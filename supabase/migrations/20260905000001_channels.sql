-- Chat platform P1, file 1 of 3: named rooms.
--
-- A channel is a grouping LABEL, not a scope. It has no members, no privacy,
-- and it never appears in an authorization predicate. Every member of the
-- workspace reads every channel; that ruling is stated here in SQL so a later
-- reader does not have to infer it from the absence of a table.
-- Design: docs/design/2026-09-04-chat-platform-reconciled.md (R1, D1, D3).
--
-- This file commits on its own. Until file 2 commits, swarm.signals has no
-- channel_id and nothing references these rows, so an interrupted push leaves
-- an unused table rather than a broken write path.

CREATE TABLE swarm.channels (
  channel_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  -- Shape only. The reserved-slug rule is a product decision and lives in the
  -- edge validator (supabase/functions/_shared/channels.ts), which is also
  -- where the user-facing sentence describing this pattern is generated from.
  -- tests/chat-channel-constants.test.ts fails if the two drift.
  slug text NOT NULL
    CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
    CHECK (char_length(slug) BETWEEN 1 AND 32),
  purpose text CHECK (purpose IS NULL OR char_length(purpose) <= 500),
  -- Stamped server-side from the authenticated credential, never client-supplied.
  created_by_principal uuid NOT NULL,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user', 'agent')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- Channels are archived, never deleted: a delete would orphan an immutable
  -- label on an append-only row. File 2's foreign key makes the delete
  -- physically refused, which is the control rather than the convention.
  archived_at timestamptz
);

CREATE UNIQUE INDEX channels_workspace_slug
  ON swarm.channels (workspace_id, lower(slug));
-- Tenant-pinning composite key so signals can carry a composite FK back and a
-- cross-tenant channel_id cannot be stamped on a signal. House idiom:
-- streams_stream_workspace (20260723000001_p1_schema.sql:275-276),
-- signals_agent_recipient_workspace (20260730000002:36-39).
CREATE UNIQUE INDEX channels_channel_workspace
  ON swarm.channels (channel_id, workspace_id);
CREATE INDEX channels_live
  ON swarm.channels (workspace_id, archived_at)
  WHERE archived_at IS NULL;

ALTER TABLE swarm.channels OWNER TO swarm_admin;
ALTER TABLE swarm.channels ENABLE ROW LEVEL SECURITY;

-- The older authority tables get swarm_command_all from a DO loop over an
-- authority_table array (20260723000001_p1_schema.sql:502-551). That loop is in
-- an already-applied file and will never reach a table created here, so the
-- policy is written out.
CREATE POLICY swarm_command_all ON swarm.channels
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE swarm.channels FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE swarm.channels TO swarm_command;

-- Membership is the ONLY predicate. swarm.is_member (20260820000002:4-21)
-- already excludes archived workspaces, so this view fails closed with them.
CREATE VIEW swarm_read.channels
WITH (security_barrier = true)
AS
  SELECT
    c.channel_id,
    c.workspace_id,
    c.slug,
    c.purpose,
    c.created_by_principal,
    c.created_by_kind,
    c.created_at,
    c.archived_at
  FROM swarm.channels AS c
  WHERE swarm.is_member(c.workspace_id, auth.uid());

ALTER VIEW swarm_read.channels OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.channels TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.channels FROM anon;

COMMENT ON TABLE swarm.channels IS
  'Named rooms. A channel is an immutable grouping label stamped on a signal at post time. It has no members and never narrows who may read a signal.';
COMMENT ON COLUMN swarm.channels.archived_at IS
  'Hides the channel from the rail and refuses new posts. Existing signals still render and permalinks still resolve. A channel is never deleted.';
