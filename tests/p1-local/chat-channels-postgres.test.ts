/**
 * Real-Postgres coverage for the chat migrations (20260905000001..000003).
 *
 * Every claim here is one a pure test cannot make: a channel does not narrow
 * who may read a signal, a channel post wakes nobody, a channel_id from
 * another tenant cannot be stamped, the append-only trigger refuses to move a
 * signal between channels, and an insert written by the edge that PREDATES the
 * migration still succeeds.
 *
 * This file is reached only by `npm run test:p1-local`, which is a literal file
 * list — the path is named in package.json. Running it requires an announced
 * exclusive local database slot.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres from "postgres";

interface LocalEnvironment {
  DB_URL: string;
}

const ROLLBACK = new Error("chat channel fixture rollback");

function databaseUrl(): string {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(parsed.DB_URL, "local Supabase must expose DB_URL");
  return parsed.DB_URL;
}

interface Fixture {
  owner: string;
  other: string;
  workspaceA: string;
  workspaceB: string;
  deviceId: string;
  agentPrincipal: string;
  channelMobile: string;
  channelMobileB: string;
}

function newFixture(): Fixture {
  return {
    owner: randomUUID(),
    other: randomUUID(),
    workspaceA: randomUUID(),
    workspaceB: randomUUID(),
    deviceId: randomUUID(),
    agentPrincipal: randomUUID(),
    channelMobile: randomUUID(),
    channelMobileB: randomUUID(),
  };
}

async function seed(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  f: Fixture,
): Promise<void> {
  for (const userId of [f.owner, f.other]) {
    await tx`
      INSERT INTO auth.users (
        id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at
      ) VALUES (
        ${userId}::uuid, 'authenticated', 'authenticated',
        ${`channel-${userId}@example.test`}, '', statement_timestamp(),
        '{}'::jsonb, '{}'::jsonb, statement_timestamp(), statement_timestamp()
      )
    `;
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${userId}::uuid, ${`member ${userId.slice(0, 8)}`})
    `;
  }
  await tx`
    INSERT INTO swarm.devices (device_id, user_id, label)
    VALUES (${f.deviceId}::uuid, ${f.owner}::uuid, 'channel-test')
  `;
  await tx`
    INSERT INTO swarm.workspaces (workspace_id, name, created_by)
    VALUES
      (${f.workspaceA}::uuid, 'Channel workspace A', ${f.owner}::uuid),
      (${f.workspaceB}::uuid, 'Channel workspace B', ${f.owner}::uuid)
  `;
  await tx`
    INSERT INTO swarm.memberships (workspace_id, user_id, role)
    VALUES
      (${f.workspaceA}::uuid, ${f.owner}::uuid, 'owner'),
      (${f.workspaceA}::uuid, ${f.other}::uuid, 'member'),
      (${f.workspaceB}::uuid, ${f.owner}::uuid, 'owner')
  `;
  await tx`
    INSERT INTO swarm.agent_principals (
      principal_id, workspace_id, owner_user_id, name
    ) VALUES (
      ${f.agentPrincipal}::uuid, ${f.workspaceA}::uuid, ${f.owner}::uuid, 'builder'
    )
  `;
  await tx`
    INSERT INTO swarm.channels (
      channel_id, workspace_id, slug, purpose,
      created_by_principal, created_by_kind
    ) VALUES
      (${f.channelMobile}::uuid, ${f.workspaceA}::uuid, 'mobile', 'phone work',
       ${f.owner}::uuid, 'user'),
      (${f.channelMobileB}::uuid, ${f.workspaceB}::uuid, 'mobile', NULL,
       ${f.owner}::uuid, 'user')
  `;
}

/** The column list the edge writes today, with the chat columns. */
async function insertSignal(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  row: {
    id: string;
    workspaceId: string;
    from: string;
    toUserId: string | null;
    toAgent: string | null;
    kind: string;
    body: string;
    channelId: string | null;
  },
): Promise<void> {
  await tx`
    INSERT INTO swarm.signals (
      id, workspace_id, from_principal, from_kind,
      to_user_id, to_agent_principal_id, in_reply_to,
      about, kind, body, until, created_at,
      channel_id, thread_root_id, broadcast_to_channel
    ) VALUES (
      ${row.id}::uuid, ${row.workspaceId}::uuid, ${row.from}::uuid, 'user',
      ${row.toUserId}::uuid, ${row.toAgent}::uuid, NULL,
      NULL, ${row.kind}, ${row.body},
      statement_timestamp() + interval '1 day', statement_timestamp(),
      ${row.channelId}::uuid, NULL, false
    )
  `;
}

