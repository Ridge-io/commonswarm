-- Workspace access lifecycle for the consumer invite flow.
--
-- Model is descriptive agent identity, never authority. The two views expose
-- lifecycle metadata only: no invitation digest, agent token digest, or raw
-- credential can cross the PostgREST boundary.

ALTER TABLE swarm.agent_principals
  ADD COLUMN IF NOT EXISTS model text;

COMMENT ON COLUMN swarm.agent_principals.model IS
  'Human-declared agent model label for identity and attribution only; never an authorization input.';

ALTER TABLE swarm.agent_principals
  DROP CONSTRAINT IF EXISTS agent_principals_model_bounded;

ALTER TABLE swarm.agent_principals
  ADD CONSTRAINT agent_principals_model_bounded
  CHECK (
    model IS NULL
    OR (
      model = btrim(model)
      AND char_length(model) BETWEEN 1 AND 120
      AND model !~ '[[:cntrl:]]'
    )
  );

-- PostgreSQL expands SELECT * when the view is created, not at read time.
-- Recreate the membership-gated projection after adding model so PostgREST
-- exposes the new descriptive field without granting authority-table access.
CREATE OR REPLACE VIEW swarm_read.agent_principals
WITH (security_barrier = true)
AS
  SELECT p.*
  FROM swarm.agent_principals AS p
  WHERE swarm.is_member(p.workspace_id, auth.uid());

CREATE OR REPLACE VIEW swarm_read.pending_invitations
WITH (security_barrier = true)
AS
  SELECT
    i.workspace_id,
    i.invitation_id,
    i.email,
    i.role,
    i.created_by,
    i.created_at,
    i.expires_at
  FROM swarm.invitations AS i
  WHERE i.consumed_at IS NULL
    AND i.revoked_at IS NULL
    AND i.expires_at > statement_timestamp()
    AND EXISTS (
      SELECT 1
      FROM swarm.memberships AS viewer
      WHERE viewer.workspace_id = i.workspace_id
        AND viewer.user_id = auth.uid()
        AND viewer.revoked_at IS NULL
        AND viewer.role IN ('owner', 'admin')
    );

CREATE OR REPLACE VIEW swarm_read.agent_access_status
WITH (security_barrier = true)
AS
  SELECT
    p.workspace_id,
    p.principal_id,
    p.owner_user_id,
    p.name AS agent_name,
    p.model,
    t.token_id,
    t.issued_at,
    t.expires_at,
    t.first_used_at,
    t.revoked_at
  FROM swarm.agent_tokens AS t
  JOIN swarm.agent_principals AS p USING (principal_id)
  WHERE t.predecessor_token_id IS NULL
    AND p.revoked_at IS NULL
    AND (
      p.owner_user_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM swarm.memberships AS viewer
        WHERE viewer.workspace_id = p.workspace_id
          AND viewer.user_id = auth.uid()
          AND viewer.revoked_at IS NULL
          AND viewer.role IN ('owner', 'admin')
      )
    );

ALTER VIEW swarm_read.pending_invitations OWNER TO swarm_admin;
ALTER VIEW swarm_read.agent_access_status OWNER TO swarm_admin;

GRANT SELECT ON
  swarm_read.pending_invitations,
  swarm_read.agent_access_status
TO authenticated, swarm_read;

REVOKE ALL ON
  swarm_read.pending_invitations,
  swarm_read.agent_access_status
FROM anon;

-- Positive controls: prove the migration created the identity field and that
-- neither lifecycle view exposes credential material.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'swarm.agent_principals'::regclass
      AND attname = 'model'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'swarm.agent_principals.model was not created' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'swarm_read'
      AND table_name = 'agent_principals'
      AND column_name = 'model'
  ) THEN
    RAISE EXCEPTION 'swarm_read.agent_principals.model was not projected'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'swarm_read'
      AND table_name IN ('pending_invitations', 'agent_access_status')
      AND column_name IN ('token_hash', 'invitation_token', 'agent_token')
  ) THEN
    RAISE EXCEPTION 'a credential field leaked into a workspace access view'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
