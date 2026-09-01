-- Forward replacement of 20260902000001_broadcast_recipient_roster.sql.
--
-- WHY THIS EXISTS: old client x new server on the broadcast path.
--
-- 20260902000001 put agent tracking rows
--   {recipient_agent_principal_id, display_name, tracking_state, observed_at}
-- into the `receipts` ARRAY of a broadcast read. The clients installed from npm
-- as commonswarm 0.1.42 and 0.1.43 (the two-branch parser: a row with
-- `recipient_user_id` is a human row, anything else is an agent DELIVERY row and
-- must carry enqueued_at / acked_at / attempt_count) hard-fail on every broadcast
-- receipt in any workspace with one live agent, and the cached dashboard bundle
-- swallows the throw and blanks the indicator. There is no client-version
-- negotiation on this wire, and the server migrates independently of the
-- installed base. Measured 2026-09-01 by running the 619ff1f^ parser (the
-- 0.1.42/0.1.43 blob) against a hand-built wire from this file: it PARSES this
-- shape and THROWS on 20260902000001's — the control discriminates.
--
-- ~~"commonswarm <= 0.1.17"~~ Dead before it shipped: measured against the npm
-- tarballs, 0.1.17..0.1.41 carry a ONE-branch parser that already throws on ANY
-- human attestation row under today's live function (20260901000020). Those
-- clients predate human receipts and are broken on attested broadcasts
-- regardless of this file; this file widens that to every broadcast because the
-- author's owner is always a member row. They must upgrade; that is not a
-- compatibility promise this migration can make.
--
-- The fix is a shape rule: `receipts` carries ONLY row kinds every installed
-- client already parses —
--   * directed reads: agent delivery rows and the one directed human row,
--     byte-identical to 20260901000020;
--   * broadcast reads: human rows {recipient_user_id, display_name, seen_at}.
--     The old human branch reads recipient_user_id and seen_at and ignores
--     display_name; a NULL seen_at is the not-seen state it already renders.
-- Agent tracking rows live EXCLUSIVELY under broadcast_roster.agents.principals,
-- a key the old parsers never read. The old client renders a plain member list;
-- the new client renders the roster. Neither throws.
--
-- APPLY ORDER (all three matter): 20260902000001 has never been applied to
-- production; (1) push both files in one `supabase db push` and verify via a
-- schema_migrations query, not the push output; (2) DEPLOY THE `read` EDGE
-- FUNCTION — the 619ff1f^ read function forwards only {addressed, receipts} and
-- drops broadcast_roster, so a NEW client against an un-redeployed edge throws
-- "malformed broadcast roster"; (3) only then publish a client that requires
-- broadcast_roster. Old clients keep working at every step of that order.
--
-- Identity, authorization, and the directed path are unchanged: identity comes
-- from the PostgREST JWT GUC and never from an auth-schema identity helper,
-- members read every receipt in their workspace, agents remain author-only.
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
  v_agent_principals jsonb;
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

    -- Agents have no honest broadcast-observation surface. Count every live
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

    -- `receipts` holds member rows ONLY. Seen members sort first so the one
    -- member who has seen a broadcast survives the cap whatever their name.
    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'recipient_user_id', member.user_id,
            'display_name', member.display_name,
            'seen_at', member.first_seen_at
          )
          ORDER BY
            member.first_seen_at IS NULL,
            lower(member.display_name),
            member.user_id
        ),
        '[]'::jsonb
      ),
      count(*)
    INTO v_receipts, v_member_returned
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
    ) AS member;

    -- Agent tracking rows live under broadcast_roster.agents.principals and
    -- never in `receipts` — see the header comment.
    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'recipient_agent_principal_id', agent.principal_id,
            'display_name', agent.name,
            'tracking_state', 'not_tracked',
            'observed_at', NULL
          )
          ORDER BY lower(agent.name), agent.principal_id
        ),
        '[]'::jsonb
      ),
      count(*)
    INTO v_agent_principals, v_agent_returned
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
    ) AS agent;

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
          'tracking_state', 'not_tracked',
          'principals', v_agent_principals
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
  'Members may inspect workspace receipts; agents remain author-only. Broadcast `receipts` carries member rows only (focused-viewport seen state, 50-row cap, seen first) so pre-roster clients keep parsing; live agents are listed as not_tracked under broadcast_roster.agents.principals because broadcasts do not wake or track agents.';
