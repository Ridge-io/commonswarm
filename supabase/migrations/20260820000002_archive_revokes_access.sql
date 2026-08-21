-- Closing a workspace is an availability boundary, not a list preference.
-- Put the live-workspace check in the shared membership predicate so every
-- membership-gated human view fails closed without each caller remembering it.
CREATE OR REPLACE FUNCTION swarm.is_member(p_workspace uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM swarm.memberships AS m
    JOIN swarm.workspaces AS w
      ON w.workspace_id = m.workspace_id
     AND w.archived_at IS NULL
    WHERE m.workspace_id = p_workspace
      AND m.user_id = p_user
      AND m.revoked_at IS NULL
  )
$$;

ALTER FUNCTION swarm.is_member(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.is_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm.is_member(uuid, uuid)
  TO authenticated, swarm_command, swarm_read;

-- These two lifecycle views carried hand-written membership checks instead of
-- swarm.is_member. Keep their role rules and add the shared live-member gate.
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
    AND swarm.is_member(i.workspace_id, auth.uid())
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
    AND swarm.is_member(p.workspace_id, auth.uid())
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

-- Agent reads do not authenticate through a PostgREST view. Their definer
-- context is the one gate that stamps first use, checks revocation, and returns
-- the pending-delivery count. Recreate it with swarm.is_member in that same
-- revocation decision so an archived home workspace returns forbidden before
-- any signal, member, or file query runs. Clearing archived_at restores access;
-- no token or membership row is destroyed.
CREATE OR REPLACE FUNCTION swarm.agent_delivery_read_context(
  p_token_hash bytea,
  p_workspace_id uuid
)
RETURNS TABLE (
  token_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  principal_workspace_id uuid,
  run_id uuid,
  device_id uuid,
  first_use boolean,
  membership_revoked_at timestamptz,
  is_revoked boolean,
  pending_delivery_count integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  v_token_id uuid;
  v_first_use boolean;
  v_principal_id uuid;
  v_owner_user_id uuid;
  v_principal_workspace_id uuid;
  v_run_id uuid;
  v_device_id uuid;
  v_lineage_id uuid;
  v_token_revoked_at timestamptz;
  v_principal_revoked_at timestamptz;
  v_run_ended_at timestamptz;
  v_device_revoked_at timestamptz;
  v_surrender_only boolean;
  v_unexpired boolean;
  v_membership_revoked_at timestamptz;
  v_revoked boolean := false;
  v_pending integer := 0;
  v_ids uuid[];
BEGIN
  -- Stamp first-use under the same join constraints as loadAgentCredential.
  WITH presented AS (
    SELECT t.token_id, t.predecessor_token_id, t.first_used_at
    FROM swarm.agent_tokens AS t
    JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
    JOIN swarm.agent_runs AS r
      ON r.run_id = t.run_id AND r.principal_id = t.principal_id
    JOIN swarm.devices AS d ON d.device_id = r.device_id
    WHERE t.token_hash = p_token_hash
    LIMIT 1
  ),
  stamp AS (
    UPDATE swarm.agent_tokens AS s
    SET first_used_at = statement_timestamp()
    FROM presented AS pre
    WHERE s.token_id = pre.token_id
      AND s.first_used_at IS NULL
      AND s.revoked_at IS NULL
      AND s.expires_at > statement_timestamp()
    RETURNING s.token_id
  ),
  handover AS (
    UPDATE swarm.agent_tokens AS pred
    SET expires_at = statement_timestamp()
    FROM presented AS pre
    JOIN stamp AS st ON st.token_id = pre.token_id
    WHERE pred.token_id = pre.predecessor_token_id
      AND pred.revoked_at IS NULL
      AND pred.expires_at > statement_timestamp()
    RETURNING pred.token_id
  )
  SELECT pre.token_id, pre.first_used_at IS NULL
  INTO v_token_id, v_first_use
  FROM presented AS pre;

  IF v_token_id IS NULL THEN
    RETURN;
  END IF;

  -- Fresh liveness snapshot after the stamp lock is released.
  SELECT
    t.token_id,
    t.principal_id,
    p.owner_user_id,
    p.workspace_id,
    t.run_id,
    r.device_id,
    t.lineage_id,
    t.revoked_at,
    p.revoked_at,
    r.ended_at,
    d.revoked_at,
    t.surrender_only,
    t.expires_at > statement_timestamp()
  INTO
    v_token_id,
    v_principal_id,
    v_owner_user_id,
    v_principal_workspace_id,
    v_run_id,
    v_device_id,
    v_lineage_id,
    v_token_revoked_at,
    v_principal_revoked_at,
    v_run_ended_at,
    v_device_revoked_at,
    v_surrender_only,
    v_unexpired
  FROM swarm.agent_tokens AS t
  JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
  JOIN swarm.agent_runs AS r
    ON r.run_id = t.run_id AND r.principal_id = t.principal_id
  JOIN swarm.devices AS d ON d.device_id = r.device_id
  WHERE t.token_id = v_token_id;

  IF NOT COALESCE(v_unexpired, false) THEN
    RETURN;
  END IF;

  SELECT m.revoked_at
  INTO v_membership_revoked_at
  FROM swarm.memberships AS m
  WHERE m.workspace_id = v_principal_workspace_id
    AND m.user_id = v_owner_user_id
  LIMIT 1;

  IF NOT FOUND THEN
    v_revoked := true;
  ELSIF NOT swarm.is_member(v_principal_workspace_id, v_owner_user_id)
     OR v_membership_revoked_at IS NOT NULL
     OR v_token_revoked_at IS NOT NULL
     OR v_principal_revoked_at IS NOT NULL
     OR v_run_ended_at IS NOT NULL
     OR v_device_revoked_at IS NOT NULL
     OR v_surrender_only
  THEN
    v_revoked := true;
  ELSE
    v_ids := ARRAY[
      v_token_id,
      v_principal_id,
      v_run_id,
      v_device_id,
      v_owner_user_id,
      v_lineage_id
    ];
    IF EXISTS (
      SELECT 1
      FROM swarm.revocation_tombstones AS rt
      WHERE rt.target_id = ANY (v_ids)
        AND (
          (rt.kind = 'token' AND rt.target_id = v_token_id)
          OR (rt.kind = 'principal' AND rt.target_id = v_principal_id)
          OR (rt.kind = 'run' AND rt.target_id = v_run_id)
          OR (rt.kind = 'device' AND rt.target_id = v_device_id)
          OR (rt.kind = 'membership' AND rt.target_id = v_owner_user_id)
          OR (rt.kind = 'lineage' AND rt.target_id = v_lineage_id)
          OR (rt.kind = 'family' AND rt.target_id = v_lineage_id)
        )
    ) THEN
      v_revoked := true;
    END IF;
  END IF;

  -- Live-unacked = unacked rows whose immutable signal is still live.
  -- Foreign workspace requests still authenticate but report count for the
  -- principal's home workspace only when p_workspace_id matches.
  IF NOT v_revoked
     AND p_workspace_id IS NOT NULL
     AND p_workspace_id = v_principal_workspace_id
  THEN
    SELECT count(*)::integer
    INTO v_pending
    FROM swarm.signal_deliveries AS d
    JOIN swarm.signals AS s
      ON s.id = d.signal_id
     AND s.workspace_id = d.workspace_id
    WHERE d.recipient_agent_principal_id = v_principal_id
      AND d.workspace_id = v_principal_workspace_id
      AND d.acked_at IS NULL
      AND s.until > statement_timestamp();
  END IF;

  token_id := v_token_id;
  principal_id := v_principal_id;
  owner_user_id := v_owner_user_id;
  principal_workspace_id := v_principal_workspace_id;
  run_id := v_run_id;
  device_id := v_device_id;
  first_use := v_first_use;
  membership_revoked_at := v_membership_revoked_at;
  is_revoked := v_revoked;
  pending_delivery_count := COALESCE(v_pending, 0);
  RETURN NEXT;
END;
$$;

ALTER FUNCTION swarm.agent_delivery_read_context(bytea, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_delivery_read_context(bytea, uuid) FROM PUBLIC;
-- swarm_read needs schema USAGE only to resolve the definer call; it still has
-- zero table privileges on swarm.signal_deliveries or other authority tables.
GRANT USAGE ON SCHEMA swarm TO swarm_read;
GRANT EXECUTE ON FUNCTION swarm.agent_delivery_read_context(bytea, uuid) TO swarm_read;
