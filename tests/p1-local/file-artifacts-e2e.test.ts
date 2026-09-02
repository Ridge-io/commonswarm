/**
 * S4 end-to-end storage proof (docs/design/2026-08-18-FILE-ARTIFACTS.md §11).
 *
 * Reached ONLY by `npm run test:p1-local`, which names this file literally and
 * runs with --test-concurrency=1 because each p1-local file spawns the one
 * local functions runtime. Needs the exclusive DB slot.
 *
 * What this file exists to prove that p1-server's F1 cannot: the parts of the
 * lifecycle that only REAL storage plus REAL time manipulation exercise —
 * the size-lie-low refusal, the pre-commit second PUT, and above all the
 * purge pipeline: pg_cron's SQL claim queues object paths, and the command
 * function's S4 drain deletes the objects through the Storage API. Before this
 * file, `drainFilePurgeQueue` had no test and the queue had no consumer.
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

interface Fixture {
  workspaceId: string;
  userId: string;
  agentToken: string;
}

let f: Fixture;

async function fixture(): Promise<Fixture> {
  const email = `s4-${randomUUID()}@example.test`;
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
  const device = randomUUID();
  const principal = randomUUID();
  const run = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(agentToken).digest();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${userId}::uuid, 'S4User')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${userId}::uuid, 's4-e2e')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspaceId}::uuid, 'S4E2E', ${userId}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}::uuid, ${userId}::uuid, 'owner')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${workspaceId}::uuid, 'workspace')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${principal}::uuid, ${workspaceId}::uuid, ${userId}::uuid, 's4-worker'
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
        ${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid,
        ${tx.json(["post_signal"])}::jsonb, ${tokenHash},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  });
  return { workspaceId, userId, agentToken };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-s4-env-"));
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
  f = await fixture();
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
  command: Record<string, unknown>,
  commandId: string = randomUUID(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.agentToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: commandId,
      client_version: "0.1.0",
      workspace_id: f.workspaceId,
      stream: { kind: "workspace" },
      command,
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body };
}

async function probeStorageDelete(
  path: string,
): Promise<{ ready: boolean; state: string }> {
  try {
    const response = await fetch(
      `${local.API_URL}/storage/v1/object/swarm-files`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${local.SERVICE_ROLE_KEY}`,
          apikey: local.SERVICE_ROLE_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prefixes: [path] }),
        signal: AbortSignal.timeout(1_000),
      },
    );
    return {
      ready: response.ok || response.status === 404,
      state: `HTTP ${response.status}`,
    };
  } catch {
    return { ready: false, state: "request failed" };
  }
}

function sha256hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createAndUpload(
  name: string,
  bytes: Uint8Array,
  declared: number = bytes.length,
): Promise<{ fileId: string; versionId: string; uploadUrl: string }> {
  const fileId = randomUUID();
  const versionId = randomUUID();
  const create = await postCommand({
    kind: "file_version_create",
    file_id: fileId,
    version_id: versionId,
    name,
    declared_size_bytes: declared,
    content_type: "text/markdown",
  });
  assert.equal(create.status, 200, JSON.stringify(create.body));
  const uploadUrl = `${local.API_URL}${create.body.upload_path as string}`;
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: new Blob([Uint8Array.from(bytes)]),
  });
  assert.ok(put.ok, `upload PUT failed: ${put.status}`);
  return { fileId, versionId, uploadUrl };
}

const BYTES = new TextEncoder().encode("# s4 e2e\n\nreal bytes, real storage\n");

test("SA-local schema keeps both attachment foreign keys tenant-honest and rows immutable", async () => {
  const constraints = await sql<{ definition: string }[]>`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'swarm.signal_attachments'::regclass
  `;
  const definitions = constraints.map((row) => row.definition).join("\n");
  assert.match(definitions, /FOREIGN KEY \(signal_id, workspace_id\)/);
  assert.match(definitions, /FOREIGN KEY \(file_id, workspace_id, version_n\)/);
  assert.match(definitions, /position.*0.*7/i);
  const triggers = await sql<{ trigger_name: string }[]>`
    SELECT trigger_name
    FROM information_schema.triggers
    WHERE event_object_schema = 'swarm'
      AND event_object_table = 'signal_attachments'
      AND event_manipulation IN ('INSERT', 'UPDATE', 'DELETE')
  `;
  assert.deepEqual(
    new Set(triggers.map((row) => row.trigger_name)),
    new Set([
      "signal_attachments_append_only",
      "signal_attachments_same_transaction",
    ]),
  );
  const guards = await sql<{ definition: string }[]>`
    SELECT pg_get_functiondef('swarm.require_new_signal_for_attachment()'::regprocedure)
      AS definition
  `;
  assert.match(guards[0]?.definition ?? "", /signal\.xmin[\s\S]*pg_current_xact_id/);
});

test("S4-1 size lie low: an object larger than its declaration is refused at commit", async () => {
  const big = new TextEncoder().encode("x".repeat(64));
  const { fileId, versionId } = await createAndUpload("liar.md", big, 10);
  const commit = await postCommand({
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
    sha256: sha256hex(big),
  });
  assert.equal(commit.status, 409, JSON.stringify(commit.body));
  assert.equal(commit.body.error, "file_size_exceeds_declaration");
});

test("S4-2 the signed upload capability binds one object: a second pre-commit PUT is refused", async () => {
  const { uploadUrl } = await createAndUpload("single-use.md", BYTES);
  const rePut = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: new Blob([Uint8Array.from(new TextEncoder().encode("second write"))]),
  });
  // upsert is OFF at sign time (★R3): once an object exists at the path, the
  // same capability cannot replace it — before OR after commit.
  assert.ok(
    !rePut.ok,
    `a second PUT through the same capability must fail, got ${rePut.status}`,
  );
});

test("S4-3 purge pipeline end to end: cron claim queues, the drain deletes the REAL object, the name frees", async () => {
  // Commit a real object.
  const { fileId, versionId } = await createAndUpload("doomed.md", BYTES);
  const commit = await postCommand({
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
    sha256: sha256hex(BYTES),
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));

  // The object exists in REAL storage after commit. Checked HERE because no
  // purge-queue row for this path can exist yet, so no drain can race the
  // check. Storage answers 5xx briefly after a container restart (S4-6 in a
  // prior run), so poll to a definitive answer.
  const committedPath = await sql<{ storage_path: string }[]>`
    SELECT storage_path FROM swarm.file_versions
    WHERE file_id = ${fileId}::uuid
  `;
  {
    const deadline = Date.now() + 8_000;
    let ok = false;
    let lastError = "";
    while (Date.now() < deadline) {
      const check = await admin.storage.from("swarm-files").download(
        committedPath[0]!.storage_path,
      );
      if (!check.error) {
        ok = true;
        break;
      }
      lastError = String(check.error);
      await delay(250);
    }
    assert.ok(ok, `object must exist after commit: ${lastError}`);
  }

  // Tombstone it, then age the tombstone past the 30-day window in SQL —
  // the only clock the window reads (review round 2: database time).
  const rm = await postCommand({ kind: "file_tombstone", file_id: fileId });
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  await sql`
    UPDATE swarm.files
    SET tombstoned_at = statement_timestamp() - interval '31 days'
    WHERE file_id = ${fileId}::uuid
  `;

  // Run the cron function body directly, exactly as pg_cron would.
  await sql`SELECT swarm.purge_file_artifacts()`;

  const claimed = await sql<{ state: string; storage_path: string }[]>`
    SELECT state, storage_path FROM swarm.file_versions
    WHERE file_id = ${fileId}::uuid
  `;
  assert.equal(claimed[0]?.state, "purged", "the claim marks the version purged");
  const storagePath = claimed[0]!.storage_path;
  const queued = await sql<{ deleted_at: string | null }[]>`
    SELECT deleted_at FROM swarm.file_purge_queue
    WHERE storage_path = ${storagePath}
  `;
  assert.equal(queued.length, 1, "the claim queued the object path");
  assert.equal(queued[0]!.deleted_at, null, "not yet drained");

  // No pre-drain existence assertion HERE, deliberately: every file command
  // dispatches a detached drain, and the tombstone's drain can execute after
  // the SQL purge above queued this path — deleting the object before this
  // line runs. That is the drain WORKING; racing it is not the claim. The
  // object's existence was asserted post-commit, where no queue row for this
  // path can exist yet, and the end state below is the pipeline proof.

  // Any file command triggers the S4 drain. Restore is convenient: it must
  // ALSO refuse now (410 — the purge claimed the contents), which pins the
  // ★R6 ordering on real data in the same step.
  const restore = await postCommand({ kind: "file_restore", file_id: fileId });
  assert.equal(restore.status, 410, JSON.stringify(restore.body));

  // The drain runs after the command's own transaction; poll briefly.
  const deadline = Date.now() + 5_000;
  let drained = false;
  while (Date.now() < deadline) {
    const row = await sql<{ deleted_at: string | null }[]>`
      SELECT deleted_at FROM swarm.file_purge_queue
      WHERE storage_path = ${storagePath}
    `;
    if (row[0]?.deleted_at) {
      drained = true;
      break;
    }
    await delay(100);
  }
  assert.ok(drained, "the drain retires the queue row");

  // The REAL object is gone.
  const postDrain = await admin.storage.from("swarm-files").download(storagePath);
  assert.ok(postDrain.error, "the storage object is deleted");

  // ★partial-index rule: the purged name is reusable.
  const reborn = await postCommand({
    kind: "file_version_create",
    file_id: randomUUID(),
    version_id: randomUUID(),
    name: "doomed.md",
    declared_size_bytes: 10,
    content_type: "text/markdown",
  });
  assert.equal(reborn.status, 200, JSON.stringify(reborn.body));
});

test("S4-4 pending GC: a never-uploaded slot is claimed at 3h and its queue row drains harmlessly", async () => {
  const fileId = randomUUID();
  const versionId = randomUUID();
  const create = await postCommand({
    kind: "file_version_create",
    file_id: fileId,
    version_id: versionId,
    name: "never-uploaded.md",
    declared_size_bytes: 10,
    content_type: "text/markdown",
  });
  assert.equal(create.status, 200, JSON.stringify(create.body));
  // No PUT ever happens. Age the pending row past the 3h sweep (★R15) in SQL.
  await sql`
    UPDATE swarm.file_versions
    SET created_at = statement_timestamp() - interval '4 hours'
    WHERE version_id = ${versionId}::uuid
  `;
  await sql`SELECT swarm.purge_file_artifacts()`;
  const row = await sql<{ state: string; storage_path: string }[]>`
    SELECT state, storage_path FROM swarm.file_versions
    WHERE version_id = ${versionId}::uuid
  `;
  assert.equal(row[0]?.state, "purged", "pending GC claims the slot");
  const storagePath = row[0]!.storage_path;

  // Trigger a drain with an unrelated cheap file command; the queued path has
  // NO object behind it and the drain must retire it anyway (the FileStorage
  // contract removeObjects tolerates absent objects).
  const nudge = await postCommand({
    kind: "file_download_url",
    file_id: fileId,
  });
  // The file's only version is purged; the command refuses — the drain still ran.
  assert.ok(nudge.status >= 400);
  const deadline = Date.now() + 5_000;
  let drained = false;
  while (Date.now() < deadline) {
    const q = await sql<{ deleted_at: string | null }[]>`
      SELECT deleted_at FROM swarm.file_purge_queue
      WHERE storage_path = ${storagePath}
    `;
    if (q[0]?.deleted_at) {
      drained = true;
      break;
    }
    await delay(100);
  }
  assert.ok(drained, "a never-uploaded path drains without error");
});

test("S4-5 batch boundary: one drain retires exactly its bounded batch, the next takes the rest", async () => {
  // Synthetic queue rows under a test prefix — no objects behind them, which
  // the drain tolerates by contract. 12 rows against the batch bound of 10.
  const nudge = () =>
    postCommand({ kind: "file_download_url", file_id: randomUUID() });
  // Quiesce: drains detach via waitUntil, so one dispatched by an EARLIER
  // test can land mid-count here. Drain the leftovers, then hold until the
  // queue stays empty so no straggler can touch this test's rows.
  {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const pending = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM swarm.file_purge_queue
        WHERE deleted_at IS NULL
      `;
      if (Number(pending[0]!.n) === 0) break;
      await nudge();
      await delay(300);
    }
    await delay(500);
  }
  const prefix = `s4-batch-${randomUUID()}`;
  const paths = Array.from({ length: 12 }, (_, i) => `${prefix}/row-${i}.bin`);
  for (const path of paths) {
    await sql`
      INSERT INTO swarm.file_purge_queue (storage_path)
      VALUES (${path})
    `;
  }

  await nudge();
  let firstBatch = 0;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM swarm.file_purge_queue
      WHERE storage_path LIKE ${prefix + "/%"} AND deleted_at IS NOT NULL
    `;
    firstBatch = Number(rows[0]!.n);
    if (firstBatch >= 10) break;
    await delay(100);
  }
  assert.equal(firstBatch, 10, "the first drain retires exactly the batch bound");
  // Boundary stability: hold briefly and confirm no straggler exceeds the
  // bound — exactly 10, not "at least 10 on the way to 12".
  await delay(800);
  const held = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.file_purge_queue
    WHERE storage_path LIKE ${prefix + "/%"} AND deleted_at IS NOT NULL
  `;
  assert.equal(Number(held[0]!.n), 10, "one command drains one bounded batch");

  // Review item 2's success-path half: every drained row records its attempt.
  const stamped = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.file_purge_queue
    WHERE storage_path LIKE ${prefix + "/%"}
      AND deleted_at IS NOT NULL
      AND attempt_count = 1
      AND last_attempt_at IS NOT NULL
  `;
  assert.equal(Number(stamped[0]!.n), 10, "attempts are stamped on success too");

  await nudge();
  const restDeadline = Date.now() + 5_000;
  let drained = 0;
  while (Date.now() < restDeadline) {
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM swarm.file_purge_queue
      WHERE storage_path LIKE ${prefix + "/%"} AND deleted_at IS NOT NULL
    `;
    drained = Number(rows[0]!.n);
    if (drained === 12) break;
    await delay(100);
  }
  assert.equal(drained, 12, "the second drain takes the remaining rows");
});

test("S4-6 storage outage: a failed drain stamps its attempt durably and the row stays eligible", async () => {
  // The only DRIVABLE storage failure: every malformed prefix probed against
  // the local storage API answers 200 (newline, empty string, 3000 chars —
  // measured before writing this test), so the failure branch is driven the
  // honest way — by taking storage DOWN. Last test in the file on purpose:
  // it stops and restarts the storage container.
  // Start from an empty queue. This makes attempt_count = 1 below evidence of
  // this test's one trigger, not a detached drain left by an earlier command.
  let pending = -1;
  const quiesceDeadline = Date.now() + 8_000;
  while (Date.now() < quiesceDeadline) {
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM swarm.file_purge_queue
      WHERE deleted_at IS NULL
    `;
    pending = Number(rows[0]!.n);
    if (pending === 0) break;
    await postCommand({ kind: "file_download_url", file_id: randomUUID() });
    await delay(300);
  }
  assert.equal(pending, 0, "the outage test starts with an empty purge queue");
  await delay(500);
  const stable = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.file_purge_queue
    WHERE deleted_at IS NULL
  `;
  assert.equal(Number(stable[0]!.n), 0, "the empty queue stays quiescent");

  const path = `s4-outage-${randomUUID()}/victim.bin`;
  await sql`
    INSERT INTO swarm.file_purge_queue (storage_path) VALUES (${path})
  `;
  const storageContainer = "supabase_storage_cloud-swarm";
  execFileSync("docker", ["stop", storageContainer], {
    stdio: "ignore",
  });
  try {
    const running = execFileSync(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", storageContainer],
      { encoding: "utf8" },
    ).trim();
    assert.equal(running, "false", "the outage control stopped Storage");
    const outageProbe = await probeStorageDelete(
      `s4-outage-control-${randomUUID()}/absent.bin`,
    );
    assert.ok(
      !outageProbe.ready,
      `the Storage DELETE must be unavailable before the failed drain runs: ${outageProbe.state}`,
    );
    await postCommand({ kind: "file_download_url", file_id: randomUUID() });
    const deadline = Date.now() + 8_000;
    let failed:
      | { attempt_count: number; last_error: string | null }
      | null = null;
    while (Date.now() < deadline) {
      const rows = await sql<
        {
          attempt_count: number;
          last_error: string | null;
          deleted_at: string | null;
        }[]
      >`
        SELECT attempt_count, last_error, deleted_at
        FROM swarm.file_purge_queue
        WHERE storage_path = ${path}
      `;
      if (rows[0] && rows[0].attempt_count > 0 && rows[0].deleted_at === null) {
        failed = rows[0];
        break;
      }
      await delay(150);
    }
    assert.ok(failed, "the failed attempt is stamped while the row stays pending");
    assert.equal(failed!.attempt_count, 1, "the outage caused one drain attempt");
    assert.ok(
      typeof failed!.last_error === "string" && failed!.last_error.length > 0,
      "the failure text is recorded durably",
    );
  } finally {
    execFileSync("docker", ["start", storageContainer], {
      stdio: "ignore",
    });
  }
  // docker start returns before object deletion accepts requests. Prove the
  // exact DELETE endpoint is back before spending the one retry trigger.
  const readyDeadline = Date.now() + 15_000;
  let storageReady = false;
  let readinessState = "no response";
  while (Date.now() < readyDeadline) {
    const probe = await probeStorageDelete(
      `s4-ready-control-${randomUUID()}/absent.bin`,
    );
    readinessState = probe.state;
    if (probe.ready) {
      storageReady = true;
      break;
    }
    await delay(100);
  }
  assert.ok(storageReady, `Storage did not recover: ${readinessState}`);

  // Storage is ready: the same row must be claimable again and drain clean.
  await postCommand({ kind: "file_download_url", file_id: randomUUID() });
  const deadline = Date.now() + 8_000;
  let recovered = false;
  while (Date.now() < deadline) {
    const rows = await sql<
      { deleted_at: string | null; last_error: string | null }[]
    >`
      SELECT deleted_at, last_error FROM swarm.file_purge_queue
      WHERE storage_path = ${path}
    `;
    if (rows[0]?.deleted_at) {
      assert.equal(rows[0].last_error, null, "success clears the failure text");
      recovered = true;
      break;
    }
    await delay(150);
  }
  if (!recovered) {
    const diagnostic = await sql<
      {
        attempt_count: number;
        claimed_at: string;
        last_attempt_at: string | null;
        last_error: string | null;
        deleted_at: string | null;
      }[]
    >`
      SELECT attempt_count, claimed_at, last_attempt_at, last_error, deleted_at
      FROM swarm.file_purge_queue
      WHERE storage_path = ${path}
    `;
    assert.fail(
      `a previously failed row did not drain: row=${JSON.stringify(diagnostic[0])}\n` +
        `drain log:\n${functionLogs.slice(-8_000)}`,
    );
  }
});
