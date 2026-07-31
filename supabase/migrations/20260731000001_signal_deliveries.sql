-- Durable direct-signal delivery and acknowledgement.
-- Spec: docs/design/2026-07-31-DURABLE-SIGNAL-DELIVERY.md
--
-- Creates swarm.signal_deliveries as the mutable delivery ledger. Leaves the
-- dormant swarm.inbox_deliveries table untouched (zero-use substrate only).

COMMENT ON TABLE swarm.inbox_deliveries IS
  'DORMANT P1 substrate. Never read or written by command/read/CLI/listener. '
  'Replaced by swarm.signal_deliveries for typed agent signal delivery.';

-- ---------------------------------------------------------------------------
-- 1. Table, constraints, grants, indexes
-- ---------------------------------------------------------------------------

CREATE TABLE swarm.signal_deliveries (
  signal_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recipient_agent_principal_id uuid NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  lease_id uuid,
  leased_by uuid,
  leased_until timestamptz,
  last_lease_id uuid,
  last_leased_by uuid,
  attempt_count integer NOT NULL DEFAULT 0,
  lease_expiry_count integer NOT NULL DEFAULT 0,
  last_lease_expired_at timestamptz,
  delivered_at timestamptz,
  acked_at timestamptz,
  ack_outcome text,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (signal_id, recipient_agent_principal_id),
  FOREIGN KEY (signal_id, workspace_id)
    REFERENCES swarm.signals (id, workspace_id),
  FOREIGN KEY (recipient_agent_principal_id, workspace_id)
    REFERENCES swarm.agent_principals (principal_id, workspace_id),
  CHECK (attempt_count BETWEEN 0 AND 10),
  CHECK (lease_expiry_count BETWEEN 0 AND attempt_count),
  CHECK (num_nonnulls(lease_id, leased_by, leased_until) IN (0, 3)),
  CHECK (
    acked_at IS NULL
    OR ack_outcome = 'expired'
    OR delivered_at IS NOT NULL
  ),
  CHECK (ack_outcome IS NULL OR ack_outcome IN
    ('replied', 'observed', 'expired', 'failed_terminal')),
  CHECK ((acked_at IS NULL) = (ack_outcome IS NULL)),
  CHECK (
    acked_at IS NULL
    OR num_nonnulls(lease_id, leased_by, leased_until) = 0
  ),
  CHECK (
    lease_id IS NULL
    OR leased_until > updated_at
  ),
  CHECK (
    (lease_expiry_count = 0) = (last_lease_expired_at IS NULL)
  ),
  CHECK (
    last_error_code IS NULL
    OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'
  )
);

ALTER TABLE swarm.signal_deliveries OWNER TO swarm_admin;

CREATE INDEX signal_deliveries_unacked_oldest
  ON swarm.signal_deliveries (
    recipient_agent_principal_id,
    workspace_id,
    enqueued_at,
    signal_id
  )
  WHERE acked_at IS NULL;

CREATE INDEX signal_deliveries_terminal_acked
  ON swarm.signal_deliveries (acked_at)
  WHERE acked_at IS NOT NULL;

ALTER TABLE swarm.signal_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.signal_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY swarm_admin_all ON swarm.signal_deliveries
  AS PERMISSIVE FOR ALL TO swarm_admin
  USING (true) WITH CHECK (true);

CREATE POLICY swarm_command_all ON swarm.signal_deliveries
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE swarm.signal_deliveries FROM PUBLIC, anon, authenticated, swarm_read;
GRANT SELECT, INSERT, UPDATE ON TABLE swarm.signal_deliveries TO swarm_command;
-- No DELETE for swarm_command. Purge is a SECURITY DEFINER owned by swarm_admin.

COMMENT ON TABLE swarm.signal_deliveries IS
  'Mutable at-least-once delivery ledger for direct agent signals. '
  'Bodies never live here; hydrate from immutable swarm.signals after auth.';

