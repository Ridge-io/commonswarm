import { isAbsolute, join } from "node:path";
import { sanitizeChildEnv } from "../host/env.js";
import {
  SESSION_CONTEXT_ENV,
  type AgentSessionProof,
} from "../cloud/session-contract.js";
import type { SessionContextDocument } from "../cloud/session-context.js";
import { sessionProofOf } from "../cloud/session-context.js";
import {
  deleteSecureJsonFile,
  readSecureJsonFile,
  writeSecureJsonFile,
} from "../cloud/storage.js";
import type { ListenerSessionIdentity } from "./types.js";

export const LISTENER_SESSION_BINDING_FILE = "session-binding.json";

export interface ListenerSessionBindingRecord {
  version: 1;
  contextPath: string;
  sessionId: string;
  generation: number;
}

export interface ManagedSessionBinding {
  contextPath: string;
  context: SessionContextDocument;
  /**
   * Proof presented on this process's writes. Defaults to sessionProofOf(context).
   * A captured older generation is stale against the current context and cannot ACK.
   */
  proof?: AgentSessionProof | null;
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
  return binding.proof !== undefined ? binding.proof : sessionProofOf(binding.context);
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

/** Persist the bound context path and generation for the hook process. Never stores the key. */
export async function writeListenerSessionBinding(
  instanceDirectory: string,
  binding: ManagedSessionBinding,
): Promise<void> {
  if (!isAbsolute(instanceDirectory) || !isAbsolute(binding.contextPath)) {
    throw new Error("managed session binding paths must be absolute");
  }
  const proof = bindingProof(binding);
  const record: ListenerSessionBindingRecord = {
    version: 1,
    contextPath: binding.contextPath,
    sessionId: binding.context.session_id,
    generation: proof?.generation ?? binding.context.generation,
  };
  await writeSecureJsonFile(
    join(instanceDirectory, LISTENER_SESSION_BINDING_FILE),
    `${JSON.stringify(record)}\n`,
  );
}

export async function readListenerSessionBinding(
  instanceDirectory: string,
): Promise<ListenerSessionBindingRecord | null> {
  if (!isAbsolute(instanceDirectory)) return null;
  const raw = await readSecureJsonFile(
    join(instanceDirectory, LISTENER_SESSION_BINDING_FILE),
    4 * 1024,
  );
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.contextPath !== "string" ||
    !isAbsolute(row.contextPath) ||
    typeof row.sessionId !== "string" ||
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1
  ) {
    return null;
  }
  return {
    version: 1,
    contextPath: row.contextPath,
    sessionId: row.sessionId.toLowerCase(),
    generation: row.generation,
  };
}

export async function deleteListenerSessionBinding(
  instanceDirectory: string,
): Promise<void> {
  if (!isAbsolute(instanceDirectory)) return;
  await deleteSecureJsonFile(
    join(instanceDirectory, LISTENER_SESSION_BINDING_FILE),
  ).catch(() => undefined);
}
