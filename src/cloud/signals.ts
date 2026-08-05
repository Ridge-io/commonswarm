import {
  readEndpoint,
  type CloudTarget,
} from "./config.js";
import type {
  PostSignalCommand,
  SenderOwnerRelation,
  SignalKind,
  SignalRecord,
} from "./command-client.js";
import {
  relativeAge,
  relativeExpiry,
} from "./workspaces.js";
import {
  describeServerError,
  EMPTY_SERVER_ERROR_ENVELOPE,
  parseServerErrorEnvelope,
  serverRefusedRetry,
  type ServerErrorEnvelope,
} from "./error-envelope.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNAL_KINDS = new Set<SignalKind>(["working-on", "note", "ask"]);
/** Default per-read ceiling when no wait deadline is active. */
export const SIGNAL_READ_TIMEOUT_MS = 30_000;

/**
 * Per-read deadline abort (wait remaining time or the default read ceiling).
 * Wait paths map this to a successful timed-out idle state; one-shot paths
 * still surface it as an unreachable-service failure.
 */
export class SignalReadTimeoutError extends Error {
  constructor(message = "signal read timed out") {
    super(message);
    this.name = "SignalReadTimeoutError";
  }
}

export type SignalCredential =
  | { kind: "human"; accessToken: string; userId: string }
  | { kind: "agent"; token: string };

/** Keyset high-water for lossless follow pagination (created_at, id). */
export interface SignalCursor {
  created_at: string;
  id: string;
}

export interface SignalQuery {
  workspaceId: string;
  inbox: boolean;
  about?: string;
  kind?: SignalKind;
  /** Filter replies correlated to this signal id. */
  in_reply_to?: string;
  since?: string;
  /**
   * Strict keyset lower bound: return rows after this (created_at, id).
   * Implies ascending order. Used by the follow stream to page a backlog
   * without the newest-N window silently dropping older rows.
   */
  after?: SignalCursor;
  /**
   * Oldest-first order. Follow catch-up uses this so a backlog larger than
   * --limit is drained page by page instead of truncated to the newest page.
   * One-shot inbox/feed keep the default (newest first).
   */
  ascending?: boolean;
  limit?: number;
  includeStale?: boolean;
}

export interface SignalReadCapabilities {
  senderOwnerRelation: boolean;
  cursorAfter: boolean;
  /** Command edge supports claim_agent_inbox; absent means cursor-only. */
  deliveryClaim: boolean;
  /** Command edge supports ack_agent_delivery. */
  deliveryAck: boolean;
}

export interface AgentSignalPage {
  signals: SignalRecord[];
  capabilities: SignalReadCapabilities;
  /** True only when a pre-capability edge required a legacy newest-first read. */
  legacyCursorFallback: boolean;
  /** Server row count before tolerant quarantine. */
  rawCount: number;
  /** Cursor of the last raw row, null when it was not safely readable. */
  nextCursor: SignalCursor | null;
  malformedRows: number;
  /**
   * Live-unacked delivery count for this exact agent, null only on edges that
   * advertise no delivery capability. A capability-carrying edge must send a
   * valid non-negative safe integer. No content is ever included.
   */
  pendingDeliveryCount: number | null;
}

/** Bounded CLI wait window for inbox --wait / ask --wait (seconds). */
export const SIGNAL_WAIT_MIN_SECONDS = 1;
export const SIGNAL_WAIT_MAX_SECONDS = 300;
/** Default poll cadence while a wait is open; shortened near the deadline. */
export const SIGNAL_WAIT_POLL_MS = 1_000;
/**
 * Follow-stream idle rearm cadence. Slower than the wait path's 1Hz poll so a
 * long-lived receiver does not hammer the edge on empty inboxes.
 */
export const SIGNAL_FOLLOW_POLL_MS = 2_000;
/** First retry delay after a retryable follow failure. */
export const SIGNAL_FOLLOW_BACKOFF_INITIAL_MS = 500;
/** Cap on exponential backoff between follow rearms. */
export const SIGNAL_FOLLOW_BACKOFF_MAX_MS = 30_000;
/** In-process signal-id memory for one follow run (at-least-once, no durable ack). */
export const SIGNAL_FOLLOW_SEEN_MAX = 1_024;
/**
 * Minimum spacing after an emitted signal before the next arm. Keeps rearm
 * prompt relative to idle without a zero-delay request storm.
 */
export const SIGNAL_FOLLOW_POST_EMIT_MS = 250;
/**
 * Follow drain page size. Uses the server maximum so a burst larger than the
 * historical default of 50 is still walked to completion page by page.
 */
export const SIGNAL_FOLLOW_PAGE_LIMIT = 100;

/**
 * HTTP failure for follow classification tests and helpers. The shared one-shot
 * read path still throws plain Error with the same message so existing contracts
 * stay name-stable; Retry-After is attached via a weak map on those Errors.
 */
export class SignalHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly envelope: ServerErrorEnvelope;

  constructor(
    status: number,
    retryAfterMs: number | null = null,
    envelope: ServerErrorEnvelope = EMPTY_SERVER_ERROR_ENVELOPE,
  ) {
    super(describeServerError(`signal read failed (HTTP ${status})`, envelope));
    this.name = "SignalHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.envelope = envelope;
  }
}

/** Transport unreachable for follow classification tests/helpers. */
export class SignalTransportError extends Error {
  constructor(message = "signal read could not reach the cloud service") {
    super(message);
    this.name = "SignalTransportError";
  }
}

/** Malformed body for follow classification tests/helpers. */
export class SignalMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalMalformedError";
  }
}

/** Retry-After attached to plain Errors thrown by the shared read path. */
const plainHttpRetryAfterMs = new WeakMap<Error, number | null>();
const plainHttpStatus = new WeakMap<Error, number>();
/** The server's failure envelope, carried alongside the status (D-051). */
const plainHttpEnvelope = new WeakMap<Error, ServerErrorEnvelope>();
/**
 * D-058: transport failures are tagged by identity at construction, never
 * recognised by their wording. The prose match this replaced let any error
 * spelled "signal read could not reach the cloud service" acquire a transport
 * verdict — the same untrusted-text control flow D-053 removed elsewhere,
 * surviving inside the D-057 closed classification.
 */
const plainTransportErrors = new WeakSet<Error>();

/** Build the shared plain transport Error, tagged so classification is by identity. */
function plainTransportError(): Error {
  const error = new Error("signal read could not reach the cloud service");
  plainTransportErrors.add(error);
  return error;
}

function checkedUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`signal read returned a malformed ${field}`);
  }
  return value.toLowerCase();
}

function checkedNullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : checkedUuid(value, field);
}

function checkedTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`signal read returned a malformed ${field}`);
  }
  return value;
}

/**
 * A delivery marker that is present but not exactly 1 is a malformed
 * advertisement, never a legacy downgrade. Absent means the capability is
 * simply not offered.
 */
function deliveryCapabilityMarker(
  row: Record<string, unknown>,
  key: string,
): boolean {
  if (row[key] === undefined) return false;
  if (row[key] !== 1) {
    throw new Error("signal read returned a malformed delivery capability marker");
  }
  return true;
}