INSERT INTO swarm.config (key, value)
VALUES ('delivery_retention_days', '30'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Enqueue trigger (before backfill, so concurrent inserts cannot race)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION swarm.enqueue_signal_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.to_agent_principal_id IS NOT NULL THEN
    INSERT INTO swarm.signal_deliveries (
      signal_id,
      workspace_id,
      recipient_agent_principal_id
    ) VALUES (
      NEW.id,
      NEW.workspace_id,
      NEW.to_agent_principal_id
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION swarm.enqueue_signal_delivery() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.enqueue_signal_delivery() FROM PUBLIC;

CREATE TRIGGER signals_enqueue_delivery
  AFTER INSERT ON swarm.signals
  FOR EACH ROW
  EXECUTE FUNCTION swarm.enqueue_signal_delivery();

-- ---------------------------------------------------------------------------
-- 3. Backfill live direct-agent signals
-- ---------------------------------------------------------------------------

INSERT INTO swarm.signal_deliveries (
  signal_id,
  workspace_id,
  recipient_agent_principal_id,
  enqueued_at
)
SELECT
  s.id,
  s.workspace_id,
  s.to_agent_principal_id,
  s.created_at
FROM swarm.signals AS s
WHERE s.to_agent_principal_id IS NOT NULL
  AND s.until > statement_timestamp()
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Assert every live direct-agent signal has a delivery row
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  missing integer;
BEGIN
  SELECT count(*)::integer INTO missing
  FROM swarm.signals AS s
  WHERE s.to_agent_principal_id IS NOT NULL
    AND s.until > statement_timestamp()
    AND NOT EXISTS (
      SELECT 1
      FROM swarm.signal_deliveries AS d
      WHERE d.signal_id = s.id
        AND d.recipient_agent_principal_id = s.to_agent_principal_id
    );
  IF missing <> 0 THEN
    RAISE EXCEPTION
      'signal_deliveries backfill incomplete: % live direct-agent signal(s) lack a delivery row',
      missing;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. Assert signal-inserter roles can also insert deliveries
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  role_name text;
  missing text[] := ARRAY[]::text[];
BEGIN
  FOR role_name IN
    SELECT rolname::text
    FROM pg_catalog.pg_roles
    WHERE NOT rolsuper
      AND has_table_privilege(rolname, 'swarm.signals', 'INSERT')
  LOOP
    IF NOT has_table_privilege(role_name, 'swarm.signal_deliveries', 'INSERT') THEN
      missing := array_append(missing, role_name);
    END IF;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'signal-inserter role(s) lack INSERT on swarm.signal_deliveries: %',
      array_to_string(missing, ', ');
  END IF;

  -- Positive control: the two known inserters must resolve.
  IF NOT has_table_privilege('swarm_admin', 'swarm.signal_deliveries', 'INSERT')
     OR NOT has_table_privilege('swarm_command', 'swarm.signal_deliveries', 'INSERT')
  THEN
    RAISE EXCEPTION
      'expected swarm_admin and swarm_command to INSERT swarm.signal_deliveries';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. Terminal-row purge + daily schedule
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION swarm.purge_terminal_signal_deliveries(
  p_retention_days integer DEFAULT NULL
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
  DELETE FROM swarm.signal_deliveries
  WHERE acked_at IS NOT NULL
    AND acked_at
      < statement_timestamp()
        - make_interval(
            days => GREATEST(
              30,
              COALESCE(
                p_retention_days,
                (
                  SELECT (value #>> '{}')::integer
                  FROM swarm.config
                  WHERE key = 'delivery_retention_days'
                ),
                30
              )
            )
          );
$$;

ALTER FUNCTION swarm.purge_terminal_signal_deliveries(integer) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_terminal_signal_deliveries(integer) FROM PUBLIC;

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'swarm-purge-terminal-signal-deliveries',
  '23 4 * * *',
  'SELECT swarm.purge_terminal_signal_deliveries()'
);

-- ---------------------------------------------------------------------------
-- Read-edge authentication + live-unacked count (never mutates deliveries)
-- ---------------------------------------------------------------------------
-- Runs as swarm_admin so the read transaction never needs swarm_command.
-- Stamps first-use the same way loadAgentCredential does, then returns only
-- principal context and the exact live-unacked count for that principal.

CREATE OR REPLACE FUNCTION swarm.agent_delivery_read_context(
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
  pending_delivery_count integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
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
    t.expires_at > statement_timestamp()
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
    v_unexpired
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
  ELSIF v_membership_revoked_at IS NOT NULL
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
  RETURN NEXT;
END;
$$;

ALTER FUNCTION swarm.agent_delivery_read_context(bytea, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_delivery_read_context(bytea, uuid) FROM PUBLIC;
-- swarm_read needs schema USAGE only to resolve the definer call; it still has
-- zero table privileges on swarm.signal_deliveries or other authority tables.
GRANT USAGE ON SCHEMA swarm TO swarm_read;
GRANT EXECUTE ON FUNCTION swarm.agent_delivery_read_context(bytea, uuid) TO swarm_read;
-- Explicitly no execute for anon/authenticated via PUBLIC revoke.
-- swarm_command authenticates via loadAgentCredential; this is read-edge only.
