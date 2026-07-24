-- P2-2 adds only membership-gated read projections. These views reuse the
-- existing swarm.is_member authorization predicate and expose no global
-- directory or non-member probe.

CREATE OR REPLACE VIEW swarm_read.workspaces
WITH (security_barrier = true)
AS
  SELECT
    w.workspace_id,
    w.name,
    w.archived_at
  FROM swarm.workspaces AS w
  WHERE swarm.is_member(w.workspace_id, auth.uid());

CREATE OR REPLACE VIEW swarm_read.member_profiles
WITH (security_barrier = true)
AS
  SELECT
    m.workspace_id,
    m.user_id,
    u.display_name,
    m.role
  FROM swarm.memberships AS m
  JOIN swarm.users AS u USING (user_id)
  WHERE m.revoked_at IS NULL
    AND swarm.is_member(m.workspace_id, auth.uid());

ALTER VIEW swarm_read.workspaces OWNER TO swarm_admin;
ALTER VIEW swarm_read.member_profiles OWNER TO swarm_admin;

GRANT SELECT ON
  swarm_read.workspaces,
  swarm_read.member_profiles
TO authenticated, swarm_read;

REVOKE ALL ON
  swarm_read.workspaces,
  swarm_read.member_profiles
FROM anon;
