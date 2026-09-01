import { readEndpoint, type CloudTarget } from "./config.js";
import {
  SIGNAL_READ_TIMEOUT_MS,
  SignalReadTimeoutError,
} from "./signals.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DeliveryAckOutcome =
  | "replied"
  | "observed"
  | "queued"
  | "expired"
  | "failed_terminal";

export type DeliveryReceiptState =
  | "enqueued"
  | "delivered"
  | "leased"
  | DeliveryAckOutcome;

export interface DeliveryReceipt {
  recipient_agent_principal_id: string;
  enqueued_at: string;
  delivered_at: string | null;
  leased_until: string | null;
  acked_at: string | null;
  ack_outcome: DeliveryAckOutcome | null;
  attempt_count: number;
  lease_expiry_count: number;
  last_error_code: string | null;
}

export interface HumanDeliveryReceipt {
  recipient_user_id: string;
  /** Present on broadcast roster rows; directed rows keep their existing wire shape. */
  display_name?: string;
  /** Null means the member's browser has not attested focused viewport display. */
  seen_at: string | null;
}

export interface UntrackedBroadcastAgentReceipt {
  recipient_agent_principal_id: string;
  display_name: string;
  tracking_state: "not_tracked";
  observed_at: null;
}

export interface BroadcastRosterSection {
  total: number;
  returned: number;
  limit: number;
  truncated: boolean;
}

export interface BroadcastMemberRosterSection extends BroadcastRosterSection {
  seen: number;
}

export interface BroadcastAgentRosterSection extends BroadcastRosterSection {
  tracking_state: "not_tracked";
}

export interface BroadcastRecipientRoster {
  members: BroadcastMemberRosterSection;
  agents: BroadcastAgentRosterSection;
}

export type DeliveryReceiptRow =
  | DeliveryReceipt
  | HumanDeliveryReceipt
  | UntrackedBroadcastAgentReceipt;

export interface DeliveryReceiptResult {
  /** Null means this credential did not author a matching signal. */
  addressed: boolean | null;
  receipts: DeliveryReceiptRow[];
  /** Present only for broadcasts; each section is independently capped at 50. */
  broadcast_roster?: BroadcastRecipientRoster;
}

export interface AgentDeliveryReceiptResult extends DeliveryReceiptResult {
  addressed: boolean;
}

export interface DeliveryReceiptReadOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  deadlineMs?: number;
  now?: () => number;
}

/** Keep unavailable or untrusted receipt reads from acquiring a delivery state. */
export class DeliveryReceiptReadError extends Error {
  constructor(
    readonly code: "transport" | "http" | "protocol" | "not_author",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "DeliveryReceiptReadError";
  }
}

const ACK_OUTCOMES = new Set<DeliveryAckOutcome>([
  "replied",
  "observed",
  "queued",
  "expired",
  "failed_terminal",
]);

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new DeliveryReceiptReadError(
      "protocol",
      `delivery receipt returned a malformed ${field}`,
    );
  }
  return value.toLowerCase();
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new DeliveryReceiptReadError(
      "protocol",
      `delivery receipt returned a malformed ${field}`,
    );
  }
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DeliveryReceiptReadError(
      "protocol",
      `delivery receipt returned a malformed ${field}`,
    );
  }
  return value;
}

function displayName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new DeliveryReceiptReadError(
      "protocol",
      `delivery receipt returned a malformed ${field}`,
    );
  }
  return value;
}

