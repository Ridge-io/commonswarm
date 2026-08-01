import { randomUUID } from "node:crypto";
import {
  appendListenerEvent,
  ListenerAlreadyRunningError,
  queryListenerControl,
  readListenerStatus,
  startListenerControlServer,
  writeListenerStatus,
  type ListenerPaths,
  type ListenerProviderId,
  type ListenerStatus,
} from "./control.js";
import type {
  ListenerRuntimeEvent,
  ListenerRuntimeStop,
} from "./runtime.js";

import type { ListenerPermissionMode } from "./types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ListenerSupervisorOptions {
  paths: ListenerPaths;
  profileId: string;
  workspaceId: string;
  principalId: string;
  /** Host adapter id recorded in status metadata only. Default: grok. */
  provider?: ListenerProviderId;
  permissionMode?: ListenerPermissionMode;
  now?: () => number;
  /**
   * Runs under starting.lock after the live-socket rejection check, before
   * the socket can answer. Receives the one proposed UUID and selects the
   * durable instance UUID (e.g. by opening the delivery journal).
   */
  prepare?: (proposedInstanceId: string) => Promise<{ instanceId: string }>;
  run: (
    signal: AbortSignal,
    onEvent: (event: ListenerRuntimeEvent) => void,
    listenerInstanceId: string,
  ) => Promise<ListenerRuntimeStop>;
}

export class ListenerStartupError extends Error {
  constructor(readonly code: string) {
    super(`listener stopped before ready (${code})`);
    this.name = "ListenerStartupError";
  }
}

function iso(now: () => number): string {
  return new Date(now()).toISOString();
}

function safeErrorCode(error: Error): string {
  const explicit = (error as Error & { code?: unknown }).code;
  if (typeof explicit === "string") {
    const normalized = explicit.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
    if (normalized.length > 0) return normalized.slice(0, 96);
  }
  const name = error.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return name.slice(0, 96) || "listener_error";
}

/** Lifetime control socket + durable metadata around one listener runtime. */
export async function runListenerSupervisor(
  options: ListenerSupervisorOptions,
): Promise<ListenerStatus> {
  const now = options.now ?? Date.now;
  const startedAt = iso(now);
  const controller = new AbortController();
  const proposedInstanceId = randomUUID();
  let status: ListenerStatus = {
    version: 1,
    instanceId: proposedInstanceId,
    provider: options.provider ?? "grok",
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    profileId: options.profileId,
    workspaceId: options.workspaceId.toLowerCase(),
    principalId: options.principalId.toLowerCase(),
    pid: process.pid,
    state: "starting",
    startedAt,
    readyAt: null,
    updatedAt: startedAt,
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    deliveryMode: null,
    pendingDeliveryCount: null,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
    logPath: options.paths.logPath,
  };
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(status);
    writes = writes.then(() => writeListenerStatus(options.paths, snapshot));
  };
  const log = (event: Record<string, string | number | boolean | null>) => {
    writes = writes.then(() => appendListenerEvent(options.paths, event));
  };
  const transition = (
    state: ListenerStatus["state"],
    changes: Partial<ListenerStatus> = {},
  ) => {
    status = {
      ...status,
      ...changes,
      state,
      updatedAt: iso(now),
    };
    persist();
  };

  const prepare = options.prepare;
  const control = await startListenerControlServer({
    paths: options.paths,
    status: () => structuredClone(status),
    stop: () => {
      if (status.state === "stopped" || status.state === "failed") return;
      transition("stopping");
      controller.abort();
    },
    // Selected under starting.lock, after the live-socket rejection and
    // before the socket can answer, before any status/event persistence.
    initialize: prepare
      ? async () => {
        const selected = await prepare(proposedInstanceId);
        if (
          !selected ||
          typeof selected !== "object" ||
          typeof selected.instanceId !== "string" ||
          !UUID_RE.test(selected.instanceId)
        ) {
          throw new Error("listener prepare returned an invalid instance id");
        }
        status = { ...status, instanceId: selected.instanceId };
      }
      : undefined,
  });
  persist();
  log({
    ts: iso(now),
    event: "listener_starting",
    instance_id: status.instanceId,
    pid: process.pid,
  });

  const onEvent = (event: ListenerRuntimeEvent) => {
    if (event.type === "ready") {
      transition("ready", { readyAt: event.ts, lastErrorCode: null });
      log({ ts: event.ts, event: "listener_ready" });
      return;
    }
    if (event.type === "effect") {
      status = {
        ...status,
        lastSignalId: event.signalId,
        lastErrorCode: event.failureCode,
        updatedAt: event.ts,
      };
      persist();
      log({
        ts: event.ts,
        event: "listener_effect",
        signal_id: event.signalId,
        status: event.status,
        failure_code: event.failureCode,
      });
      return;
    }
    if (event.type === "read_retry") {
      log({
        ts: event.ts,
        event: "listener_read_retry",
        attempt: event.attempt,
        delay_ms: event.delayMs,
      });
      return;
    }
    log({
      ts: event.ts,
      event: "listener_malformed_row",
      index: event.index,
    });
  };

  try {
    const stop = await options.run(
      controller.signal,
      onEvent,
      status.instanceId,
    );
    const stoppedAt = iso(now);
    if (stop.reason === "cancelled") {
      transition("stopped", {
        stoppedAt,
        lastErrorCode: null,
      });
      log({ ts: stoppedAt, event: "listener_stopped" });
    } else {
      const code = stop.reason === "credential"
        ? "credential_stopped"
        : safeErrorCode(stop.error);
      transition("failed", {
        stoppedAt,
        lastErrorCode: code,
      });
      log({
        ts: stoppedAt,
        event: "listener_failed",
        failure_code: code,
      });
    }
  } catch (error) {
    const stoppedAt = iso(now);
    const code = safeErrorCode(
      error instanceof Error ? error : new Error(String(error)),
    );
    transition("failed", { stoppedAt, lastErrorCode: code });
    log({
      ts: stoppedAt,
      event: "listener_failed",
      failure_code: code,
    });
  } finally {
    await writes.catch(() => undefined);
    await control.close().catch(() => undefined);
  }
  return status;
}

