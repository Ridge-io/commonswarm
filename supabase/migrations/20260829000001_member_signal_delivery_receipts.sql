-- Let workspace members inspect delivery receipts for every signal they can already read.
-- Agent callers remain author-only.
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
  v_addressed boolean;
  v_receipts jsonb;
BEGIN
  -- A PostgREST human request has a JWT subject. Membership already permits
  -- reading every signal body in this workspace, so it also permits reading
  -- every matching signal's delivery metadata. A human cannot opt into the
  -- narrower agent identity path by supplying an agent digest.
  IF v_human_user_id IS NOT NULL THEN
    IF p_agent_token_hash IS NOT NULL
       OR NOT swarm.is_member(p_workspace_id, v_human_user_id)
    THEN
      RETURN NULL;
    END IF;
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

  -- Human members can inspect any signal in their workspace. For agents, the
  -- two author predicates below remain the cross-sender security boundary.
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
  'A human workspace member may inspect any signal in that workspace. An agent may inspect only its own signals. A broadcast returns addressed=false with no receipt rows.';
