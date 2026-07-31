import {
  assertAgentToken,
  type SenderOwnerRelation,
  type SignalRecord,
} from "./command-client.js";
import {
  CLIENT_PROTOCOL_VERSION,
  commandEndpoint,
  type CloudTarget,
} from "./config.js";
import { parseRetryAfterMs, parseSignalRecord } from "./signals.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-]\d{2}):(\d{2}))$/i;
const DELIVERY_KINDS = new Set<SignalRecord["kind"]>(["ask", "note"]);
const SENDER_OWNER_RELATIONS = new Set<SenderOwnerRelation>([
  "same_owner",
  "cross_owner",
  "unknown",
]);
const DELIVERY_ACK_OUTCOMES = new Set<DeliveryOutcome>([
  "replied",
  "observed",
  "expired",
  "failed_terminal",
]);

/** Per-request deadline covering fetch and the response body read. */
export const DELIVERY_REQUEST_TIMEOUT_MS = 30_000;

const COMMAND_ID_VALIDATOR_RE = /^[A-Za-z0-9_-]{8,72}$/;

const FAILED_TERMINAL_CODES_SET = new Set([
  "provider_refused",
  "local_effect_failed",
  "host_session_failed",
  "credential_unavailable",
]);

const SERVER_ERROR_CODES_SET = new Set([
  "unauthenticated",
  "fresh_auth_required",
  "invalid_request",
  "payload_too_large",
  "forbidden",
  "delivery_unavailable",
  "delivery_ack_conflict",
  "command_id_conflict",
  "rate_limited",
  "upgrade_required",
  "temporarily_unavailable",
  "internal_error",
]);

/** Allowed client failure codes for failed_terminal outcomes. */
export const DELIVERY_FAILED_TERMINAL_CODES: readonly string[] = Object.freeze([
  "provider_refused",
  "local_effect_failed",
  "host_session_failed",
  "credential_unavailable",
]);

/** The bounded client-visible server error vocabulary; anything else collapses. */
export const DELIVERY_SERVER_ERROR_CODES: readonly string[] = Object.freeze([
  "unauthenticated",
  "fresh_auth_required",
  "invalid_request",
  "payload_too_large",
  "forbidden",
  "delivery_unavailable",
  "delivery_ack_conflict",
  "command_id_conflict",
  "rate_limited",
  "upgrade_required",
  "temporarily_unavailable",
  "internal_error",
]);

export const DELIVERY_UNKNOWN_ERROR_CODE = "unknown_error";

/** Direct signal delivery outcome vocabulary (server closed enum). */
export type DeliveryOutcome =
  | "replied"
  | "observed"
  | "expired"
  | "failed_terminal";

export interface DeliveryRow {
  /** Immutable signal the server hydrated for this claim. */
  signal: SignalRecord;
  /** Row-scoped lease capability; never logged or persisted client-side. */
  leaseId: string;
  /** Server lease deadline; the runtime slice decides refusal on replay. */
  leasedUntil: string;
  /**
   * Server-proven authoritative relation; the inner signal is normalized to
   * this exact value so there is only one representation.
   */
  senderOwnerRelation: SenderOwnerRelation;
}

export type DeliveryClaimCapabilities = {
  deliveryClaim: true;
  deliveryAck: true;
  senderOwnerRelation: true;
};

export interface DeliveryClaimResult {
  httpStatus: number;
  capabilities: DeliveryClaimCapabilities;
  deliveries: DeliveryRow[];
  pendingDeliveryCount: number;
  /**
   * Rows newly terminalized as delivery_attempts_exhausted by this claim
   * transaction. Safe metadata, never content.
   */
  terminalDeliveryFailureCount: number;
}

export interface DeliveryAckResult {
  httpStatus: number;
  /** Echoed by the server and required to equal the requested signal id. */
  signalId: string;
  /** Echoed by the server and required to equal the requested outcome. */
  outcome: DeliveryOutcome;
}

export interface DeliveryClaimRequest {
  workspaceId: string;
  /** Agent bearer; never logged or echoed into any error the client raises. */
  credential: string;
  /**
   * Deterministic caller-supplied id. This layer sends exactly the id it is
   * given; retry policy and durable id storage belong to the runtime slice.
   */
  commandId: string;
  listenerInstanceId: string;
  /** The client's own agent principal; every claimed signal must be addressed to it. */
  expectedPrincipalId: string;
}

