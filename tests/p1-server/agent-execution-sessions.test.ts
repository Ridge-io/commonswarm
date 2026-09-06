/**
 * Agent execution sessions against the served command function and real Postgres.
 *
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import {
  AGENT_SESSION_GENERATION_HEADER,
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_KEY_HEADER,
} from "../../src/cloud/session-wire.js";
import { awaitFunctionRunning } from "../support/edge-readiness.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDir: string | undefined;

interface SharedFixture {
  workspace: string;
  ownerId: string;
  ownerJwt: string;
  device: string;
}

let shared: SharedFixture;

function localEnvironment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(
    parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL &&
      parsed.SERVICE_ROLE_KEY,
  );
  return parsed as LocalEnvironment;
}

async function createUser(
  label: string,
): Promise<{ id: string; jwt: string }> {
  const email = `synth-${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  assert.ok(signedIn.data.session?.access_token);
  return { id: created.data.user.id, jwt: signedIn.data.session.access_token };
}

function synthKey(): string {
  return randomBytes(32).toString("base64url");
}

function synthToken(): string {
  return `swm_agt_${randomBytes(32).toString("base64url")}`;
}

function proofHeaders(
  sessionId: string,
  generation: number,
  key: string,
): Record<string, string> {
  return {
    [AGENT_SESSION_ID_HEADER]: sessionId,
    [AGENT_SESSION_GENERATION_HEADER]: String(generation),
    [AGENT_SESSION_KEY_HEADER]: key,
  };
}

function acquireHeaders(sessionId: string, key: string): Record<string, string> {
  return {
    [AGENT_SESSION_ID_HEADER]: sessionId,
    [AGENT_SESSION_KEY_HEADER]: key,
  };
}

async function runCmd(
  token: string,
  command: Record<string, unknown>,
  options: {
    commandId?: string;
    headers?: Record<string, string>;
    workspace?: string;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const workspace = options.workspace ?? shared.workspace;
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify({
      command_id: options.commandId ?? randomUUID(),
      client_version: "0.1.0",
      workspace_id: workspace,
      stream: { kind: "workspace" },
      command,
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body };
}

interface SeededAgent {
  principalId: string;
  token: string;
}

async function seedAgent(label: string): Promise<SeededAgent> {
  const principalId = randomUUID();
  const token = synthToken();
  const run = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${principalId}::uuid,
        ${shared.workspace}::uuid,
        ${shared.ownerId}::uuid,
        ${`synth-${label}-${principalId.slice(0, 8)}`}
      )
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principalId}::uuid, ${shared.device}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id
      ) VALUES (
        ${randomUUID()}::uuid, ${principalId}::uuid, ${run}::uuid,
        ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  });
  return { principalId, token };
}

async function enable(principalId: string) {
  const result = await runCmd(shared.ownerJwt, {
    kind: "enable_agent_management",
    principal_id: principalId,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}

async function acquire(token: string, sessionId: string, key: string) {
  return await runCmd(
    token,
    { kind: "acquire_agent_session", session_id: sessionId },
    { headers: acquireHeaders(sessionId, key) },
  );
}

function noteBody(): Record<string, unknown> {
  return {
    kind: "post_signal",
    signal_kind: "note",
    body: `synth-note-${randomUUID()}`,
    to_user_id: null,
    about: null,
    to_agent_principal_id: null,
    in_reply_to: null,
  };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-session-env-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\n");
  functionProcess = spawn(
    "supabase",
    ["functions", "serve", "--no-verify-jwt", "--env-file", envFile],
    {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const capture = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000);
  };
  functionProcess.stdout?.on("data", capture);
  functionProcess.stderr?.on("data", capture);
  {
    const bootDeadline = Date.now() + 60_000;
    while (!functionLogs.includes("Serving functions on")) {
      if (Date.now() > bootDeadline) {
        throw new Error(
          `functions serve never booted:\n${functionLogs.slice(-3000)}`,
        );
      }
      await delay(250);
    }
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `command function logs:\n${functionLogs.slice(-4000)}`,
  });

  const owner = await createUser("session-owner");
  const workspace = randomUUID();
  const device = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, 'SynthSessionOwner')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'synth-session-device')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'SynthSessionWS', ${owner.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')
    `;
  });
  shared = {
    workspace,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    device,
  };
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      functionProcess.once("close", () => resolve(true));
    });
    functionProcess.kill();
    const stopped = await Promise.race([
      exited,
      delay(2_000).then(() => false),
    ]);
    if (!stopped && functionProcess.exitCode === null) {
      functionProcess.kill("SIGKILL");
    }
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});

test("two racing sessions: one winner, other principal unaffected", async () => {
  const a = await seedAgent("race-a");
  const b = await seedAgent("race-b");
  await enable(a.principalId);
  await enable(b.principalId);
  const sessionA1 = randomUUID();
  const sessionA2 = randomUUID();
  const keyA1 = synthKey();
  const keyA2 = synthKey();
  const [first, second] = await Promise.all([
    acquire(a.token, sessionA1, keyA1),
    acquire(a.token, sessionA2, keyA2),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const winner = first.status === 200 ? first : second;
  const loser = first.status === 200 ? second : first;
  assert.equal(typeof winner.body.generation, "number");
  assert.equal(loser.body.error, "session_conflict");
  const sessionB = randomUUID();
  const heldB = await acquire(b.token, sessionB, synthKey());
  assert.equal(heldB.status, 200, JSON.stringify(heldB.body));
});

test("wrong principal, wrong key, and wrong generation each refused with its typed code", async () => {
  const a = await seedAgent("wrong-a");
  const b = await seedAgent("wrong-b");
  await enable(a.principalId);
  await enable(b.principalId);
  const sessionA = randomUUID();
  const keyA = synthKey();
  const heldA = await acquire(a.token, sessionA, keyA);
  assert.equal(heldA.status, 200, JSON.stringify(heldA.body));
  const generation = Number(heldA.body.generation);
  const sessionB = randomUUID();
  const keyB = synthKey();
  const heldB = await acquire(b.token, sessionB, keyB);
  assert.equal(heldB.status, 200, JSON.stringify(heldB.body));

  const wrongPrincipal = await runCmd(b.token, noteBody(), {
    headers: proofHeaders(sessionA, generation, keyA),
  });
  assert.equal(wrongPrincipal.status, 409);
  assert.equal(wrongPrincipal.body.error, "session_conflict");

  const wrongKey = await runCmd(a.token, noteBody(), {
    headers: proofHeaders(sessionA, generation, synthKey()),
  });
  assert.equal(wrongKey.status, 401);
  assert.equal(wrongKey.body.error, "session_proof_invalid");

  const wrongGeneration = await runCmd(a.token, noteBody(), {
    headers: proofHeaders(sessionA, generation + 1, keyA),
  });
  assert.equal(wrongGeneration.status, 409);
  assert.equal(wrongGeneration.body.error, "session_conflict");
});

test("expiry then recovery increments generation", async () => {
  const agent = await seedAgent("expiry");
  await enable(agent.principalId);
  const sessionId = randomUUID();
  const key = synthKey();
  const held = await acquire(agent.token, sessionId, key);
  assert.equal(held.status, 200, JSON.stringify(held.body));
  const generation = Number(held.body.generation);
  await sql`
    UPDATE swarm.agent_execution_sessions
    SET expired_at = statement_timestamp() - interval '1 second'
    WHERE principal_id = ${agent.principalId}::uuid
  `;
  const expiredWrite = await runCmd(agent.token, noteBody(), {
    headers: proofHeaders(sessionId, generation, key),
  });
  assert.equal(expiredWrite.status, 401);
  assert.equal(expiredWrite.body.error, "session_expired");
  const next = randomUUID();
  const recovered = await acquire(agent.token, next, synthKey());
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(Number(recovered.body.generation), generation + 1);
});

test("acquire retry with the same UUID+key succeeds; a retired UUID cannot acquire", async () => {
  const agent = await seedAgent("retry");
  await enable(agent.principalId);
  const sessionId = randomUUID();
  const key = synthKey();
  const first = await acquire(agent.token, sessionId, key);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const generation = Number(first.body.generation);
  const retry = await acquire(agent.token, sessionId, key);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(Number(retry.body.generation), generation);
  const recovered = await runCmd(shared.ownerJwt, {
    kind: "recover_agent_session",
    principal_id: agent.principalId,
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  const retired = await acquire(agent.token, sessionId, key);
  assert.equal(retired.status, 403);
  assert.equal(retired.body.error, "session_retired");
});

test("human recovery revokes the session and leaves enforcement on", async () => {
  const agent = await seedAgent("recover");
  await enable(agent.principalId);
  const sessionId = randomUUID();
  const key = synthKey();
  const held = await acquire(agent.token, sessionId, key);
  assert.equal(held.status, 200, JSON.stringify(held.body));
  const generation = Number(held.body.generation);
  const recovered = await runCmd(shared.ownerJwt, {
    kind: "recover_agent_session",
    principal_id: agent.principalId,
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  const [row] = await sql<{ managed_at: Date | null }[]>`
    SELECT managed_at
    FROM swarm.agent_principals
    WHERE principal_id = ${agent.principalId}::uuid
  `;
  assert.ok(row?.managed_at, "enforcement stays on after recovery");
  const stale = await runCmd(agent.token, noteBody(), {
    headers: proofHeaders(sessionId, generation, key),
  });
  assert.equal(stale.status, 401);
  assert.equal(stale.body.error, "session_expired");
  const missing = await runCmd(agent.token, noteBody());
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, "session_proof_missing");
});

test("missing proof is refused; old-proof replay is refused; current holder retries the same command_id", async () => {
  const agent = await seedAgent("replay");
  await enable(agent.principalId);
  const sessionId = randomUUID();
  const key = synthKey();
  const held = await acquire(agent.token, sessionId, key);
  assert.equal(held.status, 200, JSON.stringify(held.body));
  const generation = Number(held.body.generation);
  const missing = await runCmd(agent.token, noteBody());
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, "session_proof_missing");

  const commandId = randomUUID();
  const command = noteBody();
  const posted = await runCmd(agent.token, command, {
    commandId,
    headers: proofHeaders(sessionId, generation, key),
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signalId = (posted.body.signal as { id?: string } | undefined)?.id;
  assert.equal(typeof signalId, "string");

  const recovered = await runCmd(shared.ownerJwt, {
    kind: "recover_agent_session",
    principal_id: agent.principalId,
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  const nextSession = randomUUID();
  const nextKey = synthKey();
  const nextHold = await acquire(agent.token, nextSession, nextKey);
  assert.equal(nextHold.status, 200, JSON.stringify(nextHold.body));
  const nextGeneration = Number(nextHold.body.generation);

  const staleReplay = await runCmd(agent.token, command, {
    commandId,
    headers: proofHeaders(sessionId, generation, key),
  });
  assert.equal(staleReplay.status, 409, JSON.stringify(staleReplay.body));
  assert.equal(staleReplay.body.error, "session_conflict");

  const currentReplay = await runCmd(agent.token, command, {
    commandId,
    headers: proofHeaders(nextSession, nextGeneration, nextKey),
  });
  assert.equal(currentReplay.status, 200, JSON.stringify(currentReplay.body));
  const replayedId =
    (currentReplay.body.signal as { id?: string } | undefined)?.id;
  assert.equal(replayedId, signalId);
});

test("stale claim and ACK are refused", async () => {
  const agent = await seedAgent("stale-claim");
  await enable(agent.principalId);
  const sessionId = randomUUID();
  const key = synthKey();
  const held = await acquire(agent.token, sessionId, key);
  assert.equal(held.status, 200, JSON.stringify(held.body));
  const generation = Number(held.body.generation);
  const posted = await runCmd(shared.ownerJwt, {
    kind: "post_signal",
    signal_kind: "ask",
    body: `synth-ask-${randomUUID()}`,
    to_user_id: null,
    about: null,
    to_agent_principal_id: agent.principalId,
    in_reply_to: null,
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const listener = randomUUID();
  const claim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: listener },
    { headers: proofHeaders(sessionId, generation, key) },
  );
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const deliveries = claim.body.deliveries as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(deliveries) && deliveries.length >= 1);
  const leaseId = String(deliveries[0]?.lease_id);
  const signalId = String(
    (deliveries[0]?.signal as { id?: string } | undefined)?.id,
  );
  const recovered = await runCmd(shared.ownerJwt, {
    kind: "recover_agent_session",
    principal_id: agent.principalId,
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  const staleClaim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: listener },
    { headers: proofHeaders(sessionId, generation, key) },
  );
  assert.equal(staleClaim.status, 401);
  assert.equal(staleClaim.body.error, "session_expired");
  const staleAck = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: leaseId,
      listener_instance_id: listener,
      outcome: "observed",
      last_error_code: null,
    },
    { headers: proofHeaders(sessionId, generation, key) },
  );
  assert.equal(staleAck.status, 401);
  assert.equal(staleAck.body.error, "session_expired");
});

test("unsurfaced host loss reclaims pending rows on recovery without consuming retries", async () => {
  const agent = await seedAgent("unsurfaced");
  await enable(agent.principalId);
  const sessionId = randomUUID();
  const key = synthKey();
  const held = await acquire(agent.token, sessionId, key);
  assert.equal(held.status, 200, JSON.stringify(held.body));
  const generation = Number(held.body.generation);
  const posted = await runCmd(shared.ownerJwt, {
    kind: "post_signal",
    signal_kind: "ask",
    body: `synth-unsurfaced-${randomUUID()}`,
    to_user_id: null,
    about: null,
    to_agent_principal_id: agent.principalId,
    in_reply_to: null,
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signalId = String(
    (posted.body.signal as { id?: string } | undefined)?.id,
  );
  const listener = randomUUID();
  const claim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: listener },
    { headers: proofHeaders(sessionId, generation, key) },
  );
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const before = await sql<{
    lease_id: string | null;
    attempt_count: number;
  }[]>`
    SELECT lease_id::text, attempt_count
    FROM swarm.signal_deliveries
    WHERE signal_id = ${signalId}::uuid
      AND recipient_agent_principal_id = ${agent.principalId}::uuid
  `;
  assert.equal(before.length, 1);
  assert.ok(before[0]?.lease_id);
  const attempts = before[0]!.attempt_count;
  const recovered = await runCmd(shared.ownerJwt, {
    kind: "recover_agent_session",
    principal_id: agent.principalId,
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  const after = await sql<{
    lease_id: string | null;
    attempt_count: number;
    acked_at: Date | null;
  }[]>`
    SELECT lease_id::text, attempt_count, acked_at
    FROM swarm.signal_deliveries
    WHERE signal_id = ${signalId}::uuid
      AND recipient_agent_principal_id = ${agent.principalId}::uuid
  `;
  assert.equal(after[0]?.lease_id, null);
  assert.equal(after[0]?.attempt_count, attempts);
  assert.equal(after[0]?.acked_at, null);
});

test("swarm_read.agent_principals does not project wake_id and does project managed_at", async () => {
  const cols = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'swarm_read'
      AND table_name = 'agent_principals'
  `;
  const names = cols.map((row) => row.column_name);
  assert.equal(names.includes("wake_id"), false);
  assert.equal(names.includes("managed_at"), true);
  const contextCols = await sql<{ name: string }[]>`
    SELECT unnest(proargnames) AS name
    FROM pg_proc
    JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
    WHERE nspname = 'swarm'
      AND proname = 'agent_delivery_read_context'
  `;
  const contextNames = contextCols.map((row) => row.name);
  assert.equal(contextNames.includes("managed_at"), true);
  assert.equal(contextNames.includes("wake_id"), true);
});

test("unmanaged principal keeps legacy behaviour: post_signal with no headers succeeds", async () => {
  const agent = await seedAgent("unmanaged");
  const posted = await runCmd(agent.token, noteBody());
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(posted.body.status, "accepted");
  const [row] = await sql<{ managed_at: Date | null }[]>`
    SELECT managed_at
    FROM swarm.agent_principals
    WHERE principal_id = ${agent.principalId}::uuid
  `;
  assert.equal(row?.managed_at ?? null, null);
});

test("duplicate name: default refused, allow_duplicate_name true creates a second principal, two concurrent defaults produce exactly one", async () => {
  const name = `synth-dup-${randomUUID().slice(0, 8)}`;
  const first = await runCmd(shared.ownerJwt, {
    kind: "create_agent_principal",
    name,
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, "accepted");
  const refused = await runCmd(shared.ownerJwt, {
    kind: "create_agent_principal",
    name,
  });
  assert.equal(refused.status, 200, JSON.stringify(refused.body));
  assert.equal(refused.body.status, "rejected");
  assert.equal(refused.body.reason, "principal_name_taken");
  const allowed = await runCmd(shared.ownerJwt, {
    kind: "create_agent_principal",
    name,
    allow_duplicate_name: true,
  });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.status, "accepted");
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
    FROM swarm.agent_principals
    WHERE workspace_id = ${shared.workspace}::uuid
      AND name = ${name}
  `;
  assert.equal(Number(rows[0]?.n), 2);

  const concurrentName = `synth-dup-race-${randomUUID().slice(0, 8)}`;
  const [left, right] = await Promise.all([
    runCmd(shared.ownerJwt, {
      kind: "create_agent_principal",
      name: concurrentName,
    }),
    runCmd(shared.ownerJwt, {
      kind: "create_agent_principal",
      name: concurrentName,
    }),
  ]);
  const accepted = [left, right].filter((result) =>
    result.status === 200 && result.body.status === "accepted"
  );
  const rejected = [left, right].filter((result) =>
    result.body.reason === "principal_name_taken"
  );
  assert.equal(accepted.length, 1, JSON.stringify({ left, right }));
  assert.equal(rejected.length, 1, JSON.stringify({ left, right }));
  const concurrentRows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
    FROM swarm.agent_principals
    WHERE workspace_id = ${shared.workspace}::uuid
      AND name = ${concurrentName}
  `;
  assert.equal(Number(concurrentRows[0]?.n), 1);
});
