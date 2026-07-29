import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import {
  acceptInviteLink,
  cloudAcceptOperations,
  type AcceptProgress,
  type AcceptSession,
} from "../../src/cloud/accept-link.js";
import {
  assertAgentToken,
  ThinCommandClient,
} from "../../src/cloud/command-client.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { awaitFunctionRunning } from "./edge-readiness.js";
import {
  decodeInviteLink,
  encodeInviteLink,
} from "../../src/cloud/invite-link.js";
import { seedDogfood } from "../../src/cloud/seed.js";
import type {
  CredentialProfile,
  CredentialRecord,
  CredentialStore,
} from "../../src/cloud/storage.js";
import {
  cloudWorkspaceDirectory,
  selectWorkspace,
} from "../../src/cloud/workspaces.js";

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

class LocalMemoryStore implements CredentialStore {
  readonly kind = "keychain" as const;
  readonly location = "local integration memory";
  record: CredentialRecord | null = null;
  profile: CredentialProfile;

  constructor(userId: string, email: string) {
    this.profile = {
      version: 1,
      userId,
      workspaceId: null,
      email,
      principalId: null,
      principalName: null,
      pendingCommands: {},
    };
  }

  async read(): Promise<CredentialRecord | null> {
    return this.record ? structuredClone(this.record) : null;
  }
  async write(record: CredentialRecord): Promise<void> {
    this.record = structuredClone(record);
  }
  async delete(): Promise<void> {
    this.record = null;
  }
  async readProfile(): Promise<CredentialProfile> {
    return structuredClone(this.profile);
  }
  async writeProfile(profile: CredentialProfile): Promise<void> {
    this.profile = structuredClone(profile);
  }
  async withLock<T>(work: () => Promise<T>): Promise<T> {
    return await work();
  }
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

/**
 * D-020: wait for the command function to be RUNNING, not merely reachable.
 *
 * This used to return on any 401, which the local gateway answers before the function module
 * has loaded — so the gate cleared while the runtime was cold and the first real command came
 * back `502 unknown_error`, roughly 1 run in 8. The predicate now requires the function's own
 * `{ "error": "unauthenticated" }` body, which only its code produces. See edge-readiness.ts
 * for why this is a gate rather than a retry around the failing command.
 */
async function ready(): Promise<void> {
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => functionLogs.slice(-4000),
  });
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
    env: {
      ...process.env,
      SWARM_ALLOW_INSECURE_STORE: "0",
      SWARM_CLOUD_WORKSPACE_ID: workspaceId,
    },
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
  options: { workspaceId?: string; workspaceName?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const seedArgs = [
    "--import",
    "tsx",
    "src/cli.ts",
    "seed-fixture",
    "--uid",
    userId,
  ];
  if (options.workspaceId) {
    seedArgs.push("--workspace-id", options.workspaceId);
  }
  if (options.workspaceName) {
    seedArgs.push("--workspace-name", options.workspaceName);
  }
  const child = spawn(process.execPath, seedArgs, {
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
      workspaceName: string;
      streamId: string;
      principalId: string;
      tokenWritten: boolean;
    };
    assert.equal(publicSeed.userId, userId);
    assert.equal(publicSeed.membershipRole, "owner");
    assert.equal(publicSeed.workspaceName, "Dogfood Workspace");
    assert.equal(publicSeed.tokenWritten, true);
    assert.equal(seeded.stdout.includes(tokenPath), false);
    const agentCredential = await readFile(tokenPath, "utf8");
    const agentArtifact = JSON.parse(agentCredential) as {
      message: string;
      status: string;
      principal_id: string;
      token_id: string;
      run_id: string;
      agent_token: string;
    };
    assert.deepEqual(Object.keys(agentArtifact).sort(), [
      "agent_token",
      "message",
      "principal_id",
      "run_id",
      "status",
      "token_id",
    ]);
    const agentToken = agentArtifact.agent_token;
    assertAgentToken(agentToken);
    assert.equal(agentArtifact.status, "accepted");
    assert.equal(agentArtifact.principal_id, publicSeed.principalId);
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
    assert.equal(directReseed.workspaceName, publicSeed.workspaceName);

    const explicitWorkspaceId = randomUUID();
    const explicitWorkspaceName = `uxtest-r1-${nonce.slice(0, 8)}`;
    const explicitPath = join(tokenDirectory, "explicit-token");
    const explicitSeed = await runSeedCli(userId, explicitPath, {
      workspaceId: explicitWorkspaceId,
      workspaceName: explicitWorkspaceName,
    });
    assert.equal(explicitSeed.code, 0, explicitSeed.stderr);
    const publicExplicitSeed = JSON.parse(explicitSeed.stdout) as typeof publicSeed;
    assert.equal(publicExplicitSeed.workspaceId, explicitWorkspaceId);
    assert.equal(publicExplicitSeed.workspaceName, explicitWorkspaceName);
    assert.notEqual(publicExplicitSeed.workspaceId, publicSeed.workspaceId);
    await rm(explicitPath);

    const explicitReseedPath = join(tokenDirectory, "explicit-reseed-token");
    const explicitReseed = await runSeedCli(userId, explicitReseedPath, {
      workspaceId: explicitWorkspaceId,
      workspaceName: "ignored-on-idempotent-retry",
    });
    assert.equal(explicitReseed.code, 0, explicitReseed.stderr);
    const publicExplicitReseed = JSON.parse(
      explicitReseed.stdout,
    ) as typeof publicSeed;
    assert.equal(publicExplicitReseed.workspaceId, explicitWorkspaceId);
    assert.equal(publicExplicitReseed.workspaceName, explicitWorkspaceName);
    assert.equal(publicExplicitReseed.tokenWritten, false);
    await assert.rejects(stat(explicitReseedPath), { code: "ENOENT" });

    await assert.rejects(
      seedDogfood({
        databaseUrl: local.DB_URL,
        userId,
        workspaceId: "not-a-uuid",
      }),
      /workspace id must be a UUID/,
    );

    const existingPath = join(tokenDirectory, "must-not-overwrite");
    await writeFile(existingPath, "sentinel", { mode: 0o600 });
    const refused = await runSeedCli(userId, existingPath);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already exists/);
    assert.equal(await readFile(existingPath, "utf8"), "sentinel");

    const transcript = await runDogfoodCli(
      publicSeed.workspaceId,
      agentCredential,
    );
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

test("one-command invite link accept converges after a live local double-run", async () => {
  const nonce = randomUUID();
  const ownerEmail = `p2-owner-${nonce}@example.test`;
  const inviteeEmail = `p2-invitee-${nonce}@example.test`;
  const ownerPassword = `T-${randomBytes(24).toString("base64url")}!`;
  const inviteePassword = `T-${randomBytes(24).toString("base64url")}!`;
  const [ownerCreated, inviteeCreated] = await Promise.all([
    admin.auth.admin.createUser({
      email: ownerEmail,
      password: ownerPassword,
      email_confirm: true,
      user_metadata: { full_name: "P2 Owner" },
    }),
    admin.auth.admin.createUser({
      email: inviteeEmail,
      password: inviteePassword,
      email_confirm: true,
      user_metadata: { full_name: "P2 Invitee" },
    }),
  ]);
  assert.ifError(ownerCreated.error);
  assert.ifError(inviteeCreated.error);
  assert.ok(ownerCreated.data.user && inviteeCreated.data.user);
  const auth = createClient(local.API_URL, local.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ownerAuth = await auth.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  assert.ifError(ownerAuth.error);
  const ownerJwt = ownerAuth.data.session?.access_token;
  assert.ok(ownerJwt);
  const inviteeAuth = await auth.auth.signInWithPassword({
    email: inviteeEmail,
    password: inviteePassword,
  });
  assert.ifError(inviteeAuth.error);
  const inviteeJwt = inviteeAuth.data.session?.access_token;
  assert.ok(inviteeJwt);

  const seeded = await seedDogfood({
    databaseUrl: local.DB_URL,
    userId: ownerCreated.data.user.id,
    displayName: "P2 Owner",
    workspaceName: `P2 Link ${nonce}`,
  });
  const target = cloudTarget(local.API_URL, local.ANON_KEY);
  const invited = await new ThinCommandClient(target).sendConnect({
    workspaceId: seeded.workspaceId,
    credential: ownerJwt,
    command: { kind: "invite_member", email: inviteeEmail },
  });
  assert.equal(invited.response.status, "accepted");
  assert.ok(invited.response.invitation_token);
  assert.equal(invited.response.workspace_id, seeded.workspaceId);
  assert.equal(invited.response.workspace_name, `P2 Link ${nonce}`);
  const linkPayload = decodeInviteLink(encodeInviteLink({
    v: 1,
    url: target.url,
    anon_key: target.anonKey,
    workspace_id: seeded.workspaceId,
    invitation_token: invited.response.invitation_token,
    workspace_name: String(invited.response.workspace_name),
    inviter_display_name: String(invited.response.inviter_display_name),
    inviter_user_id: String(invited.response.inviter_user_id),
  }));
  const store = new LocalMemoryStore(
    inviteeCreated.data.user.id,
    inviteeEmail,
  );
  const session: AcceptSession = {
    accessToken: inviteeJwt,
    userId: inviteeCreated.data.user.id,
    deviceId: randomUUID(),
    email: inviteeEmail,
  };
  const progress: AcceptProgress[] = [];
  const operations = cloudAcceptOperations(target, store);
  const runtime = {
    ...operations,
    pinOrigin: async () => undefined,
    currentSession: async () => session,
    loginSession: async () => {
      throw new Error("live local flow should reuse its authenticated session");
    },
    autoName: () => `p2-agent-${nonce.slice(0, 8)}`,
    emit: (entry: AcceptProgress) => progress.push(entry),
  };
  const first = await acceptInviteLink({
    payload: linkPayload,
    target,
    store,
    runtime,
  });
  const second = await acceptInviteLink({
    payload: linkPayload,
    target,
    store,
    runtime,
  });
  assert.equal(second.checkpointShortCircuit, true);
  assert.equal(second.principalId, first.principalId);
  assert.equal(store.profile.workspaceId, seeded.workspaceId);
  assert.equal(store.profile.principalId, first.principalId);
  assert.ok(progress.some((entry) => entry.message.includes("You're connected")));

  const db = postgres(local.DB_URL, { prepare: false });
  try {
    const [membershipCount] = await db<{ count: string | number }[]>`
      SELECT count(*) AS count
      FROM swarm.memberships
      WHERE workspace_id = ${seeded.workspaceId}::uuid
        AND user_id = ${inviteeCreated.data.user.id}::uuid
        AND revoked_at IS NULL
    `;
    const [principalCount] = await db<{ count: string | number }[]>`
      SELECT count(*) AS count
      FROM swarm.agent_principals
      WHERE workspace_id = ${seeded.workspaceId}::uuid
        AND owner_user_id = ${inviteeCreated.data.user.id}::uuid
        AND revoked_at IS NULL
    `;
    assert.equal(Number(membershipCount?.count), 1);
    assert.equal(Number(principalCount?.count), 1);
  } finally {
    await db.end({ timeout: 5 });
  }
});

test("live project reads list, select, and render status across two memberships", async () => {
  const nonce = randomUUID();
  const email = `p2-projects-${nonce}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const auth = createClient(local.API_URL, local.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await auth.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  assert.ok(signedIn.data.session?.access_token);
  const deviceId = randomUUID();
  const alphaId = randomUUID();
  const betaId = randomUUID();
  await seedDogfood({
    databaseUrl: local.DB_URL,
    userId: created.data.user.id,
    deviceId,
    workspaceId: alphaId,
    workspaceName: `Alpha ${nonce.slice(0, 8)}`,
    displayName: "P2\u202e Operator",
  });
  await seedDogfood({
    databaseUrl: local.DB_URL,
    userId: created.data.user.id,
    deviceId,
    workspaceId: betaId,
    workspaceName: `Beta ${nonce.slice(0, 8)}`,
    displayName: "P2 Operator",
  });
  const db = postgres(local.DB_URL, { prepare: false });
  try {
    await db`
      UPDATE swarm.workspaces
      SET archived_at = statement_timestamp()
      WHERE workspace_id = ${betaId}::uuid
    `;
  } finally {
    await db.end({ timeout: 5 });
  }

  const directory = cloudWorkspaceDirectory(
    cloudTarget(local.API_URL, local.ANON_KEY),
  );
  const session = {
    accessToken: signedIn.data.session.access_token,
    userId: created.data.user.id,
    deviceId,
  };
  const projects = await directory.list(session);
  assert.deepEqual(
    projects.map((project) => project.workspace_id).sort(),
    [alphaId, betaId].sort(),
  );
  assert.equal(
    projects.find((project) => project.workspace_id === betaId)?.archived,
    true,
  );
  assert.ok(projects.every((project) => project.name.includes(nonce.slice(0, 8))));

  const store = new LocalMemoryStore(created.data.user.id, email);
  const selected = await selectWorkspace(
    `Beta ${nonce.slice(0, 8)}`,
    projects,
    store,
    created.data.user.id,
  );
  assert.equal(selected.workspace_id, betaId);
  assert.equal(store.profile.workspaceId, betaId);

  const status = await directory.status(session, betaId);
  assert.equal(status.members.length, 1);
  assert.equal(status.members[0]?.name, "P2 Operator");
  assert.equal(status.members[0]?.you, true);
  assert.ok(status.agents.length >= 1);
  assert.ok(status.agents.some((agent) => agent.this_machine));
  assert.deepEqual(status.tasks, []);
});
