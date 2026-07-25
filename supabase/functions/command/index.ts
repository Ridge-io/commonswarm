import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import postgres from "npm:postgres@3.4.9";
import {
  agentCredentialRevoked,
  loadAgentCredential,
  type AgentAuthRow,
} from "../_shared/agent-auth.ts";
// Supabase's edge graph cannot resolve the NodeNext `.js` specifiers in the
// frozen TypeScript core. This checked-in bundle is regenerated directly from
// src/protocol/index.ts by build:command-core; it is not a second implementation.
import {
  applyCommand,
  canonicalPrincipal,
  decideWorkspace,
  DISPOSITIONS,
  reduceTask,
  reduceWorkspace,
  requestHash,
} from "../_shared/protocol.js";

interface Actor {
  user: string | null;
  agent_principal: string | null;
  run: string | null;
}

type Command =
  | { kind: "create"; task_id: string; slug: string }
  | { kind: "acquire"; task_id: string; ttl_ms: number }
  | { kind: "renew"; task_id: string; epoch: number; ttl_ms: number }
  | {
    kind: "handoff";
    task_id: string;
    epoch: number;
    to_owner: string;
    ttl_ms: number;
  }
  | {
    kind: "takeover";
    task_id: string;
    grant_id: string | null;
    ttl_ms: number;
  }
  | {
    kind: "submit";
    task_id: string;
    epoch: number;
    branch: string;
    head_sha: string;
    evidence_set: string[];
  }
  | {
    kind: "close";
    task_id: string;
    epoch: number;
    disposition: "merged" | "pr" | "archive" | "discard";
    grant_id: string | null;
  }
  | { kind: "reopen"; task_id: string; epoch: number };

type ConnectCommand =
  | { kind: "invite_member"; email: string; ttl_ms?: number }
  | { kind: "accept_invitation"; token: string }
  | { kind: "create_agent_principal"; name: string }
  | {
    kind: "mint_agent_token";
    principal_id: string;
    run_id: string;
    task_id: string;
    epoch: number;
    ttl_ms?: number;
    device_id: string;
    scopes?: string[];
  };

type SignalKind = "working-on" | "note" | "ask";

interface SignalCommand {
  kind: "post_signal";
  signal_kind: SignalKind;
  body: string;
  to_user_id: string | null;
  about: string | null;
  until_ms?: number;
}

interface SignalRecord {
  id: string;
  workspace_id: string;
  from: string;
  from_kind: CredentialKind;
  to: string | null;
  about: string | null;
  kind: SignalKind;
  body: string;
  until: string;
  created_at: string;
}

type ValidatedCommand = Command | ConnectCommand | SignalCommand;

type WorkspaceRole = "owner" | "admin" | "member";

interface WorkspaceState {
  workspace: {
    workspace_id: string;
    name: string;
    created_by: string;
    created_at: number;
    archived_at: number | null;
  };
  members: Record<string, {
    user_id: string;
    role: WorkspaceRole;
    invited_by: string | null;
    joined_at: number;
    revoked_at: number | null;
  }>;
  invitations: Record<string, {
    invitation_id: string;
    email: string | null;
    role: WorkspaceRole;
    token_hash: string;
    expires_at: number;
    created_by: string;
    created_at: number;
    consumed_at: number | null;
    consumed_by: string | null;
    revoked_at: number | null;
  }>;
  principals: Record<string, {
    principal_id: string;
    owner_user_id: string;
    name: string;
    created_at: number;
    revoked_at: number | null;
  }>;
  tokens: Record<string, {
    token_id: string;
    principal_id: string;
    run_id: string;
    task_id: string | null;
    epoch: number | null;
    scopes: string[];
    issued_at: number;
    expires_at: number;
    revoked_at: number | null;
  }>;
  owners_count: number;
}

type WorkspaceCommand =
  | {
    kind: "invite_member";
    invitation_id: string;
    email: string | null;
    role: WorkspaceRole;
    token_hash: string;
    expires_at: number;
  }
  | { kind: "accept_invitation"; token_hash: string }
  | { kind: "create_agent_principal"; principal_id: string; name: string }
  | {
    kind: "mint_agent_token";
    token_id: string;
    principal_id: string;
    run_id: string;
    task_id: string;
    epoch: number;
    scopes: string[];
    ttl_ms?: number;
  };

interface WorkspaceDecideCtx {
  now: number;
  actor: Actor;
  credential_kind: "human" | "agent";
  presenting_token_id: string | null;
  command_id: string;
  workspace_id: string;
  stream_id: string;
  operatorAllowed(actor: Actor): boolean;
  role(user_id: string): WorkspaceRole | null;
  inviteeAlreadyMember(email: string | null): boolean;
  identityVerified(user_id: string): boolean;
  humanRights(actor: Actor): readonly string[];
  landingAuthorityChangeResolved(
    target_user_id: string,
    successor_user_id: string | null,
  ): boolean;
  nextSeq(): number;
  nextEventId(): string;
}

interface StoredResponse {
  ok: boolean;
  reason?: string;
  detail?: string;
  class?: "authz" | "domain";
  event_ids: string[];
  invitation_id?: string;
  principal_id?: string;
  token_id?: string;
  run_id?: string;
  workspace_id?: string;
  signal?: SignalRecord;
}

interface EventEnvelope {
  workspace_id: string;
  stream_id: string;
  seq: number;
  event_id: string;
  command_id: string;
  type: string;
  schema_version: number;
  actor_user: string | null;
  actor_agent_principal: string | null;
  actor_run: string | null;
  occurred_at_server: number;
  payload: unknown;
}

interface TaskState {
  task_id: string;
  slug: string;
  lifecycle: "open" | "active" | "awaiting_review" | "reopened" | "done";
  version: number;
  epoch: number;
  owner: string | null;
  lease_expiry: number | null;
  submission: {
    epoch: number;
    branch: string;
    head_sha: string;
    evidence_set: string[];
  } | null;
  closed_disposition: string | null;
}

interface DecideCtx {
  now: number;
  actor: Actor;
  command_id: string;
  isMember(principal: string): boolean;
  role(principal: string): "owner" | "admin" | "member" | null;
  isEligibleRecipient(principal: string): boolean;
  claimRequiresGrant(task_id: string): boolean;
  evidenceComplete(task_id: string, evidence_set: readonly string[]): boolean;
  validTakeoverGrant(
    task_id: string,
    grant_id: string | null,
    epoch: number,
    recipient: string,
  ): boolean;
  validCloseGrant(
    task_id: string,
    grant_id: string | null,
    submission: { version: number; epoch: number; head_sha: string },
  ): boolean;
  slugTaken(slug: string): boolean;
  nextSeq(): number;
  nextEventId(): string;
  workspace_id: string;
  stream_id: string;
}

type Decision =
  | { ok: true; events: EventEnvelope[] }
  | {
    ok: false;
    class: "authz" | "domain";
    reason: string;
    detail: string;
    events: EventEnvelope[];
  };

interface FreshOutcome {
  status: "fresh";
  decision: Decision;
  response: StoredResponse;
  events: EventEnvelope[];
}

const MAX_BODY_BYTES = 128 * 1024;
const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
const MAX_TTL_MS = 4 * 60 * 60 * 1000;
const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const INVITATION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_TOKEN_MAX_TTL_MS = 8 * 60 * 60 * 1000;
const SIGNAL_MAX_UNTIL_MS = 30 * 24 * 60 * 60 * 1000;
const SIGNAL_DEFAULT_UNTIL_MS: Record<SignalKind, number> = {
  "working-on": 24 * 60 * 60 * 1000,
  ask: 7 * 24 * 60 * 60 * 1000,
  note: 30 * 24 * 60 * 60 * 1000,
};
const SIGNAL_CREDENTIAL_LIMIT = 120;
const SIGNAL_WORKSPACE_LIMIT = 1000;
const COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,72}$/;
const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const INVITATION_TOKEN_RE = /^swm_inv_[A-Za-z0-9_-]{43}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const CONTROL_RE =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_GLOBAL_RE =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const SIGNAL_UNSAFE_GLOBAL_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;
const SIGNAL_WHITESPACE_GLOBAL_RE = /[\t\n\v\f\r\u0085\u2028\u2029]+/gu;
const ANSI_ESCAPE_GLOBAL_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const REGISTER_DEVICE_KIND = "register_device";
const COMMAND_KINDS = [
  "create",
  "acquire",
  "renew",
  "handoff",
  "takeover",
  "submit",
  "close",
  "reopen",
  "invite_member",
  "accept_invitation",
  "create_agent_principal",
  "mint_agent_token",
  "post_signal",
] as const;
const TASK_COMMAND_KINDS = [
  "create",
  "acquire",
  "renew",
  "handoff",
  "takeover",
  "submit",
  "close",
  "reopen",
] as const;
const CONNECT_COMMAND_KINDS = [
  "invite_member",
  "accept_invitation",
  "create_agent_principal",
  "mint_agent_token",
] as const;
const P0_AGENT_SCOPES = [
  "create",
  "acquire",
  "renew",
  "handoff",
  "takeover",
  "submit",
  "close",
  "reopen",
  "post_signal",
] as const;

const databaseUrl =
  Deno.env.get("SWARM_DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
if (!databaseUrl || !supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "command function requires SWARM_DATABASE_URL/SUPABASE_DB_URL, SUPABASE_URL, and SUPABASE_ANON_KEY",
  );
}

const hookSleep = parseStepSleep(
  Deno.env.get("SWARM_CMD_TEST_SLEEP_AFTER_STEP"),
);
const hookRollback = parseStep(Deno.env.get("SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP"));
if (
  (hookSleep !== null || hookRollback !== null) &&
  Deno.env.get("SWARM_ENV") !== "test"
) {
  throw new Error("command test hooks refuse to run unless SWARM_ENV=test");
}

const db = postgres(databaseUrl, {
  max: 4,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
});
const authClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Sql = postgres.TransactionSql<Record<string, unknown>>;
type CredentialKind = "user" | "agent";
type Role = "owner" | "admin" | "member";

interface RequestBody {
  command_id?: unknown;
  client_version?: unknown;
  workspace_id?: unknown;
  stream?: unknown;
  command?: unknown;
  [key: string]: unknown;
}

interface AuthContext {
  credentialKind: CredentialKind;
  credentialId: string | null;
  deviceId: string | null;
  actor: Actor;
  agent: AgentAuthRow | null;
  identityVerified: boolean;
}

interface Route {
  workspaceId: string;
  streamId: string;
  membershipRole: Role | null;
  membershipRevokedAt: Date | null;
}

interface VerifiedHuman {
  userId: string;
  email: string | null;
  displayName: string;
  identityVerified: boolean;
}

