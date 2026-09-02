import { randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openClaudeAcpSession,
  type ClaudeAcpHandle,
  type ClaudeAcpOpenOptions,
  type ClaudeBridgeRuntimeNotice,
} from "../host/claude.js";
import { ACP_CANARY_TIMEOUT_MS } from "../host/bounds.js";
import { allowOnceOrDeny, defaultPermissionCallback } from "../host/permission.js";
import {
  AcpChildExitError,
  AcpPermissionCanaryError,
  type AcpPeerError,
  type HostSessionEvents,
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
  /** Receives each bounded permission-canary verdict for local diagnostics. */
  onCanaryAttempt?: ListenerCanaryAttemptCallback;
  /** Receives one allowed newer-version notice for durable startup status. */
  onVersionNotice?: NonNullable<ClaudeAcpOpenOptions["onVersionNotice"]>;
  /** Receives exact bridge path and bundled package versions before canary. */
  onRuntimeNotice?: (notice: ClaudeBridgeRuntimeNotice) => void;
  /** Structured session updates for the ephemeral live-activity frame. */
  events?: HostSessionEvents;
}

export type ClaudeCanaryFailureCode =
  | "claude_bridge_version_required"
  | "claude_canary_timeout"
  | "claude_canary_auth_failed"
  | "claude_canary_unknown";

export type ClaudeCanaryFailureShape = {
  code: ClaudeCanaryFailureCode;
  minimumRequiredVersion: string | null;
};

const CLAUDE_CODE_VERSION_REQUIRED_RE =
  /\bClaude Code (\d+\.\d+\.\d+) does not support this model; version (\d+\.\d+\.\d+) or newer is required\b/;
const CLAUDE_AUTH_FAILURE_RE =
  /\b(?:authentication failed|failed to authenticate|authentication required|not authenticated|OAuth (?:sign-in|login|token)|OAuth session (?:expired|could not be refreshed)|keychain\/OAuth|please (?:log|sign) in)\b/i;
const CLAUDE_CANARY_TIMEOUT_RE =
  /^ACP request timed out: session\/prompt(?: \(failed \d+ attempts\))?$/;

/** Assign a stable local reason at the Claude provider boundary. */
export function classifyClaudeCanaryFailure(
  detail: string | null | undefined,
  typedReasonCode?: string | null,
  peerError?: AcpPeerError | null,
): ClaudeCanaryFailureShape {
  const recorded = detail?.trim() ?? "";
  const peerData = peerError?.data;
  const peerErrorKind = peerData && typeof peerData === "object" &&
      !Array.isArray(peerData)
    ? (peerData as Record<string, unknown>).errorKind
    : undefined;
  if (
    typedReasonCode === "claude_canary_auth_failed" ||
    ((typedReasonCode === "rpc_error" || typedReasonCode === null ||
      typedReasonCode === undefined) &&
      (peerError?.code === -32000 || peerErrorKind === "authentication_failed"))
  ) {
    return { code: "claude_canary_auth_failed", minimumRequiredVersion: null };
  }
  const demanded = CLAUDE_CODE_VERSION_REQUIRED_RE.exec(recorded);
  if (demanded?.[2]) {
    return {
      code: "claude_bridge_version_required",
      minimumRequiredVersion: demanded[2],
    };
  }
  if (
    typedReasonCode === "claude_canary_timeout" ||
    typedReasonCode === "timeout" ||
    ((typedReasonCode === null || typedReasonCode === undefined) &&
      CLAUDE_CANARY_TIMEOUT_RE.test(recorded))
  ) {
    return { code: "claude_canary_timeout", minimumRequiredVersion: null };
  }
  if (typedReasonCode === "claude_bridge_version_required") {
    return {
      code: "claude_bridge_version_required",
      minimumRequiredVersion: demanded?.[2] ?? null,
    };
  }
  /* claude-agent-acp 0.73.0 supplies `error.data.errorKind` for SDK failures,
   * and that typed field is preferred above. Older bridges or paths can omit
   * it. The new fallbacks for the measured family are "Failed to authenticate",
   * "OAuth session expired", and "could not be refreshed" only when attached
   * to "OAuth session"; the existing direct auth phrases remain. No retry or
   * state decision branches on this presentation text (D-053). */
  if (
    (typedReasonCode === "rpc_error" || typedReasonCode === null ||
      typedReasonCode === undefined) &&
    CLAUDE_AUTH_FAILURE_RE.test(recorded)
  ) {
    return { code: "claude_canary_auth_failed", minimumRequiredVersion: null };
  }
  return { code: "claude_canary_unknown", minimumRequiredVersion: null };
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
        ...(this.options.onVersionNotice
          ? { onVersionNotice: this.options.onVersionNotice }
          : {}),
        ...(this.options.onRuntimeNotice
          ? { onRuntimeNotice: this.options.onRuntimeNotice }
          : {}),
        ...(this.options.events ? { events: this.options.events } : {}),
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
    let canaryError: unknown;
    let sentinelCreated = false;
    try {
      await handle.session.enablePromptsAfterCanary({
        timeoutMs: ACP_CANARY_TIMEOUT_MS,
        probeText:
          `Create the file ${sentinelPath} using the Write tool with content ` +
          "CSWARM_CANARY_NOOP. You must use the Write tool. Do nothing else.",
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
    if (sentinelCreated) {
      throw new AcpPermissionCanaryError(
        "Claude bridge wrote the permission canary sentinel before denial",
        "claude_canary_write_not_blocked",
      );
    }
    if (canaryError instanceof AcpPermissionCanaryError) {
      const shape = classifyClaudeCanaryFailure(
        canaryError.message,
        canaryError.reasonCode,
        canaryError.peerError,
      );
      throw new AcpPermissionCanaryError(
        canaryError.message,
        shape.code,
        shape.minimumRequiredVersion,
      );
    }
    if (canaryError !== undefined) throw canaryError;
  }
}