async function readableIdsAs(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  userId: string,
  workspaceId: string,
): Promise<Set<string>> {
  await tx`
    SELECT set_config(
      'request.jwt.claims',
      ${JSON.stringify({ sub: userId, role: "authenticated" })},
      true
    )
  `;
  await tx.unsafe("SET LOCAL ROLE authenticated");
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM swarm_read.signals WHERE workspace_id = ${workspaceId}::uuid
  `;
  await tx.unsafe("RESET ROLE");
  return new Set(rows.map((row) => row.id));
}

test("a channel groups signals and narrows nothing", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const broadcastInMobile = randomUUID();
  const directInMobile = randomUUID();
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await seed(tx, f);
        await insertSignal(tx, {
          id: broadcastInMobile,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: null,
          toAgent: null,
          kind: "note",
          body: "filed in mobile, addressed to nobody",
          channelId: f.channelMobile,
        });
        /* The discriminating pair. A member who is not the author must see the
         * broadcast (a channel is not an ACL) and must NOT see the directed
         * signal that happens to carry the same label (a channel did not
         * replace the predicate). Seeing both means the filter replaced the
         * predicate; seeing neither means the channel became an ACL. */
        await insertSignal(tx, {
          id: directInMobile,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: f.owner,
          toAgent: null,
          kind: "note",
          body: "filed in mobile, addressed to the author",
          channelId: f.channelMobile,
        });

        const seenByOther = await readableIdsAs(tx, f.other, f.workspaceA);
        assert.equal(
          seenByOther.has(broadcastInMobile),
          true,
          "a member who is not the author reads a broadcast in any channel",
        );
        assert.equal(
          seenByOther.has(directInMobile),
          false,
          "a channel label does not make a directed signal readable",
        );

        const seenByOwner = await readableIdsAs(tx, f.owner, f.workspaceA);
        assert.equal(seenByOwner.has(directInMobile), true);

        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("a channel post creates no delivery row, and a directed note to an agent still creates one", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const channelPost = randomUUID();
  const agentNote = randomUUID();
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await seed(tx, f);
        await insertSignal(tx, {
          id: channelPost,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: null,
          toAgent: null,
          kind: "note",
          body: "a channel post",
          channelId: f.channelMobile,
        });
        const [channelRow] = await tx<{ n: string }[]>`
          SELECT count(*)::text AS n FROM swarm.signal_deliveries
          WHERE signal_id = ${channelPost}::uuid
        `;
        assert.equal(channelRow?.n, "0", "a channel post wakes nobody");

        /* Positive control. Without it this test passes on a delivery trigger
         * that was dropped, or on a fixture whose workspace has no agent. */
        await insertSignal(tx, {
          id: agentNote,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: null,
          toAgent: f.agentPrincipal,
          kind: "note",
          body: "a directed note",
          channelId: f.channelMobile,
        });
        const [agentRow] = await tx<{ n: string }[]>`
          SELECT count(*)::text AS n FROM swarm.signal_deliveries
          WHERE signal_id = ${agentNote}::uuid
        `;
        assert.equal(agentRow?.n, "1", "a directed note to an agent still delivers");

        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("a channel is tenant-pinned: another workspace's channel_id cannot be stamped", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await seed(tx, f);
        /* Positive control first: the same slug resolves in its OWN workspace,
         * so the rejection below is tenancy and not a broken fixture. */
        const [own] = await tx<{ channel_id: string }[]>`
          SELECT channel_id FROM swarm.channels
          WHERE workspace_id = ${f.workspaceA}::uuid AND lower(slug) = 'mobile'
        `;
        assert.equal(own?.channel_id, f.channelMobile);

        await assert.rejects(
          insertSignal(tx, {
            id: randomUUID(),
            workspaceId: f.workspaceA,
            from: f.owner,
            toUserId: null,
            toAgent: null,
            kind: "note",
            body: "cross tenant",
            channelId: f.channelMobileB,
          }),
          /signals_channel_workspace/,
          "the composite foreign key must refuse a channel from another workspace",
        );
        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("channel_id is immutable, and the append-only trigger is what refuses the move", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const filed = randomUUID();
  const proofOfGrants = randomUUID();
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await seed(tx, f);
        await insertSignal(tx, {
          id: filed,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: null,
          toAgent: null,
          kind: "note",
          body: "filed once",
          channelId: null,
        });
        await assert.rejects(
          tx`
            UPDATE swarm.signals SET channel_id = ${f.channelMobile}::uuid
            WHERE id = ${filed}::uuid
          `,
          /append|immutable/i,
          "a signal cannot be moved into a channel after the fact",
        );
        /* Control: an INSERT in the same transaction succeeds, so the refusal
         * above was the append-only trigger and not a missing grant. */
        await insertSignal(tx, {
          id: proofOfGrants,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: null,
          toAgent: null,
          kind: "note",
          body: "inserts still work",
          channelId: f.channelMobile,
        });
        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("the edge that predates this migration still writes a legal row", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const oldShape = randomUUID();
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await seed(tx, f);
        /* The EXACT column list the command edge names before this lane. */
        await tx`
          INSERT INTO swarm.signals (
            id, workspace_id, from_principal, from_kind,
            to_user_id, to_agent_principal_id, in_reply_to,
            about, kind, body, until, created_at
          ) VALUES (
            ${oldShape}::uuid, ${f.workspaceA}::uuid, ${f.owner}::uuid, 'user',
            NULL, NULL, NULL, NULL, 'note', 'written by the old edge',
            statement_timestamp() + interval '1 day', statement_timestamp()
          )
        `;
        const [row] = await tx<
          { channel_id: string | null; broadcast_to_channel: boolean }[]
        >`
          SELECT channel_id, broadcast_to_channel FROM swarm.signals
          WHERE id = ${oldShape}::uuid
        `;
        assert.equal(row?.channel_id, null, "unfiled, which is legal forever");
        assert.equal(
          row?.broadcast_to_channel,
          false,
          "the NOT NULL column has a default, so the old insert is still legal",
        );

        /* The NEGATIVE arm, and the reason this test is worth having. Without
         * it, a passing insert cannot tell a safe migration from a lucky one:
         * make channel_id NOT NULL inside this rolled-back transaction and the
         * same insert must fail. That failure is the production write outage
         * this migration is shaped to make unreachable. */
        await tx.unsafe(
          "ALTER TABLE swarm.signals ALTER COLUMN channel_id SET NOT NULL",
        );
        await assert.rejects(
          tx`
            INSERT INTO swarm.signals (
              id, workspace_id, from_principal, from_kind,
              to_user_id, to_agent_principal_id, in_reply_to,
              about, kind, body, until, created_at
            ) VALUES (
              ${randomUUID()}::uuid, ${f.workspaceA}::uuid, ${f.owner}::uuid,
              'user', NULL, NULL, NULL, NULL, 'note', 'would fail in production',
              statement_timestamp() + interval '1 day', statement_timestamp()
            )
          `,
          /null value in column "channel_id"/,
        );
        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("a thread root is tenant-pinned and a reply may not point across workspaces", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const rootInA = randomUUID();
  const replyInA = randomUUID();
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await seed(tx, f);
        await insertSignal(tx, {
          id: rootInA,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: null,
          toAgent: null,
          kind: "note",
          body: "the thread root",
          channelId: f.channelMobile,
        });
        /* Positive control: a same-workspace reply is accepted. */
        await tx`
          INSERT INTO swarm.signals (
            id, workspace_id, from_principal, from_kind,
            to_user_id, to_agent_principal_id, in_reply_to,
            about, kind, body, until, created_at,
            channel_id, thread_root_id, broadcast_to_channel
          ) VALUES (
            ${replyInA}::uuid, ${f.workspaceA}::uuid, ${f.owner}::uuid, 'user',
            NULL, NULL, NULL, NULL, 'note', 'a threaded reply',
            statement_timestamp() + interval '1 hour', statement_timestamp(),
            ${f.channelMobile}::uuid, ${rootInA}::uuid, true
          )
        `;
        await assert.rejects(
          tx`
            INSERT INTO swarm.signals (
              id, workspace_id, from_principal, from_kind,
              to_user_id, to_agent_principal_id, in_reply_to,
              about, kind, body, until, created_at,
              channel_id, thread_root_id, broadcast_to_channel
            ) VALUES (
              ${randomUUID()}::uuid, ${f.workspaceB}::uuid, ${f.owner}::uuid,
              'user', NULL, NULL, NULL, NULL, 'note', 'cross tenant reply',
              statement_timestamp() + interval '1 hour', statement_timestamp(),
              NULL, ${rootInA}::uuid, false
            )
          `,
          /signals_thread_root_workspace/,
        );
        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("every view recreation kept the authorization clauses it started with", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  try {
    const [row] = await sql<{ def: string }[]>`
      SELECT pg_get_viewdef('swarm_read.signals'::regclass, true) AS def
    `;
    const def = row?.def ?? "";
    /* The columns the two recreations were supposed to add. */
    for (
      const column of ["channel_id", "thread_root_id", "broadcast_to_channel"]
    ) {
      assert.ok(def.includes(column), `the view must project ${column}`);
    }
    /* The clauses they were supposed to leave alone. A recreation started from
     * a migration file instead of pg_get_viewdef drops one of these silently:
     * CREATE OR REPLACE VIEW protects column shape and not the WHERE. */
    for (
      const marker of [
        "is_member",
        "to_user_id = auth.uid()",
        "to_agent_principal_id IS NULL",
        "owner_user_id = auth.uid()",
      ]
    ) {
      assert.ok(
        def.includes(marker),
        `the view must still carry the authorization fragment ${marker}`,
      );
    }
    /* Control: this scan can fail. A fragment no version of this view ever had
     * must be absent, so the assertions above are about content. */
    assert.equal(def.includes("channel_members"), false);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
