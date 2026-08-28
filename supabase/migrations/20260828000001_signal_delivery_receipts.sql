-- Author-only delivery receipts for human and agent signal senders.
-- Spec: docs/design/2026-08-28-DELIVERY-RECEIPTS.md

CREATE OR REPLACE FUNCTION swarm_read.signal_delivery_receipts(
  p_workspace_id uuid,
  p_signal_id uuid,
  p_agent_token_hash bytea DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_human_user_id uuid := auth.uid();
  v_author_kind text;
  v_author_id uuid;
  v_agent_principal_id uuid;
  v_agent_workspace_id uuid;
  v_agent_revoked boolean;
  v_addressed boolean;
  v_receipts jsonb;
BEGIN
  -- A PostgREST human request has auth.uid(). Refuse an agent hash on that
  -- path so a signed-in person cannot change caller kind by supplying one.
  IF v_human_user_id IS NOT NULL THEN
    IF p_agent_token_hash IS NOT NULL
       OR NOT swarm.is_member(p_workspace_id, v_human_user_id)
    THEN
      RETURN NULL;
    END IF;
    v_author_kind := 'user';
    v_author_id := v_human_user_id;
  ELSE
    -- The read edge has no user JWT in its database session. It supplies the
    -- SHA-256 agent bearer digest and reuses the existing credential definer,
    -- including first-use, expiry, membership, workspace and revocation gates.
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

  -- These two author predicates are the security boundary. The workspace
  -- predicate is separate and also required: neither membership nor signal id
  -- alone proves that this caller authored this signal in this workspace.
  SELECT EXISTS (
    SELECT 1
    FROM swarm.signal_deliveries AS delivery
    WHERE delivery.signal_id = signal.id
      AND delivery.workspace_id = signal.workspace_id
  )
  INTO v_addressed
  FROM swarm.signals AS signal
  WHERE signal.id = p_signal_id
    AND signal.workspace_id = p_workspace_id
    AND signal.from_kind = v_author_kind
    AND signal.from_principal = v_author_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
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
      )
      ORDER BY delivery.recipient_agent_principal_id
    ),
    '[]'::jsonb
  )
  INTO v_receipts
  FROM swarm.signal_deliveries AS delivery
  WHERE delivery.signal_id = p_signal_id
    AND delivery.workspace_id = p_workspace_id;

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
  'Returns no result for a non-author. An author receives addressed=false plus an empty receipt array for a broadcast, or one minimal receipt per delivery recipient.';