export interface DeliveryAckRequest {
  workspaceId: string;
  credential: string;
  commandId: string;
  signalId: string;
  leaseId: string;
  listenerInstanceId: string;
  outcome: DeliveryOutcome;
  /** Null for every non-failed outcome; an allowed code for failed_terminal. */
  lastErrorCode: string | null;
}

export interface DeliveryClientOptions {
  /**
   * Per-request deadline in ms covering fetch and the response body read.
   * Injectable for causal deadline tests; defaults to the bounded transport
   * ceiling.
   */
  deadlineMs?: number;
  /** Injected clock for live-lease validation; defaults to Date.now. */
  now?: () => number;
  /** Injected clearTimeout function to verify timer teardown in causal tests. */
  clearTimeout?: typeof clearTimeout;
  /** Injected AbortController factory to verify abort listener cleanup in causal tests. */
  createAbortController?: () => AbortController;
}

/** Transport refused the round trip before a bounded HTTP status existed. */
export class DeliveryTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryTransportError";
  }
}

/**
 * Refused command response carrying the HTTP status, a bounded server error
 * code, and bounded Retry-After metadata. The code comes from an allowlist,
 * never from the body verbatim, so no response content or credential can leak
 * into the message.
 */
export class DeliveryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Parsed with the signal Retry-After semantics; bounded, never the raw header. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "DeliveryHttpError";
  }
}

/** A 2xx response that violated the strict wire contract. */
export class DeliveryProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryProtocolError";
  }
}

function checkedUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new DeliveryProtocolError(
      `delivery response returned a malformed ${field}`,
    );
  }
  return value.toLowerCase();
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12:
      return 31;
    case 4: case 6: case 9: case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * Server timestamps must be RFC3339/ISO shaped (T separator, Z or numeric
 * offset) and component-semantically valid (e.g. real day-in-month, hour 00..23,
 * minute/second 00..59). Date.parse auto-coercions such as Feb 29 on a non-leap
 * year or hour 24 are strictly rejected. The value is never embedded in the error.
 */
function checkedRfc3339Timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new DeliveryProtocolError(
      `delivery response returned a malformed ${field}`,
    );
  }
  const match = RFC3339_TIMESTAMP_RE.exec(value);
  if (!match) {
    throw new DeliveryProtocolError(
      `delivery response returned a malformed ${field}`,
    );
  }
  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);
  const hour = parseInt(match[4]!, 10);
  const minute = parseInt(match[5]!, 10);
  const second = parseInt(match[6]!, 10);

  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59 ||
    second < 0 || second > 59
  ) {
    throw new DeliveryProtocolError(
      `delivery response returned a malformed ${field}`,
    );
  }

  if (match[7] !== undefined && match[8] !== undefined) {
    const offsetHour = Math.abs(parseInt(match[7], 10));
    const offsetMin = parseInt(match[8], 10);
    if (offsetHour > 23 || offsetMin < 0 || offsetMin > 59) {
      throw new DeliveryProtocolError(
        `delivery response returned a malformed ${field}`,
      );
    }
  }

  if (!Number.isFinite(Date.parse(value))) {
    throw new DeliveryProtocolError(
      `delivery response returned a malformed ${field}`,
    );
  }
  return value;
}

/** A lease that has already elapsed cannot be claimed; the value stays out of the error. */
function checkedLiveLease(leasedUntil: string, now: () => number): void {
  if (Date.parse(leasedUntil) <= now()) {
    throw new DeliveryProtocolError(
      "delivery claim response returned an already expired lease",
    );
  }
}

function checkedRelation(value: unknown): SenderOwnerRelation {
  if (
    typeof value !== "string" ||
    !SENDER_OWNER_RELATIONS.has(value as SenderOwnerRelation)
  ) {
    throw new DeliveryProtocolError(
      "delivery response returned a malformed sender_owner_relation",
    );
  }
  return value as SenderOwnerRelation;
}

/** Non-negative safe integer whose value is never embedded in the error. */
function checkedNonNegativeCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DeliveryProtocolError(
      `delivery response returned a malformed ${field}`,
    );
  }
  return value;
}

/** Claim success requires every capability marker exactly 1. */
function checkedClaimCapabilities(value: unknown): DeliveryClaimCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryProtocolError(
      "delivery claim response is missing delivery capabilities",
    );
  }
  const row = value as Record<string, unknown>;
  for (const marker of ["delivery_claim", "delivery_ack", "sender_owner_relation"] as const) {
    if (row[marker] !== 1) {
      throw new DeliveryProtocolError(
        `delivery claim response is missing the ${marker} capability`,
      );
    }
  }
  return { deliveryClaim: true, deliveryAck: true, senderOwnerRelation: true };
}

