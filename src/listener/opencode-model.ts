import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openOpenCodeAcpSession,
  prepareOpenCodeIsolatedHome,
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
 * Provider code never interprets ownership.
 *
 * Steady-state `--permissions allow` only selects allow_once *after* the deny
 * canary; the canary itself never proves allow mode.
 */
export class OpenCodeListenerModel implements ListenerModel {
  private readonly openSession: OpenOpenCodeSession;
  private readonly permissionMode: ListenerPermissionMode;
  private worker: OpenCodeAcpHandle | null = null;
  private workerHome: string | null = null;
  /** All in-flight isolated handles (concurrent cross-owner asks). */
  private readonly inFlight = new Set<OpenCodeAcpHandle>();
  private workerCanary = true;
  private closed = false;

  constructor(private readonly options: OpenCodeListenerModelOptions) {
    this.openSession = options.open ?? openOpenCodeAcpSession;
    this.permissionMode = options.permissionMode ?? "deny";
  }

  /** Initialize worker + deny canary before the listener reports ready. */
  async start(): Promise<void> {
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
    this.cancel();
    const handles = [
      this.worker,
      ...this.inFlight,
    ].filter((value): value is OpenCodeAcpHandle => value !== null);
    this.worker = null;
    this.inFlight.clear();
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
    if (this.workerHome) {
      const home = this.workerHome;
      this.workerHome = null;
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async ensureWorkerHome(): Promise<string> {
    if (this.workerHome) return this.workerHome;
    const home = await prepareOpenCodeIsolatedHome({
      env: this.options.env ?? process.env,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.allowMissingAuth === true
        ? { allowMissingAuth: true }
        : {}),
    });
    this.workerHome = home;
    return home;
  }

  private async ensureWorker(): Promise<OpenCodeAcpHandle> {
    if (this.closed) throw new Error("listener model is closed");
    if (this.worker) return this.worker;
    this.workerCanary = true;
    const home = await this.ensureWorkerHome();
    // Canary never runs inside the real repo — empty temp cwd only.
    const canaryCwd = await mkdtemp(join(tmpdir(), "cswarm-opencode-canary-"));
    await chmod(canaryCwd, 0o700);
    const permissionCallback: PermissionCallback = (request) =>
      this.workerCanary || this.permissionMode === "deny"
        ? defaultPermissionCallback(request)
        : allowOnceOrDeny(request);
    let handle: OpenCodeAcpHandle | null = null;
    try {
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
      await handle.session.enablePromptsAfterCanary();
      // Same child: open a work session on the real cwd without re-probing tools there.
      await handle.session.openWorkCwd(this.options.cwd);
      this.workerCanary = false;
      this.worker = handle;
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    } finally {
      await rm(canaryCwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Fresh auth-only 0700 home + empty 0700 cwd for every cross-owner/unknown turn.
   * Tracked in `inFlight` so close/cancel reaches concurrent isolates.
   */
  private async promptIsolated(prompt: string): Promise<ListenerPromptResult> {
    const cwd = await mkdtemp(join(tmpdir(), "cswarm-opencode-cwd-"));
    await chmod(cwd, 0o700);
    let home: string | null = null;
    let handle: OpenCodeAcpHandle | null = null;
    try {
      home = await prepareOpenCodeIsolatedHome({
        env: this.options.env ?? process.env,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.allowMissingAuth === true
          ? { allowMissingAuth: true }
          : {}),
      });
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
      this.inFlight.add(handle);
      await handle.session.enablePromptsAfterCanary();
      return await handle.session.prompt(prompt);
    } finally {
      if (handle) this.inFlight.delete(handle);
      await handle?.close().catch(() => undefined);
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      if (home) {
        await rm(home, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
