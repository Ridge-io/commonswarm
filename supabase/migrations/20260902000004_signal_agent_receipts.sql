-- An agent receipt is the agent client's attestation that it rendered or
-- consumed one broadcast. It is separate from signal_deliveries: broadcasts
-- do not create directed delivery leases or acknowledgements.
CREATE TABLE swarm.signal_agent_receipts (
  workspace_id uuid NOT NULL,
  signal_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (signal_id, principal_id),
  FOREIGN KEY (signal_id, workspace_id)
    REFERENCES swarm.signals (id, workspace_id),
  FOREIGN KEY (principal_id, workspace_id)
    REFERENCES swarm.agent_principals (principal_id, workspace_id)
);

ALTER TABLE swarm.signal_agent_receipts OWNER TO swarm_admin;
ALTER TABLE swarm.signal_agent_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.signal_agent_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY signal_agent_receipts_admin_all
  ON swarm.signal_agent_receipts
  FOR ALL TO swarm_admin
  USING (true)
  WITH CHECK (true);

CREATE POLICY signal_agent_receipts_command_select
  ON swarm.signal_agent_receipts
  FOR SELECT TO swarm_command
  USING (
    EXISTS (
      SELECT 1
      FROM swarm.agent_principals AS principal
      JOIN swarm.memberships AS owner_membership
        ON owner_membership.workspace_id = principal.workspace_id
       AND owner_membership.user_id = principal.owner_user_id
       AND owner_membership.revoked_at IS NULL
      JOIN swarm.workspaces AS workspace
        ON workspace.workspace_id = principal.workspace_id
       AND workspace.archived_at IS NULL
      WHERE principal.workspace_id = signal_agent_receipts.workspace_id
        AND principal.principal_id = signal_agent_receipts.principal_id
        AND principal.revoked_at IS NULL
    )
  );

CREATE POLICY signal_agent_receipts_command_insert
  ON swarm.signal_agent_receipts
  FOR INSERT TO swarm_command
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM swarm.agent_principals AS principal
      JOIN swarm.memberships AS owner_membership
        ON owner_membership.workspace_id = principal.workspace_id
       AND owner_membership.user_id = principal.owner_user_id
       AND owner_membership.revoked_at IS NULL
      JOIN swarm.workspaces AS workspace
        ON workspace.workspace_id = principal.workspace_id
       AND workspace.archived_at IS NULL
      WHERE principal.workspace_id = signal_agent_receipts.workspace_id
        AND principal.principal_id = signal_agent_receipts.principal_id
        AND principal.revoked_at IS NULL
    )
  );

CREATE POLICY signal_agent_receipts_live_member_select
  ON swarm.signal_agent_receipts
  FOR SELECT TO authenticated
  USING (swarm.is_member(workspace_id, auth.uid()));

CREATE TRIGGER signal_agent_receipts_append_only
BEFORE UPDATE OR DELETE ON swarm.signal_agent_receipts
FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

REVOKE ALL ON swarm.signal_agent_receipts FROM PUBLIC, anon, authenticated, swarm_command;
GRANT SELECT ON swarm.signal_agent_receipts TO authenticated;
GRANT SELECT, INSERT ON swarm.signal_agent_receipts TO swarm_command;

-- 20260902000002 wrapped the author-scoped receipt authority to add the main
-- queue count for directed signals. Keep that wrapper and enrich only its
-- broadcast branch after the private authority has accepted the author.
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
  v_result jsonb;
  v_receipts jsonb;
  v_agent_principals jsonb;
  v_agent_total bigint;
  v_agent_seen_total bigint;
  v_agent_returned bigint;
  v_roster_limit constant integer := 50;
BEGIN
  v_result := swarm_read.signal_delivery_receipts_without_main_queue_count(
    p_workspace_id,
    p_signal_id,
    p_agent_token_hash
  );
  IF v_result IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_result ->> 'addressed' = 'false' THEN
    SELECT count(*), count(agent_receipt.first_seen_at)
    INTO v_agent_total, v_agent_seen_total
    FROM swarm.agent_principals AS principal
    JOIN swarm.memberships AS owner_membership
      ON owner_membership.workspace_id = principal.workspace_id
     AND owner_membership.user_id = principal.owner_user_id
     AND owner_membership.revoked_at IS NULL
    LEFT JOIN swarm.signal_agent_receipts AS agent_receipt
      ON agent_receipt.workspace_id = principal.workspace_id
     AND agent_receipt.signal_id = p_signal_id
     AND agent_receipt.principal_id = principal.principal_id
    WHERE principal.workspace_id = p_workspace_id
      AND principal.revoked_at IS NULL;

    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'principal_id', agent.principal_id,
            'recipient_agent_principal_id', agent.principal_id,
            'display_name', agent.name,
            'seen_at', agent.first_seen_at,
            'tracking_state', 'not_tracked',
            'observed_at', NULL
          )
          ORDER BY
            agent.first_seen_at IS NULL,
            lower(agent.name),
            agent.principal_id
        ),
        '[]'::jsonb
      ),
      count(*)
    INTO v_agent_principals, v_agent_returned
    FROM (
      SELECT principal.principal_id, principal.name, agent_receipt.first_seen_at
      FROM swarm.agent_principals AS principal
      JOIN swarm.memberships AS owner_membership
        ON owner_membership.workspace_id = principal.workspace_id
       AND owner_membership.user_id = principal.owner_user_id
       AND owner_membership.revoked_at IS NULL
      LEFT JOIN swarm.signal_agent_receipts AS agent_receipt
        ON agent_receipt.workspace_id = principal.workspace_id
       AND agent_receipt.signal_id = p_signal_id
       AND agent_receipt.principal_id = principal.principal_id
      WHERE principal.workspace_id = p_workspace_id
        AND principal.revoked_at IS NULL
      ORDER BY
        agent_receipt.first_seen_at IS NULL,
        lower(principal.name),
        principal.principal_id
      LIMIT v_roster_limit
    ) AS agent;

    v_result := jsonb_set(
      v_result,
      '{broadcast_roster,agents}',
      jsonb_build_object(
        'total', v_agent_total,
        'seen', v_agent_seen_total,
        'returned', v_agent_returned,
        'limit', v_roster_limit,
        'truncated', v_agent_total > v_agent_returned,
        -- Retained for clients through 0.1.47. New clients use seen_at.
        'tracking_state', 'not_tracked',
        'principals', v_agent_principals
      ),
      false
    );
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

COMMENT ON TABLE swarm.signal_agent_receipts IS
  'Append-only first-render attestations from agent clients for broadcasts.';
COMMENT ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) IS
  'Author-scoped directed receipts and live broadcast member/agent rosters. Agent seen_at is a CLI render or listener feed-consumption attestation; legacy agent keys remain additive through the 0.1.47 wire.';