/** If event_ids is present it must be an array of valid UUID strings. */
function checkedOptionalUuidArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !UUID_RE.test(item))
  ) {
    throw new DeliveryProtocolError(
      `delivery response returned a malformed ${field}`,
    );
  }
}

/** If events is present it must be an array (contents are opaque envelopes). */
function checkedOptionalArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new DeliveryProtocolError(
      `delivery response returned a malformed ${field}`,
    );
  }
}

function parseDeliveryRow(
  value: unknown,
  expected: { workspaceId: string; principalId: string },
  index: number,
  now: () => number,
): DeliveryRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryProtocolError(
      "delivery claim response returned a malformed delivery row",
    );
  }
  const row = value as Record<string, unknown>;
  let signal: SignalRecord;
  try {
    signal = parseSignalRecord(row.signal);
  } catch {
    throw new DeliveryProtocolError(
      `delivery claim response returned a malformed signal at ${index}`,
    );
  }
  if (signal.workspace_id !== expected.workspaceId) {
    throw new DeliveryProtocolError(
      "delivery claim response returned a signal for another workspace",
    );
  }
  if (signal.to_agent !== expected.principalId) {
    throw new DeliveryProtocolError(
      "delivery claim response returned a signal addressed to another agent",
    );
  }
  if (!DELIVERY_KINDS.has(signal.kind)) {
    throw new DeliveryProtocolError(
      "delivery claim response returned a non-direct signal kind",
    );
  }
  const senderOwnerRelation = checkedRelation(row.sender_owner_relation);
  const leaseId = checkedUuid(row.lease_id, "lease_id");
  const leasedUntil = checkedRfc3339Timestamp(row.leased_until, "leased_until");
  checkedLiveLease(leasedUntil, now);
  // The outer relation is authoritative: the immutable signal's inner relation
  // (unknown when absent) must not surface a second, contradicting value.
  signal.sender_owner_relation = senderOwnerRelation;
  return { signal, leaseId, leasedUntil, senderOwnerRelation };
}

function parseClaimSuccess(
  body: unknown,
  expected: { workspaceId: string; principalId: string },
  now: () => number,
): {
  capabilities: DeliveryClaimCapabilities;
  deliveries: DeliveryRow[];
  pendingDeliveryCount: number;
  terminalDeliveryFailureCount: number;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DeliveryProtocolError("delivery claim response was not an object");
  }
  const row = body as Record<string, unknown>;
  if (row.status !== "accepted" || row.ok !== true) {
    throw new DeliveryProtocolError(
      "delivery claim response did not report accepted ok",
    );
  }
  const capabilities = checkedClaimCapabilities(row.capabilities);
  checkedOptionalUuidArray(row.event_ids, "event_ids");
  checkedOptionalArray(row.events, "events");
  if (!Array.isArray(row.deliveries)) {
    throw new DeliveryProtocolError(
      "delivery claim response is missing its deliveries array",
    );
  }
  const deliveries = row.deliveries.map((item, index) =>
    parseDeliveryRow(item, expected, index, now)
  );
  const signalIds = new Set<string>();
  const leaseIds = new Set<string>();
  for (const delivery of deliveries) {
    if (signalIds.has(delivery.signal.id)) {
      throw new DeliveryProtocolError(
        "delivery claim response repeats a signal id",
      );
    }
    signalIds.add(delivery.signal.id);
    if (leaseIds.has(delivery.leaseId)) {
      throw new DeliveryProtocolError(
        "delivery claim response repeats a lease id",
      );
    }
    leaseIds.add(delivery.leaseId);
  }
  if (deliveries.length > 1) {
    throw new DeliveryProtocolError(
      "delivery claim response returned more than one delivery",
    );
  }
  const pendingDeliveryCount = checkedNonNegativeCount(
    row.pending_delivery_count,
    "pending_delivery_count",
  );
  const terminalDeliveryFailureCount = checkedNonNegativeCount(
    row.terminal_delivery_failure_count,
    "terminal_delivery_failure_count",
  );
  if (deliveries.length > pendingDeliveryCount) {
    throw new DeliveryProtocolError(
      "delivery claim response returned more deliveries than its pending count",
    );
  }
  return {
    capabilities,
    deliveries,
    pendingDeliveryCount,
    terminalDeliveryFailureCount,
  };
}

