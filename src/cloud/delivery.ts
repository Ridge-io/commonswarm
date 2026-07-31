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
import { parseSignalRecord } from "./signals.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

export const DELIVERY_CLAIM_MIN_LIMIT = 1;
export const DELIVERY_CLAIM_MAX_LIMIT = 100;
/** Mirrors the command edge's command_id bound so a typo fails before the round trip. */
export const DELIVERY_COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,72}$/;
export const DELIVERY_FAILED_TERMINAL_CODES = new Set([
  "provider_refused",
  "local_effect_failed",
  "host_session_failed",
  "credential_unavailable",
]);
/** The bounded client-visible server error vocabulary; anything else collapses. */
export const DELIVERY_SERVER_ERROR_CODES = new Set([
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
  /** Server-proven authoritative relation; the inner signal cannot upgrade it. */
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
  limit: number;
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

/** Transport refused the round trip before an HTTP status existed. */
export class DeliveryTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryTransportError";
  }
}

/**
 * Refused command response carrying the HTTP status and a bounded server error
 * code. The code comes from an allowlist, never from the body verbatim, so no
 * response content or credential can leak into the message.
 */
export class DeliveryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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

function checkedTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new DeliveryProtocolError(
      `delivery response returned a malformed ${field}`,
    );
  }
  return value;
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

function checkedPendingCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DeliveryProtocolError(
      "delivery response returned a malformed pending_delivery_count",
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

function parseDeliveryRow(
  value: unknown,
  expected: { workspaceId: string; principalId: string },
  index: number,
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
  } catch (error) {
    throw new DeliveryProtocolError(
      `delivery claim response returned a malformed signal at ${index}: ${
        error instanceof Error ? error.message : String(error)
      }`,
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
  return {
    signal,
    leaseId: checkedUuid(row.lease_id, "lease_id"),
    leasedUntil: checkedTimestamp(row.leased_until, "leased_until"),
    senderOwnerRelation: checkedRelation(row.sender_owner_relation),
  };
}

function parseClaimSuccess(
  body: unknown,
  expected: { workspaceId: string; principalId: string },
): {
  capabilities: DeliveryClaimCapabilities;
  deliveries: DeliveryRow[];
  pendingDeliveryCount: number;
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
  if (!Array.isArray(row.deliveries)) {
    throw new DeliveryProtocolError(
      "delivery claim response is missing its deliveries array",
    );
  }
  const deliveries = row.deliveries.map((item, index) =>
    parseDeliveryRow(item, expected, index)
  );
  const signalIds = new Set<string>();
  const leaseIds = new Set<string>();
  for (const delivery of deliveries) {
    if (signalIds.has(delivery.signal.id)) {
      throw new DeliveryProtocolError(
        `delivery claim response repeats signal ${delivery.signal.id}`,
      );
    }
    signalIds.add(delivery.signal.id);
    if (leaseIds.has(delivery.leaseId)) {
      throw new DeliveryProtocolError(
        `delivery claim response repeats lease id ${delivery.leaseId}`,
      );
    }
    leaseIds.add(delivery.leaseId);
  }
  const pendingDeliveryCount = checkedPendingCount(row.pending_delivery_count);
  if (deliveries.length > pendingDeliveryCount) {
    throw new DeliveryProtocolError(
      "delivery claim response returned more deliveries than its pending count",
    );
  }
  return { capabilities, deliveries, pendingDeliveryCount };
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
  if (!DELIVERY_COMMAND_ID_RE.test(value)) {
    throw new Error(
      "a delivery command id must be 8..72 characters of [A-Za-z0-9_-]",
    );
  }
  return value;
}

function checkedLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < DELIVERY_CLAIM_MIN_LIMIT ||
    value > DELIVERY_CLAIM_MAX_LIMIT
  ) {
    throw new Error("a delivery claim limit must be an integer in 1..100");
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
      !DELIVERY_FAILED_TERMINAL_CODES.has(request.lastErrorCode)
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
    DELIVERY_SERVER_ERROR_CODES.has(error)
  ) {
    return error;
  }
  return DELIVERY_UNKNOWN_ERROR_CODE;
}

async function refusal(response: Response): Promise<DeliveryHttpError> {
  let code = DELIVERY_UNKNOWN_ERROR_CODE;
  try {
    code = boundedDeliveryErrorCode(JSON.parse(await response.text()));
  } catch {
    // An unreadable refusal body is still a refusal; nothing to extract.
  }
  return new DeliveryHttpError(
    response.status,
    code,
    `delivery command failed (HTTP ${response.status}): ${code}`,
  );
}

/**
 * Strict transport and parsing layer for the server's durable
 * `claim_agent_inbox` / `ack_agent_delivery` contract. Sends exactly the
 * command id and body it is given; it never retries, persists, or logs.
 */
export class DeliveryCommandClient {
  constructor(
    private readonly target: CloudTarget,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async post(
    request: { workspaceId: string; credential: string; commandId: string },
    command: Record<string, unknown>,
    verb: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
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
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new DeliveryTransportError(`${verb} request timed out`);
      }
      throw new DeliveryTransportError(
        `${verb} request failed before a response`,
      );
    } finally {
      clearTimeout(timer);
    }
    return response;
  }

  private async successBody(response: Response, verb: string): Promise<unknown> {
    try {
      return JSON.parse(await response.text());
    } catch {
      throw new DeliveryProtocolError(
        `${verb} response was not JSON (HTTP ${response.status})`,
      );
    }
  }

  /** Claim one page of the caller's own unacked direct-signal delivery rows. */
  async claimAgentInbox(request: DeliveryClaimRequest): Promise<DeliveryClaimResult> {
    checkedCommandId(request.commandId);
    assertAgentToken(request.credential);
    checkedUuidRequest(request.workspaceId, "workspaceId");
    checkedUuidRequest(request.listenerInstanceId, "listenerInstanceId");
    checkedUuidRequest(request.expectedPrincipalId, "expectedPrincipalId");
    const limit = checkedLimit(request.limit);
    const response = await this.post(request, {
      kind: "claim_agent_inbox",
      listener_instance_id: request.listenerInstanceId.toLowerCase(),
      limit,
    }, "delivery claim");
    if (!response.ok) throw await refusal(response);
    const parsed = parseClaimSuccess(
      await this.successBody(response, "delivery claim"),
      {
        workspaceId: request.workspaceId.toLowerCase(),
        principalId: request.expectedPrincipalId.toLowerCase(),
      },
    );
    return {
      httpStatus: response.status,
      capabilities: parsed.capabilities,
      deliveries: parsed.deliveries,
      pendingDeliveryCount: parsed.pendingDeliveryCount,
    };
  }

  /** Acknowledge one leased delivery with an exact terminal outcome. */
  async ackAgentDelivery(request: DeliveryAckRequest): Promise<DeliveryAckResult> {
    assertAckRequest(request);
    const response = await this.post(request, {
      kind: "ack_agent_delivery",
      signal_id: request.signalId.toLowerCase(),
      lease_id: request.leaseId.toLowerCase(),
      listener_instance_id: request.listenerInstanceId.toLowerCase(),
      outcome: request.outcome,
      last_error_code: request.lastErrorCode,
    }, "delivery acknowledgement");
    if (!response.ok) throw await refusal(response);
    parseAckSuccess(
      await this.successBody(response, "delivery acknowledgement"),
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