/**
 * Status that treats a missing lifetime socket as an unclean stopped process,
 * without killing a possibly reused PID.
 */
export async function effectiveListenerStatus(
  paths: ListenerPaths,
): Promise<ListenerStatus | null> {
  try {
    return await queryListenerControl(paths, "status");
  } catch {
    const stored = await readListenerStatus(paths);
    if (
      stored &&
      (stored.state === "starting" ||
        stored.state === "ready" ||
        stored.state === "stopping")
    ) {
      const failed: ListenerStatus = {
        ...stored,
        state: "failed",
        updatedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString(),
        lastErrorCode: "unclean_exit",
      };
      await writeListenerStatus(paths, failed);
      return failed;
    }
    return stored;
  }
}

export async function stopListener(
  paths: ListenerPaths,
): Promise<ListenerStatus | null> {
  try {
    return await queryListenerControl(paths, "stop");
  } catch {
    return await effectiveListenerStatus(paths);
  }
}

export async function waitForListenerReady(
  paths: ListenerPaths,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    expectedPid?: number;
    isProcessAlive?: () => boolean;
  } = {},
): Promise<ListenerStatus> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 100;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let last: ListenerStatus | null = null;
  let processExitObservedAt: number | null = null;
  while (now() < deadline) {
    try {
      last = await queryListenerControl(paths, "status", Math.min(1_000, pollMs));
      if (
        options.expectedPid !== undefined &&
        last.pid !== options.expectedPid
      ) {
        throw new ListenerAlreadyRunningError();
      }
      if (last.state === "ready") return last;
      if (last.state === "failed" || last.state === "stopped") {
        throw new ListenerStartupError(last.lastErrorCode ?? last.state);
      }
    } catch (error) {
      if (
        error instanceof ListenerAlreadyRunningError ||
        error instanceof ListenerStartupError
      ) {
        throw error;
      }
      const stored = await readListenerStatus(paths).catch(() => null);
      if (stored?.state === "failed" || stored?.state === "stopped") {
        throw new ListenerStartupError(
          stored.lastErrorCode ?? stored.state,
        );
      }
      if (options.isProcessAlive && !options.isProcessAlive()) {
        processExitObservedAt ??= now();
        // The child can exit immediately after atomically writing its terminal
        // status. Give that rename a bounded visibility window so the parent
        // reports the actionable failure code instead of a generic process exit.
        if (now() - processExitObservedAt >= 500) {
          throw new ListenerStartupError("process_exit");
        }
      } else {
        processExitObservedAt = null;
      }
    }
    await sleep(pollMs);
  }
  throw new ListenerStartupError(last?.lastErrorCode ?? "ready_timeout");
}
