/**
 * Provider-neutral ACP host session types.
 * Wire shapes follow Agent Client Protocol v1 (NDJSON JSON-RPC over stdio).
 * Provider-specific spawn/auth lives beside these, not inside them.
 */

export type JsonRpcId = string | number;

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
};

export type PermissionDecision =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };

export type PermissionRequest = {
  sessionId: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  options: PermissionOption[];
  /** Sanitized tool call summary — never raw secrets. */
  summary: string;
};

export type PermissionCallback = (
  request: PermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>;

export type HostTextContent = {
  type: "text";
  text: string;
};

export type SessionUpdateKind =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "available_commands_update"
  | "unknown";

export type SanitizedSessionUpdate = {
  kind: SessionUpdateKind;
  sessionId: string;
  text?: string;
  toolCallId?: string;
  title?: string;
  status?: string;
  toolKind?: string;
  /** Redacted structural fields only — never raw secret material. */
  detail?: Record<string, unknown>;
};

export type PromptResult = {
  stopReason: AcpStopReason;
  /** Concatenated agent_message_chunk text. */
  message: string;
  updates: SanitizedSessionUpdate[];
};

export type HostSessionInfo = {
  sessionId: string;
  cwd: string;
  protocolVersion: number;
  agentVersion?: string;
};

export type HostSessionEvents = {
  update?: (update: SanitizedSessionUpdate) => void;
  notification?: (method: string, params: unknown) => void;
};

export type HostSessionOptions = {
  cwd: string;
  /** Provider-measured mode that must be selected after every session/new. */
  requiredModeId?: string;
  permissionCallback?: PermissionCallback;
  events?: HostSessionEvents;
  requestTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
};

export class AcpHostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AcpHostError";
    this.code = code;
  }
}

export class AcpProtocolError extends AcpHostError {
  constructor(message: string, code = "protocol_error") {
    super(code, message);
    this.name = "AcpProtocolError";
  }
}

export class AcpTimeoutError extends AcpHostError {
  constructor(message: string) {
    super("timeout", message);
    this.name = "AcpTimeoutError";
  }
}

export class AcpChildExitError extends AcpHostError {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  constructor(exitCode: number | null, signal: NodeJS.Signals | null) {
    super(
      "child_exit",
      `ACP child exited (code=${exitCode ?? "null"}, signal=${signal ?? "null"})`,
    );
    this.name = "AcpChildExitError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export class AcpVersionError extends AcpHostError {
  constructor(message: string) {
    super("version_refused", message);
    this.name = "AcpVersionError";
  }
}

export class AcpPermissionCanaryError extends AcpHostError {
  constructor(message: string) {
    super("permission_canary_failed", message);
    this.name = "AcpPermissionCanaryError";
  }
}

export class AcpPromptsBlockedError extends AcpHostError {
  constructor() {
    super(
      "prompts_blocked",
      "Real prompts are blocked until the permission-boundary canary passes",
    );
    this.name = "AcpPromptsBlockedError";
  }
}