/** Parse the narrow agent-or-human receipt wire without inventing either kind. */
export function parseDeliveryReceipt(value: unknown): DeliveryReceiptRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt returned a malformed row",
    );
  }
  const row = value as Record<string, unknown>;
  if (Object.hasOwn(row, "recipient_user_id")) {
    return {
      recipient_user_id: uuid(row.recipient_user_id, "recipient_user_id"),
      ...(Object.hasOwn(row, "display_name")
        ? { display_name: displayName(row.display_name, "display_name") }
        : {}),
      seen_at: nullableTimestamp(row.seen_at, "seen_at"),
    };
  }
  if (row.tracking_state === "not_tracked") {
    if (row.observed_at !== null) {
      throw new DeliveryReceiptReadError(
        "protocol",
        "delivery receipt returned a tracked observation for an untracked agent",
      );
    }
    return {
      recipient_agent_principal_id: uuid(
        row.recipient_agent_principal_id,
        "recipient_agent_principal_id",
      ),
      display_name: displayName(row.display_name, "display_name"),
      tracking_state: "not_tracked",
      observed_at: null,
    };
  }
  const ackedAt = nullableTimestamp(row.acked_at, "acked_at");
  const ackOutcome = row.ack_outcome === null
    ? null
    : typeof row.ack_outcome === "string" &&
        ACK_OUTCOMES.has(row.ack_outcome as DeliveryAckOutcome)
    ? row.ack_outcome as DeliveryAckOutcome
    : (() => {
      throw new DeliveryReceiptReadError(
        "protocol",
        "delivery receipt returned a malformed ack_outcome",
      );
    })();
  if ((ackedAt === null) !== (ackOutcome === null)) {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt returned an inconsistent acknowledgement",
    );
  }
  return {
    recipient_agent_principal_id: uuid(
      row.recipient_agent_principal_id,
      "recipient_agent_principal_id",
    ),
    enqueued_at: timestamp(row.enqueued_at, "enqueued_at"),
    delivered_at: nullableTimestamp(row.delivered_at, "delivered_at"),
    leased_until: nullableTimestamp(row.leased_until, "leased_until"),
    acked_at: ackedAt,
    ack_outcome: ackOutcome,
    attempt_count: nonNegativeInteger(row.attempt_count, "attempt_count"),
    lease_expiry_count: nonNegativeInteger(
      row.lease_expiry_count,
      "lease_expiry_count",
    ),
    last_error_code: row.last_error_code === null
      ? null
      : typeof row.last_error_code === "string" &&
          /^[a-z][a-z0-9_]{0,63}$/.test(row.last_error_code)
      ? row.last_error_code
      : (() => {
        throw new DeliveryReceiptReadError(
          "protocol",
          "delivery receipt returned a malformed last_error_code",
        );
      })(),
  };
}

function rosterSection(
  value: unknown,
  field: string,
): BroadcastRosterSection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryReceiptReadError(
      "protocol",
      `delivery receipt returned a malformed ${field}`,
    );
  }
  const row = value as Record<string, unknown>;
  const total = nonNegativeInteger(row.total, `${field}.total`);
  const returned = nonNegativeInteger(row.returned, `${field}.returned`);
  const limit = nonNegativeInteger(row.limit, `${field}.limit`);
  if (
    typeof row.truncated !== "boolean" || limit !== 50 || returned > limit ||
    returned > total || row.truncated !== (returned < total)
  ) {
    throw new DeliveryReceiptReadError(
      "protocol",
      `delivery receipt returned a malformed ${field}`,
    );
  }
  return { total, returned, limit, truncated: row.truncated };
}

function parseBroadcastRoster(value: unknown): BroadcastRecipientRoster {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt returned a malformed broadcast_roster",
    );
  }
  const row = value as Record<string, unknown>;
  const members = rosterSection(row.members, "broadcast_roster.members");
  const agents = rosterSection(row.agents, "broadcast_roster.agents");
  const memberRow = row.members as Record<string, unknown>;
  const agentRow = row.agents as Record<string, unknown>;
  const seen = nonNegativeInteger(memberRow.seen, "broadcast_roster.members.seen");
  if (seen > members.total || agentRow.tracking_state !== "not_tracked") {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt returned a malformed broadcast_roster",
    );
  }
  return {
    members: { ...members, seen },
    agents: { ...agents, tracking_state: "not_tracked" },
  };
}

