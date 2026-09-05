/**
 * Channels and threads against the SERVED command function and real Postgres.
 *
 * These are the claims no pure test and no schema test can reach, because they
 * live in the edge's validator and its SQL: a thread roots only on an
 * undirected message, a reply's horizon is clamped when it was defaulted and
 * REFUSED when it was named, in_reply_to keeps its addressing, and the
 * channel/thread fields do not disturb a body that omits them.
 *
 * Two of these were found by review arms rather than by a test, twice on the
 * same clamp. That is why they are here.
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

interface ChatFixture {
  workspace: string;
  ownerId: string;
  ownerJwt: string;
  otherId: string;
  otherJwt: string;
  principal: string;
  agentToken: string;
}

let f: ChatFixture;

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

async function chatFixture(): Promise<ChatFixture> {
  const owner = await createUser("chat-owner");
  const other = await createUser("chat-other");
  const workspace = randomUUID();
  const device = randomUUID();
  const principal = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${owner.id}::uuid, 'ChatOwner'),
        (${other.id}::uuid, 'ChatOther')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'chat-tests')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'ChatWS', ${owner.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${workspace}::uuid, ${owner.id}::uuid, 'owner'),
        (${workspace}::uuid, ${other.id}::uuid, 'member')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${principal}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'chat-agent'
      )
    `;
    const run = randomUUID();
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
    otherId: other.id,
    otherJwt: other.jwt,
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
  envDir = mkdtempSync(join(tmpdir(), "cswarm-chat-env-"));
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
  /* Wait for OUR boot banner before the HTTP probe: at a file seam the previous
   * file's still-answering runtime satisfies the probe and every request 502s. */
  {
    const bootDeadline = Date.now() + 60_000;
    while (!functionLogs.includes("Serving functions on")) {
      if (Date.now() > bootDeadline) {
        throw new Error(
          `functions serve never booted:\n${functionLogs.slice(-3000)}`,
        );
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
  f = await chatFixture();
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

async function send(
  bearer: string,
  command: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
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
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

/** The EXACT body every installed client sends: the modern pair, always both. */
function installedPost(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "post_signal",
    signal_kind: "note",
    body: `p1-server chat ${randomUUID()}`,
    to_user_id: null,
    about: null,
    to_agent_principal_id: null,
    in_reply_to: null,
    ...extra,
  };
}

function signalOf(body: Record<string, unknown>): Record<string, unknown> {
  const signal = body.signal as Record<string, unknown> | undefined;
  assert.ok(signal, `no signal in response: ${JSON.stringify(body)}`);
  return signal;
}

test("a body that predates channels still posts, and one that names a channel lands in it", async () => {
  const legacy = await send(f.ownerJwt, installedPost());
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal(signalOf(legacy.body).channel_id, null, "unfiled");
  assert.equal(signalOf(legacy.body).broadcast_to_channel, false);

  const created = await send(f.ownerJwt, {
    kind: "channel_create",
    slug: `mobile-${randomBytes(4).toString("hex")}`,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const channel = created.body.channel as Record<string, unknown>;
  assert.ok(channel?.channel_id);

  const filed = await send(
    f.ownerJwt,
    installedPost({ channel: channel.slug }),
  );
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  assert.equal(signalOf(filed.body).channel_id, channel.channel_id);
});

test("an agent may create a channel with a token that carries only post_signal", async () => {
  /* The scope gate exempts channel commands by class. A token minted before
   * these commands existed cannot carry a channel_create scope, so refusing
   * without the exemption would refuse every agent already running. */
  const slug = `agent-made-${randomBytes(4).toString("hex")}`;
  const created = await send(f.agentToken, { kind: "channel_create", slug });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(
    (created.body.channel as Record<string, unknown>).created_by_kind,
    "agent",
  );
  /* Control: the same token is still refused a command that is NOT exempt and
   * not in its scopes, so the acceptance above is the exemption and not an
   * unscoped edge. */
  const refused = await send(f.agentToken, {
    kind: "create_agent_principal",
    name: "should-not-work",
  });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
});

test("a channel that does not exist is refused with the channels that do", async () => {
  const slug = `known-${randomBytes(4).toString("hex")}`;
  const created = await send(f.ownerJwt, { kind: "channel_create", slug });
  assert.equal(created.status, 200);
  const missing = await send(
    f.ownerJwt,
    installedPost({ channel: `absent-${randomBytes(4).toString("hex")}` }),
  );
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.match(String(missing.body.message), /no channel named/);
  /* The list is generated from the same query the validator ran, so the slug
   * created a moment ago must be in it. A typed list would not have it. */
  assert.ok(
    String(missing.body.message).includes(slug),
    `message must name the live channels: ${missing.body.message}`,
  );
});

test("an archived channel keeps its history and takes no new messages", async () => {
  const slug = `archived-${randomBytes(4).toString("hex")}`;
  const created = await send(f.ownerJwt, { kind: "channel_create", slug });
  const channel = created.body.channel as Record<string, unknown>;
  const before = await send(f.ownerJwt, installedPost({ channel: slug }));
  assert.equal(before.status, 200);
  const archived = await send(f.ownerJwt, {
    kind: "channel_archive",
    channel_id: channel.channel_id,
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  const after = await send(f.ownerJwt, installedPost({ channel: slug }));
  assert.equal(after.status, 409, JSON.stringify(after.body));
  assert.equal(after.body.error, "channel_archived");
  /* Control: the signal posted before the archive is still there. */
  const [row] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.signals
    WHERE id = ${String(signalOf(before.body).id)}::uuid
  `;
  assert.equal(row?.n, "1");
});

test("a thread roots only on an undirected message", async () => {
  const root = await send(f.ownerJwt, installedPost());
  assert.equal(root.status, 200);
  const rootId = String(signalOf(root.body).id);

  const reply = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId }),
  );
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(signalOf(reply.body).thread_root_id, rootId);
  assert.equal(signalOf(reply.body).to, null, "a thread reply is undirected");

  /* The disclosure arm. A DIRECTED signal between two other parties must not
   * become the root of a thread everyone can read: the reply itself is
   * undirected, so the thread would advertise that the private message exists.
   * resolveThreadRoot reads swarm.signals as swarm_command, bypassing the view
   * that is the read policy, so this is enforcement and not a side effect. */
  const directed = await send(
    f.otherJwt,
    installedPost({ to_user_id: f.ownerId }),
  );
  assert.equal(directed.status, 200, JSON.stringify(directed.body));
  const directedId = String(signalOf(directed.body).id);
  const hijack = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: directedId }),
  );
  assert.equal(hijack.status, 404, JSON.stringify(hijack.body));
  assert.equal(hijack.body.error, "thread_root_not_found");
  /* The refusal must not distinguish "directed" from "absent", or it becomes
   * an oracle for which ids exist. */
  const absent = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: randomUUID() }),
  );
  assert.equal(absent.status, 404);
  assert.equal(absent.body.message, hijack.body.message);
});

test("a thread reply is never working-on, never addressed, and never also in_reply_to", async () => {
  const root = await send(f.ownerJwt, installedPost());
  const rootId = String(signalOf(root.body).id);

  const workingOn = await send(
    f.ownerJwt,
    installedPost({ signal_kind: "working-on", thread_root_id: rootId }),
  );
  assert.equal(workingOn.status, 400, JSON.stringify(workingOn.body));

  const addressed = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId, to_user_id: f.otherId }),
  );
  assert.equal(addressed.status, 400, JSON.stringify(addressed.body));

  const both = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId, in_reply_to: rootId }),
  );
  assert.equal(both.status, 400, JSON.stringify(both.body));

  /* Control: an ask IS allowed as a thread reply (R11), so the three refusals
   * above are the stated rules and not a blanket refusal of thread replies. */
  const ask = await send(
    f.ownerJwt,
    installedPost({ signal_kind: "ask", thread_root_id: rootId }),
  );
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
});

test("in_reply_to keeps its addressing, and a thread reply does not borrow it", async () => {
  /* The claim R2 rests on: in_reply_to means "reply privately to the author"
   * and the server re-addresses the row. Threads must not change that. */
  const ask = await send(
    f.otherJwt,
    installedPost({ signal_kind: "note", to_user_id: f.ownerId }),
  );
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  const askId = String(signalOf(ask.body).id);

  const privateReply = await send(
    f.ownerJwt,
    installedPost({ in_reply_to: askId }),
  );
  assert.equal(privateReply.status, 200, JSON.stringify(privateReply.body));
  assert.equal(
    signalOf(privateReply.body).to,
    f.otherId,
    "the server still re-addresses an in_reply_to row to the referenced author",
  );
  assert.equal(signalOf(privateReply.body).thread_root_id, null);
});

test("a defaulted reply horizon is clamped to the thread; a named one is refused, never shortened", async () => {
  /* Twice a review arm found this wrong and no test caught it. Both branches
   * are asserted here against the served function and real Postgres. */
  const root = await send(f.ownerJwt, installedPost({ until_ms: 90_000 }));
  assert.equal(root.status, 200, JSON.stringify(root.body));
  const rootId = String(signalOf(root.body).id);
  const rootUntil = Date.parse(String(signalOf(root.body).until));

  /* DEFAULT: a note defaults to 30 days, far past a 90-second root, so the
   * clamp must bite and the stored horizon must not exceed the root's. */
  const defaulted = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId }),
  );
  assert.equal(defaulted.status, 200, JSON.stringify(defaulted.body));
  const defaultedUntil = Date.parse(String(signalOf(defaulted.body).until));
  assert.ok(
    defaultedUntil <= rootUntil,
    `a clamped reply must not outlive its root: ${defaultedUntil} > ${rootUntil}`,
  );
  /* Control: without the clamp this would be ~30 days out, so a horizon inside
   * the root's window is the clamp working and not a coincidence. */
  assert.ok(
    defaultedUntil > Date.now(),
    "and it must still be live",
  );

  /* NAMED and too long: refused, not shortened. */
  const tooLong = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId, until_ms: 10 * 60_000 }),
  );
  assert.equal(tooLong.status, 409, JSON.stringify(tooLong.body));
  assert.equal(tooLong.body.error, "thread_reply_until_exceeds_root");

  /* NAMED and comfortably inside: stored EXACTLY as asked, never trimmed to
   * the ceiling. This is the arm that catches a silent shorten. */
  const fits = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId, until_ms: 30_000 }),
  );
  assert.equal(fits.status, 200, JSON.stringify(fits.body));
  const fitsUntil = Date.parse(String(signalOf(fits.body).until));
  const created = Date.parse(String(signalOf(fits.body).created_at));
  assert.equal(
    fitsUntil - created,
    30_000,
    "an explicit horizon is stored exactly as named, not clamped to the ceiling",
  );
});

test("a channel post wakes nobody, and a directed note to an agent still does", async () => {
  const slug = `wake-${randomBytes(4).toString("hex")}`;
  await send(f.ownerJwt, { kind: "channel_create", slug });
  const posted = await send(f.ownerJwt, installedPost({ channel: slug }));
  assert.equal(posted.status, 200);
  const [none] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.signal_deliveries
    WHERE signal_id = ${String(signalOf(posted.body).id)}::uuid
  `;
  assert.equal(none?.n, "0", "a channel post creates no delivery row");

  const directed = await send(
    f.ownerJwt,
    installedPost({ channel: slug, to_agent_principal_id: f.principal }),
  );
  assert.equal(directed.status, 200, JSON.stringify(directed.body));
  const [one] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.signal_deliveries
    WHERE signal_id = ${String(signalOf(directed.body).id)}::uuid
  `;
  assert.equal(one?.n, "1", "a directed note to an agent still delivers");
});

test("a bad channel name is refused with the rule, and the field list names the fields", async () => {
  const bad = await send(f.ownerJwt, { kind: "channel_create", slug: "Not A Slug" });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(String(bad.body.message ?? bad.body.error), /lowercase|channel name/i);

  const missing = await send(f.ownerJwt, { kind: "channel_archive" });
  assert.equal(missing.status, 400, JSON.stringify(missing.body));
  assert.match(
    String(missing.body.message ?? bad.body.error),
    /channel_archive takes channel_id/,
  );
});
