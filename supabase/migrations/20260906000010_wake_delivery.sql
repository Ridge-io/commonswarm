-- Push delivery W1/W4/W5/W6 (docs/design/2026-09-06-PUSH-DELIVERY.md).
-- One wake id per principal; a trigger sends a content-free payload on
-- cswarm-wake:{wake_id}; a Realtime policy admits the join only when that
-- id names a live principal. Rotation is a function L3 will call.

-- ---------------------------------------------------------------------------
-- 1. pgcrypto, in the schema this stack already uses
-- ---------------------------------------------------------------------------
-- gen_random_bytes lives in pgcrypto. Locally it is in schema extensions, and
-- no prior migration in this tree installs it. Every SET search_path in the
-- repo omits extensions, so an unqualified call inside a function with the
-- tree's convention fails at run time. Generators below are schema-qualified.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 2. swarm.agent_principals.wake_id
-- ---------------------------------------------------------------------------
-- Volatile default, evaluated per row: existing principals each get their own
-- id at ADD COLUMN time, and every future INSERT that does not name the
-- column (command/index.ts:4025-4036, src/cloud/seed.ts:157-164) gets one too.
ALTER TABLE swarm.agent_principals
  ADD COLUMN wake_id text NOT NULL
  DEFAULT translate(
    encode(extensions.gen_random_bytes(32), 'base64'),
    '+/=',
    '-_'
  );

CREATE UNIQUE INDEX agent_principals_wake_id
  ON swarm.agent_principals (wake_id);

COMMENT ON COLUMN swarm.agent_principals.wake_id IS
  '32 random bytes as 43 base64url characters. One per principal. The Realtime '
  'topic cswarm-wake:{wake_id} is the join credential. Stored in plaintext so '
  'the wake trigger can build the topic; a low-privilege capability by design.';

-- The neighbouring token_hash comment said "plaintext is never stored". That
-- sentence applies to token_hash. wake_id is the opposite, on purpose.
COMMENT ON COLUMN swarm.agent_tokens.token_hash IS
  'SHA-256 digest of the full presented swm_agt_ credential, including its '
  'prefix; plaintext is never stored. That sentence applies to token_hash. '
  'swarm.agent_principals.wake_id is a plaintext low-privilege capability by '
  'design.';

