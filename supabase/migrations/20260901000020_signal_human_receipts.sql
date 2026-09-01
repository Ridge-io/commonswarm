-- Human receipt proxy: a browser attests that a signal row was in its viewport
-- while the document had focus. This does not claim comprehension or a reply.

-- ★R14: both denormalized tenant relationships are enforced by composite FKs.
CREATE UNIQUE INDEX IF NOT EXISTS signals_id_workspace
  ON swarm.signals (id, workspace_id);

CREATE TABLE swarm.signal_human_receipts (
  workspace_id uuid NOT NULL,
  signal_id uuid NOT NULL,
  user_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (signal_id, user_id),
  FOREIGN KEY (signal_id, workspace_id)
    REFERENCES swarm.signals (id, workspace_id),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES swarm.memberships (workspace_id, user_id)
);

ALTER TABLE swarm.signal_human_receipts OWNER TO swarm_admin;
ALTER TABLE swarm.signal_human_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.signal_human_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY swarm_admin_all ON swarm.signal_human_receipts
  AS PERMISSIVE FOR ALL TO swarm_admin
  USING (true) WITH CHECK (true);

-- The command edge supplies the authenticated member id. RLS independently
-- refuses rows for missing, revoked, or cross-workspace memberships.
CREATE POLICY swarm_command_live_member_insert ON swarm.signal_human_receipts
  AS PERMISSIVE FOR INSERT TO swarm_command
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM swarm.memberships AS membership
      JOIN swarm.workspaces AS workspace
        ON workspace.workspace_id = membership.workspace_id
       AND workspace.archived_at IS NULL
      WHERE membership.workspace_id = signal_human_receipts.workspace_id
        AND membership.user_id = signal_human_receipts.user_id
        AND membership.revoked_at IS NULL
    )
  );

-- PostgreSQL requires conflict-target reads for INSERT ... ON CONFLICT. Keep
-- that read inside the same live-member tenant boundary as the insert.
CREATE POLICY swarm_command_live_member_select ON swarm.signal_human_receipts
  AS PERMISSIVE FOR SELECT TO swarm_command
  USING (
    EXISTS (
      SELECT 1
      FROM swarm.memberships AS membership
      JOIN swarm.workspaces AS workspace
        ON workspace.workspace_id = membership.workspace_id
       AND workspace.archived_at IS NULL
      WHERE membership.workspace_id = signal_human_receipts.workspace_id
        AND membership.user_id = signal_human_receipts.user_id
        AND membership.revoked_at IS NULL
    )
  );

CREATE TRIGGER signal_human_receipts_append_only
  BEFORE UPDATE OR DELETE ON swarm.signal_human_receipts
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

REVOKE ALL ON TABLE swarm.signal_human_receipts
  FROM PUBLIC, anon, authenticated, swarm_read;
GRANT SELECT, INSERT ON TABLE swarm.signal_human_receipts TO swarm_command;

COMMENT ON TABLE swarm.signal_human_receipts IS
  'Client-attested proxy: the signal row was in this member browser viewport while its document had focus. Append-only; first_seen_at never advances.';

