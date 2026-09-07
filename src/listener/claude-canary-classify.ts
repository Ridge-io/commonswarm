import type { AcpPeerError } from "../host/types.js";

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
