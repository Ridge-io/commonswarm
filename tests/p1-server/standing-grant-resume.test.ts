/**
 * `resume_renewal_grant` against the SERVED command function and real Postgres.
 *
 * WHY THIS FILE HAD TO EXIST. The resume path shipped with two suites around it and neither
 * could see it fail. tests/p1-local/standing-grants-postgres.test.ts drives
 * swarm.resume_renewal_grant directly, so it never runs the edge handler that reads the
 * function's return value. tests/p1-cli/standing-grants.test.ts drives `cswarm grant resume`
 * against a fake HTTP server that answers 200 with a stuffed `resumed_at` no matter what was
 * asked — so it asserted the CLI's own printing, and a handler that refused every resume would
 * have kept it green.
 *
 * What the gap hid: the handler read the outcome as
 * `outcomeRows[0]?.resume_outcome ?? "renewal_resume_forbidden"`. NULL is the SUCCESS value
 * (migration 20260904000001:614), `??` cannot tell it from a missing row, so every resume was
 * refused with 403 — while the UPDATE it had already made COMMITTED, because `refuse` returns
 * inside `db.begin` rather than throwing. The second call then answered
 * `renewal_grant_not_suspended`, describing a resume the caller had been told did not happen.
 * R1 below is red on that code; R2 is what made the split-brain visible.
 *
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**; serial via
 * --test-concurrency=1 because each file owns the one local runtime). Needs local Supabase
 * with migration 20260904000001 applied: `npm run db:start && npm run db:migrate`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
    parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY,
  );
  return parsed as LocalEnvironment;
}

interface ResumeFixture {
  workspace: string;
  ownerId: string;
  ownerJwt: string;
  strangerJwt: string;
  principal: string;
  run: string;
  /** Standing, suspended, resumable. */
  suspendedGrant: string;
  /** Standing, never suspended — the not-suspended control. */
  liveGrant: string;
}

let f: ResumeFixture;

async function createUser(label: string): Promise<{ id: string; jwt: string }> {
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

async function resumeFixture(): Promise<ResumeFixture> {
  const owner = await createUser("resume-owner");
  const stranger = await createUser("resume-stranger");
  const workspace = randomUUID();
  const device = randomUUID();
  const principal = randomUUID();
  const run = randomUUID();
  const suspendedGrant = randomUUID();
  const liveGrant = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${owner.id}::uuid, 'ResumeOwner'),
        (${stranger.id}::uuid, 'ResumeStranger')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'resume-tests')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'ResumeWS', ${owner.id}::uuid)
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
      INSERT INTO swarm.agent_principals (principal_id, workspace_id, name, owner_user_id)
      VALUES (${principal}::uuid, ${workspace}::uuid, 'resume-agent', ${owner.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)
    `;
    /* Standing shape: horizon and ceiling both NULL, which renewal_grants_kind_shape
       requires. suspended_at is stamped directly rather than by waiting 14 days. */
    await tx`
      INSERT INTO swarm.renewal_grants (
        renewal_grant_id, workspace_id, principal_id, run_id,
        kind, max_successors, successors_used, horizon_expires_at,
        bound_device_id, created_by, suspended_at
      ) VALUES (
        ${suspendedGrant}::uuid, ${workspace}::uuid, ${principal}::uuid, ${run}::uuid,
        'standing', NULL, 0, NULL,
        ${device}::uuid, ${owner.id}::uuid, now() - interval '1 hour'
      )
    `;
    await tx`
      INSERT INTO swarm.renewal_grants (
        renewal_grant_id, workspace_id, principal_id, run_id,
        kind, max_successors, successors_used, horizon_expires_at,
        bound_device_id, created_by
      ) VALUES (
        ${liveGrant}::uuid, ${workspace}::uuid, ${principal}::uuid, ${run}::uuid,
        'standing', NULL, 0, NULL,
        ${device}::uuid, ${owner.id}::uuid
      )
    `;
  });
  return {
    workspace,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    strangerJwt: stranger.jwt,
    principal,
    run,
    suspendedGrant,
    liveGrant,
  };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  /* The migration under test must actually be in the database. Without this the fixture's
     INSERT fails on a missing column and every assertion below would be about the wrong
     thing — a negative result that never reached the path it claims to test. */
  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'swarm' AND table_name = 'renewal_grants'
      AND column_name = 'suspension_active'
  `;
  assert.equal(
    columns.length,
    1,
    "migration 20260904000001 is not applied locally; run `npm run db:migrate`",
  );
  envDir = mkdtempSync(join(tmpdir(), "cswarm-resume-env-"));
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
  /* Wait for OUR boot banner before the HTTP probe: at a file seam the previous file's
     still-answering runtime satisfies the probe and kong then swaps mid-suite. */
  {
    const bootDeadline = Date.now() + 60_000;
    while (!functionLogs.includes("Serving functions on")) {
      if (Date.now() > bootDeadline) {
        throw new Error(`functions serve never booted:\n${functionLogs.slice(-3000)}`);
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
  f = await resumeFixture();
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      functionProcess.once("close", () => resolve(true));
    });
    functionProcess.kill();
    const stopped = await Promise.race([exited, delay(2_000).then(() => false)]);
    if (!stopped && functionProcess.exitCode === null) {
      functionProcess.kill("SIGKILL");
    }
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});

