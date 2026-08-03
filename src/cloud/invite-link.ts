import { timingSafeEqual } from "node:crypto";
import {
  assertInvitationToken,
  INVITATION_TOKEN_RE,
} from "./command-client.js";
import { cloudTarget, type CloudTarget } from "./config.js";

const MAX_LINK_PAYLOAD_BYTES = 8 * 1024;
const MAX_LABEL_INPUT_LENGTH = 1_024;
const CONTROL_GLOBAL_RE =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const ANSI_ESCAPE_GLOBAL_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRICT_BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const RAW_BASE64_PAYLOAD_CANDIDATE_RE = /^[A-Za-z0-9+/_=-]+$/;
const CURRENT_INVITE_SCHEME = "cswarm://accept/";
const RETIRED_INVITE_SCHEME = "coswarm://accept/";
const INVITE_WRAPPER_ERROR =
  "invite link wrapper is not recognized; use https://commonswarm.com/invite#invite=<payload> or cswarm://accept/<payload>";
const ACCEPT_INPUT_ERROR =
  "accept input was not recognized; use an https://...#invite=<payload> link, cswarm://accept/<payload>, or a swm_inv_ invitation capability";

export const PRODUCTION_CLOUD_ORIGIN =
  "https://ukezjcnxjvkpkeezxaew.supabase.co";

export interface InviteLinkPayload {
  v: 1;
  url: string;
  anon_key: string;
  workspace_id: string;
  invitation_token: string;
  workspace_name: string;
  inviter_display_name: string;
  inviter_user_id?: string;
}

export type ParsedAcceptInput =
  | { mode: "token"; token: string }
  | { mode: "link"; payload: InviteLinkPayload };

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function strictDecodedPayload(encoded: string): Record<string, unknown> {
  if (
    !encoded ||
    encoded.length > MAX_LINK_PAYLOAD_BYTES * 2 ||
    !STRICT_BASE64URL_RE.test(encoded)
  ) {
    throw new Error("invite link payload must be strict unpadded base64url");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (
    decoded.length === 0 ||
    decoded.length > MAX_LINK_PAYLOAD_BYTES ||
    decoded.toString("base64url") !== encoded
  ) {
    throw new Error("invite link payload must be strict unpadded base64url");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error("invite link payload is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invite link payload must be an object");
  }
  return value as Record<string, unknown>;
}

function validatedPayload(value: Record<string, unknown>): InviteLinkPayload {
  const required = [
    "v",
    "url",
    "anon_key",
    "workspace_id",
    "invitation_token",
    "workspace_name",
    "inviter_display_name",
  ] as const;
  if (!exactKeys(value, required, ["inviter_user_id"]) || value.v !== 1) {
    throw new Error("invite link payload must use version 1 and all required fields");
  }
  if (
    typeof value.url !== "string" ||
    typeof value.anon_key !== "string" ||
    value.anon_key.length < 1 ||
    value.anon_key.length > 4_096 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value.anon_key)
  ) {
    throw new Error("invite link target is malformed");
  }
  cloudTarget(value.url, value.anon_key);
  if (typeof value.workspace_id !== "string" || !UUID_RE.test(value.workspace_id)) {
    throw new Error("invite link workspace_id must be a UUID");
  }
  if (typeof value.invitation_token !== "string") {
    throw new Error("invite link invitation_token is malformed");
  }
  assertInvitationToken(value.invitation_token);
  if (
    typeof value.workspace_name !== "string" ||
    typeof value.inviter_display_name !== "string" ||
    value.workspace_name.length > MAX_LABEL_INPUT_LENGTH ||
    value.inviter_display_name.length > MAX_LABEL_INPUT_LENGTH
  ) {
    throw new Error("invite link display labels are malformed");
  }
  if (
    value.inviter_user_id !== undefined &&
    (typeof value.inviter_user_id !== "string" ||
      !UUID_RE.test(value.inviter_user_id))
  ) {
    throw new Error("invite link inviter_user_id must be a UUID");
  }
  return value as unknown as InviteLinkPayload;
}

export function sanitizeDisplayLabel(
  value: string,
  fallback: string,
): string {
  const cleaned = value
    .replace(ANSI_ESCAPE_GLOBAL_RE, "")
    .replace(CONTROL_GLOBAL_RE, "")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

export function sanitizePrincipalName(
  value: string,
  options: { truncate?: boolean } = {},
): string {
  const cleaned = value
    .replace(ANSI_ESCAPE_GLOBAL_RE, "")
    .replace(CONTROL_GLOBAL_RE, "")
    .toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) {
    throw new Error("agent identity name must contain a-z, 0-9, dot, underscore, @, or hyphen");
  }
  if (cleaned.length > 80 && !options.truncate) {
    throw new Error("agent identity name must be at most 80 characters");
  }
  const bounded = cleaned.slice(0, 80).replace(/-+$/g, "");
  if (!bounded) throw new Error("agent identity name is empty after sanitization");
  return bounded;
}

