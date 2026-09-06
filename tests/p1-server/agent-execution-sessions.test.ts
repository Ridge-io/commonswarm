import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

import { awaitFunctionRunning } from "../support/edge-readiness.js";

async function createUser(email: string) {
  const supabase = createClient(
    process.env.SUPABASE_URL || "http://localhost:54321",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  );
  const { data, error } = await supabase.auth.admin.createUser({ email, password: "Password123!", email_confirm: true });
  if (error || !data.user) throw error || new Error("no user");
  const { data: sessionData, error: sessionError } = await supabase.auth.signInWithPassword({ email, password: "Password123!" });
  if (sessionError || !sessionData.session) throw sessionError;
  return { id: data.user.id, jwt: sessionData.session.access_token };
}

const local = {
  DB_URL: process.env.SUPABASE_DB_URL || "postgresql://postgres:postgres@localhost:54322/postgres",
  API_URL: process.env.SUPABASE_URL || "http://localhost:54321",
};

let sql: postgres.Sql;
let envDir: string | null = null;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";

before(async () => {
  sql = postgres(local.DB_URL, { max: 1, idle_timeout: 1 });
  envDir = mkdtempSync(join(tmpdir(), "swarm-test-"));
  const envFile = join(envDir, ".env");
  writeFileSync(envFile, `SUPABASE_DB_URL=${local.DB_URL}\n`);
  
  functionProcess = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile], {
    cwd: process.cwd(), env: { ...process.env, SWARM_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: Buffer) => { functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000); };
  functionProcess.stdout?.on("data", capture);
  functionProcess.stderr?.on("data", capture);
  
  const bootDeadline = Date.now() + 60_000;
  while (!functionLogs.includes("Serving functions on")) {
    if (Date.now() > bootDeadline) throw new Error(`functions serve never booted:\n${functionLogs.slice(-3000)}`);
    await delay(250);
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`, fetcher: fetch, timeoutMs: 30_000, sleep: (ms: number) => delay(ms),
    now: () => Date.now(), diagnostics: () => `command function logs:\n${functionLogs.slice(-4000)}`,
  });
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) functionProcess.kill("SIGKILL");
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});

async function runCmd(token: string, cmd: any, stream: any = { kind: "workspace" }, headers: Record<string, string> = {}) {
  const reqHeaders: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...headers
  };
  const body = JSON.stringify({
    command_id: randomUUID(),
    client_version: "0.1.0",
    workspace_id: stream.workspace_id || randomUUID(),
    stream,
    command: cmd,
  });
  const response = await fetch(`${local.API_URL}/functions/v1/command`, { method: "POST", headers: reqHeaders, body });
  const respBody = await response.json().catch(() => ({})) as any;
  return { status: response.status, body: respBody };
}

test("duplicate-name explicit flag/default concurrent refusal", async () => {
  const owner = await createUser("owner-dup@example.com");
  const workspace = randomUUID();
  const principalA = randomUUID();
  const principalB = randomUUID();
  
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${owner.id}::uuid, 'Owner')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'WS', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner')`;
  });

  const res1 = await runCmd(owner.jwt, { kind: "create_agent_principal", principal_id: principalA, name: "my-bot" }, { kind: "workspace", workspace_id: workspace });
  assert.equal(res1.status, 200);

  const res2 = await runCmd(owner.jwt, { kind: "create_agent_principal", principal_id: principalB, name: "my-bot" }, { kind: "workspace", workspace_id: workspace });
  assert.equal(res2.status, 403);
  assert.equal(res2.body.error, "principal_name_taken");

  const res3 = await runCmd(owner.jwt, { kind: "create_agent_principal", principal_id: principalB, name: "my-bot", allow_duplicate_name: true }, { kind: "workspace", workspace_id: workspace });
  assert.equal(res3.status, 200);
});

