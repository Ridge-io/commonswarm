/**
 * L3: rotate_wake_id at revocation-by-intent; not on stranded-successor discard.
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
  WAKE_TOPIC_PREFIX,
  isWakeId,
} from "../../supabase/functions/_shared/wake.js";

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

interface Seeded {
  workspace: string;
  ownerId: string;
  ownerJwt: string;
  principal: string;
  run: string;
  tokenId: string;
  agentToken: string;
}

async function seedPrincipal(label: string): Promise<Seeded> {
  const owner = await createUser(label);
  const workspace = randomUUID();
  const device = randomUUID();
  const principal = randomUUID();
  const run = randomUUID();
  const tokenId = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, ${label})
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, ${label})
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, ${label}, ${owner.id}::uuid)
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
      ) VALUES (
        ${principal}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${label}
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
    workspace,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    principal,
    run,
    tokenId,
    agentToken,
  };
}

async function addLiveToken(
  seeded: Seeded,
): Promise<{ tokenId: string; token: string }> {
  const tokenId = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql`
    INSERT INTO swarm.agent_tokens (
      token_id, principal_id, run_id, scopes, token_hash,
      expires_at, lineage_id
    ) VALUES (
      ${tokenId}::uuid, ${seeded.principal}::uuid, ${seeded.run}::uuid,
      ${sql.json(["create", "acquire", "submit", "post_signal"])}::jsonb,
      ${createHash("sha256").update(token).digest()},
      statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
    )
  `;
  return { tokenId, token };
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

async function topicAuthorized(wakeId: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT swarm.wake_topic_authorized(${WAKE_TOPIC_PREFIX + wakeId}) AS ok
  `;
  return row?.ok === true;
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

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-wake-rot-env-"));
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
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `command function logs:\n${functionLogs.slice(-4000)}`,
  });
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

test("revoke_agent_token rotates wake_id; old topic refused, new admitted", async () => {
  const seeded = await seedPrincipal("tok-revoke");
  await addLiveToken(seeded);
  const oldId = await wakeIdOf(seeded.principal);
  assert.equal(await topicAuthorized(oldId), true);

  const revoked = await postCommand(seeded.ownerJwt, seeded.workspace, {
    kind: "revoke_agent_token",
    token_id: seeded.tokenId,
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.status, "accepted", JSON.stringify(revoked.body));

  const newId = await wakeIdOf(seeded.principal);
  assert.notEqual(newId, oldId);
  assert.equal(isWakeId(newId), true);
  assert.equal(await topicAuthorized(oldId), false);
  assert.equal(await topicAuthorized(newId), true);
});

test("revoke_agent_principal rotates wake_id", async () => {
  const seeded = await seedPrincipal("prin-revoke");
  const oldId = await wakeIdOf(seeded.principal);
  assert.equal(await topicAuthorized(oldId), true);

  const revoked = await postCommand(seeded.ownerJwt, seeded.workspace, {
    kind: "revoke_agent_principal",
    principal_id: seeded.principal,
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.status, "accepted", JSON.stringify(revoked.body));

  const newId = await wakeIdOf(seeded.principal);
  assert.notEqual(newId, oldId);
  assert.equal(await topicAuthorized(oldId), false);
});

test("a renewal that discards a stranded successor does not rotate", async () => {
  const seeded = await seedPrincipal("strand");
  const grantId = randomUUID();
  await sql`
    INSERT INTO swarm.renewal_grants (
      renewal_grant_id, workspace_id, principal_id, run_id,
      max_successors, successors_used, horizon_expires_at, created_by
    ) VALUES (
      ${grantId}::uuid,
      ${seeded.workspace}::uuid,
      ${seeded.principal}::uuid,
      ${seeded.run}::uuid,
      1,
      0,
      statement_timestamp() + interval '30 days',
      ${seeded.ownerId}::uuid
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
      ${seeded.principal}::uuid,
      ${seeded.run}::uuid,
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

  const before = await wakeIdOf(seeded.principal);
  const lostId = randomUUID();
  const lost = await postCommand(
    predToken,
    seeded.workspace,
    { kind: "renew_agent_token" },
    lostId,
  );
  assert.equal(lost.status, 200, JSON.stringify(lost.body));
  assert.equal(lost.body.status, "accepted", JSON.stringify(lost.body));
  const strandedId = String(lost.body.token_id);
  assert.equal(await wakeIdOf(seeded.principal), before, "ordinary renewal must not rotate");

  const recovery = await postCommand(
    predToken,
    seeded.workspace,
    { kind: "renew_agent_token" },
    lostId,
  );
  assert.equal(recovery.status, 200, JSON.stringify(recovery.body));
  assert.equal(recovery.body.status, "accepted", JSON.stringify(recovery.body));
  assert.notEqual(String(recovery.body.token_id), strandedId);
  assert.equal(typeof recovery.body.agent_token, "string");
  assert.equal(
    await wakeIdOf(seeded.principal),
    before,
    "discarding a stranded successor must not rotate",
  );
});
