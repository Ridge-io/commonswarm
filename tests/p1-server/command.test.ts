import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import {
  reduceTask,
  requestHash,
  upcastEnvelope,
  type Actor,
  type Command,
  type EventEnvelope,
  type TaskState,
} from "../../src/protocol/index.js";

interface LocalEnvironment {
  API_URL: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface Fixture {
  workspaceA: string;
  workspaceB: string;
  streamA: string;
  streamB: string;
  repoB: string;
  ua: string;
  ua2: string;
  ub: string;
  uaJwt: string;
  ua2Jwt: string;
  agentPrincipal: string;
  agentRun: string;
  agentToken: string;
  credentials: Map<string, { kind: "user" | "agent"; id: string; actor: Actor }>;
  firstRequests: Map<string, Command>;
}

interface CommandResponse {
  status: number;
  text: string;
  body: Record<string, unknown>;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";

function localEnvironment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(parsed.API_URL && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  return parsed as LocalEnvironment;
}

async function waitForFunction(): Promise<void> {
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
      // The runtime is still booting.
    }
    await delay(200);
  }
  throw new Error(`command function did not become ready:\n${functionLogs.slice(-4000)}`);
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 10 });
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
  await waitForFunction();
});

after(async () => {
  functionProcess?.kill("SIGINT");
  await sql?.end({ timeout: 5 });
});

async function createUser(label: string): Promise<{ id: string; jwt: string }> {
  const nonce = randomUUID();
  const email = `${label}-${nonce}@example.test`;
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
  return {
    id: created.data.user.id,
    jwt: signedIn.data.session.access_token,
  };
}

