-- Managed delivery session binding and pending-surface (Lane A round 2).
-- Spec: docs/design/2026-09-06-AGENT-SESSION-IDENTITY.md section 8.
-- Additive. Does not edit 20260906000020.

-- ---------------------------------------------------------------------------
-- P1: claim binds the live execution session onto the delivery row.
-- P2: surfaced_at is the pending-surface fence. queued stays nonterminal
--     for managed principals until this timestamp is set.
-- ---------------------------------------------------------------------------

ALTER TABLE swarm.signal_deliveries
  ADD COLUMN IF NOT EXISTS session_id uuid;

ALTER TABLE swarm.signal_deliveries
  ADD COLUMN IF NOT EXISTS session_generation integer;

ALTER TABLE swarm.signal_deliveries
  ADD COLUMN IF NOT EXISTS surfaced_at timestamptz;

COMMENT ON COLUMN swarm.signal_deliveries.session_id IS
  'Execution session UUID copied from the verified proof at claim time. '
  'Never taken from the command body. NULL on unmanaged principals.';

COMMENT ON COLUMN swarm.signal_deliveries.session_generation IS
  'Execution session generation copied from the verified proof at claim time. '
  'NULL iff session_id is NULL.';

COMMENT ON COLUMN swarm.signal_deliveries.surfaced_at IS
  'Set when a managed principal ACKs observed with surfaced true (or a terminal '
  'outcome). queued rows stay claimable-for-recovery while this is NULL.';

ALTER TABLE swarm.signal_deliveries
  DROP CONSTRAINT IF EXISTS signal_deliveries_session_binding_null;
ALTER TABLE swarm.signal_deliveries
  ADD CONSTRAINT signal_deliveries_session_binding_null
  CHECK ((session_id IS NULL) = (session_generation IS NULL));

ALTER TABLE swarm.signal_deliveries
  DROP CONSTRAINT IF EXISTS signal_deliveries_session_generation_positive;
ALTER TABLE swarm.signal_deliveries
  ADD CONSTRAINT signal_deliveries_session_generation_positive
  CHECK (session_generation IS NULL OR session_generation >= 1);

CREATE INDEX IF NOT EXISTS signal_deliveries_unsurfaced_recipient
  ON swarm.signal_deliveries (recipient_agent_principal_id)
  WHERE surfaced_at IS NULL;

-- ---------------------------------------------------------------------------
-- P5: swarm_read must not read key_hash. Column-level GRANT plus a projection
-- that omits the column. read/index.ts joins the view, not the table.
-- ---------------------------------------------------------------------------

REVOKE SELECT ON TABLE swarm.agent_execution_sessions FROM swarm_read;
GRANT SELECT (
  principal_id,
  workspace_id,
  session_id,
  generation,
  lifecycle_state,
  host_label,
  provider,
  host_session_ref,
  started_at,
  renewed_at,
  expired_at,
  created_at,
  updated_at
) ON TABLE swarm.agent_execution_sessions TO swarm_read;

DROP VIEW IF EXISTS swarm_read.agent_execution_sessions;
CREATE VIEW swarm_read.agent_execution_sessions
WITH (security_barrier = true)
AS
  SELECT
    principal_id,
    workspace_id,
    session_id,
    generation,
    lifecycle_state,
    host_label,
    provider,
    host_session_ref,
    started_at,
    renewed_at,
    expired_at,
    created_at,
    updated_at
  FROM swarm.agent_execution_sessions;

ALTER VIEW swarm_read.agent_execution_sessions OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.agent_execution_sessions TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.agent_execution_sessions FROM anon;

-- ---------------------------------------------------------------------------
-- P6: sibling views REVOKE FROM anon. 20260906000020 granted SELECT to
-- authenticated, swarm_read and skipped the revoke.
-- ---------------------------------------------------------------------------

REVOKE ALL ON swarm_read.agent_principals FROM anon;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'swarm' AND table_name = 'signal_deliveries'
      AND column_name = 'session_id'
  ) THEN
    RAISE EXCEPTION 'swarm.signal_deliveries.session_id was not created'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'swarm' AND table_name = 'signal_deliveries'
      AND column_name = 'session_generation'
  ) THEN
    RAISE EXCEPTION 'swarm.signal_deliveries.session_generation was not created'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'swarm' AND table_name = 'signal_deliveries'
      AND column_name = 'surfaced_at'
  ) THEN
    RAISE EXCEPTION 'swarm.signal_deliveries.surfaced_at was not created'
      USING ERRCODE = '55000';
  END IF;

  IF has_column_privilege(
    'swarm_read',
    'swarm.agent_execution_sessions',
    'key_hash',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'swarm_read must not SELECT swarm.agent_execution_sessions.key_hash'
      USING ERRCODE = '55000';
  END IF;

  IF NOT has_column_privilege(
    'swarm_read',
    'swarm.agent_execution_sessions',
    'session_id',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'swarm_read must still SELECT swarm.agent_execution_sessions.session_id'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'swarm_read'
      AND table_name = 'agent_execution_sessions'
      AND column_name = 'key_hash'
  ) THEN
    RAISE EXCEPTION 'swarm_read.agent_execution_sessions must not project key_hash'
      USING ERRCODE = '55000';
  END IF;

  IF has_table_privilege('anon', 'swarm_read.agent_principals', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not SELECT swarm_read.agent_principals'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
