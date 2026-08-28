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

/** Parse the narrow receipt wire shape without accepting invented outcomes. */
export function parseDeliveryReceipt(value: unknown): DeliveryReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt returned a malformed row",
    );
  }
  const row = value as Record<string, unknown>;
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
  if (body.addressed === false && receipts.length !== 0) {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt read returned recipients for a broadcast",
    );
  }
  if (body.addressed === true && receipts.length === 0) {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt read returned no recipient for an addressed signal",
    );
  }
  const recipientIds = new Set(
    receipts.map((row) => row.recipient_agent_principal_id),
  );
  if (recipientIds.size !== receipts.length) {
    throw new DeliveryReceiptReadError(
      "protocol",
      "delivery receipt read returned duplicate recipients",
    );
  }
  return { addressed: body.addressed, receipts };
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
    return { addressed: result.addressed, receipts: result.receipts };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
