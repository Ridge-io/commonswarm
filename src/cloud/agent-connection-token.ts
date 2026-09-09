import { parseAgentCredentialInput } from "./agent-credential-input.js";
import {
  AGENT_CONNECTION_FIELDS,
  AGENT_CONNECTION_VERSION,
  type AgentConnectionEnvelope,
  AgentSetupError,
  ONBOARDING_UUID,
} from "./agent-onboarding-contract.js";
import {
  BASE32_ALPHABET,
  TOKEN_VERSION,
  TOKEN_PREFIX,
  TOKEN_MARKER,
  base32Encode,
  base32Decode,
  crc32,
  crc32Bytes,
  encodeAgentConnectionToken,
  normalizeTokenCandidate,
  isAgentConnectionToken,
} from "./agent-connection-codec.js";
import { cloudTarget, type CloudTarget } from "./config.js";

export {
  BASE32_ALPHABET,
  TOKEN_VERSION,
  TOKEN_PREFIX,
  TOKEN_MARKER,
  base32Encode,
  base32Decode,
  crc32,
  crc32Bytes,
  encodeAgentConnectionToken,
  normalizeTokenCandidate,
  isAgentConnectionToken,
};

const REPAIR_USE_SETUP_FILE =
  "Use ‘Use a setup file’ in CommonSwarm and run setup with that file. Do not edit credentials or paste them into chat.";

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
  if (typeof raw !== "string") {
    throw new AgentSetupError(
      "token_marker_missing",
      `The connection token is missing its marker. ${REPAIR_USE_SETUP_FILE}`,
    );
  }

  const markerRegex =
    /C[\s\*\_\\\`]*S[\s\*\_\\\`]*W[\s\*\_\\\`]*A[\s\*\_\\\`]*R[\s\*\_\\\`]*M[\s\*\_\\\`]*A[\s\*\_\\\`]*\./i;
  const match = raw.match(markerRegex);
  if (!match || match.index === undefined) {
    throw new AgentSetupError(
      "token_marker_missing",
      `The connection token is missing its marker. ${REPAIR_USE_SETUP_FILE}`,
    );
  }

  const markerStart = match.index;
  const afterMarker = raw.slice(markerStart + match[0].length);

  let bodyChars = "";
  let crcChars = "";
  let inCrc = false;
  let crcBase32Count = 0;
  let tokenEnd = -1;
  const extraParts: string[] = [];

  for (let i = 0; i < afterMarker.length; i++) {
    const ch = afterMarker[i]!;
    if (ch === ".") {
      if (!inCrc) {
        inCrc = true;
        continue;
      } else {
        extraParts.push("");
        continue;
      }
    }

    const upper = ch.toUpperCase();
    const isBase32 = BASE32_ALPHABET.includes(upper);

    if (extraParts.length > 0) {
      if (isBase32) {
        extraParts[extraParts.length - 1] += upper;
      }
      continue;
    }

    if (!inCrc) {
      if (isBase32) {
        bodyChars += upper;
      }
    } else {
      if (isBase32) {
        crcChars += upper;
        crcBase32Count++;
        if (crcBase32Count === 7) {
          let nextNonFormat: string | null = null;
          for (let j = i + 1; j < afterMarker.length; j++) {
            const cj = afterMarker[j]!;
            if (/[\*\_\\\`]/.test(cj)) continue;
            nextNonFormat = cj;
            break;
          }
          if (nextNonFormat === null || /[\s\)\]\>\'\"\`]/.test(nextNonFormat)) {
            tokenEnd = markerStart + match[0].length + i + 1;
            break;
          }
        }
      }
    }
  }

  let parts: string[];
  if (tokenEnd !== -1 && extraParts.length === 0) {
    parts = [TOKEN_PREFIX, bodyChars, crcChars];
  } else {
    if (extraParts.length > 0) {
      parts = [TOKEN_PREFIX, bodyChars, crcChars, ...extraParts];
    } else {
      parts = [TOKEN_PREFIX, bodyChars, crcChars];
    }
  }

  if (
    parts.length !== 3 ||
    parts[0] !== TOKEN_PREFIX ||
    parts[1].length === 0 ||
    parts[2].length === 0
  ) {
    throw new AgentSetupError(
      "token_shape_invalid",
      `The connection token format is invalid. ${REPAIR_USE_SETUP_FILE}`,
    );
  }

  if (parts[2].length !== 7) {
    throw new AgentSetupError(
      "token_checksum_invalid",
      `The connection token checksum did not match. ${REPAIR_USE_SETUP_FILE}`,
    );
  }

  const body = base32Decode(parts[1]);
  const want = base32Decode(parts[2]);

  if (want.length !== 4) {
    throw new AgentSetupError(
      "token_checksum_invalid",
      `The connection token checksum did not match. ${REPAIR_USE_SETUP_FILE}`,
    );
  }

  if (base32Encode(want) !== parts[2] || base32Encode(body) !== parts[1]) {
    throw new AgentSetupError(
      "token_checksum_invalid",
      `The connection token checksum did not match. ${REPAIR_USE_SETUP_FILE}`,
    );
  }

  const got = crc32(body);
  const wantN =
    ((want[0]! << 24) | (want[1]! << 16) | (want[2]! << 8) | want[3]!) >>> 0;
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
