import { randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCodexAcpSession,
  type CodexAcpHandle,
  type CodexAcpOpenOptions,
} from "../host/codex.js";
import { ACP_CANARY_TIMEOUT_MS } from "../host/bounds.js";
import { defaultPermissionCallback } from "../host/permission.js";
import {
  AcpChildExitError,
  AcpPermissionCanaryError,
  type PermissionCallback,
  type PermissionDecision,
  type PermissionRequest,
} from "../host/types.js";
import type { SignalRecord } from "../cloud/command-client.js";
import type {
  ListenerModel,
  ListenerPermissionMode,
  ListenerPromptMode,
  ListenerPromptResult,
} from "./types.js";

export type OpenCodexSession = (
  options: CodexAcpOpenOptions,
) => Promise<CodexAcpHandle>;

export interface CodexListenerModelOptions {
  cwd: string;
  executable?: string;
  permissionMode?: ListenerPermissionMode;
  env?: NodeJS.ProcessEnv;
  open?: OpenCodexSession;
}

class CodexListenerClosedDuringOpen extends Error {
  constructor() {
    super("listener model closed while the Codex worker was opening");
    this.name = "CodexListenerClosedDuringOpen";
  }
}

function allowOnceOrDeny(request: PermissionRequest): PermissionDecision {
  const allowOnce = request.options.find((option) => option.kind === "allow_once");
  return allowOnce
    ? { outcome: "selected", optionId: allowOnce.optionId }
    : defaultPermissionCallback(request);
}

/** Codex-backed listener model using one operator-home worker session. */
export class CodexListenerModel implements ListenerModel {
  private readonly openSession: OpenCodexSession;
  private readonly permissionMode: ListenerPermissionMode;
  private worker: CodexAcpHandle | null = null;
  private opening: Promise<CodexAcpHandle> | null = null;
  private openingController: AbortController | null = null;
  private openingHandle: CodexAcpHandle | null = null;
  private workerCanary = true;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: CodexListenerModelOptions) {
    this.openSession = options.open ?? openCodexAcpSession;
    this.permissionMode = options.permissionMode ?? "deny";
  }

  /** Initialize the worker and deny canary before reporting ready. */
  async start(): Promise<void> {
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
        try {
          await worker.close();
        } finally {
          if (this.worker === worker) this.worker = null;
        }
      }
      throw error;
    }
  }

  cancel(): void {
    this.worker?.session.cancel();
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.cancel();
    this.closePromise = (async () => {
      const closeFailures: unknown[] = [];
      const opening = this.opening;
      this.openingController?.abort();
      const openingHandle = this.openingHandle;
      if (openingHandle) {
        try {
          openingHandle.session.cancel();
        } catch {
          // The handshake may have closed between the field read and cancel.
        }
        try {
          await openingHandle.close();
        } catch (error) {
          closeFailures.push(error);
        }
      }
      if (opening) {
        try {
          await opening;
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          if (
            !(error instanceof CodexListenerClosedDuringOpen) &&
            code !== "cancelled" &&
            !openingHandle
          ) {
            throw error;
          }
        }
      }
      const handle = this.worker;
      this.worker = null;
      if (handle && handle !== openingHandle) {
        try {
          await handle.close();
        } catch (error) {
          closeFailures.push(error);
        }
      }
      if (closeFailures.length > 0) throw closeFailures[0];
    })();
    return this.closePromise;
  }

  private async ensureWorker(): Promise<CodexAcpHandle> {
    if (this.closed) throw new Error("listener model is closed");
    if (this.worker) return this.worker;
    if (this.opening) return this.opening;
    const opening = this.openWorker();
    this.opening = opening;
    try {
      return await opening;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  private async openWorker(): Promise<CodexAcpHandle> {
    const controller = new AbortController();
    this.openingController = controller;
    this.workerCanary = true;
    const permissionCallback: PermissionCallback = (request) =>
      this.workerCanary || this.permissionMode === "deny"
        ? defaultPermissionCallback(request)
        : allowOnceOrDeny(request);
    try {
      const handle = await this.openSession({
        cwd: this.options.cwd,
        permissionCallback,
        ...(this.options.executable ? { executable: this.options.executable } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        signal: controller.signal,
        clientName: "cswarm-listener",
      });
      this.openingHandle = handle;
      try {
        if (this.closed) throw new CodexListenerClosedDuringOpen();
        await this.enablePromptsAfterCodexCanary(handle);
        if (this.closed) throw new CodexListenerClosedDuringOpen();
        this.workerCanary = false;
        this.worker = handle;
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      } finally {
        if (this.openingHandle === handle) this.openingHandle = null;
      }
    } finally {
      if (this.openingController === controller) this.openingController = null;
    }
  }

  /** Force Codex's measured shell permission path without changing worker cwd. */
  private async enablePromptsAfterCodexCanary(
    handle: CodexAcpHandle,
  ): Promise<void> {
    const sentinelPath = join(
      tmpdir(),
      `cswarm-codex-permission-canary-${process.pid}-${randomUUID()}`,
    );
    let sentinelCreated = false;
    try {
      await handle.session.enablePromptsAfterCanary({
        timeoutMs: ACP_CANARY_TIMEOUT_MS,
        probeText:
          `Use a shell command to create ${sentinelPath} with content ` +
          "CSWARM_CANARY_NOOP. You must use the shell. Do nothing else.",
      });
    } finally {
      try {
        await lstat(sentinelPath);
        sentinelCreated = true;
        await unlink(sentinelPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (sentinelCreated) {
      throw new AcpPermissionCanaryError(
        "Codex bridge wrote the permission canary sentinel before denial",
      );
    }
  }
}
