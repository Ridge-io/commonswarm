/**
 * Server half of durable direct-signal delivery (claim / ack).
 * Spec: docs/design/2026-07-31-DURABLE-SIGNAL-DELIVERY.md
 *
 * Bodies never enter delivery metadata, the idempotency ledger, or audit detail.
 * Fresh and replay responses hydrate immutable signals after exact-recipient auth.
 */
import type postgres from "postgres";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const CLAIM_AGENT_INBOX_KIND = "claim_agent_inbox";
export const ACK_AGENT_DELIVERY_KIND = "ack_agent_delivery";

/** Fixed first-release lease duration; callers cannot widen it. */
export const DELIVERY_LEASE_MS = 15 * 60 * 1000;
/** Server-side poison ceiling; callers cannot raise it. */
export const DELIVERY_MAX_ATTEMPTS = 10;
export const DELIVERY_CLAIM_DEFAULT_LIMIT = 10;
export const DELIVERY_CLAIM_MAX_LIMIT = 100;
export const DELIVERY_CLAIM_RATE_LIMIT_PER_MINUTE = 120;
export const DELIVERY_ACK_RATE_LIMIT_PER_MINUTE = 240;
export const DELIVERY_MAX_OUTSTANDING_LEASES = 100;

export const DELIVERY_ACK_OUTCOMES = [
  "replied",
  "observed",
  "queued",
  "expired",
  "failed_terminal",
] as const;
export type DeliveryAckOutcome = (typeof DELIVERY_ACK_OUTCOMES)[number];

/** Client-supplied failed_terminal codes (server poison path is distinct). */
export const DELIVERY_CLIENT_ERROR_CODES = new Set([
  "provider_refused",
  "local_effect_failed",
  "host_session_failed",
  "credential_unavailable",
]);

export type SenderOwnerRelation = "same_owner" | "cross_owner" | "unknown";

export interface ClaimAgentInboxCommand {
  kind: "claim_agent_inbox";
  listener_instance_id: string;
  limit: number;
}

export interface AckAgentDeliveryCommand {
  kind: "ack_agent_delivery";
  signal_id: string;
  lease_id: string | null;
  listener_instance_id: string | null;
  outcome: DeliveryAckOutcome;
  last_error_code: string | null;
}

export interface DeliveryLedgerRef {
  signal_id: string;
  lease_id: string;
  leased_until: string;
  sender_owner_relation: SenderOwnerRelation;
}

export interface DeliveryClaimLedgerResponse {
  ok: true;
  event_ids: [];
  delivery_refs: DeliveryLedgerRef[];
  pending_delivery_count: number;
  terminal_delivery_failure_count: number;
  /**
   * When the OLDEST row in `pending_delivery_count` was enqueued, so a listener
   * can say how long its queue has been waiting instead of only how long it is.
   * The claim wire carried no enqueue times, and
   * docs/evidence/2026-09-05-listener-head-of-line/DESIGN-BOUNDS.md records
   * three wordings that were refused because the listener could not support
   * them. This is the server change that bound asked for.
   *
   * THREE STATES, and they are not interchangeable:
   *   a string  the oldest pending row's enqueue time, as ISO 8601
   *   null      the server looked and nothing is pending
   *   absent    the server did not report it
   *
   * `absent` is reachable on a REPLAY of a claim that was stored before this
   * field existed. A replay of that response also carries the count observed at
   * the time, so collapsing absent into null would pair "nothing is waiting"
   * with a non-zero count and say something the server never said.
   *
   * It counts exactly the set `pending_delivery_count` counts, measured in the
   * same statement -- which includes the row this very claim just leased,
   * because a claim does not acknowledge anything.
   */
  oldest_pending_at?: string | null;
}

export interface DeliveryAckLedgerResponse {
  ok: true;
  event_ids: [];
  signal_id: string;
  outcome: DeliveryAckOutcome;
}

