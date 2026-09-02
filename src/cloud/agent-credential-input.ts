const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;

/* The credential artifact's `message` is validated byte-for-byte below, which makes it a
 * PROTOCOL CONSTANT rather than copy: a site minting a different spelling is unreadable by
 * every cswarm already installed. Measured against the shipped v0.1.15 binary, 2026-08-12.
 *
 * D-088. The current wording claims the credential is "bound to this task … so the agent's
 * work stays scoped". The run binding and attribution are real; the task scope is not. So the
 * honest spelling is accepted here first, and the site keeps emitting the current one until
 * enough installs carry this build. Reversing that order trades a soft false claim for a hard
 * break. */
export const AGENT_CREDENTIAL_MESSAGE =
  "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.";
export const AGENT_CREDENTIAL_MESSAGE_D088 =
  "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.";
export const ACCEPTED_AGENT_CREDENTIAL_MESSAGES: readonly string[] = [
  AGENT_CREDENTIAL_MESSAGE,
  AGENT_CREDENTIAL_MESSAGE_D088,
];

export interface AgentCredentialInput {
  token: string;
  principalId: string | null;
  tokenId: string | null;
  runId: string | null;
  /** Epoch ms, when the artifact stated one. Null for a bare or pre-renewal artifact. */
  expiresAt: number | null;
  durable: boolean;
}

export type AgentCredentialInputErrorCode =
  | "agent_credential_invalid_json"
  | "agent_credential_not_object"
  | "agent_credential_missing_agent_token"
  | "agent_credential_invalid_agent_token"
  | "agent_credential_fields_invalid";

export type AgentCredentialInputSource =
  | { kind: "file"; path: string }
  | { kind: "stdin" };

/** A stable structural reason for rejecting an agent credential input. */
export class AgentCredentialInputError extends Error {
  readonly name = "AgentCredentialInputError";

  constructor(readonly code: AgentCredentialInputErrorCode, message: string) {
    super(`[${code}] ${message}`);
  }
}

const REQUIRED_ARTIFACT_KEYS = [
  "agent_token",
  "message",
  "principal_id",
  "run_id",
  "status",
  "token_id",
] as const;
const ALLOWED_ARTIFACT_KEYS = new Set<string>([
  ...REQUIRED_ARTIFACT_KEYS,
  "expires_at",
]);

function sourceName(source: AgentCredentialInputSource): string {
  return source.kind === "file"
    ? `agent credential file ${source.path}`
    : "agent credential input from stdin";
}

function nextStep(source: AgentCredentialInputSource): string {
  return source.kind === "file"
    ? `Next step: copy the minted JSON line again and replace ${source.path}.`
    : "Next step: copy the minted JSON line again and send that line to stdin.";
}

function credentialInputError(
  code: AgentCredentialInputErrorCode,
  source: AgentCredentialInputSource,
  found: string,
): AgentCredentialInputError {
  return new AgentCredentialInputError(
    code,
    `${sourceName(source)} ${found}. It must be the JSON line CommonSwarm minted, copied unchanged. Fields: agent_token (required), principal_id, token_id, run_id, expires_at. The complete line also has required message and status fields. ${nextStep(source)}`,
  );
}

function jsonKind(value: unknown): string {
  if (value === null) return "JSON null";
  if (Array.isArray(value)) return "a JSON array";
  return `a JSON ${typeof value}`;
}

/**
 * Parses a minted JSON artifact or a legacy bare token. Faults are classified from parsed
 * structure, never from another error's display text. No input value is copied into an error.
 */
export function parseAgentCredentialInput(
  value: string,
  source: AgentCredentialInputSource,
): AgentCredentialInput {
  // Bare credentials predate the artifact and remain valid for commands that do not need
  // artifact metadata. Test the complete grammar so arbitrary non-JSON text cannot take this
  // compatibility path.
  if (AGENT_TOKEN_RE.test(value)) {
    return {
      token: value,
      principalId: null,
      tokenId: null,
      runId: null,
      expiresAt: null,
      durable: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw credentialInputError(
      "agent_credential_invalid_json",
      source,
      "contains text that is not valid JSON",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw credentialInputError(
      "agent_credential_not_object",
      source,
      `contains ${jsonKind(parsed)} instead of a JSON object`,
    );
  }

  const artifact = parsed as Record<string, unknown>;
  if (!Object.hasOwn(artifact, "agent_token")) {
    throw credentialInputError(
      "agent_credential_missing_agent_token",
      source,
      'is missing "agent_token"',
    );
  }
  if (typeof artifact.agent_token !== "string" ||
      !AGENT_TOKEN_RE.test(artifact.agent_token)) {
    const found = typeof artifact.agent_token === "string"
      ? 'has "agent_token" as a string that is not a swm_agt_ credential'
      : `has "agent_token" as ${jsonKind(artifact.agent_token)}`;
    throw credentialInputError(
      "agent_credential_invalid_agent_token",
      source,
      found,
    );
  }

  const actualKeys = Object.keys(artifact);
  const missingKeys = REQUIRED_ARTIFACT_KEYS.filter((key) =>
    !Object.hasOwn(artifact, key)
  );
  const unknownCount = actualKeys.filter((key) =>
    !ALLOWED_ARTIFACT_KEYS.has(key)
  ).length;
  const invalidKeys: string[] = [];
  if (Object.hasOwn(artifact, "message") &&
      !ACCEPTED_AGENT_CREDENTIAL_MESSAGES.includes(artifact.message as string)) {
    invalidKeys.push("message");
  }
  if (Object.hasOwn(artifact, "status") && artifact.status !== "accepted") {
    invalidKeys.push("status");
  }
  for (const key of ["principal_id", "token_id", "run_id"] as const) {
    if (Object.hasOwn(artifact, key) &&
        (typeof artifact[key] !== "string" || !UUID_RE.test(artifact[key]))) {
      invalidKeys.push(key);
    }
  }
  if (artifact.expires_at !== undefined) {
    if (typeof artifact.expires_at !== "string" ||
        Number.isNaN(Date.parse(artifact.expires_at))) {
      invalidKeys.push("expires_at");
    }
  }
  if (missingKeys.length > 0 || unknownCount > 0 || invalidKeys.length > 0) {
    const faults: string[] = [];
    if (unknownCount > 0) {
      faults.push(`has ${unknownCount} unrecognized ${unknownCount === 1 ? "field" : "fields"}`);
    }
    if (missingKeys.length > 0) {
      faults.push(`is missing required ${missingKeys.length === 1 ? "field" : "fields"} ${missingKeys.map((key) => `"${key}"`).join(", ")}`);
    }
    if (invalidKeys.length > 0) {
      faults.push(`has invalid ${invalidKeys.length === 1 ? "field" : "fields"} ${invalidKeys.map((key) => `"${key}"`).join(", ")}`);
    }
    throw credentialInputError(
      "agent_credential_fields_invalid",
      source,
      faults.join(" and "),
    );
  }

  const expiresAt = artifact.expires_at === undefined
    ? null
    : Date.parse(artifact.expires_at as string);
  return {
    token: artifact.agent_token,
    principalId: (artifact.principal_id as string).toLowerCase(),
    tokenId: (artifact.token_id as string).toLowerCase(),
    runId: (artifact.run_id as string).toLowerCase(),
    expiresAt,
    durable: true,
  };
}
