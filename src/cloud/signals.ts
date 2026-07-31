import {
  readEndpoint,
  type CloudTarget,
} from "./config.js";
import type {
  PostSignalCommand,
  SignalKind,
  SignalRecord,
} from "./command-client.js";
import {
  relativeAge,
  relativeExpiry,
} from "./workspaces.js";

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

export interface SignalQuery {
  workspaceId: string;
  inbox: boolean;
  about?: string;
  kind?: SignalKind;
  /** Filter replies correlated to this signal id. */
  in_reply_to?: string;
  since?: string;
  limit?: number;
  includeStale?: boolean;
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

/** HTTP failure from a signal read; carries status for follow retry classification. */
export class SignalHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null = null) {
    super(`signal read failed (HTTP ${status})`);
    this.name = "SignalHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Transport unreachable / network failure for a signal read. */
export class SignalTransportError extends Error {
  constructor(message = "signal read could not reach the cloud service") {
    super(message);
    this.name = "SignalTransportError";
  }
}

/** Response body failed structural validation. */
export class SignalMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalMalformedError";
  }
}

function checkedUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new SignalMalformedError(`signal read returned a malformed ${field}`);
  }
  return value.toLowerCase();
}

function checkedNullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : checkedUuid(value, field);
}

function checkedTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new SignalMalformedError(`signal read returned a malformed ${field}`);
  }
  return value;
}

function signalRecord(value: unknown): SignalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SignalMalformedError("signal read returned a malformed row");
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
    throw new SignalMalformedError("signal read returned malformed signal data");
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
  };
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

function signalHttpError(response: Response): SignalHttpError {
  return new SignalHttpError(
    response.status,
    parseRetryAfterMs(response.headers.get("retry-after")),
  );
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
      if (!response.ok) {
        return { response, body: null };
      }
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
    throw new SignalTransportError();
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
  if (query.since !== undefined) {
    url.searchParams.set("created_at", `gte.${query.since}`);
  }
  url.searchParams.set("order", "created_at.desc,id.desc");
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
    throw new SignalTransportError();
  }
  const { response, body } = result;
  if (!response.ok) {
    throw signalHttpError(response);
  }
  if (!Array.isArray(body)) {
    throw new SignalMalformedError("signal read returned malformed JSON");
  }
  return body.map(signalRecord);
}

async function agentSignals(
  target: CloudTarget,
  credential: Extract<SignalCredential, { kind: "agent" }>,
  query: SignalQuery,
  options: ReturnType<typeof normalizeReadOptions>,
): Promise<SignalRecord[]> {
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
        limit: query.limit,
        include_stale: query.includeStale ?? false,
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    }, perReadTimeoutMs(options));
  } catch (error) {
    mapReadFailure(error, options.deadlineMs !== undefined);
  }
  if (result === null) {
    throw new SignalTransportError();
  }
  const { response, body } = result;
  if (!response.ok) {
    throw signalHttpError(response);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Array.isArray((body as Record<string, unknown>).signals)
  ) {
    throw new SignalMalformedError("signal read returned malformed JSON");
  }
  return ((body as Record<string, unknown>).signals as unknown[])
    .map(signalRecord);
}

export interface SignalMember {
  user_id: string;
  display_name: string;
}