async function fixture(): Promise<Fixture> {
  const [ua, ua2, ub] = await Promise.all([
    createUser("ua"),
    createUser("ua2"),
    createUser("ub"),
  ]);
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const streamA = randomUUID();
  const workspaceStreamB = randomUUID();
  const streamB = randomUUID();
  const installationB = randomUUID();
  const repoB = randomUUID();
  const device = randomUUID();
  const agentPrincipal = randomUUID();
  const agentRun = randomUUID();
  const tokenId = randomUUID();
  const lineageId = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  assert.equal(agentToken.length, 51);
  const tokenHash = createHash("sha256").update(agentToken).digest();

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${ua.id}::uuid, 'UA'),
        (${ua2.id}::uuid, 'UA2'),
        (${ub.id}::uuid, 'UB')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${ua.id}::uuid, 'integration-agent')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES
        (${workspaceA}::uuid, 'A', ${ua.id}::uuid),
        (${workspaceB}::uuid, 'B', ${ub.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${workspaceA}::uuid, ${ua.id}::uuid, 'owner'),
        (${workspaceA}::uuid, ${ua2.id}::uuid, 'member'),
        (${workspaceB}::uuid, ${ub.id}::uuid, 'owner')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES
        (${streamA}::uuid, ${workspaceA}::uuid, 'workspace'),
        (${workspaceStreamB}::uuid, ${workspaceB}::uuid, 'workspace')
    `;
    await tx`
      INSERT INTO swarm.github_installations (
        installation_row_id, workspace_id, github_installation_id
      ) VALUES (
        ${installationB}::uuid,
        ${workspaceB}::uuid,
        ${(BigInt(Date.now()) * 10_000n + BigInt(randomBytes(2).readUInt16BE())).toString()}
      )
    `;
    await tx`
      INSERT INTO swarm.repositories (
        repo_mapping_id, workspace_id, github_repository_id,
        installation_row_id, full_name, default_branch,
        landing_authority_user_id
      ) VALUES (
        ${repoB}::uuid,
        ${workspaceB}::uuid,
        ${(BigInt(Date.now()) * 10_000n + BigInt(randomBytes(2).readUInt16BE())).toString()},
        ${installationB}::uuid,
        'example/repo',
        'main',
        ${ub.id}::uuid
      )
    `;
    await tx`
      INSERT INTO swarm.streams (
        stream_id, workspace_id, kind, repo_mapping_id
      ) VALUES (
        ${streamB}::uuid, ${workspaceB}::uuid, 'repo', ${repoB}::uuid
      )
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${agentPrincipal}::uuid, ${workspaceA}::uuid, ${ua.id}::uuid, 'worker'
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
        ${tokenId}::uuid,
        ${agentPrincipal}::uuid,
        ${agentRun}::uuid,
        ${tx.json([
          "create",
          "acquire",
          "renew",
          "handoff",
          "takeover",
          "submit",
          "close",
          "reopen",
        ])}::jsonb,
        ${tokenHash},
        statement_timestamp() + interval '1 hour',
        ${lineageId}::uuid
      )
    `;
  });

  return {
    workspaceA,
    workspaceB,
    streamA,
    streamB,
    repoB,
    ua: ua.id,
    ua2: ua2.id,
    ub: ub.id,
    uaJwt: ua.jwt,
    ua2Jwt: ua2.jwt,
    agentPrincipal,
    agentRun,
    agentToken,
    credentials: new Map([
      [ua.jwt, {
        kind: "user",
        id: ua.id,
        actor: { user: ua.id, agent_principal: null, run: null },
      }],
      [ua2.jwt, {
        kind: "user",
        id: ua2.id,
        actor: { user: ua2.id, agent_principal: null, run: null },
      }],
      [agentToken, {
        kind: "agent",
        id: agentPrincipal,
        actor: {
          user: ua.id,
          agent_principal: agentPrincipal,
          run: agentRun,
        },
      }],
    ]),
    firstRequests: new Map(),
  };
}

function commandId(label: string): string {
  return `${label}_${randomBytes(8).toString("hex")}`;
}

async function issue(
  f: Fixture,
  token: string,
  command: Command,
  id = commandId(command.kind),
  extras: Record<string, unknown> = {},
  workspaceId = f.workspaceA,
  stream: Record<string, unknown> = { kind: "workspace" },
): Promise<CommandResponse> {
  const credential = f.credentials.get(token);
  assert.ok(credential, "test credential is registered");
  const ledgerKey = `${credential.kind}:${credential.id}:${id}`;
  if (!f.firstRequests.has(ledgerKey)) f.firstRequests.set(ledgerKey, command);
  const requestBody = {
    command_id: id,
    client_version: "0.1.0",
    workspace_id: workspaceId,
    stream,
    command,
    ...extras,
  };
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

function stored(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ["ok", "reason", "detail", "class", "event_ids"]
      .filter((key) => Object.hasOwn(body, key))
      .map((key) => [key, body[key]]),
  );
}

function dbTaskState(row: Record<string, unknown>): TaskState {
  const submission = row.submission as TaskState["submission"];
  return {
    task_id: String(row.task_id),
    slug: String(row.slug),
    lifecycle: row.lifecycle as TaskState["lifecycle"],
    version: Number(row.version),
    epoch: Number(row.epoch),
    owner: row.owner === null ? null : String(row.owner),
    lease_expiry: row.lease_expiry instanceof Date
      ? row.lease_expiry.getTime()
      : null,
    submission: submission === null
      ? null
      : {
        epoch: Number(submission.epoch),
        branch: submission.branch,
        head_sha: submission.head_sha,
        evidence_set: [...submission.evidence_set],
      },
    closed_disposition: row.closed_disposition === null
      ? null
      : String(row.closed_disposition),
  };
}

async function assertInvariants(f: Fixture): Promise<void> {
  const workspaces = [f.workspaceA, f.workspaceB];
  const events = await sql<Record<string, unknown>[]>`
    SELECT e.*
    FROM swarm.events AS e
    WHERE e.workspace_id = ANY(${workspaces}::uuid[])
    ORDER BY e.stream_id, e.seq
  `;
  const tasks = await sql<Record<string, unknown>[]>`
    SELECT t.*
    FROM swarm.tasks AS t
    WHERE t.workspace_id = ANY(${workspaces}::uuid[])
    ORDER BY t.stream_id, t.task_id
  `;

  // I1: one task fold per payload task_id. History-only initial rejections do
  // not synthesize a task, matching the adapter rule approved for step 12.
  const folded = new Map<string, TaskState>();
  for (const row of events) {
    const payload = row.payload as Record<string, unknown>;
    const taskId = String(payload.task_id);
    const key = `${String(row.stream_id)}:${taskId}`;
    const event = upcastEnvelope({
      workspace_id: String(row.workspace_id),
      stream_id: String(row.stream_id),
      seq: Number(row.seq),
      event_id: String(row.event_id),
      command_id: String(row.command_id),
      type: String(row.type) as EventEnvelope["type"],
      schema_version: Number(row.schema_version),
      actor_user: row.actor_user === null ? null : String(row.actor_user),
      actor_agent_principal: row.actor_agent_principal === null
        ? null
        : String(row.actor_agent_principal),
      actor_run: row.actor_run === null ? null : String(row.actor_run),
      occurred_at_server: (row.occurred_at_server as Date).getTime(),
      payload,
    }) as unknown as EventEnvelope;
    const previous = folded.get(key) ?? null;
    if (previous === null && event.type === "CommandRejected") continue;
    folded.set(key, reduceTask(previous, event));
  }
  const actual = new Map(
    tasks.map((row) => [
      `${String(row.stream_id)}:${String(row.task_id)}`,
      dbTaskState(row),
    ]),
  );
  assert.deepEqual(actual, folded, "I1 projection must equal the event fold");

  // I2: per-stream sequence allocation is contiguous and equals head_seq.
  const streams = await sql<{ stream_id: string; head_seq: string | number }[]>`
    SELECT stream_id, head_seq
    FROM swarm.streams
    WHERE workspace_id = ANY(${workspaces}::uuid[])
  `;
  for (const stream of streams) {
    const seqs = events
      .filter((event) => event.stream_id === stream.stream_id)
      .map((event) => Number(event.seq));
    assert.deepEqual(
      seqs,
      Array.from({ length: seqs.length }, (_, index) => index + 1),
      "I2 event seqs must be gapless",
    );
    assert.equal(Number(stream.head_seq), seqs.length, "I2 head equals event count");
  }

  // I3: tenant columns are pinned to the owning stream.
  const tenantViolations = await sql<{ count: string | number }[]>`
    SELECT count(*) AS count
    FROM swarm.events AS e
    JOIN swarm.streams AS s ON s.stream_id = e.stream_id
    WHERE e.workspace_id = ANY(${workspaces}::uuid[])
      AND e.workspace_id <> s.workspace_id
  `;
  assert.equal(Number(tenantViolations[0]?.count), 0, "I3 event tenancy");
  assert.ok(tasks.every((task) =>
    task.workspace_id === (task.stream_id === f.streamA ? f.workspaceA : f.workspaceB)
  ), "I3 task tenancy");

  // I4: only committable outcomes are ledgered, with the pure-core hash.
  const ledger = await sql<Record<string, unknown>[]>`
    SELECT *
    FROM swarm.idempotency_keys
    WHERE workspace_id = ANY(${workspaces}::uuid[])
  `;
  for (const row of ledger) {
    const response = row.response as Record<string, unknown>;
    assert.ok(
      response.ok === true ||
        (response.ok === false && response.class === "domain"),
      "I4 ledger contains only accepted/domain outcomes",
    );
    const key = `${String(row.principal_kind)}:${String(row.principal_id)}:${String(row.command_id)}`;
    const original = f.firstRequests.get(key);
    assert.ok(original, `I4 has original request for ${key}`);
    const actor = row.principal_kind === "agent"
      ? f.credentials.get(f.agentToken)!.actor
      : [...f.credentials.values()].find((entry) =>
        entry.kind === "user" && entry.id === row.principal_id
      )!.actor;
    assert.equal(row.request_hash, requestHash(actor, original), "I4 request hash");
  }

  // I5: every event is attributable; agent stamps join to the run/principal.
  for (const event of events) assert.ok(event.actor_user, "I5 actor_user");
  const badAgentStamps = await sql<{ count: string | number }[]>`
    SELECT count(*) AS count
    FROM swarm.events AS e
    LEFT JOIN swarm.agent_runs AS r ON r.run_id = e.actor_run
    WHERE e.workspace_id = ANY(${workspaces}::uuid[])
      AND e.actor_agent_principal IS NOT NULL
      AND (
        e.actor_run IS NULL
        OR r.run_id IS NULL
        OR r.principal_id <> e.actor_agent_principal
      )
  `;
  assert.equal(Number(badAgentStamps[0]?.count), 0, "I5 agent attribution");
}

async function scenario(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture();
  await run(f);
  await assertInvariants(f);
}

test("T-01 cross-tenant and nonexistent workspaces are uniform 403s", async () => {
  await scenario(async (f) => {
    const bHead = await sql<{ head_seq: string | number }[]>`
      SELECT head_seq FROM swarm.streams WHERE stream_id = ${f.streamB}::uuid
    `;
    const command: Command = {
      kind: "create",
      task_id: randomUUID(),
      slug: "cross-tenant",
    };
    const idB = commandId("crossb");
    const bRoute = { kind: "repo", repo_mapping_id: f.repoB };
    const deniedB = await issue(
      f,
      f.uaJwt,
      command,
      idB,
      {},
      f.workspaceB,
      bRoute,
    );
    const deniedMissing = await issue(
      f,
      f.uaJwt,
      { ...command, task_id: randomUUID() },
      commandId("crossmissing"),
      {},
      randomUUID(),
      bRoute,
    );
    assert.equal(deniedB.status, 403);
    assert.equal(deniedMissing.status, 403);
    assert.equal(deniedB.text, deniedMissing.text);
    assert.deepEqual(deniedB.body, { error: "forbidden" });
    const after = await sql<{ head_seq: string | number }[]>`
      SELECT head_seq FROM swarm.streams WHERE stream_id = ${f.streamB}::uuid
    `;
    assert.equal(Number(after[0]?.head_seq), Number(bHead[0]?.head_seq));
    const ledger = await sql<{ count: string | number }[]>`
      SELECT count(*) AS count FROM swarm.idempotency_keys
      WHERE command_id = ${idB}
    `;
    assert.equal(Number(ledger[0]?.count), 0);
  });
});

test("T-02 actor fields are ignored at the envelope boundary", async () => {
  await scenario(async (f) => {
    const taskId = randomUUID();
    const id = commandId("forged");
    const command: Command = { kind: "create", task_id: taskId, slug: "forged" };
    const accepted = await issue(f, f.uaJwt, command, id, {
      actor_user: f.ua2,
      actor_agent_principal: f.agentPrincipal,
      device: "victim-laptop",
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, "accepted");
    const replay = await issue(f, f.uaJwt, command, id);
    assert.equal(replay.body.status, "accepted");
    assert.deepEqual(stored(replay.body), stored(accepted.body));
    const event = await sql<Record<string, unknown>[]>`
      SELECT actor_user, actor_agent_principal, actor_run
      FROM swarm.events WHERE command_id = ${id}
    `;
    assert.equal(event[0]?.actor_user, f.ua);
    assert.equal(event[0]?.actor_agent_principal, null);
    assert.equal(event[0]?.actor_run, null);
    const detail = await sql<{ detail: string | null }[]>`
      SELECT detail FROM swarm.audit_log
      WHERE command_kind = 'create' AND actor_user = ${f.ua}::uuid
      ORDER BY audit_id ASC
    `;
    assert.ok(detail.some((row) => row.detail?.includes("actor_user")));

    const smuggled = await issue(
      f,
      f.uaJwt,
      { ...command, task_id: randomUUID(), actor_user: f.ua2 } as Command,
      commandId("smuggled"),
    );
    assert.equal(smuggled.status, 400);
  });
});

test("T-03 stale close is one ledgered domain rejection", async () => {
  await scenario(async (f) => {
    const taskId = randomUUID();
    assert.equal((await issue(f, f.uaJwt, {
      kind: "create",
      task_id: taskId,
      slug: "stale-close",
    })).body.status, "accepted");
    assert.equal((await issue(f, f.uaJwt, {
      kind: "acquire",
      task_id: taskId,
      ttl_ms: 1_000,
    })).body.status, "accepted");
    assert.equal((await issue(f, f.uaJwt, {
      kind: "submit",
      task_id: taskId,
      epoch: 1,
      branch: "ua/work",
      head_sha: "a".repeat(40),
      evidence_set: ["test:green"],
    })).body.status, "accepted");
    await delay(1_100);
    assert.equal((await issue(f, f.ua2Jwt, {
      kind: "acquire",
      task_id: taskId,
      ttl_ms: 60_000,
    })).body.status, "accepted");
    assert.equal((await issue(f, f.ua2Jwt, {
      kind: "submit",
      task_id: taskId,
      epoch: 2,
      branch: "ua2/work",
      head_sha: "b".repeat(40),
      evidence_set: ["test:green"],
    })).body.status, "accepted");

    const id = commandId("staleclose");
    const close: Command = {
      kind: "close",
      task_id: taskId,
      epoch: 1,
      disposition: "archive",
      grant_id: null,
    };
    const rejected = await issue(f, f.uaJwt, close, id);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, "rejected");
    assert.equal(rejected.body.class, "domain");
    assert.equal(rejected.body.reason, "stale_epoch");
    const replay = await issue(f, f.uaJwt, close, id);
    assert.deepEqual(stored(replay.body), stored(rejected.body));
    const rejectionCount = await sql<{ count: string | number }[]>`
      SELECT count(*) AS count FROM swarm.events
      WHERE command_id = ${id} AND type = 'CommandRejected'
    `;
    assert.equal(Number(rejectionCount[0]?.count), 1);
    const task = await sql<Record<string, unknown>[]>`
      SELECT lifecycle, submission FROM swarm.tasks
      WHERE stream_id = ${f.streamA}::uuid AND task_id = ${taskId}::uuid
    `;
    assert.equal(task[0]?.lifecycle, "awaiting_review");
    assert.equal((task[0]?.submission as { epoch: number }).epoch, 2);
  });
});

test("T-05/T-06 accepted replay and conflicting command-id reuse", async () => {
  await scenario(async (f) => {
    const id = commandId("idem");
    const original: Command = {
      kind: "create",
      task_id: randomUUID(),
      slug: "idempotent",
    };
    const accepted = await issue(f, f.uaJwt, original, id);
    const replay1 = await issue(f, f.uaJwt, original, id);
    const replay2 = await issue(f, f.uaJwt, original, id);
    assert.equal(accepted.body.status, "accepted");
    assert.deepEqual(stored(replay1.body), stored(accepted.body));
    assert.deepEqual(stored(replay2.body), stored(accepted.body));
    const beforeConflict = await sql<{ head_seq: string | number }[]>`
      SELECT head_seq FROM swarm.streams WHERE stream_id = ${f.streamA}::uuid
    `;
    const conflict = await issue(f, f.uaJwt, {
      kind: "create",
      task_id: randomUUID(),
      slug: "different",
    }, id);
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, { error: "command_id_conflict" });
    const replay3 = await issue(f, f.uaJwt, original, id);
    assert.deepEqual(stored(replay3.body), stored(accepted.body));
    const afterConflict = await sql<{ head_seq: string | number }[]>`
      SELECT head_seq FROM swarm.streams WHERE stream_id = ${f.streamA}::uuid
    `;
    assert.equal(Number(afterConflict[0]?.head_seq), Number(beforeConflict[0]?.head_seq));
    const rows = await sql<{ count: string | number }[]>`
      SELECT count(*) AS count FROM swarm.events WHERE command_id = ${id}
    `;
    assert.equal(Number(rows[0]?.count), 1);
  });
});

test("T-10 concurrent acquire has exactly one winner", async () => {
  await scenario(async (f) => {
    for (let iteration = 0; iteration < 50; iteration += 1) {
      const taskId = randomUUID();
      await issue(f, f.uaJwt, {
        kind: "create",
        task_id: taskId,
        slug: `lease-race-${iteration}`,
      });
      const idA = commandId("racea");
      const idB = commandId("raceb");
      const command: Command = {
        kind: "acquire",
        task_id: taskId,
        ttl_ms: 60_000,
      };
      const [a, b] = await Promise.all([
        issue(f, f.uaJwt, command, idA),
        issue(f, f.ua2Jwt, command, idB),
      ]);
      const responses = [a, b];
      assert.equal(
        responses.filter((r) => r.body.status === "accepted").length,
        1,
      );
      assert.equal(
        responses.filter((r) =>
          r.body.status === "rejected" && r.body.reason === "not_acquirable"
        ).length,
        1,
      );
      const events = await sql<{ type: string }[]>`
        SELECT type FROM swarm.events
        WHERE command_id IN (${idA}, ${idB})
        ORDER BY seq
      `;
      assert.equal(
        events.filter((event) => event.type === "LeaseAcquired").length,
        1,
      );
      assert.equal(
        events.filter((event) => event.type === "CommandRejected").length,
        1,
      );
      const [replayA, replayB] = await Promise.all([
        issue(f, f.uaJwt, command, idA),
        issue(f, f.ua2Jwt, command, idB),
      ]);
      assert.deepEqual(stored(replayA.body), stored(a.body));
      assert.deepEqual(stored(replayB.body), stored(b.body));
    }
  });
});

test("T-11 domain rejection replay preserves the original response", async () => {
  await scenario(async (f) => {
    const taskId = randomUUID();
    await issue(f, f.uaJwt, {
      kind: "create",
      task_id: taskId,
      slug: "domain-replay",
    });
    await issue(f, f.uaJwt, {
      kind: "acquire",
      task_id: taskId,
      ttl_ms: 60_000,
    });
    const id = commandId("domain");
    const acquire: Command = {
      kind: "acquire",
      task_id: taskId,
      ttl_ms: 60_000,
    };
    const rejected = await issue(f, f.ua2Jwt, acquire, id);
    assert.equal(rejected.body.reason, "not_acquirable");
    for (let index = 0; index < 3; index += 1) {
      const replay = await issue(f, f.ua2Jwt, acquire, id);
      assert.deepEqual(stored(replay.body), stored(rejected.body));
    }
    const events = await sql<{ count: string | number }[]>`
      SELECT count(*) AS count FROM swarm.events WHERE command_id = ${id}
    `;
    assert.equal(Number(events[0]?.count), 1);
  });
});

test("unknown-task agent command is history-only and replayable", async () => {
  await scenario(async (f) => {
    const taskId = randomUUID();
    const commands: Command[] = [
      { kind: "acquire", task_id: taskId, ttl_ms: 60_000 },
      { kind: "renew", task_id: taskId, epoch: 1, ttl_ms: 60_000 },
      {
        kind: "submit",
        task_id: taskId,
        epoch: 1,
        branch: "missing/work",
        head_sha: "c".repeat(40),
        evidence_set: ["test:green"],
      },
      {
        kind: "close",
        task_id: taskId,
        epoch: 1,
        disposition: "archive",
        grant_id: null,
      },
    ];
    const ids: string[] = [];
    for (const command of commands) {
      const id = commandId(`unknown${command.kind}`);
      ids.push(id);
      const rejected = await issue(f, f.agentToken, command, id);
      assert.equal(rejected.status, 200);
      assert.equal(rejected.body.status, "rejected");
      assert.equal(rejected.body.class, "domain");
      assert.equal(rejected.body.reason, "unknown_task");
      const replay = await issue(f, f.agentToken, command, id);
      assert.deepEqual(stored(replay.body), stored(rejected.body));
    }
    const events = await sql<Record<string, unknown>[]>`
      SELECT type, actor_user, actor_agent_principal, actor_run
      FROM swarm.events WHERE command_id = ANY(${ids}::text[])
      ORDER BY seq
    `;
    assert.equal(events.length, commands.length);
    for (const event of events) {
      assert.equal(event.type, "CommandRejected");
      assert.equal(event.actor_user, f.ua);
      assert.equal(event.actor_agent_principal, f.agentPrincipal);
      assert.equal(event.actor_run, f.agentRun);
    }
    const tasks = await sql<{ count: string | number }[]>`
      SELECT count(*) AS count FROM swarm.tasks
      WHERE stream_id = ${f.streamA}::uuid AND task_id = ${taskId}::uuid
    `;
    assert.equal(Number(tasks[0]?.count), 0);
  });
});
