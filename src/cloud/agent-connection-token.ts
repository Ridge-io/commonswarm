import { AgentSetupError, ONBOARDING_UUID } from "./agent-profile.js";
import { parseAgentCredentialInput } from "./agent-credential-input.js";
import {
  AGENT_CONNECTION_FIELDS,
  AGENT_CONNECTION_VERSION,
  type AgentConnectionEnvelope,
} from "./agent-onboarding-contract.js";
import { cloudTarget, type CloudTarget } from "./config.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const TOKEN_VERSION = "A";
export const TOKEN_PREFIX = `CSWARM${TOKEN_VERSION}`;
export const TOKEN_MARKER = `${TOKEN_PREFIX}.`;

const REPAIR_USE_SETUP_FILE =
  "Use ‘Use a setup file’ in CommonSwarm and run setup with that file. Do not edit credentials or paste them into chat.";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(s: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s) {
    const i = BASE32_ALPHABET.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const x of bytes) {
    c ^= x;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
  }
  return (~c) >>> 0;
}

function crc32Bytes(crc: number): Uint8Array {
  return Uint8Array.from([24, 16, 8, 0].map((shift) => (crc >>> shift) & 255));
}

export function isAgentConnectionToken(raw: string): boolean {
  const cleaned = raw.toUpperCase().replace(/[^A-Z2-7.]/g, "");
  return cleaned.includes("CSWARM");
}

export function encodeAgentConnectionToken(
  envelope: AgentConnectionEnvelope | Record<string, unknown> | string,
): string {
  const json = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
  const bytes = new TextEncoder().encode(json);
  const crc = crc32(bytes);
  const crcB = crc32Bytes(crc);
  return `${TOKEN_MARKER}${base32Encode(bytes)}.${base32Encode(crcB)}`;
}

function checkedTarget(url: string, anonKey: string): CloudTarget {
  try {
    const target = cloudTarget(url, anonKey);
    const parsed = new URL(target.url);
    if (parsed.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error();
    if (anonKey.length > 4096 || /[\u0000-\u0020\u007f]/.test(anonKey)) throw new Error();
    return target;
  } catch {
    throw new AgentSetupError("connection_target_invalid", "Use an HTTPS deployment origin and its public key. HTTP is allowed only for local tests.");
  }
}

export function validateAgentConnectionEnvelope(
  value: unknown,
): AgentConnectionEnvelope {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    (value as Record<string, unknown>).version !== AGENT_CONNECTION_VERSION ||
    Object.keys(value).length !== AGENT_CONNECTION_FIELDS.length ||
    AGENT_CONNECTION_FIELDS.some((key) => !Object.hasOwn(value as Record<string, unknown>, key)) ||
    typeof (value as Record<string, unknown>).url !== "string" ||
    typeof (value as Record<string, unknown>).anon_key !== "string" ||
    typeof (value as Record<string, unknown>).workspace_id !== "string" ||
    !ONBOARDING_UUID.test((value as Record<string, unknown>).workspace_id as string) ||
    typeof (value as Record<string, unknown>).principal_id !== "string" ||
    !ONBOARDING_UUID.test((value as Record<string, unknown>).principal_id as string) ||
    !(value as Record<string, unknown>).credential ||
    typeof (value as Record<string, unknown>).credential !== "object" ||
    Array.isArray((value as Record<string, unknown>).credential)
  ) {
    throw new AgentSetupError(
      "connection_invalid",
      `Expected connection version ${AGENT_CONNECTION_VERSION} with fields: ${AGENT_CONNECTION_FIELDS.join(", ")}. Save the supplied file unchanged.`,
    );
  }
  const obj = value as Record<string, unknown>;
  if (/^\s*\[[\s\S]*\]\(/.test(obj.url as string)) {
    throw new AgentSetupError(
      "connection_target_invalid",
      `The connection URL appears to be a Markdown link. ${REPAIR_USE_SETUP_FILE}`,
    );
  }
  const target = checkedTarget(obj.url as string, obj.anon_key as string);
  const agent = parseAgentCredentialInput(JSON.stringify(obj.credential), {
    kind: "stdin",
  });
  if (
    !agent.durable ||
    agent.principalId !== (obj.principal_id as string).toLowerCase()
  ) {
    throw new AgentSetupError(
      "connection_identity_mismatch",
      "The connection and credential name different agents. Ask for a new connection file.",
    );
  }
  return {
    version: AGENT_CONNECTION_VERSION,
    url: target.url,
    anon_key: target.anonKey,
    workspace_id: (obj.workspace_id as string).toLowerCase(),
    principal_id: agent.principalId,
    credential: obj.credential as Record<string, unknown>,
  };
}

export function decodeAgentConnectionToken(raw: string): AgentConnectionEnvelope {
  const cleaned = raw.toUpperCase().replace(/[^A-Z2-7.]/g, "");
  const at = cleaned.indexOf(TOKEN_MARKER);
  if (at < 0) {
    throw new AgentSetupError(
      "token_marker_missing",
      `The connection token is missing its marker. ${REPAIR_USE_SETUP_FILE}`,
    );
  }
  const parts = cleaned.slice(at).split(".").filter(Boolean);
  if (
    parts.length < 3 ||
    parts[0] !== TOKEN_PREFIX ||
    parts[1].length === 0 ||
    parts[2].length === 0
  ) {
    throw new AgentSetupError(
      "token_shape_invalid",
      `The connection token format is invalid. ${REPAIR_USE_SETUP_FILE}`,
    );
  }
  const body = base32Decode(parts[1]);
  const want = base32Decode(parts[2]);
  if (want.length < 4) {
    throw new AgentSetupError(
      "token_checksum_invalid",
      `The connection token checksum did not match. ${REPAIR_USE_SETUP_FILE}`,
    );
  }
  const got = crc32(body);
  const wantN =
    ((want[0] << 24) | (want[1] << 16) | (want[2] << 8) | want[3]) >>> 0;
  if (got !== wantN) {
    throw new AgentSetupError(
      "token_checksum_invalid",
      `The connection token checksum did not match. ${REPAIR_USE_SETUP_FILE}`,
    );
  }
  let jsonString: string;
  try {
    jsonString = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new AgentSetupError(
      "token_payload_invalid",
      `The connection token payload is damaged. ${REPAIR_USE_SETUP_FILE}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new AgentSetupError(
      "token_payload_invalid",
      `The connection token payload is damaged. ${REPAIR_USE_SETUP_FILE}`,
    );
  }
  return validateAgentConnectionEnvelope(parsed);
}
