/**
 * Browser-safe teammate invitation links.
 *
 * The invitation capability stays in the URL fragment until this module moves
 * it into a browser-local resume record. It never enters a request URL,
 * referrer, analytics event, or server-rendered page.
 */

export interface MemberInvitePayload {
  v: 1;
  url: string;
  anon_key: string;
  workspace_id: string;
  invitation_token: string;
  workspace_name: string;
  inviter_display_name: string;
  inviter_user_id?: string;
}

const MAX_PAYLOAD_BYTES = 8 * 1024;
const MAX_LABEL_INPUT = 1_024;
const STRICT_BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITATION_TOKEN_RE = /^swm_inv_[A-Za-z0-9_-]{43}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_GLOBAL_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const RESUME_PREFIX = "commonswarm:invite-resume:";

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

/** Removes control and bidi characters before untrusted labels reach the DOM. */
export function inviteLabel(value: string, fallback: string): string {
  return value.replace(CONTROL_GLOBAL_RE, "").trim().slice(0, 120) || fallback;
}

function validateOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Invite deployment URL is malformed.");
  }
  return parsed.origin;
}

/** Strictly validates the version-one payload shared with the CLI. */
export function validateMemberInvite(value: unknown): MemberInvitePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invite payload is not an object.");
  }
  const record = value as Record<string, unknown>;
  const required = [
    "v",
    "url",
    "anon_key",
    "workspace_id",
    "invitation_token",
    "workspace_name",
    "inviter_display_name",
  ] as const;
  if (!exactKeys(record, required, ["inviter_user_id"]) || record.v !== 1) {
    throw new Error("Invite payload is incomplete.");
  }
  if (
    typeof record.url !== "string" ||
    typeof record.anon_key !== "string" ||
    record.anon_key.length < 1 ||
    record.anon_key.length > 4_096 ||
    CONTROL_RE.test(record.anon_key)
  ) {
    throw new Error("Invite deployment is malformed.");
  }
  validateOrigin(record.url);
  if (typeof record.workspace_id !== "string" || !UUID_RE.test(record.workspace_id)) {
    throw new Error("Invite workspace is malformed.");
  }
  if (
    typeof record.invitation_token !== "string" ||
    !INVITATION_TOKEN_RE.test(record.invitation_token)
  ) {
    throw new Error("Invite credential is malformed.");
  }
  if (
    typeof record.workspace_name !== "string" ||
    typeof record.inviter_display_name !== "string" ||
    record.workspace_name.length > MAX_LABEL_INPUT ||
    record.inviter_display_name.length > MAX_LABEL_INPUT
  ) {
    throw new Error("Invite labels are malformed.");
  }
  if (
    record.inviter_user_id !== undefined &&
    (typeof record.inviter_user_id !== "string" || !UUID_RE.test(record.inviter_user_id))
  ) {
    throw new Error("Invite sender is malformed.");
  }
  return {
    v: 1,
    url: record.url,
    anon_key: record.anon_key,
    workspace_id: record.workspace_id,
    invitation_token: record.invitation_token,
    workspace_name: inviteLabel(record.workspace_name, "a CommonSwarm workspace"),
    inviter_display_name: inviteLabel(record.inviter_display_name, "A teammate"),
    ...(record.inviter_user_id === undefined
      ? {}
      : { inviter_user_id: record.inviter_user_id }),
  };
}

function encodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBytes(value: string): Uint8Array {
  if (!value || !STRICT_BASE64URL_RE.test(value) || value.length > MAX_PAYLOAD_BYTES * 2) {
    throw new Error("Invite payload is not strict base64url.");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Invite payload is not strict base64url.");
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_PAYLOAD_BYTES ||
    encodeBytes(bytes) !== value
  ) {
    throw new Error("Invite payload is not strict base64url.");
  }
  return bytes;
}

/** Encodes only the payload; callers decide whether it belongs in a CLI or web link. */
export function encodeMemberInvite(payload: MemberInvitePayload): string {
  const validated = validateMemberInvite(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(validated));
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) throw new Error("Invite payload is too large.");
  return encodeBytes(bytes);
}

/** Decodes a strict version-one payload and rejects non-canonical encodings. */
export function decodeMemberInvite(encoded: string): MemberInvitePayload {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBytes(encoded)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invite payload")) throw error;
    throw new Error("Invite payload is not valid JSON.");
  }
  return validateMemberInvite(value);
}

/** Builds the shareable web link without ever putting the capability in a query string. */
export function memberInviteUrl(siteOrigin: string, payload: MemberInvitePayload): string {
  const invite = new URL("/invite", siteOrigin);
  invite.hash = `invite=${encodeMemberInvite(payload)}`;
  return invite.toString();
}

/** Refuses links minted for a different CommonSwarm deployment. */
export function assertInviteDeployment(
  payload: MemberInvitePayload,
  expected: { url: string; anonKey: string },
): void {
  if (payload.url !== validateOrigin(expected.url) || payload.anon_key !== expected.anonKey) {
    throw new Error("This invitation belongs to a different CommonSwarm deployment.");
  }
}

/** Saves a credential-bearing payload under an unguessable id for an auth redirect. */
export function rememberInvite(
  payload: MemberInvitePayload,
  storage: Storage,
  resumeId = crypto.randomUUID(),
): string {
  if (!UUID_RE.test(resumeId)) throw new Error("Invite resume id is malformed.");
  storage.setItem(`${RESUME_PREFIX}${resumeId}`, JSON.stringify(validateMemberInvite(payload)));
  return resumeId;
}

/** Reads and revalidates a browser-local resume record. */
export function recalledInvite(resumeId: string, storage: Storage): MemberInvitePayload | null {
  if (!UUID_RE.test(resumeId)) return null;
  const raw = storage.getItem(`${RESUME_PREFIX}${resumeId}`);
  if (!raw) return null;
  try {
    return validateMemberInvite(JSON.parse(raw));
  } catch {
    forgetInvite(resumeId, storage);
    return null;
  }
}

/** Erases a credential-bearing resume record after acceptance or terminal failure. */
export function forgetInvite(resumeId: string, storage: Storage): void {
  if (UUID_RE.test(resumeId)) storage.removeItem(`${RESUME_PREFIX}${resumeId}`);
}