interface PreparedWorkspace {
  wire: ConnectCommand;
  command: WorkspaceCommand;
  state: WorkspaceState;
  ctx: WorkspaceDecideCtx;
  invitationToken: string | null;
  invitationHash: Uint8Array | null;
  agentToken: string | null;
  agentTokenHash: Uint8Array | null;
  lineageId: string | null;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

interface Audit {
  auth: AuthContext;
  commandKind: string;
  workspaceId?: string | null;
  streamId?: string | null;
  outcome: string;
  reason?: string | null;
  detail?: string | null;
  hash?: string | null;
}

class TestRollback extends Error {
  constructor(readonly step: number) {
    super(`test rollback before step ${step}`);
  }
}

class LedgerRace extends Error {
  constructor(
    readonly auth: AuthContext,
    readonly commandId: string,
    readonly commandKind: string,
    readonly workspaceId: string,
    readonly streamId: string,
    readonly hash: string,
  ) {
    super("idempotency insert lost a concurrent race");
  }
}

function parseStep(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 15) {
    throw new Error("SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP must be an integer 1..15");
  }
  return value;
}

function parseStepSleep(
  raw: string | undefined,
): { step: number; milliseconds: number } | null {
  if (raw === undefined) return null;
  const match = /^(\d+):(\d+)$/.exec(raw);
  if (!match) {
    throw new Error(
      "SWARM_CMD_TEST_SLEEP_AFTER_STEP must have the form step:milliseconds",
    );
  }
  const step = Number(match[1]);
  const milliseconds = Number(match[2]);
  if (
    !Number.isInteger(step) || step < 1 || step > 15 ||
    !Number.isInteger(milliseconds) || milliseconds < 0 ||
    milliseconds > 60_000
  ) {
    throw new Error("invalid SWARM_CMD_TEST_SLEEP_AFTER_STEP");
  }
  return { step, milliseconds };
}

async function beforeStep(step: number): Promise<void> {
  if (hookRollback === step) throw new TestRollback(step);
}

async function afterStep(step: number): Promise<void> {
  if (hookSleep?.step === step) {
    await new Promise((resolve) => setTimeout(resolve, hookSleep.milliseconds));
  }
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stripControls(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.replace(CONTROL_GLOBAL_RE, "").slice(0, 2048);
}

function sanitizeSignalText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_GLOBAL_RE, "")
    .replace(SIGNAL_WHITESPACE_GLOBAL_RE, " ")
    .replace(SIGNAL_UNSAFE_GLOBAL_RE, "");
}

function displayLabel(value: string | null | undefined, fallback: string): string {
  const cleaned = stripControls(
    value?.replace(ANSI_ESCAPE_GLOBAL_RE, ""),
  )?.trim().slice(0, 120);
  return cleaned || fallback;
}

function commandKind(body: RequestBody | null): string {
  const command = record(body?.command);
  return typeof command?.kind === "string"
    ? stripControls(command.kind)?.slice(0, 64) || "unknown"
    : "unknown";
}

function forgedActorDetail(body: RequestBody): string | null {
  const forged = [
    "actor_user",
    "actor_agent_principal",
    "actor_run",
    "device",
    "device_id",
  ].filter((key) => Object.hasOwn(body, key));
  return forged.length === 0
    ? null
    : `ignored client-supplied identity fields: ${forged.join(",")}`;
}

async function readBody(
  request: Request,
): Promise<
  | { ok: true; body: RequestBody; byteLength: number }
  | { ok: false; response: Response }
> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: json(413, { error: "payload_too_large" }) };
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, response: json(400, { error: "invalid_request" }) };
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      return { ok: false, response: json(413, { error: "payload_too_large" }) };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const body = record(parsed);
    return body
      ? { ok: true, body, byteLength }
      : { ok: false, response: json(400, { error: "invalid_request" }) };
  } catch {
    return { ok: false, response: json(400, { error: "invalid_request" }) };
  }
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer ([^\s]+)$/.exec(header) : null;
  return match?.[1] ?? null;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("invalid SHA-256 hex");
  return new Uint8Array(
    value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
  );
}

function opaqueToken(prefix: "swm_inv_" | "swm_agt_"): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const binary = String.fromCharCode(...bytes);
  const encoded = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${prefix}${encoded}`;
}

async function setTransaction(tx: Sql): Promise<void> {
  await tx.unsafe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  await tx.unsafe("SET LOCAL ROLE swarm_command");
  await tx.unsafe("SET LOCAL search_path = swarm, pg_catalog");
  await tx.unsafe("SET LOCAL lock_timeout = '5s'");
}

async function insertAudit(tx: Sql, audit: Audit): Promise<void> {
  const auth = audit.auth;
  await tx`
    INSERT INTO swarm.audit_log (
      actor_user, actor_agent_principal, actor_run,
      credential_kind, credential_id, device_id,
      command_kind, workspace_id, stream_id,
      outcome, reason, detail, request_hash, ip
    ) VALUES (
      ${auth?.actor.user ?? null}::uuid,
      ${auth?.actor.agent_principal ?? null}::uuid,
      ${auth?.actor.run ?? null}::uuid,
      ${auth?.credentialKind ?? null},
      ${auth?.credentialId ?? null}::uuid,
      ${auth?.deviceId ?? null}::uuid,
      ${stripControls(audit.commandKind) ?? "unknown"},
      ${audit.workspaceId ?? null}::uuid,
      ${audit.streamId ?? null}::uuid,
      ${audit.outcome},
      ${stripControls(audit.reason)},
      ${stripControls(audit.detail)},
      ${audit.hash ?? null},
      NULL
    )
  `;
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${stripControls(error.message) ?? ""}`.slice(0, 512);
  }
  return "unknown error";
}

function logCommandFailure(
  event: "command_pre_auth_failure" | "command_request_failure",
  commandKind: string,
  outcome: string,
  reason: string,
  detail?: string,
): void {
  console.error(JSON.stringify({
    event,
    command_kind: stripControls(commandKind)?.slice(0, 64) || "unknown",
    outcome,
    reason,
    ...(detail === undefined ? {} : { detail: stripControls(detail) }),
  }));
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function boundedText(
  value: unknown,
  maximum: number,
  minimum = 1,
): value is string {
  return typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    !CONTROL_RE.test(value);
}

function normalizedEmail(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 320 ||
    CONTROL_RE.test(value)
  ) return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : null;
}

function nullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && UUID_RE.test(value));
}