function signalReadCapabilities(value: unknown): SignalReadCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      senderOwnerRelation: false,
      cursorAfter: false,
      deliveryClaim: false,
      deliveryAck: false,
    };
  }
  const row = value as Record<string, unknown>;
  return {
    senderOwnerRelation: row.sender_owner_relation === 1,
    cursorAfter: row.cursor_after === 1,
    deliveryClaim: deliveryCapabilityMarker(row, "delivery_claim"),
    deliveryAck: deliveryCapabilityMarker(row, "delivery_ack"),
  };
}

/**
 * Strict live-unacked count on a capable agent inbox page. A missing, negative,
 * fractional, unsafe, or otherwise malformed count is a protocol error; a
 * delivery marker advertises the field, so its absence cannot be tolerated.
 */
function pendingDeliveryCountOf(
  body: Record<string, unknown>,
  capabilities: SignalReadCapabilities,
): number | null {
  if (!capabilities.deliveryClaim && !capabilities.deliveryAck) return null;
  const value = body.pending_delivery_count;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("signal read returned a malformed pending_delivery_count");
  }
  return value;
}

const SENDER_OWNER_RELATIONS = new Set<SenderOwnerRelation>([
  "same_owner",
  "cross_owner",
  "unknown",
]);

/**
 * Parse one signal row.
 *
 * Forward-compatible: unknown top-level fields are ignored so a newer edge can
 * add columns without killing old clients. Absent optional known fields
 * (to_agent, in_reply_to) normalize to null so an older edge still parses.
 * Absent sender_owner_relation normalizes to "unknown" (fail-closed for wake).
 *
 * Fail-closed: required identity/body/kind/time fields must be well-formed;
 * a present optional UUID/enum that is invalid is refused rather than coerced.
 */
export function parseSignalRecord(value: unknown): SignalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("signal read returned a malformed row");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.from_kind !== "string" ||
    !["user", "agent"].includes(row.from_kind) ||
    typeof row.kind !== "string" ||
    !SIGNAL_KINDS.has(row.kind as SignalKind) ||
    typeof row.body !== "string" ||
    row.body.length < 1 ||
    row.body.length > 2000 ||
    !(row.about === null ||
      (typeof row.about === "string" && row.about.length <= 500))
  ) {
    throw new Error("signal read returned malformed signal data");
  }
  let senderOwnerRelation: SenderOwnerRelation = "unknown";
  if (row.sender_owner_relation !== undefined) {
    if (
      typeof row.sender_owner_relation !== "string" ||
      !SENDER_OWNER_RELATIONS.has(
        row.sender_owner_relation as SenderOwnerRelation,
      )
    ) {
      throw new Error(
        "signal read returned a malformed sender_owner_relation",
      );
    }
    senderOwnerRelation = row.sender_owner_relation as SenderOwnerRelation;
  }
  return {
    id: checkedUuid(row.id, "id"),
    workspace_id: checkedUuid(row.workspace_id, "workspace_id"),
    from: checkedUuid(row.from, "from"),
    from_kind: row.from_kind as SignalRecord["from_kind"],
    to: checkedNullableUuid(row.to, "to"),
    // Absent fields are treated as null so an old server response still parses.
    to_agent: row.to_agent === undefined
      ? null
      : checkedNullableUuid(row.to_agent, "to_agent"),
    in_reply_to: row.in_reply_to === undefined
      ? null
      : checkedNullableUuid(row.in_reply_to, "in_reply_to"),
    about: row.about as string | null,
    kind: row.kind as SignalKind,
    body: row.body,
    until: checkedTimestamp(row.until, "until"),
    created_at: checkedTimestamp(row.created_at, "created_at"),
    sender_owner_relation: senderOwnerRelation,
  };
}

function cursorFromUnknown(value: unknown): SignalCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  try {
    return {
      created_at: checkedTimestamp(row.created_at, "created_at"),
      id: checkedUuid(row.id, "id"),
    };
  } catch {
    return null;
  }
}

function parseSignalRows(
  rows: unknown[],
  options: {
    tolerateMalformedRows: boolean;
    maxMalformedRows: number;
    onMalformedRow?: (index: number, error: Error) => void;
  },
): { signals: SignalRecord[]; malformedRows: number } {
  const signals: SignalRecord[] = [];
  let malformedRows = 0;
  for (const [index, row] of rows.entries()) {
    try {
      signals.push(parseSignalRecord(row));
    } catch (error) {
      if (!options.tolerateMalformedRows) throw error;
      malformedRows += 1;
      const parsed = error instanceof Error ? error : new Error(String(error));
      options.onMalformedRow?.(index, parsed);
      if (malformedRows > options.maxMalformedRows) {
        throw new Error(
          `signal read returned too many malformed rows (more than ${options.maxMalformedRows})`,
        );
      }
    }
  }
  return { signals, malformedRows };
}

/** @deprecated Use parseSignalRecord — kept as an internal alias. */
const signalRecord = parseSignalRecord;

/** Compare (created_at, id) keyset cursors: <0 before, 0 equal, >0 after. */
export function compareSignalCursor(
  a: SignalCursor,
  b: SignalCursor,
): number {
  const byTime = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (byTime !== 0) return byTime;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function checkedAfter(value: SignalCursor | undefined): SignalCursor | undefined {
  if (value === undefined) return undefined;
  return {
    created_at: checkedTimestamp(value.created_at, "after.created_at"),
    id: checkedUuid(value.id, "after.id"),
  };
}

/** Strictly after the keyset cursor (used after a gte lower bound). */
function rowsAfterCursor(
  rows: readonly SignalRecord[],
  after: SignalCursor | undefined,
): SignalRecord[] {
  if (after === undefined) return [...rows];
  return rows.filter((row) =>
    compareSignalCursor(
      { created_at: row.created_at, id: row.id },
      after,
    ) > 0
  );
}

function sortSignals(
  rows: readonly SignalRecord[],
  ascending: boolean,
): SignalRecord[] {
  return [...rows].sort((a, b) => {
    const cmp = compareSignalCursor(
      { created_at: a.created_at, id: a.id },
      { created_at: b.created_at, id: b.id },
    );
    return ascending ? cmp : -cmp;
  });
}

/** Parse Retry-After as delta-seconds or HTTP-date into a delay in ms. */
export function parseRetryAfterMs(
  header: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (header === null || header.trim() === "") return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
    return Math.min(seconds * 1000, SIGNAL_FOLLOW_BACKOFF_MAX_MS);
  }
  const when = Date.parse(trimmed);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, Math.min(when - nowMs, SIGNAL_FOLLOW_BACKOFF_MAX_MS));
}

/**
 * Throw a plain Error so one-shot callers keep the pre-follow failure taxonomy.
 * The body is already parsed by fetchSignalRead; its envelope rides along so
 * classification can honour `retryable` and the operator sees `request_id`.
 */
function throwSignalHttp(response: Response, body: unknown): never {
  const status = response.status;
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  const envelope = parseServerErrorEnvelope(body);
  const error = new Error(
    describeServerError(`signal read failed (HTTP ${status})`, envelope),
  );
  plainHttpStatus.set(error, status);
  plainHttpRetryAfterMs.set(error, retryAfterMs);
  plainHttpEnvelope.set(error, envelope);
  throw error;
}

/**
 * Status + Retry-After for follow classification (typed or tagged plain Errors).
 *
 * D-058: the message-regex fallback that used to sit here is gone. Every HTTP
 * failure this module raises is already tagged by identity in `plainHttpStatus`
 * at construction, so the regex was redundant for real errors and was the one
 * way an unrecognised error type could acquire a status — and with it a restart
 * verdict — purely from how it was worded.
 */
