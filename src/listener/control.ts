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
  writeSecureJsonFile,
} from "../cloud/storage.js";
import {
  defaultListenerStateDirectory,
  listenerInstanceKey,
} from "./file-store.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STATUS_BYTES = 16 * 1024;
const MAX_CONTROL_BYTES = 8 * 1024;
const CONTROL_TIMEOUT_MS = 2_000;
const START_LOCK_WAIT_MS = 2_000;
const START_LOCK_STALE_MS = 10_000;

export type ListenerStatusState =
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export interface ListenerStatus {
  version: 1;
  instanceId: string;
  provider: "grok";
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
  const nullableUuid = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === "string" && UUID_RE.test(candidate));
  if (
    row.version !== 1 ||
    typeof row.instanceId !== "string" ||
    !UUID_RE.test(row.instanceId) ||
    row.provider !== "grok" ||
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
    typeof row.logPath !== "string" ||
    !isAbsolute(row.logPath)
  ) {
    throw new Error("stored listener status is malformed");
  }
  return row as unknown as ListenerStatus;
}

export async function writeListenerStatus(
  paths: ListenerPaths,
  status: ListenerStatus,
): Promise<void> {
  const serialized = JSON.stringify(status);
  parseStatus(serialized);
  await writeSecureJsonFile(paths.statusPath, serialized);
}

export async function readListenerStatus(
  paths: ListenerPaths,
): Promise<ListenerStatus | null> {
  const raw = await readSecureJsonFile(paths.statusPath, MAX_STATUS_BYTES);
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
    "delay_ms",
    "index",
  ]);
  for (const [key, value] of Object.entries(event)) {
    if (!allowed.has(key)) {
      throw new Error(`listener event field is not allowed: ${key}`);
    }
    if (
      typeof value === "string" &&
      (value.length > 128 || /swm_(?:agt|inv|cap)_/i.test(value))
    ) {
      throw new Error("listener event contains unsafe text");
    }
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
  socket.end(`${JSON.stringify(response)}\n`);
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
  if (process.platform === "win32") return;
  const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
  const directory = join("/tmp", `cswarm-control-${uid}`);
  await ensureSecureStateDirectory(directory);
  try {
    await queryListenerControl(paths, "status");
    throw new ListenerAlreadyRunningError();
  } catch (error) {
    if (error instanceof ListenerAlreadyRunningError) throw error;
    await unlink(paths.socketPath).catch((unlinkError) => {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw unlinkError;
      }
    });
  }
}

export async function startListenerControlServer(options: {
  paths: ListenerPaths;
  status: () => ListenerStatus;
  stop: () => void;
}): Promise<{ close: () => Promise<void> }> {
  const releaseStartupLock = await startupLock(options.paths);
  const server = createServer((socket) => {
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