function validateCommand(
  value: unknown,
): { ok: true; command: ValidatedCommand } | { ok: false; status: number; reason: string } {
  const cmd = record(value);
  if (!cmd || typeof cmd.kind !== "string") {
    return { ok: false, status: 400, reason: "invalid command shape" };
  }
  if (!(COMMAND_KINDS as readonly string[]).includes(cmd.kind)) {
    return { ok: false, status: 400, reason: "unknown command kind" };
  }

  if (cmd.kind === "post_signal") {
    if (Object.hasOwn(cmd, "from")) {
      return {
        ok: false,
        status: 400,
        reason: "client-supplied from is forbidden",
      };
    }
    const optionalKeys = Object.hasOwn(cmd, "until_ms") ? ["until_ms"] : [];
    const signalKinds: readonly SignalKind[] = ["working-on", "note", "ask"];
    const sanitizedBody = typeof cmd.body === "string"
      ? sanitizeSignalText(cmd.body)
      : "";
    const sanitizedAbout = typeof cmd.about === "string"
      ? sanitizeSignalText(cmd.about) || null
      : null;
    const valid = exactKeys(cmd, [
      "kind",
      "signal_kind",
      "body",
      "to_user_id",
      "about",
      ...optionalKeys,
    ]) &&
      typeof cmd.signal_kind === "string" &&
      signalKinds.includes(cmd.signal_kind as SignalKind) &&
      typeof cmd.body === "string" &&
      cmd.body.length >= 1 &&
      cmd.body.length <= 2000 &&
      sanitizedBody.length >= 1 &&
      nullableUuid(cmd.to_user_id) &&
      (
        cmd.signal_kind !== "working-on" ||
        cmd.to_user_id === null
      ) &&
      (
        cmd.about === null ||
        (
          typeof cmd.about === "string" &&
          cmd.about.length <= 500
        )
      ) &&
      (
        cmd.until_ms === undefined ||
        (
          integer(cmd.until_ms, 1) &&
          cmd.until_ms <= SIGNAL_MAX_UNTIL_MS
        )
      );
    return valid
      ? {
        ok: true,
        command: {
          kind: "post_signal",
          signal_kind: cmd.signal_kind as SignalKind,
          body: sanitizedBody,
          to_user_id: cmd.to_user_id as string | null,
          about: sanitizedAbout,
          ...(cmd.until_ms === undefined
            ? {}
            : { until_ms: cmd.until_ms as number }),
        },
      }
      : {
        ok: false,
        status: 400,
        reason: "signal fields are malformed or over their limits",
      };
  }

  if ((CONNECT_COMMAND_KINDS as readonly string[]).includes(cmd.kind)) {
    if (cmd.kind === "invite_member") {
      const email = normalizedEmail(cmd.email);
      const optionalKeys = Object.hasOwn(cmd, "ttl_ms") ? ["ttl_ms"] : [];
      const validTtl = cmd.ttl_ms === undefined ||
        (integer(cmd.ttl_ms, 1) && cmd.ttl_ms <= INVITATION_MAX_TTL_MS);
      return exactKeys(cmd, ["kind", "email", ...optionalKeys]) &&
          email !== null &&
          validTtl
        ? {
          ok: true,
          command: {
            kind: "invite_member",
            email,
            ...(cmd.ttl_ms === undefined
              ? {}
              : { ttl_ms: cmd.ttl_ms as number }),
          },
        }
        : { ok: false, status: 400, reason: "invite fields are malformed" };
    }
    if (cmd.kind === "accept_invitation") {
      return exactKeys(cmd, ["kind", "token"]) &&
          typeof cmd.token === "string" &&
          INVITATION_TOKEN_RE.test(cmd.token)
        ? {
          ok: true,
          command: { kind: "accept_invitation", token: cmd.token },
        }
        : { ok: false, status: 400, reason: "invitation token is malformed" };
    }
    if (cmd.kind === "create_agent_principal") {
      return exactKeys(cmd, ["kind", "name"]) && boundedText(cmd.name, 80)
        ? {
          ok: true,
          command: { kind: "create_agent_principal", name: cmd.name },
        }
        : { ok: false, status: 400, reason: "principal name is malformed" };
    }
    const optionalKeys = [
      ...(Object.hasOwn(cmd, "ttl_ms") ? ["ttl_ms"] : []),
      ...(Object.hasOwn(cmd, "scopes") ? ["scopes"] : []),
    ];
    const validScopes = cmd.scopes === undefined ||
      (
        Array.isArray(cmd.scopes) &&
        cmd.scopes.length >= 1 &&
        cmd.scopes.length <= 64 &&
        cmd.scopes.every((scope) => boundedText(scope, 128))
      );
    const validTtl = cmd.ttl_ms === undefined ||
      (integer(cmd.ttl_ms, 1) && cmd.ttl_ms <= AGENT_TOKEN_MAX_TTL_MS);
    const valid = exactKeys(cmd, [
      "kind",
      "principal_id",
      "run_id",
      "task_id",
      "epoch",
      "device_id",
      ...optionalKeys,
    ]) &&
      typeof cmd.principal_id === "string" && UUID_RE.test(cmd.principal_id) &&
      typeof cmd.run_id === "string" && UUID_RE.test(cmd.run_id) &&
      typeof cmd.task_id === "string" && UUID_RE.test(cmd.task_id) &&
      integer(cmd.epoch) &&
      typeof cmd.device_id === "string" && UUID_RE.test(cmd.device_id) &&
      validScopes &&
      validTtl;
    return valid
      ? {
        ok: true,
        command: {
          kind: "mint_agent_token",
          principal_id: cmd.principal_id as string,
          run_id: cmd.run_id as string,
          task_id: cmd.task_id as string,
          epoch: cmd.epoch as number,
          device_id: cmd.device_id as string,
          ...(cmd.ttl_ms === undefined ? {} : { ttl_ms: cmd.ttl_ms as number }),
          ...(cmd.scopes === undefined
            ? {}
            : { scopes: [...cmd.scopes as string[]] }),
        },
      }
      : {
        ok: false,
        status: 400,
        reason: "mint_agent_token fields are malformed or out of bounds",
      };
  }

  if (typeof cmd.task_id !== "string" || !UUID_RE.test(cmd.task_id)) {
    return { ok: false, status: 400, reason: "task_id must be a UUID" };
  }

  let valid = false;
  switch (cmd.kind) {
    case "create":
      valid = exactKeys(cmd, ["kind", "task_id", "slug"]) &&
        typeof cmd.slug === "string" && SLUG_RE.test(cmd.slug);
      break;
    case "acquire":
      valid = exactKeys(cmd, ["kind", "task_id", "ttl_ms"]) &&
        integer(cmd.ttl_ms, 1) && cmd.ttl_ms <= MAX_TTL_MS;
      break;
    case "renew":
      valid = exactKeys(cmd, ["kind", "task_id", "epoch", "ttl_ms"]) &&
        integer(cmd.epoch) && integer(cmd.ttl_ms, 1) &&
        cmd.ttl_ms <= MAX_TTL_MS;
      break;
    case "handoff":
      valid = exactKeys(cmd, [
        "kind",
        "task_id",
        "epoch",
        "to_owner",
        "ttl_ms",
      ]) &&
        integer(cmd.epoch) &&
        typeof cmd.to_owner === "string" && UUID_RE.test(cmd.to_owner) &&
        integer(cmd.ttl_ms, 1) && cmd.ttl_ms <= MAX_TTL_MS;
      break;
    case "takeover":
      valid = exactKeys(cmd, ["kind", "task_id", "grant_id", "ttl_ms"]) &&
        nullableUuid(cmd.grant_id) &&
        integer(cmd.ttl_ms, 1) && cmd.ttl_ms <= MAX_TTL_MS;
      break;
    case "submit":
      valid = exactKeys(cmd, [
        "kind",
        "task_id",
        "epoch",
        "branch",
        "head_sha",
        "evidence_set",
      ]) &&
        integer(cmd.epoch) &&
        boundedText(cmd.branch, 255) &&
        typeof cmd.head_sha === "string" && SHA_RE.test(cmd.head_sha) &&
        Array.isArray(cmd.evidence_set) &&
        cmd.evidence_set.length > 0 &&
        cmd.evidence_set.length <= 128 &&
        cmd.evidence_set.every((item) => boundedText(item, 2048));
      break;
    case "close":
      valid = exactKeys(cmd, [
        "kind",
        "task_id",
        "epoch",
        "disposition",
        "grant_id",
      ]) &&
        integer(cmd.epoch) &&
        typeof cmd.disposition === "string" &&
        (DISPOSITIONS as readonly string[]).includes(cmd.disposition) &&
        nullableUuid(cmd.grant_id);
      break;
    case "reopen":
      valid = exactKeys(cmd, ["kind", "task_id", "epoch"]) &&
        integer(cmd.epoch);
      break;
  }
  if (!valid) {
    return {
      ok: false,
      status: 400,
      reason: "command fields are malformed or out of bounds",
    };
  }

  if (
    new TextEncoder().encode(JSON.stringify(cmd)).byteLength >
      MAX_EVENT_PAYLOAD_BYTES
  ) {
    return { ok: false, status: 413, reason: "event payload too large" };
  }
  return { ok: true, command: cmd as Command };
}

