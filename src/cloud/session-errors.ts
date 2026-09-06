import { CommandHttpError } from "./command-client.js";
import {
  AGENT_SESSION_ERROR_CODE_LIST,
  isAgentSessionErrorCode,
  type AgentSessionErrorCode,
} from "./session-contract.js";

const SESSION_ERROR_MESSAGES = {
  session_proof_missing:
    "this agent is managed; a session proof is required before a write",
  session_proof_invalid: "the session proof was rejected",
  session_expired: "the execution session has expired; stop dispatch and recover",
  session_retired: "this execution UUID is retired and cannot be used again",
  session_conflict: "another live execution session already holds this agent",
  session_not_managed:
    "managed sessions are not enabled for this agent; an owner or admin must enable them first",
  session_already_managed: "managed sessions are already enabled for this agent",
} as const satisfies Record<AgentSessionErrorCode, string>;

/**
 * Typed session failure. Callers branch on `code`, never on `message`.
 * The message is generated from the same code list the classifier reads.
 */
export class AgentSessionError extends Error {
  readonly name = "AgentSessionError";

  constructor(
    readonly status: number,
    readonly code: AgentSessionErrorCode,
  ) {
    super(SESSION_ERROR_MESSAGES[code]);
  }
}

export function sessionErrorMessage(code: AgentSessionErrorCode): string {
  return SESSION_ERROR_MESSAGES[code];
}

/** Every code the classifier accepts, from the same list enforcement reads. */
export function sessionErrorMessageList(): readonly string[] {
  return AGENT_SESSION_ERROR_CODE_LIST.map((code) => SESSION_ERROR_MESSAGES[code]);
}

export function agentSessionErrorFromBody(
  status: number,
  body: unknown,
): AgentSessionError | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== "string" || !isAgentSessionErrorCode(error)) return null;
  return new AgentSessionError(status, error);
}

/** Classify a command-layer failure without reading error.message. */
export function agentSessionErrorFromUnknown(
  error: unknown,
): AgentSessionError | null {
  if (error instanceof AgentSessionError) return error;
  if (error instanceof CommandHttpError) {
    if (error.code !== undefined && isAgentSessionErrorCode(error.code)) {
      return new AgentSessionError(error.status, error.code);
    }
    return null;
  }
  return null;
}
