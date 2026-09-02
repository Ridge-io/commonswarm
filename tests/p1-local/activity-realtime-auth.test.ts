/**
 * Private Realtime authorization control for listener activity.
 *
 * This file is named by `npm run test:p1-local`. It needs the local Supabase
 * stack and an announced exclusive database slot because it creates auth users
 * and committed workspace memberships.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from "@supabase/supabase-js";
import postgres from "postgres";
import { activityTopic } from "../../supabase/functions/activity/core.js";
import { awaitFunctionRunning } from "../support/edge-readiness.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

function environment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(
    parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY,
  );
  return parsed as LocalEnvironment;
}

let local: LocalEnvironment;
let admin: SupabaseClient;
let sql: ReturnType<typeof postgres>;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDirectory: string | undefined;
const realtimeClients: SupabaseClient[] = [];

before(async () => {
  local = environment();
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  sql = postgres(local.DB_URL, { max: 1 });
  envDirectory = mkdtempSync(join(tmpdir(), "cswarm-l35-env-"));
  const envFile = join(envDirectory, "test.env");
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
    url: `${local.API_URL}/functions/v1/activity`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (milliseconds) => delay(milliseconds),
    now: Date.now,
    diagnostics: () => `activity function logs:\n${functionLogs.slice(-4_000)}`,
  });
});

after(async () => {
  for (const client of realtimeClients) client.realtime.disconnect();
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      functionProcess.once("close", () => resolve(true));
    });
    functionProcess.kill();
    const stopped = await Promise.race([exited, delay(2_000).then(() => false)]);
    if (!stopped && functionProcess.exitCode === null) functionProcess.kill("SIGKILL");
  }
  await sql.end({ timeout: 2 });
  if (envDirectory) rmSync(envDirectory, { recursive: true, force: true });
});

async function newMember(label: string): Promise<{
  client: SupabaseClient;
  userId: string;
  workspaceId: string;
}> {
  const email = `l35-${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const userId = created.data.user.id;
  const workspaceId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${userId}::uuid, ${`L35 ${label}`})
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspaceId}::uuid, ${`L35 ${label}`}, ${userId}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}::uuid, ${userId}::uuid, 'owner')
    `;
  });
  const client = createClient(local.API_URL, local.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  realtimeClients.push(client);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  assert.ok(signedIn.data.session);
  await client.realtime.setAuth(signedIn.data.session.access_token);
  return { client, userId, workspaceId };
}

async function newAgent(
  userId: string,
  workspaceId: string,
): Promise<{ principalId: string; token: string }> {
  const deviceId = randomUUID();
  const principalId = randomUUID();
  const runId = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${deviceId}::uuid, ${userId}::uuid, 'l35-activity')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${principalId}::uuid, ${workspaceId}::uuid, ${userId}::uuid, 'l35-listener'
      )
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${runId}::uuid, ${principalId}::uuid, ${deviceId}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id
      ) VALUES (
        ${randomUUID()}::uuid, ${principalId}::uuid, ${runId}::uuid,
        ${tx.json(["post_signal"])}::jsonb, ${tokenHash},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  });
  return { principalId, token };
}

async function subscribe(
  client: SupabaseClient,
  topic: string,
  onFrame: (frame: unknown) => void,
): Promise<{ channel: RealtimeChannel; status: string }> {
  const channel = client.channel(topic, {
    config: { private: true, broadcast: { ack: false, self: false } },
  });
  channel.on("broadcast", { event: "activity" }, onFrame);
  const status = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime subscribe timed out")), 10_000);
    channel.subscribe((next) => {
      if (next !== "SUBSCRIBED" && next !== "CHANNEL_ERROR" && next !== "TIMED_OUT") {
        return;
      }
      clearTimeout(timer);
      resolve(next);
    });
  });
  return { channel, status };
}

test("another workspace member cannot join or receive the private activity channel", async () => {
  const owner = await newMember("owner");
  const outsider = await newMember("outsider");
  const topic = activityTopic(owner.workspaceId);
  let ownerReceipts = 0;
  let outsiderReceipts = 0;
  const ownerFrames: unknown[] = [];

  const allowed = await subscribe(owner.client, topic, (frame) => {
    ownerReceipts += 1;
    ownerFrames.push(frame);
  });
  assert.equal(allowed.status, "SUBSCRIBED", "member join is the positive control");

  const refused = await subscribe(outsider.client, topic, () => {
    outsiderReceipts += 1;
  });
  assert.equal(refused.status, "CHANNEL_ERROR");

  await sql`
    SELECT realtime.send(
      ${sql.json({ probe: randomUUID() })}::jsonb,
      'activity',
      ${topic},
      true
    )
  `;
  for (let attempt = 0; attempt < 20 && ownerReceipts === 0; attempt += 1) {
    await delay(50);
  }
  assert.equal(ownerReceipts, 1, "authorized member must receive the control frame");
  assert.equal(outsiderReceipts, 0);

  const agent = await newAgent(owner.userId, owner.workspaceId);
  const requestBody = {
    version: 1,
    workspace_id: owner.workspaceId,
    stream_id: randomUUID(),
    sequence: 1,
    phase: "tool-running",
    signal_id: randomUUID(),
    tool_title: `Read swm_\u200bagt_${"z".repeat(43)} record`,
    elapsed_ms: 12,
  };
  const published = await fetch(`${local.API_URL}/functions/v1/activity`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${agent.token}`,
      apikey: local.ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  assert.equal(
    published.status,
    202,
    `${await published.text()}\n${functionLogs.slice(-4_000)}`,
  );
  for (let attempt = 0; attempt < 20 && ownerReceipts < 2; attempt += 1) {
    await delay(50);
  }
  assert.equal(ownerReceipts, 2, "the authenticated agent publish must reach its member");
  assert.equal(outsiderReceipts, 0);
  assert.equal(
    (ownerFrames[1] as { payload?: { principalId?: unknown } } | undefined)
      ?.payload?.principalId,
    agent.principalId,
    "the edge must derive the publishing principal from the agent token",
  );
  assert.equal(
    (ownerFrames[1] as { payload?: { toolTitle?: unknown } } | undefined)
      ?.payload?.toolTitle,
    "Read [redacted-credential] record",
    "the edge must redact a direct caller even if the listener sanitizer is bypassed",
  );

  const crossWorkspace = await fetch(`${local.API_URL}/functions/v1/activity`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${agent.token}`,
      apikey: local.ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...requestBody, workspace_id: outsider.workspaceId }),
  });
  assert.equal(crossWorkspace.status, 403);
  await delay(100);
  assert.equal(outsiderReceipts, 0);

  await owner.client.removeChannel(allowed.channel);
  await outsider.client.removeChannel(refused.channel);
});
