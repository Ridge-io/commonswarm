import {
  readEndpoint,
  type CloudTarget,
} from "./config.js";
import type {
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
const SIGNAL_READ_TIMEOUT_MS = 30_000;

export type SignalCredential =
  | { kind: "human"; accessToken: string; userId: string }
  | { kind: "agent"; token: string };

export interface SignalQuery {
  workspaceId: string;
  inbox: boolean;
  about?: string;
  kind?: SignalKind;
  since?: string;
  limit?: number;
  includeStale?: boolean;
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

function signalRecord(value: unknown): SignalRecord {
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
  return {
    id: checkedUuid(row.id, "id"),
    workspace_id: checkedUuid(row.workspace_id, "workspace_id"),
    from: checkedUuid(row.from, "from"),
    from_kind: row.from_kind as SignalRecord["from_kind"],
    to: checkedNullableUuid(row.to, "to"),
    about: row.about as string | null,
    kind: row.kind as SignalKind,
    body: row.body,
    until: checkedTimestamp(row.until, "until"),
    created_at: checkedTimestamp(row.created_at, "created_at"),
  };
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

async function fetchSignalRead(
  fetcher: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
): Promise<{ response: Response; body: unknown } | null> {
  const deadlineController = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadlineController.signal])
    : deadlineController.signal;
  let onAbort = () => {};
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  const timeout = setTimeout(
    () => deadlineController.abort(),
    SIGNAL_READ_TIMEOUT_MS,
  );
  try {
    if (signal.aborted) return null;
    const read = (async () => {
      let response: Response;
      try {
        response = await fetcher(input, {
          ...init,
          signal,
        });
      } catch {
        return null;
      }
      if (signal.aborted) return null;
      if (!response.ok) {
        return { response, body: null };
      }
      try {
        return { response, body: await response.json() };
      } catch {
        return signal.aborted ? null : { response, body: null };
      }
    })();
    return await Promise.race([read, aborted]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

async function humanSignals(
  target: CloudTarget,
  credential: Extract<SignalCredential, { kind: "human" }>,
  query: SignalQuery,
  fetcher: typeof fetch,
): Promise<SignalRecord[]> {
  const url = new URL("/rest/v1/signals", target.url);
  url.searchParams.set(
    "select",
    "id,workspace_id,from,from_kind,to,about,kind,body,until,created_at",
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
  if (query.since !== undefined) {
    url.searchParams.set("created_at", `gte.${query.since}`);
  }
  url.searchParams.set("order", "created_at.desc,id.desc");
  url.searchParams.set("limit", String(query.limit));
  const result = await fetchSignalRead(fetcher, url, {
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      apikey: target.anonKey,
      "accept-profile": "swarm_read",
    },
  });
  if (result === null) {
    throw new Error("signal read could not reach the cloud service");
  }
  const { response, body } = result;
  if (!response.ok) {
    throw new Error(`signal read failed (HTTP ${response.status})`);
  }
  if (!Array.isArray(body)) {
    throw new Error("signal read returned malformed JSON");
  }
  return body.map(signalRecord);
}

async function agentSignals(
  target: CloudTarget,
  credential: Extract<SignalCredential, { kind: "agent" }>,
  query: SignalQuery,
  fetcher: typeof fetch,
): Promise<SignalRecord[]> {
  const result = await fetchSignalRead(fetcher, readEndpoint(target), {
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
      since: query.since ?? null,
      limit: query.limit,
      include_stale: query.includeStale ?? false,
    }),
  });
  if (result === null) {
    throw new Error("signal read could not reach the cloud service");
  }
  const { response, body } = result;
  if (!response.ok) {
    throw new Error(`signal read failed (HTTP ${response.status})`);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Array.isArray((body as Record<string, unknown>).signals)
  ) {
    throw new Error("signal read returned malformed JSON");
  }
  return ((body as Record<string, unknown>).signals as unknown[])
    .map(signalRecord);
}

export interface SignalMember {
  user_id: string;
  display_name: string;
}

export async function readAgentSignalMembers(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<SignalMember[]> {
  const result = await fetchSignalRead(fetcher, readEndpoint(target), {
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
  if (result === null) {
    throw new Error("member read could not reach the cloud service");
  }
  const { response, body } = result;
  if (!response.ok) {
    throw new Error(`member read failed (HTTP ${response.status})`);
  }
  const raw = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).members
    : null;
  if (!Array.isArray(raw)) {
    throw new Error("member read returned malformed JSON");
  }
  return raw.map((value): SignalMember => {
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
  });
}

export function resolveSignalRecipient(
  selector: string,
  members: readonly SignalMember[],
): string {
  if (UUID_RE.test(selector)) {
    const normalized = selector.toLowerCase();
    if (members.some((member) => member.user_id === normalized)) {
      return normalized;
    }
    throw new Error("signal recipient is not a live member of this project");
  }
  const matches = members.filter(
    (member) => member.display_name === selector,
  );
  if (matches.length === 1) return matches[0]!.user_id;
  if (matches.length > 1) {
    throw new Error(
      `signal recipient name is ambiguous; use one of these user ids: ${
        matches.map((member) => member.user_id).join(", ")
      }`,
    );
  }
  throw new Error("signal recipient is not a live member of this project");
}

export async function readSignals(
  target: CloudTarget,
  credential: SignalCredential,
  query: SignalQuery,
  fetcher: typeof fetch = fetch,
): Promise<SignalRecord[]> {
  if (!UUID_RE.test(query.workspaceId)) {
    throw new Error("--workspace-id must be a UUID");
  }
  const normalized: SignalQuery = {
    ...query,
    workspaceId: query.workspaceId.toLowerCase(),
    limit: checkedLimit(query.limit),
    since: checkedSince(query.since),
    includeStale: query.includeStale ?? false,
  };
  return credential.kind === "human"
    ? await humanSignals(target, credential, normalized, fetcher)
    : await agentSignals(target, credential, normalized, fetcher);
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
): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    view: inbox ? "inbox" : "feed",
    signals,
    message: signals.length === 0
      ? inbox
        ? "Nothing is waiting for you."
        : "No matching signals are visible."
      : `${signals.length} signal${signals.length === 1 ? "" : "s"} visible.`,
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