function compareSemver(left: string, right: string): number | null {
  const a = SEMVER_RE.exec(left);
  const b = SEMVER_RE.exec(right);
  if (!a || !b) return null;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

function stateFromRow(row: Record<string, unknown> | undefined): TaskState | null {
  if (!row) return null;
  const submission = record(row.submission);
  return {
    task_id: String(row.task_id),
    slug: String(row.slug),
    lifecycle: row.lifecycle as TaskState["lifecycle"],
    version: Number(row.version),
    epoch: Number(row.epoch),
    owner: row.owner === null ? null : String(row.owner),
    lease_expiry: row.lease_expiry instanceof Date
      ? row.lease_expiry.getTime()
      : null,
    submission: submission
      ? {
        epoch: Number(submission.epoch),
        branch: String(submission.branch),
        head_sha: String(submission.head_sha),
        evidence_set: Array.isArray(submission.evidence_set)
          ? submission.evidence_set.map(String)
          : [],
      }
      : null,
    closed_disposition: row.closed_disposition === null
      ? null
      : String(row.closed_disposition),
  };
}

function storedResponse(value: unknown): StoredResponse {
  const response = record(value);
  if (!response || typeof response.ok !== "boolean" || !Array.isArray(response.event_ids)) {
    throw new Error("invalid stored idempotency response");
  }
  return {
    ok: response.ok,
    ...(typeof response.reason === "string" ? { reason: response.reason as StoredResponse["reason"] } : {}),
    ...(typeof response.detail === "string" ? { detail: response.detail } : {}),
    ...(response.class === "authz" || response.class === "domain"
      ? { class: response.class }
      : {}),
    event_ids: response.event_ids.map(String),
    ...(typeof response.invitation_id === "string"
      ? { invitation_id: response.invitation_id }
      : {}),
    ...(typeof response.principal_id === "string"
      ? { principal_id: response.principal_id }
      : {}),
    ...(typeof response.token_id === "string"
      ? { token_id: response.token_id }
      : {}),
    ...(typeof response.run_id === "string" ? { run_id: response.run_id } : {}),
    ...(typeof response.workspace_id === "string"
      ? { workspace_id: response.workspace_id }
      : {}),
    ...(record(response.signal) === null
      ? {}
      : { signal: response.signal as unknown as SignalRecord }),
  };
}

function replayResult(
  response: StoredResponse,
  commandKind?: string,
): HttpResult {
  if (commandKind === "accept_invitation" && !response.ok) {
    return { status: 403, body: { error: "forbidden" } };
  }
  return {
    status: 200,
    body: {
      status: response.ok ? "accepted" : "rejected",
      ...response,
    },
  };
}

function dbCode(error: unknown): string | null {
  return record(error)?.code as string | null ?? null;
}

async function authenticateAgent(
  tx: Sql,
  tokenHash: Uint8Array,
): Promise<AuthContext | null> {
  const agent = await loadAgentCredential(tx, tokenHash);
  if (!agent) return null;
  return {
    credentialKind: "agent",
    credentialId: agent.token_id,
    deviceId: agent.device_id,
    actor: {
      user: agent.owner_user_id,
      agent_principal: agent.principal_id,
      run: agent.run_id,
    },
    agent,
    identityVerified: false,
  };
}

async function authenticateHuman(
  tx: Sql,
  verified: VerifiedHuman,
): Promise<AuthContext | null> {
  const rows = await tx<{ user_id: string }[]>`
    INSERT INTO swarm.users (user_id, display_name, email)
    VALUES (
      ${verified.userId}::uuid,
      ${verified.displayName},
      ${verified.email}
    )
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      email = coalesce(EXCLUDED.email, swarm.users.email)
    RETURNING user_id
  `;
  if (!rows[0]) return null;
  return {
    credentialKind: "user",
    credentialId: null,
    deviceId: null,
    actor: { user: rows[0].user_id, agent_principal: null, run: null },
    agent: null,
    identityVerified: verified.identityVerified,
  };
}

async function resolveRoute(
  tx: Sql,
  body: RequestBody,
  auth: AuthContext,
): Promise<Route | null> {
  if (typeof body.workspace_id !== "string" || !UUID_RE.test(body.workspace_id)) {
    return null;
  }
  const workspaceId = body.workspace_id;
  if (
    auth.agent !== null &&
    auth.agent.principal_workspace_id !== workspaceId
  ) {
    return null;
  }

  const memberships = await tx<
    { role: Role; revoked_at: Date | null }[]
  >`
    SELECT role, revoked_at
    FROM swarm.memberships
    WHERE workspace_id = ${workspaceId}::uuid
      AND user_id = ${auth.actor.user}::uuid
    LIMIT 1
  `;
  const membership = memberships[0];
  if (!membership) return null;

  const stream = record(body.stream);
  if (!stream || typeof stream.kind !== "string") return null;
  let streamId: string | null = null;
  if (stream.kind === "workspace" && exactKeys(stream, ["kind"])) {
    const rows = await tx<{ stream_id: string }[]>`
      SELECT stream_id
      FROM swarm.streams
      WHERE workspace_id = ${workspaceId}::uuid
        AND kind = 'workspace'
      LIMIT 1
    `;
    streamId = rows[0]?.stream_id ?? null;
  } else if (
    stream.kind === "repo" &&
    exactKeys(stream, ["kind", "repo_mapping_id"]) &&
    typeof stream.repo_mapping_id === "string" &&
    UUID_RE.test(stream.repo_mapping_id)
  ) {
    const rows = await tx<{ stream_id: string }[]>`
      SELECT s.stream_id
      FROM swarm.repositories AS r
      JOIN swarm.streams AS s
        ON s.repo_mapping_id = r.repo_mapping_id
       AND s.workspace_id = r.workspace_id
       AND s.kind = 'repo'
      WHERE r.repo_mapping_id = ${stream.repo_mapping_id}::uuid
        AND r.workspace_id = ${workspaceId}::uuid
        AND r.archived_at IS NULL
      LIMIT 1
    `;
    streamId = rows[0]?.stream_id ?? null;
  }
  if (!streamId) return null;
  return {
    workspaceId,
    streamId,
    membershipRole: membership.role,
    membershipRevokedAt: membership.revoked_at,
  };
}

function invitationTokenForRoute(body: RequestBody): string | null {
  if (body.workspace_id !== undefined || body.stream !== undefined) return null;
  const command = record(body.command);
  if (
    !command ||
    command.kind !== "accept_invitation" ||
    !exactKeys(command, ["kind", "token"]) ||
    typeof command.token !== "string" ||
    !INVITATION_TOKEN_RE.test(command.token)
  ) return null;
  return command.token;
}

async function resolveInvitationRoute(
  tx: Sql,
  body: RequestBody,
  auth: AuthContext,
  tokenHash: Uint8Array,
): Promise<Route | null> {
  // Agent credentials never get a capability existence oracle.
  if (auth.credentialKind !== "user" || invitationTokenForRoute(body) === null) {
    return null;
  }
  const rows = await tx<{
    workspace_id: string;
    stream_id: string;
    role: Role | null;
    revoked_at: Date | null;
  }[]>`
    SELECT
      i.workspace_id,
      s.stream_id,
      m.role,
      m.revoked_at
    FROM swarm.invitations AS i
    JOIN swarm.streams AS s
      ON s.workspace_id = i.workspace_id
     AND s.kind = 'workspace'
    LEFT JOIN swarm.memberships AS m
      ON m.workspace_id = i.workspace_id
     AND m.user_id = ${auth.actor.user}::uuid
    WHERE i.token_hash = ${tokenHash}
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
      workspaceId: row.workspace_id,
      streamId: row.stream_id,
      membershipRole: row.role,
      membershipRevokedAt: row.revoked_at,
    }
    : null;
}

async function revoked(
  tx: Sql,
  auth: AuthContext,
  route: Route,
): Promise<boolean> {
  const agent = auth.agent;
  return agent === null
    ? route.membershipRevokedAt !== null
    : await agentCredentialRevoked(tx, agent, route.membershipRevokedAt);
}

async function buildContext(
  tx: Sql,
  route: Route,
  auth: AuthContext,
  command: Command,
  commandId: string,
  prior: TaskState | null,
  headSeq: number,
  now: number,
): Promise<DecideCtx> {
  let eligibleRecipient = false;
  if (command.kind === "handoff") {
    const rows = await tx<{ eligible: boolean }[]>`
      SELECT (
        EXISTS (
          SELECT 1
          FROM swarm.memberships AS m
          WHERE m.workspace_id = ${route.workspaceId}::uuid
            AND m.user_id::text = ${command.to_owner}
            AND m.revoked_at IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM swarm.agent_principals AS p
          JOIN swarm.memberships AS m
            ON m.workspace_id = p.workspace_id
           AND m.user_id = p.owner_user_id
           AND m.revoked_at IS NULL
          WHERE p.workspace_id = ${route.workspaceId}::uuid
            AND p.principal_id::text = ${command.to_owner}
            AND p.revoked_at IS NULL
        )
      ) AS eligible
    `;
    eligibleRecipient = rows[0]?.eligible ?? false;
  }

  let slugTaken = false;
  if (command.kind === "create") {
    const rows = await tx<{ taken: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM swarm.tasks
        WHERE stream_id = ${route.streamId}::uuid
          AND slug = ${command.slug}
      ) AS taken
    `;
    slugTaken = rows[0]?.taken ?? false;
  }

  let takeoverGrant = false;
  if (
    command.kind === "takeover" &&
    command.grant_id !== null &&
    prior !== null
  ) {
    const recipient = canonicalPrincipal(auth.actor);
    const rows = await tx<{ valid: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM swarm.grants AS g
        WHERE g.grant_id = ${command.grant_id}::uuid
          AND g.workspace_id = ${route.workspaceId}::uuid
          AND g.stream_id = ${route.streamId}::uuid
          AND g.task_id = ${command.task_id}::uuid
          AND g.type = 'takeover'
          AND g.issued_to = ${recipient}
          AND g.binding @> ${
      tx.json({ epoch: prior.epoch })
    }::jsonb
          AND g.revoked_at IS NULL
          AND g.expires_at > statement_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM swarm.grant_consumptions AS c
            WHERE c.grant_id = g.grant_id
          )
      ) AS valid
    `;
    takeoverGrant = rows[0]?.valid ?? false;
  }

  let nextSeq = headSeq;
  return {
    now,
    actor: auth.actor,
    command_id: commandId,
    workspace_id: route.workspaceId,
    stream_id: route.streamId,
    isMember: (principal) =>
      principal === canonicalPrincipal(auth.actor) &&
      route.membershipRole !== null &&
      route.membershipRevokedAt === null,
    role: (principal) =>
      principal === canonicalPrincipal(auth.actor) ? route.membershipRole : null,
    isEligibleRecipient: (principal) =>
      command.kind === "handoff" &&
      principal === command.to_owner &&
      eligibleRecipient,
    claimRequiresGrant: () => false,
    evidenceComplete: (_taskId, evidence) =>
      evidence.length > 0 &&
      evidence.every((item) => boundedText(item, 2048)),
    validTakeoverGrant: (taskId, grantId, epoch, recipient) =>
      command.kind === "takeover" &&
      taskId === command.task_id &&
      grantId === command.grant_id &&
      epoch === prior?.epoch &&
      recipient === canonicalPrincipal(auth.actor) &&
      takeoverGrant,
    validCloseGrant: () => false,
    slugTaken: (slug) =>
      command.kind === "create" && slug === command.slug && slugTaken,
    nextSeq: () => ++nextSeq,
    nextEventId: () => crypto.randomUUID(),
  };
}

function millis(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function byteaHex(value: unknown): string {
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (typeof value === "string" && /^(?:\\x)?[0-9a-f]{64}$/i.test(value)) {
    return value.replace(/^\\x/u, "").toLowerCase();
  }
  throw new Error("invalid bytea digest in workspace projection");
}

async function loadWorkspaceState(
  tx: Sql,
  route: Route,
): Promise<WorkspaceState> {
  const [workspaceRows, memberRows, invitationRows, principalRows, tokenRows] =
    await Promise.all([
      tx<Record<string, unknown>[]>`
        SELECT workspace_id, name, created_by, created_at, archived_at
        FROM swarm.workspaces
        WHERE workspace_id = ${route.workspaceId}::uuid
        LIMIT 1
      `,
      tx<Record<string, unknown>[]>`
        SELECT user_id, role, invited_by, joined_at, revoked_at
        FROM swarm.memberships
        WHERE workspace_id = ${route.workspaceId}::uuid
      `,
      tx<Record<string, unknown>[]>`
        SELECT
          invitation_id, email, role, token_hash, expires_at,
          created_by, created_at, consumed_at, consumed_by, revoked_at
        FROM swarm.invitations
        WHERE workspace_id = ${route.workspaceId}::uuid
      `,
      tx<Record<string, unknown>[]>`
        SELECT principal_id, owner_user_id, name, created_at, revoked_at
        FROM swarm.agent_principals
        WHERE workspace_id = ${route.workspaceId}::uuid
      `,
      tx<Record<string, unknown>[]>`
        SELECT
          t.token_id, t.principal_id, t.run_id, t.task_id, t.epoch,
          t.scopes, t.issued_at, t.expires_at, t.revoked_at
        FROM swarm.agent_tokens AS t
        JOIN swarm.agent_principals AS p
          ON p.principal_id = t.principal_id
        WHERE p.workspace_id = ${route.workspaceId}::uuid
      `,
    ]);
  const workspace = workspaceRows[0];
  if (!workspace) throw new Error("validated workspace disappeared");

  const members: WorkspaceState["members"] = {};
  for (const row of memberRows) {
    const userId = String(row.user_id);
    members[userId] = {
      user_id: userId,
      role: row.role as WorkspaceRole,
      invited_by: row.invited_by === null ? null : String(row.invited_by),
      joined_at: millis(row.joined_at) ?? 0,
      revoked_at: millis(row.revoked_at),
    };
  }
  const invitations: WorkspaceState["invitations"] = {};
  for (const row of invitationRows) {
    const invitationId = String(row.invitation_id);
    invitations[invitationId] = {
      invitation_id: invitationId,
      email: row.email === null ? null : String(row.email),
      role: row.role as WorkspaceRole,
      token_hash: byteaHex(row.token_hash),
      expires_at: millis(row.expires_at) ?? 0,
      created_by: String(row.created_by),
      created_at: millis(row.created_at) ?? 0,
      consumed_at: millis(row.consumed_at),
      consumed_by: row.consumed_by === null ? null : String(row.consumed_by),
      revoked_at: millis(row.revoked_at),
    };
  }
  const principals: WorkspaceState["principals"] = {};
  for (const row of principalRows) {
    const principalId = String(row.principal_id);
    principals[principalId] = {
      principal_id: principalId,
      owner_user_id: String(row.owner_user_id),
      name: String(row.name),
      created_at: millis(row.created_at) ?? 0,
      revoked_at: millis(row.revoked_at),
    };
  }
  const tokens: WorkspaceState["tokens"] = {};
  for (const row of tokenRows) {
    const tokenId = String(row.token_id);
    tokens[tokenId] = {
      token_id: tokenId,
      principal_id: String(row.principal_id),
      run_id: String(row.run_id),
      task_id: row.task_id === null ? null : String(row.task_id),
      epoch: row.epoch === null ? null : Number(row.epoch),
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      issued_at: millis(row.issued_at) ?? 0,
      expires_at: millis(row.expires_at) ?? 0,
      revoked_at: millis(row.revoked_at),
    };
  }

  return {
    workspace: {
      workspace_id: String(workspace.workspace_id),
      name: String(workspace.name),
      created_by: String(workspace.created_by),
      created_at: millis(workspace.created_at) ?? 0,
      archived_at: millis(workspace.archived_at),
    },
    members,
    invitations,
    principals,
    tokens,
    owners_count: Object.values(members).filter(
      (member) => member.revoked_at === null && member.role === "owner",
    ).length,
  };
}

async function mintBindingsValid(
  tx: Sql,
  auth: AuthContext,
  command: ValidatedCommand,
): Promise<boolean> {
  if (command.kind !== "mint_agent_token" || auth.actor.user === null) return true;
  const devices = await tx<{ user_id: string; revoked_at: Date | null }[]>`
    SELECT user_id, revoked_at
    FROM swarm.devices
    WHERE device_id = ${command.device_id}::uuid
    LIMIT 1
  `;
  const device = devices[0];
  if (
    !device ||
    device.user_id !== auth.actor.user ||
    device.revoked_at !== null
  ) return false;

  const runs = await tx<{
    principal_id: string;
    device_id: string;
    ended_at: Date | null;
  }[]>`
    SELECT principal_id, device_id, ended_at
    FROM swarm.agent_runs
    WHERE run_id = ${command.run_id}::uuid
    LIMIT 1
  `;
  const run = runs[0];
  return !run ||
    (
      run.principal_id === command.principal_id &&
      run.device_id === command.device_id &&
      run.ended_at === null
    );
}

async function prepareWorkspaceCommand(
  tx: Sql,
  route: Route,
  auth: AuthContext,
  wire: ConnectCommand,
  commandId: string,
  headSeq: number,
  now: number,
): Promise<PreparedWorkspace> {
  const state = await loadWorkspaceState(tx, route);
  let invitationToken: string | null = null;
  let invitationHash: Uint8Array | null = null;
  let agentToken: string | null = null;
  let agentTokenHash: Uint8Array | null = null;
  let lineageId: string | null = null;
  let command: WorkspaceCommand;

  if (wire.kind === "invite_member") {
    invitationToken = opaqueToken("swm_inv_");
    invitationHash = await sha256(invitationToken);
    command = {
      kind: "invite_member",
      invitation_id: crypto.randomUUID(),
      email: wire.email,
      role: "member",
      token_hash: bytesToHex(invitationHash),
      expires_at: now + (wire.ttl_ms ?? INVITATION_TTL_MS),
    };
  } else if (wire.kind === "accept_invitation") {
    invitationHash = await sha256(wire.token);
    command = {
      kind: "accept_invitation",
      token_hash: bytesToHex(invitationHash),
    };
  } else if (wire.kind === "create_agent_principal") {
    command = {
      kind: "create_agent_principal",
      principal_id: crypto.randomUUID(),
      name: wire.name,
    };
  } else {
    agentToken = opaqueToken("swm_agt_");
    agentTokenHash = await sha256(agentToken);
    lineageId = crypto.randomUUID();
    command = {
      kind: "mint_agent_token",
      token_id: crypto.randomUUID(),
      principal_id: wire.principal_id,
      run_id: wire.run_id,
      task_id: wire.task_id,
      epoch: wire.epoch,
      scopes: [...(wire.scopes ?? P0_AGENT_SCOPES)],
      ...(wire.ttl_ms === undefined ? {} : { ttl_ms: wire.ttl_ms }),
    };
  }

  let inviteeAlreadyMember = false;
  if (wire.kind === "invite_member") {
    const rows = await tx<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM swarm.users AS u
        JOIN swarm.memberships AS m
          ON m.user_id = u.user_id
         AND m.workspace_id = ${route.workspaceId}::uuid
         AND m.revoked_at IS NULL
        WHERE lower(u.email) = ${wire.email}
      ) AS present
    `;
    inviteeAlreadyMember = rows[0]?.present ?? false;
  }

  let nextSeq = headSeq;
  const ctx: WorkspaceDecideCtx = {
    now,
    actor: auth.actor,
    credential_kind: auth.credentialKind === "user" ? "human" : "agent",
    presenting_token_id: auth.agent?.token_id ?? null,
    command_id: commandId,
    workspace_id: route.workspaceId,
    stream_id: route.streamId,
    operatorAllowed: () => false,
    role: (userId) => {
      const member = state.members[userId];
      return member?.revoked_at === null ? member.role : null;
    },
    inviteeAlreadyMember: (email) =>
      wire.kind === "invite_member" &&
      email === wire.email &&
      inviteeAlreadyMember,
    identityVerified: (userId) =>
      userId === auth.actor.user && auth.identityVerified,
    humanRights: () => [...P0_AGENT_SCOPES],
    landingAuthorityChangeResolved: () => true,
    nextSeq: () => ++nextSeq,
    nextEventId: () => crypto.randomUUID(),
  };
  return {
    wire,
    command,
    state,
    ctx,
    invitationToken,
    invitationHash,
    agentToken,
    agentTokenHash,
    lineageId,
  };
}

