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

async function createBrainAgent(label: string): Promise<{
  principalId: string;
  token: string;
}> {
  const deviceId = randomUUID();
  const principalId = randomUUID();
  const runId = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${deviceId}::uuid, ${f.ua}::uuid, ${label})
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${principalId}::uuid, ${f.workspaceA}::uuid, ${f.ua}::uuid, ${label}
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

test("B1 21 brain puts keep one name, 20 live versions, and retired history", async () => {
  const actor = await createBrainAgent("brain-window-writer");
  const topicFileName = "brain--rolling-ledger.md";
  let fileId = "";
  const bodies: Uint8Array[] = [];

  for (let versionN = 1; versionN <= 21; versionN += 1) {
    const bytes = new TextEncoder().encode(`# Rolling ledger\n\nVersion ${versionN}.\n`);
    bodies.push(bytes);
    const versionId = randomUUID();
    const create = await postCommand(actor.token, {
      kind: "file_version_create",
      file_id: randomUUID(),
      version_id: versionId,
      name: topicFileName,
      declared_size_bytes: bytes.length,
      content_type: "text/markdown",
    }, f.workspaceA);
    assert.equal(create.status, 200, `create ${versionN}: ${JSON.stringify(create.body)}`);
    fileId ||= String(create.body.file_id);
    assert.equal(create.body.file_id, fileId, "the topic name remains the stable pointer");
    assert.equal(create.body.version_n, versionN);

    const put = await fetch(`${local.API_URL}${String(create.body.upload_path)}`, {
      method: "PUT",
      headers: { "content-type": "text/markdown" },
      body: bytes,
    });
    assert.ok(put.ok, `upload ${versionN} failed: ${put.status}`);
    const commit = await postCommand(actor.token, {
      kind: "file_version_commit",
      file_id: fileId,
      version_id: versionId,
      sha256: sha256hex(bytes),
    }, f.workspaceA);
    assert.equal(commit.status, 200, `commit ${versionN}: ${JSON.stringify(commit.body)}`);
    assert.equal(commit.body.version_n, versionN);
    assert.equal(
      commit.body.retired_version_n,
      versionN === 21 ? 1 : undefined,
      "only the 21st commit retires the oldest live version",
    );
  }

  const states = await sql<
    { state: string; n: string; first_version: number; last_version: number }[]
  >`
    SELECT state, count(*)::text AS n,
           min(version_n)::integer AS first_version,
           max(version_n)::integer AS last_version
    FROM swarm.file_versions
    WHERE file_id = ${fileId}::uuid
      AND workspace_id = ${f.workspaceA}::uuid
    GROUP BY state
    ORDER BY state
  `;
  assert.deepEqual([...states], [
    { state: "live", n: "20", first_version: 2, last_version: 21 },
    { state: "retired", n: "1", first_version: 1, last_version: 1 },
  ]);
  const retiredMarker = await sql<{ retired_at: Date | null }[]>`
    SELECT retired_at FROM swarm.file_versions
    WHERE file_id = ${fileId}::uuid AND version_n = 1
  `;
  assert.ok(retiredMarker[0]?.retired_at, "retirement is marked, not deleted");

  const read = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${actor.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ resource: "files", workspace_id: f.workspaceA }),
  });
  assert.equal(read.status, 200);
  const listed = await read.json() as { files: Array<Record<string, unknown>> };
  const topic = listed.files.find((row) => row.name === topicFileName);
  assert.ok(topic, "the original topic name still resolves in brain ls data");
  assert.equal(topic.current_version, 21);
  assert.equal(topic.live_version_count, 20);
  assert.equal(topic.retired_version_count, 1);

  const retiredGrant = await postCommand(actor.token, {
    kind: "file_download_url",
    file_id: fileId,
    version_n: 1,
  }, f.workspaceA);
  assert.equal(retiredGrant.status, 200, JSON.stringify(retiredGrant.body));
  assert.equal(retiredGrant.body.version_state, "retired");
  assert.equal(retiredGrant.body.live_version_count, 20);
  assert.equal(retiredGrant.body.retired_version_count, 1);
  const retiredGet = await fetch(
    `${local.API_URL}${String(retiredGrant.body.download_path)}`,
  );
  assert.ok(retiredGet.ok);
  assert.deepEqual(
    new Uint8Array(await retiredGet.arrayBuffer()),
    bodies[0],
    "brain get --version 1 still resolves the retired object for a member agent",
  );

  const currentGrant = await postCommand(actor.token, {
    kind: "file_download_url",
    file_id: fileId,
  }, f.workspaceA);
  assert.equal(currentGrant.status, 200, JSON.stringify(currentGrant.body));
  assert.equal(currentGrant.body.version_n, 21);
  assert.equal(currentGrant.body.version_state, "live");
});