export function followHttpDetails(
  error: unknown,
): { status: number; retryAfterMs: number | null } | null {
  if (error instanceof SignalHttpError) {
    return { status: error.status, retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof Error) {
    const mapped = plainHttpStatus.get(error);
    if (mapped !== undefined) {
      return {
        status: mapped,
        retryAfterMs: plainHttpRetryAfterMs.get(error) ?? null,
      };
    }
  }
  return null;
}

/**
 * The server's failure envelope for an error raised by the read path. Empty
 * when the failure carried no readable body, which leaves status classification
 * unchanged.
 */
export function followErrorEnvelope(error: unknown): ServerErrorEnvelope {
  if (error instanceof SignalHttpError) return error.envelope;
  if (error instanceof Error) {
    return plainHttpEnvelope.get(error) ?? EMPTY_SERVER_ERROR_ENVELOPE;
  }
  return EMPTY_SERVER_ERROR_ENVELOPE;
}

/**
 * D-058: identity only. Was an exact-prose match, so an unrecognised error type
 * spelled the same way acquired a transport verdict and, through the restart
 * classifier, a restart it had not earned.
 */
function isTransportFollowMessage(error: unknown): boolean {
  return error instanceof SignalTransportError ||
    (error instanceof Error && plainTransportErrors.has(error));
}

/**
 * Whether a failed read could plausibly succeed on a later attempt.
 *
 * Scope: the READ path only. The follow CLI's exit status calls this directly;
 * the supervisor's `isRestartableRuntimeError` delegates only its read-path
 * portion here and decides delivery, command and ACP failures itself. Those two
 * surfaces therefore agree about read failures by construction, which is the
 * property worth having.
 *
 * ENUMERATED, not excluded (D-057): timeout, transport, and HTTP 429/5xx are
 * restartable; everything else returns false and acquires no decision. A server
 * refusal still restarts, because the `retryable: false` veto governs an
 * IMMEDIATE retry of the same request, not whether a later run may work.
 *
 * ~~Superseded (2026-08-05, dead): "The single source for that judgement…so the
 * two surfaces cannot drift" — false since D-057 gave the runtime its own closed
 * classifier; and "Everything else — 5xx, a server refusal, transport,
 * timeouts — may clear on its own", which states the rule by exclusion when it
 * is now an enumeration.~~
 */
export function isRestartableReadError(error: unknown): boolean {
  if (error instanceof SignalReadTimeoutError) return true;
  if (isTransportFollowMessage(error)) return true;
  const http = followHttpDetails(error);
  if (http !== null) {
    // Status alone. The `retryable: false` veto governs an IMMEDIATE retry of
    // the same request; it does not assert that a later run cannot work, and a
    // later run is the judgement a restart needs.
    return http.status === 429 || http.status >= 500;
  }
  // D-057: CLOSED. An unrecognised failure acquires no decision. This used to
  // exclude three known types and return true for everything else, so a plain
  // TypeError, a delivery 400 and an ACP version mismatch all bought up to
  // five restarts — verified by execution before the fix.
  return false;
}

/** A malformed body/row: a protocol defect, so repeating the read cannot help. */
export function isMalformedFollowMessage(error: unknown): boolean {
  if (error instanceof SignalMalformedError) return true;
  if (!(error instanceof Error)) return false;
  return error.message.startsWith("signal read returned a malformed") ||
    error.message === "signal read returned malformed JSON" ||
    error.message === "signal read returned malformed signal data" ||
    error.message === "signal read returned a malformed row";
}

function checkedLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be an integer in 1..100");
  }
  return limit;
}

function checkedSince(value: string | undefined): string | undefined {
  if (value !== undefined && !Number.isFinite(Date.parse(value))) {
    throw new Error("--since must be an ISO-8601 timestamp");
  }
  return value;
}

export interface SignalReadOptions {
  fetcher?: typeof fetch;
  /** Caller-supplied abort; combined with the per-read timeout ceiling. */
  signal?: AbortSignal;
  /**
   * Absolute epoch ms for a wait window. Each read aborts at
   * min(SIGNAL_READ_TIMEOUT_MS, remaining until deadlineMs).
   */
  deadlineMs?: number;
  now?: () => number;
}

function normalizeReadOptions(
  fetcherOrOptions: typeof fetch | SignalReadOptions | undefined,
): Required<Pick<SignalReadOptions, "fetcher" | "now">> & SignalReadOptions {
  if (typeof fetcherOrOptions === "function") {
    return { fetcher: fetcherOrOptions, now: Date.now };
  }
  return {
    fetcher: fetcherOrOptions?.fetcher ?? fetch,
    signal: fetcherOrOptions?.signal,
    deadlineMs: fetcherOrOptions?.deadlineMs,
    now: fetcherOrOptions?.now ?? Date.now,
  };
}

function perReadTimeoutMs(options: SignalReadOptions): number {
  if (options.deadlineMs === undefined) return SIGNAL_READ_TIMEOUT_MS;
  const remaining = options.deadlineMs - (options.now ?? Date.now)();
  if (remaining <= 0) return 0;
  return Math.min(SIGNAL_READ_TIMEOUT_MS, remaining);
}

/**
 * Fetch with an application deadline. Timeout aborts throw
 * SignalReadTimeoutError; transport failures return null; HTTP/body problems
 * return a response the caller validates.
 */
