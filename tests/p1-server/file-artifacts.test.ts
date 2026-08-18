/**
 * S2 server tests for file artifacts (docs/design/2026-08-18-FILE-ARTIFACTS.md).
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**). The script
 * runs files with --test-concurrency=1 because each file owns the one local
 * functions runtime; two concurrent `supabase functions serve` spawns collide.
 *
 * The agent token here deliberately carries NO file scopes: passing proves the
 * ★R9.2 class exemption; a scope-gated refusal would fail every test below.
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

async function waitForFunctions(): Promise<void> {
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
}

interface FileFixture {
  workspaceA: string;
  workspaceB: string;
  ua: string;
  ub: string;
  uaJwt: string;
  ubJwt: string;
  agentPrincipal: string;
  agentToken: string;
}

let f: FileFixture;

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

async function fileFixture(): Promise<FileFixture> {
  const [ua, ub] = await Promise.all([
    createUser("file-ua"),
    createUser("file-ub"),
  ]);
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const device = randomUUID();
  const agentPrincipal = randomUUID();
  const agentRun = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(agentToken).digest();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${ua.id}::uuid, 'FileUA'), (${ub.id}::uuid, 'FileUB')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${ua.id}::uuid, 'file-tests')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES
        (${workspaceA}::uuid, 'FileA', ${ua.id}::uuid),
        (${workspaceB}::uuid, 'FileB', ${ub.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${workspaceA}::uuid, ${ua.id}::uuid, 'owner'),
        (${workspaceB}::uuid, ${ub.id}::uuid, 'owner')
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
        ${agentPrincipal}::uuid, ${workspaceA}::uuid, ${ua.id}::uuid,
        'file-worker'
      )
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${agentRun}::uuid, ${agentPrincipal}::uuid, ${device}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id
      ) VALUES (
        ${randomUUID()}::uuid, ${agentPrincipal}::uuid, ${agentRun}::uuid,
        ${tx.json(["post_signal"])}::jsonb, ${tokenHash},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  });
  return {
    workspaceA,
    workspaceB,
    ua: ua.id,
    ub: ub.id,
    uaJwt: ua.jwt,
    ubJwt: ub.jwt,
    agentPrincipal,
    agentToken,
  };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-file-env-"));
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
  await waitForFunctions();
  f = await fileFixture();
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

async function postCommand(
  token: string,
  command: Record<string, unknown>,
  workspaceId: string,
  commandId: string = randomUUID(),
): Promise<{ status: number; body: Record<string, unknown>; commandId: string }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
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
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body, commandId };
}

function sha256hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const PLAN_BYTES = new TextEncoder().encode("# plan\n\nreview me\n");

test("F1 happy path: create -> PUT -> commit -> download -> list -> tombstone -> restore", async () => {
  const fileId = randomUUID();
  const versionId = randomUUID();
  const create = await postCommand(f.agentToken, {
    kind: "file_version_create",
    file_id: fileId,
    version_id: versionId,
    name: "plan.md",
    declared_size_bytes: 1000,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(create.status, 200, JSON.stringify(create.body));
  const uploadUrl = `${local.API_URL}${create.body.upload_path as string}`;
  assert.ok(uploadUrl.includes("/storage/v1/object/upload/sign/swarm-files/"));
  assert.equal(create.body.version_n, 1);

  // ★R16: a retried create with the SAME command id replays the SAME slot.
  const replay = await postCommand(f.agentToken, {
    kind: "file_version_create",
    file_id: fileId,
    version_id: versionId,
    name: "plan.md",
    declared_size_bytes: 1000,
    content_type: "text/markdown",
  }, f.workspaceA, create.commandId);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.version_id, versionId, "replay returns the same pending slot");
  assert.equal(`${local.API_URL}${replay.body.upload_path as string}`, uploadUrl, "replay returns the same upload URL");

  // Commit before upload is refused: existence is verified (★R4 family).
  const early = await postCommand(f.agentToken, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
    sha256: sha256hex(PLAN_BYTES),
  }, f.workspaceA);
  assert.equal(early.status, 409, JSON.stringify(early.body));
  assert.equal(early.body.error, "file_bytes_missing");

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: PLAN_BYTES,
  });
  assert.ok(put.ok, `upload PUT failed: ${put.status}`);

  const commit = await postCommand(f.agentToken, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
    sha256: sha256hex(PLAN_BYTES),
  }, f.workspaceA);
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  // ★R4: the row states the MEASURED size, not the declared 1000.
  assert.equal(commit.body.size_bytes, PLAN_BYTES.length);
  assert.equal(commit.body.sha256_note, "unverified client attestation");
  assert.equal(commit.body.reference, `file:${fileId}@v1`);

  // ★R2: commit is one-time; a replayed commit with a NEW command id refuses.
  const again = await postCommand(f.agentToken, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
    sha256: sha256hex(PLAN_BYTES),
  }, f.workspaceA);
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error, "file_commit_conflict");

  // ★R3: the upload capability is dead as a rewrite vector — storage refuses a
  // second PUT to the committed path (upsert is off).
  const rePut = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: new TextEncoder().encode("tampered"),
  });
  assert.ok(!rePut.ok, "a second PUT to a committed version's path must fail");

  const download = await postCommand(f.agentToken, {
    kind: "file_download_url",
    file_id: fileId,
  }, f.workspaceA);
  assert.equal(download.status, 200, JSON.stringify(download.body));
  const got = await fetch(`${local.API_URL}${download.body.download_path as string}`);
  assert.ok(got.ok, `download GET failed: ${got.status}`);
  const bytes = new Uint8Array(await got.arrayBuffer());
  assert.equal(sha256hex(bytes), sha256hex(PLAN_BYTES), "bytes round-trip");

  const read = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.agentToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ resource: "files", workspace_id: f.workspaceA }),
  });
  assert.equal(read.status, 200);
  const listed = await read.json() as {
    files: Record<string, unknown>[];
    sha256_note: string;
  };
  assert.equal(listed.sha256_note, "unverified client attestation");
  const row = listed.files.find((entry) => entry.file_id === fileId);
  assert.ok(row, "file appears in the files read");
  assert.equal(row.name, "plan.md");
  assert.equal(Number(row.size_bytes), PLAN_BYTES.length);

  const tombstone = await postCommand(f.agentToken, {
    kind: "file_tombstone",
    file_id: fileId,
  }, f.workspaceA);
  assert.equal(tombstone.status, 200, JSON.stringify(tombstone.body));
  assert.ok(tombstone.body.restorable_until, "tombstone names the purge date");

  const blocked = await postCommand(f.agentToken, {
    kind: "file_download_url",
    file_id: fileId,
  }, f.workspaceA);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "file_tombstoned");

  const restore = await postCommand(f.agentToken, {
    kind: "file_restore",
    file_id: fileId,
  }, f.workspaceA);
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  assert.equal(restore.body.restored, true);
});

test("F2 IDOR control: a member of workspace B cannot reach A's file through B's route", async () => {
  const fileId = randomUUID();
  const versionId = randomUUID();
  const create = await postCommand(f.uaJwt, {
    kind: "file_version_create",
    file_id: fileId,
    version_id: versionId,
    name: "secret-notes.md",
    declared_size_bytes: 100,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(create.status, 200, JSON.stringify(create.body));
  const put = await fetch(`${local.API_URL}${create.body.upload_path as string}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: PLAN_BYTES,
  });
  assert.ok(put.ok);
  const commit = await postCommand(f.uaJwt, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
  }, f.workspaceA);
  assert.equal(commit.status, 200, JSON.stringify(commit.body));

  // ub is a live member of B and routes B — every membership check passes.
  // ★R1: the compound (workspace_id, file_id) key is the only thing standing
  // between this request and a cross-tenant download URL.
  for (
    const kind of [
      "file_download_url",
      "file_version_commit",
      "file_tombstone",
      "file_restore",
    ]
  ) {
    const crossed = await postCommand(f.ubJwt, {
      kind,
      file_id: fileId,
      ...(kind === "file_version_commit" ? { version_id: versionId } : {}),
    }, f.workspaceB);
    assert.equal(
      crossed.status,
      404,
      `${kind} across the tenant boundary must be a compound-key miss: ${
        JSON.stringify(crossed.body)
      }`,
    );
    assert.equal(crossed.body.error, "file_not_found");
  }

  // Control for the control: ub in A's route (no membership) refuses earlier.
  const noMembership = await postCommand(f.ubJwt, {
    kind: "file_download_url",
    file_id: fileId,
  }, f.workspaceA);
  assert.equal(noMembership.status, 403);
});

test("F3 non-creator commit is refused; caps refuse with their numbers", async () => {
  const fileId = randomUUID();
  const versionId = randomUUID();
  const create = await postCommand(f.agentToken, {
    kind: "file_version_create",
    file_id: fileId,
    version_id: versionId,
    name: "handoff.md",
    declared_size_bytes: 50,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(create.status, 200, JSON.stringify(create.body));
  const put = await fetch(`${local.API_URL}${create.body.upload_path as string}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: PLAN_BYTES,
  });
  assert.ok(put.ok);
  // ua owns the workspace and the agent — and still may not commit an agent's
  // pending version (★R2: creator-only).
  const foreign = await postCommand(f.uaJwt, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
  }, f.workspaceA);
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body));

  const tooBig = await postCommand(f.uaJwt, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: "huge.pdf",
    declared_size_bytes: 26 * 1024 * 1024,
    content_type: "application/pdf",
  }, f.workspaceA);
  assert.equal(tooBig.status, 413);
  assert.match(String(tooBig.body.message), /25 MB/, "refusal names the cap");

  const badType = await postCommand(f.uaJwt, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: "payload.sh",
    declared_size_bytes: 10,
    content_type: "text/x-shellscript",
  }, f.workspaceA);
  assert.equal(badType.status, 415);
});

test("F4 purge claims once and restore refuses a claimed file (★R6)", async () => {
  const fileId = randomUUID();
  const versionId = randomUUID();
  const create = await postCommand(f.uaJwt, {
    kind: "file_version_create",
    file_id: fileId,
    version_id: versionId,
    name: "expired.md",
    declared_size_bytes: 100,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(create.status, 200, JSON.stringify(create.body));
  const put = await fetch(`${local.API_URL}${create.body.upload_path as string}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: PLAN_BYTES,
  });
  assert.ok(put.ok);
  const commit = await postCommand(f.uaJwt, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
  }, f.workspaceA);
  assert.equal(commit.status, 200);
  const tombstone = await postCommand(f.uaJwt, {
    kind: "file_tombstone",
    file_id: fileId,
  }, f.workspaceA);
  assert.equal(tombstone.status, 200);

  // Age the tombstone past the window, run the purge the cron job runs.
  await sql`
    UPDATE swarm.files
    SET tombstoned_at = statement_timestamp() - interval '31 days'
    WHERE file_id = ${fileId}::uuid AND workspace_id = ${f.workspaceA}::uuid
  `;
  await sql`SELECT swarm.purge_file_artifacts()`;
  const state = await sql<{ state: string }[]>`
    SELECT state FROM swarm.file_versions
    WHERE version_id = ${versionId}::uuid
  `;
  assert.equal(state[0]?.state, "purged", "purge claimed the version row");
  const object = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM storage.objects
    WHERE bucket_id = 'swarm-files'
      AND name = ${`${f.workspaceA}/${fileId}/1`}
  `;
  assert.equal(object[0]?.count, "0", "purge deleted the object row");

  const restore = await postCommand(f.uaJwt, {
    kind: "file_restore",
    file_id: fileId,
  }, f.workspaceA);
  assert.equal(restore.status, 410, JSON.stringify(restore.body));
  assert.equal(restore.body.error, "file_purged");
});
