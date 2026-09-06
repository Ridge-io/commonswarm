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
  | "session_leases_live";

/**
 * The sole agent-mutation exemption from the session-proof fence.
 * acquire_agent_session performs its own row-locked acquisition check.
 * A newly added agent-mutation kind is fenced unless it is added here;
 * the membership test in tests/protocol-workspace.test.ts fails closed.
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