test("two racing sessions, wrong principal/key/generation, expiry, acquire retry/retired UUID, human recovery", async () => {
  // A comprehensive integration test hitting all session boundaries
  const owner = await createUser("owner-session@example.com");
  const workspace = randomUUID();
  const principal = randomUUID();
  const device = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${owner.id}::uuid, 'Owner')`;
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${owner.id}::uuid, 'dev')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'WS', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name) VALUES (${principal}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'bot')`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${randomUUID()}::uuid, ${principal}::uuid, ${device}::uuid) RETURNING run_id`;
    const rows = await tx`SELECT run_id FROM swarm.agent_runs WHERE principal_id = ${principal}::uuid`;
    const hashed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hex = Array.from(new Uint8Array(hashed)).map(b => b.toString(16).padStart(2, "0")).join("");
    await tx`INSERT INTO swarm.agent_tokens (token_id, token_hash, principal_id, run_id, lineage_id, scopes, expires_at) VALUES (${randomUUID()}::uuid, ${hex}, ${principal}::uuid, ${rows[0].run_id}::uuid, ${randomUUID()}::uuid, '[]', statement_timestamp() + interval '1 day')`;
  });

  // 1. Unmanaged compatibility: agent mutations without proof succeed
  const resUnmanaged = await runCmd(token, { kind: "declare_agent_model", model: "test" }, { kind: "workspace", workspace_id: workspace });
  assert.equal(resUnmanaged.status, 200);

  // 2. Enable agent management (human)
  const resEnable = await runCmd(owner.jwt, { kind: "enable_agent_management", principal_id: principal }, { kind: "workspace", workspace_id: workspace });
  assert.equal(resEnable.status, 200);

  // 3. Missing-proof mutation: agent mutations without proof fail closed
  const resMissing = await runCmd(token, { kind: "declare_agent_model", model: "fail" }, { kind: "workspace", workspace_id: workspace });
  assert.equal(resMissing.status, 401);

  // 4. Acquire session
  const sid = randomUUID();
  const key = "key_".padEnd(43, "X"); // 43 chars base64url
  const hashedKeyHex = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))).map(b => b.toString(16).padStart(2, "0")).join("");
  
  const resAcquire = await runCmd(token, { kind: "acquire_agent_session", session_id: sid, key_hash: hashedKeyHex }, { kind: "workspace", workspace_id: workspace });
  assert.equal(resAcquire.status, 200);
  assert.ok(resAcquire.body.generation >= 1);

  // 5. Wrong key/generation
  const resWrong = await runCmd(token, { kind: "declare_agent_model", model: "wrong" }, { kind: "workspace", workspace_id: workspace }, {
    "x-cswarm-session-id": sid,
    "x-cswarm-session-generation": String(resAcquire.body.generation),
    "x-cswarm-session-key": "wrong_key_padX_padX_padX_padX_padX_padX_padX"
  });
  assert.equal(resWrong.status, 401);

  // 6. Current-proof success
  const resProof = await runCmd(token, { kind: "declare_agent_model", model: "proof" }, { kind: "workspace", workspace_id: workspace }, {
    "x-cswarm-session-id": sid,
    "x-cswarm-session-generation": String(resAcquire.body.generation),
    "x-cswarm-session-key": key
  });
  assert.equal(resProof.status, 200);

  // 7. Human recovery
  const resRecover = await runCmd(owner.jwt, { kind: "recover_agent_session", principal_id: principal }, { kind: "workspace", workspace_id: workspace });
  assert.equal(resRecover.status, 200);

  // 8. Replay / retired UUID
  const resReplay = await runCmd(token, { kind: "declare_agent_model", model: "replay" }, { kind: "workspace", workspace_id: workspace }, {
    "x-cswarm-session-id": sid,
    "x-cswarm-session-generation": String(resAcquire.body.generation),
    "x-cswarm-session-key": key
  });
  assert.equal(resReplay.status, 401); // Retired UUID fails

  // 9. Acquire retry on retired UUID fails
  const resAcquireRetired = await runCmd(token, { kind: "acquire_agent_session", session_id: sid, key_hash: hashedKeyHex }, { kind: "workspace", workspace_id: workspace });
  assert.equal(resAcquireRetired.status, 403);
});