async function appendEvents(
  tx: Sql,
  events: readonly EventEnvelope[],
): Promise<void> {
  for (const event of events) {
    await tx`
      INSERT INTO swarm.events (
        workspace_id, stream_id, seq, event_id, command_id,
        type, schema_version,
        actor_user, actor_agent_principal, actor_run,
        occurred_at_server, payload
      ) VALUES (
        ${event.workspace_id}::uuid,
        ${event.stream_id}::uuid,
        ${event.seq},
        ${event.event_id}::uuid,
        ${event.command_id},
        ${event.type},
        ${event.schema_version},
        ${event.actor_user}::uuid,
        ${event.actor_agent_principal}::uuid,
        ${event.actor_run}::uuid,
        ${new Date(event.occurred_at_server)},
        ${tx.json(event.payload as postgres.JSONValue)}::jsonb
      )
    `;
  }
}

async function updateProjection(
  tx: Sql,
  route: Route,
  prior: TaskState | null,
  priorUpdatedAt: Date | null,
  events: readonly EventEnvelope[],
  now: number,
): Promise<TaskState | null> {
  let projection = prior;
  for (const event of events) {
    if (projection === null && event.type === "CommandRejected") continue;
    projection = reduceTask(projection, event);
  }
  if (projection === null) return null;

  const updatedAt = projection === prior && priorUpdatedAt !== null
    ? priorUpdatedAt
    : new Date(now);
  await tx`
    INSERT INTO swarm.tasks (
      workspace_id, stream_id, task_id, slug, lifecycle,
      version, epoch, owner, lease_expiry, submission,
      closed_disposition, updated_at
    ) VALUES (
      ${route.workspaceId}::uuid,
      ${route.streamId}::uuid,
      ${projection.task_id}::uuid,
      ${projection.slug},
      ${projection.lifecycle},
      ${projection.version},
      ${projection.epoch},
      ${projection.owner},
      ${
    projection.lease_expiry === null ? null : new Date(projection.lease_expiry)
  },
      ${
    projection.submission === null
      ? null
      : tx.json(projection.submission as postgres.JSONValue)
  }::jsonb,
      ${projection.closed_disposition},
      ${updatedAt}
    )
    ON CONFLICT (stream_id, task_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      slug = EXCLUDED.slug,
      lifecycle = EXCLUDED.lifecycle,
      version = EXCLUDED.version,
      epoch = EXCLUDED.epoch,
      owner = EXCLUDED.owner,
      lease_expiry = EXCLUDED.lease_expiry,
      submission = EXCLUDED.submission,
      closed_disposition = EXCLUDED.closed_disposition,
      updated_at = EXCLUDED.updated_at
  `;

  for (const event of events) {
    const payload = record(event.payload);
    if (!payload) continue;
    if (
      event.type === "LeaseAcquired" ||
      event.type === "LeaseHandedOff" ||
      event.type === "LeaseTakenOver"
    ) {
      await tx`
        UPDATE swarm.leases
        SET ended_at = ${new Date(event.occurred_at_server)}
        WHERE stream_id = ${route.streamId}::uuid
          AND task_id = ${projection.task_id}::uuid
          AND ended_at IS NULL
      `;
      const owner = event.type === "LeaseHandedOff"
        ? String(payload.to_owner)
        : String(payload.owner);
      await tx`
        INSERT INTO swarm.leases (
          stream_id, task_id, epoch, owner,
          acquired_at, lease_expiry, ended_at
        ) VALUES (
          ${route.streamId}::uuid,
          ${projection.task_id}::uuid,
          ${Number(payload.epoch)},
          ${owner},
          ${new Date(event.occurred_at_server)},
          ${new Date(Number(payload.lease_expiry))},
          NULL
        )
      `;
    } else if (event.type === "LeaseRenewed") {
      await tx`
        UPDATE swarm.leases
        SET lease_expiry = ${new Date(Number(payload.lease_expiry))}
        WHERE stream_id = ${route.streamId}::uuid
          AND task_id = ${projection.task_id}::uuid
          AND epoch = ${Number(payload.epoch)}
          AND ended_at IS NULL
      `;
    } else if (event.type === "TaskClosed" || event.type === "TaskReopened") {
      await tx`
        UPDATE swarm.leases
        SET ended_at = ${new Date(event.occurred_at_server)}
        WHERE stream_id = ${route.streamId}::uuid
          AND task_id = ${projection.task_id}::uuid
          AND ended_at IS NULL
      `;
    }
  }
  return projection;
}

async function consumeInvitation(
  tx: Sql,
  prepared: PreparedWorkspace,
  auth: AuthContext,
  now: number,
): Promise<boolean> {
  if (
    prepared.command.kind !== "accept_invitation" ||
    prepared.invitationHash === null ||
    auth.actor.user === null
  ) return true;
  const rows = await tx<{ invitation_id: string }[]>`
    UPDATE swarm.invitations
    SET
      consumed_at = ${new Date(now)},
      consumed_by = ${auth.actor.user}::uuid
    WHERE token_hash = ${prepared.invitationHash}
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > statement_timestamp()
    RETURNING invitation_id
  `;
  return rows.length === 1;
}