test("B1b a refused brain commit cannot retire a live version", async () => {
  const actor = await createBrainAgent("brain-refusal-rollback-writer");
  const topicFileName = "brain--refusal-rollback.md";
  const fileId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.files (
        file_id, workspace_id, name, created_by_kind, created_by, current_version
      ) VALUES (
        ${fileId}::uuid, ${f.workspaceA}::uuid, ${topicFileName},
        'agent', ${actor.principalId}::uuid, 20
      )
    `;
    for (let versionN = 1; versionN <= 20; versionN += 1) {
      await tx`
        INSERT INTO swarm.file_versions (
          version_id, file_id, workspace_id, version_n, state,
          size_bytes, content_type, storage_path, uploaded_by_kind,
          uploaded_by, committed_at
        ) VALUES (
          ${randomUUID()}::uuid, ${fileId}::uuid, ${f.workspaceA}::uuid,
          ${versionN}, 'live', 1, 'text/markdown',
          ${`${f.workspaceA}/${fileId}/${versionN}`}, 'agent',
          ${actor.principalId}::uuid, statement_timestamp()
        )
      `;
    }
  });

  const pendingVersionId = randomUUID();
  const create = await postCommand(actor.token, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: pendingVersionId,
    name: topicFileName,
    declared_size_bytes: PLAN_BYTES.length,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(create.status, 200, JSON.stringify(create.body));
  assert.equal(create.body.file_id, fileId);
  assert.equal(create.body.version_n, 21);
  const put = await fetch(`${local.API_URL}${String(create.body.upload_path)}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: PLAN_BYTES,
  });
  assert.ok(put.ok, `upload failed: ${put.status}`);

  const triggerName = "l52_suppress_selected_brain_commit";
  const functionName = "l52_suppress_selected_brain_commit";
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION swarm.${functionName}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $test$
    BEGIN
      IF OLD.version_id = '${pendingVersionId}'::uuid
         AND OLD.state = 'pending'
         AND NEW.state = 'live' THEN
        RETURN NULL;
      END IF;
      RETURN NEW;
    END;
    $test$;
    DROP TRIGGER IF EXISTS ${triggerName} ON swarm.file_versions;
    CREATE TRIGGER ${triggerName}
      BEFORE UPDATE ON swarm.file_versions
      FOR EACH ROW
      EXECUTE FUNCTION swarm.${functionName}();
  `);
  try {
    /* This trigger makes the pending->live UPDATE return no row. In the old
     * order the oldest live version was retired first, then the normal 409
     * return committed that retirement. The fixed order refuses first. */
    const refused = await postCommand(actor.token, {
      kind: "file_version_commit",
      file_id: fileId,
      version_id: pendingVersionId,
      sha256: sha256hex(PLAN_BYTES),
    }, f.workspaceA);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "file_commit_conflict");

    const states = await sql<{ state: string; n: string }[]>`
      SELECT state, count(*)::text AS n
      FROM swarm.file_versions
      WHERE file_id = ${fileId}::uuid
      GROUP BY state
      ORDER BY state
    `;
    assert.deepEqual([...states], [
      { state: "live", n: "20" },
      { state: "pending", n: "1" },
    ]);
  } finally {
    await sql.unsafe(`
      DROP TRIGGER IF EXISTS ${triggerName} ON swarm.file_versions;
      DROP FUNCTION IF EXISTS swarm.${functionName}();
    `);
  }
});

test("B2 a brain topic refuses only when 20 uploads are still in flight", async () => {
  const actor = await createBrainAgent("brain-in-flight-writer");
  const topicFileName = "brain--in-flight-cap.md";
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const create = await postCommand(actor.token, {
      kind: "file_version_create",
      file_id: randomUUID(),
      version_id: randomUUID(),
      name: topicFileName,
      declared_size_bytes: 1,
      content_type: "text/markdown",
    }, f.workspaceA);
    assert.equal(create.status, 200, `pending create ${attempt}: ${JSON.stringify(create.body)}`);
  }
  const refused = await postCommand(actor.token, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: topicFileName,
    declared_size_bytes: 1,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "brain_version_in_flight_cap");
  assert.match(String(refused.body.message), /20 uncommitted uploads in flight/);
  assert.match(String(refused.body.message), /wait for one to commit|pending upload to expire/);
  assert.match(String(refused.body.message), /brain put again/);

  // The existing hourly `swarm.purge_file_artifacts()` job is the expiry path:
  // it changes pending rows older than 3h to purged and queues their object paths.
  await sql`
    UPDATE swarm.file_versions AS v
    SET created_at = statement_timestamp() - interval '4 hours'
    FROM swarm.files AS file
    WHERE file.workspace_id = ${f.workspaceA}::uuid
      AND file.name = ${topicFileName}
      AND v.file_id = file.file_id
      AND v.workspace_id = file.workspace_id
      AND v.state = 'pending'
  `;
  await sql`SELECT swarm.purge_file_artifacts()`;
  const expiredStates = await sql<{ state: string; n: string }[]>`
    SELECT v.state, count(*)::text AS n
    FROM swarm.file_versions AS v
    JOIN swarm.files AS file
      ON file.file_id = v.file_id AND file.workspace_id = v.workspace_id
    WHERE file.workspace_id = ${f.workspaceA}::uuid
      AND file.name = ${topicFileName}
    GROUP BY v.state
  `;
  assert.deepEqual([...expiredStates], [{ state: "purged", n: "20" }]);
  const afterExpiry = await postCommand(actor.token, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: topicFileName,
    declared_size_bytes: 1,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(afterExpiry.status, 200, JSON.stringify(afterExpiry.body));
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

/* B2: the optional compare-and-set on file_version_create.
 *
 * Measured 2026-09-04: two agents read-modify-wrote one brain topic and the
 * later write, composed from a copy read before the newer version, silently
 * replaced it. `if_version` refuses exactly that. The default is unchanged, so
 * every test above sends no precondition and still passes.
 *
 * NOT RUN in the lane that wrote it: tests/p1-server needs local Supabase and
 * the exclusive DB slot, which another lane held. Typechecked only. */

test("B2 if_version refuses a create against a superseded live version", async () => {
  const actor = await createBrainAgent("brain-cas-writer");
  const topicFileName = "brain--compare-and-set.md";
  const first = new TextEncoder().encode("# CAS\n\nVersion 1.\n");

  /* v1: no live version yet, so if_version 0 is the correct precondition and
   * must be ACCEPTED. This is the discriminating half: a check that refused
   * everything would also refuse here. */
  const createV1 = await postCommand(actor.token, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: topicFileName,
    declared_size_bytes: first.length,
    content_type: "text/markdown",
    if_version: 0,
  }, f.workspaceA);
  assert.equal(createV1.status, 200, JSON.stringify(createV1.body));
  const fileId = String(createV1.body.file_id);
  const versionV1 = String(createV1.body.version_id);
  const putV1 = await fetch(`${local.API_URL}${String(createV1.body.upload_path)}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: first,
  });
  assert.ok(putV1.ok);
  const commitV1 = await postCommand(actor.token, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionV1,
    sha256: sha256hex(first),
  }, f.workspaceA);
  assert.equal(commitV1.status, 200, JSON.stringify(commitV1.body));
  assert.equal(commitV1.body.version_n, 1);

  /* The live version is now 1, so the stale writer still holding 0 is refused
   * BEFORE any row is written. */
  const stale = await postCommand(actor.token, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: topicFileName,
    declared_size_bytes: 32,
    content_type: "text/markdown",
    if_version: 0,
  }, f.workspaceA);
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error, "file_version_precondition_failed");
  assert.match(String(stale.body.message), /at version 1/);
  assert.match(String(stale.body.message), /required version 0/);

  /* No pending row was created, so the refusal cost no version number and no
   * quota. A refusal that had already inserted would show a v2 here. */
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.file_versions
    WHERE file_id = ${fileId}::uuid
  `;
  assert.equal(rows[0]?.n, "1", "the refused create must leave no version row");

  /* Re-reading and presenting the current version succeeds, which is the
   * remedy the CLI prints. */
  const fresh = await postCommand(actor.token, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: topicFileName,
    declared_size_bytes: 32,
    content_type: "text/markdown",
    if_version: 1,
  }, f.workspaceA);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.version_n, 2);
});

test("B2b a create with no if_version stays last-write-wins", async () => {
  /* CONTROL for the compatibility claim: an older client sends no such key,
   * and the exact-key-set validator must still accept the request. */
  const actor = await createBrainAgent("brain-cas-default");
  const topicFileName = "brain--cas-default.md";

  const create = await postCommand(actor.token, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: topicFileName,
    declared_size_bytes: 16,
    content_type: "text/markdown",
  }, f.workspaceA);

  assert.equal(create.status, 200, JSON.stringify(create.body));
  assert.equal(create.body.version_n, 1);
});

test("B2c a malformed if_version is refused as a bad request, not a conflict", async () => {
  const actor = await createBrainAgent("brain-cas-malformed");

  /* null is NOT here: an explicit null means "no precondition", the same way
   * commit accepts a null sha256. Only a value that cannot be a version is a
   * bad request. */
  for (const bad of [-1, 1.5, "2", true]) {
    const create = await postCommand(actor.token, {
      kind: "file_version_create",
      file_id: randomUUID(),
      version_id: randomUUID(),
      name: "brain--cas-malformed.md",
      declared_size_bytes: 16,
      content_type: "text/markdown",
      if_version: bad,
    }, f.workspaceA);

    /* 400, never 409: a client that cannot express the precondition has not
     * lost a race, and must not be told to re-read and retry. */
    assert.equal(create.status, 400, `if_version ${JSON.stringify(bad)}: ${JSON.stringify(create.body)}`);
  }
});

test("B2d two writers derived from the same version: exactly one commit lands", async () => {
  /* The case the flag exists for, and the one a create-time check alone does
   * NOT stop. brain put is two phases; the create lock ends with its own
   * transaction and current_version moves only at commit. So both writers
   * create successfully against version 1, and the precondition has to be
   * re-checked at commit under the file lock.
   *
   * NOT RUN: tests/p1-server needs local Supabase and the exclusive DB slot,
   * held by another lane. Typechecked only. */
  const actor = await createBrainAgent("brain-cas-race");
  const topicFileName = "brain--cas-race.md";

  const seed = new TextEncoder().encode("# Race\n\nVersion 1.\n");
  const createSeed = await postCommand(actor.token, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: topicFileName,
    declared_size_bytes: seed.length,
    content_type: "text/markdown",
  }, f.workspaceA);
  assert.equal(createSeed.status, 200, JSON.stringify(createSeed.body));
  const fileId = String(createSeed.body.file_id);
  await fetch(`${local.API_URL}${String(createSeed.body.upload_path)}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: seed,
  });
  const commitSeed = await postCommand(actor.token, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: String(createSeed.body.version_id),
    sha256: sha256hex(seed),
  }, f.workspaceA);
  assert.equal(commitSeed.status, 200, JSON.stringify(commitSeed.body));
  assert.equal(commitSeed.body.version_n, 1);

  // Both writers read version 1 and both create against it. Both creates are
  // expected to succeed: at create time neither has changed current_version.
  const writers = await Promise.all([2, 3].map(async (label) => {
    const bytes = new TextEncoder().encode(`# Race\n\nWriter ${label}.\n`);
    const create = await postCommand(actor.token, {
      kind: "file_version_create",
      file_id: randomUUID(),
      version_id: randomUUID(),
      name: topicFileName,
      declared_size_bytes: bytes.length,
      content_type: "text/markdown",
      if_version: 1,
    }, f.workspaceA);
    assert.equal(create.status, 200, `writer ${label} create: ${JSON.stringify(create.body)}`);
    const put = await fetch(`${local.API_URL}${String(create.body.upload_path)}`, {
      method: "PUT",
      headers: { "content-type": "text/markdown" },
      body: bytes,
    });
    assert.ok(put.ok);
    return { bytes, versionId: String(create.body.version_id) };
  }));

  const commits = await Promise.all(writers.map((writer) =>
    postCommand(actor.token, {
      kind: "file_version_commit",
      file_id: fileId,
      version_id: writer.versionId,
      sha256: sha256hex(writer.bytes),
    }, f.workspaceA)
  ));

  const accepted = commits.filter((commit) => commit.status === 200);
  const refused = commits.filter((commit) => commit.status === 409);
  assert.equal(accepted.length, 1, `exactly one commit must land: ${JSON.stringify(commits.map((c) => c.body))}`);
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.body.error, "file_version_precondition_failed");
  assert.match(String(refused[0]!.body.message), /required version 1/);

  /* The loser left no live version. Which of the two pending versions wins is
   * not determined here - both were created before either committed - so the
   * assertion is on the SHAPE: the seed plus exactly one winner, and the
   * winner is the version the accepted commit reported. */
  const live = await sql<{ version_n: number }[]>`
    SELECT version_n FROM swarm.file_versions
    WHERE file_id = ${fileId}::uuid AND state = 'live'
    ORDER BY version_n ASC
  `;
  const winnerVersion = Number(accepted[0]!.body.version_n);
  assert.deepEqual(live.map((row) => row.version_n), [1, winnerVersion]);
  assert.ok(
    winnerVersion === 2 || winnerVersion === 3,
    `the winner must be one of the two created versions, got ${winnerVersion}`,
  );

  /* current_version must equal the winner, or a later --if-version derived
   * from a read would compare against a number no reader was ever shown. */
  const head = await sql<{ current_version: number }[]>`
    SELECT current_version FROM swarm.files WHERE file_id = ${fileId}::uuid
  `;
  assert.equal(Number(head[0]?.current_version), winnerVersion);
  /* The refusal must name the version that actually won, not a fixed guess. */
  assert.match(
    String(refused[0]!.body.message),
    new RegExp(`at version ${winnerVersion}\\b`),
  );

  // The loser's pending row is left for the sweeper, never silently committed.
  const stranded = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.file_versions
    WHERE file_id = ${fileId}::uuid AND state = 'pending'
  `;
  assert.equal(stranded[0]?.n, "1");
});

test("B2e the precondition is re-checked at commit, not only at create", async () => {
  /* Minimal form of B2d with the interleaving made explicit and serial, so a
   * failure here names the mechanism rather than a race.
   *
   * NOT RUN: needs local Supabase and the exclusive DB slot. */
  const actor = await createBrainAgent("brain-cas-recheck");
  const topicFileName = "brain--cas-recheck.md";
  const first = new TextEncoder().encode("# Recheck\n\nVersion 1.\n");

  const createA = await postCommand(actor.token, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: topicFileName,
    declared_size_bytes: first.length,
    content_type: "text/markdown",
  }, f.workspaceA);
  const fileId = String(createA.body.file_id);
  await fetch(`${local.API_URL}${String(createA.body.upload_path)}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: first,
  });
  await postCommand(actor.token, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: String(createA.body.version_id),
    sha256: sha256hex(first),
  }, f.workspaceA);

  // Stale writer creates against version 1 and PASSES the create-time check.
  const stale = new TextEncoder().encode("# Recheck\n\nStale writer.\n");
  const staleCreate = await postCommand(actor.token, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: topicFileName,
    declared_size_bytes: stale.length,
    content_type: "text/markdown",
    if_version: 1,
  }, f.workspaceA);
  assert.equal(staleCreate.status, 200, "the create-time check cannot yet know");
  await fetch(`${local.API_URL}${String(staleCreate.body.upload_path)}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: stale,
  });

  // A different writer commits version 2 in between.
  const winner = new TextEncoder().encode("# Recheck\n\nWinner.\n");
  const winnerCreate = await postCommand(actor.token, {
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: topicFileName,
    declared_size_bytes: winner.length,
    content_type: "text/markdown",
  }, f.workspaceA);
  await fetch(`${local.API_URL}${String(winnerCreate.body.upload_path)}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: winner,
  });
  const winnerCommit = await postCommand(actor.token, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: String(winnerCreate.body.version_id),
    sha256: sha256hex(winner),
  }, f.workspaceA);
  assert.equal(winnerCommit.status, 200, JSON.stringify(winnerCommit.body));

  // Now the stale writer commits. current_version is 2; it required 1.
  const staleCommit = await postCommand(actor.token, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: String(staleCreate.body.version_id),
    sha256: sha256hex(stale),
  }, f.workspaceA);

  assert.equal(staleCommit.status, 409, JSON.stringify(staleCommit.body));
  assert.equal(staleCommit.body.error, "file_version_precondition_failed");
  /* The stale writer took version 2, so the winner is version 3 and that is
   * what current_version reads when the stale commit is judged. */
  assert.equal(Number(winnerCommit.body.version_n), 3);
  assert.match(String(staleCommit.body.message), /at version 3/);
  assert.match(String(staleCommit.body.message), /required version 1/);
});