async function resume(
  jwt: string,
  renewalGrantId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify({
      command_id: randomUUID(),
      client_version: "0.1.0",
      workspace_id: f.workspace,
      stream: { kind: "workspace" },
      command: { kind: "resume_renewal_grant", renewal_grant_id: renewalGrantId },
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body };
}

async function grantRow(id: string) {
  const rows = await sql<{
    suspended_at: Date | null;
    resumed_at: Date | null;
    resumed_by: string | null;
    resume_count: number;
    suspension_active: boolean;
  }[]>`
    SELECT suspended_at, resumed_at, resumed_by, resume_count, suspension_active
    FROM swarm.renewal_grants WHERE renewal_grant_id = ${id}::uuid
  `;
  assert.ok(rows[0], "grant row must exist");
  return rows[0]!;
}

async function lastAudit(): Promise<{ outcome: string; reason: string | null }> {
  const rows = await sql<{ outcome: string; reason: string | null }[]>`
    SELECT outcome, reason
    FROM swarm.audit_log
    WHERE workspace_id = ${f.workspace}::uuid
      AND command_kind = 'resume_renewal_grant'
    ORDER BY occurred_at DESC
    LIMIT 1
  `;
  assert.ok(rows[0], "the resume must leave an audit row");
  return rows[0]!;
}

test("R1 an owner resumes a suspended standing grant and is TOLD it happened", async () => {
  const before = await grantRow(f.suspendedGrant);
  assert.equal(before.suspension_active, true, "the fixture must start paused");

  const result = await resume(f.ownerJwt, f.suspendedGrant);

  /* The assertion the shipped handler failed. NULL is success from
     swarm.resume_renewal_grant; a `??` that turns it into a refusal string answers 403 here
     while still committing the UPDATE checked below. */
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, "accepted", JSON.stringify(result.body));
  assert.equal(result.body.renewal_grant_id, f.suspendedGrant);
  assert.equal(typeof result.body.resumed_at, "string");

  const after = await grantRow(f.suspendedGrant);
  assert.equal(after.suspension_active, false, "the grant is no longer paused");
  assert.equal(after.resume_count, 1);
  assert.equal(after.resumed_by, f.ownerId);
  assert.ok(after.resumed_at instanceof Date);
  /* The lapse stays readable: suspended_at is never cleared, which is why
     suspension_active — not this column — is the definition of "paused right now". */
  assert.ok(after.suspended_at instanceof Date, "the suspension that happened stays on the row");

  const audit = await lastAudit();
  assert.equal(audit.outcome, "accepted");
  assert.equal(audit.reason, null);
});

test("R2 a second resume is refused as not-suspended, and changes nothing", async () => {
  /* THE CONTROL THAT MADE THE SPLIT-BRAIN VISIBLE. On the shipped handler R1 answered 403
     and this call answered `renewal_grant_not_suspended` — the state after a resume the
     caller had been told did not happen. Here it is the ordinary second call. */
  const before = await grantRow(f.suspendedGrant);
  const result = await resume(f.ownerJwt, f.suspendedGrant);
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.error, "forbidden");

  const audit = await lastAudit();
  assert.equal(audit.outcome, "authz");
  assert.equal(
    audit.reason,
    "renewal_resume_renewal_grant_not_suspended",
    "the operator gets the distinction the caller is deliberately denied",
  );

  const after = await grantRow(f.suspendedGrant);
  assert.equal(after.resume_count, before.resume_count, "a refusal must not resume");
  assert.deepEqual(after.resumed_at, before.resumed_at);
});

test("R3 a grant that was never suspended is refused the same way", async () => {
  const result = await resume(f.ownerJwt, f.liveGrant);
  assert.equal(result.status, 403, JSON.stringify(result.body));
  const audit = await lastAudit();
  assert.equal(audit.reason, "renewal_resume_renewal_grant_not_suspended");
  const after = await grantRow(f.liveGrant);
  assert.equal(after.resume_count, 0);
  assert.equal(after.resumed_at, null);
});

test("R4 a non-member cannot resume, and the refusal is indistinguishable", async () => {
  /* The existence oracle matters more now that resume is reachable: a stranger must not be
     able to tell a grant they may not touch from one that does not exist.
     MEASURED, not assumed: this test first expected the audit reason
     `renewal_resume_renewal_grant_not_found`, i.e. that a stranger reaches
     swarm.resume_renewal_grant and is refused by its membership read. They do not. A caller
     with no membership in this workspace is refused by the route before the handler runs, and
     the audit reason is a bare `forbidden`. That is a STRONGER property than the one assumed,
     so it is what is pinned — but it also means the SQL function's own membership arm is not
     exercised from here, and tests/p1-local covers it directly. */
  const before = await grantRow(f.suspendedGrant);
  const stranger = await resume(f.strangerJwt, f.suspendedGrant);
  assert.equal(stranger.status, 403, JSON.stringify(stranger.body));
  assert.equal(stranger.body.error, "forbidden");
  const strangerAudit = await lastAudit();
  assert.equal(strangerAudit.outcome, "authz");
  assert.notEqual(
    strangerAudit.reason,
    "renewal_resume_renewal_grant_not_suspended",
    "a stranger must not learn the grant's suspension state",
  );

  const absent = await resume(f.strangerJwt, randomUUID());
  assert.equal(absent.status, 403);
  assert.deepEqual(absent.body, stranger.body, "the wire cannot tell the two apart");

  const after = await grantRow(f.suspendedGrant);
  assert.equal(after.resume_count, before.resume_count, "a stranger changes nothing");
});