export function validateExplicitPrincipalName(value: string): string {
  const stripped = value
    .replace(ANSI_ESCAPE_GLOBAL_RE, "")
    .replace(CONTROL_GLOBAL_RE, "");
  if (
    stripped !== value ||
    value.length < 1 ||
    value.length > 80 ||
    !/^[a-z0-9._@-]+$/.test(value)
  ) {
    throw new Error(
      "--name must be unchanged by sanitization, use only a-z, 0-9, dot, underscore, @, or hyphen, and be at most 80 characters",
    );
  }
  return value;
}

export function encodeInviteLink(payload: InviteLinkPayload): string {
  const validated = validatedPayload(payload as unknown as Record<string, unknown>);
  const encoded = Buffer.from(JSON.stringify(validated), "utf8").toString("base64url");
  if (Buffer.byteLength(JSON.stringify(validated), "utf8") > MAX_LINK_PAYLOAD_BYTES) {
    throw new Error("invite link payload is too large");
  }
  return `${CURRENT_INVITE_SCHEME}${encoded}`;
}

function encodedInvitePayload(value: string): string {
  for (const scheme of [CURRENT_INVITE_SCHEME, RETIRED_INVITE_SCHEME]) {
    if (value.startsWith(scheme)) return value.slice(scheme.length);
  }
  if (/^https?:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(INVITE_WRAPPER_ERROR);
    }
    for (const parameter of parsed.hash.slice(1).split("&")) {
      const separator = parameter.indexOf("=");
      const name = separator === -1 ? parameter : parameter.slice(0, separator);
      if (name === "invite") {
        return separator === -1 ? "" : parameter.slice(separator + 1);
      }
    }
    throw new Error(INVITE_WRAPPER_ERROR);
  }
  if (RAW_BASE64_PAYLOAD_CANDIDATE_RE.test(value)) return value;
  throw new Error(INVITE_WRAPPER_ERROR);
}

export function decodeInviteLink(value: string): InviteLinkPayload {
  const encoded = encodedInvitePayload(value);
  return validatedPayload(strictDecodedPayload(encoded));
}

export function parseAcceptPositional(value: string): ParsedAcceptInput {
  if (INVITATION_TOKEN_RE.test(value)) {
    return { mode: "token", token: value };
  }
  if (
    value.startsWith(CURRENT_INVITE_SCHEME) ||
    value.startsWith(RETIRED_INVITE_SCHEME) ||
    /^https?:\/\//i.test(value)
  ) {
    return { mode: "link", payload: decodeInviteLink(value) };
  }
  if (STRICT_BASE64URL_RE.test(value)) {
    try {
      return { mode: "link", payload: decodeInviteLink(value) };
    } catch {
      // Raw base64url is accepted only when it is a complete v1 payload.
    }
  }
  throw new Error(`${ACCEPT_INPUT_ERROR}; use --link-stdin to keep the link out of shell history`);
}

function loopback(target: CloudTarget): boolean {
  const hostname = new URL(target.url).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function devOrigins(value: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const entry of value?.split(",") ?? []) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      origins.add(cloudTarget(trimmed, "dev-only-placeholder").url);
    } catch {
      throw new Error("CSWARM_DEV_ALLOWED_ORIGINS contains an invalid origin");
    }
  }
  return origins;
}

function equalExact(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  const length = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  const equal = timingSafeEqual(paddedLeft, paddedRight);
  return equal && left.length === right.length;
}

export interface OriginPinOptions {
  interactive: boolean;
  output: { write(value: string): unknown };
  readConfirmation?: () => Promise<string>;
  devAllowedOrigins?: string;
}

export async function requirePinnedOrigin(
  target: CloudTarget,
  options: OriginPinOptions,
): Promise<void> {
  if (target.url === PRODUCTION_CLOUD_ORIGIN || loopback(target)) return;
  if (
    options.interactive &&
    devOrigins(options.devAllowedOrigins).has(target.url)
  ) {
    return;
  }
  const host = sanitizeDisplayLabel(new URL(target.url).host, "unknown host");
  if (!options.interactive || !options.readConfirmation) {
    throw new Error(
      `invite link targets unrecognized Cloud host ${host}; non-interactive mode refuses before login`,
    );
  }
  options.output.write(
    `This invitation targets the unrecognized Cloud origin ${target.url}. Re-type that exact origin to continue:\n`,
  );
  const confirmation = (await options.readConfirmation()).trim();
  if (!equalExact(confirmation, target.url)) {
    throw new Error(`origin confirmation did not exactly match ${host}; refusing before login`);
  }
}
