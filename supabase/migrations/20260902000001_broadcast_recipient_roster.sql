-- Broadcast receipts start from the live workspace rosters, not from the
-- sparse attestation tables. A NULL seen_at is therefore an honest not-seen
-- member state. Broadcasts still create no delivery rows and do not wake or
-- track agents.

-- Forward replacement of 20260901000020_signal_human_receipts.sql.
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
  v_member_total bigint;
  v_member_seen_total bigint;
  v_member_returned bigint;
  v_agent_total bigint;
  v_agent_returned bigint;
  v_roster_limit constant integer := 50;
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

  IF NOT v_addressed THEN
    -- Count the complete live member roster before applying the display cap.
    -- The summary therefore stays honest even when the detail list is cut.
    SELECT
      count(*),
      count(human.first_seen_at)
    INTO v_member_total, v_member_seen_total
    FROM swarm.memberships AS membership
    JOIN swarm.users AS member_user
      ON member_user.user_id = membership.user_id
    LEFT JOIN swarm.signal_human_receipts AS human
      ON human.workspace_id = membership.workspace_id
     AND human.signal_id = p_signal_id
     AND human.user_id = membership.user_id
    WHERE membership.workspace_id = p_workspace_id
      AND membership.revoked_at IS NULL;

    -- Agents have no honest broadcast-observation surface. Include every live
    -- principal owned by a live member, but label it not_tracked rather than
    -- turning missing telemetry into a false not-seen claim.
    SELECT count(*)
    INTO v_agent_total
    FROM swarm.agent_principals AS principal
    JOIN swarm.memberships AS owner_membership
      ON owner_membership.workspace_id = principal.workspace_id
     AND owner_membership.user_id = principal.owner_user_id
     AND owner_membership.revoked_at IS NULL
    WHERE principal.workspace_id = p_workspace_id
      AND principal.revoked_at IS NULL;

    SELECT
      COALESCE(jsonb_agg(row.receipt ORDER BY row.sort_key), '[]'::jsonb),
      count(*) FILTER (WHERE row.recipient_kind = 'member'),
      count(*) FILTER (WHERE row.recipient_kind = 'agent')
    INTO v_receipts, v_member_returned, v_agent_returned
    FROM (
      SELECT
        'member:' || CASE WHEN member.first_seen_at IS NULL THEN '1' ELSE '0' END || ':' ||
          lower(member.display_name) || ':' || member.user_id::text AS sort_key,
        'member'::text AS recipient_kind,
        jsonb_build_object(
          'recipient_user_id', member.user_id,
          'display_name', member.display_name,
          'seen_at', member.first_seen_at
        ) AS receipt
      FROM (
        SELECT
          membership.user_id,
          member_user.display_name,
          human.first_seen_at
        FROM swarm.memberships AS membership
        JOIN swarm.users AS member_user
          ON member_user.user_id = membership.user_id
        LEFT JOIN swarm.signal_human_receipts AS human
          ON human.workspace_id = membership.workspace_id
         AND human.signal_id = p_signal_id
         AND human.user_id = membership.user_id
        WHERE membership.workspace_id = p_workspace_id
          AND membership.revoked_at IS NULL
        ORDER BY
          human.first_seen_at IS NULL,
          lower(member_user.display_name),
          membership.user_id
        LIMIT v_roster_limit
      ) AS member

      UNION ALL

      SELECT
        'agent:' || lower(agent.name) || ':' || agent.principal_id::text AS sort_key,
        'agent'::text AS recipient_kind,
        jsonb_build_object(
          'recipient_agent_principal_id', agent.principal_id,
          'display_name', agent.name,
          'tracking_state', 'not_tracked',
          'observed_at', NULL
        ) AS receipt
      FROM (
        SELECT principal.principal_id, principal.name
        FROM swarm.agent_principals AS principal
        JOIN swarm.memberships AS owner_membership
          ON owner_membership.workspace_id = principal.workspace_id
         AND owner_membership.user_id = principal.owner_user_id
         AND owner_membership.revoked_at IS NULL
        WHERE principal.workspace_id = p_workspace_id
          AND principal.revoked_at IS NULL
        ORDER BY lower(principal.name), principal.principal_id
        LIMIT v_roster_limit
      ) AS agent
    ) AS row;

    RETURN jsonb_build_object(
      'addressed', false,
      'receipts', v_receipts,
      'broadcast_roster', jsonb_build_object(
        'members', jsonb_build_object(
          'total', v_member_total,
          'seen', v_member_seen_total,
          'returned', v_member_returned,
          'limit', v_roster_limit,
          'truncated', v_member_total > v_member_returned
        ),
        'agents', jsonb_build_object(
          'total', v_agent_total,
          'returned', v_agent_returned,
          'limit', v_roster_limit,
          'truncated', v_agent_total > v_agent_returned,
          'tracking_state', 'not_tracked'
        )
      )
    );
  END IF;

  -- Directed behavior is deliberately unchanged from 20260901000020.
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
  ) AS row;

  RETURN jsonb_build_object(
    'addressed', true,
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
  'Members may inspect workspace receipts; agents remain author-only. Broadcast members are rostered with focused-viewport seen state (50-row cap); live agents are rostered as not_tracked because broadcasts do not wake or track agents.';
