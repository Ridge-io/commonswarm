/**
 * Provider-neutral ACP host session: initialize, session/new, sequential
 * prompt (text), cancel notification, session/load, permission handling,
 * and the permission-boundary canary gate for real prompts.
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  ACP_DEFAULT_REQUEST_TIMEOUT_MS,
  ACP_MAX_ACCUMULATED_TEXT_CHARS,
  ACP_PROTOCOL_VERSION,
} from "./bounds.js";
import {
  defaultPermissionCallback,
  parsePermissionOptions,
  permissionDecisionToResult,
  resolvePermissionCallback,
} from "./permission.js";
import { sanitizeText, sanitizeUpdateDetail } from "./sanitize.js";
import { AcpTransport } from "./transport.js";
import {
  AcpPermissionCanaryError,
  AcpPromptsBlockedError,
  AcpProtocolError,
  type HostSessionEvents,
  type HostSessionInfo,
  type HostSessionOptions,
  type JsonRpcId,
  type PermissionCallback,
  type PromptResult,
  type SanitizedSessionUpdate,
  type SessionUpdateKind,
  type AcpStopReason,
} from "./types.js";

export type AcpSessionConnectOptions = HostSessionOptions & {
  transport: AcpTransport;
  /** When true, skip canary gate (tests that exercise prompt path directly after manual enable). */
  promptsEnabled?: boolean;
};

