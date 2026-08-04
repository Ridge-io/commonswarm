import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  openGrokAcpSession,
  type GrokAcpHandle,
  type GrokAcpOpenOptions,
} from "../host/grok.js";
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
  ListenerPermissionMode,
  ListenerPromptMode,
  ListenerPromptResult,
} from "./types.js";
import type { SignalRecord } from "../cloud/command-client.js";

export type { ListenerPermissionMode };
export type OpenGrokSession = (
  options: GrokAcpOpenOptions,
) => Promise<GrokAcpHandle>;

export interface GrokListenerModelOptions {
  cwd: string;
  executable?: string;
  model?: string;
  effort?: string;
  permissionMode?: ListenerPermissionMode;
  env?: NodeJS.ProcessEnv;
  open?: OpenGrokSession;
}

const MAX_GROK_AUTH_BYTES = 256 * 1024;

function allowOnceOrDeny(request: PermissionRequest): PermissionDecision {
  const allowOnce = request.options.find((option) => option.kind === "allow_once");
  return allowOnce
    ? { outcome: "selected", optionId: allowOnce.optionId }
    : defaultPermissionCallback(request);
}

/**
 * Grok-backed listener model.
 *
 * Every ask shares the operator's worker session; provenance in the prompt
 * tells the worker who supplied each message.
 */
export class GrokListenerModel implements ListenerModel {
  private readonly openSession: OpenGrokSession;
  private readonly permissionMode: ListenerPermissionMode;
  private worker: GrokAcpHandle | null = null;
  private workerCanary = true;
  private closed = false;

  constructor(private readonly options: GrokListenerModelOptions) {
    this.openSession = options.open ?? openGrokAcpSession;
    this.permissionMode = options.permissionMode ?? "deny";
  }

  /** Initialize worker + deny canary before the listener reports ready. */
  async start(): Promise<void> {
    await this.validateLocalAuth();
    await this.ensureWorker();
  }

  async prompt(
    _signal: SignalRecord,
    _mode: ListenerPromptMode,
    prompt: string,
  ): Promise<ListenerPromptResult> {
    if (this.closed) throw new Error("listener model is closed");
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
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    const handle = this.worker;
    this.worker = null;
    await handle?.close().catch(() => undefined);
  }

  private async ensureWorker(): Promise<GrokAcpHandle> {
    if (this.closed) throw new Error("listener model is closed");
    if (this.worker) return this.worker;
    this.workerCanary = true;
    const permissionCallback: PermissionCallback = (request) =>
      this.workerCanary || this.permissionMode === "deny"
        ? defaultPermissionCallback(request)
        : allowOnceOrDeny(request);
    const handle = await this.openSession({
      cwd: this.options.cwd,
      permissionCallback,
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
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

  /** Validate the operator's login artifact without copying or replacing its home. */
  private async validateLocalAuth(): Promise<void> {
    if (this.options.open) return;
    const parent = this.options.env ?? process.env;
    const sourceHome = parent.GROK_HOME ??
      join(parent.HOME ?? homedir(), ".grok");
    if (!isAbsolute(sourceHome)) {
      throw new Error("Grok home must be an absolute path");
    }
    const sourceAuth = join(sourceHome, "auth.json");
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(sourceAuth);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new AcpHostError(
        "grok_auth_missing",
        "Grok is not signed in; run grok login before starting the listener",
      );
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new AcpHostError(
        "grok_auth_insecure",
        "Grok auth must be a secure regular file",
      );
    }
    if (
      typeof process.getuid === "function" &&
      (Number(info.uid) !== process.getuid() ||
        (Number(info.mode) & 0o777) !== 0o600)
    ) {
      throw new AcpHostError(
        "grok_auth_insecure",
        "Grok auth must be owned by this user with mode 0600",
      );
    }
    if (Number(info.size) > MAX_GROK_AUTH_BYTES) {
      throw new AcpHostError(
        "grok_auth_too_large",
        "Grok auth file exceeds the listener safety bound",
      );
    }
    const raw = await readFile(sourceAuth);
    if (raw.byteLength > MAX_GROK_AUTH_BYTES) {
      throw new AcpHostError(
        "grok_auth_too_large",
        "Grok auth file exceeds the listener safety bound",
      );
    }
    try {
      JSON.parse(raw.toString("utf8"));
    } catch {
      throw new AcpHostError(
        "grok_auth_malformed",
        "Grok auth file is malformed; run grok login again",
      );
    }
  }
}