async function fetchSignalRead(
  fetcher: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  timeoutMs: number = SIGNAL_READ_TIMEOUT_MS,
): Promise<{ response: Response; body: unknown } | null> {
  if (timeoutMs <= 0) {
    throw new SignalReadTimeoutError();
  }
  const deadlineController = new AbortController();
  let timedOut = false;
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadlineController.signal])
    : deadlineController.signal;
  let onAbort = () => {};
  const aborted = new Promise<"timeout">((resolve) => {
    onAbort = () => resolve("timeout");
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    deadlineController.abort();
  }, timeoutMs);
  try {
    if (signal.aborted) {
      throw new SignalReadTimeoutError();
    }
    const read = (async (): Promise<
      { response: Response; body: unknown } | null | "timeout"
    > => {
      let response: Response;
      try {
        response = await fetcher(input, {
          ...init,
          signal,
        });
      } catch (error) {
        if (signal.aborted || timedOut || (error as Error)?.name === "AbortError") {
          return "timeout";
        }
        return null;
      }
      if (signal.aborted || timedOut) return "timeout";
      // D-051: failure bodies are read on the same terms as success bodies.
      // They carry request_id and the server's `retryable` instruction, and
      // returning body:null here is what discarded both.
      try {
        return { response, body: await response.json() };
      } catch {
        if (signal.aborted || timedOut) return "timeout";
        return { response, body: null };
      }
    })();
    const raced = await Promise.race([read, aborted]);
    if (raced === "timeout") {
      throw new SignalReadTimeoutError();
    }
    return raced;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

function mapReadFailure(error: unknown, waitBound: boolean): never {
  if (error instanceof SignalReadTimeoutError) {
    if (waitBound) throw error;
    throw plainTransportError();
  }
  throw error;
}

async function humanSignals(
  target: CloudTarget,
  credential: Extract<SignalCredential, { kind: "human" }>,
  query: SignalQuery,
  options: ReturnType<typeof normalizeReadOptions>,
): Promise<SignalRecord[]> {
  const url = new URL("/rest/v1/signals", target.url);
  url.searchParams.set(
    "select",
    "id,workspace_id,from,from_kind,to,to_agent,in_reply_to,about,kind,body,until,created_at",
  );
  url.searchParams.set("workspace_id", `eq.${query.workspaceId}`);
  if (query.inbox) url.searchParams.set("to", `eq.${credential.userId}`);
  if (!query.includeStale) {
    url.searchParams.set("until", "gt.now");
  }
  if (query.about !== undefined) {
    url.searchParams.set("about", `eq.${query.about}`);
  }
  if (query.kind !== undefined) {
    url.searchParams.set("kind", `eq.${query.kind}`);
  }
  if (query.in_reply_to !== undefined) {
    url.searchParams.set("in_reply_to", `eq.${query.in_reply_to}`);
  }
  const ascending = query.ascending === true || query.after !== undefined;
  // Keyset pages use gte on created_at then filter strictly-after client-side so
  // same-timestamp rows with a later id are not lost.
  if (query.after !== undefined) {
    url.searchParams.set("created_at", `gte.${query.after.created_at}`);
  } else if (query.since !== undefined) {
    url.searchParams.set("created_at", `gte.${query.since}`);
  }
  url.searchParams.set(
    "order",
    ascending ? "created_at.asc,id.asc" : "created_at.desc,id.desc",
  );
  url.searchParams.set("limit", String(query.limit));
  let result: { response: Response; body: unknown } | null;
  try {
    result = await fetchSignalRead(options.fetcher, url, {
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        apikey: target.anonKey,
        "accept-profile": "swarm_read",
      },
      ...(options.signal ? { signal: options.signal } : {}),
    }, perReadTimeoutMs(options));
  } catch (error) {
    mapReadFailure(error, options.deadlineMs !== undefined);
  }
  if (result === null) {
    throw plainTransportError();
  }
  const { response, body } = result;
  if (!response.ok) {
    throwSignalHttp(response, body);
  }
  if (!Array.isArray(body)) {
    throw new Error("signal read returned malformed JSON");
  }
  const parsed = body.map(parseSignalRecord);
  return sortSignals(rowsAfterCursor(parsed, query.after), ascending);
}