async function updateWorkspaceProjection(
  tx: Sql,
  route: Route,
  prepared: PreparedWorkspace,
  events: readonly EventEnvelope[],
): Promise<WorkspaceState> {
  let projection = prepared.state;
  for (const event of events) {
    projection = reduceWorkspace(projection, event) as WorkspaceState;
  }

  for (const event of events) {
    const payload = record(event.payload);
    if (!payload || event.type === "CommandRejected") continue;

    if (event.type === "MemberInvited") {
      const invitation = projection.invitations[String(payload.invitation_id)];
      if (!invitation) throw new Error("folded invitation projection missing");
      await tx`
        INSERT INTO swarm.invitations (
          invitation_id, workspace_id, email, role, token_hash,
          expires_at, created_by, created_at,
          consumed_at, consumed_by, revoked_at
        ) VALUES (
          ${invitation.invitation_id}::uuid,
          ${route.workspaceId}::uuid,
          ${invitation.email},
          ${invitation.role},
          ${hexToBytes(invitation.token_hash)},
          ${new Date(invitation.expires_at)},
          ${invitation.created_by}::uuid,
          ${new Date(invitation.created_at)},
          NULL,
          NULL,
          NULL
        )
      `;
    } else if (event.type === "MemberJoined") {
      const member = projection.members[String(payload.user_id)];
      if (!member) throw new Error("folded member projection missing");
      await tx`
        INSERT INTO swarm.memberships (
          workspace_id, user_id, role, invited_by, joined_at, revoked_at
        ) VALUES (
          ${route.workspaceId}::uuid,
          ${member.user_id}::uuid,
          ${member.role},
          ${member.invited_by}::uuid,
          ${new Date(member.joined_at)},
          NULL
        )
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET
          role = EXCLUDED.role,
          invited_by = EXCLUDED.invited_by,
          joined_at = EXCLUDED.joined_at,
          revoked_at = NULL
      `;
    } else if (event.type === "AgentPrincipalCreated") {
      const principal = projection.principals[String(payload.principal_id)];
      if (!principal) throw new Error("folded principal projection missing");
      await tx`
        INSERT INTO swarm.agent_principals (
          principal_id, workspace_id, owner_user_id, name, created_at, revoked_at
        ) VALUES (
          ${principal.principal_id}::uuid,
          ${route.workspaceId}::uuid,
          ${principal.owner_user_id}::uuid,
          ${principal.name},
          ${new Date(principal.created_at)},
          NULL
        )
      `;
    } else if (event.type === "AgentTokenMinted") {
      if (
        prepared.wire.kind !== "mint_agent_token" ||
        prepared.agentTokenHash === null ||
        prepared.lineageId === null ||
        authUser(prepared.ctx.actor) === null
      ) {
        throw new Error("token mint side-effect material missing");
      }
      const token = projection.tokens[String(payload.token_id)];
      if (!token || token.task_id === null || token.epoch === null) {
        throw new Error("folded token projection missing narrow binding");
      }
      const userId = authUser(prepared.ctx.actor)!;
      const devices = await tx<{ user_id: string }[]>`
        SELECT user_id
        FROM swarm.devices
        WHERE device_id = ${prepared.wire.device_id}::uuid
          AND revoked_at IS NULL
      `;
      if (devices[0]?.user_id !== userId) {
        throw new Error("authenticated device ownership changed during mint");
      }
      await tx`
        INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
        VALUES (
          ${token.run_id}::uuid,
          ${token.principal_id}::uuid,
          ${prepared.wire.device_id}::uuid
        )
        ON CONFLICT (run_id) DO NOTHING
      `;
      const runs = await tx<{
        principal_id: string;
        device_id: string;
        ended_at: Date | null;
      }[]>`
        SELECT principal_id, device_id, ended_at
        FROM swarm.agent_runs
        WHERE run_id = ${token.run_id}::uuid
      `;
      const run = runs[0];
      if (
        !run ||
        run.principal_id !== token.principal_id ||
        run.device_id !== prepared.wire.device_id ||
        run.ended_at !== null
      ) {
        throw new Error("agent run binding changed during mint");
      }
      await tx`
        INSERT INTO swarm.agent_tokens (
          token_id, principal_id, run_id, task_id, epoch,
          scopes, token_hash, issued_at, expires_at, lineage_id
        ) VALUES (
          ${token.token_id}::uuid,
          ${token.principal_id}::uuid,
          ${token.run_id}::uuid,
          ${token.task_id}::uuid,
          ${token.epoch},
          ${tx.json(token.scopes)}::jsonb,
          ${prepared.agentTokenHash},
          ${new Date(token.issued_at)},
          ${new Date(token.expires_at)},
          ${prepared.lineageId}::uuid
        )
      `;
    }
  }
  return projection;
}

function authUser(actor: Actor): string | null {
  return actor.user;
}

async function applyEventSideEffects(
  tx: Sql,
  events: readonly EventEnvelope[],
): Promise<void> {
  for (const event of events) {
    const payload = record(event.payload);
    if (!payload) continue;
    if (
      (event.type === "TaskClosed" || event.type === "LeaseTakenOver") &&
      typeof payload.grant_id === "string"
    ) {
      await tx`
        INSERT INTO swarm.grant_consumptions (
          grant_id, consumed_at, command_id, event_id
        ) VALUES (
          ${payload.grant_id}::uuid,
          ${new Date(event.occurred_at_server)},
          ${event.command_id},
          ${event.event_id}::uuid
        )
      `;
    }
    if (event.type === "TaskReopened" && typeof payload.task_id === "string") {
      await tx`
        UPDATE swarm.grants
        SET revoked_at = ${new Date(event.occurred_at_server)}
        WHERE stream_id = ${event.stream_id}::uuid
          AND task_id = ${payload.task_id}::uuid
          AND revoked_at IS NULL
      `;
    }
  }
}

async function registerLoginDevice(
  tx: Sql,
  body: RequestBody,
  auth: AuthContext,
  ignoredIdentity: string | null,
): Promise<HttpResult> {
  const command = record(body.command);
  const valid = auth.credentialKind === "user" &&
    auth.actor.user !== null &&
    auth.identityVerified &&
    body.workspace_id === undefined &&
    body.stream === undefined &&
    typeof body.client_version === "string" &&
    command !== null &&
    exactKeys(command, ["kind", "device_id", "label"]) &&
    command.kind === REGISTER_DEVICE_KIND &&
    typeof command.device_id === "string" &&
    UUID_RE.test(command.device_id) &&
    boundedText(command.label, 80);
  if (!valid) {
    await insertAudit(tx, {
      auth,
      commandKind: REGISTER_DEVICE_KIND,
      outcome: auth.credentialKind === "user" ? "validation" : "authz",
      reason: auth.credentialKind === "user" ? "invalid_request" : "forbidden",
      detail: ignoredIdentity,
    });
    return auth.credentialKind === "user"
      ? { status: 400, body: { error: "invalid_request" } }
      : { status: 403, body: { error: "forbidden" } };
  }

  const configRows = await tx<{ value: unknown }[]>`
    SELECT value FROM swarm.config WHERE key = 'min_client_version' LIMIT 1
  `;
  const minClientVersion = configRows[0]?.value;
  if (
    typeof minClientVersion !== "string" ||
    compareSemver(body.client_version as string, minClientVersion) === null
  ) {
    await insertAudit(tx, {
      auth,
      commandKind: REGISTER_DEVICE_KIND,
      outcome: "validation",
      reason: "invalid client_version",
      detail: ignoredIdentity,
    });
    return { status: 400, body: { error: "invalid_request" } };
  }
  if (compareSemver(body.client_version as string, minClientVersion)! < 0) {
    await insertAudit(tx, {
      auth,
      commandKind: REGISTER_DEVICE_KIND,
      outcome: "validation",
      reason: "client_unsupported",
      detail: ignoredIdentity,
    });
    return {
      status: 426,
      body: { error: "upgrade_required", min_client_version: minClientVersion },
    };
  }

  const deviceId = command!.device_id as string;
  const label = command!.label as string;
  await tx`
    INSERT INTO swarm.devices (device_id, user_id, label, last_seen_at)
    VALUES (
      ${deviceId}::uuid,
      ${auth.actor.user}::uuid,
      ${label},
      statement_timestamp()
    )
    ON CONFLICT (device_id) DO NOTHING
  `;
  const devices = await tx<{ user_id: string; revoked_at: Date | null }[]>`
    SELECT user_id, revoked_at
    FROM swarm.devices
    WHERE device_id = ${deviceId}::uuid
    FOR UPDATE
  `;
  const device = devices[0];
  if (
    !device ||
    device.user_id !== auth.actor.user ||
    device.revoked_at !== null
  ) {
    await insertAudit(tx, {
      auth,
      commandKind: REGISTER_DEVICE_KIND,
      outcome: "authz",
      reason: "forbidden",
      detail: ignoredIdentity,
    });
    return { status: 403, body: { error: "forbidden" } };
  }
  await tx`
    UPDATE swarm.devices
    SET label = ${label}, last_seen_at = statement_timestamp()
    WHERE device_id = ${deviceId}::uuid
      AND user_id = ${auth.actor.user}::uuid
      AND revoked_at IS NULL
  `;
  await insertAudit(tx, {
    auth,
    commandKind: REGISTER_DEVICE_KIND,
    outcome: "accepted",
    reason: null,
    detail: ignoredIdentity,
  });
  return {
    status: 200,
    body: {
      status: "accepted",
      ok: true,
      event_ids: [],
      device_id: deviceId,
      min_client_version: minClientVersion,
    },
  };
}

interface SignalRateLimit {
  bucket: "credential" | "workspace";
  limit: number;
  resetsAt: string;
}

async function incrementSignalBucket(
  tx: Sql,
  bucketKey: string,
  limit: number,
): Promise<{ count: number; resetsAt: string }> {
  const rows = await tx<{ count: number; resets_at: Date }[]>`
    INSERT INTO swarm.rate_buckets (bucket_key, window_start, count)
    VALUES (
      ${bucketKey},
      date_trunc('hour', statement_timestamp()),
      1
    )
    ON CONFLICT (bucket_key, window_start) DO UPDATE
    SET count = LEAST(swarm.rate_buckets.count + 1, ${limit + 1})
    RETURNING count, window_start + interval '1 hour' AS resets_at
  `;
  const row = rows[0];
  if (!row) throw new Error("signal rate bucket did not return a row");
  return {
    count: Number(row.count),
    resetsAt: row.resets_at.toISOString(),
  };
}

async function enforceSignalRate(
  tx: Sql,
  auth: AuthContext,
  workspaceId: string,
): Promise<SignalRateLimit | null> {
  const credentialIdentity = auth.credentialKind === "agent"
    ? auth.credentialId
    : auth.actor.user;
  if (credentialIdentity === null) {
    throw new Error("authenticated signal credential has no stable identity");
  }
  const credential = await incrementSignalBucket(
    tx,
    `signal:credential:${auth.credentialKind}:${credentialIdentity}`,
    SIGNAL_CREDENTIAL_LIMIT,
  );
  if (credential.count > SIGNAL_CREDENTIAL_LIMIT) {
    return {
      bucket: "credential",
      limit: SIGNAL_CREDENTIAL_LIMIT,
      resetsAt: credential.resetsAt,
    };
  }
  const workspace = await incrementSignalBucket(
    tx,
    `signal:workspace:${workspaceId}`,
    SIGNAL_WORKSPACE_LIMIT,
  );
  if (workspace.count > SIGNAL_WORKSPACE_LIMIT) {
    return {
      bucket: "workspace",
      limit: SIGNAL_WORKSPACE_LIMIT,
      resetsAt: workspace.resetsAt,
    };
  }
  return null;
}

async function signalTargetIsLive(
  tx: Sql,
  route: Route,
  toUserId: string | null,
): Promise<boolean> {
  if (toUserId === null) return true;
  const targetRows = await tx<{ user_id: string }[]>`
    SELECT user_id
    FROM swarm.memberships
    WHERE workspace_id = ${route.workspaceId}::uuid
      AND user_id = ${toUserId}::uuid
      AND revoked_at IS NULL
    LIMIT 1
  `;
  return targetRows[0] !== undefined;
}

