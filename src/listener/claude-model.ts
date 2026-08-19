import { randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openClaudeAcpSession,
  type ClaudeAcpHandle,
  type ClaudeAcpOpenOptions,
} from "../host/claude.js";
import { ACP_CANARY_TIMEOUT_MS } from "../host/bounds.js";
import { allowOnceOrDeny, defaultPermissionCallback } from "../host/permission.js";
import {
  AcpChildExitError,
  AcpPermissionCanaryError,
  type PermissionCallback,
  type PermissionDecision,
  type PermissionRequest,
} from "../host/types.js";
import type { SignalRecord } from "../cloud/command-client.js";
import { LISTENER_PROMPT_TIMEOUT_MS } from "./types.js";
import type {
  ListenerModel,
  ListenerPermissionMode,
  ListenerPromptMode,
  ListenerPromptResult,
} from "./types.js";

export type OpenClaudeSession = (
  options: ClaudeAcpOpenOptions,
) => Promise<ClaudeAcpHandle>;

export interface ClaudeListenerModelOptions {
  cwd: string;
  executable?: string;
  permissionMode?: ListenerPermissionMode;
  env?: NodeJS.ProcessEnv;
  open?: OpenClaudeSession;
  /**
   * Per-prompt-turn budget in ms, or a resolver called at each turn start
   * (default LISTENER_PROMPT_TIMEOUT_MS). The listener passes a resolver that
   * renews the credential when due and clamps to what it can still cover.
   */
  promptTimeoutMs?: number | (() => Promise<number>);
  /** Receives the worker's bounded stderr tail on child exit (local log only). */
  onWorkerStderrTail?: (tail: string) => void;
}

class ClaudeListenerClosedDuringOpen extends Error {
  constructor() {
    super("listener model closed while the Claude worker was opening");
    this.name = "ClaudeListenerClosedDuringOpen";
  }
}


/** Claude-backed listener model using one operator-home worker session. */
export class ClaudeListenerModel implements ListenerModel {
  private readonly openSession: OpenClaudeSession;
  private readonly permissionMode: ListenerPermissionMode;
  private worker: ClaudeAcpHandle | null = null;
  private opening: Promise<ClaudeAcpHandle> | null = null;
  private openingController: AbortController | null = null;
  private openingHandle: ClaudeAcpHandle | null = null;
  private workerCanary = true;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: ClaudeListenerModelOptions) {
    this.openSession = options.open ?? openClaudeAcpSession;
    /* DELIBERATELY deny, and deliberately NOT the CLI default. `cswarm listen start` resolves an
     * omitted --permissions to "allow" (D-084, operator direction: low friction by default) and
     * always passes an explicit mode, so this fallback is only reached by a programmatic caller
     * that never stated one. A library caller who did not choose gets the conservative mode; a
     * product user who did not choose gets the one the operator asked for. The divergence was
     * flagged by the cross-family inversion arm on de6ecee2 as a possible oversight — it is
     * recorded here as intent so the next reader does not "align" them. */
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
    const budget = this.options.promptTimeoutMs ?? LISTENER_PROMPT_TIMEOUT_MS;
    const timeoutMs = typeof budget === "number" ? budget : await budget();
    try {
      return await worker.session.prompt(prompt, { timeoutMs });
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
            !(error instanceof ClaudeListenerClosedDuringOpen) &&
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

  private async ensureWorker(): Promise<ClaudeAcpHandle> {
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

  private async openWorker(): Promise<ClaudeAcpHandle> {
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
      ...(this.options.onWorkerStderrTail
        ? { onStderrTail: this.options.onWorkerStderrTail }
        : {}),
        clientName: "cswarm-listener",
      });
      this.openingHandle = handle;
      try {
        if (this.closed) throw new ClaudeListenerClosedDuringOpen();
        await this.enablePromptsAfterClaudeCanary(handle);
        if (this.closed) throw new ClaudeListenerClosedDuringOpen();
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

  /** Force Claude's measured Write permission path without changing worker cwd. */
  private async enablePromptsAfterClaudeCanary(
    handle: ClaudeAcpHandle,
  ): Promise<void> {
    const sentinelPath = join(
      tmpdir(),
      `cswarm-claude-permission-canary-${process.pid}-${randomUUID()}`,
    );
    let sentinelCreated = false;
    try {
      await handle.session.enablePromptsAfterCanary({
        timeoutMs: ACP_CANARY_TIMEOUT_MS,
        probeText:
          `Create the file ${sentinelPath} using the Write tool with content ` +
          "CSWARM_CANARY_NOOP. You must use the Write tool. Do nothing else.",
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
        "Claude bridge wrote the permission canary sentinel before denial",
      );
    }
  }
}