async function agentSignalPage(
  target: CloudTarget,
  credential: Extract<SignalCredential, { kind: "agent" }>,
  query: SignalQuery,
  options: ReturnType<typeof normalizeReadOptions>,
  allowLegacyCursorFallback = false,
  parseOptions: {
    tolerateMalformedRows: boolean;
    maxMalformedRows: number;
    onMalformedRow?: (index: number, error: Error) => void;
  } = {
    tolerateMalformedRows: false,
    maxMalformedRows: 0,
  },
): Promise<AgentSignalPage> {
  const cursorRequested = query.ascending === true || query.after !== undefined;
  const perform = async (
    includeCursor: boolean,
  ): Promise<{ response: Response; body: unknown }> => {
    let result: { response: Response; body: unknown } | null;
    try {
      result = await fetchSignalRead(options.fetcher, readEndpoint(target), {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.token}`,
          apikey: target.anonKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          resource: "signals",
          workspace_id: query.workspaceId,
          inbox: query.inbox,
          about: query.about ?? null,
          kind: query.kind ?? null,
          in_reply_to: query.in_reply_to ?? null,
          since: query.since ?? null,
          ...(includeCursor
            ? {
              after_created_at: query.after?.created_at ?? null,
              after_id: query.after?.id ?? null,
            }
            : {}),
          limit: query.limit,
          include_stale: query.includeStale ?? false,
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      }, perReadTimeoutMs(options));
    } catch (error) {
      mapReadFailure(error, options.deadlineMs !== undefined);
    }
    if (result === null) {
      throw plainTransportError();
    }
    return result;
  };

  let result = await perform(cursorRequested);
  let legacyCursorFallback = false;
  if (
    result.response.status === 400 &&
    cursorRequested &&
    allowLegacyCursorFallback
  ) {
    const original = result;
    result = await perform(false);
    if (!result.response.ok) throwSignalHttp(result.response, result.body);
    const fallbackBody = result.body;
    const fallbackCapabilities = fallbackBody &&
        typeof fallbackBody === "object" &&
        !Array.isArray(fallbackBody)
      ? signalReadCapabilities(
        (fallbackBody as Record<string, unknown>).capabilities,
      )
      : {
        senderOwnerRelation: false,
        cursorAfter: false,
        deliveryClaim: false,
        deliveryAck: false,
      };
    // A capable edge rejecting the capability request is a real protocol bug,
    // not an excuse to silently fall back to a lossy newest-N window.
    if (fallbackCapabilities.cursorAfter) {
      throwSignalHttp(original.response, original.body);
    }
    legacyCursorFallback = true;
  }
  const { response, body } = result;
  if (!response.ok) throwSignalHttp(response, body);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Array.isArray((body as Record<string, unknown>).signals)
  ) {
    throw new Error("signal read returned malformed JSON");
  }
  const capabilities = signalReadCapabilities(
    (body as Record<string, unknown>).capabilities,
  );
  const pendingDeliveryCount = pendingDeliveryCountOf(
    body as Record<string, unknown>,
    capabilities,
  );
  const rawRows = (body as Record<string, unknown>).signals as unknown[];
  const parsedRows = parseSignalRows(rawRows, parseOptions);
  const ascending = query.ascending === true || query.after !== undefined;
  return {
    signals: sortSignals(
      rowsAfterCursor(parsedRows.signals, query.after),
      ascending,
    ),
    capabilities,
    legacyCursorFallback,
    rawCount: rawRows.length,
    nextCursor: rawRows.length === 0
      ? null
      : cursorFromUnknown(rawRows[rawRows.length - 1]),
    malformedRows: parsedRows.malformedRows,
    pendingDeliveryCount,
  };
}

export interface SignalMember {
  user_id: string;
  display_name: string;
}

export interface SignalAgent {
  principal_id: string;
  name: string;
  /** Added by the current read edge; absent on older compatible deployments. */
  owner_user_id?: string;
}

/** Live members and agents available as signal targets in one workspace. */
export interface SignalDirectory {
  members: readonly SignalMember[];
  agents: readonly SignalAgent[];
}

export type ResolvedSignalRecipient =
  | { kind: "user"; id: string }
  | { kind: "agent"; id: string };

function parseAgentMemberRow(value: unknown): SignalAgent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("member read returned a malformed agent row");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string") {
    throw new Error("member read returned a malformed agent name");
  }
  return {
    principal_id: checkedUuid(row.principal_id, "agent principal_id"),
    name: row.name,
    ...(row.owner_user_id === undefined
      ? {}
      : { owner_user_id: checkedUuid(row.owner_user_id, "agent owner_user_id") }),
  };
}

function parseMemberRow(value: unknown): SignalMember {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("member read returned a malformed row");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.display_name !== "string") {
    throw new Error("member read returned a malformed display name");
  }
  return {
    user_id: checkedUuid(row.user_id, "member user_id"),
    display_name: row.display_name,
  };
}

export async function readAgentSignalDirectory(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  fetcherOrOptions: typeof fetch | SignalReadOptions = fetch,
): Promise<SignalDirectory> {
  const options = normalizeReadOptions(fetcherOrOptions);
  let result: { response: Response; body: unknown } | null;
  try {
    result = await fetchSignalRead(options.fetcher, readEndpoint(target), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        apikey: target.anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        resource: "members",
        workspace_id: workspaceId,
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, perReadTimeoutMs(options));
  } catch (error) {
    if (error instanceof SignalReadTimeoutError) {
      throw new Error("member read could not reach the cloud service");
    }
    throw error;
  }
  if (result === null) {
    throw new Error("member read could not reach the cloud service");
  }
  const { response, body } = result;
  if (!response.ok) {
    throw new Error(`member read failed (HTTP ${response.status})`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("member read returned malformed JSON");
  }
  const payload = body as Record<string, unknown>;
  if (!Array.isArray(payload.members)) {
    throw new Error("member read returned malformed JSON");
  }
  const agentsRaw = payload.agents;
  // Agents are additive; an older members response without agents[] still works.
  const agents = agentsRaw === undefined
    ? []
    : Array.isArray(agentsRaw)
    ? agentsRaw.map(parseAgentMemberRow)
    : (() => {
      throw new Error("member read returned malformed agents");
    })();
  return {
    members: payload.members.map(parseMemberRow),
    agents,
  };
}

/** @deprecated Prefer readAgentSignalDirectory; kept for call sites that only need humans. */
export async function readAgentSignalMembers(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<SignalMember[]> {
  const directory = await readAgentSignalDirectory(
    target,
    token,
    workspaceId,
    fetcher,
  );
  return [...directory.members];
}

/**
 * Resolve --to against live members and agents. Exact UUID wins when it names
 * one live principal; exact name is accepted only when unique across both sets.
 */
export function resolveSignalRecipient(
  selector: string,
  directory: SignalDirectory | readonly SignalMember[],
): ResolvedSignalRecipient {
  const resolved: SignalDirectory = Array.isArray(directory)
    ? { members: directory, agents: [] }
    : directory as SignalDirectory;

  if (UUID_RE.test(selector)) {
    const normalized = selector.toLowerCase();
    const member = resolved.members.find((row) => row.user_id === normalized);
    const agent = resolved.agents.find((row) =>
      row.principal_id === normalized
    );
    if (member && !agent) return { kind: "user", id: member.user_id };
    if (agent && !member) return { kind: "agent", id: agent.principal_id };
    if (member && agent) {
      throw new Error(
        `signal recipient id matches both a member and an agent; use a unique id`,
      );
    }
    throw new Error(
      "signal recipient is not a live member or agent of this project",
    );
  }

  const memberMatches = resolved.members.filter(
    (member) => member.display_name === selector,
  );
  const agentMatches = resolved.agents.filter(
    (agent) => agent.name === selector,
  );
  const total = memberMatches.length + agentMatches.length;
  if (total === 1) {
    if (memberMatches.length === 1) {
      return { kind: "user", id: memberMatches[0]!.user_id };
    }
    return { kind: "agent", id: agentMatches[0]!.principal_id };
  }
  if (total > 1) {
    const choices = [
      ...memberMatches.map((member) => `user ${member.user_id}`),
      ...agentMatches.map((agent) => `agent ${agent.principal_id}`),
    ];
    throw new Error(
      `signal recipient name is ambiguous; use one of these ids: ${
        choices.join(", ")
      }`,
    );
  }
  throw new Error(
    "signal recipient is not a live member or agent of this project",
  );
}

/** Parse --wait as an integer number of seconds in 1..300. */
export function parseWaitSeconds(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("--wait must be an integer number of seconds in 1..300");
  }
  const seconds = Number(value);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < SIGNAL_WAIT_MIN_SECONDS ||
    seconds > SIGNAL_WAIT_MAX_SECONDS
  ) {
    throw new Error("--wait must be an integer number of seconds in 1..300");
  }
  return seconds;
}

export function waitDeadlineMs(
  waitSeconds: number,
  nowMs: number = Date.now(),
): number {
  return nowMs + waitSeconds * 1000;
}

export function nextWaitSleepMs(
  nowMs: number,
  deadlineMs: number,
  pollMs: number = SIGNAL_WAIT_POLL_MS,
): number {
  return Math.max(0, Math.min(pollMs, deadlineMs - nowMs));
}

export interface SignalWaitResult {
  signals: SignalRecord[];
  timedOut: boolean;
}

/**
 * Immediate read, then poll until a non-empty match or the deadline. After each
 * sleep — including the sleep that lands on the deadline — probe once more so a
 * signal that arrives during the last sleep is observed. Deadline aborts are a
 * successful timed-out idle state; transport/HTTP/malformed errors propagate.
 */
export async function pollForSignals(options: {
  read: () => Promise<SignalRecord[]>;
  deadlineMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}): Promise<SignalWaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? SIGNAL_WAIT_POLL_MS;

  const probe = async (): Promise<SignalWaitResult | "empty"> => {
    try {
      const signals = await options.read();
      if (signals.length > 0) return { signals, timedOut: false };
      return "empty";
    } catch (error) {
      if (error instanceof SignalReadTimeoutError) {
        return { signals: [], timedOut: true };
      }
      throw error;
    }
  };

  // Always attempt at least one read, even if the deadline is already past.
  const first = await probe();
  if (first !== "empty") return first;

  while (now() < options.deadlineMs) {
    const sleepMs = nextWaitSleepMs(now(), options.deadlineMs, pollMs);
    if (sleepMs > 0) await sleep(sleepMs);
    // Probe after every sleep, including one that exhausts the wait window.
    const next = await probe();
    if (next !== "empty") return next;
  }
  return { signals: [], timedOut: true };
}

function normalizedSignalQuery(query: SignalQuery): SignalQuery {
  if (!UUID_RE.test(query.workspaceId)) {
    throw new Error("--workspace-id must be a UUID");
  }
  if (query.in_reply_to !== undefined && !UUID_RE.test(query.in_reply_to)) {
    throw new Error("in_reply_to must be a signal UUID");
  }
  const after = checkedAfter(query.after);
  return {
    ...query,
    workspaceId: query.workspaceId.toLowerCase(),
    ...(query.in_reply_to === undefined
      ? {}
      : { in_reply_to: query.in_reply_to.toLowerCase() }),
    limit: checkedLimit(query.limit),
    since: checkedSince(query.since),
    ...(after === undefined ? {} : { after }),
    ascending: query.ascending === true || after !== undefined,
    includeStale: query.includeStale ?? false,
  };
}

/** Agent read with explicit edge capabilities for safe host-adapter gating. */
export async function readAgentSignalPage(
  target: CloudTarget,
  credential: Extract<SignalCredential, { kind: "agent" }>,
  query: SignalQuery,
  fetcherOrOptions: typeof fetch | SignalReadOptions = fetch,
  pageOptions?: {
    allowLegacyCursorFallback?: boolean;
    tolerateMalformedRows?: boolean;
    maxMalformedRows?: number;
    onMalformedRow?: (index: number, error: Error) => void;
  },
): Promise<AgentSignalPage> {
  const readOptions = normalizeReadOptions(fetcherOrOptions);
  const maxMalformedRows = pageOptions?.maxMalformedRows ?? 3;
  if (!Number.isSafeInteger(maxMalformedRows) || maxMalformedRows < 0) {
    throw new Error("maxMalformedRows must be a non-negative integer");
  }
  return await agentSignalPage(
    target,
    credential,
    normalizedSignalQuery(query),
    readOptions,
    pageOptions?.allowLegacyCursorFallback === true,
    {
      tolerateMalformedRows: pageOptions?.tolerateMalformedRows === true,
      maxMalformedRows,
      ...(pageOptions?.onMalformedRow
        ? { onMalformedRow: pageOptions.onMalformedRow }
        : {}),
    },
  );
}

export async function readSignals(
  target: CloudTarget,
  credential: SignalCredential,
  query: SignalQuery,
  fetcherOrOptions: typeof fetch | SignalReadOptions = fetch,
): Promise<SignalRecord[]> {
  const options = normalizeReadOptions(fetcherOrOptions);
  const normalized = normalizedSignalQuery(query);
  return credential.kind === "human"
    ? await humanSignals(target, credential, normalized, options)
    : (await agentSignalPage(
      target,
      credential,
      normalized,
      options,
      true,
      {
        tolerateMalformedRows: false,
        maxMalformedRows: 0,
      },
    )).signals;
}

export const SIGNAL_STATUS_UNAVAILABLE_MESSAGE =
  "Signal summary is temporarily unavailable; core project status is still shown.";

export interface SignalStatusSupplement {
  recentSignals: SignalRecord[] | null;
  waitingAsks: number | null;
  warning: string | null;
}

export interface SignalAuthorLabels {
  users: ReadonlyMap<string, string>;
  agents: ReadonlyMap<string, string>;
  currentUserId?: string;
}

export async function settleSignalAuthorLabels(
  labels: Promise<SignalAuthorLabels>,
): Promise<SignalAuthorLabels> {
  return await labels.catch(() => ({
    users: new Map(),
    agents: new Map(),
  }));
}

export async function settleSignalStatus(
  recent: Promise<SignalRecord[]>,
  asks: Promise<SignalRecord[]>,
): Promise<SignalStatusSupplement> {
  const [recentResult, asksResult] = await Promise.allSettled([recent, asks]);
  const available = recentResult.status === "fulfilled" &&
    asksResult.status === "fulfilled";
  return {
    recentSignals: recentResult.status === "fulfilled"
      ? recentResult.value
      : null,
    waitingAsks: asksResult.status === "fulfilled"
      ? asksResult.value.length
      : null,
    warning: available ? null : SIGNAL_STATUS_UNAVAILABLE_MESSAGE,
  };
}

export function signalReadJsonPayload(
  workspaceId: string,
  inbox: boolean,
  signals: readonly SignalRecord[],
  options: { waited?: boolean; timedOut?: boolean } = {},
): Record<string, unknown> {
  const waited = options.waited === true;
  const timedOut = options.timedOut === true;
  const emptyMessage = timedOut
    ? inbox
      ? "Nothing arrived before the wait ended."
      : "No matching signals arrived before the wait ended."
    : inbox
    ? "Nothing is waiting for you."
    : "No matching signals are visible.";
  const message = signals.length === 0
    ? emptyMessage
    : `${signals.length} signal${signals.length === 1 ? "" : "s"} visible.`;
  return {
    workspace_id: workspaceId,
    view: inbox ? "inbox" : "feed",
    signals,
    ...(waited ? { waited: true, timed_out: timedOut } : {}),
    message,
  };
}

/** JSON document for ask --wait: one document, timeout is success with no reply. */
export function askWaitJsonPayload(
  ask: SignalRecord,
  reply: SignalRecord | null,
  timedOut: boolean,
): Record<string, unknown> {
  return {
    status: "accepted",
    message: timedOut
      ? "Ask shared. No reply arrived before the wait ended; the ask remains live."
      : "Ask shared and a correlated reply arrived.",
    signal: ask,
    reply,
    timed_out: timedOut,
  };
}

export function postSignalTargets(
  recipient: ResolvedSignalRecipient | null,
): Pick<
  PostSignalCommand,
  "to_user_id" | "to_agent_principal_id" | "in_reply_to"
> {
  if (recipient === null) {
    return {
      to_user_id: null,
      to_agent_principal_id: null,
      in_reply_to: null,
    };
  }
  if (recipient.kind === "user") {
    return {
      to_user_id: recipient.id,
      to_agent_principal_id: null,
      in_reply_to: null,
    };
  }
  return {
    to_user_id: null,
    to_agent_principal_id: recipient.id,
    in_reply_to: null,
  };
}

export function renderSignals(
  signals: readonly SignalRecord[],
  options: {
    inbox: boolean;
    includeStale: boolean;
    now?: number;
    authors?: SignalAuthorLabels;
  },
): string {
  if (signals.length === 0) {
    return [
      options.inbox ? "Inbox:" : "Recent signals:",
      options.inbox
        ? "Nothing is waiting for you."
        : options.includeStale
        ? "No signals have been shared in this project yet."
        : "No live signals in this project yet.",
    ].join("\n");
  }
  const now = options.now ?? Date.now();
  const lines = [options.inbox ? "Inbox:" : "Recent signals:"];
  for (const signal of signals) {
    const authorKind = signal.from_kind === "agent" ? "agent" : "member";
    const authorName = signal.from_kind === "agent"
      ? options.authors?.agents.get(signal.from)
      : options.authors?.users.get(signal.from);
    const author = authorName === undefined
      ? `${authorKind} ${signal.from}`
      : `${authorKind} ${authorName} (${signal.from})${
        signal.from_kind === "user" &&
          options.authors?.currentUserId === signal.from
          ? " — you"
          : ""
      }`;
    const expired = Date.parse(signal.until) <= now ? " (expired)" : "";
    const about = signal.about === null
      ? ""
      : ` about ${JSON.stringify(signal.about)}`;
    lines.push(
      `- [${signal.kind}] ${author} — ${
        relativeAge(signal.created_at, now)
      } — ${relativeExpiry(signal.until, now)}${expired}${about}: ${
        JSON.stringify(signal.body)
      }`,
    );
  }
  return lines.join("\n");
}

export function renderSignalStatus(
  recent: readonly SignalRecord[],
  waitingAsks: number,
  options: { authors?: SignalAuthorLabels; now?: number } = {},
): string {
  const askSummary = waitingAsks === 0
    ? "No asks are waiting in your inbox."
    : `${waitingAsks}${waitingAsks === 100 ? "+" : ""} ask${
      waitingAsks === 1 ? " is" : "s are"
    } waiting — run cswarm inbox.`;
  return `${renderSignals(recent, {
    inbox: false,
    includeStale: false,
    ...options,
  })}\n${askSummary}`;
}

// ---------------------------------------------------------------------------
// inbox --follow --ndjson: host-neutral resilient receive stream
//
// This is a long-lived NDJSON stream of durable signal rows. It never claims
// to wake a model, execute a message, or install a host daemon. Receipt is
// at-least-once for one process: there is no durable ack, and a second run
// may re-emit still-live rows.
// ---------------------------------------------------------------------------

export type FollowFrame =
  | {
    type: "ready";
    workspace_id: string;
    view: "inbox";
    ts: string;
  }
  | {
    type: "signal";
    signal: SignalRecord;
    ts: string;
  }
  | {
    type: "retrying";
    reason: string;
    attempt: number;
    delay_ms: number;
    ts: string;
  }
  /**
   * D-055: the stream's terminal condition. `--ndjson` exists for machine
   * consumption — the connect prompt points non-Grok hosts at it — so a fatal
   * stop written as bare text made the stream's LAST word the one line a
   * wrapper cannot parse. The information was already there; only the
   * encoding was wrong.
   */
  | {
    type: "error";
    reason: FollowStopReason;
    /** Why the server said it failed, when it said anything. */
    server_error: string | null;
    request_id: string | null;
    /** True only when the server explicitly refused a retry. */
    server_refused: boolean;
    message: string;
    ts: string;
  };

export type FollowStopReason =
  | "cancelled"
  | "fatal_http"
  | "malformed"
  | "credential"
  | "error";

export interface FollowStop {
  reason: FollowStopReason;
  error?: Error;
}

/**
 * The terminal frame for a follow stop that is not a clean cancellation.
 * Returns null for "cancelled": an operator stop is not an error, and the
 * stream simply ends.
 */
export function followStopFrame(
  stop: FollowStop,
  nowMs: number,
): Extract<FollowFrame, { type: "error" }> | null {
  if (stop.reason === "cancelled") return null;
  const envelope = followErrorEnvelope(stop.error);
  return {
    type: "error",
    reason: stop.reason,
    server_error: envelope.error,
    request_id: envelope.requestId,
    server_refused: envelope.retryable === false,
    message: stop.error?.message ?? `inbox follow stopped (${stop.reason})`,
    ts: followTs(nowMs),
  };
}

/** Bounded FIFO set of signal ids seen during one follow process. */
export class BoundedSignalIdSet {
  private readonly order: string[] = [];
  private readonly ids = new Set<string>();

  constructor(private readonly max: number = SIGNAL_FOLLOW_SEEN_MAX) {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new Error("BoundedSignalIdSet max must be a positive integer");
    }
  }

  get size(): number {
    return this.ids.size;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Insert id; returns true when it was new (should emit). */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.order.push(id);
    while (this.order.length > this.max) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }
}

/**
 * Full-jitter exponential backoff, respecting Retry-After when larger.
 * attempt is 1-based (first retry = 1).
 */
export function nextFollowBackoffMs(
  attempt: number,
  retryAfterMs: number | null = null,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.min(attempt, 16));
  const exp = Math.min(
    SIGNAL_FOLLOW_BACKOFF_MAX_MS,
    SIGNAL_FOLLOW_BACKOFF_INITIAL_MS * (2 ** (safeAttempt - 1)),
  );
  const jittered = Math.floor(exp * (0.5 + random() * 0.5));
  if (retryAfterMs === null) return jittered;
  return Math.min(
    SIGNAL_FOLLOW_BACKOFF_MAX_MS,
    Math.max(jittered, retryAfterMs),
  );
}

/**
 * D-051: `retryable: false` is a refusal, and it vetoes retry before status is
 * consulted. Retrying a rejection at a saturated ceiling is what fed the
 * concurrency that caused it. The veto is one-directional on purpose —
 * `retryable: true` does not promote a status we would otherwise refuse to
 * retry, so a server cannot talk this client into hammering a 401.
 */
/**
 * Decay the retry attempt counter after a success rather than zeroing it.
 *
 * D-051 companion: a single success used to reset the counter to 0, so an
 * intermittently-failing receiver never reached the 30s backoff cap — it
 * climbed, succeeded, reset, and climbed again. That is the amplifier's
 * engine, and it is why one receiver produced 13.2 retry frames/min where a
 * receiver sitting at the cap produces ~2.
 *
 * Decaying by one makes the steady state track the recent failure RATE rather
 * than the current streak: the counter drifts by (2p - 1) per read at failure
 * probability p. A healthy receiver still returns to zero, one step per
 * success, so health is never penalised for long. This holds whatever the
 * server says about `retryable`, so it protects the client even on endpoints
 * that never emit the field.
 *
 * ~~Superseded (2026-08-05, now dead): "Against the measured curve that lands
 * where we want it — at 71% failures (concurrency 8) it climbs to the cap, at
 * 17% (concurrency 2) it stays pinned at 0."~~ Wren retracted that
 * dose-response curve the same day: interleaved measurement showed a roughly
 * even per-request failure chance that load barely moves, and the ascending
 * curve was a time confound. At p near 0.5 this counter random-walks rather
 * than converging either way, so do not read the tuning as validated. What
 * survives the retraction is the defect itself — a success wiping backoff the
 * failures earned is wrong under ANY failure distribution — and that is the
 * whole reason this function exists.
 */
export function decayFollowAttempt(attempt: number): number {
  return attempt > 0 ? attempt - 1 : 0;
}

export function isRetryableFollowError(error: unknown): boolean {
  if (serverRefusedRetry(followErrorEnvelope(error))) return false;
  if (error instanceof SignalReadTimeoutError) return true;
  if (isTransportFollowMessage(error)) return true;
  const http = followHttpDetails(error);
  if (http) return http.status === 429 || http.status >= 500;
  return false;
}

export function isFatalFollowError(error: unknown): boolean {
  if (isMalformedFollowMessage(error)) return true;
  const http = followHttpDetails(error);
  if (!http) return false;
  return http.status === 400 ||
    http.status === 401 ||
    http.status === 403 ||
    http.status === 404 ||
    http.status === 426 ||
    (http.status >= 400 && http.status < 500 && http.status !== 429);
}

/**
 * Credential refusal/horizon/secret-absence stop classifier used by the CLI
 * and pure tests. Matches Renewal* by name to avoid coupling this module to
 * renewal.ts, plus explicit secret-absence wording.
 */
export function isFollowCredentialFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const http = followHttpDetails(error);
  if (http !== null) {
    // It came off the wire, so the status decides and nothing else does.
    // Returning here keeps the wording check below out of reach of response
    // text: since D-051 the message can carry server-supplied fields, and an
    // unanchored phrase test over a message that contains external text is
    // the same defect as the `/aborted/i` one this sweep removed.
    return http.status === 401 || http.status === 403;
  }
  if (
    error.name === "RenewalReauthorisationRequired" ||
    error.name === "RenewalRevoked"
  ) {
    return true;
  }
  // Locally-thrown secret absence only; these errors never cross the network.
  return /secret is absent/i.test(error.message);
}

function followRetryReason(error: unknown): string {
  if (error instanceof SignalReadTimeoutError) return "idle_deadline";
  if (isTransportFollowMessage(error)) return "transport";
  const http = followHttpDetails(error);
  if (http) {
    if (http.status === 429) return "http_429";
    if (http.status >= 500) return `http_${http.status}`;
  }
  return "retryable";
}

function followTs(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/** Serialize one follow frame as a single NDJSON line (no trailing newline). */
export function formatFollowFrame(frame: FollowFrame): string {
  return JSON.stringify(frame);
}

/**
 * Name-only cancellation recognition, matching runtime.ts `isAbort`.
 *
 * The message regex that used to sit here — `/aborted/i.test(error.message)` —
 * let arbitrary error TEXT impersonate a caller cancellation. D-051 made that
 * reachable from outside: failure bodies are now parsed, so a server answering
 * `{"error":"aborted"}` would have produced the message "signal read failed
 * (HTTP 500): aborted" and been classified as a clean cancel instead of an
 * error. A receiver would exit quietly, reporting success, having read nothing.
 *
 * This is the same defect the A2 credential-escape work removed from the engine
 * and runtime classifiers; signals.ts kept its copy. Cancellation is a fact
 * about our own AbortSignal or a typed local abort, never about wording.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** One page request from the follow loop to the caller's arm. */
export interface FollowArmRequest {
  /** Strict keyset high-water; null on the first catch-up page. */
  after: SignalCursor | null;
  /** Page size; full pages drain immediately without the idle poll. */
  limit: number;
}

export interface FollowArmPage {
  signals: SignalRecord[];
  /** Row count before malformed-row quarantine. */
  rawCount: number;
  /** Last server row cursor; required to continue a full page. */
  nextCursor: SignalCursor | null;
  /** False for a legacy edge whose newest-N response cannot be keyset-paged. */
  canPage: boolean;
}

/**
 * Long-running inbox receive loop. Caller supplies `arm`, which must refresh
 * credentials (AgentCredentialSession.bearer when agent) and perform one read
 * page. The loop walks a backlog with an ascending keyset cursor so a burst
 * larger than one page cannot be silently truncated to the newest N rows.
 * Emits ready only after the first successful arm. Does not ack rows.
 */
export async function runInboxFollow(options: {
  workspaceId: string;
  /**
   * Fetch one ascending page after the cursor. Legacy zero-arg arms still work
   * (extra args are ignored) but cannot express lossless pagination alone.
   */
  arm: (
    page: FollowArmRequest,
  ) => Promise<SignalRecord[] | FollowArmPage>;
  emit: (frame: FollowFrame) => void;
  /**
   * Optional side-effect sleep hook for tests (e.g. advance a fake clock).
   * Production delay always uses a clearable timer so cancel cannot leave a
   * pending setTimeout holding the event loop.
   */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  signal?: AbortSignal;
  pollMs?: number;
  postEmitMs?: number;
  pageLimit?: number;
  seen?: BoundedSignalIdSet;
  /** Optional classifier for credential refusal/horizon failures from arm(). */
  isCredentialFailure?: (error: unknown) => boolean;
}): Promise<FollowStop> {
  const now = options.now ?? Date.now;
  const sleepHook = options.sleep;
  const random = options.random ?? Math.random;
  const pollMs = options.pollMs ?? SIGNAL_FOLLOW_POLL_MS;
  const postEmitMs = options.postEmitMs ?? SIGNAL_FOLLOW_POST_EMIT_MS;
  const pageLimit = options.pageLimit ?? SIGNAL_FOLLOW_PAGE_LIMIT;
  const seen = options.seen ?? new BoundedSignalIdSet();
  const isCredentialFailure = options.isCredentialFailure ??
    isFollowCredentialFailure;
  const abort = options.signal;

  let ready = false;
  let attempt = 0;
  let after: SignalCursor | null = null;

  const cancelled = (): boolean => abort?.aborted === true;

  const sleepInterruptible = async (ms: number): Promise<"ok" | "cancelled"> => {
    if (cancelled()) return "cancelled";
    if (ms <= 0) return cancelled() ? "cancelled" : "ok";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort && abort) abort.removeEventListener("abort", onAbort);
          resolve();
        };
        if (abort) {
          if (abort.aborted) {
            finish();
            return;
          }
          onAbort = finish;
          abort.addEventListener("abort", onAbort, { once: true });
        }
        // Clearable timer is the real delay; hooks may finish early for tests.
        timer = setTimeout(finish, ms);
        if (sleepHook) {
          void Promise.resolve(sleepHook(ms)).then(finish, finish);
        }
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort && abort) abort.removeEventListener("abort", onAbort);
    }
    return cancelled() ? "cancelled" : "ok";
  };

  /**
   * D-055: the terminal condition is part of the stream, so the loop that owns
   * the stream emits it. Leaving this to each caller is what put a bare,
   * unparseable line at the end of an --ndjson stream.
   */
  const stopWith = (stop: FollowStop): FollowStop => {
    const frame = followStopFrame(stop, now());
    if (frame) options.emit(frame);
    return stop;
  };

  while (true) {
    if (cancelled()) return { reason: "cancelled" };

    try {
      const armResult = await options.arm({ after, limit: pageLimit });
      const rows = Array.isArray(armResult)
        ? armResult
        : armResult.signals;
      const rawCount = Array.isArray(armResult)
        ? rows.length
        : armResult.rawCount;
      const nextCursor = Array.isArray(armResult)
        ? (rows.length === 0
          ? null
          : {
            created_at: rows[rows.length - 1]!.created_at,
            id: rows[rows.length - 1]!.id,
          })
        : armResult.nextCursor;
      const canPage = Array.isArray(armResult) ? true : armResult.canPage;
      // Decay, never reset: an isolated success between failures must not wipe
      // the backoff the failures earned. See decayFollowAttempt.
      attempt = decayFollowAttempt(attempt);

      if (!ready) {
        options.emit({
          type: "ready",
          workspace_id: options.workspaceId,
          view: "inbox",
          ts: followTs(now()),
        });
        ready = true;
      }

      // Oldest first so a multi-row arm is deterministic for consumers.
      const ordered = sortSignals(rows, true);

      let emitted = false;
      for (const signal of ordered) {
        if (cancelled()) return { reason: "cancelled" };
        if (!seen.add(signal.id)) continue;
        options.emit({
          type: "signal",
          signal,
          ts: followTs(now()),
        });
        emitted = true;
      }

      // Full page => more backlog may exist; drain without the idle poll.
      const fullPage = canPage && rawCount >= pageLimit;
      if (fullPage && nextCursor === null) {
        throw new SignalMalformedError(
          "signal read cannot continue a full page because its terminal cursor is malformed",
        );
      }
      // Advance even when every valid row was a duplicate. The cursor comes
      // from the last raw row so quarantining an earlier malformed row cannot
      // pin a full page forever.
      if (fullPage) after = nextCursor;
      // The tuple cursor is a page cursor for one complete scan, not a durable
      // high-water mark. Reset after the last partial page so a row that commits
      // late with an older created_at is discovered on the next full scan.
      if (!fullPage) after = null;
      const waitMs = fullPage
        ? (emitted ? postEmitMs : 0)
        : (emitted ? postEmitMs : pollMs);
      const wait = await sleepInterruptible(waitMs);
      if (wait === "cancelled") return { reason: "cancelled" };
    } catch (error) {
      // Precedence mirrors runtime.ts: our own abort state is authoritative,
      // then the credential predicate, then name-only AbortError. A caller
      // that did not abort cannot be cancelled by what an error says.
      if (cancelled()) {
        return { reason: "cancelled" };
      }
      if (isCredentialFailure(error)) {
        return stopWith({
          reason: "credential",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      if (isAbortError(error)) {
        return { reason: "cancelled" };
      }
      if (isRetryableFollowError(error)) {
        attempt += 1;
        const retryAfterMs = followHttpDetails(error)?.retryAfterMs ?? null;
        const delayMs = nextFollowBackoffMs(attempt, retryAfterMs, random);
        if (ready) {
          options.emit({
            type: "retrying",
            reason: followRetryReason(error),
            attempt,
            delay_ms: delayMs,
            ts: followTs(now()),
          });
        }
        const wait = await sleepInterruptible(delayMs);
        if (wait === "cancelled") return { reason: "cancelled" };
        continue;
      }
      if (isMalformedFollowMessage(error)) {
        return stopWith({
          reason: "malformed",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      if (isFatalFollowError(error)) {
        return stopWith({
          reason: "fatal_http",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      return stopWith({
        reason: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}
