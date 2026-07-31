import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenCodeHomeOwner,
  openOpenCodeAcpSession,
  prepareOpenCodeIsolatedHome,
  releaseOpenCodeHome,
  type OpenCodeAcpHandle,
  type OpenCodeAcpOpenOptions,
} from "../host/opencode.js";
import { defaultPermissionCallback } from "../host/permission.js";
import {
  AcpChildExitError,
  AcpHostError,
  type PermissionCallback,
  type PermissionDecision,
  type PermissionRequest,
} from "../host/types.js";
import type {
  ListenerModel,
  ListenerPromptMode,
  ListenerPromptResult,
} from "./types.js";
import type { ListenerPermissionMode } from "./grok-model.js";
import type { SignalRecord } from "../cloud/command-client.js";

export type OpenOpenCodeSession = (
  options: OpenCodeAcpOpenOptions,
) => Promise<OpenCodeAcpHandle>;

export interface OpenCodeListenerModelOptions {
  cwd: string;
  executable?: string;
  model?: string;
  permissionMode?: ListenerPermissionMode;
  env?: NodeJS.ProcessEnv;
  open?: OpenOpenCodeSession;
  /**
   * Explicit test-only: allow missing OpenCode auth when preparing homes.
   * Must not be implied by injecting a fake `open`.
   */
  allowMissingAuth?: boolean;
  /** Test-only home preparer (defaults to prepareOpenCodeIsolatedHome). */
  prepareHome?: typeof prepareOpenCodeIsolatedHome;
  /** Test-only bound for waiting on in-progress opens during close (ms). */
  pendingOpenWaitMs?: number;
}

