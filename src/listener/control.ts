import { createServer, createConnection, type Socket } from "node:net";
import {
  chmod,
  lstat,
  open,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  ensureSecureStateDirectory,
  readSecureJsonFile,
  readSecureJsonFileIfPresent,
  writeSecureJsonFile,
} from "../cloud/storage.js";
import {
  defaultListenerStateDirectory,
  listenerInstanceKey,
} from "./file-store.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_STATUS_BYTES = 16 * 1024;
const MAX_CONTROL_BYTES = 8 * 1024;
const CONTROL_TIMEOUT_MS = 2_000;
const START_LOCK_WAIT_MS = 2_000;
const START_LOCK_STALE_MS = 10_000;

import type { ListenerPermissionMode } from "./types.js";
import type { ListenerRouteMode } from "./main-routing.js";

export type ListenerStatusState =
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export type ListenerProviderId = "grok" | "opencode" | "claude" | "codex";

export interface ListenerStatus {
  version: 1;
  instanceId: string;
  provider: ListenerProviderId;
  permissionMode?: ListenerPermissionMode;
  profileId: string;
  workspaceId: string;
  principalId: string;
  pid: number;
  state: ListenerStatusState;
  startedAt: string;
  readyAt: string | null;
  updatedAt: string;
  stoppedAt: string | null;
  lastSignalId: string | null;
  lastErrorCode: string | null;
  /** Final local error message for diagnosis; never sent to CommonSwarm. */
  lastErrorDetail: string | null;
  /** Stable provider-boundary reason beneath a shared outer failure code. */
  lastErrorReasonCode?: string | null;
  /** Absolute realpath of the provider process this supervisor opened. */
  providerExecutable?: string | null;
  /** Version measured from the exact provider executable before spawn. */
  providerVersion?: string | null;
  providerLastMeasuredVersion?: string | null;
  /** Exact package versions bundled by a Claude bridge, when measurable. */
  providerBundledAgentSdkVersion?: string | null;
  providerBundledClaudeCodeVersion?: string | null;
  /** Minimum Claude Code version returned by the API on a failed request. */
  providerMinimumRequiredVersion?: string | null;
  /** The cswarm binary version reported by the running supervisor. */
  cswarmVersion?: string | null;
  /**
   * Final lines of the last failed worker's stderr, sanitized and bounded by
   * the supervisor. LOCAL diagnosis only (D-090 family) — this file is the
   * operator's own 0600 state; the tail never reaches a server payload.
   * Old status files omit the key; readListenerStatus normalizes it to null.
   */
  lastWorkerStderrTail: string | null;
  // Metadata-only delivery fields (§13). Required nullable fields for every
  // in-memory producer; readListenerStatus normalizes old version-1 disk JSON
  // that omits them to null without rewriting bytes, and writeListenerStatus
  // refuses a write that omits any of them, so every new status file carries
  // all six keys.
  deliveryMode: "durable_claim" | "cursor_fallback" | null;
  pendingDeliveryCount: number | null;
  lastTerminalDeliveryFailureCount: number | null;
  lastTerminalDeliveryFailureAt: string | null;
  lastClaimAt: string | null;
  lastAckAt: string | null;
  routeMode?: ListenerRouteMode;
  deferOverChars?: number | null;
  pendingForMainCount?: number;
  droppedForMainCount?: number;
  logPath: string;
}

export interface ListenerPaths {
  key: string;
  instanceDirectory: string;
  statusPath: string;
  logPath: string;
  socketPath: string;
}

export class ListenerAlreadyRunningError extends Error {
  constructor() {
    super("a listener is already running for this agent principal");
    this.name = "ListenerAlreadyRunningError";
  }
}

