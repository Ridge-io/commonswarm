import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  openCodexAcpSession,
  type CodexAcpHandle,
  type CodexAcpOpenOptions,
} from "../host/codex.js";
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
import {
  LISTENER_PROMPT_TIMEOUT_MS,
  resolveBudgetAndPrompt,
} from "./types.js";
import type {
  ListenerCanaryAttemptCallback,
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
  /**
   * Per-prompt-turn budget in ms, or a resolver called at each turn start
   * (default LISTENER_PROMPT_TIMEOUT_MS). The listener passes a resolver that
   * renews the credential when due and clamps to what it can still cover.
   */
  promptTimeoutMs?: number | (() => Promise<number>);
  /** Receives the worker's bounded stderr tail on child exit (local log only). */
  onWorkerStderrTail?: (tail: string) => void;
  /** Receives each bounded permission-canary verdict for local diagnostics. */
  onCanaryAttempt?: ListenerCanaryAttemptCallback;
  /** Receives the admitted bridge version for durable startup status. */
  onVersionNotice?: NonNullable<CodexAcpOpenOptions["onVersionNotice"]>;
}

class CodexListenerClosedDuringOpen extends Error {
  constructor() {
    super("listener model closed while the Codex worker was opening");
    this.name = "CodexListenerClosedDuringOpen";
  }
}

function pathIsInsideOrEqual(ancestor: string, candidate: string): boolean {
  const fromAncestor = relative(ancestor, candidate);
  return fromAncestor === "" ||
    (fromAncestor !== ".." &&
      !fromAncestor.startsWith(`..${sep}`) &&
      !isAbsolute(fromAncestor));
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
    // Respawn a dead worker FIRST; the budget gate runs AFTER, inside
    // resolveBudgetAndPrompt, so it resolves-or-defers against the credential
    // live at turn start rather than before a slow respawn. A deferral throws
    // before session.prompt, so no turn begins on a credential that cannot
    // outlast it.
    const worker = await this.ensureWorker();
    const budget = this.options.promptTimeoutMs ?? LISTENER_PROMPT_TIMEOUT_MS;
    try {
      return await resolveBudgetAndPrompt(worker.session, prompt, budget);
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
        ...(this.options.onVersionNotice
          ? { onVersionNotice: this.options.onVersionNotice }
          : {}),
        signal: controller.signal,
      ...(this.options.onWorkerStderrTail
        ? { onStderrTail: this.options.onWorkerStderrTail }
        : {}),
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
    const configuredHome = this.options.env?.HOME;
    const home = configuredHome && isAbsolute(configuredHome)
      ? configuredHome
      : homedir();
    const sentinelDirectory = join(home, ".cswarm", "canary");
    await mkdir(sentinelDirectory, { recursive: true, mode: 0o700 });
    await chmod(sentinelDirectory, 0o700);
    const [workerCwd, canaryDirectory] = await Promise.all([
      realpath(this.options.cwd),
      realpath(sentinelDirectory),
    ]);
    if (pathIsInsideOrEqual(workerCwd, canaryDirectory)) {
      throw new AcpPermissionCanaryError(
        `canary_path_inside_cwd: ${canaryDirectory} is inside listener cwd ${workerCwd}. ` +
          "Next: pass a --cwd that is not your home directory",
      );
    }
    const sentinelPath = join(
      canaryDirectory,
      `cswarm-codex-permission-canary-${process.pid}-${randomUUID()}`,
    );
    let canaryError: unknown;
    let sentinelCreated = false;
    try {
      await handle.session.enablePromptsAfterCanary({
        timeoutMs: ACP_CANARY_TIMEOUT_MS,
        probeText:
          `Use a shell command to create ${sentinelPath} with content ` +
          "CSWARM_CANARY_NOOP. You must use the shell. Do nothing else.",
        ...(this.options.onCanaryAttempt
          ? { onAttempt: this.options.onCanaryAttempt }
          : {}),
      });
    } catch (error) {
      canaryError = error;
    } finally {
      try {
        await lstat(sentinelPath);
        sentinelCreated = true;
        await unlink(sentinelPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const observation = handle.session.canaryObservation;
    const sawPermissionRequest = observation?.sawPermissionRequest === true;
    const bridgeVersion = handle.providerVersion ??
      handle.session.info?.agentVersion ?? "unknown";
    if (sentinelCreated && !sawPermissionRequest) {
      throw new AcpPermissionCanaryError(
        `canary_executed_without_permission: codex-acp ${bridgeVersion} ran the shell probe ` +
          `without a permission request and wrote ${sentinelPath}. ` +
          `Next: replace codex-acp ${bridgeVersion} with a bridge version that asks before writing ${sentinelPath}`,
      );
    }
    if (sentinelCreated) {
      throw new AcpPermissionCanaryError(
        `canary_write_not_blocked: codex-acp ${bridgeVersion} wrote ${sentinelPath} even though ` +
          "the host rejected the canary. Next: update or reinstall the codex-acp bridge",
      );
    }
    if (canaryError instanceof AcpPermissionCanaryError) {
      if (canaryError.reasonCode === "timeout") {
        throw new AcpPermissionCanaryError(
          `canary_timeout: ${canaryError.message}. ` +
            "Next: retry to run a fresh bounded permission canary",
          "timeout",
        );
      }
      if (canaryError.reasonCode !== null) {
        throw new AcpPermissionCanaryError(
          `canary_bridge_error: codex-acp ${bridgeVersion} returned ${canaryError.message}. ` +
            "Next: resolve the quoted bridge error, then retry",
          canaryError.reasonCode,
        );
      }
      if (!sawPermissionRequest) {
        throw new AcpPermissionCanaryError(
          `canary_no_tool_call: codex-acp ${bridgeVersion} did not request permission or create ` +
            `${sentinelPath}. Next: retry to re-sample the model's shell choice`,
        );
      }
    }
    if (canaryError !== undefined) throw canaryError;
  }
}