function allowOnceOrDeny(request: PermissionRequest): PermissionDecision {
  const allowOnce = request.options.find((option) => option.kind === "allow_once");
  return allowOnce
    ? { outcome: "selected", optionId: allowOnce.optionId }
    : defaultPermissionCallback(request);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const DEFAULT_PENDING_OPEN_WAIT_MS = 5_000;

type PendingOpen = {
  home: string;
  instanceId: string;
  /** pre-spawn: prepare only; opening: openSession or worker init in flight (child live). */
  phase: "pre-spawn" | "opening";
  openPromise: Promise<OpenCodeAcpHandle> | null;
  settlePromise: Promise<void>;
  markSettled: (err?: unknown) => void;
  handle?: OpenCodeAcpHandle | null;
  timer?: NodeJS.Timeout;
  closedByOpenPath?: boolean;
};

/**
 * OpenCode-backed listener model.
 *
 * Homes are never deleted while an openSession or worker initialization may have spawned a child.
 * close/cancel waits (bounded) for pending opens to settle via single-owner
 * open path cleanup, then verifies handle.close before release. Unsettled opens
 * or failed closes retain the exact home and propagate child_exit_timeout.
 */
export class OpenCodeListenerModel implements ListenerModel {
  private readonly openSession: OpenOpenCodeSession;
  private readonly prepareHome: typeof prepareOpenCodeIsolatedHome;
  private readonly permissionMode: ListenerPermissionMode;
  private readonly pendingOpenWaitMs: number;
  private readonly instanceId = randomUUID();
  private worker: OpenCodeAcpHandle | null = null;
  private workerHome: string | null = null;
  /** Worker/isolate homes retained after failed close or unsettled open. */
  private retainedHomes: string[] = [];
  private readonly inFlight = new Set<OpenCodeAcpHandle>();
  /** In-progress prepare/open keyed by home path. */
  private readonly pendingOpens = new Map<string, PendingOpen>();
  private openGeneration = 0;
  private workerCanary = true;
  private closed = false;
  private cancelled = false;
  private exitCleanupInstalled = false;

  constructor(private readonly options: OpenCodeListenerModelOptions) {
    this.openSession = options.open ?? openOpenCodeAcpSession;
    this.prepareHome = options.prepareHome ?? prepareOpenCodeIsolatedHome;
    this.permissionMode = options.permissionMode ?? "deny";
    this.pendingOpenWaitMs = options.pendingOpenWaitMs ?? DEFAULT_PENDING_OPEN_WAIT_MS;
  }

  getRetainedHomes(): readonly string[] {
    return this.retainedHomes;
  }

  async start(): Promise<void> {
    this.installExitCleanup();
    await this.ensureWorker();
  }

  async prompt(
    _signal: SignalRecord,
    mode: ListenerPromptMode,
    prompt: string,
  ): Promise<ListenerPromptResult> {
    if (this.closed) throw new Error("listener model is closed");
    if (mode === "isolated") return await this.promptIsolated(prompt);
    const worker = await this.ensureWorker();
    try {
      return await worker.session.prompt(prompt);
    } catch (error) {
      if (error instanceof AcpChildExitError) {
        try {
          await worker.close();
          if (this.worker === worker) {
            this.worker = null;
            await this.releaseWorkerHomeIfOwned();
          }
        } catch (closeError) {
          if (this.worker === worker) this.worker = null;
          throw closeError;
        }
      }
      throw error;
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.openGeneration += 1;
    this.worker?.session.cancel();
    for (const handle of this.inFlight) {
      try {
        handle.session.cancel();
      } catch {
        // best-effort
      }
    }
    for (const pending of this.pendingOpens.values()) {
      try {
        pending.handle?.session.cancel();
      } catch {
        // best-effort
      }
    }
  }

  private closePromise: Promise<void> | null = null;

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    this.closed = true;
    this.removeExitCleanup();
    this.cancel();

    const failures: Error[] = [];

    // 1) Settle every in-progress open (child may already be live).
    const pending = [...this.pendingOpens.values()];
    for (const entry of pending) {
      try {
        await this.settlePendingOpen(entry);
      } catch (error) {
        failures.push(asError(error));
      }
    }
    this.pendingOpens.clear();

    // 2) Close known handles; release homes only after verified close.
    const worker = this.worker;
    const workerHome = this.workerHome;
    const isolates = [...this.inFlight];
    this.worker = null;
    this.inFlight.clear();

    if (worker) {
      try {
        await worker.close();
        if (workerHome) {
          this.workerHome = null;
          await releaseOpenCodeHome(workerHome, this.instanceId).catch(() => undefined);
        }
      } catch (error) {
        failures.push(asError(error));
        if (workerHome) {
          this.retainedHomes.push(workerHome);
          this.workerHome = null;
        }
      }
    } else if (workerHome) {
      // No handle (prepare-only race already settled above); drop field.
      this.workerHome = null;
    }

    for (const handle of isolates) {
      try {
        await handle.close();
      } catch (error) {
        failures.push(asError(error));
        // Isolate home retained by host open path when terminate fails.
      }
    }

    if (failures.length > 0) {
      const first = failures[0]!;
      if (failures.length === 1) throw first;
      throw new AcpHostError(
        first instanceof AcpHostError ? first.code : "close_failed",
        `listener model close failed (${failures.length}): ${first.message}`,
      );
    }
  }

  /**
   * Wait for a pending open to settle via the open path's single-owner cleanup.
   */
  private async settlePendingOpen(entry: PendingOpen): Promise<void> {
    if (entry.phase === "pre-spawn" || !entry.openPromise) {
      this.pendingOpens.delete(entry.home);
      if (entry.home === this.workerHome) this.workerHome = null;
      await releaseOpenCodeHome(entry.home, entry.instanceId);
      entry.markSettled();
      return;
    }

    let timedOut = false;
    let errResult: unknown = null;
    try {
      await Promise.race([
        entry.settlePromise,
        new Promise<void>((resolve) => {
          entry.timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, this.pendingOpenWaitMs);
        }),
      ]);
    } catch (e) {
      errResult = e;
    }

    if (entry.timer) clearTimeout(entry.timer);
    this.pendingOpens.delete(entry.home);

    if (errResult) {
      if (entry.home === this.workerHome) this.workerHome = null;
      throw asError(errResult);
    }

    if (timedOut) {
      if (entry.home === this.workerHome) this.workerHome = null;
      this.retainedHomes.push(entry.home);
      throw new AcpHostError(
        "pending_open_timeout",
        "OpenCode openSession did not settle during close; retaining home",
      );
    }
  }

  private async performSingleOwnerCleanup(
    handle: OpenCodeAcpHandle,
    home: string,
    instanceId: string,
    pending: PendingOpen,
    disposeHomeOnClose: boolean,
  ): Promise<void> {
    if (pending.closedByOpenPath) return;
    pending.closedByOpenPath = true;
    this.pendingOpens.delete(home);
    if (pending.timer) clearTimeout(pending.timer);

    let closeErr: unknown = null;
    try {
      await handle.close();
      if (this.workerHome === home) this.workerHome = null;
      await releaseOpenCodeHome(home, instanceId).catch(() => undefined);
    } catch (e) {
      if (this.workerHome === home) this.workerHome = null;
      this.retainedHomes.push(home);
      closeErr = e;
    }

    if (closeErr) {
      pending.markSettled(closeErr);
      throw closeErr;
    }

    pending.markSettled();
    throw new AcpHostError("cancelled_during_open", "listener model cancelled during open");
  }

  private async releaseWorkerHomeIfOwned(): Promise<void> {
    const home = this.workerHome;
    this.workerHome = null;
    if (!home) return;
    await releaseOpenCodeHome(home, this.instanceId);
  }

  private async abandonWorkerHome(): Promise<void> {
    const home = this.workerHome;
    this.workerHome = null;
    if (!home) return;
    this.pendingOpens.delete(home);
    await releaseOpenCodeHome(home, this.instanceId);
  }

  private assertOpen(generation: number): void {
    if (this.closed || this.cancelled || generation !== this.openGeneration) {
      throw new Error("listener model cancelled during open");
    }
  }

  private installExitCleanup(): void {
    if (this.exitCleanupInstalled) return;
    this.exitCleanupInstalled = true;
    process.on("SIGTERM", this.onProcessSignal);
    process.on("SIGINT", this.onProcessSignal);
  }

  private removeExitCleanup(): void {
    if (!this.exitCleanupInstalled) return;
    this.exitCleanupInstalled = false;
    process.off("SIGTERM", this.onProcessSignal);
    process.off("SIGINT", this.onProcessSignal);
  }

  private readonly onProcessSignal = (): void => {
    void this.close().catch(() => undefined);
  };

  private async ensureWorkerHome(generation: number): Promise<{ home: string; pending: PendingOpen }> {
    if (this.workerHome) {
      const existing = this.pendingOpens.get(this.workerHome);
      if (existing) return { home: this.workerHome, pending: existing };
    }
    const owner = buildOpenCodeHomeOwner({
      role: "worker",
      instanceId: this.instanceId,
      pid: process.pid,
    });
    const home = await this.prepareHome({
      env: this.options.env ?? process.env,
      owner,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.allowMissingAuth === true
        ? { allowMissingAuth: true }
        : {}),
    });
    this.workerHome = home;
    let markSettled!: (err?: unknown) => void;
    const settlePromise = new Promise<void>((resolve, reject) => {
      markSettled = (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      };
    });
    void settlePromise.catch(() => undefined);
    const pending: PendingOpen = {
      home,
      instanceId: this.instanceId,
      phase: "pre-spawn",
      openPromise: null,
      settlePromise,
      markSettled,
    };
    this.pendingOpens.set(home, pending);
    try {
      this.assertOpen(generation);
    } catch (error) {
      this.workerHome = null;
      this.pendingOpens.delete(home);
      await releaseOpenCodeHome(home, this.instanceId);
      pending.markSettled();
      throw error;
    }
    return { home, pending };
  }

  private async ensureWorker(): Promise<OpenCodeAcpHandle> {
    if (this.closed || this.cancelled) {
      throw new Error("listener model is closed");
    }
    if (this.worker) return this.worker;
    const generation = this.openGeneration;
    this.workerCanary = true;
    const canaryCwd = await mkdtemp(join(tmpdir(), "cswarm-opencode-canary-"));
    await chmod(canaryCwd, 0o700);
    const permissionCallback: PermissionCallback = (request) =>
      this.workerCanary || this.permissionMode === "deny"
        ? defaultPermissionCallback(request)
        : allowOnceOrDeny(request);
    let handle: OpenCodeAcpHandle | null = null;
    let home: string | null = null;
    let pending: PendingOpen | null = null;
    try {
      const homeRes = await this.ensureWorkerHome(generation);
      home = homeRes.home;
      pending = homeRes.pending;
      this.assertOpen(generation);
      const openPromise = this.openSession({
        cwd: canaryCwd,
        permissionCallback,
        isolatedHome: home,
        disposeHomeOnClose: false,
        ...(this.options.executable ? { executable: this.options.executable } : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        ...(this.options.allowMissingAuth === true
          ? { allowMissingAuth: true }
          : {}),
        clientName: "cswarm-listener",
      });
      pending.phase = "opening";
      pending.openPromise = openPromise;
      void openPromise.catch(() => undefined);

      try {
        handle = await openPromise;
        pending.handle = handle;
      } catch (openError) {
        this.pendingOpens.delete(home);
        if (this.workerHome === home) this.workerHome = null;
        if (openError instanceof AcpChildExitError || (openError as any)?.code === "child_exit_timeout") {
          this.retainedHomes.push(home);
        } else {
          await releaseOpenCodeHome(home, this.instanceId).catch(() => undefined);
        }
        pending.markSettled(openError);
        throw openError;
      }

      if (this.closed || this.cancelled || generation !== this.openGeneration) {
        await this.performSingleOwnerCleanup(handle, home, this.instanceId, pending, false);
      }

      await handle.session.enablePromptsAfterCanary();
      if (this.closed || this.cancelled || generation !== this.openGeneration) {
        await this.performSingleOwnerCleanup(handle, home, this.instanceId, pending, false);
      }

      await handle.session.openWorkCwd(this.options.cwd);
      if (this.closed || this.cancelled || generation !== this.openGeneration) {
        await this.performSingleOwnerCleanup(handle, home, this.instanceId, pending, false);
      }

      this.pendingOpens.delete(home);
      pending.markSettled();
      this.workerCanary = false;
      this.worker = handle;
      return handle;
    } catch (error) {
      if (handle && pending && !pending.closedByOpenPath) {
        await this.performSingleOwnerCleanup(handle, home!, this.instanceId, pending, false).catch(() => undefined);
      }
      if (pending && this.pendingOpens.has(home!)) {
        this.pendingOpens.delete(home!);
        if (this.workerHome === home) this.workerHome = null;
        pending.markSettled(error);
      }
      throw error;
    } finally {
      await rm(canaryCwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async promptIsolated(prompt: string): Promise<ListenerPromptResult> {
    if (this.closed) throw new Error("listener model is closed");
    const generation = this.openGeneration;
    const cwd = await mkdtemp(join(tmpdir(), "cswarm-opencode-cwd-"));
    await chmod(cwd, 0o700);
    const isolatedInstanceId = randomUUID();
    let home: string | null = null;
    let handle: OpenCodeAcpHandle | null = null;
    let pending: PendingOpen | null = null;
    try {
      home = await this.prepareHome({
        env: this.options.env ?? process.env,
        owner: buildOpenCodeHomeOwner({
          role: "isolated",
          instanceId: isolatedInstanceId,
          pid: process.pid,
        }),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.allowMissingAuth === true
          ? { allowMissingAuth: true }
          : {}),
      });
      let markSettled!: (err?: unknown) => void;
      const settlePromise = new Promise<void>((resolve, reject) => {
        markSettled = (err?: unknown) => {
          if (err) reject(err);
          else resolve();
        };
      });
      void settlePromise.catch(() => undefined);
      pending = {
        home,
        instanceId: isolatedInstanceId,
        phase: "pre-spawn",
        openPromise: null,
        settlePromise,
        markSettled,
      };
      this.pendingOpens.set(home, pending);
      try {
        this.assertOpen(generation);
      } catch (error) {
        this.pendingOpens.delete(home);
        await releaseOpenCodeHome(home, isolatedInstanceId);
        pending.markSettled();
        home = null;
        throw error;
      }
      const openPromise = this.openSession({
        cwd,
        permissionCallback: defaultPermissionCallback,
        isolatedHome: home,
        disposeHomeOnClose: true,
        ...(this.options.executable ? { executable: this.options.executable } : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        ...(this.options.allowMissingAuth === true
          ? { allowMissingAuth: true }
          : {}),
        clientName: "cswarm-isolated-listener",
      });
      pending.phase = "opening";
      pending.openPromise = openPromise;
      void openPromise.catch(() => undefined);

      try {
        handle = await openPromise;
        pending.handle = handle;
      } catch (openError) {
        this.pendingOpens.delete(home);
        if (openError instanceof AcpChildExitError || (openError as any)?.code === "child_exit_timeout") {
          this.retainedHomes.push(home);
        } else {
          await releaseOpenCodeHome(home, isolatedInstanceId).catch(() => undefined);
        }
        pending.markSettled(openError);
        home = null;
        throw openError;
      }

      if (this.closed || this.cancelled || generation !== this.openGeneration) {
        await this.performSingleOwnerCleanup(handle, home, isolatedInstanceId, pending, true);
      }

      this.inFlight.add(handle);
      await handle.session.enablePromptsAfterCanary();
      if (this.closed || this.cancelled || generation !== this.openGeneration) {
        await this.performSingleOwnerCleanup(handle, home, isolatedInstanceId, pending, true);
      }

      this.pendingOpens.delete(home);
      pending.markSettled();
      return await handle.session.prompt(prompt);
    } catch (error) {
      if (handle && pending && !pending.closedByOpenPath) {
        await this.performSingleOwnerCleanup(handle, home!, isolatedInstanceId, pending, true).catch(() => undefined);
      }
      if (home && pending && this.pendingOpens.has(home)) {
        const currentHome = home;
        if (pending.phase === "pre-spawn") {
          this.pendingOpens.delete(currentHome);
          await releaseOpenCodeHome(currentHome, isolatedInstanceId).catch(() => undefined);
          pending.markSettled();
          home = null;
        }
      }
      throw error;
    } finally {
      if (handle && this.inFlight.has(handle)) {
        this.inFlight.delete(handle);
        let closeOk = true;
        try {
          await handle.close();
        } catch (closeError) {
          closeOk = false;
          if (home) {
            this.retainedHomes.push(home);
            home = null;
          }
          await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
          throw closeError;
        }
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
        if (home && closeOk) {
          await releaseOpenCodeHome(home, isolatedInstanceId);
        }
      } else {
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
