import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertAgentToken } from "../../src/cloud/command-client.js";
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

async function runSeedCli(
  userId: string,
  tokenPath: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "seed-fixture",
    "--uid",
    userId,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: local.DB_URL,
      SEED_TOKEN_OUT: tokenPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
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
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
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
  const tokenDirectory = await mkdtemp(join(tmpdir(), "swarm-seed-token-"));
  try {
    const tokenPath = join(tokenDirectory, "first-token");
    const seeded = await runSeedCli(userId, tokenPath);
    assert.equal(seeded.code, 0, seeded.stderr);
    const publicSeed = JSON.parse(seeded.stdout) as {
      userId: string;
      membershipRole: string;
      workspaceId: string;
      streamId: string;
      principalId: string;
      tokenWritten: boolean;
    };
    assert.equal(publicSeed.userId, userId);
    assert.equal(publicSeed.membershipRole, "owner");
    assert.equal(publicSeed.tokenWritten, true);
    assert.equal(seeded.stdout.includes(tokenPath), false);
    const agentToken = await readFile(tokenPath, "utf8");
    assertAgentToken(agentToken);
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    assert.equal(seeded.stdout.includes(agentToken), false);
    assert.equal(seeded.stderr.includes(agentToken), false);
    await rm(tokenPath);

    const secondPath = join(tokenDirectory, "second-token");
    const reseeded = await runSeedCli(userId, secondPath);
    assert.equal(reseeded.code, 0, reseeded.stderr);
    const publicReseed = JSON.parse(reseeded.stdout) as typeof publicSeed;
    assert.equal(publicReseed.tokenWritten, false);
    assert.equal(publicReseed.workspaceId, publicSeed.workspaceId);
    assert.equal(publicReseed.streamId, publicSeed.streamId);
    assert.equal(publicReseed.principalId, publicSeed.principalId);
    await assert.rejects(stat(secondPath), { code: "ENOENT" });

    const directReseed = await seedDogfood({
      databaseUrl: local.DB_URL,
      userId,
      displayName: "Slice 3 Operator",
    });
    assert.equal(directReseed.agentToken, null);
    assert.equal(directReseed.membershipRole, "owner");
    assert.equal(directReseed.workspaceId, publicSeed.workspaceId);

    const existingPath = join(tokenDirectory, "must-not-overwrite");
    await writeFile(existingPath, "sentinel", { mode: 0o600 });
    const refused = await runSeedCli(userId, existingPath);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already exists/);
    assert.equal(await readFile(existingPath, "utf8"), "sentinel");

    const transcript = await runDogfoodCli(publicSeed.workspaceId, agentToken);
    assert.match(transcript.stdout, /create: \{/);
    assert.match(transcript.stdout, /acquire: \{/);
    assert.match(transcript.stdout, /submit: \{/);
    assert.match(transcript.stdout, /close: \{/);
    assert.match(transcript.stdout, /"lifecycle": "done"/);
    assert.match(
      transcript.stdout,
      new RegExp(`"owner": "${publicSeed.principalId}"`),
    );
    assert.equal(transcript.stdout.includes(agentToken), false);
    assert.equal(transcript.stderr.includes(agentToken), false);
  } finally {
    await rm(tokenDirectory, { recursive: true, force: true });
  }
});