function parseAckSuccess(
  body: unknown,
  expected: { signalId: string; outcome: DeliveryOutcome },
): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DeliveryProtocolError(
      "delivery acknowledgement response was not an object",
    );
  }
  const row = body as Record<string, unknown>;
  if (row.status !== "accepted" || row.ok !== true) {
    throw new DeliveryProtocolError(
      "delivery acknowledgement response did not report accepted ok",
    );
  }
  checkedOptionalUuidArray(row.event_ids, "event_ids");
  checkedOptionalArray(row.events, "events");
  if (row.signal_id !== expected.signalId) {
    throw new DeliveryProtocolError(
      "delivery acknowledgement response echoed a different signal id",
    );
  }
  if (row.outcome !== expected.outcome) {
    throw new DeliveryProtocolError(
      "delivery acknowledgement response echoed a different outcome",
    );
  }
}

function checkedCommandId(value: string): string {
  if (typeof value !== "string" || !COMMAND_ID_VALIDATOR_RE.test(value)) {
    throw new Error(
      "a delivery command id must be 8..72 characters of [A-Za-z0-9_-]",
    );
  }
  return value;
}

function checkedUuidRequest(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${field} must be a UUID for an agent delivery command`);
  }
}

function assertAckRequest(request: DeliveryAckRequest): void {
  checkedCommandId(request.commandId);
  assertAgentToken(request.credential);
  checkedUuidRequest(request.workspaceId, "workspaceId");
  checkedUuidRequest(request.signalId, "signalId");
  checkedUuidRequest(request.leaseId, "leaseId");
  checkedUuidRequest(request.listenerInstanceId, "listenerInstanceId");
  if (!DELIVERY_ACK_OUTCOMES.has(request.outcome as DeliveryOutcome)) {
    throw new Error(
      "a delivery outcome must be replied, observed, expired, or failed_terminal",
    );
  }
  if (request.outcome === "failed_terminal") {
    if (
      typeof request.lastErrorCode !== "string" ||
      !FAILED_TERMINAL_CODES_SET.has(request.lastErrorCode)
    ) {
      throw new Error(
        "a failed_terminal acknowledgement requires one of provider_refused, local_effect_failed, host_session_failed, credential_unavailable",
      );
    }
  } else if (request.lastErrorCode !== null) {
    throw new Error(
      "a non-failed acknowledgement must send lastErrorCode null",
    );
  }
}

/** Collapse an unknown server error to the bounded unknown code. */
function boundedDeliveryErrorCode(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return DELIVERY_UNKNOWN_ERROR_CODE;
  }
  const error = (body as Record<string, unknown>).error;
  if (
    typeof error === "string" &&
    SERVER_ERROR_CODES_SET.has(error)
  ) {
    return error;
  }
  return DELIVERY_UNKNOWN_ERROR_CODE;
}

/** Refusal body parsed against the allowlist; Retry-After via signal semantics. */
function refusal(
  response: Response,
  text: string,
): DeliveryHttpError {
  let code = DELIVERY_UNKNOWN_ERROR_CODE;
  try {
    code = boundedDeliveryErrorCode(JSON.parse(text));
  } catch {
    // An unreadable refusal body is still a refusal; nothing to extract.
  }
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  return new DeliveryHttpError(
    response.status,
    code,
    `delivery command failed (HTTP ${response.status}): ${code}`,
    retryAfterMs,
  );
}

function successBody(response: Response, text: string, verb: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DeliveryProtocolError(
      `${verb} response was not JSON (HTTP ${response.status})`,
    );
  }
}

/**
 * Strict transport and parsing layer for the server's durable
 * `claim_agent_inbox` / `ack_agent_delivery` contract. Sends exactly the
 * command id and body it is given; it never retries, persists, or logs. One
 * injectable deadline covers fetch AND the response body read: the abort/deadline
 * race mirrors `fetchSignalRead`, so a fake or provider that ignores abort still
 * times out and every listener/timer is cleaned.
 */
export class DeliveryCommandClient {
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly createAbortControllerFn: () => AbortController;

  constructor(
    private readonly target: CloudTarget,
    private readonly fetcher: typeof fetch = fetch,
    options: DeliveryClientOptions = {},
  ) {
    this.deadlineMs = options.deadlineMs ?? DELIVERY_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.clearTimeoutFn = options.clearTimeout ?? clearTimeout;
    this.createAbortControllerFn =
      options.createAbortController ?? (() => new AbortController());
  }

  private async post(
    request: { workspaceId: string; credential: string; commandId: string },
    command: Record<string, unknown>,
    verb: string,
  ): Promise<{ response: Response; text: string }> {
    if (this.deadlineMs <= 0) {
      throw new DeliveryTransportError(`${verb} request timed out`);
    }
    const deadlineController = this.createAbortControllerFn();
    let timedOut = false;
    const signal = deadlineController.signal;
    let onAbort = () => {};
    const aborted = new Promise<"timeout">((resolve) => {
      onAbort = () => resolve("timeout");
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      deadlineController.abort();
    }, this.deadlineMs);
    try {
      if (signal.aborted) {
        throw new DeliveryTransportError(`${verb} request timed out`);
      }
      const read = (async (): Promise<
        { response: Response; text: string } | "timeout"
      > => {
        let response: Response;
        try {
          response = await this.fetcher(commandEndpoint(this.target), {
            method: "POST",
            headers: {
              authorization: `Bearer ${request.credential}`,
              apikey: this.target.anonKey,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              command_id: request.commandId,
              client_version: CLIENT_PROTOCOL_VERSION,
              workspace_id: request.workspaceId.toLowerCase(),
              stream: { kind: "workspace" },
              command,
            }),
            signal,
          });
        } catch (error) {
          if (
            signal.aborted ||
            timedOut ||
            (error as Error)?.name === "AbortError"
          ) {
            return "timeout";
          }
          throw new DeliveryTransportError(
            `${verb} request failed before a response`,
          );
        }
        if (signal.aborted || timedOut) return "timeout";
        let text: string;
        try {
          text = await response.text();
        } catch {
          if (signal.aborted || timedOut) return "timeout";
          throw new DeliveryTransportError(
            `${verb} response body was interrupted`,
          );
        }
        if (signal.aborted || timedOut) return "timeout";
        return { response, text };
      })();
      const raced = await Promise.race([read, aborted]);
      if (raced === "timeout") {
        throw new DeliveryTransportError(`${verb} request timed out`);
      }
      return raced;
    } finally {
      this.clearTimeoutFn(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Claim the caller's own single unacked direct-signal delivery row. */
  async claimAgentInbox(request: DeliveryClaimRequest): Promise<DeliveryClaimResult> {
    checkedCommandId(request.commandId);
    assertAgentToken(request.credential);
    checkedUuidRequest(request.workspaceId, "workspaceId");
    checkedUuidRequest(request.listenerInstanceId, "listenerInstanceId");
    checkedUuidRequest(request.expectedPrincipalId, "expectedPrincipalId");
    const { response, text } = await this.post(request, {
      kind: "claim_agent_inbox",
      listener_instance_id: request.listenerInstanceId.toLowerCase(),
      limit: 1,
    }, "delivery claim");
    if (!response.ok) throw refusal(response, text);
    const parsed = parseClaimSuccess(
      successBody(response, text, "delivery claim"),
      {
        workspaceId: request.workspaceId.toLowerCase(),
        principalId: request.expectedPrincipalId.toLowerCase(),
      },
      this.now,
    );
    return {
      httpStatus: response.status,
      capabilities: parsed.capabilities,
      deliveries: parsed.deliveries,
      pendingDeliveryCount: parsed.pendingDeliveryCount,
      terminalDeliveryFailureCount: parsed.terminalDeliveryFailureCount,
    };
  }

  /** Acknowledge one leased delivery with an exact terminal outcome. */
  async ackAgentDelivery(request: DeliveryAckRequest): Promise<DeliveryAckResult> {
    assertAckRequest(request);
    const { response, text } = await this.post(request, {
      kind: "ack_agent_delivery",
      signal_id: request.signalId.toLowerCase(),
      lease_id: request.leaseId.toLowerCase(),
      listener_instance_id: request.listenerInstanceId.toLowerCase(),
      outcome: request.outcome,
      last_error_code: request.lastErrorCode,
    }, "delivery acknowledgement");
    if (!response.ok) throw refusal(response, text);
    parseAckSuccess(
      successBody(response, text, "delivery acknowledgement"),
      {
        signalId: request.signalId.toLowerCase(),
        outcome: request.outcome,
      },
    );
    return {
      httpStatus: response.status,
      signalId: request.signalId.toLowerCase(),
      outcome: request.outcome,
    };
  }
}