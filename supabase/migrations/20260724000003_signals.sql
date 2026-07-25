-- P3-1 signal plane. Signals are immutable addressed intent, not stream events.

CREATE TABLE swarm.signals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  from_principal uuid NOT NULL,
  from_kind text NOT NULL CHECK (from_kind IN ('user', 'agent')),
  to_user_id uuid,
  about text CHECK (about IS NULL OR char_length(about) <= 500),
  kind text NOT NULL CHECK (kind IN ('working-on', 'note', 'ask')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (until > created_at),
  CHECK (until <= created_at + interval '30 days'),
  FOREIGN KEY (workspace_id, to_user_id)
    REFERENCES swarm.memberships (workspace_id, user_id)
);

CREATE INDEX signals_workspace_newest
  ON swarm.signals (workspace_id, created_at DESC, id DESC);
CREATE INDEX signals_inbox_newest
  ON swarm.signals (workspace_id, to_user_id, created_at DESC, id DESC)
  WHERE to_user_id IS NOT NULL;
CREATE INDEX signals_about_newest
  ON swarm.signals (workspace_id, about, created_at DESC, id DESC)
  WHERE about IS NOT NULL;

ALTER TABLE swarm.signals OWNER TO swarm_admin;
ALTER TABLE swarm.signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY swarm_command_all ON swarm.signals
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

CREATE TRIGGER signals_append_only
  BEFORE UPDATE OR DELETE ON swarm.signals
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

REVOKE ALL ON TABLE swarm.signals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE swarm.signals TO swarm_command;

CREATE VIEW swarm_read.signals
WITH (security_barrier = true)
AS
  SELECT
    s.id,
    s.workspace_id,
    s.from_principal AS "from",
    s.from_kind,
    s.to_user_id AS "to",
    s.about,
    s.kind,
    s.body,
    s.until,
    s.created_at
  FROM swarm.signals AS s
  WHERE swarm.is_member(s.workspace_id, auth.uid())
    AND (s.to_user_id IS NULL OR s.to_user_id = auth.uid());

ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM anon;
