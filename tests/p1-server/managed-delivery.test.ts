/**
 * Managed delivery pending-surface against the served command function.
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
  DELIVERY_NOT_SURFACED_CODE,
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

async function postAsk(principalId: string): Promise<string> {
  const posted = await runCmd(shared.ownerJwt, {
    kind: "post_signal",
    signal_kind: "ask",
    body: `synth-ask-${randomUUID()}`,
    to_user_id: null,
    about: null,
    to_agent_principal_id: principalId,
    in_reply_to: null,
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signalId = (posted.body.signal as { id?: string } | undefined)?.id;
  assert.equal(typeof signalId, "string");
  return signalId as string;
}

async function holdSession(agent: SeededAgent) {
  await enable(agent.principalId);
  const sessionId = randomUUID();
  const key = synthKey();
  const held = await acquire(agent.token, sessionId, key);
  assert.equal(held.status, 200, JSON.stringify(held.body));
  return { sessionId, key, generation: Number(held.body.generation) };
}

async function deliveryRow(signalId: string, principalId: string) {
  const [row] = await sql<{
    session_id: string | null;
    session_generation: number | null;
    attempt_count: number;
    ack_outcome: string | null;
    acked_at: Date | null;
    surfaced_at: Date | null;
    lease_id: string | null;
  }[]>`
    SELECT
      session_id::text,
      session_generation,
      attempt_count,
      ack_outcome,
      acked_at,
      surfaced_at,
      lease_id::text
    FROM swarm.signal_deliveries
    WHERE signal_id = ${signalId}::uuid
      AND recipient_agent_principal_id = ${principalId}::uuid
  `;
  assert.ok(row, "delivery row");
  return row;
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-managed-delivery-env-"));
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

  const owner = await createUser("managed-delivery-owner");
  const workspace = randomUUID();
  const device = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, 'SynthManagedDeliveryOwner')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'synth-managed-delivery-device')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'SynthManagedDeliveryWS', ${owner.id}::uuid)
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

test("claim binds session_id and session_generation from the verified proof", async () => {
  const agent = await seedAgent("claim-bind");
  const held = await holdSession(agent);
  const signalId = await postAsk(agent.principalId);
  const listener = randomUUID();
  const claim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: listener },
    { headers: proofHeaders(held.sessionId, held.generation, held.key) },
  );
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const row = await deliveryRow(signalId, agent.principalId);
  assert.equal(row.session_id, held.sessionId);
  assert.equal(Number(row.session_generation), held.generation);
  assert.ok(row.lease_id);
});

test("stale-generation claim is refused with session_conflict", async () => {
  const agent = await seedAgent("stale-gen");
  const held = await holdSession(agent);
  await postAsk(agent.principalId);
  const claim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: randomUUID() },
    { headers: proofHeaders(held.sessionId, held.generation + 1, held.key) },
  );
  assert.equal(claim.status, 409, JSON.stringify(claim.body));
  assert.equal(claim.body.error, "session_conflict");
});

test("bare queued-to-observed is delivery_not_surfaced when managed", async () => {
  const agent = await seedAgent("bare-promote");
  const held = await holdSession(agent);
  const signalId = await postAsk(agent.principalId);
  const listener = randomUUID();
  const headers = proofHeaders(held.sessionId, held.generation, held.key);
  const claim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: listener },
    { headers },
  );
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const deliveries = claim.body.deliveries as Array<Record<string, unknown>>;
  const leaseId = String(deliveries[0]?.lease_id);
  const queued = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: leaseId,
      listener_instance_id: listener,
      outcome: "queued",
      last_error_code: null,
      surfaced: false,
    },
    { headers },
  );
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const bare = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: null,
      listener_instance_id: null,
      outcome: "observed",
      last_error_code: null,
    },
    { headers },
  );
  assert.equal(bare.status, 409, JSON.stringify(bare.body));
  assert.equal(bare.body.error, DELIVERY_NOT_SURFACED_CODE);
  const flagged = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: null,
      listener_instance_id: null,
      outcome: "observed",
      last_error_code: null,
      surfaced: false,
    },
    { headers },
  );
  assert.equal(flagged.status, 409, JSON.stringify(flagged.body));
  assert.equal(flagged.body.error, "delivery_not_surfaced");
});

test("surfaced ACK with current proof succeeds and sets surfaced_at", async () => {
  const agent = await seedAgent("surface-ack");
  const held = await holdSession(agent);
  const signalId = await postAsk(agent.principalId);
  const listener = randomUUID();
  const headers = proofHeaders(held.sessionId, held.generation, held.key);
  const claim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: listener },
    { headers },
  );
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const deliveries = claim.body.deliveries as Array<Record<string, unknown>>;
  const leaseId = String(deliveries[0]?.lease_id);
  const queued = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: leaseId,
      listener_instance_id: listener,
      outcome: "queued",
      last_error_code: null,
      surfaced: false,
    },
    { headers },
  );
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const observed = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: null,
      listener_instance_id: null,
      outcome: "observed",
      last_error_code: null,
      surfaced: true,
    },
    { headers },
  );
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  const row = await deliveryRow(signalId, agent.principalId);
  assert.equal(row.ack_outcome, "observed");
  assert.ok(row.surfaced_at);
});

test("unmanaged ACK keeps today's queued-to-observed promotion", async () => {
  const agent = await seedAgent("unmanaged-ack");
  const signalId = await postAsk(agent.principalId);
  const listener = randomUUID();
  const claim = await runCmd(agent.token, {
    kind: "claim_agent_inbox",
    listener_instance_id: listener,
  });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const deliveries = claim.body.deliveries as Array<Record<string, unknown>>;
  const leaseId = String(deliveries[0]?.lease_id);
  const queued = await runCmd(agent.token, {
    kind: "ack_agent_delivery",
    signal_id: signalId,
    lease_id: leaseId,
    listener_instance_id: listener,
    outcome: "queued",
    last_error_code: null,
  });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const observed = await runCmd(agent.token, {
    kind: "ack_agent_delivery",
    signal_id: signalId,
    lease_id: null,
    listener_instance_id: null,
    outcome: "observed",
    last_error_code: null,
  });
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  const row = await deliveryRow(signalId, agent.principalId);
  assert.equal(row.ack_outcome, "observed");
  assert.equal(row.surfaced_at, null);
  assert.equal(row.session_id, null);
});

test("recovery reclaims a queued unsurfaced row; new holder claims it; attempt unchanged", async () => {
  const agent = await seedAgent("reclaim-queued");
  const held = await holdSession(agent);
  const signalId = await postAsk(agent.principalId);
  const listener = randomUUID();
  const headers = proofHeaders(held.sessionId, held.generation, held.key);
  const claim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: listener },
    { headers },
  );
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const deliveries = claim.body.deliveries as Array<Record<string, unknown>>;
  const leaseId = String(deliveries[0]?.lease_id);
  const queued = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: leaseId,
      listener_instance_id: listener,
      outcome: "queued",
      last_error_code: null,
      surfaced: false,
    },
    { headers },
  );
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const before = await deliveryRow(signalId, agent.principalId);
  assert.equal(before.ack_outcome, "queued");
  assert.equal(before.surfaced_at, null);
  const attempts = before.attempt_count;
  const recovered = await runCmd(shared.ownerJwt, {
    kind: "recover_agent_session",
    principal_id: agent.principalId,
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  const mid = await deliveryRow(signalId, agent.principalId);
  assert.equal(mid.session_id, null);
  assert.equal(mid.session_generation, null);
  assert.equal(mid.lease_id, null);
  assert.equal(mid.acked_at, null);
  assert.equal(mid.attempt_count, attempts);
  const nextSession = randomUUID();
  const nextKey = synthKey();
  const nextHold = await acquire(agent.token, nextSession, nextKey);
  assert.equal(nextHold.status, 200, JSON.stringify(nextHold.body));
  const nextGeneration = Number(nextHold.body.generation);
  const reclaim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: randomUUID() },
    { headers: proofHeaders(nextSession, nextGeneration, nextKey) },
  );
  assert.equal(reclaim.status, 200, JSON.stringify(reclaim.body));
  const reclaimed = reclaim.body.deliveries as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(reclaimed) && reclaimed.length >= 1);
  const reclaimedId = String(
    (reclaimed[0]?.signal as { id?: string } | undefined)?.id,
  );
  assert.equal(reclaimedId, signalId);
  const after = await deliveryRow(signalId, agent.principalId);
  assert.equal(after.attempt_count, attempts);
  assert.equal(after.session_id, nextSession);
  assert.equal(Number(after.session_generation), nextGeneration);
});
