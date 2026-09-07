/**
 * Agent execution-session wire contract.
 *
 * Names, timings, states, and error codes for the managed-session fence.
 * The private session key never belongs in a command body, URL, log, or
 * conflict response. Proof headers sit outside the logical command hash.
 */

export const AGENT_SESSION_ID_HEADER = "x-cswarm-session-id";
export const AGENT_SESSION_GENERATION_HEADER = "x-cswarm-session-generation";
export const AGENT_SESSION_KEY_HEADER = "x-cswarm-session-key";

/** Server-authoritative session lifetime. */
export const AGENT_SESSION_TTL_MS = 120_000;
export const AGENT_SESSION_TTL_SECONDS = 120;
/** Client renewal cadence. Deterministic; no model call. */
export const AGENT_SESSION_RENEW_AFTER_MS = 40_000;
/** Client-generated private key size. */
export const AGENT_SESSION_KEY_BYTES = 32;
/** base64url of 32 bytes, no padding. */
export const AGENT_SESSION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
/** Strict UUID (any RFC 4122 version/variant the command edge already accepts). */
export const AGENT_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AgentSessionProof {
  session_id: string;
  generation: number;
  key: string;
}

export type AgentSessionErrorCode =
  | "session_proof_missing"
  | "session_proof_invalid"
  | "session_expired"
  | "session_retired"
  | "session_conflict"
  | "session_not_managed"
  | "session_already_managed"
  | "session_leases_live"
  | "delivery_not_surfaced";

/** ACK body field. Closed boolean. Required for managed principals. */
export const ACK_AGENT_DELIVERY_SURFACED_FIELD = "surfaced" as const;

/** Typed refusal when a managed principal promotes queued → observed without a surface. */
export const DELIVERY_NOT_SURFACED_CODE = "delivery_not_surfaced" as const;

/**
 * Immutable host binding on acquire. A live retry with the same session
 * UUID+key must present the same values; a change is session_conflict.
 */
export const AGENT_SESSION_BINDING_FIELDS = [
  "provider",
  "host_label",
  "host_session_ref",
] as const;

/**
 * Columns projected by swarm_read.agent_execution_sessions.
 * key_hash is not in this list. Server tests compare this array to the live view.
 */
export const AGENT_EXECUTION_SESSION_READ_COLUMNS = [
  "principal_id",
  "workspace_id",
  "session_id",
  "generation",
  "lifecycle_state",
  "host_label",
  "provider",
  "host_session_ref",
  "started_at",
  "renewed_at",
  "expired_at",
  "created_at",
  "updated_at",
] as const;

/**
 * JWT claim the read edge installs so swarm_read.agent_execution_sessions
 * admits only the calling agent's principal. Human PostgREST callers omit it.
 */
export const AGENT_SESSION_READ_PRINCIPAL_CLAIM = "agent_principal_id" as const;

export type AgentSessionBindingField =
  (typeof AGENT_SESSION_BINDING_FIELDS)[number];

export interface AgentSessionBinding {
  provider: string | null;
  host_label: string | null;
  host_session_ref: string | null;
}

export function normalizeSessionBindingValue(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function sessionBindingsEqual(
  left: AgentSessionBinding,
  right: AgentSessionBinding,
): boolean {
  for (const field of AGENT_SESSION_BINDING_FIELDS) {
    if (
      normalizeSessionBindingValue(left[field]) !==
        normalizeSessionBindingValue(right[field])
    ) {
      return false;
    }
  }
  return true;
}

export function sessionBindingsConflict(
  stored: AgentSessionBinding,
  presented: AgentSessionBinding,
): boolean {
  return !sessionBindingsEqual(stored, presented);
}

/**
 * The sole agent-mutation exemption from the session-proof fence.
 * acquire_agent_session performs its own row-locked acquisition check.
 * A newly added agent-mutation kind is fenced unless it is added here.
 * tests/protocol-workspace.test.ts derives the dispatcher inventory from
 * protocol command unions, exported KIND constants, and handleTransaction
 * `kind ===` labels — not a fixed name list — and fails closed on a new kind.
 */
export const AGENT_SESSION_PROOF_EXEMPT_KINDS = [
  "acquire_agent_session",
] as const;

export type AgentSessionProofExemptKind =
  (typeof AGENT_SESSION_PROOF_EXEMPT_KINDS)[number];

const EXEMPT_KIND_SET: ReadonlySet<string> = new Set(
  AGENT_SESSION_PROOF_EXEMPT_KINDS,
);

export function isAgentSessionProofExempt(kind: string): boolean {
  return EXEMPT_KIND_SET.has(kind);
}

export function agentSessionErrorStatus(code: AgentSessionErrorCode): number {
  switch (code) {
    case "session_proof_missing":
    case "session_proof_invalid":
    case "session_expired":
      return 401;
    case "session_conflict":
    case "session_already_managed":
    case "session_leases_live":
    case "delivery_not_surfaced":
      return 409;
    case "session_retired":
    case "session_not_managed":
      return 403;
  }
}

export type AgentSessionProofParse =
  | { ok: true; proof: AgentSessionProof }
  | { ok: false; error: "session_proof_missing" | "session_proof_invalid" };

export type AgentSessionAcquireParse =
  | { ok: true; session_id: string; key: string }
  | { ok: false; error: "session_proof_missing" | "session_proof_invalid" };

function readHeader(
  headers: { get(name: string): string | null },
  name: string,
): string | null {
  const value = headers.get(name);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseGeneration(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const generation = Number(raw);
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  return generation;
}

export function parseAgentSessionProofHeaders(
  headers: { get(name: string): string | null },
): AgentSessionProofParse {
  const sessionId = readHeader(headers, AGENT_SESSION_ID_HEADER);
  const generationRaw = readHeader(headers, AGENT_SESSION_GENERATION_HEADER);
  const key = readHeader(headers, AGENT_SESSION_KEY_HEADER);
  const anyPresent =
    sessionId !== null || generationRaw !== null || key !== null;
  if (!anyPresent) {
    return { ok: false, error: "session_proof_missing" };
  }
  if (sessionId === null || generationRaw === null || key === null) {
    return { ok: false, error: "session_proof_invalid" };
  }
  if (!AGENT_SESSION_ID_RE.test(sessionId) || !AGENT_SESSION_KEY_RE.test(key)) {
    return { ok: false, error: "session_proof_invalid" };
  }
  const generation = parseGeneration(generationRaw);
  if (generation === null) {
    return { ok: false, error: "session_proof_invalid" };
  }
  return {
    ok: true,
    proof: { session_id: sessionId, generation, key },
  };
}

/** Acquire carries session UUID + key; generation does not exist yet. */
export function parseAgentSessionAcquireHeaders(
  headers: { get(name: string): string | null },
): AgentSessionAcquireParse {
  const sessionId = readHeader(headers, AGENT_SESSION_ID_HEADER);
  const key = readHeader(headers, AGENT_SESSION_KEY_HEADER);
  const generationRaw = readHeader(headers, AGENT_SESSION_GENERATION_HEADER);
  if (sessionId === null && key === null && generationRaw === null) {
    return { ok: false, error: "session_proof_missing" };
  }
  if (sessionId === null || key === null) {
    return { ok: false, error: "session_proof_invalid" };
  }
  if (!AGENT_SESSION_ID_RE.test(sessionId) || !AGENT_SESSION_KEY_RE.test(key)) {
    return { ok: false, error: "session_proof_invalid" };
  }
  if (generationRaw !== null && parseGeneration(generationRaw) === null) {
    return { ok: false, error: "session_proof_invalid" };
  }
  return { ok: true, session_id: sessionId, key };
}
