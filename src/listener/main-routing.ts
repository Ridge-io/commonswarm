import { isAbsolute, join } from "node:path";
import {
  readSecureJsonFile,
  withFileLock,
  writeSecureJsonFile,
} from "../cloud/storage.js";
import type { SignalRecord } from "../cloud/command-client.js";
import type { ListenerSenderProvenance } from "./types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUEUE_BYTES = 1024 * 1024;
const QUEUE_FILE = "pending-for-main.json";
const QUEUE_LOCK = "pending-for-main";

export const LISTENER_MAIN_QUEUE_MAX = 200;
export const LISTENER_DEFER_OVER_MIN = 1;
export const LISTENER_DEFER_OVER_MAX = 10_000;

export type ListenerRouteMode = "worker" | "main" | "split";
export type ListenerRouteDecision = "worker" | "main";

/** Keep the default worker path exact while making the split boundary explicit. */
export function decideListenerRoute(
  route: ListenerRouteMode,
  threshold: number | null,
  bodyLength: number,
): ListenerRouteDecision {
  if (!Number.isSafeInteger(bodyLength) || bodyLength < 0) {
    throw new Error("listener route body length must be a non-negative integer");
  }
  if (route === "worker") {
    if (threshold !== null) {
      throw new Error("worker route cannot have a split threshold");
    }
    return "worker";
  }
  if (route === "main") {
    if (threshold !== null) {
      throw new Error("main route cannot have a split threshold");
    }
    return "main";
  }
  if (route !== "split") {
    throw new Error("listener route mode is invalid");
  }
  if (
    threshold === null ||
    !Number.isSafeInteger(threshold) ||
    threshold < LISTENER_DEFER_OVER_MIN ||
    threshold > LISTENER_DEFER_OVER_MAX
  ) {
    throw new Error("split route threshold is invalid");
  }
  return bodyLength > threshold ? "main" : "worker";
}

export interface PendingMainEntry {
  signalId: string;
  workspaceId: string;
  principalId: string;
  fromId: string;
  fromKind: "user" | "agent";
  kind?: "ask" | "note";
  senderName: string | null;
  body: string;
  attachmentCount?: number;
  createdAt: string;
  queuedAt: string;
  /** True only when the delivery ledger is waiting for hook-surfaced observation. */
  observationPending?: true;
}

interface PendingMainFile {
  version: 1;
  entries: PendingMainEntry[];
  droppedCount: number;
}

function checkedTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseEntry(value: unknown): PendingMainEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored pending-for-main entry is malformed");
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set([
    "signalId",
    "workspaceId",
    "principalId",
    "fromId",
    "fromKind",
    "kind",
    "senderName",
    "body",
    "attachmentCount",
    "createdAt",
    "queuedAt",
    "observationPending",
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new Error("stored pending-for-main entry is malformed");
  }
  if (
    typeof row.signalId !== "string" || !UUID_RE.test(row.signalId) ||
    typeof row.workspaceId !== "string" || !UUID_RE.test(row.workspaceId) ||
    typeof row.principalId !== "string" || !UUID_RE.test(row.principalId) ||
    typeof row.fromId !== "string" || !UUID_RE.test(row.fromId) ||
    (row.fromKind !== "user" && row.fromKind !== "agent") ||
    !(row.kind === undefined || row.kind === "ask" || row.kind === "note") ||
    !(row.senderName === null ||
      (typeof row.senderName === "string" && row.senderName.length <= 200)) ||
    typeof row.body !== "string" || row.body.length < 1 ||
    !(row.attachmentCount === undefined ||
      (typeof row.attachmentCount === "number" &&
        Number.isSafeInteger(row.attachmentCount) &&
        row.attachmentCount >= 1 && row.attachmentCount <= 8)) ||
    !checkedTimestamp(row.createdAt) || !checkedTimestamp(row.queuedAt) ||
    !(row.observationPending === undefined || row.observationPending === true)
  ) {
    throw new Error("stored pending-for-main entry is malformed");
  }
  return {
    signalId: row.signalId.toLowerCase(),
    workspaceId: row.workspaceId.toLowerCase(),
    principalId: row.principalId.toLowerCase(),
    fromId: row.fromId.toLowerCase(),
    fromKind: row.fromKind,
    ...(row.kind === "ask" || row.kind === "note" ? { kind: row.kind } : {}),
    senderName: row.senderName,
    body: row.body,
    ...(typeof row.attachmentCount === "number"
      ? { attachmentCount: row.attachmentCount }
      : {}),
    createdAt: row.createdAt,
    queuedAt: row.queuedAt,
    ...(row.observationPending === true ? { observationPending: true as const } : {}),
  };
}

