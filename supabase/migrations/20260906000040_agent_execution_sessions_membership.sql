-- Membership-gate swarm_read.agent_execution_sessions (Lane A round 4).
-- 20260906000030 projected every execution-session row. security_barrier
-- does not add access control. Sibling swarm_read views filter with
-- swarm.is_member(workspace_id, auth.uid()). Do not edit 000030: a sibling
-- lane may already have applied it.

DROP VIEW IF EXISTS swarm_read.agent_execution_sessions;
CREATE VIEW swarm_read.agent_execution_sessions
WITH (security_barrier = true)
AS
  SELECT
    s.principal_id,
    s.workspace_id,
    s.session_id,
    s.generation,
    s.lifecycle_state,
    s.host_label,
    s.provider,
    s.host_session_ref,
    s.started_at,
    s.renewed_at,
    s.expired_at,
    s.created_at,
    s.updated_at
  FROM swarm.agent_execution_sessions AS s
  WHERE swarm.is_member(s.workspace_id, auth.uid())
    AND (
      -- Human PostgREST callers are role authenticated: any live member of
      -- the workspace may read public session fields. Agent callers through
      -- the read edge are role swarm_read and must name their principal in
      -- request.jwt.claims; without that claim they see no row.
      current_user <> 'swarm_read'::name
      OR s.principal_id = NULLIF(
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb
          ->> 'agent_principal_id',
        ''
      )::uuid
    );

ALTER VIEW swarm_read.agent_execution_sessions OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.agent_execution_sessions TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.agent_execution_sessions FROM anon;

DO $$
DECLARE
  view_def text := pg_get_viewdef('swarm_read.agent_execution_sessions'::regclass, true);
  cols text[];
BEGIN
  IF position('swarm.is_member(' IN view_def) = 0 THEN
    RAISE EXCEPTION
      'swarm_read.agent_execution_sessions must filter with swarm.is_member'
      USING ERRCODE = '55000';
  END IF;

  IF position('agent_principal_id' IN view_def) = 0 THEN
    RAISE EXCEPTION
      'swarm_read.agent_execution_sessions must restrict swarm_read to the calling principal'
      USING ERRCODE = '55000';
  END IF;

  SELECT array_agg(column_name::text ORDER BY ordinal_position)
  INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'swarm_read'
    AND table_name = 'agent_execution_sessions';

  IF cols IS DISTINCT FROM ARRAY[
    'principal_id',
    'workspace_id',
    'session_id',
    'generation',
    'lifecycle_state',
    'host_label',
    'provider',
    'host_session_ref',
    'started_at',
    'renewed_at',
    'expired_at',
    'created_at',
    'updated_at'
  ]::text[] THEN
    RAISE EXCEPTION
      'swarm_read.agent_execution_sessions column list drifted: %', cols
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'swarm_read'
      AND table_name = 'agent_execution_sessions'
      AND column_name = 'key_hash'
  ) THEN
    RAISE EXCEPTION 'swarm_read.agent_execution_sessions must not project key_hash'
      USING ERRCODE = '55000';
  END IF;

  IF NOT has_table_privilege(
    'authenticated',
    'swarm_read.agent_execution_sessions',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'authenticated must SELECT swarm_read.agent_execution_sessions'
      USING ERRCODE = '55000';
  END IF;

  IF NOT has_table_privilege(
    'swarm_read',
    'swarm_read.agent_execution_sessions',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'swarm_read must SELECT swarm_read.agent_execution_sessions'
      USING ERRCODE = '55000';
  END IF;

  IF has_table_privilege(
    'anon',
    'swarm_read.agent_execution_sessions',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'anon must not SELECT swarm_read.agent_execution_sessions'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