export interface SignalAgent {
  principal_id: string;
  name: string;
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
  fetcher: typeof fetch = fetch,
): Promise<SignalDirectory> {
  let result: { response: Response; body: unknown } | null;
  try {
    result = await fetchSignalRead(fetcher, readEndpoint(target), {
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
    });
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

export async function readSignals(
  target: CloudTarget,
  credential: SignalCredential,
  query: SignalQuery,
  fetcherOrOptions: typeof fetch | SignalReadOptions = fetch,
): Promise<SignalRecord[]> {
  if (!UUID_RE.test(query.workspaceId)) {
    throw new Error("--workspace-id must be a UUID");
  }
  if (query.in_reply_to !== undefined && !UUID_RE.test(query.in_reply_to)) {
    throw new Error("in_reply_to must be a signal UUID");
  }
  const options = normalizeReadOptions(fetcherOrOptions);
  const normalized: SignalQuery = {
    ...query,
    workspaceId: query.workspaceId.toLowerCase(),
    ...(query.in_reply_to === undefined
      ? {}
      : { in_reply_to: query.in_reply_to.toLowerCase() }),
    limit: checkedLimit(query.limit),
    since: checkedSince(query.since),
    includeStale: query.includeStale ?? false,
  };
  return credential.kind === "human"
    ? await humanSignals(target, credential, normalized, options)
    : await agentSignals(target, credential, normalized, options);
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

export function isRetryableFollowError(error: unknown): boolean {
  if (error instanceof SignalReadTimeoutError) return true;
  if (error instanceof SignalTransportError) return true;
  if (error instanceof SignalHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return false;
}

export function isFatalFollowError(error: unknown): boolean {
  if (error instanceof SignalMalformedError) return true;
  if (error instanceof SignalHttpError) {
    return error.status === 400 ||
      error.status === 401 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status === 426 ||
      (error.status >= 400 && error.status < 500 && error.status !== 429);
  }
  return false;
}

function followRetryReason(error: unknown): string {
  if (error instanceof SignalReadTimeoutError) return "idle_deadline";
  if (error instanceof SignalTransportError) return "transport";
  if (error instanceof SignalHttpError) {
    if (error.status === 429) return "http_429";
    if (error.status >= 500) return `http_${error.status}`;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "AbortError" || /aborted/i.test(error.message));
}

/**
 * Long-running inbox receive loop. Caller supplies `arm`, which must refresh
 * credentials (AgentCredentialSession.bearer when agent) and perform one read.
 * Emits ready only after the first successful arm. Does not ack rows.
 */
export async function runInboxFollow(options: {
  workspaceId: string;
  arm: () => Promise<SignalRecord[]>;
  emit: (frame: FollowFrame) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  signal?: AbortSignal;
  pollMs?: number;
  seen?: BoundedSignalIdSet;
  /** Optional classifier for credential refusal/horizon failures from arm(). */
  isCredentialFailure?: (error: unknown) => boolean;
}): Promise<FollowStop> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const pollMs = options.pollMs ?? SIGNAL_FOLLOW_POLL_MS;
  const seen = options.seen ?? new BoundedSignalIdSet();
  const isCredentialFailure = options.isCredentialFailure ?? (() => false);
  const abort = options.signal;

  let ready = false;
  let attempt = 0;

  const cancelled = (): boolean => abort?.aborted === true;

  const sleepInterruptible = async (ms: number): Promise<"ok" | "cancelled"> => {
    if (cancelled()) return "cancelled";
    if (ms <= 0) return cancelled() ? "cancelled" : "ok";
    // Always use the injected sleep so tests can drive time; race abort so a
    // live SIGINT/AbortSignal still interrupts a long backoff.
    if (!abort) {
      await sleep(ms);
      return cancelled() ? "cancelled" : "ok";
    }
    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        if (abort.aborted) {
          resolve();
          return;
        }
        abort.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return cancelled() ? "cancelled" : "ok";
  };

  while (true) {
    if (cancelled()) return { reason: "cancelled" };

    try {
      const rows = await options.arm();
      attempt = 0;

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
      const ordered = [...rows].sort((a, b) => {
        const byTime = Date.parse(a.created_at) - Date.parse(b.created_at);
        if (byTime !== 0) return byTime;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      let emitted = false;
      for (const signal of ordered) {
        if (!seen.add(signal.id)) continue;
        options.emit({
          type: "signal",
          signal,
          ts: followTs(now()),
        });
        emitted = true;
      }

      // Rearm promptly after emissions; otherwise idle at the slowed poll cadence.
      if (!emitted) {
        const wait = await sleepInterruptible(pollMs);
        if (wait === "cancelled") return { reason: "cancelled" };
      }
    } catch (error) {
      if (cancelled() || isAbortError(error)) {
        return { reason: "cancelled" };
      }
      if (isCredentialFailure(error)) {
        return {
          reason: "credential",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      if (isRetryableFollowError(error)) {
        attempt += 1;
        const retryAfterMs = error instanceof SignalHttpError
          ? error.retryAfterMs
          : null;
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
      if (error instanceof SignalMalformedError) {
        return { reason: "malformed", error };
      }
      if (isFatalFollowError(error)) {
        return {
          reason: "fatal_http",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      return {
        reason: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}