export interface HydratedDelivery {
  signal: {
    id: string;
    workspace_id: string;
    from: string;
    from_kind: "user" | "agent";
    to: string | null;
    to_agent: string | null;
    in_reply_to: string | null;
    about: string | null;
    kind: string;
    body: string;
    attachments: Array<{
      file_id: string;
      version_n: number;
      name: string;
      content_type: string;
      size_bytes: number;
    }>;
    until: string;
    created_at: string;
  };
  lease_id: string;
  leased_until: string;
  sender_owner_relation: SenderOwnerRelation;
}

export const DELIVERY_CAPABILITIES = {
  delivery_claim: 1,
  delivery_ack: 1,
  sender_owner_relation: 1,
  /* Says the server REPORTS oldest_pending_at, which is what lets a reader tell
   * "absent because this server does not send it" from "absent because this is
   * a replay of an older stored response". Clients check the markers they
   * require and ignore the rest, so adding one is safe for every installed
   * listener. */
  oldest_pending_at: 1,
} as const;

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Six-step claim mutation in exact order. Returns body-free ledger refs plus
 * the live-unacked count observed in this transaction.
 */
export async function claimAgentInbox(
  tx: Sql,
  args: {
    workspaceId: string;
    recipientPrincipalId: string;
    receiverOwnerUserId: string;
    listenerInstanceId: string;
    limit: number;
  },
): Promise<DeliveryClaimLedgerResponse | null> {
  // 1. Hold a row lock on the exact recipient agent principal row FOR UPDATE
  const principalRows = await tx<{ principal_id: string; revoked_at: Date | null }[]>`
    SELECT principal_id, revoked_at
    FROM swarm.agent_principals
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND principal_id = ${args.recipientPrincipalId}::uuid
    FOR UPDATE
  `;
  const principalRow = principalRows[0];
  if (!principalRow || principalRow.revoked_at !== null) {
    return null;
  }

  // 2. Reset this recipient's stale leases without acknowledging them.
  await tx`
    UPDATE swarm.signal_deliveries
    SET
      lease_id = NULL,
      leased_by = NULL,
      leased_until = NULL,
      lease_expiry_count = lease_expiry_count + 1,
      last_lease_expired_at = statement_timestamp(),
      updated_at = statement_timestamp()
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND recipient_agent_principal_id = ${args.recipientPrincipalId}::uuid
      AND acked_at IS NULL
      AND lease_id IS NOT NULL
      AND leased_until <= statement_timestamp()
  `;

  // 3. Terminalize unleased rows whose immutable signal TTL elapsed as expired.
  await tx`
    UPDATE swarm.signal_deliveries AS d
    SET
      acked_at = statement_timestamp(),
      ack_outcome = 'expired',
      last_error_code = NULL,
      lease_id = NULL,
      leased_by = NULL,
      leased_until = NULL,
      updated_at = statement_timestamp()
    FROM swarm.signals AS s
    WHERE s.id = d.signal_id
      AND s.workspace_id = d.workspace_id
      AND d.workspace_id = ${args.workspaceId}::uuid
      AND d.recipient_agent_principal_id = ${args.recipientPrincipalId}::uuid
      AND d.acked_at IS NULL
      AND d.lease_id IS NULL
      AND s.until <= statement_timestamp()
  `;

  // 4. Terminalize remaining unleased, signal-live rows at the ten-attempt ceiling.
  // Count rows newly failed in this transaction.
  const poisonRows = await tx<{ signal_id: string }[]>`
    UPDATE swarm.signal_deliveries AS d
    SET
      acked_at = statement_timestamp(),
      ack_outcome = 'failed_terminal',
      last_error_code = 'delivery_attempts_exhausted',
      lease_id = NULL,
      leased_by = NULL,
      leased_until = NULL,
      updated_at = statement_timestamp()
    FROM swarm.signals AS s
    WHERE s.id = d.signal_id
      AND s.workspace_id = d.workspace_id
      AND d.workspace_id = ${args.workspaceId}::uuid
      AND d.recipient_agent_principal_id = ${args.recipientPrincipalId}::uuid
      AND d.acked_at IS NULL
      AND d.lease_id IS NULL
      AND d.attempt_count >= ${DELIVERY_MAX_ATTEMPTS}
      AND s.until > statement_timestamp()
    RETURNING d.signal_id
  `;
  const terminalDeliveryFailureCount = poisonRows.length;

  // 5. Count currently live active leases for this principal and compute slots.
  const activeLeaseRows = await tx<{ active: string | number }[]>`
    SELECT count(*)::int AS active
    FROM swarm.signal_deliveries
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND recipient_agent_principal_id = ${args.recipientPrincipalId}::uuid
      AND acked_at IS NULL
      AND lease_id IS NOT NULL
      AND leased_until > statement_timestamp()
  `;
  const activeLiveLeases = Number(activeLeaseRows[0]?.active ?? 0);
  const slots = Math.max(0, DELIVERY_MAX_OUTSTANDING_LEASES - activeLiveLeases);
  const effectiveLimit = Math.min(args.limit, slots);

  // 6. Select candidate rows with LIMIT effectiveLimit and FOR UPDATE SKIP LOCKED.
  const claimed = effectiveLimit <= 0 ? [] : await tx<{
    signal_id: string;
    lease_id: string;
    leased_until: Date;
    sender_owner_relation: SenderOwnerRelation;
  }[]>`
    WITH candidates AS (
      SELECT d.signal_id, d.recipient_agent_principal_id
      FROM swarm.signal_deliveries AS d
      JOIN swarm.signals AS s
        ON s.id = d.signal_id
       AND s.workspace_id = d.workspace_id
      WHERE d.workspace_id = ${args.workspaceId}::uuid
        AND d.recipient_agent_principal_id = ${args.recipientPrincipalId}::uuid
        AND d.acked_at IS NULL
        AND d.lease_id IS NULL
        AND d.attempt_count < ${DELIVERY_MAX_ATTEMPTS}
        AND s.until > statement_timestamp()
      ORDER BY d.enqueued_at ASC, d.signal_id ASC
      LIMIT ${effectiveLimit}
      FOR UPDATE OF d SKIP LOCKED
    ),
    updated AS (
      UPDATE swarm.signal_deliveries AS d
      SET
        lease_id = gen_random_uuid(),
        leased_by = ${args.listenerInstanceId}::uuid,
        leased_until = statement_timestamp()
          + (${DELIVERY_LEASE_MS} * interval '1 millisecond'),
        attempt_count = d.attempt_count + 1,
        delivered_at = COALESCE(d.delivered_at, statement_timestamp()),
        updated_at = statement_timestamp()
      FROM candidates AS c
      WHERE d.signal_id = c.signal_id
        AND d.recipient_agent_principal_id = c.recipient_agent_principal_id
      RETURNING
        d.signal_id,
        d.lease_id,
        d.leased_until,
        d.workspace_id
    )
    SELECT
      u.signal_id,
      u.lease_id,
      u.leased_until,
      CASE
        WHEN s.from_kind = 'user'
         AND author_member.user_id IS NOT NULL
         AND s.from_principal = ${args.receiverOwnerUserId}::uuid
          THEN 'same_owner'
        WHEN s.from_kind = 'user'
         AND author_member.user_id IS NOT NULL
          THEN 'cross_owner'
        WHEN s.from_kind = 'agent'
         AND author.principal_id IS NOT NULL
         AND author_member.user_id IS NOT NULL
         AND author.owner_user_id = ${args.receiverOwnerUserId}::uuid
          THEN 'same_owner'
        WHEN s.from_kind = 'agent'
         AND author.principal_id IS NOT NULL
         AND author_member.user_id IS NOT NULL
          THEN 'cross_owner'
        ELSE 'unknown'
      END::text AS sender_owner_relation
    FROM updated AS u
    JOIN swarm.signals AS s
      ON s.id = u.signal_id
     AND s.workspace_id = u.workspace_id
    LEFT JOIN swarm.agent_principals AS author
      ON s.from_kind = 'agent'
     AND author.workspace_id = s.workspace_id
     AND author.principal_id = s.from_principal
     AND author.revoked_at IS NULL
    LEFT JOIN swarm.memberships AS author_member
      ON author_member.workspace_id = s.workspace_id
     AND author_member.user_id = COALESCE(author.owner_user_id, CASE WHEN s.from_kind = 'user' THEN s.from_principal END)
     AND author_member.revoked_at IS NULL
    ORDER BY s.created_at ASC, s.id ASC
  `;

  // 7. Exact live-unacked count (unacked + immutable signal still live), and
  // the enqueue time of the OLDEST row in that same set. One statement, one
  // snapshot: a separate query could count one set and time another.
  const countRows = await tx<
    { pending: string | number; oldest: Date | string | null }[]
  >`
    SELECT count(*)::int AS pending, min(d.enqueued_at) AS oldest
    FROM swarm.signal_deliveries AS d
    JOIN swarm.signals AS s
      ON s.id = d.signal_id
     AND s.workspace_id = d.workspace_id
    WHERE d.workspace_id = ${args.workspaceId}::uuid
      AND d.recipient_agent_principal_id = ${args.recipientPrincipalId}::uuid
      AND d.acked_at IS NULL
      AND s.until > statement_timestamp()
  `;
  const pending = Number(countRows[0]?.pending ?? 0);
  const oldestPending = countRows[0]?.oldest ?? null;

  return {
    ok: true,
    event_ids: [],
    delivery_refs: claimed.map((row) => ({
      signal_id: row.signal_id,
      lease_id: row.lease_id,
      leased_until: asIso(row.leased_until),
      sender_owner_relation: row.sender_owner_relation,
    })),
    pending_delivery_count: pending,
    terminal_delivery_failure_count: terminalDeliveryFailureCount,
    /* min() over an empty set is NULL, which is exactly the "nothing pending"
     * state, so no separate branch on the count is needed or wanted: branching
     * would let the two disagree. */
    oldest_pending_at: oldestPending === null ? null : asIso(oldestPending),
  };
}

