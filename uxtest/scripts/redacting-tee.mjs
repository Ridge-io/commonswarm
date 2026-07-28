#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const [outputPath, terminalStream] = process.argv.slice(2);
if (!outputPath || !["stdout", "stderr"].includes(terminalStream)) {
  throw new Error("usage: redacting-tee.mjs <output-path> <stdout|stderr>");
}

const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  const value = Buffer.from(chunk);
  process[terminalStream].write(value);
  chunks.push(value);
  bytes += value.length;
  if (bytes > 256 * 1024) {
    chunks.shift();
    bytes = chunks.reduce((total, item) => total + item.length, 0);
  }
}

function isInvitePayload(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 16 * 1024) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) return false;
    const parsed = JSON.parse(decoded.toString("utf8"));
    return parsed?.v === 1 &&
      typeof parsed.url === "string" &&
      typeof parsed.anon_key === "string" &&
      typeof parsed.workspace_id === "string" &&
      typeof parsed.invitation_token === "string" &&
      typeof parsed.workspace_name === "string" &&
      typeof parsed.inviter_display_name === "string";
  } catch {
    return false;
  }
}

function redact(value) {
  let redacted = value
    .replace(
      /\b(?:cswarm|coswarm):\/\/accept\/([A-Za-z0-9_-]+)/g,
      "[INVITE LINK REDACTED]",
    )
    .replace(
      /\bswm_inv_[A-Za-z0-9_-]{43}\b/g,
      "[INVITE TOKEN REDACTED]",
    )
    .replace(
      /\bswm_agt_[A-Za-z0-9_-]+\b/g,
      "[AGENT TOKEN REDACTED]",
    );
  redacted = redacted.replace(
    /\b[A-Za-z0-9_-]{20,16384}\b/g,
    (candidate) => isInvitePayload(candidate)
      ? "[INVITE LINK REDACTED]"
      : candidate,
  );
  return redacted.replace(
    /\beyJ[A-Za-z0-9._-]{20,}\b/g,
    "[TOKEN REDACTED]",
  );
}

const buffered = Buffer.concat(chunks).toString("utf8");
writeFileSync(outputPath, redact(buffered).slice(-20_000), { mode: 0o600 });
