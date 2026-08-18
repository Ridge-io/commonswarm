/**
 * declare_agent_model against the served command function and real Postgres.
 *
 * The self-only property is structural — the command has no target field — so
 * the control here is behavioural: two principals declare, and each write
 * lands on the declarer's own row while the sibling's row is untouched.
 *
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**; serial via
 * --test-concurrency=1 because each file owns the one local runtime).
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

interface DeclareFixture {
  workspace: string;
  ownerJwt: string;
  principalA: string;
  principalB: string;
  tokenA: string;
  tokenB: string;
}

let f: DeclareFixture;

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

async function declareFixture(): Promise<DeclareFixture> {
  const owner = await createUser("declare-owner");
  const workspace = randomUUID();
  const device = randomUUID();
  const principalA = randomUUID();
  const principalB = randomUUID();
  const tokenA = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const tokenB = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, 'DeclareOwner')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'declare-tests')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'DeclareWS', ${owner.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES
        (${principalA}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'declare-a'),
        (${principalB}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'declare-b')
    `;
    for (const [principal, token] of [
      [principalA, tokenA] as const,
      [principalB, tokenB] as const,
    ]) {
      const run = randomUUID();
      await tx`
        INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
        VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)
      `;
      await tx`
        INSERT INTO swarm.agent_tokens (
          token_id, principal_id, run_id, scopes, token_hash,
          expires_at, lineage_id
        ) VALUES (
          ${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid,
          ${tx.json(["post_signal"])}::jsonb,
          ${createHash("sha256").update(token).digest()},
          statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
        )
      `;
    }
  });
  return {
    workspace,
    ownerJwt: owner.jwt,
    principalA,
    principalB,
    tokenA,
    tokenB,
  };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-declare-env-"));
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
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `command function logs:\n${functionLogs.slice(-4000)}`,
  });
  f = await declareFixture();
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

async function declare(
  token: string,
  model: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: randomUUID(),
      client_version: "0.1.0",
      workspace_id: f.workspace,
      stream: { kind: "workspace" },
      command: { kind: "declare_agent_model", model },
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body };
}

async function models(): Promise<Record<string, string | null>> {
  const rows = await sql<{ principal_id: string; model: string | null }[]>`
    SELECT principal_id, model
    FROM swarm.agent_principals
    WHERE workspace_id = ${f.workspace}::uuid
  `;
  return Object.fromEntries(rows.map((row) => [row.principal_id, row.model]));
}

test("M1 an agent's declaration lands on its OWN row and only there", async () => {
  const result = await declare(f.tokenA, "claude (claude-agent-acp 0.64.2)");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const byId = await models();
  assert.equal(byId[f.principalA], "claude (claude-agent-acp 0.64.2)");
  // The sibling is the control: same workspace, untouched.
  assert.equal(byId[f.principalB], null);
});

test("M2 the second principal's declaration cannot reach the first's row", async () => {
  const result = await declare(f.tokenB, "codex (codex-acp 1.1.9)");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const byId = await models();
  assert.equal(byId[f.principalA], "claude (claude-agent-acp 0.64.2)");
  assert.equal(byId[f.principalB], "codex (codex-acp 1.1.9)");
});

test("M3 a human credential is refused before the reducer", async () => {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.ownerJwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: randomUUID(),
      client_version: "0.1.0",
      workspace_id: f.workspace,
      stream: { kind: "workspace" },
      command: { kind: "declare_agent_model", model: "claude" },
    }),
  });
  assert.equal(response.status, 403);
  await response.json();
  const byId = await models();
  assert.equal(byId[f.principalA], "claude (claude-agent-acp 0.64.2)");
});

test("M4 the wire refuses an over-bound model before authorization", async () => {
  const result = await declare(f.tokenA, "x".repeat(121));
  assert.equal(result.status, 400, JSON.stringify(result.body));
  const byId = await models();
  assert.equal(byId[f.principalA], "claude (claude-agent-acp 0.64.2)");
});

test("M5 null clears the declaration", async () => {
  const result = await declare(f.tokenA, null);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const byId = await models();
  assert.equal(byId[f.principalA], null);
  assert.equal(byId[f.principalB], "codex (codex-acp 1.1.9)");
});
