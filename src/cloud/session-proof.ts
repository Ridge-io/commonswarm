import { createHash, randomBytes } from "node:crypto";
import {
  AGENT_SESSION_GENERATION_HEADER,
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_KEY_HEADER,
  AGENT_SESSION_PROOF_HEADERS,
  type AgentSessionProof,
} from "./session-contract.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export function generateSessionKey(): string {
  return randomBytes(32).toString("base64url");
}

export function isSessionKey(value: string): boolean {
  return SESSION_KEY_RE.test(value);
}

export function isSessionUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** SHA-256 hex of the key string, matching the server acquire `key_hash`. */
export function sessionKeyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function proofHeaders(proof: AgentSessionProof): Record<string, string> {
  return {
    [AGENT_SESSION_ID_HEADER]: proof.session_id,
    [AGENT_SESSION_GENERATION_HEADER]: String(proof.generation),
    [AGENT_SESSION_KEY_HEADER]: proof.key,
  };
}

export function parseSessionProof(value: unknown): AgentSessionProof | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.session_id !== "string" || !UUID_RE.test(row.session_id)) {
    return null;
  }
  if (
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1
  ) {
    return null;
  }
  if (typeof row.key !== "string" || !SESSION_KEY_RE.test(row.key)) return null;
  return {
    session_id: row.session_id.toLowerCase(),
    generation: row.generation,
    key: row.key,
  };
}

const REDACTED_PROOF = "[redacted-session-proof]";
const REDACTED_TOKEN = "[redacted-credential]";

function isProofHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (AGENT_SESSION_PROOF_HEADERS as readonly string[]).includes(lower);
}

/** Copy headers for logs. Private proof and agent tokens never appear. */
export function redactSessionHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  const parsed = new Headers(headers);
  parsed.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (isProofHeaderName(lower)) {
      out[key] = REDACTED_PROOF;
      return;
    }
    if (lower === "authorization" || /swm_agt_/.test(value)) {
      out[key] = REDACTED_TOKEN;
      return;
    }
    out[key] = value;
  });
  return out;
}

/** Strip proof secrets from diagnostic text. */
export function redactSessionText(value: string): string {
  let text = value;
  for (const header of AGENT_SESSION_PROOF_HEADERS) {
    text = text.replace(
      new RegExp(`${header}\\s*[:=]\\s*[^\\s,;}]+`, "gi"),
      `${header}=${REDACTED_PROOF}`,
    );
  }
  text = text.replace(/swm_agt_[A-Za-z0-9_-]+/g, REDACTED_TOKEN);
  text = text.replace(
    /"session_key"\s*:\s*"[^"]*"/g,
    `"session_key":"${REDACTED_PROOF}"`,
  );
  return text;
}

/**
 * Attach the three proof headers to every request this fetcher sends.
 * Proof stays out of the body so command ids remain stable across renewals.
 */
export function bindSessionProof(
  fetcher: typeof fetch,
  proof: AgentSessionProof | null | undefined,
): typeof fetch {
  if (proof === null || proof === undefined) return fetcher;
  const headersToAdd = proofHeaders(proof);
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headersToAdd)) {
      headers.set(name, value);
    }
    return await fetcher(input, { ...init, headers });
  }) as typeof fetch;
}
