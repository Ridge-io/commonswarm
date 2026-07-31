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
 * Same-owner asks share one worker session on a private auth+forced-ask home.
 * Cross-owner/unknown asks get a brand-new auth-only home + empty cwd and never
 * enter the worker's context. Provider code never interprets ownership.
 */
export class OpenCodeListenerModel implements ListenerModel {
  private readonly openSession: OpenOpenCodeSession;
  private readonly permissionMode: ListenerPermissionMode;
  private worker: OpenCodeAcpHandle | null = null;
  private workerHome: string | null = null;
  private isolated: OpenCodeAcpHandle | null = null;
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
    this.isolated?.session.cancel();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    const handles = [this.worker, this.isolated].filter(
      (value): value is OpenCodeAcpHandle => value !== null,
    );
    this.worker = null;
    this.isolated = null;
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
      // Fake open paths in pure tests may omit a real auth file.
      allowMissingAuth: this.options.open !== undefined,
    });
    this.workerHome = home;
    return home;
  }

  private async ensureWorker(): Promise<OpenCodeAcpHandle> {
    if (this.closed) throw new Error("listener model is closed");
    if (this.worker) return this.worker;
    this.workerCanary = true;
    const home = await this.ensureWorkerHome();
    const permissionCallback: PermissionCallback = (request) =>
      this.workerCanary || this.permissionMode === "deny"
        ? defaultPermissionCallback(request)
        : allowOnceOrDeny(request);
    const handle = await this.openSession({
      cwd: this.options.cwd,
      permissionCallback,
      isolatedHome: home,
      disposeHomeOnClose: false,
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      clientName: "cswarm-listener",
    });
    try {
      await handle.session.enablePromptsAfterCanary();
      this.workerCanary = false;
      this.worker = handle;
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Fresh auth-only 0700 home + empty 0700 cwd for every cross-owner/unknown turn.
   * Both are removed after the turn; never reuses the worker home or cwd.
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
        allowMissingAuth: this.options.open !== undefined,
      });
      handle = await this.openSession({
        cwd,
        permissionCallback: defaultPermissionCallback,
        isolatedHome: home,
        disposeHomeOnClose: true,
        ...(this.options.executable ? { executable: this.options.executable } : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        clientName: "cswarm-isolated-listener",
      });
      this.isolated = handle;
      await handle.session.enablePromptsAfterCanary();
      return await handle.session.prompt(prompt);
    } finally {
      if (this.isolated === handle) this.isolated = null;
      await handle?.close().catch(() => undefined);
      // Only the exact directories we created are removed.
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      if (home) {
        await rm(home, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