export function listenerPaths(options: {
  profileId: string;
  workspaceId: string;
  principalId: string;
  stateDirectory?: string;
}): ListenerPaths {
  const root = options.stateDirectory ?? defaultListenerStateDirectory();
  if (!isAbsolute(root)) {
    throw new Error("listener state directory must be absolute");
  }
  const key = listenerInstanceKey(options);
  const instanceDirectory = join(root, key);
  const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
  // Keep the Unix socket below macOS's short sockaddr_un path limit.
  const controlDirectory = process.platform === "win32"
    ? ""
    : join("/tmp", `cswarm-control-${uid}`);
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\cswarm-${key}`
    : join(controlDirectory, `${key.slice(0, 32)}.sock`);
  return {
    key,
    instanceDirectory,
    statusPath: join(instanceDirectory, "status.json"),
    logPath: join(instanceDirectory, "events.ndjson"),
    socketPath,
  };
}

const STATUS_DELIVERY_MODES = new Set(["durable_claim", "cursor_fallback"]);
const STATUS_ALLOWED_KEYS = new Set([
  "version",
  "instanceId",
  "provider",
  "permissionMode",
  "profileId",
  "workspaceId",
  "principalId",
  "pid",
  "state",
  "startedAt",
  "readyAt",
  "updatedAt",
  "stoppedAt",
  "lastSignalId",
  "lastErrorCode",
  "lastErrorDetail",
  "lastErrorReasonCode",
  "providerExecutable",
  "providerVersion",
  "providerLastMeasuredVersion",
  "providerBundledAgentSdkVersion",
  "providerBundledClaudeCodeVersion",
  "providerMinimumRequiredVersion",
  "cswarmVersion",
  "lastWorkerStderrTail",
  "logPath",
  "deliveryMode",
  "pendingDeliveryCount",
  "lastTerminalDeliveryFailureCount",
  "lastTerminalDeliveryFailureAt",
  "lastClaimAt",
  "lastAckAt",
  "routeMode",
  "deferOverChars",
  "pendingForMainCount",
  "droppedForMainCount",
]);
// Sensitive aliases are rejected by name, not silently dropped, so a status
// file can never smuggle a lease capability, command ID, credential, or body.
const STATUS_SENSITIVE_KEYS = new Set([
  "leaseId",
  "lease_id",
  "claimCommandId",
  "claim_command_id",
  "ackCommandId",
  "ack_command_id",
  "bearer",
  "token",
  "body",
  "prompt",
  "reply",
  "owner",
  "ownerId",
  "owner_id",
]);
const STATUS_DELIVERY_KEYS = [
  "deliveryMode",
  "pendingDeliveryCount",
  "lastTerminalDeliveryFailureCount",
  "lastTerminalDeliveryFailureAt",
  "lastClaimAt",
  "lastAckAt",
] as const;

function parseStatus(raw: string): ListenerStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("stored listener status is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored listener status is malformed");
  }
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (STATUS_SENSITIVE_KEYS.has(key)) {
      throw new Error("stored listener status contains a forbidden field");
    }
    if (!STATUS_ALLOWED_KEYS.has(key)) {
      throw new Error("stored listener status is malformed");
    }
  }
  const nullableUuid = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === "string" && UUID_RE.test(candidate));
  const nullableCount = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0);
  const nullableTimestamp = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === "string" && Number.isFinite(Date.parse(candidate)));
  if (
    row.version !== 1 ||
    typeof row.instanceId !== "string" ||
    !UUID_RE.test(row.instanceId) ||
    (row.provider !== "grok" &&
      row.provider !== "opencode" &&
      row.provider !== "claude" &&
      row.provider !== "codex") ||
    typeof row.profileId !== "string" ||
    typeof row.workspaceId !== "string" ||
    !UUID_RE.test(row.workspaceId) ||
    typeof row.principalId !== "string" ||
    !UUID_RE.test(row.principalId) ||
    !Number.isSafeInteger(row.pid) ||
    (row.pid as number) < 1 ||
    typeof row.state !== "string" ||
    !["starting", "ready", "stopping", "stopped", "failed"].includes(row.state) ||
    typeof row.startedAt !== "string" ||
    !Number.isFinite(Date.parse(row.startedAt)) ||
    !(row.readyAt === null ||
      (typeof row.readyAt === "string" && Number.isFinite(Date.parse(row.readyAt)))) ||
    typeof row.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    !(row.stoppedAt === null ||
      (typeof row.stoppedAt === "string" && Number.isFinite(Date.parse(row.stoppedAt)))) ||
    !nullableUuid(row.lastSignalId) ||
    !(row.lastErrorCode === null ||
      (typeof row.lastErrorCode === "string" &&
        /^[a-z0-9_-]{1,96}$/.test(row.lastErrorCode))) ||
    !(row.lastErrorDetail === undefined ||
      row.lastErrorDetail === null ||
      (typeof row.lastErrorDetail === "string" &&
        row.lastErrorDetail.length > 0 &&
        row.lastErrorDetail.length <= 2_048 &&
        !/swm_(?:agt|inv|cap)_/i.test(row.lastErrorDetail))) ||
    !(row.lastErrorReasonCode === undefined ||
      row.lastErrorReasonCode === null ||
      (typeof row.lastErrorReasonCode === "string" &&
        /^[a-z0-9_-]{1,96}$/.test(row.lastErrorReasonCode))) ||
    !(row.providerExecutable === undefined ||
      row.providerExecutable === null ||
      (typeof row.providerExecutable === "string" &&
        isAbsolute(row.providerExecutable))) ||
    !(row.providerVersion === undefined || row.providerVersion === null ||
      (typeof row.providerVersion === "string" && SEMVER_RE.test(row.providerVersion))) ||
    !(row.providerLastMeasuredVersion === undefined ||
      row.providerLastMeasuredVersion === null ||
      (typeof row.providerLastMeasuredVersion === "string" &&
        SEMVER_RE.test(row.providerLastMeasuredVersion))) ||
    !(row.providerBundledAgentSdkVersion === undefined ||
      row.providerBundledAgentSdkVersion === null ||
      (typeof row.providerBundledAgentSdkVersion === "string" &&
        SEMVER_RE.test(row.providerBundledAgentSdkVersion))) ||
    !(row.providerBundledClaudeCodeVersion === undefined ||
      row.providerBundledClaudeCodeVersion === null ||
      (typeof row.providerBundledClaudeCodeVersion === "string" &&
        SEMVER_RE.test(row.providerBundledClaudeCodeVersion))) ||
    !(row.providerMinimumRequiredVersion === undefined ||
      row.providerMinimumRequiredVersion === null ||
      (typeof row.providerMinimumRequiredVersion === "string" &&
        SEMVER_RE.test(row.providerMinimumRequiredVersion))) ||
    !(row.cswarmVersion === undefined || row.cswarmVersion === null ||
      (typeof row.cswarmVersion === "string" && SEMVER_RE.test(row.cswarmVersion))) ||
    ((row.providerVersion === null || row.providerVersion === undefined) !==
      (row.providerLastMeasuredVersion === null ||
        row.providerLastMeasuredVersion === undefined)) ||
    !(row.lastWorkerStderrTail === undefined ||
      row.lastWorkerStderrTail === null ||
      (typeof row.lastWorkerStderrTail === "string" &&
        row.lastWorkerStderrTail.length > 0 &&
        row.lastWorkerStderrTail.length <= 2_048 &&
        !/swm_(?:agt|inv|cap)_/i.test(row.lastWorkerStderrTail))) ||
    typeof row.logPath !== "string" ||
    !isAbsolute(row.logPath) ||
    !(row.deliveryMode === undefined ||
      row.deliveryMode === null ||
      (typeof row.deliveryMode === "string" &&
        STATUS_DELIVERY_MODES.has(row.deliveryMode))) ||
    !(row.pendingDeliveryCount === undefined ||
      nullableCount(row.pendingDeliveryCount)) ||
    !(row.lastTerminalDeliveryFailureCount === undefined ||
      nullableCount(row.lastTerminalDeliveryFailureCount)) ||
    !(row.lastTerminalDeliveryFailureAt === undefined ||
      nullableTimestamp(row.lastTerminalDeliveryFailureAt)) ||
    !(row.lastClaimAt === undefined ||
      nullableTimestamp(row.lastClaimAt)) ||
    !(row.lastAckAt === undefined ||
      nullableTimestamp(row.lastAckAt)) ||
    !(row.routeMode === undefined ||
      row.routeMode === "worker" || row.routeMode === "main" || row.routeMode === "split") ||
    !(row.deferOverChars === undefined || row.deferOverChars === null ||
      (typeof row.deferOverChars === "number" &&
        Number.isSafeInteger(row.deferOverChars) && row.deferOverChars >= 1 &&
        row.deferOverChars <= 10_000)) ||
    !(row.pendingForMainCount === undefined ||
      (typeof row.pendingForMainCount === "number" &&
        Number.isSafeInteger(row.pendingForMainCount) && row.pendingForMainCount >= 0)) ||
    !(row.droppedForMainCount === undefined ||
      (typeof row.droppedForMainCount === "number" &&
        Number.isSafeInteger(row.droppedForMainCount) && row.droppedForMainCount >= 0))
  ) {
    throw new Error("stored listener status is malformed");
  }
  const routeMode = (row.routeMode ?? "worker") as ListenerRouteMode;
  const deferOverChars = (row.deferOverChars ?? null) as number | null;
  if (
    (routeMode === "split" && deferOverChars === null) ||
    (routeMode !== "split" && deferOverChars !== null)
  ) {
    throw new Error("stored listener status routing fields are malformed");
  }
  // Old version-1 files predate the delivery fields: normalize the absent
  // keys to null in memory without rewriting the stored bytes.
  return {
    ...(row as unknown as ListenerStatus),
    deliveryMode: (row.deliveryMode ?? null) as ListenerStatus["deliveryMode"],
    pendingDeliveryCount: (row.pendingDeliveryCount ?? null) as number | null,
    lastTerminalDeliveryFailureCount:
      (row.lastTerminalDeliveryFailureCount ?? null) as number | null,
    lastTerminalDeliveryFailureAt:
      (row.lastTerminalDeliveryFailureAt ?? null) as string | null,
    lastClaimAt: (row.lastClaimAt ?? null) as string | null,
    lastAckAt: (row.lastAckAt ?? null) as string | null,
    lastErrorDetail: (row.lastErrorDetail ?? null) as string | null,
    lastWorkerStderrTail: (row.lastWorkerStderrTail ?? null) as string | null,
    providerVersion: (row.providerVersion ?? null) as string | null,
    providerLastMeasuredVersion:
      (row.providerLastMeasuredVersion ?? null) as string | null,
    ...(row.cswarmVersion === undefined
      ? {}
      : { cswarmVersion: row.cswarmVersion as string | null }),
    routeMode,
    deferOverChars,
    pendingForMainCount: (row.pendingForMainCount ?? 0) as number,
    droppedForMainCount: (row.droppedForMainCount ?? 0) as number,
  };
}

export async function writeListenerStatus(
  paths: ListenerPaths,
  status: ListenerStatus,
): Promise<void> {
  const serialized = JSON.stringify(status);
  // New writes always carry all six delivery fields, even when null.
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  for (const key of STATUS_DELIVERY_KEYS) {
    if (!(key in parsed)) {
      throw new Error("listener status is missing delivery metadata fields");
    }
  }
  if (!("lastErrorDetail" in parsed)) {
    throw new Error("listener status is missing local error detail metadata");
  }
  parseStatus(serialized);
  await writeSecureJsonFile(paths.statusPath, serialized);
}

export async function readListenerStatus(
  paths: ListenerPaths,
): Promise<ListenerStatus | null> {
  const raw = await readSecureJsonFile(paths.statusPath, MAX_STATUS_BYTES);
  return raw === null ? null : parseStatus(raw);
}

/** Read listener status without creating a missing instance directory. */
export async function readListenerStatusIfPresent(
  paths: ListenerPaths,
): Promise<ListenerStatus | null> {
  const raw = await readSecureJsonFileIfPresent(paths.statusPath, MAX_STATUS_BYTES);
  return raw === null ? null : parseStatus(raw);
}

/** Append one metadata-only event to an owned 0600 log. */
export async function appendListenerEvent(
  paths: ListenerPaths,
  event: Record<string, string | number | boolean | null>,
): Promise<void> {
  const allowed = new Set([
    "ts",
    "event",
    "instance_id",
    "pid",
    "signal_id",
    "status",
    "failure_code",
    "attempt",
    "total",
    "passed",
    "reason",
    "delay_ms",
    "index",
    "delivery_mode",
    "pending_delivery_count",
    "terminal_delivery_failure_count",
    "outcome",
    // D-051 companion 2: why a listener is down, and why it stopped trying.
    "restart_attempts",
    "restartable",
    "restarts_exhausted",
    // D-090 family: the last lines of a dead worker's stderr, sanitized and
    // bounded by the supervisor, and the prompt-turn budget behind a timeout.
    // Local log only — this file never feeds a server payload.
    "worker_stderr_tail",
    "turn_budget_ms",
    "route_mode",
    "route_decision",
    "defer_over_chars",
    "body_length",
    "pending_main_count",
    "dropped_count",
  ]);
  const deliveryModes = new Set(["durable_claim", "cursor_fallback"]);
  const deliveryOutcomes = new Set([
    "replied",
    "observed",
    "queued",
    "expired",
    "failed_terminal",
  ]);
  const routeModes = new Set(["worker", "main", "split"]);
  const routeDecisions = new Set(["worker", "main"]);
  for (const [key, value] of Object.entries(event)) {
    if (!allowed.has(key)) {
      throw new Error(`listener event field is not allowed: ${key}`);
    }
    if (
      (key === "attempt" || key === "total") &&
      !(typeof value === "number" && Number.isSafeInteger(value) && value >= 1)
    ) {
      throw new Error("listener event attempt count is not allowed");
    }
    if (key === "passed" && typeof value !== "boolean") {
      throw new Error("listener event canary result is not allowed");
    }
    if (
      key === "reason" &&
      !(value === null || (typeof value === "string" && value.length > 0))
    ) {
      throw new Error("listener event canary reason is not allowed");
    }
    if (
      key === "delivery_mode" &&
      !(value === null ||
        (typeof value === "string" && deliveryModes.has(value)))
    ) {
      throw new Error("listener event delivery mode is not allowed");
    }
    if (
      (key === "pending_delivery_count" ||
        key === "terminal_delivery_failure_count") &&
      !(value === null ||
        (typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0))
    ) {
      throw new Error("listener event delivery count is not allowed");
    }
    if (
      key === "outcome" &&
      !(value === null ||
        (typeof value === "string" && deliveryOutcomes.has(value)))
    ) {
      throw new Error("listener event outcome is not allowed");
    }
    if (
      key === "route_mode" &&
      !(typeof value === "string" && routeModes.has(value))
    ) {
      throw new Error("listener event route mode is not allowed");
    }
    if (
      key === "route_decision" &&
      !(typeof value === "string" && routeDecisions.has(value))
    ) {
      throw new Error("listener event route decision is not allowed");
    }
    if (
      key === "defer_over_chars" &&
      !(value === null ||
        (typeof value === "number" && Number.isSafeInteger(value) &&
          value >= 1 && value <= 10_000))
    ) {
      throw new Error("listener event split threshold is not allowed");
    }
    if (
      (key === "body_length" || key === "pending_main_count" || key === "dropped_count") &&
      !(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    ) {
      throw new Error("listener event main-route count is not allowed");
    }
    if (
      key === "worker_stderr_tail" &&
      !(typeof value === "string" && value.length > 0 && value.length <= 2_048)
    ) {
      throw new Error("listener event stderr tail is not allowed");
    }
    if (
      key === "turn_budget_ms" &&
      !(typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    ) {
      throw new Error("listener event turn budget is not allowed");
    }
    if (
      typeof value === "string" &&
      // worker_stderr_tail is deliberately exempt from the generic 128-char
      // cap (its own bound is 2048, above); the secret scan still applies to
      // every string, the tail included.
      ((key !== "worker_stderr_tail" && value.length > 128) ||
        /swm_(?:agt|inv|cap)_/i.test(value))
    ) {
      throw new Error("listener event contains unsafe text");
    }
  }
  if (
    event.event === "listener_canary_attempt" &&
    (typeof event.attempt !== "number" ||
      typeof event.total !== "number" ||
      event.attempt > event.total ||
      typeof event.passed !== "boolean" ||
      !(event.reason === null || typeof event.reason === "string"))
  ) {
    throw new Error("listener canary attempt event is incomplete");
  }
  await ensureSecureStateDirectory(paths.instanceDirectory);
  const serialized = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 4_096) {
    throw new Error("listener event is too large");
  }
  try {
    const info = await lstat(paths.logPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
      throw new Error("listener event log is not a secure regular file");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("listener event log is not owned by this user");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(paths.logPath, "a", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(paths.logPath, 0o600);
}

type ControlRequest = { command: "status" | "stop" };
type ControlResponse =
  | { ok: true; status: ListenerStatus }
  | { ok: false; error: string };

function parseControlRequest(raw: string): ControlRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid control request");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid control request");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 1 ||
    (row.command !== "status" && row.command !== "stop")
  ) {
    throw new Error("invalid control request");
  }
  return { command: row.command };
}

function writeResponse(socket: Socket, response: ControlResponse): void {
  if (socket.writable) {
    try {
      socket.end(`${JSON.stringify(response)}\n`);
    } catch {
      socket.destroy();
    }
  }
}

async function startupLock(
  paths: ListenerPaths,
): Promise<() => Promise<void>> {
  await ensureSecureStateDirectory(paths.instanceDirectory);
  const lockPath = join(paths.instanceDirectory, "starting.lock");
  const deadline = Date.now() + START_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        await queryListenerControl(paths, "status", 250);
        throw new ListenerAlreadyRunningError();
      } catch (queryError) {
        if (queryError instanceof ListenerAlreadyRunningError) throw queryError;
      }
      const info = await lstat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs >= START_LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      continue;
    }
    try {
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
    return async () => {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    };
  }
  throw new ListenerAlreadyRunningError();
}

async function prepareSocket(paths: ListenerPaths): Promise<void> {
  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
    const directory = join("/tmp", `cswarm-control-${uid}`);
    await ensureSecureStateDirectory(directory);
  }
  try {
    await queryListenerControl(paths, "status");
    throw new ListenerAlreadyRunningError();
  } catch (error) {
    if (error instanceof ListenerAlreadyRunningError) throw error;
    if (process.platform !== "win32") {
      await unlink(paths.socketPath).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw unlinkError;
        }
      });
    }
  }
}

export async function startListenerControlServer(options: {
  paths: ListenerPaths;
  status: () => ListenerStatus;
  stop: () => void;
  /**
   * Runs exactly once, after prepareSocket has rejected a live listener and
   * before bind/listen, while starting.lock is still held. A loser that
   * discovers a live socket never invokes it.
   */
  initialize?: () => Promise<void> | void;
}): Promise<{ close: () => Promise<void> }> {
  const releaseStartupLock = await startupLock(options.paths);
  const server = createServer((socket) => {
    socket.on("error", () => {
      socket.destroy();
    });
    let input = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_CONTROL_BYTES) {
        handled = true;
        writeResponse(socket, { ok: false, error: "request_too_large" });
        return;
      }
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      const line = input.slice(0, newline);
      try {
        const request = parseControlRequest(line);
        if (request.command === "stop") options.stop();
        writeResponse(socket, { ok: true, status: options.status() });
      } catch {
        writeResponse(socket, { ok: false, error: "invalid_request" });
      }
    });
  });
  try {
    await prepareSocket(options.paths);
    if (options.initialize) {
      await options.initialize();
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(options.paths.socketPath);
    });
    if (process.platform !== "win32") {
      await chmod(options.paths.socketPath, 0o600);
    }
  } catch (error) {
    // Leave no live server behind when prepare/initialize/listen fails. Only
    // clean up a socket this server actually bound: a loser that discovers a
    // live socket in prepareSocket must not delete the winner's socket.
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") {
        await unlink(options.paths.socketPath).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await releaseStartupLock();
  }
  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") {
        await unlink(options.paths.socketPath).catch(() => undefined);
      }
    },
  };
}

export async function queryListenerControl(
  paths: ListenerPaths,
  command: "status" | "stop",
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<ListenerStatus> {
  return await new Promise<ListenerStatus>((resolve, reject) => {
    const socket = createConnection(paths.socketPath);
    let input = "";
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("listener control timed out"));
    }, timeoutMs);
    const finish = (error?: Error, status?: ListenerStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(status!);
    };
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ command })}\n`);
    });
    socket.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_CONTROL_BYTES) {
        finish(new Error("listener control response is too large"));
        return;
      }
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
        if (response.ok !== true || !response.status) {
          finish(new Error("listener control refused the request"));
          return;
        }
        finish(undefined, parseStatus(JSON.stringify(response.status)));
      } catch {
        finish(new Error("listener control returned malformed JSON"));
      }
    });
  });
}
