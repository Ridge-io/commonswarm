import { sanitizeChildEnv } from "../host/env.js";
import {
  SESSION_CONTEXT_ENV,
  type AgentSessionProof,
} from "../cloud/session-contract.js";
import type { SessionContextDocument } from "../cloud/session-context.js";
import { sessionProofOf } from "../cloud/session-context.js";
import type { ListenerSessionIdentity } from "./types.js";

export interface ManagedSessionBinding {
  contextPath: string;
  context: SessionContextDocument;
}

export function listenerSessionIdentity(
  binding: ManagedSessionBinding,
): ListenerSessionIdentity {
  return {
    principalId: binding.context.principal_id,
    sessionId: binding.context.session_id,
    generation: binding.context.generation,
    hostSessionId: binding.context.host_session_id,
    contextPath: binding.contextPath,
  };
}

export function bindingProof(
  binding: ManagedSessionBinding,
): AgentSessionProof | null {
  return sessionProofOf(binding.context);
}

/**
 * Path only, never the session key. Worker tools take --session-context.
 * sanitizeChildEnv already drops this name; review children therefore cannot
 * inherit the binding from an ACP subprocess env.
 */
export function workerToolEnv(
  parent: NodeJS.ProcessEnv,
  contextPath: string,
): Record<string, string> {
  const base = sanitizeChildEnv(parent);
  return { ...base, [SESSION_CONTEXT_ENV]: contextPath };
}

/** Review / sibling agents get no session binding. */
export function reviewChildEnv(
  parent: NodeJS.ProcessEnv,
): Record<string, string> {
  const base = sanitizeChildEnv(parent);
  delete base[SESSION_CONTEXT_ENV];
  return base;
}

export function envHasSessionBinding(
  env: NodeJS.ProcessEnv | Record<string, string>,
): boolean {
  const value = env[SESSION_CONTEXT_ENV];
  return typeof value === "string" && value.length > 0;
}
