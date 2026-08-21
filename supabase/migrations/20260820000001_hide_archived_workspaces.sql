-- Closed workspaces remain durable in swarm.workspaces for support restore,
-- but membership-gated client listings must expose only live workspaces.
-- Keep archived_at in the projection for compatibility with released CLI and
-- web clients that still select and null-filter the column.

CREATE OR REPLACE VIEW swarm_read.workspaces
WITH (security_barrier = true)
AS
  SELECT
    w.workspace_id,
    w.name,
    w.archived_at
  FROM swarm.workspaces AS w
  WHERE swarm.is_member(w.workspace_id, auth.uid())
    AND w.archived_at IS NULL;
