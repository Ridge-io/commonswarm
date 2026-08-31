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

  // ★R9.3: every accepted file command left an attributed audit row.
  const audits = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.audit_log
    WHERE workspace_id = ${f.workspaceA}::uuid
      AND command_kind = 'file_version_create'
      AND outcome = 'accepted'
      AND credential_kind = 'agent'
      AND actor_agent_principal = ${f.agentPrincipal}::uuid
  `;
  assert.ok(Number(audits[0]?.n) >= 1, "accepted create is audited with the agent actor");
});

test("F9 .html is accepted (Fastio feedback); a genuinely-unsafe extension is still refused", async () => {
  // A web/marketing team's deliverables are HTML. Downloads are served
  // Content-Disposition: attachment, so .html is no worse than the .svg already allowed.
  const html = await postCommand(f.agentToken, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: "index.html",
    declared_size_bytes: 500,
    content_type: "text/html",
  }, f.workspaceA);
  assert.equal(html.status, 200, JSON.stringify(html.body));

  // Control: the allowlist did not go permissive - an executable is still refused,
  // so F9 proves the gate accepts .html, not that it accepts everything.
  const exe = await postCommand(f.agentToken, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: "tool.exe",
    declared_size_bytes: 500,
    content_type: "application/x-msdownload",
  }, f.workspaceA);
  assert.notEqual(exe.status, 200, "an .exe must not be accepted");
});

test("F5 current_version follows COMMIT, not create: a pending v2 never hides live v1", async () => {
  const fileId = randomUUID();
  const v1 = randomUUID();
  const create1 = await postCommand(f.uaJwt, {
    kind: "file_version_create",
    file_id: fileId,
    version_id: v1,
    name: "versioned.md",
    declared_size_bytes: 100,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(create1.status, 200, JSON.stringify(create1.body));
  const put1 = await fetch(`${local.API_URL}${create1.body.upload_path as string}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: PLAN_BYTES,
  });
  assert.ok(put1.ok);
  const commit1 = await postCommand(f.uaJwt, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: v1,
  }, f.workspaceA);
  assert.equal(commit1.status, 200, JSON.stringify(commit1.body));

  // v2 pending, never committed.
  const v2 = randomUUID();
  const create2 = await postCommand(f.uaJwt, {
    kind: "file_version_create",
    file_id: fileId,
    version_id: v2,
    name: "versioned.md",
    declared_size_bytes: 100,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(create2.status, 200, JSON.stringify(create2.body));
  assert.equal(create2.body.version_n, 2);

  const during = await postCommand(f.uaJwt, {
    kind: "file_download_url",
    file_id: fileId,
  }, f.workspaceA);
  assert.equal(during.status, 200, JSON.stringify(during.body));
  assert.equal(during.body.version_n, 1, "default download still serves live v1");

  const V2_BYTES = new TextEncoder().encode("# plan v2 --");
  const put2 = await fetch(`${local.API_URL}${create2.body.upload_path as string}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: V2_BYTES,
  });
  assert.ok(put2.ok);
  const commit2 = await postCommand(f.uaJwt, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: v2,
  }, f.workspaceA);
  assert.equal(commit2.status, 200, JSON.stringify(commit2.body));
  const after = await postCommand(f.uaJwt, {
    kind: "file_download_url",
    file_id: fileId,
  }, f.workspaceA);
  assert.equal(after.body.version_n, 2, "after commit the default serves v2");
});

test("F6 a foreign tenant's file_id refuses uniformly — no oracle, no 500", async () => {
  // A file exists in workspace A (made in F2/F5); take any live A file id.
  const aFile = await sql<{ file_id: string }[]>`
    SELECT file_id FROM swarm.files
    WHERE workspace_id = ${f.workspaceA}::uuid LIMIT 1
  `;
  assert.ok(aFile[0], "workspace A holds a file");
  const foreign = await postCommand(f.ubJwt, {
    kind: "file_version_create",
    file_id: aFile[0].file_id,
    version_id: randomUUID(),
    name: "probe.md",
    declared_size_bytes: 10,
    content_type: "text/markdown",
  }, f.workspaceB);
  assert.equal(foreign.status, 409, JSON.stringify(foreign.body));
  assert.equal(foreign.body.error, "file_id_unavailable");

  // Control: an OWN-workspace id collision returns the byte-same refusal shape,
  // so the response carries no cross-tenant information.
  const bFileId = randomUUID();
  const bCreate = await postCommand(f.ubJwt, {
    kind: "file_version_create",
    file_id: bFileId,
    version_id: randomUUID(),
    name: "own.md",
    declared_size_bytes: 10,
    content_type: "text/markdown",
  }, f.workspaceB);
  assert.equal(bCreate.status, 200, JSON.stringify(bCreate.body));
  const ownCollision = await postCommand(f.ubJwt, {
    kind: "file_version_create",
    file_id: bFileId,
    version_id: randomUUID(),
    name: "own-other-name.md",
    declared_size_bytes: 10,
    content_type: "text/markdown",
  }, f.workspaceB);
  assert.equal(ownCollision.status, 409);
  assert.equal(ownCollision.body.error, foreign.body.error, "identical refusal both sides");
});

test("F7 refusals re-evaluate: the same command id retried after the cause is fixed SUCCEEDS", async () => {
  // The ledger stores ACCEPTED results only. A state-dependent refusal
  // (bytes missing) must NOT freeze the id: the honest idempotent retry is
  // PUT-the-bytes-then-retry-the-SAME-id, and it must succeed.
  const fileId = randomUUID();
  const versionId = randomUUID();
  const create = await postCommand(f.uaJwt, {
    kind: "file_version_create",
    file_id: fileId,
    version_id: versionId,
    name: "retry-me.md",
    declared_size_bytes: 100,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(create.status, 200, JSON.stringify(create.body));

  const commitId = randomUUID();
  const early = await postCommand(f.uaJwt, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
  }, f.workspaceA, commitId);
  assert.equal(early.status, 409);
  assert.equal(early.body.error, "file_bytes_missing");

  const put = await fetch(`${local.API_URL}${create.body.upload_path as string}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: PLAN_BYTES,
  });
  assert.ok(put.ok);
  const retry = await postCommand(f.uaJwt, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
  }, f.workspaceA, commitId);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));

  // An ACCEPTED id replays, and the SAME id with DIFFERENT content conflicts.
  const replay = await postCommand(f.uaJwt, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
  }, f.workspaceA, commitId);
  assert.equal(replay.status, 200, "accepted result replays");
  assert.equal(replay.body.version_n, retry.body.version_n);
  const conflict = await postCommand(f.uaJwt, {
    kind: "file_tombstone",
    file_id: fileId,
  }, f.workspaceA, commitId);
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.error, "command_id_conflict");
});