-- Forward replacement of 20260829000001_member_signal_delivery_receipts.sql.
-- Human members remain workspace-wide readers. Agents remain author-only.
CREATE OR REPLACE FUNCTION swarm_read.signal_delivery_receipts(
  p_workspace_id uuid,
  p_signal_id uuid,
  p_agent_token_hash bytea DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  v_human_user_id uuid := NULLIF(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid;
  v_author_kind text;
  v_author_id uuid;
  v_agent_principal_id uuid;
  v_agent_workspace_id uuid;
  v_agent_revoked boolean;
  v_to_user_id uuid;
  v_to_agent_principal_id uuid;
  v_addressed boolean;
  v_receipts jsonb;
BEGIN
  -- A human cannot opt into the narrower agent identity path by supplying a
  -- digest. Identity comes from the PostgREST JWT GUC; this swarm_admin-owned
  -- definer never calls an auth-schema identity helper.
  IF v_human_user_id IS NOT NULL THEN
    IF p_agent_token_hash IS NOT NULL
       OR NOT swarm.is_member(p_workspace_id, v_human_user_id)
    THEN
      RETURN NULL;
    END IF;
  ELSE
    IF p_agent_token_hash IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT
      context.principal_id,
      context.principal_workspace_id,
      context.is_revoked
    INTO
      v_agent_principal_id,
      v_agent_workspace_id,
      v_agent_revoked
    FROM swarm.agent_delivery_read_context(
      p_agent_token_hash,
      p_workspace_id
    ) AS context
    LIMIT 1;

    IF v_agent_principal_id IS NULL
       OR v_agent_revoked
       OR v_agent_workspace_id <> p_workspace_id
    THEN
      RETURN NULL;
    END IF;
    v_author_kind := 'agent';
    v_author_id := v_agent_principal_id;
  END IF;

  SELECT signal.to_user_id, signal.to_agent_principal_id
  INTO v_to_user_id, v_to_agent_principal_id
  FROM swarm.signals AS signal
  WHERE signal.id = p_signal_id
    AND signal.workspace_id = p_workspace_id
    AND (
      v_human_user_id IS NOT NULL
      OR (
        signal.from_kind = v_author_kind
        AND signal.from_principal = v_author_id
      )
    );

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_addressed := v_to_user_id IS NOT NULL OR v_to_agent_principal_id IS NOT NULL;

  SELECT COALESCE(jsonb_agg(row.receipt ORDER BY row.sort_key), '[]'::jsonb)
  INTO v_receipts
  FROM (
    SELECT
      'agent:' || delivery.recipient_agent_principal_id::text AS sort_key,
      jsonb_build_object(
        'recipient_agent_principal_id', delivery.recipient_agent_principal_id,
        'enqueued_at', delivery.enqueued_at,
        'delivered_at', delivery.delivered_at,
        'leased_until', delivery.leased_until,
        'acked_at', delivery.acked_at,
        'ack_outcome', delivery.ack_outcome,
        'attempt_count', delivery.attempt_count,
        'lease_expiry_count', delivery.lease_expiry_count,
        'last_error_code', delivery.last_error_code
      ) AS receipt
    FROM swarm.signal_deliveries AS delivery
    WHERE delivery.signal_id = p_signal_id
      AND delivery.workspace_id = p_workspace_id

    UNION ALL

    -- A directed member always gets one row. NULL means not seen yet.
    SELECT
      'human:' || target.user_id::text AS sort_key,
      jsonb_build_object(
        'recipient_user_id', target.user_id,
        'seen_at', human.first_seen_at
      ) AS receipt
    FROM (SELECT v_to_user_id AS user_id) AS target
    LEFT JOIN swarm.signal_human_receipts AS human
      ON human.workspace_id = p_workspace_id
     AND human.signal_id = p_signal_id
     AND human.user_id = target.user_id
    WHERE target.user_id IS NOT NULL

    UNION ALL

    -- A broadcast has no addressed recipient, but the author may inspect up to
    -- 50 member attestations. The free tier currently caps members below this;
    -- the explicit limit keeps this RPC bounded if that ceiling changes.
    SELECT
      'human:' || broadcast.user_id::text AS sort_key,
      jsonb_build_object(
        'recipient_user_id', broadcast.user_id,
        'seen_at', broadcast.first_seen_at
      ) AS receipt
    FROM (
      SELECT human.user_id, human.first_seen_at
      FROM swarm.signal_human_receipts AS human
      WHERE human.workspace_id = p_workspace_id
        AND human.signal_id = p_signal_id
        AND v_to_user_id IS NULL
        AND v_to_agent_principal_id IS NULL
      ORDER BY human.first_seen_at, human.user_id
      LIMIT 50
    ) AS broadcast
  ) AS row;

  RETURN jsonb_build_object(
    'addressed', v_addressed,
    'receipts', v_receipts
  );
END;
$$;

ALTER FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  TO authenticated, swarm_read;

COMMENT ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) IS
  'Members may inspect workspace receipts; agents remain author-only. Agent rows report delivery state. Human rows report only the client-attested focused-viewport seen proxy.';
