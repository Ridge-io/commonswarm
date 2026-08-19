/**
 * set_agent_model against the served command function and real Postgres —
 * the HUMAN mirror of agent-model-declare.test.ts. The gate under test is
 * revoke_agent_principal's convention: owner/admin relabel any principal in
 * the workspace, a plain member only their own; agents are refused on this
 * kind outright (they have declare_agent_model for themselves).
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

interface SetFixture {
  workspace: string;
  ownerId: string;
  ownerJwt: string;
  memberId: string;
  memberJwt: string;
  /** Owned by the plain member. */
  principalMember: string;
  /** Owned by the workspace owner. */
  principalOwner: string;
  /** A live token for principalMember, for the agent-refusal control. */
  agentToken: string;
}

let f: SetFixture;

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

async function setFixture(): Promise<SetFixture> {
  const owner = await createUser("set-owner");
  const member = await createUser("set-member");
  const workspace = randomUUID();
  const device = randomUUID();
  const principalMember = randomUUID();
  const principalOwner = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${owner.id}::uuid, 'SetOwner'),
        (${member.id}::uuid, 'SetMember')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${member.id}::uuid, 'set-tests')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'SetWS', ${owner.id}::uuid)
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
        (${principalMember}::uuid, ${workspace}::uuid, ${member.id}::uuid, 'set-member-agent'),
        (${principalOwner}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'set-owner-agent')
    `;
    const run = randomUUID();
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principalMember}::uuid, ${device}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id
      ) VALUES (
        ${randomUUID()}::uuid, ${principalMember}::uuid, ${run}::uuid,
        ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(agentToken).digest()},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  });
  return {
    workspace,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    memberId: member.id,
    memberJwt: member.jwt,
    principalMember,
    principalOwner,
    agentToken,
  };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-set-model-env-"));
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
   * probe, kong swaps runtimes mid-suite, and every request 502s ("An invalid
   * response was received from the upstream server") — measured on the
   * declare→set adjacency, where this file's own log never got past "Setting
   * up Edge Functions runtime...". Our stdout is unambiguously ours, so wait
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
  f = await setFixture();
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

async function setModel(
  jwt: string,
  principalId: string,
  model: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: randomUUID(),
      client_version: "0.1.0",
      workspace_id: f.workspace,
      stream: { kind: "workspace" },
      command: { kind: "set_agent_model", principal_id: principalId, model },
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body };
}

async function models(): Promise<Record<string, string | null>> {
  const rows = await sql<{ principal_id: string; model: string | null }[]>`
    SELECT principal_id, model
    FROM swarm.agent_principals
    WHERE workspace_id = ${f.workspace}::uuid
  `;
  return Object.fromEntries(rows.map((row) => [row.principal_id, row.model]));
}

test("S1 the workspace owner relabels a MEMBER-owned agent; the audit names the human", async () => {
  const result = await setModel(f.ownerJwt, f.principalMember, "gpt-5");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const byId = await models();
  assert.equal(byId[f.principalMember], "gpt-5");
  assert.equal(byId[f.principalOwner], null);
  // Attribution: the accepted audit row carries the HUMAN and no principal —
  // a human set must be distinguishable from an agent self-declaration.
  const audit = await sql<
    { actor_user: string | null; actor_agent_principal: string | null }[]
  >`
    SELECT actor_user, actor_agent_principal
    FROM swarm.audit_log
    WHERE workspace_id = ${f.workspace}::uuid
      AND command_kind = 'set_agent_model'
      AND outcome = 'accepted'
    ORDER BY occurred_at DESC
    LIMIT 1
  `;
  assert.equal(audit[0]?.actor_user, f.ownerId);
  assert.equal(audit[0]?.actor_agent_principal, null);
});

test("S2 a plain member cannot relabel someone ELSE'S agent, but can their own", async () => {
  const refused = await setModel(f.memberJwt, f.principalOwner, "gemini");
  assert.equal(refused.status, 200, JSON.stringify(refused.body));
  assert.equal(refused.body.status, "rejected");
  assert.equal(refused.body.reason, "principal_not_owned");
  const allowed = await setModel(f.memberJwt, f.principalMember, "claude");
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.status, "accepted");
  const byId = await models();
  assert.equal(byId[f.principalOwner], null);
  assert.equal(byId[f.principalMember], "claude");
});

test("S2b the UNCHANGED-value probe is refused for someone else's agent (both arms' finding)", async () => {
  // The fast-path used to answer `accepted` before the ownership gate, so a plain
  // member could confirm another member's agent existed and probe its current model
  // by submitting the value it already had. The fast path now requires the caller
  // to pass the reducer's exact gate; an unauthorized unchanged submit falls through
  // to the reducer and gets its refusal, indistinguishable from a changed one.
  const current = (await models())[f.principalOwner];
  const refused = await setModel(f.memberJwt, f.principalOwner, current);
  assert.equal(refused.status, 200);
  assert.equal(refused.body.status, "rejected");
  assert.equal(refused.body.reason, "principal_not_owned");
  assert.notEqual(refused.body.unchanged, true, "must not leak the unchanged fast-path shape");
});

test("S3 an agent token is refused on this kind", async () => {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.agentToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: randomUUID(),
      client_version: "0.1.0",
      workspace_id: f.workspace,
      stream: { kind: "workspace" },
      command: {
        kind: "set_agent_model",
        principal_id: f.principalMember,
        model: "self-promotion",
      },
    }),
  });
  assert.equal(response.status, 403);
  await response.json();
  const byId = await models();
  assert.equal(byId[f.principalMember], "claude");
});

test("S4 an unchanged set is an accepted no-op appending nothing", async () => {
  const eventsBefore = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.events
    WHERE workspace_id = ${f.workspace}::uuid
  `;
  const result = await setModel(f.ownerJwt, f.principalMember, "claude");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.unchanged, true);
  assert.deepEqual(result.body.event_ids, []);
  const eventsAfter = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.events
    WHERE workspace_id = ${f.workspace}::uuid
  `;
  assert.equal(eventsBefore[0]?.n, eventsAfter[0]?.n);
});

test("S5 empty clears, and the wire refuses an over-bound value", async () => {
  const cleared = await setModel(f.ownerJwt, f.principalMember, "");
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const byId = await models();
  assert.equal(byId[f.principalMember], null);
  const over = await setModel(f.ownerJwt, f.principalMember, "x".repeat(121));
  assert.equal(over.status, 400, JSON.stringify(over.body));
});
