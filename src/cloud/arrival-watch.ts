import { homedir } from "node:os";
import { join } from "node:path";
import type { SignalRecord } from "./command-client.js";
import type { CloudTarget } from "./config.js";
import {
  followHttpDetails,
  isRetryableFollowError,
  nextFollowBackoffMs,
  SIGNAL_FOLLOW_PAGE_LIMIT,
  type AgentSignalPage,
  type SignalCursor,
} from "./signals.js";
import {
  readSecureJsonFile,
  writeSecureJsonFile,
} from "./storage.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_MAX_BYTES = 4 * 1024;
const ARRIVAL_SNIPPET_MAX = 180;

/** A remote-friendly cadence for a long-lived, human-visible arrival monitor. */
export const ARRIVAL_WATCH_POLL_MS = 25_000;
/** Continuous read failure time before a human-visible monitor warning. */
export const ARRIVAL_RETRY_NOTICE_THRESHOLD_MS = 60_000;

export type ArrivalRetryNotice =
  | {
    code: "arrival_read_persisting";
    continuousFailureMs: number;
    nextRetryMs: number;
  }
  | {
    code: "arrival_read_recovered";
    continuousFailureMs: number;
  };

export interface ArrivalRetryNoticePolicy {
  failure(nowMs: number, nextRetryMs: number): ArrivalRetryNotice | null;
  recovery(nowMs: number): ArrivalRetryNotice | null;
}

/** Collapse one retry episode to at most one failure line and one recovery line. */
export function createArrivalRetryNoticePolicy(
  thresholdMs = ARRIVAL_RETRY_NOTICE_THRESHOLD_MS,
): ArrivalRetryNoticePolicy {
  let firstFailureAt: number | null = null;
  let failureEmitted = false;
  return {
    failure(nowMs, nextRetryMs) {
      if (firstFailureAt === null) firstFailureAt = nowMs;
      const continuousFailureMs = Math.max(0, nowMs - firstFailureAt);
      if (failureEmitted || continuousFailureMs < thresholdMs) return null;
      failureEmitted = true;
      return {
        code: "arrival_read_persisting",
        continuousFailureMs,
        nextRetryMs,
      };
    },
    recovery(nowMs) {
      if (firstFailureAt === null) return null;
      const continuousFailureMs = Math.max(0, nowMs - firstFailureAt);
      const notice: ArrivalRetryNotice | null = failureEmitted
        ? { code: "arrival_read_recovered", continuousFailureMs }
        : null;
      firstFailureAt = null;
      failureEmitted = false;
      return notice;
    },
  };
}

/** Stable, one-line operator copy for a retry episode transition. */
export function formatArrivalRetryNotice(notice: ArrivalRetryNotice): string {
  const seconds = Math.max(1, Math.floor(notice.continuousFailureMs / 1_000));
  if (notice.code === "arrival_read_persisting") {
    return `[arrival_read_persisting] Arrival reads have failed continuously for ${seconds}s. ` +
      "Durable delivery is unaffected; only this monitor view is delayed. " +
      `Next check: automatic retry in ${notice.nextRetryMs}ms.`;
  }
  return `[arrival_read_recovered] Arrival reads recovered after ${seconds}s. ` +
    "This monitor is current again; durable delivery was unaffected.";
}

interface StoredArrivalCursor {
  version: 1;
  workspace_id: string;
  principal_id: string;
  cursor: SignalCursor | null;
}

export interface ArrivalCursorStore {
  readonly location: string;
  read(): Promise<SignalCursor | null | undefined>;
  write(cursor: SignalCursor | null): Promise<void>;
}

export interface ArrivalWatchPageRequest {
  /** Null only after an empty first-run baseline. */
  after: SignalCursor | null;
  /** First run reads the newest row only and emits none of the existing backlog. */
  baseline: boolean;
  limit: number;
}

export interface ArrivalWatchStop {
  reason: "cancelled" | "error";
  error?: Error;
}

export interface ArrivalNotification {
  type: "arrival";
  workspace_id: string;
  signal_id: string;
  sender: string;
  sender_kind: SignalRecord["from_kind"];
  kind: SignalRecord["kind"];
  snippet: string;
  attachment_count: number;
  reply_command: string;
}