async function postSignal(
  tx: Sql,
  route: Route,
  auth: AuthContext,
  command: SignalCommand,
): Promise<SignalRecord> {
  const untilMs = command.until_ms ??
    SIGNAL_DEFAULT_UNTIL_MS[command.signal_kind];
  const signalId = crypto.randomUUID();
  const rows = await tx<{
    id: string;
    workspace_id: string;
    from_principal: string;
    from_kind: CredentialKind;
    to_user_id: string | null;
    about: string | null;
    kind: SignalKind;
    body: string;
    until: Date;
    created_at: Date;
  }[]>`
    INSERT INTO swarm.signals (
      id, workspace_id, from_principal, from_kind, to_user_id,
      about, kind, body, until, created_at
    ) VALUES (
      ${signalId}::uuid,
      ${route.workspaceId}::uuid,
      ${canonicalPrincipal(auth.actor)}::uuid,
      ${auth.credentialKind},
      ${command.to_user_id}::uuid,
      ${command.about},
      ${command.signal_kind},
      ${command.body},
      statement_timestamp() + ${untilMs} * interval '1 millisecond',
      statement_timestamp()
    )
    RETURNING
      id, workspace_id, from_principal, from_kind, to_user_id,
      about, kind, body, until, created_at
  `;
  const signal = rows[0];
  if (!signal) throw new Error("signal insert did not return a row");
  return {
    id: signal.id,
    workspace_id: signal.workspace_id,
    from: signal.from_principal,
    from_kind: signal.from_kind,
    to: signal.to_user_id,
    about: signal.about,
    kind: signal.kind,
    body: signal.body,
    until: signal.until.toISOString(),
    created_at: signal.created_at.toISOString(),
  };
}

async function handleTransaction(
  body: RequestBody,
  verifiedHuman: VerifiedHuman | null,
  agentTokenHash: Uint8Array | null,
): Promise<HttpResult> {
  const kind = commandKind(body);
  const commandId = String(body.command_id);
  return await db.begin(async (tx) => {
    await beforeStep(2);
    await setTransaction(tx);
    await afterStep(2);

    await beforeStep(3);
    const auth = agentTokenHash !== null
      ? await authenticateAgent(tx, agentTokenHash)
      : verifiedHuman !== null
      ? await authenticateHuman(tx, verifiedHuman)
      : null;
    if (!auth) {
      logCommandFailure(
        "command_pre_auth_failure",
        kind,
        "authn",
        "unverified principal",
      );
      return { status: 401, body: { error: "unauthenticated" } };
    }
    await afterStep(3);

    await beforeStep(4);
    const ignoredIdentity = forgedActorDetail(body);
    await afterStep(4);

    if (Object.hasOwn(body, "from")) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        outcome: "validation",
        reason: "client-supplied from is forbidden",
      });
      return { status: 400, body: { error: "invalid_request" } };
    }

    if (kind === REGISTER_DEVICE_KIND) {
      return await registerLoginDevice(tx, body, auth, ignoredIdentity);
    }

    await beforeStep(5);
    const invitationToken = kind === "accept_invitation"
      ? invitationTokenForRoute(body)
      : null;
    const invitationRouteHash = invitationToken === null
      ? null
      : await sha256(invitationToken);
    const route = kind === "accept_invitation"
      ? invitationRouteHash === null
        ? null
        : await resolveInvitationRoute(tx, body, auth, invitationRouteHash)
      : await resolveRoute(tx, body, auth);
    const workspaceCommandRouteOk =
      !(CONNECT_COMMAND_KINDS as readonly string[]).includes(kind) ||
      kind === "accept_invitation" ||
      record(body.stream)?.kind === "workspace";
    if (!route || !workspaceCommandRouteOk) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: typeof body.workspace_id === "string" &&
            UUID_RE.test(body.workspace_id)
          ? body.workspace_id
          : null,
        outcome: "authz",
        reason: "forbidden",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: "forbidden" } };
    }
    await afterStep(5);

    await beforeStep(6);
    if (await revoked(tx, auth, route)) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "revocation",
        reason: "forbidden",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: "forbidden" } };
    }
    const validation = validateCommand(body.command);
    const configRows = await tx<{ value: unknown }[]>`
      SELECT value FROM swarm.config WHERE key = 'min_client_version' LIMIT 1
    `;
    const minClientVersion = configRows[0]?.value;
    if (typeof minClientVersion !== "string") {
      throw new Error("min_client_version config is missing or malformed");
    }
    if (!validation.ok) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "validation",
        reason: validation.reason,
        detail: ignoredIdentity,
      });
      return {
        status: validation.status,
        body: {
          error: validation.status === 413
            ? "payload_too_large"
            : "invalid_request",
        },
      };
    }
    if (typeof body.client_version !== "string") {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "validation",
        reason: "invalid client_version",
        detail: ignoredIdentity,
      });
      return { status: 400, body: { error: "invalid_request" } };
    }
    const versionOrder = compareSemver(body.client_version, minClientVersion);
    if (versionOrder === null) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "validation",
        reason: "invalid client_version",
        detail: ignoredIdentity,
      });
      return { status: 400, body: { error: "invalid_request" } };
    }
    if (versionOrder < 0) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "validation",
        reason: "client_unsupported",
        detail: ignoredIdentity,
      });
      return {
        status: 426,
        body: { error: "upgrade_required", min_client_version: minClientVersion },
      };
    }
    if (
      auth.agent !== null &&
      (
        (CONNECT_COMMAND_KINDS as readonly string[]).includes(
          validation.command.kind,
        ) ||
        !Array.isArray(auth.agent.scopes) ||
        !auth.agent.scopes.every((scope) => typeof scope === "string") ||
        !auth.agent.scopes.includes(validation.command.kind)
      )
    ) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "authz",
        reason: "forbidden",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: "forbidden" } };
    }
    const command = validation.command;
    if (!await mintBindingsValid(tx, auth, command)) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "authz",
        reason: "forbidden",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: "forbidden" } };
    }
    const hash = requestHash(auth.actor, command);
    await afterStep(6);

    await beforeStep(7);
    const existingRows = await tx<
      {
        workspace_id: string;
        stream_id: string;
        request_hash: string;
        response: unknown;
      }[]
    >`
      SELECT workspace_id, stream_id, request_hash, response
      FROM swarm.idempotency_keys
      WHERE principal_kind = ${auth.credentialKind}
        AND principal_id = ${canonicalPrincipal(auth.actor)}
        AND command_id = ${commandId}
      LIMIT 1
    `;
    const existing = existingRows[0];
    if (existing) {
      const matches = existing.request_hash === hash &&
        existing.workspace_id === route.workspaceId &&
        existing.stream_id === route.streamId;
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: matches ? "replayed" : "conflict",
        reason: matches ? null : "command_id_conflict",
        detail: ignoredIdentity,
        hash,
      });
      return matches
        ? replayResult(storedResponse(existing.response), kind)
        : { status: 409, body: { error: "command_id_conflict" } };
    }
    await afterStep(7);

    if (command.kind === "post_signal") {
      if (!await signalTargetIsLive(tx, route, command.to_user_id)) {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: "authz",
          reason: "signal target is not a live workspace member",
          hash,
        });
        return { status: 403, body: { error: "forbidden" } };
      }
      const rateLimit = await enforceSignalRate(
        tx,
        auth,
        route.workspaceId,
      );
      if (rateLimit !== null) {
        const detail =
          `${rateLimit.bucket} limit ${rateLimit.limit} signals/hour; resets at ${rateLimit.resetsAt}`;
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: "rate_limit",
          reason: "rate_limited",
          detail,
          hash,
        });
        await tx`
          INSERT INTO swarm.security_alerts (kind, subject, detail)
          VALUES (
            'signal_rate_limit',
            ${rateLimit.bucket},
            ${tx.json({
              workspace_id: route.workspaceId,
              credential_kind: auth.credentialKind,
              credential_id: auth.credentialId,
              limit: rateLimit.limit,
              resets_at: rateLimit.resetsAt,
            })}::jsonb
          )
        `;
        return {
          status: 429,
          body: {
            error: "rate_limited",
            message: `Signal refused: ${detail}.`,
            limit: rateLimit.limit,
            resets_at: rateLimit.resetsAt,
          },
        };
      }

      const signal = await postSignal(tx, route, auth, command);
      const signalResponse: StoredResponse = {
        ok: true,
        event_ids: [],
        signal,
      };
      const inserted = await tx<{ command_id: string }[]>`
        INSERT INTO swarm.idempotency_keys (
          principal_kind, principal_id, command_id,
          workspace_id, stream_id, request_hash, response
        ) VALUES (
          ${auth.credentialKind},
          ${canonicalPrincipal(auth.actor)},
          ${commandId},
          ${route.workspaceId}::uuid,
          ${route.streamId}::uuid,
          ${hash},
          ${tx.json(signalResponse as unknown as postgres.JSONValue)}::jsonb
        )
        ON CONFLICT (principal_kind, principal_id, command_id) DO NOTHING
        RETURNING command_id
      `;
      if (inserted.length === 0) {
        throw new LedgerRace(
          auth,
          commandId,
          kind,
          route.workspaceId,
          route.streamId,
          hash,
        );
      }
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "accepted",
        detail: ignoredIdentity,
        hash,
      });
      return {
        status: 200,
        body: {
          status: "accepted",
          ...signalResponse,
          events: [],
          min_client_version: minClientVersion,
        },
      };
    }

    await beforeStep(8);
    const streamRows = await tx<{ head_seq: string | number }[]>`
      SELECT head_seq
      FROM swarm.streams
      WHERE stream_id = ${route.streamId}::uuid
        AND workspace_id = ${route.workspaceId}::uuid
      FOR UPDATE
    `;
    if (!streamRows[0]) throw new Error("validated stream disappeared");
    const headSeq = Number(streamRows[0].head_seq);
    await afterStep(8);

    await beforeStep(9);
    const timeRows = await tx<{ now_ms: string | number }[]>`
      SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS now_ms
    `;
    let now = Number(timeRows[0]?.now_ms);
    const workspaceWire =
      (CONNECT_COMMAND_KINDS as readonly string[]).includes(command.kind)
        ? command as ConnectCommand
        : null;
    let prepared: PreparedWorkspace | null = null;
    let priorRow: Record<string, unknown> | undefined;
    let prior: TaskState | null = null;
    let ctx: DecideCtx | null = null;
    if (workspaceWire !== null) {
      prepared = await prepareWorkspaceCommand(
        tx,
        route,
        auth,
        workspaceWire,
        commandId,
        headSeq,
        now,
      );
    } else {
      const taskCommand = command as Command;
      const taskRows = await tx<Record<string, unknown>[]>`
        SELECT
          task_id, slug, lifecycle, version, epoch, owner,
          lease_expiry, submission, closed_disposition, updated_at
        FROM swarm.tasks
        WHERE stream_id = ${route.streamId}::uuid
          AND task_id = ${taskCommand.task_id}::uuid
        LIMIT 1
      `;
      priorRow = taskRows[0];
      prior = stateFromRow(priorRow);
      ctx = await buildContext(
        tx,
        route,
        auth,
        taskCommand,
        commandId,
        prior,
        headSeq,
        now,
      );
    }
    await afterStep(9);

    await beforeStep(10);
    let outcome: FreshOutcome;
    if (prepared !== null) {
      let decision = decideWorkspace(
        prepared.state,
        prepared.command,
        prepared.ctx,
      ) as Decision;
      if (
        decision.ok &&
        prepared.command.kind === "accept_invitation" &&
        !await consumeInvitation(tx, prepared, auth, now)
      ) {
        const retryTime = await tx<{ now_ms: string | number }[]>`
          SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS now_ms
        `;
        now = Number(retryTime[0]?.now_ms);
        prepared = await prepareWorkspaceCommand(
          tx,
          route,
          auth,
          workspaceWire!,
          commandId,
          headSeq,
          now,
        );
        decision = decideWorkspace(
          prepared.state,
          prepared.command,
          prepared.ctx,
        ) as Decision;
        if (decision.ok) {
          throw new Error("invitation atomic consumption lost without a domain state change");
        }
      }
      const response: StoredResponse = decision.ok
        ? {
          ok: true,
          event_ids: decision.events.map((event) => event.event_id),
          ...(prepared.command.kind === "invite_member"
            ? { invitation_id: prepared.command.invitation_id }
            : prepared.command.kind === "create_agent_principal"
            ? { principal_id: prepared.command.principal_id }
            : prepared.command.kind === "mint_agent_token"
            ? {
              token_id: prepared.command.token_id,
              principal_id: prepared.command.principal_id,
              run_id: prepared.command.run_id,
            }
            : { workspace_id: route.workspaceId }),
        }
        : {
          ok: false,
          reason: decision.reason,
          detail: decision.detail,
          class: decision.class,
          event_ids: decision.events.map((event) => event.event_id),
        };
      outcome = {
        status: "fresh",
        decision,
        response,
        events: decision.events,
      };
    } else {
      outcome = applyCommand(
        new Map(),
        prior,
        command as Command,
        ctx!,
      ) as FreshOutcome;
      if (outcome.status !== "fresh") {
        throw new Error("empty in-memory ledger unexpectedly replayed/conflicted");
      }
    }
    await afterStep(10);

    if (!outcome.decision.ok && outcome.decision.class === "authz") {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "authz",
        reason: outcome.decision.reason,
        detail: [ignoredIdentity, outcome.decision.detail].filter(Boolean).join("; "),
        hash,
      });
      return { status: 403, body: { error: "forbidden" } };
    }

    await beforeStep(11);
    await appendEvents(tx, outcome.events);
    if (outcome.events.length > 0) {
      await tx`
        UPDATE swarm.streams
        SET head_seq = ${headSeq + outcome.events.length}
        WHERE stream_id = ${route.streamId}::uuid
      `;
    }
    await afterStep(11);

    await beforeStep(12);
    if (prepared !== null) {
      await updateWorkspaceProjection(tx, route, prepared, outcome.events);
    } else {
      await updateProjection(
        tx,
        route,
        prior,
        priorRow?.updated_at instanceof Date ? priorRow.updated_at : null,
        outcome.events,
        now,
      );
    }
    await afterStep(12);

    await beforeStep(13);
    if (prepared === null) {
      await applyEventSideEffects(tx, outcome.events);
    }
    await afterStep(13);

    await beforeStep(14);
    const inserted = await tx<{ command_id: string }[]>`
      INSERT INTO swarm.idempotency_keys (
        principal_kind, principal_id, command_id,
        workspace_id, stream_id, request_hash, response
      ) VALUES (
        ${auth.credentialKind},
        ${canonicalPrincipal(auth.actor)},
        ${commandId},
        ${route.workspaceId}::uuid,
        ${route.streamId}::uuid,
        ${hash},
        ${tx.json(outcome.response as unknown as postgres.JSONValue)}::jsonb
      )
      ON CONFLICT (principal_kind, principal_id, command_id) DO NOTHING
      RETURNING command_id
    `;
    if (inserted.length === 0) {
      throw new LedgerRace(
        auth,
        commandId,
        kind,
        route.workspaceId,
        route.streamId,
        hash,
      );
    }
    await insertAudit(tx, {
      auth,
      commandKind: kind,
      workspaceId: route.workspaceId,
      streamId: route.streamId,
      outcome: outcome.decision.ok ? "accepted" : "domain",
      reason: outcome.decision.ok ? null : outcome.decision.reason,
      detail: [
        ignoredIdentity,
        outcome.decision.ok ? null : outcome.decision.detail,
      ].filter(Boolean).join("; "),
      hash,
    });
    await afterStep(14);

    await beforeStep(15);
    const freshOnly: Record<string, unknown> = {};
    if (prepared?.command.kind === "invite_member") {
      freshOnly.invitation_token = prepared.invitationToken;
      const inviters = await tx<{ display_name: string }[]>`
        SELECT display_name
        FROM swarm.users
        WHERE user_id = ${auth.actor.user}::uuid
        LIMIT 1
      `;
      freshOnly.workspace_id = route.workspaceId;
      freshOnly.workspace_name = displayLabel(
        prepared.state.workspace.name,
        "this swarm",
      );
      freshOnly.inviter_display_name = displayLabel(
        inviters[0]?.display_name,
        "the inviter",
      );
      freshOnly.inviter_user_id = auth.actor.user;
    } else if (prepared?.command.kind === "mint_agent_token") {
      freshOnly.agent_token = prepared.agentToken;
    }
    const result: HttpResult =
      prepared?.command.kind === "accept_invitation" && !outcome.decision.ok
        ? { status: 403, body: { error: "forbidden" } }
        : outcome.decision.ok
      ? {
        status: 200,
        body: {
          status: "accepted",
          ...outcome.response,
          events: outcome.events,
          min_client_version: minClientVersion,
          ...freshOnly,
        },
      }
      : {
        status: 200,
        body: {
          status: "rejected",
          ...outcome.response,
          min_client_version: minClientVersion,
        },
      };
    await afterStep(15);
    return result;
  });
}