/**
 * Hydrate body-free claim refs from immutable signals after exact-recipient auth.
 * Missing or mismatched rows are integrity failures (caller maps to
 * delivery_unavailable without enumerating).
 */
export async function hydrateDeliveryRefs(
  tx: Sql,
  args: {
    workspaceId: string;
    recipientPrincipalId: string;
    recipientOwnerUserId?: string | null;
    refs: DeliveryLedgerRef[];
  },
): Promise<HydratedDelivery[] | null> {
  if (args.refs.length === 0) return [];
  const signalIds = args.refs.map((ref) => ref.signal_id);
  const rows = await tx<{
    id: string;
    workspace_id: string;
    from_principal: string;
    from_kind: "user" | "agent";
    to_user_id: string | null;
    to_agent_principal_id: string | null;
    in_reply_to: string | null;
    about: string | null;
    kind: string;
    body: string;
    attachments: Array<{
      file_id: string;
      version_n: number;
      name: string;
      content_type: string;
      size_bytes: number;
    }>;
    until: Date;
    created_at: Date;
    sender_owner_relation: SenderOwnerRelation;
  }[]>`
    SELECT
      s.id,
      s.workspace_id,
      s.from_principal,
      s.from_kind,
      s.to_user_id,
      s.to_agent_principal_id,
      s.in_reply_to,
      s.about,
      s.kind,
      s.body,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'file_id', attachment.file_id,
              'version_n', attachment.version_n,
              'name', file.name,
              'content_type', version.content_type,
              'size_bytes', version.size_bytes::double precision
            ) ORDER BY attachment.position
          )
          FROM swarm.signal_attachments AS attachment
          JOIN swarm.files AS file
            ON file.file_id = attachment.file_id
           AND file.workspace_id = attachment.workspace_id
          JOIN swarm.file_versions AS version
            ON version.file_id = attachment.file_id
           AND version.workspace_id = attachment.workspace_id
           AND version.version_n = attachment.version_n
          WHERE attachment.signal_id = s.id
            AND attachment.workspace_id = s.workspace_id
        ),
        '[]'::jsonb
      ) AS attachments,
      s.until,
      s.created_at,
      CASE
        WHEN s.from_kind = 'user'
         AND author_member.user_id IS NOT NULL
         AND ${args.recipientOwnerUserId ?? null}::uuid IS NOT NULL
         AND s.from_principal = ${args.recipientOwnerUserId ?? null}::uuid
          THEN 'same_owner'
        WHEN s.from_kind = 'user'
         AND author_member.user_id IS NOT NULL
          THEN 'cross_owner'
        WHEN s.from_kind = 'agent'
         AND author.principal_id IS NOT NULL
         AND author_member.user_id IS NOT NULL
         AND ${args.recipientOwnerUserId ?? null}::uuid IS NOT NULL
         AND author.owner_user_id = ${args.recipientOwnerUserId ?? null}::uuid
          THEN 'same_owner'
        WHEN s.from_kind = 'agent'
         AND author.principal_id IS NOT NULL
         AND author_member.user_id IS NOT NULL
          THEN 'cross_owner'
        ELSE 'unknown'
      END::text AS sender_owner_relation
    FROM swarm.signals AS s
    LEFT JOIN swarm.agent_principals AS author
      ON s.from_kind = 'agent'
     AND author.workspace_id = s.workspace_id
     AND author.principal_id = s.from_principal
     AND author.revoked_at IS NULL
    LEFT JOIN swarm.memberships AS author_member
      ON author_member.workspace_id = s.workspace_id
     AND author_member.user_id = COALESCE(author.owner_user_id, CASE WHEN s.from_kind = 'user' THEN s.from_principal END)
     AND author_member.revoked_at IS NULL
    WHERE s.workspace_id = ${args.workspaceId}::uuid
      AND s.to_agent_principal_id = ${args.recipientPrincipalId}::uuid
      AND s.id = ANY (${signalIds}::uuid[])
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const hydrated: HydratedDelivery[] = [];
  for (const ref of args.refs) {
    const signal = byId.get(ref.signal_id);
    if (!signal) return null;
    hydrated.push({
      signal: {
        id: signal.id,
        workspace_id: signal.workspace_id,
        from: signal.from_principal,
        from_kind: signal.from_kind,
        to: signal.to_user_id,
        to_agent: signal.to_agent_principal_id,
        in_reply_to: signal.in_reply_to,
        about: signal.about,
        kind: signal.kind,
        body: signal.body,
        attachments: signal.attachments,
        until: asIso(signal.until),
        created_at: asIso(signal.created_at),
      },
      lease_id: ref.lease_id,
      leased_until: ref.leased_until,
      sender_owner_relation: ref.sender_owner_relation,
    });
  }
  return hydrated;
}

export type AckResult =
  | { status: "accepted"; response: DeliveryAckLedgerResponse }
  | { status: "idempotent"; response: DeliveryAckLedgerResponse }
  | { status: "conflict" }
  | { status: "unavailable" };

/**
 * Acknowledge a live lease, or promote a queued receipt after hook surfacing.
 */
export async function ackAgentDelivery(
  tx: Sql,
  args: {
    workspaceId: string;
    recipientPrincipalId: string;
    signalId: string;
    leaseId: string | null;
    listenerInstanceId: string | null;
    outcome: DeliveryAckOutcome;
    lastErrorCode: string | null;
  },
): Promise<AckResult> {
  // Already acked with same outcome AND same lease/listener identity → idempotent.
  // Lock row FOR UPDATE so concurrent identical ack calls serialize cleanly.
  const existing = await tx<{
    ack_outcome: string | null;
    acked_at: Date | null;
    last_lease_id: string | null;
    last_leased_by: string | null;
  }[]>`
    SELECT ack_outcome, acked_at, last_lease_id, last_leased_by
    FROM swarm.signal_deliveries
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND signal_id = ${args.signalId}::uuid
      AND recipient_agent_principal_id = ${args.recipientPrincipalId}::uuid
    FOR UPDATE
    LIMIT 1
  `;
  const row = existing[0];
  if (!row) return { status: "unavailable" };

  const queuedObservation =
    args.outcome === "observed" &&
    args.lastErrorCode === null &&
    args.leaseId === null &&
    args.listenerInstanceId === null;
  if (queuedObservation) {
    if (row.acked_at === null) return { status: "unavailable" };
    if (row.ack_outcome === "observed") {
      return {
        status: "idempotent",
        response: {
          ok: true,
          event_ids: [],
          signal_id: args.signalId,
          outcome: "observed",
        },
      };
    }
    if (row.ack_outcome !== "queued") return { status: "conflict" };
    await tx`
      UPDATE swarm.signal_deliveries
      SET
        acked_at = statement_timestamp(),
        ack_outcome = 'observed',
        updated_at = statement_timestamp()
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND signal_id = ${args.signalId}::uuid
        AND recipient_agent_principal_id = ${args.recipientPrincipalId}::uuid
        AND ack_outcome = 'queued'
    `;
    return {
      status: "accepted",
      response: {
        ok: true,
        event_ids: [],
        signal_id: args.signalId,
        outcome: "observed",
      },
    };
  }
  if (args.leaseId === null || args.listenerInstanceId === null) {
    return { status: "unavailable" };
  }
  if (row.acked_at !== null) {
    const identityMatches =
      row.last_lease_id !== null &&
      row.last_leased_by !== null &&
      row.last_lease_id === args.leaseId &&
      row.last_leased_by === args.listenerInstanceId;
    if (!identityMatches) return { status: "unavailable" };
    if (row.ack_outcome === args.outcome) {
      return {
        status: "idempotent",
        response: {
          ok: true,
          event_ids: [],
          signal_id: args.signalId,
          outcome: args.outcome,
        },
      };
    }
    return { status: "conflict" };
  }

  // expired is accepted only when the immutable signal TTL has elapsed.
  if (args.outcome === "expired") {
    const ttl = await tx<{ live: boolean }[]>`
      SELECT s.until > statement_timestamp() AS live
      FROM swarm.signals AS s
      WHERE s.workspace_id = ${args.workspaceId}::uuid
        AND s.id = ${args.signalId}::uuid
        AND s.to_agent_principal_id = ${args.recipientPrincipalId}::uuid
      LIMIT 1
    `;
    if (!ttl[0]) return { status: "unavailable" };
    if (ttl[0].live) return { status: "unavailable" };
  }

  // Live ack must match lease_id, leased_by, workspace, recipient.
  // Active leases are never rewritten by TTL cleanup here — a matching live
  // lease may still ack replied after signal TTL (active-lease race).
  const updated = await tx<{ signal_id: string }[]>`
    UPDATE swarm.signal_deliveries
    SET
      acked_at = statement_timestamp(),
      ack_outcome = ${args.outcome},
      last_error_code = ${args.lastErrorCode},
      last_lease_id = lease_id,
      last_leased_by = leased_by,
      lease_id = NULL,
      leased_by = NULL,
      leased_until = NULL,
      updated_at = statement_timestamp()
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND signal_id = ${args.signalId}::uuid
      AND recipient_agent_principal_id = ${args.recipientPrincipalId}::uuid
      AND acked_at IS NULL
      AND lease_id = ${args.leaseId}::uuid
      AND leased_by = ${args.listenerInstanceId}::uuid
      AND leased_until > statement_timestamp()
    RETURNING signal_id
  `;
  if (updated.length === 0) {
    // Post-update re-read: if a concurrent identical ack won the update race, resolve idempotently.
    const reread = await tx<{
      ack_outcome: string | null;
      acked_at: Date | null;
      last_lease_id: string | null;
      last_leased_by: string | null;
    }[]>`
      SELECT ack_outcome, acked_at, last_lease_id::text, last_leased_by::text
      FROM swarm.signal_deliveries
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND signal_id = ${args.signalId}::uuid
        AND recipient_agent_principal_id = ${args.recipientPrincipalId}::uuid
      LIMIT 1
    `;
    const r = reread[0];
    if (r && r.acked_at !== null) {
      const identityMatches =
        r.last_lease_id !== null &&
        r.last_leased_by !== null &&
        r.last_lease_id === args.leaseId &&
        r.last_leased_by === args.listenerInstanceId;
      if (!identityMatches) return { status: "unavailable" };
      if (r.ack_outcome === args.outcome) {
        return {
          status: "idempotent",
          response: {
            ok: true,
            event_ids: [],
            signal_id: args.signalId,
            outcome: args.outcome,
          },
        };
      }
      return { status: "conflict" };
    }
    return { status: "unavailable" };
  }
  return {
    status: "accepted",
    response: {
      ok: true,
      event_ids: [],
      signal_id: args.signalId,
      outcome: args.outcome,
    },
  };
}

/** Parse body-free claim ledger payload; null if malformed. */
export function parseClaimLedger(value: unknown): DeliveryClaimLedgerResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.ok !== true || !Array.isArray(body.event_ids)) return null;
  if (!Array.isArray(body.delivery_refs)) return null;
  if (!Number.isSafeInteger(body.pending_delivery_count)) return null;
  const refs: DeliveryLedgerRef[] = [];
  for (const item of body.delivery_refs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const ref = item as Record<string, unknown>;
    if (
      typeof ref.signal_id !== "string" ||
      typeof ref.lease_id !== "string" ||
      typeof ref.leased_until !== "string" ||
      (ref.sender_owner_relation !== "same_owner" &&
        ref.sender_owner_relation !== "cross_owner" &&
        ref.sender_owner_relation !== "unknown")
    ) {
      return null;
    }
    refs.push({
      signal_id: ref.signal_id,
      lease_id: ref.lease_id,
      leased_until: ref.leased_until,
      sender_owner_relation: ref.sender_owner_relation,
    });
  }
  let terminalFailureCount = 0;
  if (Object.hasOwn(body, "terminal_delivery_failure_count")) {
    const val = (body as Record<string, unknown>).terminal_delivery_failure_count;
    if (!Number.isSafeInteger(val) || (val as number) < 0) return null;
    terminalFailureCount = val as number;
  }
  /* ABSENT stays absent. A stored response written before this field existed
   * must not come back as null: null is the server saying nothing is pending,
   * and that response carries a count from before this field existed. */
  let oldestPending: { oldest_pending_at?: string | null } = {};
  if (Object.hasOwn(body, "oldest_pending_at")) {
    const val = (body as Record<string, unknown>).oldest_pending_at;
    if (val === null) {
      oldestPending = { oldest_pending_at: null };
    } else if (
      typeof val === "string" && Number.isFinite(Date.parse(val))
    ) {
      oldestPending = { oldest_pending_at: val };
    } else {
      return null;
    }
  }
  return {
    ok: true,
    event_ids: [],
    delivery_refs: refs,
    pending_delivery_count: body.pending_delivery_count as number,
    terminal_delivery_failure_count: terminalFailureCount,
    ...oldestPending,
  };
}

/** True when a stored response looks like a claim ledger (body-free). */
export function isClaimLedgerResponse(value: unknown): boolean {
  return parseClaimLedger(value) !== null;
}
