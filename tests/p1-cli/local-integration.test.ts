import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { seedDogfood } from "../../src/cloud/seed.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

let local: LocalEnvironment;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";

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

async function ready(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${local.API_URL}/functions/v1/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command_id: "healthcheck" }),
      });
      if (response.status === 401) return;
    } catch {
      // Runtime is still starting.
    }
    await delay(200);
  }
  throw new Error(`command function failed to start:\n${functionLogs.slice(-4000)}`);
}

async function runDogfoodCli(
  workspaceId: string,
  agentToken: string,
): Promise<{ stdout: string; stderr: string }> {
  const taskId = randomUUID();
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "dogfood",
    "--url",
    local.API_URL,
    "--anon-key",
    local.ANON_KEY,
    "--workspace-id",
    workspaceId,
    "--task-id",
    taskId,
    "--slug",
    `slice3-cli-${taskId}`,
    "--branch",
    "slice3/cli-dogfood",
    "--head-sha",
    "d".repeat(40),
    "--evidence",
    "test:p1-cli",
    "--agent-token-stdin",
    "--force-file-store",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_ALLOW_INSECURE_STORE: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(agentToken);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  assert.equal(code, 0, stderr);
  return { stdout, stderr };
}

before(async () => {
  local = environment();
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  functionProcess = spawn(
    "supabase",
    ["functions", "serve", "command", "--no-verify-jwt", "--env-file", "/dev/null"],
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
  await ready();
});

after(() => {
  functionProcess?.kill("SIGINT");
});

test("fixture bridge is idempotent and CLI client drives cradle-to-grave", async () => {
  const nonce = randomUUID();
  const created = await admin.auth.admin.createUser({
    email: `slice3-${nonce}@example.test`,
    password: `T-${randomBytes(24).toString("base64url")}!`,
    email_confirm: true,
  });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const userId = created.data.user.id;
  const first = await seedDogfood({
    databaseUrl: local.DB_URL,
    userId,
    displayName: "Slice 3 Operator",
  });
  assert.ok(first.agentToken, "first seed displays a one-time agent token");
  const second = await seedDogfood({
    databaseUrl: local.DB_URL,
    userId,
    displayName: "Slice 3 Operator",
  });
  assert.equal(second.agentToken, null, "rerun retains the existing live token");
  assert.equal(second.workspaceId, first.workspaceId);
  assert.equal(second.streamId, first.streamId);
  assert.equal(second.principalId, first.principalId);
  assert.equal(second.runId, first.runId);
  assert.equal(second.tokenId, first.tokenId);

  const transcript = await runDogfoodCli(first.workspaceId, first.agentToken);
  assert.match(transcript.stdout, /create: \{/);
  assert.match(transcript.stdout, /acquire: \{/);
  assert.match(transcript.stdout, /submit: \{/);
  assert.match(transcript.stdout, /close: \{/);
  assert.match(transcript.stdout, /"lifecycle": "done"/);
  assert.match(transcript.stdout, new RegExp(`"owner": "${first.principalId}"`));
  assert.equal(transcript.stdout.includes(first.agentToken), false);
  assert.equal(transcript.stderr.includes(first.agentToken), false);
});
