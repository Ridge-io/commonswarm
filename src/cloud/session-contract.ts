/**
 * Client-side session contract. Header names, proof shape, and error codes
 * come from session-wire.ts. Everything else lives here so a server fix-up
 * that adds wire fields cannot fork a second schema.
 */
export {
  AGENT_SESSION_GENERATION_HEADER,
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_KEY_HEADER,
  type AgentSessionErrorCode,
  type AgentSessionProof,
} from "./session-wire.js";

import {
  AGENT_SESSION_GENERATION_HEADER,
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_KEY_HEADER,
  type AgentSessionErrorCode,
} from "./session-wire.js";

/** Server lease length (section 8). */
export const AGENT_SESSION_TTL_MS = 120_000;
/** Deterministic renew offset from last successful proof (section 8). */
export const AGENT_SESSION_RENEW_AFTER_MS = 40_000;

export const SESSION_CONTEXT_VERSION = 1 as const;

/* cswarm 0.1.61: the listener never starts a model, so there is no managed worker mode (spec section 10). */
export const SESSION_MODES = ["interactive"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const SESSION_PROVIDERS = ["grok", "opencode", "claude", "codex"] as const;
export type SessionProvider = (typeof SESSION_PROVIDERS)[number];

export const SESSION_ENFORCEMENT_STATES = [
  "unknown",
  "unmanaged",
  "enabled",
] as const;
export type SessionEnforcementState = (typeof SESSION_ENFORCEMENT_STATES)[number];

export const SESSION_RECEIVE_STATES = [
  "manual",
  "unverified",
  "callback",
] as const;
export type SessionReceiveState = (typeof SESSION_RECEIVE_STATES)[number];

export const AGENT_SESSION_ERROR_CODE_LIST = [
  "session_proof_missing",
  "session_proof_invalid",
  "session_expired",
  "session_retired",
  "session_conflict",
  "session_not_managed",
  "session_already_managed",
  "session_leases_live",
] as const satisfies readonly AgentSessionErrorCode[];

export const AGENT_SESSION_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  AGENT_SESSION_ERROR_CODE_LIST,
);

export function isAgentSessionErrorCode(
  value: string,
): value is AgentSessionErrorCode {
  return AGENT_SESSION_ERROR_CODE_SET.has(value);
}

export const AGENT_SESSION_PROOF_HEADERS = [
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_GENERATION_HEADER,
  AGENT_SESSION_KEY_HEADER,
] as const;

export const SESSION_CONTEXT_ENV = "CSWARM_SESSION_CONTEXT";

export const ALLOW_DUPLICATE_NAME_FIELD = "allow_duplicate_name" as const;

export const ACQUIRE_AGENT_SESSION_KIND = "acquire_agent_session" as const;
export const RENEW_AGENT_SESSION_KIND = "renew_agent_session" as const;
export const RELEASE_AGENT_SESSION_KIND = "release_agent_session" as const;
export const ENABLE_AGENT_MANAGEMENT_KIND = "enable_agent_management" as const;
export const DISABLE_AGENT_MANAGEMENT_KIND = "disable_agent_management" as const;
export const RECOVER_AGENT_SESSION_KIND = "recover_agent_session" as const;
