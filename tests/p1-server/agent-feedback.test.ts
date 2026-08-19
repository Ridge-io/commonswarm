/**
 * submit_feedback against the served command function and real Postgres.
 * The claims under test: BOTH credential kinds may submit (the agent token
 * here carries only ["post_signal"] scopes — acceptance is the scope-gate
 * exemption working, not a scope match); attribution is derived from the
 * presenting credential; an exact duplicate within the hour is an accepted
 * no-op that neither writes a row nor charges the rate bucket; the hourly
 * bucket refuses the eleventh distinct submission; wire bounds refuse
 * oversize context and hidden control characters before anything runs.
 *
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**; serial via
 * --test-concurrency=1 because each file owns the one local runtime).
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

interface FeedbackFixture {
  workspace: string;
  memberId: string;
  memberJwt: string;
  /** Owned by the plain member; its token's scopes are ["post_signal"] only. */
  principal: string;
  agentToken: string;
}

let f: FeedbackFixture;

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

async function feedbackFixture(): Promise<FeedbackFixture> {
  const owner = await createUser("fb-owner");
  const member = await createUser("fb-member");
  const workspace = randomUUID();
  const device = randomUUID();
  const principal = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${owner.id}::uuid, 'FbOwner'),
        (${member.id}::uuid, 'FbMember')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${member.id}::uuid, 'fb-tests')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'FbWS', ${owner.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${workspace}::uuid, ${owner.id}::uuid, 'owner'),
        (${workspace}::uuid, ${member.id}::uuid, 'member')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES
        (${principal}::uuid, ${workspace}::uuid, ${member.id}::uuid, 'fb-agent')
    `;
    const run = randomUUID();
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)
    `;
    /* Deliberately ["post_signal"] and NOT "submit_feedback": tokens minted
     * before this command existed cannot carry the new scope, so acceptance
     * below is the class exemption in the scope gate, measured. */
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id
      ) VALUES (
        ${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid,
        ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(agentToken).digest()},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  });
  return {
    workspace,
    memberId: member.id,
    memberJwt: member.jwt,
    principal,
    agentToken,
  };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-feedback-env-"));
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
  /* The HTTP probe below cannot tell OUR serve from the previous test file's
   * still-answering zombie: at the file seam the old instance satisfies the
   * probe, kong swaps runtimes mid-suite, and every request 502s — measured
   * on the declare→set adjacency. Our stdout is unambiguously ours, so wait
   * for OUR boot banner first; only then is the HTTP probe meaningful. */
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
  f = await feedbackFixture();
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

async function submit(
  bearer: string,
  body: string,
  options: {
    category?: "bug" | "idea" | "friction";
    context?: unknown;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const command: Record<string, unknown> = {
    kind: "submit_feedback",
    feedback_id: randomUUID(),
    category: options.category ?? "bug",
    body,
  };
  if ("context" in options) command.context = options.context;
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: randomUUID(),
      client_version: "0.1.0",
      workspace_id: f.workspace,
      stream: { kind: "workspace" },
      command,
    }),
  });
  const parsed = await response.json() as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

interface FeedbackRow {
  reporter_kind: string;
  reporter_id: string;
  category: string;
  body: string;
  context: Record<string, string> | null;
}

async function rowsFor(body: string): Promise<FeedbackRow[]> {
  return await sql<FeedbackRow[]>`
    SELECT reporter_kind, reporter_id, category, body, context
    FROM swarm.feedback
    WHERE workspace_id = ${f.workspace}::uuid AND body = ${body}
  `;
}

const AGENT_BODY = "the listener said ready but the socket path was stale";

test("an agent token with only post_signal scope submits; the row carries its principal", async () => {
  const result = await submit(f.agentToken, AGENT_BODY, {
    category: "friction",
    context: { surface: "test", cswarm_version: "0.0.0-test" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, "accepted");
  const rows = await rowsFor(AGENT_BODY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reporter_kind, "agent");
  assert.equal(rows[0].reporter_id, f.principal);
  assert.equal(rows[0].category, "friction");
  assert.deepEqual(rows[0].context, {
    surface: "test",
    cswarm_version: "0.0.0-test",
  });
});

test("a human member submits; attribution is the user", async () => {
  const body = "the dashboard needs a feedback inbox";
  const result = await submit(f.memberJwt, body, { category: "idea" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const rows = await rowsFor(body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reporter_kind, "user");
  assert.equal(rows[0].reporter_id, f.memberId);
  assert.equal(rows[0].context, null);
});

test("an exact duplicate within the hour is acknowledged and writes nothing", async () => {
  const result = await submit(f.agentToken, AGENT_BODY, {
    category: "friction",
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, "accepted");
  assert.equal(result.body.duplicate, true);
  const rows = await rowsFor(AGENT_BODY);
  assert.equal(rows.length, 1);
});

test("oversize context is refused at the wire and writes nothing", async () => {
  const body = "context bounds probe";
  const result = await submit(f.agentToken, body, {
    context: { note: "v".repeat(513) },
  });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.error, "invalid_request");
  assert.equal((await rowsFor(body)).length, 0);
});

test("hidden control characters in the body are refused at the wire", async () => {
  const body = "bell\u0007inside";
  const result = await submit(f.memberJwt, body);
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.error, "invalid_request");
  assert.equal((await rowsFor(body)).length, 0);
});

test("the eleventh distinct submission in an hour is rate-limited", async () => {
  /* The agent has been charged once so far (the first accepted submission);
   * the duplicate ack and the two wire refusals charge nothing — this
   * arithmetic is itself the assertion that they don't. Nine more distinct
   * bodies reach the limit of 10; the eleventh distinct submission refuses. */
  for (let i = 1; i <= 9; i++) {
    const result = await submit(f.agentToken, `rate probe ${i}`);
    assert.equal(result.status, 200, `probe ${i}: ${JSON.stringify(result.body)}`);
    assert.notEqual(result.body.duplicate, true);
  }
  const refused = await submit(f.agentToken, "rate probe 10 — one past the limit");
  assert.equal(refused.status, 429, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "rate_limited");
  const count = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.feedback
    WHERE workspace_id = ${f.workspace}::uuid
      AND reporter_id = ${f.principal}::uuid
  `;
  assert.equal(count[0].n, "10");
});
