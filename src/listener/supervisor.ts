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
import { isRestartableListenerStop } from "./runtime.js";
import type {
  ListenerRuntimeEvent,
  ListenerRuntimeStop,
} from "./runtime.js";

import type { ListenerPermissionMode } from "./types.js";
import type { ListenerRouteMode } from "./main-routing.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Attempts before a repeatedly-failing listener is left down and diagnosable. */
export const LISTENER_RESTART_MAX_ATTEMPTS = 5;
/** First restart delay. */
export const LISTENER_RESTART_INITIAL_MS = 1_000;
/** Ceiling on the restart delay; wider than the read backoff cap on purpose. */
export const LISTENER_RESTART_MAX_MS = 60_000;

/**
 * Bounded restart policy. Bounded is the load-bearing word: an unbounded
 * restart would recreate the amplification D-051 removed, one process at a
 * time instead of one request at a time.
 */
export interface ListenerRestartPolicy {
  maxAttempts?: number;
  initialMs?: number;
  maxMs?: number;
  isRestartable?: (stop: ListenerRuntimeStop) => boolean;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** Full-jitter exponential restart delay; attempt is 1-based. */
export function nextListenerRestartMs(
  attempt: number,
  policy: ListenerRestartPolicy = {},
  random: () => number = Math.random,
): number {
  const initial = policy.initialMs ?? LISTENER_RESTART_INITIAL_MS;
  const max = policy.maxMs ?? LISTENER_RESTART_MAX_MS;
  const safeAttempt = Math.max(1, Math.min(attempt, 16));
  const exp = Math.min(max, initial * (2 ** (safeAttempt - 1)));
  return Math.floor(exp * (0.5 + random() * 0.5));
}

async function defaultRestartSleep(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export interface ListenerSupervisorOptions {
  paths: ListenerPaths;
  profileId: string;
  workspaceId: string;
  principalId: string;
  /** Host adapter id recorded in status metadata only. Default: grok. */
  provider?: ListenerProviderId;
  permissionMode?: ListenerPermissionMode;
  routeMode?: ListenerRouteMode;
  deferOverChars?: number | null;
  now?: () => number;
  /**
   * Runs under starting.lock after the live-socket rejection check, before
   * the socket can answer. Receives the one proposed UUID and selects the
   * durable instance UUID (e.g. by opening the delivery journal).
   */
  prepare?: (proposedInstanceId: string) => Promise<{ instanceId: string }>;
  /**
   * Called once per attempt, so it MUST construct its own per-attempt
   * resources. A listener model is single-use — runListenerRuntime closes it
   * in a finally on every exit, and every adapter refuses to start once
   * closed — so a captured model would make the second attempt fail
   * immediately with "listener model is closed".
   */
  run: (
    signal: AbortSignal,
    onEvent: (event: ListenerRuntimeEvent) => void,
    listenerInstanceId: string,
  ) => Promise<ListenerRuntimeStop>;
  /** Bounded restart for possibly-transient stops. Default: the constants above. */
  restart?: ListenerRestartPolicy;
  /**
   * Read-and-clear accessor for the newest worker stderr tail. The supervisor
   * is its only consumer and writes it only to the operator's own 0600 log
   * and status file — never to a server payload or an error object (D-090
   * family: a crash-looping worker whose every failure event read a bare
   * "error" was undiagnosable from the failing box's own log).
   */
  takeWorkerStderrTail?: () => string | null;
  /** Read the allowed newer-version notice after the permission canary passes. */
  getProviderVersionNotice?: () => {
    runningVersion: string;
    lastMeasuredVersion: string;
  } | null;
  /**
   * The turn budget in ms to record on a timeout-class effect event. Returns
   * the budget ACTUALLY applied to the last turn (clamped to the credential's
   * lifetime), so the reader sees the bound that was hit rather than the
   * configured cap. Returns null when no turn has run yet.
   */
  getTurnBudgetMs?: () => number | null;
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

/** Keep provider messages local, bounded, and free of credential-shaped text. */
function localDiagnostic(message: string, maxChars: number): string | null {
  const redacted = message.replace(
    /swm_(?:agt|inv|cap)_[^\s"'\\]*/gi,
    "[redacted]",
  ).trim();
  if (redacted.length === 0) return null;
  return redacted.slice(0, maxChars);
}

function safeErrorDetail(error: Error): string | null {
  return localDiagnostic(error.message, 2_048);
}

/**
 * events.ndjson lines are capped at 4096 bytes (appendListenerEvent), and the
 * validator also caps the tail at 2048 characters. Both bounds are enforced
 * against the SERIALIZED form: JSON escaping doubles backslashes and quotes
 * and can sextuple control remnants (\uXXXX), so a raw-byte budget can pass
 * here and still push the line over the cap — where the throw is swallowed by
 * the write chain and the one failure line the tail exists to enrich is
 * silently dropped. Keep the END of the tail: the last lines of a crash log
 * are the part that names the cause. 3000 bytes serialized leaves the event's
 * other fields ample headroom under 4096.
 */
const TAIL_SERIALIZED_BUDGET_BYTES = 3_000;

function fitWorkerStderrTailForLog(tail: string): string {
  let fitted = tail.trim();
  for (;;) {
    if (fitted.length === 0) return fitted;
    const serializedBytes = Buffer.byteLength(JSON.stringify(fitted), "utf8");
    if (
      fitted.length <= 2_048 &&
      serializedBytes <= TAIL_SERIALIZED_BUDGET_BYTES
    ) {
      return fitted;
    }
    // Drop from the front. A char serializes to at least 1 byte, so this
    // always makes progress; /6 undershoots on heavily escaped input and the
    // loop re-measures rather than over-cutting.
    const dropChars = Math.max(
      fitted.length - 2_048,
      Math.ceil((serializedBytes - TAIL_SERIALIZED_BUDGET_BYTES) / 6),
      1,
    );
    fitted = fitted.slice(dropChars);
  }
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
    lastErrorDetail: null,
    providerVersion: null,
    providerLastMeasuredVersion: null,
    lastWorkerStderrTail: null,
    deliveryMode: null,
    pendingDeliveryCount: null,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
    routeMode: options.routeMode ?? "worker",
    deferOverChars: options.deferOverChars ?? null,
    pendingForMainCount: 0,
    droppedForMainCount: 0,
    logPath: options.paths.logPath,
  };
  let writes = Promise.resolve();
  // Each link swallows its own failure. Without this a single rejected write
  // poisons the shared chain, so every LATER status persist and event append
  // is skipped too — the status file freezes mid-lifecycle and the log loses
  // exactly the terminal lines that explain why. Observed while building the
  // restart logging: one disallowed field dropped the listener_failed line.
  const chain = (work: () => Promise<void>) => {
    writes = writes.then(work).catch(() => undefined);
  };
  const persist = () => {
    const snapshot = structuredClone(status);
    chain(() => writeListenerStatus(options.paths, snapshot));
  };
  const log = (event: Record<string, string | number | boolean | null>) => {
    chain(() => appendListenerEvent(options.paths, event));
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

  const takeWorkerStderrTail = options.takeWorkerStderrTail;
  const takeTail = (): string | null => {
    if (!takeWorkerStderrTail) return null;
    const tail = takeWorkerStderrTail();
    if (typeof tail !== "string") return null;
    const fitted = fitWorkerStderrTailForLog(tail);
    return fitted.length > 0 ? fitted : null;
  };

  const onEvent = (event: ListenerRuntimeEvent) => {
    if (event.type === "ready") {
      const versionNotice = options.getProviderVersionNotice?.() ?? null;
      transition("ready", {
        readyAt: event.ts,
        lastErrorCode: null,
        lastErrorDetail: null,
        lastWorkerStderrTail: null,
        providerVersion: versionNotice?.runningVersion ?? null,
        providerLastMeasuredVersion: versionNotice?.lastMeasuredVersion ?? null,
      });
      log({ ts: event.ts, event: "listener_ready" });
      return;
    }
    if (event.type === "canary_attempt") {
      log({
        ts: event.ts,
        event: "listener_canary_attempt",
        attempt: event.attempt,
        total: event.total,
        passed: event.passed,
        reason: event.reason === null
          ? null
          : localDiagnostic(event.reason, 128),
      });
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
        // Code comparison, not message matching (D-053). The budget rides
        // only the timeout class so a reader can see what bound was hit — and
        // it is the CLAMPED budget actually in force, not the configured cap.
        ...((): Record<string, number> => {
          if (event.failureCode !== "acptimeouterror") return {};
          const budget = options.getTurnBudgetMs?.();
          return typeof budget === "number" && budget > 0
            ? { turn_budget_ms: budget }
            : {};
        })(),
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
    if (event.type === "malformed_row") {
      log({
        ts: event.ts,
        event: "listener_malformed_row",
        index: event.index,
      });
      return;
    }
    if (event.type === "model_declared") {
      // Outcome recorded either way: a silent best-effort failure is the
      // D-090 family — information the next diagnosis needs, absent.
      log({
        ts: event.ts,
        event: "listener_model_declared",
        ok: event.ok,
        model: event.model,
      });
      return;
    }
    if (event.type === "delivery_mode") {
      status = {
        ...status,
        deliveryMode: event.mode,
        pendingDeliveryCount: event.pendingDeliveryCount,
        updatedAt: event.ts,
      };
      persist();
      log({
        ts: event.ts,
        event: "listener_delivery_mode",
        delivery_mode: event.mode,
        pending_delivery_count: event.pendingDeliveryCount,
      });
      return;
    }
    if (event.type === "delivery_claim") {
      status = {
        ...status,
        pendingDeliveryCount: event.pendingDeliveryCount,
        lastClaimAt: event.ts,
        updatedAt: event.ts,
      };
      persist();
      log({
        ts: event.ts,
        event: "listener_delivery_claim",
        signal_id: event.signalId,
        pending_delivery_count: event.pendingDeliveryCount,
        terminal_delivery_failure_count: event.terminalDeliveryFailureCount,
      });
      return;
    }
    if (event.type === "delivery_terminal_failures") {
      if (!Number.isSafeInteger(event.count) || event.count <= 0) {
        throw new Error("listener terminal delivery failure count must be positive");
      }
      status = {
        ...status,
        lastTerminalDeliveryFailureCount: event.count,
        lastTerminalDeliveryFailureAt: event.ts,
        updatedAt: event.ts,
      };
      persist();
      log({
        ts: event.ts,
        event: "listener_delivery_terminal_failures",
        terminal_delivery_failure_count: event.count,
      });
      return;
    }
    if (event.type === "delivery_ack") {
      status = {
        ...status,
        lastAckAt: event.ts,
        pendingDeliveryCount: null,
        lastSignalId: event.signalId,
        updatedAt: event.ts,
      };
      persist();
      log({
        ts: event.ts,
        event: "listener_delivery_ack",
        signal_id: event.signalId,
        outcome: event.outcome,
      });
      return;
    }
    if (event.type === "routing_decision") {
      log({
        ts: event.ts,
        event: "listener_routing_decision",
        signal_id: event.signalId,
        route_mode: event.routeMode,
        route_decision: event.decision,
        defer_over_chars: event.threshold,
        body_length: event.bodyLength,
      });
      return;
    }
    if (event.type === "main_queue") {
      status = {
        ...status,
        pendingForMainCount: event.pendingCount,
        droppedForMainCount: event.droppedCount,
        lastSignalId: event.signalId,
        updatedAt: event.ts,
      };
      persist();
      log({
        ts: event.ts,
        event: event.droppedOldest
          ? "listener_main_queue_oldest_dropped"
          : "listener_main_queue",
        signal_id: event.signalId,
        pending_main_count: event.pendingCount,
        dropped_count: event.droppedOldest ? 1 : 0,
      });
      return;
    }
    const unknown = event as unknown as { ts?: unknown };
    log({
      ts: typeof unknown.ts === "string" && Number.isFinite(Date.parse(unknown.ts))
        ? unknown.ts
        : iso(now),
      event: "listener_malformed_event",
    });
  };

  const policy = options.restart ?? {};
  const maxAttempts = policy.maxAttempts ?? LISTENER_RESTART_MAX_ATTEMPTS;
  const isRestartable = policy.isRestartable ?? isRestartableListenerStop;
  const restartSleep = policy.sleep ?? defaultRestartSleep;
  const restartRandom = policy.random ?? Math.random;

  try {
    let restarts = 0;
    let exhausted = false;
    let eligible = false;
    let stop: ListenerRuntimeStop;
    // Each pass is a fresh runtime on the SAME instance id and control socket:
    // prepare() ran once, so the delivery journal keeps its identity across a
    // restart. options.run must build its own per-attempt resources — a
    // listener model is single-use, because runListenerRuntime closes it on
    // every exit.
    for (;;) {
      stop = await options.run(
        controller.signal,
        onEvent,
        status.instanceId,
      );
      if (stop.reason === "cancelled" || controller.signal.aborted) break;
      eligible = isRestartable(stop);
      if (!eligible) break;
      if (restarts >= maxAttempts) {
        exhausted = true;
        break;
      }
      restarts += 1;
      const delayMs = nextListenerRestartMs(restarts, policy, restartRandom);
      const restartCode = safeErrorCode(stop.error);
      const restartStderrTail = takeTail();
      log({
        ts: iso(now),
        event: "listener_restarting",
        attempt: restarts,
        delay_ms: delayMs,
        failure_code: restartCode,
        ...(restartStderrTail !== null
          ? { worker_stderr_tail: restartStderrTail }
          : {}),
      });
      transition("starting", {
        readyAt: null,
        lastErrorCode: restartCode,
        lastErrorDetail: safeErrorDetail(stop.error),
        lastWorkerStderrTail: restartStderrTail,
        providerVersion: null,
        providerLastMeasuredVersion: null,
      });
      await restartSleep(delayMs, controller.signal);
      if (controller.signal.aborted) {
        stop = { reason: "cancelled" };
        break;
      }
    }

    const stoppedAt = iso(now);
    if (stop.reason === "cancelled") {
      transition("stopped", {
        stoppedAt,
        lastErrorCode: null,
        lastErrorDetail: null,
        lastWorkerStderrTail: null,
      });
      log({ ts: stoppedAt, event: "listener_stopped" });
    } else {
      const code = stop.reason === "credential"
        ? "credential_stopped"
        : safeErrorCode(stop.error);
      const failedStderrTail = takeTail();
      transition("failed", {
        stoppedAt,
        lastErrorCode: code,
        lastErrorDetail: safeErrorDetail(stop.error),
        lastWorkerStderrTail: failedStderrTail,
      });
      // Record why it is down and why it stopped trying — a listener left down
      // after exhausting restarts must be distinguishable from one that was
      // never eligible for a restart at all.
      log({
        ts: stoppedAt,
        event: "listener_failed",
        failure_code: code,
        restart_attempts: restarts,
        restartable: eligible,
        restarts_exhausted: exhausted,
        ...(failedStderrTail !== null
          ? { worker_stderr_tail: failedStderrTail }
          : {}),
      });
    }
  } catch (error) {
    const stoppedAt = iso(now);
    const code = safeErrorCode(
      error instanceof Error ? error : new Error(String(error)),
    );
    const failedStderrTail = takeTail();
    transition("failed", {
      stoppedAt,
      lastErrorCode: code,
      lastErrorDetail: safeErrorDetail(
        error instanceof Error ? error : new Error(String(error)),
      ),
      lastWorkerStderrTail: failedStderrTail,
    });
    log({
      ts: stoppedAt,
      event: "listener_failed",
      failure_code: code,
      ...(failedStderrTail !== null
        ? { worker_stderr_tail: failedStderrTail }
        : {}),
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
    /* Epoch ms captured BEFORE the child is spawned. A stored status older than this belongs to
     * an earlier run, whatever pid it carries. D-080: the pid check alone is not sufficient,
     * because pids are recycled and this directory is keyed by config hash, so the one file a
     * retry reads is the one written by the run whose pid could come round again. The floor
     * precedes the spawn, so this instance's own startedAt is always at or after it and its
     * genuine failures are still reported. */
    startedAtFloorMs?: number;
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
      /* D-080: this fallback runs when the LIVE control query fails, which is the normal state
       * for the first moments of a start — the socket is not up yet. It then reads the status
       * FILE, and that file belongs to whatever ran in this directory last.
       *
       * The directory is keyed by config hash, so a retry after a failed start reads the
       * PREVIOUS run's terminal status and reports it as its own. Measured: a start at 23:04:34
       * printed the 22:00 attempt's `permission_canary_failed` and exited, while the listener it
       * had just launched reached ready at 23:04:42 and then served a cross-user wake round trip
       * for 3h35m. It also explains why the diagnostics read backwards — the specific message
       * belonged to the earlier failure, not to the start that printed it.
       *
       * The live branch above already rejects a mismatched pid via ListenerAlreadyRunningError.
       * This one did not check at all, so it is the only path by which a stale terminal status
       * can end a healthy start. */
      const stored = await readListenerStatus(paths).catch(() => null);
      /* Both identifiers must MATCH, never merely be absent. The first version read
       * `expectedPid === undefined || …`, which kept the original unsafe behaviour for any caller
       * that could not supply a pid — a latent copy of the defect, and both review arms flagged
       * it. `listen start` is the only caller in src/ and it supplies both, so requiring them
       * costs nothing here and cannot be reintroduced by a future caller that omits one.
       *
       * Failing this check only means the shortcut is not taken: the wait continues to ready, to
       * process_exit, or to the timeout. It can delay a report; it cannot invent one. */
      const storedIsThisInstance = stored !== null &&
        options.expectedPid !== undefined && stored.pid === options.expectedPid &&
        options.startedAtFloorMs !== undefined &&
        Date.parse(stored.startedAt) >= options.startedAtFloorMs;
      if (
        storedIsThisInstance &&
        (stored.state === "failed" || stored.state === "stopped")
      ) {
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
