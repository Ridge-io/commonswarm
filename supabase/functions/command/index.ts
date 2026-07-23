import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import postgres from "npm:postgres@3.4.9";
// Supabase's edge graph cannot resolve the NodeNext `.js` specifiers in the
// frozen TypeScript core. This checked-in bundle is regenerated directly from
// src/protocol/index.ts by build:command-core; it is not a second implementation.
import {
  applyCommand,
  canonicalPrincipal,
  DISPOSITIONS,
  reduceTask,
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

interface StoredResponse {
  ok: boolean;
  reason?: string;
  detail?: string;
  class?: "authz" | "domain";
  event_ids: string[];
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
const COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,72}$/;
const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_GLOBAL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const COMMAND_KINDS = [
  "create",
  "acquire",
  "renew",
  "handoff",
  "takeover",
  "submit",
  "close",
  "reopen",
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

interface AgentAuthRow {
  token_id: string;
  principal_id: string;
  run_id: string;
  device_id: string;
  owner_user_id: string;
  principal_workspace_id: string;
  lineage_id: string;
  scopes: unknown;
  surrender_only: boolean;
  token_revoked_at: Date | null;
  principal_revoked_at: Date | null;
  run_ended_at: Date | null;
  device_revoked_at: Date | null;
  unexpired: boolean;
}

interface AuthContext {
  credentialKind: CredentialKind;
  credentialId: string | null;
  deviceId: string | null;
  actor: Actor;
  agent: AgentAuthRow | null;
}

interface Route {
  workspaceId: string;
  streamId: string;
  membershipRole: Role;
  membershipRevokedAt: Date | null;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

interface Audit {
  auth?: AuthContext | null;
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

async function setTransaction(tx: Sql): Promise<void> {
  await tx.unsafe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  await tx.unsafe("SET LOCAL ROLE swarm_command");
  await tx.unsafe("SET LOCAL search_path = swarm, pg_catalog");
  await tx.unsafe("SET LOCAL lock_timeout = '5s'");
}

async function insertAudit(tx: Sql, audit: Audit): Promise<void> {
  const auth = audit.auth ?? null;
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

async function standaloneAudit(audit: Audit): Promise<void> {
  try {
    await db.begin(async (tx) => {
      await setTransaction(tx);
      await insertAudit(tx, audit);
    });
  } catch (error) {
    console.error("command audit write failed", safeError(error));
  }
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${stripControls(error.message) ?? ""}`.slice(0, 512);
  }
  return "unknown error";
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

function nullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && UUID_RE.test(value));
}

function validateCommand(
  value: unknown,
): { ok: true; command: Command } | { ok: false; status: number; reason: string } {
  const cmd = record(value);
  if (!cmd || typeof cmd.kind !== "string") {
    return { ok: false, status: 400, reason: "invalid command shape" };
  }
  if (!(COMMAND_KINDS as readonly string[]).includes(cmd.kind)) {
    return { ok: false, status: 400, reason: "unknown command kind" };
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
  };
}

function replayResult(response: StoredResponse): HttpResult {
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
  const rows = await tx<AgentAuthRow[]>`
    SELECT
      t.token_id, t.principal_id, t.run_id, r.device_id,
      p.owner_user_id, p.workspace_id AS principal_workspace_id,
      t.lineage_id, t.scopes, t.surrender_only,
      t.revoked_at AS token_revoked_at,
      p.revoked_at AS principal_revoked_at,
      r.ended_at AS run_ended_at,
      d.revoked_at AS device_revoked_at,
      t.expires_at > statement_timestamp() AS unexpired
    FROM swarm.agent_tokens AS t
    JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
    JOIN swarm.agent_runs AS r
      ON r.run_id = t.run_id AND r.principal_id = t.principal_id
    JOIN swarm.devices AS d ON d.device_id = r.device_id
    WHERE t.token_hash = ${tokenHash}
    LIMIT 1
  `;
  const agent = rows[0];
  if (!agent || !agent.unexpired) return null;
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
  };
}

async function authenticateHuman(
  tx: Sql,
  verifiedUserId: string,
): Promise<AuthContext | null> {
  const rows = await tx<{ user_id: string }[]>`
    SELECT user_id
    FROM swarm.users
    WHERE user_id = ${verifiedUserId}::uuid
    LIMIT 1
  `;
  if (!rows[0]) return null;
  return {
    credentialKind: "user",
    credentialId: null,
    deviceId: null,
    actor: { user: rows[0].user_id, agent_principal: null, run: null },
    agent: null,
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

async function revoked(
  tx: Sql,
  auth: AuthContext,
  route: Route,
): Promise<boolean> {
  if (route.membershipRevokedAt !== null) return true;
  const agent = auth.agent;
  if (!agent) return false;
  if (
    agent.token_revoked_at !== null ||
    agent.principal_revoked_at !== null ||
    agent.run_ended_at !== null ||
    agent.device_revoked_at !== null ||
    agent.surrender_only
  ) {
    return true;
  }

  const targets: Array<[string, string]> = [
    ["token", agent.token_id],
    ["principal", agent.principal_id],
    ["run", agent.run_id],
    ["device", agent.device_id],
    ["membership", agent.owner_user_id],
    ["lineage", agent.lineage_id],
    ["family", agent.lineage_id],
  ];
  const ids = [...new Set(targets.map(([, id]) => id))];
  const rows = await tx<{ kind: string; target_id: string }[]>`
    SELECT kind, target_id
    FROM swarm.revocation_tombstones
    WHERE target_id = ANY(${ids}::uuid[])
  `;
  const expected = new Set(targets.map(([kind, id]) => `${kind}:${id}`));
  return rows.some((row) => expected.has(`${row.kind}:${row.target_id}`));
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

async function handleTransaction(
  body: RequestBody,
  verifiedUserId: string | null,
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
      : verifiedUserId !== null
      ? await authenticateHuman(tx, verifiedUserId)
      : null;
    if (!auth) {
      await insertAudit(tx, {
        commandKind: kind,
        outcome: "authn",
        reason: "unauthenticated",
      });
      return { status: 401, body: { error: "unauthenticated" } };
    }
    await afterStep(3);

    await beforeStep(4);
    const ignoredIdentity = forgedActorDetail(body);
    await afterStep(4);

    await beforeStep(5);
    const route = await resolveRoute(tx, body, auth);
    if (!route) {
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
        ? replayResult(storedResponse(existing.response))
        : { status: 409, body: { error: "command_id_conflict" } };
    }
    await afterStep(7);

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
    const taskRows = await tx<Record<string, unknown>[]>`
      SELECT
        task_id, slug, lifecycle, version, epoch, owner,
        lease_expiry, submission, closed_disposition, updated_at
      FROM swarm.tasks
      WHERE stream_id = ${route.streamId}::uuid
        AND task_id = ${command.task_id}::uuid
      LIMIT 1
    `;
    const priorRow = taskRows[0];
    const prior = stateFromRow(priorRow);
    const timeRows = await tx<{ now_ms: string | number }[]>`
      SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS now_ms
    `;
    const now = Number(timeRows[0]?.now_ms);
    const ctx = await buildContext(
      tx,
      route,
      auth,
      command,
      commandId,
      prior,
      headSeq,
      now,
    );
    await afterStep(9);

    await beforeStep(10);
    const outcome = applyCommand(new Map(), prior, command, ctx) as FreshOutcome;
    if (outcome.status !== "fresh") {
      throw new Error("empty in-memory ledger unexpectedly replayed/conflicted");
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
    await updateProjection(
      tx,
      route,
      prior,
      priorRow?.updated_at instanceof Date ? priorRow.updated_at : null,
      outcome.events,
      now,
    );
    await afterStep(12);

    await beforeStep(13);
    await applyEventSideEffects(tx, outcome.events);
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
    const result: HttpResult = outcome.decision.ok
      ? {
        status: 200,
        body: {
          status: "accepted",
          ...outcome.response,
          events: outcome.events,
          min_client_version: minClientVersion,
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
      ? replayResult(storedResponse(winner.response))
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
    await standaloneAudit({
      commandKind: kind,
      outcome: "validation",
      reason: "invalid command_id",
    });
    return json(400, { error: "invalid_request" });
  }

  const credential = bearer(request);
  if (!credential) {
    await standaloneAudit({
      commandKind: kind,
      outcome: "authn",
      reason: "unauthenticated",
    });
    return json(401, { error: "unauthenticated" });
  }

  let verifiedUserId: string | null = null;
  let agentTokenHash: Uint8Array | null = null;
  if (credential.startsWith("swm_agt_")) {
    if (!AGENT_TOKEN_RE.test(credential)) {
      await standaloneAudit({
        commandKind: kind,
        outcome: "authn",
        reason: "unauthenticated",
      });
      return json(401, { error: "unauthenticated" });
    }
    agentTokenHash = await sha256(credential);
  } else {
    const { data, error } = await authClient.auth.getUser(credential);
    if (error || !data.user) {
      await standaloneAudit({
        commandKind: kind,
        outcome: "authn",
        reason: "unauthenticated",
      });
      return json(401, { error: "unauthenticated" });
    }
    verifiedUserId = data.user.id;
  }

  try {
    const result = await handleTransaction(
      body,
      verifiedUserId,
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
    await standaloneAudit({
      commandKind: kind,
      outcome: "error",
      reason: isTestRollback
        ? "test_rollback"
        : isLockTimeout
        ? "lock_timeout"
        : "internal_error",
      detail: safeError(error),
    });
    return isLockTimeout
      ? json(503, { error: "temporarily_unavailable" })
      : json(500, { error: "internal_error" });
  }
}

Deno.serve(handleRequest);
