ALTER TABLE swarm.agent_principals DROP CONSTRAINT IF EXISTS agent_principals_workspace_id_name_key;

CREATE TYPE swarm.agent_session_state AS ENUM ('enabled', 'disabled');

CREATE TABLE IF NOT EXISTS swarm.agent_execution_sessions (
  principal_id uuid PRIMARY KEY REFERENCES swarm.agent_principals(principal_id),
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id),
  session_id uuid NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  lifecycle_state swarm.agent_session_state NOT NULL DEFAULT 'disabled',
  host_label text,
  provider text,
  host_session_ref text,
  key_hash text,
  started_at timestamptz,
  renewed_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

-- Indices
CREATE UNIQUE INDEX IF NOT EXISTS agent_execution_sessions_session_id_idx ON swarm.agent_execution_sessions(session_id);
CREATE INDEX IF NOT EXISTS agent_execution_sessions_workspace_id_idx ON swarm.agent_execution_sessions(workspace_id);

CREATE TABLE IF NOT EXISTS swarm.retired_agent_sessions (
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

