-- Product feedback from members AND agents (operator ruling 2026-08-19: agents
-- are the real users; their bug reports and feature requests are first-class).
--
-- Durable-by-default: rows land here through the command function's SECURITY
-- DEFINER projection of FeedbackSubmitted events — never a direct client
-- write. There is deliberately NO client read path in v1: reading feedback is
-- operator-side SQL (the audience is whoever runs the deployment, not the
-- workspace), so no swarm_read view is created and RLS grants nothing.

CREATE TABLE swarm.feedback (
  feedback_id    uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  reporter_kind  text NOT NULL,
  reporter_id    uuid NOT NULL,
  category       text NOT NULL,
  body           text NOT NULL,
  -- Flat client-declared context (cswarm version, host, surface). The edge
  -- bounds it to 2KB serialized and flat string values before it gets here.
  context        jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feedback_reporter_kind CHECK (reporter_kind IN ('user', 'agent')),
  CONSTRAINT feedback_category CHECK (category IN ('bug', 'idea', 'friction')),
  -- Mirrors normalizedFeedbackBody in src/protocol/workspace-commands.ts:
  -- trimmed 1..4000; the reducer's control-character class is deliberately
  -- STRICTER than [[:cntrl:]] minus tab/newline here, so accepted-by-reducer
  -- can never fail this constraint.
  CONSTRAINT feedback_body_bounded CHECK (
    length(body) BETWEEN 1 AND 4000
    AND body = btrim(body)
    AND body !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'
  )
);

-- The operator reads by recency; duplicate suppression reads by reporter+hour.
CREATE INDEX feedback_workspace_created
  ON swarm.feedback (workspace_id, created_at DESC);
CREATE INDEX feedback_reporter_recency
  ON swarm.feedback (reporter_id, created_at DESC);

ALTER TABLE swarm.feedback ENABLE ROW LEVEL SECURITY;

-- Writes ride the projection's swarm_command role, the same posture as
-- swarm.files: an explicit policy for that one role, revocation for every
-- client role, and no swarm_read view at all — operator-side SQL is the read
-- path in v1.
CREATE POLICY swarm_command_all ON swarm.feedback
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE swarm.feedback FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE swarm.feedback TO swarm_command;
