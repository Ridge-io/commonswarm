-- Keep the existing receipt authority exact, then add one field only to a
-- queued agent row. The old implementation is private after this migration;
-- the public RPC name remains stable for old and new clients.
ALTER FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  RENAME TO signal_delivery_receipts_without_main_queue_count;

REVOKE ALL ON FUNCTION
  swarm_read.signal_delivery_receipts_without_main_queue_count(uuid, uuid, bytea)
  FROM PUBLIC, anon, authenticated, swarm_read;

CREATE FUNCTION swarm_read.signal_delivery_receipts(
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
  v_result jsonb;
  v_receipts jsonb;
BEGIN
  v_result := swarm_read.signal_delivery_receipts_without_main_queue_count(
    p_workspace_id,
    p_signal_id,
    p_agent_token_hash
  );
  IF v_result IS NULL
     OR v_result ->> 'addressed' <> 'true'
  THEN
    RETURN v_result;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN receipt.value ? 'recipient_agent_principal_id'
             AND receipt.value ->> 'ack_outcome' = 'queued'
        THEN receipt.value || jsonb_build_object(
          'pending_for_main_count',
          (
            SELECT count(*)
            FROM swarm.signal_deliveries AS pending
            WHERE pending.workspace_id = p_workspace_id
              AND pending.recipient_agent_principal_id =
                (receipt.value ->> 'recipient_agent_principal_id')::uuid
              AND pending.ack_outcome = 'queued'
          )
        )
        ELSE receipt.value
      END
      ORDER BY receipt.ordinality
    ),
    '[]'::jsonb
  )
  INTO v_receipts
  FROM jsonb_array_elements(v_result -> 'receipts')
    WITH ORDINALITY AS receipt(value, ordinality);

  RETURN jsonb_set(v_result, '{receipts}', v_receipts, false);
END;
$$;

ALTER FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  TO authenticated, swarm_read;

COMMENT ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) IS
  'Existing receipt authority and roster shape, plus pending_for_main_count on queued agent delivery rows so senders can distinguish transport acknowledgement from session attendance.';