function assertAbsoluteExistingCwd(cwd: string): string {
  if (!cwd || typeof cwd !== "string") {
    throw new AcpProtocolError("cwd is required", "invalid_cwd");
  }
  if (!isAbsolute(cwd)) {
    throw new AcpProtocolError("cwd must be an absolute path", "invalid_cwd");
  }
  let st;
  try {
    st = statSync(cwd);
  } catch {
    throw new AcpProtocolError(`cwd does not exist: ${cwd}`, "invalid_cwd");
  }
  if (!st.isDirectory()) {
    throw new AcpProtocolError(`cwd is not a directory: ${cwd}`, "invalid_cwd");
  }
  return cwd;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStopReason(value: unknown): AcpStopReason {
  if (
    value === "end_turn" ||
    value === "max_tokens" ||
    value === "max_turn_requests" ||
    value === "refusal" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new AcpProtocolError(
    `invalid stopReason: ${String(value)}`,
    "invalid_response",
  );
}

/** True when the host selected reject_* or cancelled the permission request. */
function isHostRejectDecision(
  decision: import("./types.js").PermissionDecision,
  options: import("./types.js").PermissionOption[],
): boolean {
  if (decision.outcome === "cancelled") return true;
  if (decision.outcome !== "selected") return false;
  const chosen = options.find((opt) => opt.optionId === decision.optionId);
  return chosen?.kind === "reject_once" || chosen?.kind === "reject_always";
}

function updateKind(raw: unknown): SessionUpdateKind {
  switch (raw) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
    case "plan":
    case "available_commands_update":
      return raw;
    default:
      return "unknown";
  }
}

/**
 * One host↔agent ACP session. Sequential prompts only; cancel is a notification.
 */
/** Bounded structured terminal statuses that count as a host-correlated deny. */
const CANARY_TERMINAL_DENY_STATUSES = new Set([
  "rejected",
  "denied",
  "cancelled",
  "canceled",
  "failed",
  "error",
]);

export class AcpHostSession {
  private readonly transport: AcpTransport;
  private cwd: string;
  private readonly permissionCallback: PermissionCallback;
  private readonly requiredModeId: string | undefined;
  private readonly events: HostSessionEvents;
  private readonly requestTimeoutMs: number;
  private sessionId: string | null = null;
  private agentVersion: string | undefined;
  private promptsEnabled: boolean;
  private promptInFlight = false;
  private closed = false;
  /**
   * Canary denial is host-authored only: we record toolCallIds we ourselves
   * rejected, then accept a bounded structured terminal status on that same id.
   * Provider free-text / error-body regex never unlocks prompts.
   */
  private canaryState: {
    sawPermissionRequest: boolean;
    sawDeniedToolResult: boolean;
    /** Keys are `${sessionId}\\0${toolCallId}` — both must match active session. */
    rejectedToolKeys: Set<string>;
  } = {
    sawPermissionRequest: false,
    sawDeniedToolResult: false,
    rejectedToolKeys: new Set(),
  };

  private constructor(options: AcpSessionConnectOptions) {
    this.transport = options.transport;
    // Mutable so openWorkCwd can retarget after a canary on an empty temp cwd.
    this.cwd = assertAbsoluteExistingCwd(options.cwd);
    this.requiredModeId = options.requiredModeId;
    this.permissionCallback = resolvePermissionCallback(options.permissionCallback);
    this.events = options.events ?? {};
    this.requestTimeoutMs = options.requestTimeoutMs ?? ACP_DEFAULT_REQUEST_TIMEOUT_MS;
    this.promptsEnabled = options.promptsEnabled === true;
  }

  /**
   * Wire an existing transport, run initialize + session/new, return a ready session.
   * Real prompts stay blocked until {@link enablePromptsAfterCanary} (or test opt-in).
   */
  static async connect(options: AcpSessionConnectOptions): Promise<AcpHostSession> {
    const session = new AcpHostSession(options);
    session.attachHandlers();
    await session.initialize(options.clientName, options.clientVersion);
    await session.newSession();
    return session;
  }

  /**
   * Build a session around a transport that is already initialized (tests).
   */
  static attachInitialized(
    options: AcpSessionConnectOptions & { sessionId: string; agentVersion?: string },
  ): AcpHostSession {
    const session = new AcpHostSession(options);
    session.attachHandlers();
    session.sessionId = options.sessionId;
    session.agentVersion = options.agentVersion;
    return session;
  }

  get info(): HostSessionInfo {
    if (!this.sessionId) {
      throw new AcpProtocolError("session not opened", "no_session");
    }
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentVersion: this.agentVersion,
    };
  }

  get arePromptsEnabled(): boolean {
    return this.promptsEnabled;
  }

  get canaryObservation() {
    return { ...this.canaryState };
  }

  /**
   * Permission-boundary canary. Drives a side-effect-free probe that must
   * produce (1) a session/request_permission we answer with reject and
   * (2) a structured tool_call(_update) for that same toolCallId with a
   * bounded terminal deny status — never provider free-text matching.
   *
   * Ambient provider hooks remain outside this boundary — see permission.ts.
   * Steady-state `--permissions allow` is not proven by a deny-only canary;
   * allow_once is only selected after this gate, by the listener model.
   */
  /**
   * D-081. ONE BOUNDED RETRY, because the canary's pass condition depends on a REMOTE MODEL
   * CHOOSING to attempt a tool call, and re-prompting re-samples that choice.
   *
   * `runPermissionBoundaryCanary` resets its own observation state and sends a fresh prompt, so a
   * second call is a genuine second sample rather than a re-read of the first verdict — that is
   * what makes a retry meaningful here and it was checked before this was written.
   *
   * MITIGATION, NOT A DIAGNOSIS, and deliberately so: seven mechanisms for D-081 were proposed
   * and refuted in a single afternoon, and the cause is still not established. The precedent is
   * D-076, shipped in 0.1.11 as a bounded one-shot retry with its root cause open and documented.
   *
   * The cost is real and is recorded rather than hidden: a genuinely dead host now takes up to
   * two canary timeouts before failing. Measured first-attempt failures on this machine were 24s,
   * 25s and 9s against a 30s timeout, so a doubled worst case is a minute-scale wait. That is the
   * price of not reporting a healthy listener as failed, which is the defect being mitigated.
   *
   * It must NOT be able to hide a deterministic failure: every attempt is reported through
   * `onAttempt`, and the thrown error names how many were made and why the last one failed, so
   * "flaky, retried, ready" and "failed twice" are distinguishable in the log rather than
   * collapsing into one line.
   */
  async enablePromptsAfterCanary(options?: {
    probeText?: string;
    timeoutMs?: number;
    /** Total canary attempts, not retries. Default 2. Values below 1 are treated as 1. */
    attempts?: number;
    onAttempt?: (
      attempt: number,
      total: number,
      result: { passed: boolean; reason?: string },
    ) => void;
  }): Promise<void> {
    if (this.promptsEnabled) return;
    const total = Math.max(1, options?.attempts ?? 2);
    let last: { passed: boolean; reason?: string } | null = null;
    for (let attempt = 1; attempt <= total; attempt += 1) {
      const result = await this.runPermissionBoundaryCanary(options);
      last = result;
      options?.onAttempt?.(attempt, total, result);
      if (result.passed) {
        this.promptsEnabled = true;
        return;
      }
    }
    const detail = last?.reason ??
      "permission-boundary canary failed: need host reject + correlated terminal tool status";
    throw new AcpPermissionCanaryError(
      total === 1 ? detail : `${detail} (failed ${total} attempts)`,
    );
  }

  /** Test/helper: force-enable prompts without canary (never used by production open path). */
  forceEnablePromptsForTests(): void {
    this.promptsEnabled = true;
  }

  /** Reset the canary gate (used after session/load fallback to session/new). */
  private resetPromptGate(): void {
    this.promptsEnabled = false;
    this.canaryState = {
      sawPermissionRequest: false,
      sawDeniedToolResult: false,
      rejectedToolKeys: new Set(),
    };
  }

  private canaryRejectKey(sessionId: string, toolCallId: string): string {
    return `${sessionId}\0${toolCallId}`;
  }

  async runPermissionBoundaryCanary(options?: {
    probeText?: string;
    timeoutMs?: number;
  }): Promise<{
    passed: boolean;
    sawPermissionRequest: boolean;
    sawDeniedToolResult: boolean;
    reason?: string;
    stopReason?: AcpStopReason;
  }> {
    this.canaryState = {
      sawPermissionRequest: false,
      sawDeniedToolResult: false,
      rejectedToolKeys: new Set(),
    };
    // Harmless sentinel: no file paths, no project mutation instructions.
    const probe =
      options?.probeText ??
      "cswarm-permission-boundary-canary-v2: if your policy requires a tool permission request, issue one for a no-op check only; do not create, edit, delete, or read any project files; stop after the permission path. Sentinel=CSWARM_CANARY_NOOP";
    try {
      const promptResult = await this.promptInternal(probe, {
        timeoutMs: options?.timeoutMs,
        bypassCanaryGate: true,
      });
      const passed =
        this.canaryState.sawPermissionRequest && this.canaryState.sawDeniedToolResult;
      return {
        passed,
        sawPermissionRequest: this.canaryState.sawPermissionRequest,
        sawDeniedToolResult: this.canaryState.sawDeniedToolResult,
        stopReason: promptResult.stopReason,
        reason: passed
          ? undefined
          : `canary incomplete: permission=${this.canaryState.sawPermissionRequest} deniedTool=${this.canaryState.sawDeniedToolResult}`,
      };
    } catch (err) {
      return {
        passed: false,
        sawPermissionRequest: this.canaryState.sawPermissionRequest,
        sawDeniedToolResult: this.canaryState.sawDeniedToolResult,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * After a successful canary on a throwaway cwd, open a new ACP session on the
   * real work cwd without re-probing tools in that tree. Same child/host
   * permission path remains in force.
   */
  async openWorkCwd(cwd: string): Promise<void> {
    this.assertOpen();
    if (!this.promptsEnabled) {
      throw new AcpPromptsBlockedError();
    }
    this.cwd = assertAbsoluteExistingCwd(cwd);
    await this.newSession();
  }

  async prompt(text: string, options?: { timeoutMs?: number }): Promise<PromptResult> {
    if (!this.promptsEnabled) {
      throw new AcpPromptsBlockedError();
    }
    return this.promptInternal(text, { ...options, bypassCanaryGate: false });
  }

  /**
   * session/cancel as a notification — no JSON-RPC id.
   */
  cancel(): void {
    if (!this.sessionId) {
      throw new AcpProtocolError("session not opened", "no_session");
    }
    this.transport.notify("session/cancel", { sessionId: this.sessionId });
  }

  /**
   * session/load with fixed cwd and empty mcpServers.
   * On failure, falls back to session/new and returns the new session id.
   */
  async load(sessionId: string): Promise<{ sessionId: string; loaded: boolean }> {
    this.assertOpen();
    try {
      const result = await this.transport.request(
        "session/load",
        {
          sessionId,
          cwd: this.cwd,
          mcpServers: [],
        },
        this.requestTimeoutMs,
      );
      if (!isRecord(result) || typeof result.sessionId !== "string") {
        // Some agents return empty result on load success — keep requested id.
        this.sessionId = sessionId;
        await this.applyRequiredMode();
        return { sessionId, loaded: true };
      }
      /* D-086 round 2. The child returning a DIFFERENT id than the one we asked to load was
       * accepted as the new active session, so it could choose the session every later check is
       * made against — defeating those checks at the source rather than at each use. The
       * exact-review arm loaded "requested", received "other", and then had a permission request
       * for "other" approved.
       *
       * ACP has no aliasing that we rely on, so a mismatch is treated as a failed load and takes
       * the existing fallback: reset the prompt gate and open a fresh session, which re-runs the
       * canary before any real prompt. Fail-closed, and it reuses a path that is already tested. */
      if (result.sessionId !== sessionId) {
        throw new AcpProtocolError(
          "session/load returned a different session id",
          "session_id_mismatch",
        );
      }
      this.sessionId = result.sessionId;
      await this.applyRequiredMode();
      return { sessionId: result.sessionId, loaded: true };
    } catch {
      // Fallback session/new is a new agent context: re-canary before real prompts.
      this.resetPromptGate();
      await this.newSession();
      return { sessionId: this.sessionId!, loaded: false };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }

  private attachHandlers(): void {
    // Transport was constructed with handlers; we rebind via monkey-patch on the
    // options object is not available. Instead, session owns a dedicated transport
    // created by factories that pass these closures. For attachInitialized/connect,
    // callers must construct transport with createSessionTransportHandlers(session).
    // Here we only use the transport's already-wired handlers if set by factory.
  }

  /**
   * Install request/notification handlers on a transport for this session.
   * Called by factories after construction.
   */
  bindTransportHandlers(): void {
    // no-op placeholder — factories wire handlers that call session methods.
  }

  /** Handle agent→client request. Public for transport wiring. */
  async handleAgentRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (method === "session/request_permission") {
      await this.handlePermissionRequest(id, params);
      return;
    }
    // We advertise fs/terminal false — refuse any client method we did not enable.
    this.transport.respondError(id, -32601, `Method not supported by host: ${method}`);
  }

  /** Handle agent notification. Public for transport wiring. */
  handleAgentNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      this.handleSessionUpdate(params);
      return;
    }
    // Unknown notifications (including _x.ai/*) — ignore safely, optional observe.
    this.events.notification?.(method, params);
  }

  private async initialize(clientName?: string, clientVersion?: string): Promise<void> {
    const result = await this.transport.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: clientName ?? "cswarm-host",
          version: clientVersion ?? "0.1.4",
        },
      },
      this.requestTimeoutMs,
    );
    if (!isRecord(result)) {
      throw new AcpProtocolError("initialize returned non-object", "invalid_response");
    }
    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpProtocolError(
        `unsupported protocolVersion ${String(result.protocolVersion)}`,
        "protocol_version",
      );
    }
    const meta = isRecord(result._meta) ? result._meta : undefined;
    if (meta && typeof meta.agentVersion === "string") {
      this.agentVersion = meta.agentVersion;
    }
  }

  private async newSession(): Promise<void> {
    const result = await this.transport.request(
      "session/new",
      {
        cwd: this.cwd,
        mcpServers: [],
        _meta: { yoloMode: false },
      },
      this.requestTimeoutMs,
    );
    if (!isRecord(result) || typeof result.sessionId !== "string" || !result.sessionId) {
      throw new AcpProtocolError("session/new missing sessionId", "invalid_response");
    }
    this.sessionId = result.sessionId;
    await this.applyRequiredMode(result);
  }

  /** Select the provider-measured permission mode and fail closed if absent. */
  private async applyRequiredMode(newSessionResult?: Record<string, unknown>): Promise<void> {
    const requiredModeId = this.requiredModeId;
    if (!requiredModeId) return;
    if (!this.sessionId) {
      throw new AcpProtocolError("session mode requires an open session", "no_session");
    }
    if (newSessionResult) {
      const modes = isRecord(newSessionResult.modes) ? newSessionResult.modes : null;
      const availableModes = modes && Array.isArray(modes.availableModes)
        ? modes.availableModes
        : [];
      const available = availableModes.some((mode) =>
        isRecord(mode) && mode.id === requiredModeId
      );
      if (!available) {
        throw new AcpProtocolError(
          `required session mode is unavailable: ${requiredModeId}`,
          "permission_mode_unavailable",
        );
      }
    }
    try {
      await this.transport.request(
        "session/set_mode",
        { sessionId: this.sessionId, modeId: requiredModeId },
        this.requestTimeoutMs,
      );
    } catch {
      throw new AcpProtocolError(
        `required session mode could not be selected: ${requiredModeId}`,
        "permission_mode_unavailable",
      );
    }
  }

  private async promptInternal(
    text: string,
    options: { timeoutMs?: number; bypassCanaryGate: boolean },
  ): Promise<PromptResult> {
    this.assertOpen();
    if (!options.bypassCanaryGate && !this.promptsEnabled) {
      throw new AcpPromptsBlockedError();
    }
    if (this.promptInFlight) {
      throw new AcpProtocolError("prompt already in flight (sequential only)", "busy");
    }
    if (typeof text !== "string") {
      throw new AcpProtocolError("prompt text must be a string", "invalid_prompt");
    }
    this.promptInFlight = true;
    const updates: SanitizedSessionUpdate[] = [];
    let message = "";
    // Temporarily fan updates into the accumulator without re-entering this.events.update.
    const prev = this.events.update;
    this.events.update = (u) => {
      updates.push(u);
      /* D-086, the reply-text path. Text is accumulated only from the session we are driving.
       *
       * `handlePermissionRequest` trusting the child's sessionId was the release blocker; this is
       * the same trust one layer over. An `agent_message_chunk` naming a session we never opened
       * would otherwise be concatenated into `message`, and `message` becomes the reply body posted
       * as a signal — so text from a foreign session gets published under our agent's name.
       *
       * Well-behaved providers are unaffected. `sessionId` is non-optional in src/host/types.ts, so
       * an update that omits it is unattributed, and unattributed text does not become our reply.
       *
       * ★ THIS FIX WAS WRITTEN ONCE AND LOST before it reached a commit, while 65527457's message
       * claimed it had landed. Both arms had reported the path; the inversion arm caught the
       * discrepancy on the next round by reading the tree instead of the message. Verified present
       * this time by grepping the COMMITTED object, not the working tree. */
      const fromOurSession = this.sessionId === null || u.sessionId === this.sessionId;
      if (u.kind === "agent_message_chunk" && u.text && fromOurSession) {
        if (message.length + u.text.length > ACP_MAX_ACCUMULATED_TEXT_CHARS) {
          throw new AcpProtocolError(
            "accumulated agent message exceeds bound",
            "message_too_large",
          );
        }
        message += u.text;
      }
      prev?.(u);
    };
    try {
      const result = await this.transport.request(
        "session/prompt",
        {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text }],
        },
        options.timeoutMs ?? this.requestTimeoutMs,
      );
      if (!isRecord(result) || !("stopReason" in result)) {
        throw new AcpProtocolError("session/prompt missing stopReason", "invalid_response");
      }
      const stopReason = asStopReason(result.stopReason);
      return { stopReason, message, updates };
    } finally {
      this.events.update = prev;
      this.promptInFlight = false;
    }
  }

  private handleSessionUpdate(params: unknown): void {
    if (!isRecord(params)) return;
    /* D-086 round 2, same substitution as the permission path: an absent or non-string id was read
     * as ours, which let an unattributed update satisfy the canary correlation below and be
     * accumulated into the active prompt's reply. Kept as an explicit null so both uses can tell
     * "the child said it is ours" from "the child said nothing". */
    const claimedSessionId =
      typeof params.sessionId === "string" ? params.sessionId : null;
    const sessionId = claimedSessionId ?? "";
    const update = params.update;
    if (!isRecord(update)) return;
    const kind = updateKind(update.sessionUpdate);
    if (kind === "unknown") {
      // Ignore unknown update shapes safely.
      this.events.notification?.("session/update", params);
      return;
    }

    let text: string | undefined;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const content = update.content;
      if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
        text = sanitizeText(content.text);
      }
    }

    const toolCallId =
      typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    const title = typeof update.title === "string" ? sanitizeText(update.title) : undefined;
    const status = typeof update.status === "string" ? update.status : undefined;
    const toolKind = typeof update.kind === "string" ? update.kind : undefined;

    // Canary deny arm: host reject of (sessionId, toolCallId) + bounded status.
    // Mismatched session ids never unlock prompts. Never scan content bodies.
    if (
      (kind === "tool_call_update" || kind === "tool_call") &&
      toolCallId &&
      status &&
      this.sessionId !== null &&
      claimedSessionId !== null &&
      claimedSessionId === this.sessionId &&
      this.canaryState.rejectedToolKeys.has(
        this.canaryRejectKey(sessionId, toolCallId),
      ) &&
      CANARY_TERMINAL_DENY_STATUSES.has(status.toLowerCase())
    ) {
      this.canaryState.sawDeniedToolResult = true;
    }

    const detail = sanitizeUpdateDetail({
      ...(toolKind ? { kind: toolKind } : {}),
      ...(status ? { status } : {}),
      ...(title ? { title } : {}),
    });

    const sanitized: SanitizedSessionUpdate = {
      kind,
      sessionId,
      text,
      toolCallId,
      title,
      status,
      toolKind,
      detail,
    };
    this.events.update?.(sanitized);
  }

  private async handlePermissionRequest(id: JsonRpcId, params: unknown): Promise<void> {
    const rec = isRecord(params) ? params : {};
    /* D-086 round 2. `?? this.sessionId` DEFEATED the session check by substituting our own id for a
     * missing or non-string one — so a child that simply OMITS sessionId was treated as us and
     * approved. The first fix rejected an explicit foreign id and this walked around it. Measured by
     * the exact-review arm: omitted, null, and numeric ids all reached the callback as "ours" and
     * returned allow_once; only an empty string denied.
     *
     * `sessionId` is non-optional in src/host/types.ts, so requiring it enforces our declared
     * contract rather than inventing a stricter one. Absent means unattributed, and unattributed
     * means denied. */
    const claimedSessionId =
      typeof rec.sessionId === "string" ? rec.sessionId : null;
    const sessionId = claimedSessionId ?? "";
    const options = parsePermissionOptions(rec.options);
    const toolCall = isRecord(rec.toolCall) ? rec.toolCall : {};
    const toolCallId =
      typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined;
    const title = typeof toolCall.title === "string" ? toolCall.title : undefined;
    const kind = typeof toolCall.kind === "string" ? toolCall.kind : undefined;
    /* Only the active session counts for the canary permission arm — AND for approval at all.
     *
     * D-086. This match was computed and then used only for canary bookkeeping; the callback below
     * ran unconditionally. While deny was the default the bug was inert, because the callback
     * refused everything either way. Making allow the default (D-084) turned a latent fail-open
     * into a live one: an `allow_once` approval could be returned for a session that is not the one
     * we are driving. The request arrives over JSON-RPC from the provider child, so the sessionId
     * is ITS assertion, not ours.
     *
     * Found by the exact-review arm on 87fe7edc, which reproduced it: an active session "active"
     * approving allow_once for sessionId "other". A flip that is safe in isolation can arm a defect
     * that was previously unreachable — the change and the defect were in different files. */
    const sessionMatches =
      this.sessionId !== null && claimedSessionId !== null &&
      claimedSessionId === this.sessionId;
    if (sessionMatches) {
      this.canaryState.sawPermissionRequest = true;
    }
    if (!sessionMatches) {
      this.transport.respond(
        id,
        permissionDecisionToResult(defaultPermissionCallback({
          sessionId,
          toolCallId,
          title,
          kind,
          options,
          summary: sanitizeText(
            [kind, title, toolCallId].filter(Boolean).join(" ") || "permission request",
          ),
        })),
      );
      return;
    }
    // Never pass rawInput through — summary only.
    const summary = sanitizeText(
      [kind, title, toolCallId].filter(Boolean).join(" ") || "permission request",
    );

    let decision;
    try {
      decision = await this.permissionCallback({
        sessionId,
        toolCallId,
        title,
        kind,
        options,
        summary,
      });
    } catch {
      decision = defaultPermissionCallback({
        sessionId,
        toolCallId,
        title,
        kind,
        options,
        summary,
      });
    }

    // Hard safety: even a buggy callback must not be able to "forget" to decide.
    if (!decision || (decision.outcome !== "cancelled" && decision.outcome !== "selected")) {
      decision = defaultPermissionCallback({
        sessionId,
        toolCallId,
        title,
        kind,
        options,
        summary,
      });
    }

    // Record host-authored rejects bound to active sessionId + toolCallId.
    if (
      sessionMatches &&
      toolCallId &&
      isHostRejectDecision(decision, options)
    ) {
      this.canaryState.rejectedToolKeys.add(
        this.canaryRejectKey(sessionId, toolCallId),
      );
    }

    // Denied-tool canary signal requires a later structured terminal update
    // for the same sessionId+toolCallId — not the host decision alone.
    const result = permissionDecisionToResult(decision);
    this.transport.respond(id, result);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AcpProtocolError("session closed", "closed");
    }
    if (!this.sessionId) {
      throw new AcpProtocolError("session not opened", "no_session");
    }
  }
}

/**
 * Create a transport whose agent→client handlers are bound to a session.
 * Session is set after construction via the holder.
 */
export function createBoundTransport(options: {
  readable: import("node:stream").Readable;
  writable: import("node:stream").Writable;
  requestTimeoutMs?: number;
  onChildExit?: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
  getSession: () => AcpHostSession | null;
}): AcpTransport {
  return new AcpTransport({
    readable: options.readable,
    writable: options.writable,
    requestTimeoutMs: options.requestTimeoutMs,
    onChildExit: options.onChildExit,
    handlers: {
      onNotification: (method, params) => {
        options.getSession()?.handleAgentNotification(method, params);
      },
      onRequest: async (id, method, params) => {
        const session = options.getSession();
        if (!session) {
          return;
        }
        await session.handleAgentRequest(id, method, params);
      },
    },
  });
}
