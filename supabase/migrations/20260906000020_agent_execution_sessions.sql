-- Agent execution sessions (Lane A). Unreleased: edit in place.
-- Spec: docs/design/2026-09-06-AGENT-SESSION-IDENTITY.md section 8.

ALTER TABLE swarm.agent_principals
  DROP CONSTRAINT IF EXISTS agent_principals_workspace_id_name_key;

ALTER TABLE swarm.agent_principals
  ADD COLUMN IF NOT EXISTS managed_at timestamptz;

COMMENT ON COLUMN swarm.agent_principals.managed_at IS
  'Set by enable_agent_management, cleared by disable_agent_management. '
  'The command/activity fence consults session tables only when this is not null.';

DROP TABLE IF EXISTS swarm.retired_agent_sessions;
DROP TABLE IF EXISTS swarm.agent_execution_sessions;
DROP TYPE IF EXISTS swarm.agent_session_state;

CREATE TYPE swarm.agent_session_state AS ENUM ('enabled', 'disabled');

CREATE TABLE swarm.agent_execution_sessions (
  principal_id uuid PRIMARY KEY REFERENCES swarm.agent_principals(principal_id),
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id),
  session_id uuid NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  lifecycle_state swarm.agent_session_state NOT NULL DEFAULT 'disabled',
  host_label text,
  provider text,
  host_session_ref text,
  key_hash bytea CHECK (key_hash IS NULL OR octet_length(key_hash) = 32),
  started_at timestamptz,
  renewed_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE UNIQUE INDEX agent_execution_sessions_session_id_idx
  ON swarm.agent_execution_sessions(session_id);
CREATE INDEX agent_execution_sessions_workspace_id_idx
  ON swarm.agent_execution_sessions(workspace_id);

CREATE TABLE swarm.retired_agent_sessions (
  session_id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES swarm.agent_principals(principal_id),
  retired_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

ALTER TABLE swarm.agent_execution_sessions OWNER TO swarm_admin;
ALTER TABLE swarm.agent_execution_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY swarm_admin_all ON swarm.agent_execution_sessions
  AS PERMISSIVE FOR ALL TO swarm_admin
  USING (true) WITH CHECK (true);

CREATE POLICY swarm_command_all ON swarm.agent_execution_sessions
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

CREATE POLICY swarm_read_select ON swarm.agent_execution_sessions
  AS PERMISSIVE FOR SELECT TO swarm_read
  USING (true);

REVOKE ALL ON TABLE swarm.agent_execution_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE swarm.agent_execution_sessions TO swarm_command;
GRANT SELECT ON TABLE swarm.agent_execution_sessions TO swarm_read;

ALTER TABLE swarm.retired_agent_sessions OWNER TO swarm_admin;
ALTER TABLE swarm.retired_agent_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY swarm_admin_all ON swarm.retired_agent_sessions
  AS PERMISSIVE FOR ALL TO swarm_admin
  USING (true) WITH CHECK (true);

CREATE POLICY swarm_command_all ON swarm.retired_agent_sessions
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

CREATE POLICY swarm_read_select ON swarm.retired_agent_sessions
  AS PERMISSIVE FOR SELECT TO swarm_read
  USING (true);

REVOKE ALL ON TABLE swarm.retired_agent_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE swarm.retired_agent_sessions TO swarm_command;
GRANT SELECT ON TABLE swarm.retired_agent_sessions TO swarm_read;

-- ---------------------------------------------------------------------------
-- agent_delivery_read_context: live body from 20260906000010:276-483
-- plus managed_at. Same three privilege statements.
-- ---------------------------------------------------------------------------

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
  wake_id text,
  managed_at timestamptz
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
  v_managed_at timestamptz;
BEGIN
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
    p.wake_id,
    p.managed_at
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
    v_wake_id,
    v_managed_at
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
  managed_at := v_managed_at;
  RETURN NEXT;
END;
$fn$;

ALTER FUNCTION swarm.agent_delivery_read_context(bytea, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_delivery_read_context(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm.agent_delivery_read_context(bytea, uuid) TO swarm_read;

-- Enumerated projection: never SELECT p.*, which would publish wake_id.
DROP VIEW IF EXISTS swarm_read.agent_principals;
CREATE VIEW swarm_read.agent_principals
WITH (security_barrier = true)
AS
  SELECT
    p.principal_id,
    p.workspace_id,
    p.owner_user_id,
    p.name,
    p.created_at,
    p.revoked_at,
    p.model,
    p.managed_at
  FROM swarm.agent_principals AS p
  WHERE swarm.is_member(p.workspace_id, auth.uid());

ALTER VIEW swarm_read.agent_principals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.agent_principals TO authenticated, swarm_read;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'swarm.agent_principals'::regclass
      AND attname = 'managed_at'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'swarm.agent_principals.managed_at was not created'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'swarm_read'
      AND table_name = 'agent_principals'
      AND column_name = 'wake_id'
  ) THEN
    RAISE EXCEPTION 'swarm_read.agent_principals must not project wake_id'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'swarm_read'
      AND table_name = 'agent_principals'
      AND column_name = 'managed_at'
  ) THEN
    RAISE EXCEPTION 'swarm_read.agent_principals.managed_at was not projected'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'swarm'
      AND p.proname = 'agent_delivery_read_context'
      AND pg_get_function_result(p.oid) LIKE '%managed_at%'
  ) THEN
    RAISE EXCEPTION 'agent_delivery_read_context does not return managed_at'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