test("F8 direct table access is refused: the anon client cannot reach swarm.files", async () => {
  const anonClient = createClient(local.API_URL, process.env.SUPABASE_ANON_KEY ?? local.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // The swarm schema is not exposed through PostgREST (config.toml api.schemas)
  // and the table has no client grants; both walls must hold.
  const direct = await anonClient.schema("swarm" as never).from("files").select("*");
  assert.ok(direct.error, "anon select against swarm.files must be refused");
  const insert = await anonClient.schema("swarm" as never).from("files").insert({
    file_id: randomUUID(),
    workspace_id: f.workspaceA,
    name: "sneak.md",
    created_by_kind: "user",
    created_by: f.ua,
  } as never);
  assert.ok(insert.error, "anon insert against swarm.files must be refused");
});

async function committedAttachment(
  token: string,
  workspaceId: string,
  name: string,
): Promise<{ file_id: string; version_n: number }> {
  const fileId = randomUUID();
  const versionId = randomUUID();
  const create = await postCommand(token, {
    kind: "file_version_create",
    file_id: fileId,
    version_id: versionId,
    name,
    declared_size_bytes: PLAN_BYTES.length,
    content_type: "text/markdown",
  }, workspaceId);
  assert.equal(create.status, 200, JSON.stringify(create.body));
  const put = await fetch(`${local.API_URL}${String(create.body.upload_path)}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: PLAN_BYTES,
  });
  assert.ok(put.ok, `attachment PUT failed: ${put.status}`);
  const commit = await postCommand(token, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
    sha256: sha256hex(PLAN_BYTES),
  }, workspaceId);
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  return { file_id: fileId, version_n: Number(commit.body.version_n) };
}

const signalCommand = (
  attachments: Array<{ file_id: string; version_n: number }>,
  toAgent: string | null = null,
): Record<string, unknown> => ({
  kind: "post_signal",
  signal_kind: "note",
  body: "Read the attached plan.",
  to_user_id: null,
  to_agent_principal_id: toAgent,
  in_reply_to: null,
  about: null,
  attachments,
});

test("SA1 signal attachments post atomically, read metadata, and refuse tenant/live/cap violations", async () => {
  const attached = await committedAttachment(f.uaJwt, f.workspaceA, "attached-plan.md");

  // Broadcasts and directed signals share the same immutable link path.
  const broadcast = await postCommand(
    f.uaJwt,
    signalCommand([attached]),
    f.workspaceA,
  );
  assert.equal(broadcast.status, 200, JSON.stringify(broadcast.body));
  const broadcastSignal = broadcast.body.signal as Record<string, unknown>;
  assert.deepEqual(broadcastSignal.attachments, [{
    ...attached,
    name: "attached-plan.md",
    content_type: "text/markdown",
    size_bytes: PLAN_BYTES.length,
  }]);

  const directed = await postCommand(
    f.uaJwt,
    signalCommand([attached], f.agentPrincipal),
    f.workspaceA,
  );
  assert.equal(directed.status, 200, JSON.stringify(directed.body));

  const read = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.agentToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      resource: "signals",
      workspace_id: f.workspaceA,
      inbox: false,
      about: null,
      kind: null,
      since: null,
      include_stale: true,
      limit: 100,
    }),
  });
  assert.equal(read.status, 200);
  const readBody = await read.json() as { signals: Array<Record<string, unknown>> };
  const readBack = readBody.signals.find((row) => row.id === broadcastSignal.id);
  assert.deepEqual(readBack?.attachments, broadcastSignal.attachments);
  assert.equal(JSON.stringify(readBack).includes("download_path"), false);

  const foreign = await postCommand(
    f.ubJwt,
    signalCommand([attached]),
    f.workspaceB,
  );
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  assert.equal(foreign.body.error, "signal_attachment_unavailable");

  const pendingFile = randomUUID();
  const pendingVersion = randomUUID();
  const pending = await postCommand(f.uaJwt, {
    kind: "file_version_create",
    file_id: pendingFile,
    version_id: pendingVersion,
    name: "pending.md",
    declared_size_bytes: PLAN_BYTES.length,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  const notLive = await postCommand(
    f.uaJwt,
    signalCommand([{ file_id: pendingFile, version_n: Number(pending.body.version_n) }]),
    f.workspaceA,
  );
  assert.equal(notLive.status, 409, JSON.stringify(notLive.body));
  assert.equal(notLive.body.error, "signal_attachment_not_live");

  const overCap = await postCommand(
    f.uaJwt,
    signalCommand(Array.from({ length: 9 }, () => attached)),
    f.workspaceA,
  );
  assert.equal(overCap.status, 400, JSON.stringify(overCap.body));
  assert.equal(overCap.body.error, "signal_attachment_limit");
  assert.equal(overCap.body.limit, 8);
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
  // The refusal must have CHANGED NOTHING: state still pending, no committed_at,
  // no sha smuggled onto the row (★R2's SQL predicate, re-read from the table).
  const afterRefusal = await sql<
    { state: string; committed_at: Date | null; sha256: string | null }[]
  >`
    SELECT state, committed_at, sha256 FROM swarm.file_versions
    WHERE version_id = ${versionId}::uuid
  `;
  assert.equal(afterRefusal[0]?.state, "pending");
  assert.equal(afterRefusal[0]?.committed_at, null);
  assert.equal(afterRefusal[0]?.sha256, null);

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
  // Bytes are deleted by the S4 queue drain through the Storage API — SQL-side
  // deletion is refused by storage's own trigger. The claim must have QUEUED
  // the path durably.
  const queued = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM swarm.file_purge_queue
    WHERE storage_path = ${`${f.workspaceA}/${fileId}/1`}
      AND deleted_at IS NULL
  `;
  assert.equal(queued[0]?.count, "1", "purge queued the object path");

  const restore = await postCommand(f.uaJwt, {
    kind: "file_restore",
    file_id: fileId,
  }, f.workspaceA);
  assert.equal(restore.status, 410, JSON.stringify(restore.body));
  assert.equal(restore.body.error, "file_purged");

  // Item 6: the fully purged file released its NAME — the refusal copy
  // ("the purge frees a name") is now mechanically true.
  const released = await sql<{ purged_at: Date | null }[]>`
    SELECT purged_at FROM swarm.files
    WHERE file_id = ${fileId}::uuid AND workspace_id = ${f.workspaceA}::uuid
  `;
  assert.ok(released[0]?.purged_at, "purge stamped the file row");
  const reuse = await postCommand(f.uaJwt, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: "expired.md",
    declared_size_bytes: 100,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(reuse.status, 200, JSON.stringify(reuse.body));
});