async function resolveLedgerRace(error: LedgerRace): Promise<HttpResult> {
  return await db.begin(async (tx) => {
    await setTransaction(tx);
    const rows = await tx<
      {
        workspace_id: string;
        stream_id: string;
        request_hash: string;
        response: unknown;
      }[]
    >`
      SELECT workspace_id, stream_id, request_hash, response
      FROM swarm.idempotency_keys
      WHERE principal_kind = ${error.auth.credentialKind}
        AND principal_id = ${canonicalPrincipal(error.auth.actor)}
        AND command_id = ${error.commandId}
      LIMIT 1
    `;
    const winner = rows[0];
    if (!winner) throw new Error("idempotency race winner is missing");
    const matches = winner.request_hash === error.hash &&
      winner.workspace_id === error.workspaceId &&
      winner.stream_id === error.streamId;
    await insertAudit(tx, {
      auth: error.auth,
      commandKind: error.commandKind,
      workspaceId: error.workspaceId,
      streamId: error.streamId,
      outcome: matches ? "replayed" : "conflict",
      reason: matches ? null : "command_id_conflict",
      hash: error.hash,
      detail: "resolved concurrent idempotency race",
    });
    return matches
      ? replayResult(storedResponse(winner.response), error.commandKind)
      : { status: 409, body: { error: "command_id_conflict" } };
  });
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  const parsed = await readBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const kind = commandKind(body);
  if (
    typeof body.command_id !== "string" ||
    !COMMAND_ID_RE.test(body.command_id)
  ) {
    logCommandFailure(
      "command_pre_auth_failure",
      kind,
      "validation",
      "invalid command_id",
    );
    return json(400, { error: "invalid_request" });
  }

  const credential = bearer(request);
  if (!credential) {
    logCommandFailure(
      "command_pre_auth_failure",
      kind,
      "authn",
      "missing bearer",
    );
    return json(401, { error: "unauthenticated" });
  }

  let verifiedHuman: VerifiedHuman | null = null;
  let agentTokenHash: Uint8Array | null = null;
  if (credential.startsWith("swm_agt_")) {
    if (!AGENT_TOKEN_RE.test(credential)) {
      logCommandFailure(
        "command_pre_auth_failure",
        kind,
        "authn",
        "invalid agent token",
      );
      return json(401, { error: "unauthenticated" });
    }
    agentTokenHash = await sha256(credential);
  } else {
    const { data, error } = await authClient.auth.getUser(credential);
    if (error || !data.user) {
      logCommandFailure(
        "command_pre_auth_failure",
        kind,
        "authn",
        "unverified user token",
      );
      return json(401, { error: "unauthenticated" });
    }
    const metadata = record(data.user.user_metadata);
    const email = normalizedEmail(data.user.email);
    const displayNameCandidate = [
      metadata?.full_name,
      metadata?.name,
      metadata?.user_name,
      email?.split("@")[0],
    ].find((value) => typeof value === "string" && value.length > 0);
    const strippedDisplayName = stripControls(
      typeof displayNameCandidate === "string"
        ? displayNameCandidate.replace(ANSI_ESCAPE_GLOBAL_RE, "")
        : null,
    )?.trim().slice(0, 120);
    verifiedHuman = {
      userId: data.user.id,
      email,
      displayName: strippedDisplayName || "Coswarm User",
      identityVerified: data.user.email_confirmed_at !== undefined &&
        data.user.email_confirmed_at !== null,
    };
  }

  try {
    const result = await handleTransaction(
      body,
      verifiedHuman,
      agentTokenHash,
    );
    return json(result.status, result.body);
  } catch (error) {
    if (error instanceof LedgerRace) {
      try {
        const result = await resolveLedgerRace(error);
        return json(result.status, result.body);
      } catch (raceError) {
        console.error("command race resolution failed", safeError(raceError));
      }
    }
    const isTestRollback = error instanceof TestRollback;
    const isLockTimeout = dbCode(error) === "55P03";
    logCommandFailure(
      "command_request_failure",
      kind,
      "error",
      isTestRollback
        ? "test_rollback"
        : isLockTimeout
        ? "lock_timeout"
        : "internal_error",
      safeError(error),
    );
    return isLockTimeout
      ? json(503, { error: "temporarily_unavailable" })
      : json(500, { error: "internal_error" });
  }
}

Deno.serve(handleRequest);
