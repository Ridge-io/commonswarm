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
}

function allowOnceOrDeny(request: PermissionRequest): PermissionDecision {
  const allowOnce = request.options.find((option) => option.kind === "allow_once");
  return allowOnce
    ? { outcome: "selected", optionId: allowOnce.optionId }
    : defaultPermissionCallback(request);
}

/**
 * OpenCode-backed listener model.
 *
 * Same-owner asks share one worker session. The deny canary always runs on a
 * fresh empty temp cwd (never the user repo), then the same child opens a work
 * session on the real cwd. Cross-owner/unknown turns get a brand-new auth-only
 * home + empty cwd and are tracked in an in-flight set until closed.
 *
 * close/cancel also covers home-preparation and openSession races via a
 * generation counter and preparing-homes set — not only already-open workers.
 */
export class OpenCodeListenerModel implements ListenerModel {
  private readonly openSession: OpenOpenCodeSession;
  private readonly permissionMode: ListenerPermissionMode;
  private readonly instanceId = randomUUID();
  private worker: OpenCodeAcpHandle | null = null;
  private workerHome: string | null = null;
  /** All in-flight isolated handles (concurrent cross-owner asks). */
  private readonly inFlight = new Set<OpenCodeAcpHandle>();
  /** Homes being prepared that are not yet bound to a handle. */
  private readonly preparingHomes = new Map<string, string>();
  private openGeneration = 0;
  private workerCanary = true;
  private closed = false;
  private cancelled = false;
  private exitCleanupInstalled = false;

  constructor(private readonly options: OpenCodeListenerModelOptions) {
    this.openSession = options.open ?? openOpenCodeAcpSession;
    this.permissionMode = options.permissionMode ?? "deny";
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
        await worker.close().catch(() => undefined);
        if (this.worker === worker) this.worker = null;
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
    // cancel() bumps generation and cancels open + in-flight sessions.
    this.cancel();
    const handles = [
      this.worker,
      ...this.inFlight,
    ].filter((value): value is OpenCodeAcpHandle => value !== null);
    this.worker = null;
    this.inFlight.clear();
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
    // Release homes still mid-prepare (openSession/home race).
    const preparing = [...this.preparingHomes.entries()];
    this.preparingHomes.clear();
    await Promise.all(
      preparing.map(([home, instanceId]) =>
        releaseOpenCodeHome(home, instanceId).catch(() => undefined)
      ),
    );
    await this.abandonWorkerHome();
  }

  /** Drop workerHome synchronously on failure so auth copies never strand. */
  private async abandonWorkerHome(): Promise<void> {
    const home = this.workerHome;
    this.workerHome = null;
    if (!home) return;
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
    const home = await prepareOpenCodeIsolatedHome({
      env: this.options.env ?? process.env,
      owner,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.allowMissingAuth === true
        ? { allowMissingAuth: true }
        : {}),
    });
    this.assertOpen(generation);
    this.workerHome = home;
    this.preparingHomes.set(home, this.instanceId);
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
      await handle?.close().catch(() => undefined);
      await this.abandonWorkerHome();
      if (home) this.preparingHomes.delete(home);
      throw error;
    } finally {
      await rm(canaryCwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Fresh auth-only 0700 home + empty 0700 cwd for every cross-owner/unknown turn.
   * Tracked in `inFlight` so close/cancel reaches concurrent isolates and
   * mid-prepare homes.
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
      home = await prepareOpenCodeIsolatedHome({
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
      this.preparingHomes.set(home, isolatedInstanceId);
      this.assertOpen(generation);
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
      await handle?.close().catch(() => undefined);
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      if (home) {
        await releaseOpenCodeHome(home, isolatedInstanceId);
      }
    }
  }
}
