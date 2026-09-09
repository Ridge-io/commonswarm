import type { AgentConnectionEnvelope } from "./agent-onboarding-contract.js";

export const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const TOKEN_VERSION = "A";
export const TOKEN_PREFIX = `CSWARM${TOKEN_VERSION}`;
export const TOKEN_MARKER = `${TOKEN_PREFIX}.`;

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

export function crc32Bytes(crc: number): Uint8Array {
  return Uint8Array.from([24, 16, 8, 0].map((shift) => (crc >>> shift) & 255));
}

export function normalizeTokenCandidate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z2-7.]/g, "");
}

export function isAgentConnectionToken(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return false;
  const cleaned = normalizeTokenCandidate(trimmed);
  return cleaned.includes(TOKEN_MARKER);
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