function stateRoot(): string {
  return process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, "cswarm", "arrival-cursors")
    : join(homedir(), ".cswarm", "arrival-cursors");
}

/** One durable high-water mark per deployment, workspace, and agent identity. */
export function arrivalCursorPath(
  target: CloudTarget,
  workspaceId: string,
  principalId: string,
  root = stateRoot(),
): string {
  return join(
    root,
    `${target.profileId}-${workspaceId.toLowerCase()}-${principalId.toLowerCase()}.json`,
  );
}

function parseCursor(
  raw: string,
  workspaceId: string,
  principalId: string,
): SignalCursor | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("stored arrival cursor is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored arrival cursor is malformed");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const cursor = row.cursor;
  if (
    keys.join(",") !== "cursor,principal_id,version,workspace_id" ||
    row.version !== 1 ||
    row.workspace_id !== workspaceId.toLowerCase() ||
    row.principal_id !== principalId.toLowerCase() ||
    !(
      cursor === null ||
      (
        typeof cursor === "object" &&
        !Array.isArray(cursor) &&
        Object.keys(cursor as Record<string, unknown>).sort().join(",") ===
          "created_at,id" &&
        typeof (cursor as Record<string, unknown>).created_at === "string" &&
        Number.isFinite(Date.parse((cursor as Record<string, unknown>).created_at as string)) &&
        typeof (cursor as Record<string, unknown>).id === "string" &&
        UUID_RE.test((cursor as Record<string, unknown>).id as string)
      )
    )
  ) {
    throw new Error("stored arrival cursor is malformed");
  }
  if (cursor === null) return null;
  return {
    created_at: (cursor as Record<string, string>).created_at,
    id: (cursor as Record<string, string>).id.toLowerCase(),
  };
}

/** Secure atomic cursor storage; it contains ids and timestamps, never a credential. */
export function fileArrivalCursorStore(options: {
  target: CloudTarget;
  workspaceId: string;
  principalId: string;
  stateDirectory?: string;
}): ArrivalCursorStore {
  const workspaceId = options.workspaceId.toLowerCase();
  const principalId = options.principalId.toLowerCase();
  if (!UUID_RE.test(workspaceId) || !UUID_RE.test(principalId)) {
    throw new Error("arrival cursor identity must use workspace and principal UUIDs");
  }
  const location = arrivalCursorPath(
    options.target,
    workspaceId,
    principalId,
    options.stateDirectory,
  );
  return {
    location,
    async read() {
      const raw = await readSecureJsonFile(location, CURSOR_MAX_BYTES);
      return raw === null ? undefined : parseCursor(raw, workspaceId, principalId);
    },
    async write(cursor) {
      const record: StoredArrivalCursor = {
        version: 1,
        workspace_id: workspaceId,
        principal_id: principalId,
        cursor,
      };
      await writeSecureJsonFile(location, JSON.stringify(record));
    },
  };
}

/** Collapse a message body to one bounded, terminal-safe notification snippet. */
export function arrivalSnippet(body: string): string {
  const oneLine = body
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length <= ARRIVAL_SNIPPET_MAX) return oneLine;
  return `${oneLine.slice(0, ARRIVAL_SNIPPET_MAX - 1).trimEnd()}…`;
}

/** The exact CLI shape needed to answer the signal named by a notification. */
/* Matches the hook's reply hint deliberately. The url and anon key come from the
 * agent's saved target, so repeating them here only bloated every notification —
 * the anon key is a JWT, and a monitor line carrying it is unreadable on a phone
 * and teaches an agent to paste credentials into commands. Found by dogfooding
 * this feature within minutes of shipping it. */
export function arrivalReplyCommand(
  signalId: string,
  workspaceId: string,
): string {
  return `cswarm reply ${signalId} "<answer>" --workspace-id ${workspaceId}`;
}

/** Build the stable fields shared by readable and JSON monitor output. */
export function arrivalNotification(
  signal: SignalRecord,
  workspaceId: string,
  target: Pick<CloudTarget, "url" | "anonKey">,
): ArrivalNotification {
  return {
    type: "arrival",
    workspace_id: workspaceId,
    signal_id: signal.id,
    sender: signal.from,
    sender_kind: signal.from_kind,
    kind: signal.kind,
    snippet: arrivalSnippet(signal.body),
    attachment_count: signal.attachments?.length ?? 0,
    reply_command: arrivalReplyCommand(signal.id, workspaceId),
  };
}

