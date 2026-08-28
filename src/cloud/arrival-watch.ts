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
export function arrivalReplyCommand(
  signalId: string,
  workspaceId: string,
  target: Pick<CloudTarget, "url" | "anonKey">,
): string {
  return `cswarm reply ${signalId} "<answer>" --agent-token-stdin --url ${target.url} --anon-key ${target.anonKey} --workspace-id ${workspaceId}`;
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
    reply_command: arrivalReplyCommand(signal.id, workspaceId, target),
  };
}

/** Render exactly one readable line for one monitor notification. */
export function formatArrivalNotification(
  notification: ArrivalNotification,
): string {
  return `CommonSwarm from ${notification.sender_kind} ${notification.sender}: ${notification.snippet} — reply: ${notification.reply_command}`;
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
