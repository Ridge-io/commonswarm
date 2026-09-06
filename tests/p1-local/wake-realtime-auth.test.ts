/**
 * Private Realtime authorization control for agent wake topics.
 *
 * This file is named by `npm run test:p1-local`. It needs the local Supabase
 * stack and an announced exclusive database slot because it writes committed
 * principals and joins Realtime as anon.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from "@supabase/supabase-js";
import postgres from "postgres";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
}

const ROLLBACK = new Error("wake fixture rollback");
const WAKE_ID_RE = /^[A-Za-z0-9_-]{43}$/;

function environment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL);
  return parsed as LocalEnvironment;
}

function wakeTopic(wakeId: string): string {
  return `cswarm-wake:${wakeId}`;
}

function subscribeErrorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

let local: LocalEnvironment;
let sql: ReturnType<typeof postgres>;
const realtimeClients: SupabaseClient[] = [];

before(async () => {
  local = environment();
  sql = postgres(local.DB_URL, { max: 1 });
});

after(async () => {
  for (const client of realtimeClients) client.realtime.disconnect();
  await sql.end({ timeout: 2 });
});

interface SeededPrincipal {
  userId: string;
  workspaceId: string;
  principalId: string;
  tokenHash: Buffer;
  wakeId: string;
}

async function seedPrincipal(label: string, opts?: {
  liveToken?: boolean;
}): Promise<SeededPrincipal> {
  const liveToken = opts?.liveToken ?? true;
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const deviceId = randomUUID();
  const principalId = randomUUID();
  const runId = randomUUID();
  const tokenHash = createHash("sha256")
    .update(`swm_agt_${randomBytes(32).toString("base64url")}`)
    .digest();
  await sql`
    INSERT INTO swarm.users (user_id, display_name)
    VALUES (${userId}::uuid, ${`wake ${label}`})
  `;
  await sql`
    INSERT INTO swarm.workspaces (workspace_id, name, created_by)
    VALUES (${workspaceId}::uuid, ${`wake ${label}`}, ${userId}::uuid)
  `;
  await sql`
    INSERT INTO swarm.memberships (workspace_id, user_id, role)
    VALUES (${workspaceId}::uuid, ${userId}::uuid, 'owner')
  `;
  await sql`
    INSERT INTO swarm.devices (device_id, user_id, label)
    VALUES (${deviceId}::uuid, ${userId}::uuid, ${`wake-${label}`})
  `;
  await sql`
    INSERT INTO swarm.agent_principals (
      principal_id, workspace_id, owner_user_id, name
    ) VALUES (
      ${principalId}::uuid, ${workspaceId}::uuid, ${userId}::uuid, ${label}
    )
  `;
  await sql`
    INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
    VALUES (${runId}::uuid, ${principalId}::uuid, ${deviceId}::uuid)
  `;
  if (liveToken) {
    await sql`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id
      ) VALUES (
        ${randomUUID()}::uuid, ${principalId}::uuid, ${runId}::uuid,
        '["post_signal"]'::jsonb, ${tokenHash},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  }
  const [row] = await sql<{ wake_id: string }[]>`
    SELECT wake_id
    FROM swarm.agent_principals
    WHERE principal_id = ${principalId}::uuid
  `;
  assert.ok(row?.wake_id);
  return {
    userId,
    workspaceId,
    principalId,
    tokenHash,
    wakeId: row.wake_id,
  };
}

async function insertSignal(params: {
  signalId: string;
  workspaceId: string;
  fromPrincipal: string;
}): Promise<void> {
  await sql`
    INSERT INTO swarm.signals (
      id, workspace_id, from_principal, from_kind,
      to_user_id, to_agent_principal_id, in_reply_to,
      about, kind, body, until, created_at,
      channel_id, thread_root_id, broadcast_to_channel
    ) VALUES (
      ${params.signalId}::uuid, ${params.workspaceId}::uuid,
      ${params.fromPrincipal}::uuid, 'user',
      NULL, NULL, NULL,
      NULL, 'note', 'wake probe',
      statement_timestamp() + interval '1 hour',
      statement_timestamp(),
      NULL, NULL, false
    )
  `;
}

function newAnonClient(): SupabaseClient {
  const client = createClient(local.API_URL, local.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  realtimeClients.push(client);
  return client;
}

async function subscribeWake(
  client: SupabaseClient,
  topic: string,
): Promise<{ channel: RealtimeChannel; status: string; err: string }> {
  await client.realtime.setAuth(local.ANON_KEY);
  const channel = client.channel(topic, {
    config: { private: true, broadcast: { ack: false, self: false } },
  });
  channel.on("broadcast", { event: "wake" }, () => {});
  const result = await new Promise<{ status: string; err: string }>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Realtime subscribe timed out")),
        10_000,
      );
      channel.subscribe((next, err) => {
        if (next !== "SUBSCRIBED" && next !== "CHANNEL_ERROR" && next !== "TIMED_OUT") {
          return;
        }
        clearTimeout(timer);
        resolve({ status: next, err: subscribeErrorText(err) });
      });
    },
  );
  return { channel, status: result.status, err: result.err };
}

function refusalWithoutTopic(err: string, topic: string): string {
  assert.ok(err.length > 0, "Realtime refusal must carry text");
  return err.split(topic).join("<topic>");
}

test("anon joins a private wake topic for a live id", async () => {
  const principal = await seedPrincipal("live-join");
  const client = newAnonClient();
  const topic = wakeTopic(principal.wakeId);
  const joined = await subscribeWake(client, topic);
  assert.equal(
    joined.status,
    "SUBSCRIBED",
    `live id must be admitted; got ${joined.status} ${joined.err}`,
  );
  await client.removeChannel(joined.channel);
});

test("Realtime refusal text is identical for rotated, revoked, malformed, and no-live-token topics", async () => {
  const rotated = await seedPrincipal("rotated");
  const revoked = await seedPrincipal("revoked");
  const noToken = await seedPrincipal("no-token", { liveToken: false });

  const oldWakeId = rotated.wakeId;
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx`SELECT swarm.rotate_wake_id(${rotated.principalId}::uuid)`;
  });
  await sql`
    UPDATE swarm.agent_principals
    SET revoked_at = statement_timestamp()
    WHERE principal_id = ${revoked.principalId}::uuid
  `;

  const cases = [
    { name: "rotated", topic: wakeTopic(oldWakeId) },
    { name: "revoked", topic: wakeTopic(revoked.wakeId) },
    { name: "malformed", topic: "cswarm-wake:not-a-valid-id" },
    { name: "no-live-token", topic: wakeTopic(noToken.wakeId) },
  ];
  const normalized: string[] = [];
  for (const item of cases) {
    const client = newAnonClient();
    const refused = await subscribeWake(client, item.topic);
    assert.equal(
      refused.status,
      "CHANNEL_ERROR",
      `${item.name} must be CHANNEL_ERROR; got ${refused.status} ${refused.err}`,
    );
    normalized.push(refusalWithoutTopic(refused.err, item.topic));
    await client.removeChannel(refused.channel);
  }
  assert.equal(normalized[0], normalized[1]);
  assert.equal(normalized[0], normalized[2]);
  assert.equal(normalized[0], normalized[3]);
});

test("every principal has a distinct 43-character wake_id and a fresh insert gets one", async () => {
  const owner = await seedPrincipal("backfill-owner");
  for (let index = 0; index < 4; index += 1) {
    await sql`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${randomUUID()}::uuid,
        ${owner.workspaceId}::uuid,
        ${owner.userId}::uuid,
        ${`peer-${index}`}
      )
    `;
  }
  const rows = await sql<{ wake_id: string }[]>`
    SELECT wake_id FROM swarm.agent_principals
  `;
  assert.ok(rows.length >= 5);
  const ids = rows.map((row) => row.wake_id);
  for (const id of ids) {
    assert.match(id, WAKE_ID_RE);
  }
  assert.equal(new Set(ids).size, ids.length);

  const freshId = randomUUID();
  await sql`
    INSERT INTO swarm.agent_principals (
      principal_id, workspace_id, owner_user_id, name, model, created_at, revoked_at
    ) VALUES (
      ${freshId}::uuid,
      ${owner.workspaceId}::uuid,
      ${owner.userId}::uuid,
      'edge-shaped',
      NULL,
      statement_timestamp(),
      NULL
    )
  `;
  const [fresh] = await sql<{ wake_id: string }[]>`
    SELECT wake_id
    FROM swarm.agent_principals
    WHERE principal_id = ${freshId}::uuid
  `;
  assert.ok(fresh);
  assert.match(fresh.wake_id, WAKE_ID_RE);
  assert.equal(ids.includes(fresh.wake_id), false);
});

test("rotate_wake_id as swarm_command changes the id", async () => {
  const principal = await seedPrincipal("rotate");
  const before = principal.wakeId;
  let rotated = "";
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    const [row] = await tx<{ rotate_wake_id: string }[]>`
      SELECT swarm.rotate_wake_id(${principal.principalId}::uuid)
    `;
    assert.ok(row?.rotate_wake_id);
    rotated = row.rotate_wake_id;
  });
  assert.match(rotated, WAKE_ID_RE);
  assert.notEqual(rotated, before);
  const [after] = await sql<{ wake_id: string }[]>`
    SELECT wake_id
    FROM swarm.agent_principals
    WHERE principal_id = ${principal.principalId}::uuid
  `;
  assert.equal(after?.wake_id, rotated);
});

test("a delivery inserted as swarm_command leaves exactly one realtime.messages row on the wake topic", async () => {
  const principal = await seedPrincipal("delivery-row");
  const signalId = randomUUID();
  await insertSignal({
    signalId,
    workspaceId: principal.workspaceId,
    fromPrincipal: principal.userId,
  });
  const topic = wakeTopic(principal.wakeId);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx`
      INSERT INTO swarm.signal_deliveries (
        signal_id, workspace_id, recipient_agent_principal_id
      ) VALUES (
        ${signalId}::uuid,
        ${principal.workspaceId}::uuid,
        ${principal.principalId}::uuid
      )
    `;
  });
  const messages = await sql<{ topic: string; event: string; extension: string }[]>`
    SELECT topic, event, extension
    FROM realtime.messages
    WHERE topic = ${topic}
  `;
  assert.equal(messages.length, 1, "assert the row, never the absence of an error");
  assert.equal(messages[0]?.event, "wake");
  assert.equal(messages[0]?.extension, "broadcast");
});

test("the wake trigger swallows a send failure and the delivery insert still commits", async () => {
  const principal = await seedPrincipal("swallow");
  const signalId = randomUUID();
  await insertSignal({
    signalId,
    workspaceId: principal.workspaceId,
    fromPrincipal: principal.userId,
  });
  const sendFns = await sql<{ sig: string }[]>`
    SELECT p.oid::pg_catalog.regprocedure::text AS sig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'realtime' AND p.proname = 'send'
  `;
  assert.ok(sendFns.length > 0, "realtime.send must exist so the rename reaches it");
  let kept = 0;
  await assert.rejects(
    sql.begin(async (tx) => {
      for (const [index, fn] of sendFns.entries()) {
        await tx.unsafe(
          `ALTER FUNCTION ${fn.sig} RENAME TO send_saved_wake_test_${index}`,
        );
      }
      await tx.unsafe("SET LOCAL ROLE swarm_command");
      await tx`
        INSERT INTO swarm.signal_deliveries (
          signal_id, workspace_id, recipient_agent_principal_id
        ) VALUES (
          ${signalId}::uuid,
          ${principal.workspaceId}::uuid,
          ${principal.principalId}::uuid
        )
      `;
      const rows = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM swarm.signal_deliveries
        WHERE signal_id = ${signalId}::uuid
          AND recipient_agent_principal_id = ${principal.principalId}::uuid
      `;
      kept = rows[0]?.n ?? 0;
      throw ROLLBACK;
    }),
    (err: unknown) => err === ROLLBACK,
  );
  assert.equal(kept, 1);
});

test("agent_delivery_read_context returns wake_id to swarm_read", async () => {
  const principal = await seedPrincipal("read-context");
  let returned = "";
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE swarm_read");
    const [row] = await tx<{ wake_id: string }[]>`
      SELECT wake_id
      FROM swarm.agent_delivery_read_context(
        ${principal.tokenHash},
        ${principal.workspaceId}::uuid
      )
    `;
    assert.ok(row?.wake_id);
    returned = row.wake_id;
  });
  assert.equal(returned, principal.wakeId);
});

test("new function owners and agent_delivery_read_context execute privileges match the spec", async () => {
  const owners = await sql<{ proname: string; rolname: string }[]>`
    SELECT p.proname, r.rolname
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'swarm'
      AND p.proname IN (
        'wake_topic_authorized',
        'rotate_wake_id',
        'wake_agent_delivery',
        'wake_workspace_signal',
        'agent_delivery_read_context'
      )
    ORDER BY p.proname
  `;
  const byName = new Map(owners.map((row) => [row.proname, row.rolname]));
  assert.equal(byName.get("wake_topic_authorized"), "swarm_admin");
  assert.equal(byName.get("rotate_wake_id"), "postgres");
  assert.equal(byName.get("wake_agent_delivery"), "postgres");
  assert.equal(byName.get("wake_workspace_signal"), "postgres");
  assert.equal(byName.get("agent_delivery_read_context"), "swarm_admin");

  const checkFuncExec = async (role: string, fnSig: string) => {
    const [res] = await sql<{ allowed: boolean }[]>`
      SELECT has_function_privilege(${role}, ${fnSig}, 'EXECUTE') AS allowed
    `;
    return res?.allowed ?? false;
  };
  const contextFn = "swarm.agent_delivery_read_context(bytea, uuid)";
  for (const role of ["anon", "authenticated", "public"]) {
    assert.equal(
      await checkFuncExec(role, contextFn),
      false,
      `role ${role} is denied EXECUTE on ${contextFn}`,
    );
  }
  assert.equal(
    await checkFuncExec("swarm_read", contextFn),
    true,
    "swarm_read has EXECUTE on agent_delivery_read_context()",
  );
});