/** Parse author visibility separately from the receipt row set. */
export function parseDeliveryReceiptResult(value: unknown): DeliveryReceiptResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt read returned malformed JSON",
    );
  }
  const body = value as Record<string, unknown>;
  if (
    !(body.addressed === null || typeof body.addressed === "boolean") ||
    !Array.isArray(body.receipts)
  ) {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt read returned malformed JSON",
    );
  }
  const receipts = body.receipts.map(parseDeliveryReceipt);
  const broadcastRoster = Object.hasOwn(body, "broadcast_roster")
    ? parseBroadcastRoster(body.broadcast_roster)
    : undefined;
  const isUntrackedAgent = (
    row: DeliveryReceiptRow,
  ): row is UntrackedBroadcastAgentReceipt =>
    "tracking_state" in row && row.tracking_state === "not_tracked";
  const humanRows = receipts.filter(
    (row): row is HumanDeliveryReceipt => "recipient_user_id" in row,
  );
  const untrackedAgentRows = receipts.filter(isUntrackedAgent);
  if (body.addressed === false) {
    if (
      broadcastRoster === undefined ||
      receipts.some((row) =>
        "recipient_agent_principal_id" in row && !isUntrackedAgent(row)
      ) ||
      humanRows.some((row) => row.display_name === undefined) ||
      humanRows.length !== broadcastRoster.members.returned ||
      untrackedAgentRows.length !== broadcastRoster.agents.returned ||
      humanRows.filter((row) => row.seen_at !== null).length >
        broadcastRoster.members.seen
    ) {
      throw new DeliveryReceiptReadError(
        "protocol",
        "delivery receipt read returned a malformed broadcast roster",
      );
    }
  } else if (broadcastRoster !== undefined || untrackedAgentRows.length > 0) {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt read returned a broadcast roster for an addressed signal",
    );
  }
  if (body.addressed === true && receipts.length === 0) {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt read returned no recipient for an addressed signal",
    );
  }
  const recipientIds = new Set(
    receipts.map((row) =>
      "recipient_agent_principal_id" in row
        ? `agent:${row.recipient_agent_principal_id}`
        : `human:${row.recipient_user_id}`
    ),
  );
  if (recipientIds.size !== receipts.length) {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt read returned duplicate recipients",
    );
  }
  return {
    addressed: body.addressed,
    receipts,
    ...(broadcastRoster === undefined ? {} : { broadcast_roster: broadcastRoster }),
  };
}

/** Derive the display state without collapsing observed into replied. */
export function deliveryReceiptState(
  receipt: DeliveryReceipt,
  nowMs: number = Date.now(),
): DeliveryReceiptState {
  if (receipt.ack_outcome !== null) return receipt.ack_outcome;
  if (
    receipt.leased_until !== null &&
    Date.parse(receipt.leased_until) > nowMs
  ) {
    return "leased";
  }
  if (receipt.delivered_at !== null) return "delivered";
  return "enqueued";
}

/** Read one agent-authored signal's receipts through the agent read edge. */
export async function readAgentDeliveryReceipts(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  signalId: string,
  options: DeliveryReceiptReadOptions | typeof fetch = {},
): Promise<AgentDeliveryReceiptResult> {
  const readOptions = typeof options === "function"
    ? { fetcher: options }
    : options;
  const now = readOptions.now ?? Date.now;
  const timeoutMs = readOptions.deadlineMs === undefined
    ? SIGNAL_READ_TIMEOUT_MS
    : Math.min(SIGNAL_READ_TIMEOUT_MS, readOptions.deadlineMs - now());
  if (timeoutMs <= 0) {
    throw new SignalReadTimeoutError("receipt read timed out");
  }

  const deadlineController = new AbortController();
  const signal = readOptions.signal === undefined
    ? deadlineController.signal
    : AbortSignal.any([readOptions.signal, deadlineController.signal]);
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new SignalReadTimeoutError("receipt read timed out"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(() => deadlineController.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await Promise.race([
        (readOptions.fetcher ?? fetch)(readEndpoint(target), {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            apikey: target.anonKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            resource: "delivery_receipts",
            workspace_id: uuid(workspaceId, "workspace_id"),
            signal_id: uuid(signalId, "signal_id"),
          }),
          signal,
        }),
        aborted,
      ]);
    } catch (error) {
      if (
        error instanceof SignalReadTimeoutError ||
        signal.aborted ||
        (error as Error)?.name === "AbortError"
      ) {
        throw new SignalReadTimeoutError("receipt read timed out");
      }
      if (error instanceof DeliveryReceiptReadError) throw error;
      throw new DeliveryReceiptReadError(
        "transport",
        "delivery receipt read could not reach the cloud service",
      );
    }

    let body: unknown;
    try {
      body = await Promise.race([response.json(), aborted]);
    } catch (error) {
      if (error instanceof SignalReadTimeoutError || signal.aborted) {
        throw new SignalReadTimeoutError("receipt read timed out");
      }
      throw new DeliveryReceiptReadError(
        "protocol",
        "delivery receipt read returned malformed JSON",
      );
    }
    if (!response.ok) {
      throw new DeliveryReceiptReadError(
        "http",
        `delivery receipt read failed (HTTP ${response.status})`,
        response.status,
      );
    }
    const result = parseDeliveryReceiptResult(body);
    if (result.addressed === null) {
      throw new DeliveryReceiptReadError(
        "not_author",
        "delivery receipt read did not establish that this caller authored the signal",
      );
    }
    return {
      addressed: result.addressed,
      receipts: result.receipts,
      ...(result.broadcast_roster === undefined
        ? {}
        : { broadcast_roster: result.broadcast_roster }),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