-- ---------------------------------------------------------------------------
-- 3. swarm.wake_topic_authorized
-- ---------------------------------------------------------------------------
-- STABLE SECURITY DEFINER, owner swarm_admin, no extensions (it generates
-- nothing). A Realtime policy stores the function by OID, so anon needs
-- EXECUTE and not USAGE on schema swarm.
CREATE FUNCTION swarm.wake_topic_authorized(topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
DECLARE
  v_wake_id text;
  v_principal_id uuid;
BEGIN
  v_wake_id := substring(topic FROM '^cswarm-wake:([A-Za-z0-9_-]{43})$');
  IF v_wake_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT p.principal_id
  INTO v_principal_id
  FROM swarm.agent_principals AS p
  WHERE p.wake_id = v_wake_id
    AND p.revoked_at IS NULL;

  IF v_principal_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM swarm.agent_tokens AS t
    WHERE t.principal_id = v_principal_id
      AND t.revoked_at IS NULL
      AND t.expires_at > statement_timestamp()
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END;
$fn$;

ALTER FUNCTION swarm.wake_topic_authorized(text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.wake_topic_authorized(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm.wake_topic_authorized(text) TO anon;

COMMENT ON FUNCTION swarm.wake_topic_authorized(text) IS
  'Whether the Realtime topic names a live principal''s current wake id. '
  'Returns false on every non-match (malformed topic, unknown id, revoked '
  'principal, no live token) and raises on nothing.';

-- ---------------------------------------------------------------------------
-- 4. swarm.rotate_wake_id
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER owned by postgres, not swarm_admin. A plpgsql body is
-- checked for schema USAGE under the owner's identity at run time, and
-- swarm_admin has no USAGE on schema extensions (W6). The column default is
-- unaffected: a stored default holds the function OID and needs only EXECUTE.
CREATE FUNCTION swarm.rotate_wake_id(principal uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_new text;
BEGIN
  UPDATE swarm.agent_principals
  SET wake_id = translate(
    encode(extensions.gen_random_bytes(32), 'base64'),
    '+/=',
    '-_'
  )
  WHERE principal_id = principal
  RETURNING wake_id INTO v_new;
  RETURN v_new;
END;
$fn$;

ALTER FUNCTION swarm.rotate_wake_id(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION swarm.rotate_wake_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm.rotate_wake_id(uuid) TO swarm_command;

COMMENT ON FUNCTION swarm.rotate_wake_id(uuid) IS
  'Replace one principal''s wake_id with a new 43-character value. Owner is '
  'postgres because swarm_admin has no USAGE on schema extensions, and a '
  'SECURITY DEFINER plpgsql body is checked for schema USAGE under the owner.';

-- ---------------------------------------------------------------------------
-- 5. Trigger functions, owned by postgres (W4)
-- ---------------------------------------------------------------------------
-- realtime.send is SECURITY INVOKER. The gate is USAGE on schema realtime and
-- INSERT on realtime.messages. Neither swarm_command nor swarm_admin holds
-- them. The connection role postgres is the role that may INSERT into
-- realtime.messages (it has BYPASSRLS locally; the table has RLS enabled and
-- no INSERT policy). Owner postgres, not swarm_admin.
--
-- Both enqueue paths (scalar enqueue_signal_delivery and fan-out
-- enqueue_recipient_delivery) insert into swarm.signal_deliveries, so one
-- AFTER INSERT row trigger on that table covers both. The workspace-signal
-- trigger is the W2 pair on swarm.signals.

CREATE FUNCTION swarm.wake_agent_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_wake_id text;
BEGIN
  BEGIN
    SELECT p.wake_id
    INTO v_wake_id
    FROM swarm.agent_principals AS p
    WHERE p.principal_id = NEW.recipient_agent_principal_id;

    IF v_wake_id IS NULL THEN
      RETURN NULL;
    END IF;

    PERFORM realtime.send(
      pg_catalog.jsonb_build_object(
        'v', 1,
        'signal_id', NEW.signal_id,
        'enqueued_at', NEW.enqueued_at
      ),
      'wake',
      'cswarm-wake:' || v_wake_id,
      true
    );
  EXCEPTION
    WHEN OTHERS THEN
      RETURN NULL;
  END;
  RETURN NULL;
END;
$fn$;

ALTER FUNCTION swarm.wake_agent_delivery() OWNER TO postgres;
REVOKE ALL ON FUNCTION swarm.wake_agent_delivery() FROM PUBLIC;

COMMENT ON FUNCTION swarm.wake_agent_delivery() IS
  'AFTER INSERT on swarm.signal_deliveries: send a content-free wake on the '
  'recipient principal''s current topic. Owner is postgres because that is the '
  'connection role that may INSERT into realtime.messages. A Realtime failure '
  'must never fail the delivery insert.';

CREATE TRIGGER signal_deliveries_wake_agent
  AFTER INSERT ON swarm.signal_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION swarm.wake_agent_delivery();

CREATE FUNCTION swarm.wake_workspace_signal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  BEGIN
    PERFORM realtime.send(
      pg_catalog.jsonb_build_object(
        'v', 1,
        'signal_id', NEW.id,
        'created_at', NEW.created_at
      ),
      'signal',
      'cswarm-signals:' || NEW.workspace_id::text,
      true
    );
  EXCEPTION
    WHEN OTHERS THEN
      RETURN NULL;
  END;
  RETURN NULL;
END;
$fn$;

ALTER FUNCTION swarm.wake_workspace_signal() OWNER TO postgres;
REVOKE ALL ON FUNCTION swarm.wake_workspace_signal() FROM PUBLIC;

COMMENT ON FUNCTION swarm.wake_workspace_signal() IS
  'AFTER INSERT on swarm.signals: send a content-free payload on the workspace '
  'signal topic. Same owner and same swallow-failure rule as wake_agent_delivery.';

CREATE TRIGGER signals_wake_workspace
  AFTER INSERT ON swarm.signals
  FOR EACH ROW
  EXECUTE FUNCTION swarm.wake_workspace_signal();

-- ---------------------------------------------------------------------------
-- 6. realtime.messages policies
-- ---------------------------------------------------------------------------
CREATE POLICY "agent receives its own wake"
ON realtime.messages
FOR SELECT
TO anon
USING (
  realtime.messages.extension = 'broadcast'
  AND swarm.wake_topic_authorized((SELECT realtime.topic()))
);

CREATE POLICY "workspace members receive signals"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND swarm.is_member(
    substring(
      (SELECT realtime.topic())
      FROM '^cswarm-signals:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
    )::uuid,
    (SELECT auth.uid())
  )
);

-- ---------------------------------------------------------------------------
-- 7. agent_delivery_read_context, live body plus wake_id
-- ---------------------------------------------------------------------------
-- Re-created from 20260820000002_archive_revokes_access.sql:103-299, never
-- from the older 20260731000001 body. An OUT-parameter change cannot
-- CREATE OR REPLACE, so this is DROP then CREATE. Callers name their columns.
-- The three privilege statements at :301, :302, :306 follow. A re-create with
-- only the GRANT leaves the function owned by postgres with EXECUTE to PUBLIC
-- and fails tests/p1-server/command.test.ts:9267-9271.

DROP FUNCTION swarm.agent_delivery_read_context(bytea, uuid);

CREATE FUNCTION swarm.agent_delivery_read_context(
  p_token_hash bytea,
  p_workspace_id uuid
)
RETURNS TABLE (
  token_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  principal_workspace_id uuid,
  run_id uuid,
  device_id uuid,
  first_use boolean,
  membership_revoked_at timestamptz,
  is_revoked boolean,
  pending_delivery_count integer,
  wake_id text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
DECLARE
  v_token_id uuid;
  v_first_use boolean;
  v_principal_id uuid;
  v_owner_user_id uuid;
  v_principal_workspace_id uuid;
  v_run_id uuid;
  v_device_id uuid;
  v_lineage_id uuid;
  v_token_revoked_at timestamptz;
  v_principal_revoked_at timestamptz;
  v_run_ended_at timestamptz;
  v_device_revoked_at timestamptz;
  v_surrender_only boolean;
  v_unexpired boolean;
  v_membership_revoked_at timestamptz;
  v_revoked boolean := false;
  v_pending integer := 0;
  v_ids uuid[];
  v_wake_id text;
BEGIN
  -- Stamp first-use under the same join constraints as loadAgentCredential.
  WITH presented AS (
    SELECT t.token_id, t.predecessor_token_id, t.first_used_at
    FROM swarm.agent_tokens AS t
    JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
    JOIN swarm.agent_runs AS r
      ON r.run_id = t.run_id AND r.principal_id = t.principal_id
    JOIN swarm.devices AS d ON d.device_id = r.device_id
    WHERE t.token_hash = p_token_hash
    LIMIT 1
  ),
  stamp AS (
    UPDATE swarm.agent_tokens AS s
    SET first_used_at = statement_timestamp()
    FROM presented AS pre
    WHERE s.token_id = pre.token_id
      AND s.first_used_at IS NULL
      AND s.revoked_at IS NULL
      AND s.expires_at > statement_timestamp()
    RETURNING s.token_id
  ),
  handover AS (
    UPDATE swarm.agent_tokens AS pred
    SET expires_at = statement_timestamp()
    FROM presented AS pre
    JOIN stamp AS st ON st.token_id = pre.token_id
    WHERE pred.token_id = pre.predecessor_token_id
      AND pred.revoked_at IS NULL
      AND pred.expires_at > statement_timestamp()
    RETURNING pred.token_id
  )
  SELECT pre.token_id, pre.first_used_at IS NULL
  INTO v_token_id, v_first_use
  FROM presented AS pre;

  IF v_token_id IS NULL THEN
    RETURN;
  END IF;

  -- Fresh liveness snapshot after the stamp lock is released.
  SELECT
    t.token_id,
    t.principal_id,
    p.owner_user_id,
    p.workspace_id,
    t.run_id,
    r.device_id,
    t.lineage_id,
    t.revoked_at,
    p.revoked_at,
    r.ended_at,
    d.revoked_at,
    t.surrender_only,
    t.expires_at > statement_timestamp(),
    p.wake_id
  INTO
    v_token_id,
    v_principal_id,
    v_owner_user_id,
    v_principal_workspace_id,
    v_run_id,
    v_device_id,
    v_lineage_id,
    v_token_revoked_at,
    v_principal_revoked_at,
    v_run_ended_at,
    v_device_revoked_at,
    v_surrender_only,
    v_unexpired,
    v_wake_id
  FROM swarm.agent_tokens AS t
  JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
  JOIN swarm.agent_runs AS r
    ON r.run_id = t.run_id AND r.principal_id = t.principal_id
  JOIN swarm.devices AS d ON d.device_id = r.device_id
  WHERE t.token_id = v_token_id;

  IF NOT COALESCE(v_unexpired, false) THEN
    RETURN;
  END IF;

  SELECT m.revoked_at
  INTO v_membership_revoked_at
  FROM swarm.memberships AS m
  WHERE m.workspace_id = v_principal_workspace_id
    AND m.user_id = v_owner_user_id
  LIMIT 1;

  IF NOT FOUND THEN
    v_revoked := true;
  ELSIF NOT swarm.is_member(v_principal_workspace_id, v_owner_user_id)
     OR v_membership_revoked_at IS NOT NULL
     OR v_token_revoked_at IS NOT NULL
     OR v_principal_revoked_at IS NOT NULL
     OR v_run_ended_at IS NOT NULL
     OR v_device_revoked_at IS NOT NULL
     OR v_surrender_only
  THEN
    v_revoked := true;
  ELSE
    v_ids := ARRAY[
      v_token_id,
      v_principal_id,
      v_run_id,
      v_device_id,
      v_owner_user_id,
      v_lineage_id
    ];
    IF EXISTS (
      SELECT 1
      FROM swarm.revocation_tombstones AS rt
      WHERE rt.target_id = ANY (v_ids)
        AND (
          (rt.kind = 'token' AND rt.target_id = v_token_id)
          OR (rt.kind = 'principal' AND rt.target_id = v_principal_id)
          OR (rt.kind = 'run' AND rt.target_id = v_run_id)
          OR (rt.kind = 'device' AND rt.target_id = v_device_id)
          OR (rt.kind = 'membership' AND rt.target_id = v_owner_user_id)
          OR (rt.kind = 'lineage' AND rt.target_id = v_lineage_id)
          OR (rt.kind = 'family' AND rt.target_id = v_lineage_id)
        )
    ) THEN
      v_revoked := true;
    END IF;
  END IF;

  -- Live-unacked = unacked rows whose immutable signal is still live.
  -- Foreign workspace requests still authenticate but report count for the
  -- principal's home workspace only when p_workspace_id matches.
  IF NOT v_revoked
     AND p_workspace_id IS NOT NULL
     AND p_workspace_id = v_principal_workspace_id
  THEN
    SELECT count(*)::integer
    INTO v_pending
    FROM swarm.signal_deliveries AS d
    JOIN swarm.signals AS s
      ON s.id = d.signal_id
     AND s.workspace_id = d.workspace_id
    WHERE d.recipient_agent_principal_id = v_principal_id
      AND d.workspace_id = v_principal_workspace_id
      AND d.acked_at IS NULL
      AND s.until > statement_timestamp();
  END IF;

  token_id := v_token_id;
  principal_id := v_principal_id;
  owner_user_id := v_owner_user_id;
  principal_workspace_id := v_principal_workspace_id;
  run_id := v_run_id;
  device_id := v_device_id;
  first_use := v_first_use;
  membership_revoked_at := v_membership_revoked_at;
  is_revoked := v_revoked;
  pending_delivery_count := COALESCE(v_pending, 0);
  wake_id := v_wake_id;
  RETURN NEXT;
END;
$fn$;

ALTER FUNCTION swarm.agent_delivery_read_context(bytea, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_delivery_read_context(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm.agent_delivery_read_context(bytea, uuid) TO swarm_read;
