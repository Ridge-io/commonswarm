/**
 * L3: wake topic travels in the responses a client already reads (W3).
 *
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**). Needs the
 * local stack and an exclusive database slot.
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
import { awaitFunctionRunning } from "../support/edge-readiness.js";
import {
  WAKE_EVENT,
  WAKE_ID_LENGTH,
  WAKE_TOPIC_PREFIX,
  isWakeId,
} from "../../supabase/functions/_shared/wake.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface Fixture {
  workspaceA: string;
  workspaceB: string;
  ownerId: string;
  ownerJwt: string;
  otherJwt: string;
  principal: string;
  run: string;
  device: string;
  tokenId: string;
  agentToken: string;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDir: string | undefined;
let f: Fixture;

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
  const email = `${label}-${randomUUID()}@example.test`;
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

async function fixture(): Promise<Fixture> {
  const owner = await createUser("wake-owner");
  const other = await createUser("wake-other");
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const device = randomUUID();
  const principal = randomUUID();
  const run = randomUUID();
  const tokenId = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${owner.id}::uuid, 'WakeOwner'),
        (${other.id}::uuid, 'WakeOther')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'wake-tests')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES
        (${workspaceA}::uuid, 'WakeA', ${owner.id}::uuid),
        (${workspaceB}::uuid, 'WakeB', ${other.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${workspaceA}::uuid, ${owner.id}::uuid, 'owner'),
        (${workspaceB}::uuid, ${other.id}::uuid, 'owner')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES
        (${randomUUID()}::uuid, ${workspaceA}::uuid, 'workspace'),
        (${randomUUID()}::uuid, ${workspaceB}::uuid, 'workspace')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${principal}::uuid, ${workspaceA}::uuid, ${owner.id}::uuid, 'wake-agent'
      )
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id
      ) VALUES (
        ${tokenId}::uuid, ${principal}::uuid, ${run}::uuid,
        ${tx.json(["create", "acquire", "submit", "post_signal"])}::jsonb,
        ${createHash("sha256").update(agentToken).digest()},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  });
  return {
    workspaceA,
    workspaceB,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    otherJwt: other.jwt,
    principal,
    run,
    device,
    tokenId,
    agentToken,
  };
}

async function wakeIdOf(principalId: string): Promise<string> {
  const [row] = await sql<{ wake_id: string }[]>`
    SELECT wake_id FROM swarm.agent_principals
    WHERE principal_id = ${principalId}::uuid
  `;
  assert.ok(row?.wake_id);
  assert.equal(isWakeId(row.wake_id), true);
  return row.wake_id;
}

function assertWakeMatches(
  body: Record<string, unknown>,
  wakeId: string,
): void {
  assert.equal(Object.hasOwn(body, "wake"), true, JSON.stringify(body));
  const wake = body.wake as Record<string, unknown>;
  assert.equal(wake.event, WAKE_EVENT);
  assert.equal(typeof wake.topic, "string");
  const topic = String(wake.topic);
  assert.equal(topic.startsWith(WAKE_TOPIC_PREFIX), true);
  const id = topic.slice(WAKE_TOPIC_PREFIX.length);
  assert.equal(id.length, WAKE_ID_LENGTH);
  assert.equal(isWakeId(id), true);
  assert.equal(id, wakeId);
}

function assertNoWake(body: Record<string, unknown>): void {
  assert.equal(Object.hasOwn(body, "wake"), false, JSON.stringify(body));
}

async function postRead(
  bearer: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      apikey: local.ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function postCommand(
  bearer: string,
  workspaceId: string,
  command: Record<string, unknown>,
  commandId = randomUUID(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: commandId,
      client_version: "0.1.0",
      workspace_id: workspaceId,
      stream: { kind: "workspace" },
      command,
    }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

function signalReadBody(
  workspaceId: string,
  inbox: boolean,
): Record<string, unknown> {
  return {
    resource: "signals",
    workspace_id: workspaceId,
    inbox,
    about: null,
    kind: null,
    since: null,
    in_reply_to: null,
    limit: 50,
    include_stale: true,
  };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-wake-resp-env-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_SELF_SERVE=1\n");
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
  for (const fn of ["command", "read"]) {
    await awaitFunctionRunning({
      url: `${local.API_URL}/functions/v1/${fn}`,
      fetcher: fetch,
      timeoutMs: 30_000,
      sleep: (ms) => delay(ms),
      now: () => Date.now(),
      diagnostics: () => `${fn} function logs:\n${functionLogs.slice(-4000)}`,
    });
  }
  f = await fixture();
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      functionProcess.once("close", () => resolve(true));
    });
    functionProcess.kill("SIGTERM");
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

test("inbox read as an agent carries wake whose 43-char id equals the row", async () => {
  const wakeId = await wakeIdOf(f.principal);
  const result = await postRead(f.agentToken, signalReadBody(f.workspaceA, true));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertWakeMatches(result.body, wakeId);
});

test("a human read and a foreign-workspace agent inbox do not carry wake", async () => {
  const human = await postRead(f.ownerJwt, {
    resource: "renewal_grants",
    workspace_id: f.workspaceA,
  });
  assert.equal(human.status, 200, JSON.stringify(human.body));
  assertNoWake(human.body);

  const foreign = await postRead(
    f.agentToken,
    signalReadBody(f.workspaceB, true),
  );
  assert.equal(foreign.status, 200, JSON.stringify(foreign.body));
  assert.deepEqual(foreign.body.signals, []);
  assertNoWake(foreign.body);

  const ownFeed = await postRead(
    f.agentToken,
    signalReadBody(f.workspaceA, false),
  );
  assert.equal(ownFeed.status, 200, JSON.stringify(ownFeed.body));
  assertNoWake(ownFeed.body);
});

test("mint_agent_token carries wake matching the principal row", async () => {
  const wakeId = await wakeIdOf(f.principal);
  const minted = await postCommand(f.ownerJwt, f.workspaceA, {
    kind: "mint_agent_token",
    principal_id: f.principal,
    run_id: randomUUID(),
    task_id: randomUUID(),
    epoch: 1,
    device_id: f.device,
  });
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  assert.equal(minted.body.status, "accepted", JSON.stringify(minted.body));
  assert.equal(typeof minted.body.agent_token, "string");
  assertWakeMatches(minted.body, wakeId);
});

test("renew_agent_token carries wake matching the principal row", async () => {
  const grantId = randomUUID();
  await sql`
    INSERT INTO swarm.renewal_grants (
      renewal_grant_id, workspace_id, principal_id, run_id,
      max_successors, successors_used, horizon_expires_at, created_by
    ) VALUES (
      ${grantId}::uuid,
      ${f.workspaceA}::uuid,
      ${f.principal}::uuid,
      ${f.run}::uuid,
      8,
      0,
      statement_timestamp() + interval '30 days',
      ${f.ownerId}::uuid
    )
  `;
  const predId = randomUUID();
  const predToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql`
    INSERT INTO swarm.agent_tokens (
      token_id, principal_id, run_id, task_id, epoch,
      scopes, token_hash, expires_at, lineage_id, renewal_grant_id
    ) VALUES (
      ${predId}::uuid,
      ${f.principal}::uuid,
      ${f.run}::uuid,
      ${randomUUID()}::uuid,
      1,
      ${sql.json(["create", "acquire", "submit", "post_signal"])}::jsonb,
      ${createHash("sha256").update(predToken).digest()},
      statement_timestamp() + interval '1 hour',
      ${randomUUID()}::uuid,
      ${grantId}::uuid
    )
  `;
  await sql`
    UPDATE swarm.agent_tokens
    SET first_used_at = statement_timestamp()
    WHERE token_id = ${predId}::uuid AND first_used_at IS NULL
  `;
  const before = await wakeIdOf(f.principal);
  const renewed = await postCommand(predToken, f.workspaceA, {
    kind: "renew_agent_token",
  });
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.equal(renewed.body.status, "accepted", JSON.stringify(renewed.body));
  assert.equal(typeof renewed.body.agent_token, "string");
  assertWakeMatches(renewed.body, before);
  assert.equal(await wakeIdOf(f.principal), before);
});

test("claim_agent_inbox carries wake matching the principal row", async () => {
  const wakeId = await wakeIdOf(f.principal);
  const claimed = await postCommand(f.agentToken, f.workspaceA, {
    kind: "claim_agent_inbox",
    listener_instance_id: randomUUID(),
    limit: 10,
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.status, "accepted", JSON.stringify(claimed.body));
  assertWakeMatches(claimed.body, wakeId);
});
