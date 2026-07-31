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

/**
 * OpenCode-backed listener model.
 *
 * Close releases each home only after its handle.close() succeeds. A
 * child_exit_timeout (or any close failure) is rethrown and that home is
 * retained on disk for escalation. Preparing homes are registered before
 * cancel checks so a race cannot strand an auth copy as an untracked path.
 */
export class OpenCodeListenerModel implements ListenerModel {
  private readonly openSession: OpenOpenCodeSession;
  private readonly prepareHome: typeof prepareOpenCodeIsolatedHome;
  private readonly permissionMode: ListenerPermissionMode;
  private readonly instanceId = randomUUID();
  private worker: OpenCodeAcpHandle | null = null;
  private workerHome: string | null = null;
  /** Worker home retained after a failed close (not deleted). */
  private retainedHomes: string[] = [];
  /** All in-flight isolated handles (concurrent cross-owner asks). */
  private readonly inFlight = new Set<OpenCodeAcpHandle>();
  /** Homes being prepared that are not yet bound to a successful session. */
  private readonly preparingHomes = new Map<string, string>();
  private openGeneration = 0;
  private workerCanary = true;
  private closed = false;
  private cancelled = false;
  private exitCleanupInstalled = false;

  constructor(private readonly options: OpenCodeListenerModelOptions) {
    this.openSession = options.open ?? openOpenCodeAcpSession;
    this.prepareHome = options.prepareHome ?? prepareOpenCodeIsolatedHome;
    this.permissionMode = options.permissionMode ?? "deny";
  }

  /** Homes retained after a failed close (for tests / operator recovery). */
  getRetainedHomes(): readonly string[] {
    return this.retainedHomes;
  }

  /** Initialize worker + deny canary before the listener reports ready. */
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
          // Retain home; surface the close failure (may be child_exit_timeout).
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
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeExitCleanup();
    this.cancel();

    const worker = this.worker;
    const workerHome = this.workerHome;
    const isolates = [...this.inFlight];
    this.worker = null;
    this.inFlight.clear();

    const failures: Error[] = [];
    let workerCloseOk = true;

    if (worker) {
      try {
        await worker.close();
      } catch (error) {
        workerCloseOk = false;
        failures.push(asError(error));
        if (workerHome) {
          // Retain the precise home for failed terminate/close.
          this.retainedHomes.push(workerHome);
          this.workerHome = null;
        }
      }
    }

    if (workerCloseOk && workerHome) {
      this.workerHome = null;
      await releaseOpenCodeHome(workerHome, this.instanceId).catch(() => undefined);
    }

    for (const handle of isolates) {
      try {
        await handle.close();
      } catch (error) {
        failures.push(asError(error));
        // Isolate homes with disposeHomeOnClose are retained by opencode.ts when
        // terminate fails; we must not force-delete them here.
      }
    }

    // Mid-prepare homes (no live child): safe to release on close.
    const preparing = [...this.preparingHomes.entries()];
    this.preparingHomes.clear();
    await Promise.all(
      preparing.map(([home, instanceId]) =>
        releaseOpenCodeHome(home, instanceId).catch(() => undefined)
      ),
    );

    if (failures.length > 0) {
      const first = failures[0]!;
      if (failures.length === 1) throw first;
      throw new AcpHostError(
        first instanceof AcpHostError ? first.code : "close_failed",
        `listener model close failed (${failures.length}): ${first.message}`,
      );
    }
  }

  private async releaseWorkerHomeIfOwned(): Promise<void> {
    const home = this.workerHome;
    this.workerHome = null;
    if (!home) return;
    await releaseOpenCodeHome(home, this.instanceId);
  }

  /** Drop workerHome on open/canary failure (no child yet, or failed open). */
  private async abandonWorkerHome(): Promise<void> {
    const home = this.workerHome;
    this.workerHome = null;
    if (!home) return;
    this.preparingHomes.delete(home);
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
    void this.close();
  };

  private async ensureWorkerHome(generation: number): Promise<string> {
    if (this.workerHome) return this.workerHome;
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
    // Register before cancel checks so a concurrent cancel cannot strand an
    // untracked auth home (caller would otherwise see home=null).
    this.workerHome = home;
    this.preparingHomes.set(home, this.instanceId);
    try {
      this.assertOpen(generation);
    } catch (error) {
      this.workerHome = null;
      this.preparingHomes.delete(home);
      await releaseOpenCodeHome(home, this.instanceId);
      throw error;
    }
    return home;
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
    try {
      home = await this.ensureWorkerHome(generation);
      this.assertOpen(generation);
      handle = await this.openSession({
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
      this.assertOpen(generation);
      await handle.session.enablePromptsAfterCanary();
      this.assertOpen(generation);
      await handle.session.openWorkCwd(this.options.cwd);
      this.assertOpen(generation);
      this.workerCanary = false;
      this.worker = handle;
      if (home) this.preparingHomes.delete(home);
      return handle;
    } catch (error) {
      // Open/canary failure: drop handle; only abandon home if close is clean.
      if (handle) {
        try {
          await handle.close();
          await this.abandonWorkerHome();
        } catch (closeError) {
          // Retain home after failed close.
          if (home) {
            this.retainedHomes.push(home);
            this.workerHome = null;
            this.preparingHomes.delete(home);
          }
          throw closeError;
        }
      } else {
        await this.abandonWorkerHome();
      }
      if (home) this.preparingHomes.delete(home);
      throw error;
    } finally {
      await rm(canaryCwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Fresh auth-only 0700 home + empty 0700 cwd for every cross-owner/unknown turn.
   */
  private async promptIsolated(prompt: string): Promise<ListenerPromptResult> {
    if (this.closed) throw new Error("listener model is closed");
    const generation = this.openGeneration;
    const cwd = await mkdtemp(join(tmpdir(), "cswarm-opencode-cwd-"));
    await chmod(cwd, 0o700);
    const isolatedInstanceId = randomUUID();
    let home: string | null = null;
    let handle: OpenCodeAcpHandle | null = null;
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
      // Register before assert so cancel cannot strand an untracked home.
      this.preparingHomes.set(home, isolatedInstanceId);
      try {
        this.assertOpen(generation);
      } catch (error) {
        this.preparingHomes.delete(home);
        await releaseOpenCodeHome(home, isolatedInstanceId);
        home = null;
        throw error;
      }
      handle = await this.openSession({
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
      this.assertOpen(generation);
      this.inFlight.add(handle);
      this.preparingHomes.delete(home);
      await handle.session.enablePromptsAfterCanary();
      this.assertOpen(generation);
      return await handle.session.prompt(prompt);
    } catch (error) {
      if (home) this.preparingHomes.delete(home);
      throw error;
    } finally {
      if (handle) this.inFlight.delete(handle);
      let closeOk = true;
      if (handle) {
        try {
          await handle.close();
        } catch (closeError) {
          closeOk = false;
          if (home) {
            this.retainedHomes.push(home);
            home = null; // do not release below
          }
          await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
          throw closeError;
        }
      }
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      if (home && closeOk) {
        await releaseOpenCodeHome(home, isolatedInstanceId);
      }
    }
  }
}
