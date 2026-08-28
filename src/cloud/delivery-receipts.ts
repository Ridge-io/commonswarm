import { readEndpoint, type CloudTarget } from "./config.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DeliveryAckOutcome =
  | "replied"
  | "observed"
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

export interface DeliveryReceiptResult {
  /** Null means this credential did not author a matching signal. */
  addressed: boolean | null;
  receipts: DeliveryReceipt[];
}

const ACK_OUTCOMES = new Set<DeliveryAckOutcome>([
  "replied",
  "observed",
  "expired",
  "failed_terminal",
]);

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`delivery receipt returned a malformed ${field}`);
  }
  return value.toLowerCase();
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`delivery receipt returned a malformed ${field}`);
  }
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`delivery receipt returned a malformed ${field}`);
  }
  return value;
}

/** Parse the narrow receipt wire shape without accepting invented outcomes. */
export function parseDeliveryReceipt(value: unknown): DeliveryReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("delivery receipt returned a malformed row");
  }
  const row = value as Record<string, unknown>;
  const ackedAt = nullableTimestamp(row.acked_at, "acked_at");
  const ackOutcome = row.ack_outcome === null
    ? null
    : typeof row.ack_outcome === "string" &&
        ACK_OUTCOMES.has(row.ack_outcome as DeliveryAckOutcome)
    ? row.ack_outcome as DeliveryAckOutcome
    : (() => {
      throw new Error("delivery receipt returned a malformed ack_outcome");
    })();
  if ((ackedAt === null) !== (ackOutcome === null)) {
    throw new Error("delivery receipt returned an inconsistent acknowledgement");
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
        throw new Error("delivery receipt returned a malformed last_error_code");
      })(),
  };
}

/** Parse author visibility separately from the receipt row set. */
export function parseDeliveryReceiptResult(value: unknown): DeliveryReceiptResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("delivery receipt read returned malformed JSON");
  }
  const body = value as Record<string, unknown>;
  if (
    !(body.addressed === null || typeof body.addressed === "boolean") ||
    !Array.isArray(body.receipts)
  ) {
    throw new Error("delivery receipt read returned malformed JSON");
  }
  return {
    addressed: body.addressed,
    receipts: body.receipts.map(parseDeliveryReceipt),
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
  fetcher: typeof fetch = fetch,
): Promise<DeliveryReceiptResult> {
  const response = await fetcher(readEndpoint(target), {
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
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`delivery receipt read failed (HTTP ${response.status})`);
  }
  return parseDeliveryReceiptResult(body);
}