/** Render exactly one readable line for one monitor notification. */
export function formatArrivalNotification(
  notification: ArrivalNotification,
): string {
  const attachmentCopy = notification.attachment_count === 0
    ? ""
    : ` — ${notification.attachment_count} attachment${notification.attachment_count === 1 ? "" : "s"}`;
  return `CommonSwarm from ${notification.sender_kind} ${notification.sender}: ${notification.snippet}${attachmentCopy} — reply: ${notification.reply_command}`;
}

function cursorOf(signal: SignalRecord): SignalCursor {
  return { created_at: signal.created_at, id: signal.id };
}

function assertCursorPage(page: AgentSignalPage): void {
  if (!page.capabilities.cursorAfter || page.legacyCursorFallback) {
    throw new Error(
      "arrival watch needs a read service with durable cursor support",
    );
  }
}

/**
 * Read-only arrival loop. It never imports or calls delivery claim/ack code.
 * The cursor is saved after each successfully emitted line, so a normal restart
 * resumes after that line while messages received during downtime remain newer.
 */
export async function runArrivalWatch(options: {
  workspaceId: string;
  principalId: string;
  store: ArrivalCursorStore;
  readPage(request: ArrivalWatchPageRequest): Promise<AgentSignalPage>;
  emit(signal: SignalRecord): Promise<void>;
  onRetry?: (error: Error, delayMs: number) => void;
  onRecovery?: () => void;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  random?: () => number;
}): Promise<ArrivalWatchStop> {
  const pollMs = options.pollMs ?? ARRIVAL_WATCH_POLL_MS;
  const random = options.random ?? Math.random;
  let cursor = await options.store.read();
  let baseline = cursor === undefined;
  let attempt = 0;
  const cancelled = () => options.signal?.aborted === true;

  const wait = async (ms: number): Promise<void> => {
    if (options.sleep) {
      await options.sleep(ms);
      return;
    }
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", finish);
        resolve();
      };
      if (cancelled() || ms <= 0) {
        resolve();
        return;
      }
      options.signal?.addEventListener("abort", finish, { once: true });
      timer = setTimeout(finish, ms);
    });
  };

  while (!cancelled()) {
    try {
      const page = await options.readPage({
        after: cursor ?? null,
        baseline,
        limit: baseline ? 1 : SIGNAL_FOLLOW_PAGE_LIMIT,
      });
      assertCursorPage(page);
      if (page.signals.some((row) =>
        row.workspace_id !== options.workspaceId ||
        row.to_agent !== options.principalId
      )) {
        throw new Error(
          "arrival read returned a message directed to another workspace or agent",
        );
      }
      if (attempt > 0) options.onRecovery?.();
      attempt = 0;

      if (baseline) {
        if (page.rawCount > 0 && page.nextCursor === null) {
          throw new Error("arrival baseline returned no safe terminal cursor");
        }
        cursor = page.nextCursor;
        await options.store.write(cursor);
        baseline = false;
        if (cancelled()) break;
        await wait(pollMs);
        continue;
      }

      for (const row of page.signals) {
        if (cancelled()) break;
        await options.emit(row);
        cursor = cursorOf(row);
        await options.store.write(cursor);
      }
      if (cancelled()) break;

      const fullPage = page.rawCount >= SIGNAL_FOLLOW_PAGE_LIMIT;
      await wait(fullPage ? 0 : pollMs);
    } catch (error) {
      if (cancelled()) break;
      const http = followHttpDetails(error);
      const retryable = isRetryableFollowError(error) ||
        http?.status === 429 ||
        (http !== null && http.status >= 500);
      if (!retryable) {
        return {
          reason: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      attempt += 1;
      const delayMs = nextFollowBackoffMs(
        attempt,
        http?.retryAfterMs ?? null,
        random,
      );
      const typed = error instanceof Error ? error : new Error(String(error));
      options.onRetry?.(typed, delayMs);
      await wait(delayMs);
    }
  }
  return { reason: "cancelled" };
}
