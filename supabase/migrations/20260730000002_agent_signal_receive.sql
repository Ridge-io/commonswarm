-- Agent receive MVP. Signals stay immutable; these columns add typed
-- agent-principal addressing and one-hop reply correlation.

ALTER TABLE swarm.signals
  ADD COLUMN IF NOT EXISTS to_agent_principal_id uuid,
  ADD COLUMN IF NOT EXISTS in_reply_to uuid;

CREATE UNIQUE INDEX IF NOT EXISTS signals_id_workspace
  ON swarm.signals (id, workspace_id);

-- The worker-renewal migration already creates this tenant-pinned key. Keep
-- this migration independently idempotent so its foreign key never depends on
-- an unverified name in production.
CREATE UNIQUE INDEX IF NOT EXISTS agent_principals_principal_workspace
  ON swarm.agent_principals (principal_id, workspace_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'signals_one_recipient'
      AND conrelid = 'swarm.signals'::regclass
  ) THEN
    ALTER TABLE swarm.signals
      ADD CONSTRAINT signals_one_recipient
      CHECK (num_nonnulls(to_user_id, to_agent_principal_id) <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'signals_agent_recipient_workspace'
      AND conrelid = 'swarm.signals'::regclass
  ) THEN
    ALTER TABLE swarm.signals
      ADD CONSTRAINT signals_agent_recipient_workspace
      FOREIGN KEY (to_agent_principal_id, workspace_id)
      REFERENCES swarm.agent_principals (principal_id, workspace_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'signals_reply_workspace'
      AND conrelid = 'swarm.signals'::regclass
  ) THEN
    ALTER TABLE swarm.signals
      ADD CONSTRAINT signals_reply_workspace
      FOREIGN KEY (in_reply_to, workspace_id)
      REFERENCES swarm.signals (id, workspace_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS signals_agent_inbox_newest
  ON swarm.signals (
    workspace_id,
    to_agent_principal_id,
    created_at DESC,
    id DESC
  )
  WHERE to_agent_principal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS signals_reply_oldest
  ON swarm.signals (workspace_id, in_reply_to, created_at, id)
  WHERE in_reply_to IS NOT NULL;

COMMENT ON COLUMN swarm.signals.to_agent_principal_id IS
  'Direct agent recipient. Mutually exclusive with to_user_id.';
COMMENT ON COLUMN swarm.signals.in_reply_to IS
  'Immutable one-hop correlation to a signal in the same workspace.';

-- Human members keep the existing broadcast/direct-human visibility and may
-- also see signals addressed to an agent they own for oversight. Agent reads
-- apply the stricter token-derived principal filter in the read Edge function.
CREATE OR REPLACE VIEW swarm_read.signals
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
    s.created_at,
    s.to_agent_principal_id AS to_agent,
    s.in_reply_to
  FROM swarm.signals AS s
  WHERE swarm.is_member(s.workspace_id, auth.uid())
    AND (
      (
        s.to_user_id IS NULL
        AND s.to_agent_principal_id IS NULL
      )
      OR s.to_user_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM swarm.agent_principals AS p
        WHERE p.principal_id = s.to_agent_principal_id
          AND p.workspace_id = s.workspace_id
          AND p.owner_user_id = auth.uid()
      )
    );

ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM anon;