function parseFile(raw: string): PendingMainFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("stored pending-for-main queue is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored pending-for-main queue is malformed");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) =>
      key !== "version" && key !== "entries" && key !== "droppedCount"
    ) ||
    row.version !== 1 || !Array.isArray(row.entries) ||
    row.entries.length > LISTENER_MAIN_QUEUE_MAX ||
    !(row.droppedCount === undefined ||
      (typeof row.droppedCount === "number" &&
        Number.isSafeInteger(row.droppedCount) && row.droppedCount >= 0))
  ) {
    throw new Error("stored pending-for-main queue is malformed");
  }
  const entries = row.entries.map(parseEntry);
  if (new Set(entries.map((entry) => entry.signalId)).size !== entries.length) {
    throw new Error("stored pending-for-main queue repeats a signal");
  }
  return { version: 1, entries, droppedCount: row.droppedCount ?? 0 };
}

/** One bounded, locked queue beside status.json for messages reserved for the main session. */
export class FilePendingMainQueue {
  readonly path: string;
  private readonly directory: string;

  constructor(instanceDirectory: string) {
    if (!isAbsolute(instanceDirectory)) {
      throw new Error("pending-for-main directory must be absolute");
    }
    this.directory = instanceDirectory;
    this.path = join(instanceDirectory, QUEUE_FILE);
  }

  private async readUnlocked(): Promise<PendingMainFile> {
    const raw = await readSecureJsonFile(this.path, MAX_QUEUE_BYTES);
    return raw === null ? { version: 1, entries: [], droppedCount: 0 } : parseFile(raw);
  }

  private async writeUnlocked(file: PendingMainFile): Promise<void> {
    const canonical = parseFile(JSON.stringify(file));
    await writeSecureJsonFile(this.path, JSON.stringify(canonical));
  }

  async read(): Promise<PendingMainEntry[]> {
    return [...(await this.readUnlocked()).entries];
  }

  async count(): Promise<number> {
    return (await this.readUnlocked()).entries.length;
  }

  async stats(): Promise<{ count: number; droppedCount: number }> {
    const file = await this.readUnlocked();
    return { count: file.entries.length, droppedCount: file.droppedCount };
  }

  async enqueue(entry: PendingMainEntry): Promise<{
    count: number;
    added: boolean;
    droppedOldest: boolean;
    droppedCount: number;
  }> {
    const checked = parseEntry(entry);
    return await withFileLock(this.directory, QUEUE_LOCK, async () => {
      const file = await this.readUnlocked();
      if (file.entries.some((item) => item.signalId === checked.signalId)) {
        return {
          count: file.entries.length,
          added: false,
          droppedOldest: false,
          droppedCount: file.droppedCount,
        };
      }
      file.entries.push(checked);
      const droppedOldest = file.entries.length > LISTENER_MAIN_QUEUE_MAX;
      if (droppedOldest) {
        file.entries.shift();
        file.droppedCount += 1;
      }
      await this.writeUnlocked(file);
      return {
        count: file.entries.length,
        added: true,
        droppedOldest,
        droppedCount: file.droppedCount,
      };
    });
  }

  async remove(signalIds: ReadonlySet<string>, lockTimeoutMs?: number): Promise<number> {
    if (signalIds.size === 0) return await this.count();
    return await withFileLock(this.directory, QUEUE_LOCK, async () => {
      const file = await this.readUnlocked();
      const entries = file.entries.filter((entry) => !signalIds.has(entry.signalId));
      if (entries.length !== file.entries.length) {
        await this.writeUnlocked({
          version: 1,
          entries,
          droppedCount: file.droppedCount,
        });
      }
      return entries.length;
    }, lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs });
  }
}

/** Project one directed message into the local queue without carrying lease capabilities. */
export function pendingMainEntry(
  signal: SignalRecord,
  principalId: string,
  provenance: ListenerSenderProvenance,
  now: number,
  options: { observationPending?: boolean } = {},
): PendingMainEntry {
  if (signal.kind !== "ask" && signal.kind !== "note") {
    throw new Error("only directed asks and notes can enter the pending-for-main queue");
  }
  return parseEntry({
    signalId: signal.id,
    workspaceId: signal.workspace_id,
    principalId,
    fromId: signal.from,
    fromKind: signal.from_kind,
    kind: signal.kind,
    senderName: provenance.senderName,
    body: signal.body,
    ...((signal.attachments?.length ?? 0) > 0
      ? { attachmentCount: signal.attachments!.length }
      : {}),
    createdAt: signal.created_at,
    queuedAt: new Date(now).toISOString(),
    ...(options.observationPending ? { observationPending: true } : {}),
  });
}
