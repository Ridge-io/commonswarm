/**
 * Real-Postgres coverage for multi-recipient signals (20260905000010).
 *
 * Every claim here is one no pure test can make, and the build plan named the
 * first of them as the thing this suite exists to establish: the delivery
 * trigger's ON CONFLICT was READ from 20260731000001:126-137 and never RUN, so
 * "the first recipient is not woken twice" was an argument rather than a
 * measurement. It is measured here.
 *
 * The others: the view's predicate WIDENS to the recipient set and to nobody
 * else (the before/after visibility suite this lane owes, because
 * assert_view_clauses_preserved catches a dropped clause and cannot catch a
 * widened one); the derived recipient set reads identically whether it comes
 * from the rows or from the scalar fallback, which is what makes this migration
 * backfill-free; and the cap, the ordering, the first-is-the-scalar guarantee
 * and the immutability triggers all refuse what they claim to refuse.
 *
 * This file is reached only by `npm run test:p1-local`, which is a literal file
 * list -- the path is named in package.json. Running it requires an announced
 * exclusive local database slot.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres from "postgres";
import { SIGNAL_RECIPIENT_MAX } from "../../supabase/functions/_shared/channels.js";

interface LocalEnvironment {
  DB_URL: string;
}

const ROLLBACK = new Error("chat recipients fixture rollback");

function databaseUrl(): string {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(parsed.DB_URL, "local Supabase must expose DB_URL");
  return parsed.DB_URL;
}

type Tx = postgres.TransactionSql<Record<string, unknown>>;

interface Fixture {
  owner: string;
  second: string;
  third: string;
  bystander: string;
  workspaceA: string;
  workspaceB: string;
  deviceId: string;
  agentOne: string;
  agentTwo: string;
  agentOfSecond: string;
}

function newFixture(): Fixture {
  return {
    owner: randomUUID(),
    second: randomUUID(),
    third: randomUUID(),
    bystander: randomUUID(),
    workspaceA: randomUUID(),
    workspaceB: randomUUID(),
    deviceId: randomUUID(),
    agentOne: randomUUID(),
    agentTwo: randomUUID(),
    agentOfSecond: randomUUID(),
  };
}

async function seed(tx: Tx, f: Fixture): Promise<void> {
  for (const userId of [f.owner, f.second, f.third, f.bystander]) {
    await tx`
      INSERT INTO auth.users (
        id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at
      ) VALUES (
        ${userId}::uuid, 'authenticated', 'authenticated',
        ${`recipients-${userId}@example.test`}, '', statement_timestamp(),
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
    VALUES (${f.deviceId}::uuid, ${f.owner}::uuid, 'recipients-test')
  `;
  await tx`
    INSERT INTO swarm.workspaces (workspace_id, name, created_by)
    VALUES
      (${f.workspaceA}::uuid, 'Recipients workspace A', ${f.owner}::uuid),
      (${f.workspaceB}::uuid, 'Recipients workspace B', ${f.owner}::uuid)
  `;
  await tx`
    INSERT INTO swarm.memberships (workspace_id, user_id, role)
    VALUES
      (${f.workspaceA}::uuid, ${f.owner}::uuid, 'owner'),
      (${f.workspaceA}::uuid, ${f.second}::uuid, 'member'),
      (${f.workspaceA}::uuid, ${f.third}::uuid, 'member'),
      (${f.workspaceA}::uuid, ${f.bystander}::uuid, 'member'),
      (${f.workspaceB}::uuid, ${f.owner}::uuid, 'owner'),
      (${f.workspaceB}::uuid, ${f.third}::uuid, 'member')
  `;
  await tx`
    INSERT INTO swarm.agent_principals (
      principal_id, workspace_id, owner_user_id, name
    ) VALUES
      (${f.agentOne}::uuid, ${f.workspaceA}::uuid, ${f.owner}::uuid, 'builder'),
      (${f.agentTwo}::uuid, ${f.workspaceA}::uuid, ${f.owner}::uuid, 'reviewer'),
      (${f.agentOfSecond}::uuid, ${f.workspaceA}::uuid, ${f.second}::uuid, 'scout')
  `;
}

/** The column list the edge writes, with the chat columns. */
async function insertSignal(
  tx: Tx,
  row: {
    id: string;
    workspaceId: string;
    from: string;
    toUserId: string | null;
    toAgent: string | null;
    kind: string;
    body: string;
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
      NULL, NULL, false
    )
  `;
}

type Recipient = { user: string } | { agent: string };

async function addRecipients(
  tx: Tx,
  signalId: string,
  workspaceId: string,
  recipients: readonly Recipient[],
  startAt = 0,
): Promise<void> {
  for (const [offset, recipient] of recipients.entries()) {
    await tx`
      INSERT INTO swarm.signal_recipients (
        signal_id, workspace_id, recipient_user_id,
        recipient_agent_principal_id, position
      ) VALUES (
        ${signalId}::uuid,
        ${workspaceId}::uuid,
        ${"user" in recipient ? recipient.user : null}::uuid,
        ${"agent" in recipient ? recipient.agent : null}::uuid,
        ${startAt + offset}
      )
    `;
  }
}

async function readableIdsAs(
  tx: Tx,
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

async function recipientsColumn(
  tx: Tx,
  signalId: string,
): Promise<unknown> {
  const rows = await tx<{ recipients: unknown }[]>`
    SELECT recipients
    FROM swarm_read.signals
    WHERE id = ${signalId}::uuid
  `;
  return rows[0]?.recipients;
}

test("a signal addressed to three people is readable by all three and by nobody else", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const manyRecipients = randomUUID();
  const scalarOnly = randomUUID();
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await seed(tx, f);

        /* The signal under test: the scalar column names ONE recipient, the
         * side table names all three. */
        await insertSignal(tx, {
          id: manyRecipients,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: f.second,
          toAgent: null,
          kind: "note",
          body: "for the three of you",
        });
        await addRecipients(tx, manyRecipients, f.workspaceA, [
          { user: f.second },
          { user: f.third },
          { agent: f.agentOfSecond },
        ]);

        /* THE BEFORE HALF, on the same shape. Identical scalar recipient, no
         * rows in the side table. If `third` could read this one too, the new
         * disjunct would be admitting rows on something other than the
         * recipient set and the test above would prove nothing. */
        await insertSignal(tx, {
          id: scalarOnly,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: f.second,
          toAgent: null,
          kind: "note",
          body: "for one of you",
        });

        const bySecond = await readableIdsAs(tx, f.second, f.workspaceA);
        assert.equal(bySecond.has(manyRecipients), true, "recipient 0 reads it");
        assert.equal(bySecond.has(scalarOnly), true, "and the scalar one");

        const byThird = await readableIdsAs(tx, f.third, f.workspaceA);
        assert.equal(
          byThird.has(manyRecipients),
          true,
          "recipient 1 reads it, which is the whole point of the lane",
        );
        assert.equal(
          byThird.has(scalarOnly),
          false,
          "and the SAME shape without recipient rows stays invisible, so the new arm reads the set and nothing else",
        );

        const byBystander = await readableIdsAs(tx, f.bystander, f.workspaceA);
        assert.equal(
          byBystander.has(manyRecipients),
          false,
          "a member who is not addressed reads neither",
        );
        assert.equal(byBystander.has(scalarOnly), false);

        /* Recipient 2 is an AGENT owned by `second`, which the owner reads for
         * oversight the same way the scalar arm already allows. The owner of
         * the workspace does not own it, so it does not admit them. */
        const byOwner = await readableIdsAs(tx, f.owner, f.workspaceA);
        assert.equal(
          byOwner.has(manyRecipients),
          false,
          "the author is not a recipient, and sender visibility is not this lane",
        );

        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("owning an addressed agent is enough to read the signal, and owning a different one is not", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const toSecondsAgent = randomUUID();
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await seed(tx, f);
        /* Scalar recipient is an agent the OWNER owns; the side table adds an
         * agent `second` owns. Both must read it, through two different arms. */
        await insertSignal(tx, {
          id: toSecondsAgent,
          workspaceId: f.workspaceA,
          from: f.third,
          toUserId: null,
          toAgent: f.agentOne,
          kind: "ask",
          body: "both agents please",
        });
        await addRecipients(tx, toSecondsAgent, f.workspaceA, [
          { agent: f.agentOne },
          { agent: f.agentOfSecond },
        ]);

        const byOwner = await readableIdsAs(tx, f.owner, f.workspaceA);
        assert.equal(byOwner.has(toSecondsAgent), true, "owner of agent 0");
        const bySecond = await readableIdsAs(tx, f.second, f.workspaceA);
        assert.equal(
          bySecond.has(toSecondsAgent),
          true,
          "owner of agent 1, which only the new arm can admit",
        );
        const byBystander = await readableIdsAs(tx, f.bystander, f.workspaceA);
        assert.equal(
          byBystander.has(toSecondsAgent),
          false,
          "owning neither agent admits nothing",
        );
        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("every agent recipient gets exactly one delivery row, and the first is not woken twice", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const twoAgents = randomUUID();
  const scalarOnly = randomUUID();
  const oneEntryList = randomUUID();
  const userRecipients = randomUUID();
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await seed(tx, f);

        /* The measurement the build plan asked for. The signal insert already
         * enqueued agentOne from the scalar column; the recipient rows enqueue
         * agentOne AGAIN and agentTwo for the first time. If ON CONFLICT DO
         * NOTHING did not de-duplicate on (signal_id,
         * recipient_agent_principal_id), this insert would raise rather than
         * quietly produce one row. */
        await insertSignal(tx, {
          id: twoAgents,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: null,
          toAgent: f.agentOne,
          kind: "ask",
          body: "both of you",
        });
        await addRecipients(tx, twoAgents, f.workspaceA, [
          { agent: f.agentOne },
          { agent: f.agentTwo },
        ]);

        const rows = await tx<{ recipient_agent_principal_id: string }[]>`
          SELECT recipient_agent_principal_id
          FROM swarm.signal_deliveries
          WHERE signal_id = ${twoAgents}::uuid
          ORDER BY recipient_agent_principal_id
        `;
        assert.equal(rows.length, 2, "one row per agent recipient, no more");
        assert.deepEqual(
          new Set(rows.map((row) => row.recipient_agent_principal_id)),
          new Set([f.agentOne, f.agentTwo]),
        );

        /* CONTROL 1: a one-entry list produces exactly what the scalar shape
         * produces today. This is the wire claim, measured on the ledger. */
        await insertSignal(tx, {
          id: scalarOnly,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: null,
          toAgent: f.agentOne,
          kind: "ask",
          body: "scalar shape",
        });
        await insertSignal(tx, {
          id: oneEntryList,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: null,
          toAgent: f.agentOne,
          kind: "ask",
          body: "one-entry list",
        });
        await addRecipients(tx, oneEntryList, f.workspaceA, [
          { agent: f.agentOne },
        ]);
        const scalarRows = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM swarm.signal_deliveries
          WHERE signal_id = ${scalarOnly}::uuid
        `;
        const listRows = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM swarm.signal_deliveries
          WHERE signal_id = ${oneEntryList}::uuid
        `;
        assert.equal(scalarRows[0]!.n, 1);
        assert.equal(
          listRows[0]!.n,
          scalarRows[0]!.n,
          "a one-entry list writes the same delivery ledger as the scalar shape",
        );

        /* CONTROL 2: a PERSON recipient wakes nobody. Without this the counts
         * above could be explained by "every recipient row enqueues". */
        await insertSignal(tx, {
          id: userRecipients,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: f.second,
          toAgent: null,
          kind: "ask",
          body: "two people",
        });
        await addRecipients(tx, userRecipients, f.workspaceA, [
          { user: f.second },
          { user: f.third },
        ]);
        const peopleRows = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM swarm.signal_deliveries
          WHERE signal_id = ${userRecipients}::uuid
        `;
        assert.equal(peopleRows[0]!.n, 0, "people are not delivery rows");

        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("a working-on signal never enqueues a delivery, whichever way an agent is named", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const statusSignal = randomUUID();
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await seed(tx, f);
        /* The database is not the place that refuses working-on + a recipient
         * (the edge validator is), so the ROW is legal here. What must hold is
         * that the fan-out trigger applies the same kind gate the scalar
         * trigger applies, or a kind that is never delivered would start being
         * delivered through the new path. */
        await insertSignal(tx, {
          id: statusSignal,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: null,
          toAgent: f.agentOne,
          kind: "working-on",
          body: "still going",
        });
        await addRecipients(tx, statusSignal, f.workspaceA, [
          { agent: f.agentOne },
          { agent: f.agentTwo },
        ]);
        const rows = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM swarm.signal_deliveries
          WHERE signal_id = ${statusSignal}::uuid
        `;
        assert.equal(rows[0]!.n, 0);
        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("the recipient set reads the same whether it comes from the rows or from the scalar column", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const legacy = randomUUID();
  const withRow = randomUUID();
  const broadcast = randomUUID();
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await seed(tx, f);
        /* `legacy` is every signal written before this migration: a scalar
         * recipient and no rows. `withRow` is the same address written the new
         * way. The view must render them identically, because that equality is
         * the entire reason this migration needs no backfill. */
        await insertSignal(tx, {
          id: legacy,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: f.second,
          toAgent: null,
          kind: "note",
          body: "written before the table existed",
        });
        await insertSignal(tx, {
          id: withRow,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: f.second,
          toAgent: null,
          kind: "note",
          body: "written after it existed",
        });
        await addRecipients(tx, withRow, f.workspaceA, [{ user: f.second }]);
        await insertSignal(tx, {
          id: broadcast,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: null,
          toAgent: null,
          kind: "note",
          body: "to the workspace",
        });

        await tx`
          SELECT set_config(
            'request.jwt.claims',
            ${JSON.stringify({ sub: f.second, role: "authenticated" })},
            true
          )
        `;
        await tx.unsafe("SET LOCAL ROLE authenticated");
        const derived = await recipientsColumn(tx, legacy);
        const stored = await recipientsColumn(tx, withRow);
        const none = await recipientsColumn(tx, broadcast);
        await tx.unsafe("RESET ROLE");

        assert.deepEqual(
          derived,
          [{ kind: "user", id: f.second, position: 0 }],
          "the fallback renders the scalar recipient as a one-entry set",
        );
        assert.deepEqual(
          stored,
          derived,
          "and the stored row renders byte for byte the same set",
        );
        assert.deepEqual(none, [], "a signal addressed to nobody has an empty set");
        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("the cap is enforced by the database, at the same bound the edge reads", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const signalId = randomUUID();
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await seed(tx, f);
        await insertSignal(tx, {
          id: signalId,
          workspaceId: f.workspaceA,
          from: f.owner,
          toUserId: f.second,
          toAgent: null,
          kind: "note",
          body: "capped",
        });
        /* The highest legal position is the cap minus one, so the row count can
         * never exceed the cap: positions are unique per signal (the primary
         * key) and cannot exceed that number. Both halves of this sentence are
         * measured, the legal one first so the refusal below is not a refusal
         * of everything. */
        await tx`SAVEPOINT legal_top`;
        await addRecipients(
          tx,
          signalId,
          f.workspaceA,
          [{ user: f.second }],
          SIGNAL_RECIPIENT_MAX - 1,
        );
        assert.ok(true, "the cap-1 position is accepted");
        await tx`ROLLBACK TO SAVEPOINT legal_top`;

        await assert.rejects(
          addRecipients(
            tx,
            signalId,
            f.workspaceA,
            [{ user: f.second }],
            SIGNAL_RECIPIENT_MAX,
          ),
          (error: unknown) =>
            /signal_recipients_position_check|violates check constraint/.test(
              String(error),
            ),
          "the position at the cap itself is refused by the CHECK",
        );
        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

/**
 * One seeded transaction, always rolled back. Savepoints are deliberately NOT
 * used for the refusal cases below: PostgreSQL puts every command after a
 * ROLLBACK TO SAVEPOINT into a NEW subtransaction, so a row written there
 * carries a subtransaction xmin while pg_current_xact_id() keeps returning the
 * top-level id. swarm.require_new_signal_for_recipient() compares exactly those
 * two, so a savepoint silently turns "insert a recipient with its signal" into
 * "insert a recipient for someone else's signal". Measured, not assumed: a
 * first draft of this file used savepoints and three cases failed with the
 * same-transaction refusal instead of the rule they were written for.
 */
async function inRolledBackTx(
  sql: postgres.Sql,
  f: Fixture,
  body: (tx: Tx) => Promise<void>,
): Promise<void> {
  await assert.rejects(
    sql.begin(async (tx) => {
      await seed(tx, f);
      await body(tx);
      throw ROLLBACK;
    }),
    (error: unknown) => error === ROLLBACK,
  );
}

test("recipient 0 has to be the signal's own scalar recipient", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const signalId = randomUUID();
  const write = async (tx: Tx) => {
    /* The constraint trigger is DEFERRED because the recipient set is not
     * complete until commit, and these transactions are rolled back on purpose,
     * so it is forced to fire now. */
    await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
    await insertSignal(tx, {
      id: signalId,
      workspaceId: f.workspaceA,
      from: f.owner,
      toUserId: f.second,
      toAgent: null,
      kind: "note",
      body: "the scalar column says second",
    });
  };
  try {
    await inRolledBackTx(sql, f, async (tx) => {
      await write(tx);
      await assert.rejects(
        addRecipients(tx, signalId, f.workspaceA, [{ user: f.third }]),
        (error: unknown) => /recipient 0 must be the row/.test(String(error)),
        "position 0 naming someone else is refused, or an old reader would be WRONG rather than merely incomplete",
      );
    });
    /* POSITIVE CONTROL, in its own transaction: the same signal with a MATCHING
     * position 0 takes both recipients, so the refusal above is the mismatch
     * and not the trigger refusing every set. */
    await inRolledBackTx(sql, f, async (tx) => {
      await write(tx);
      await addRecipients(tx, signalId, f.workspaceA, [
        { user: f.second },
        { user: f.third },
      ]);
      const rows = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM swarm.signal_recipients
        WHERE signal_id = ${signalId}::uuid
      `;
      assert.equal(rows[0]!.n, 2);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("recipient positions have to be contiguous from zero", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const signalId = randomUUID();
  const write = async (tx: Tx) => {
    await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
    await insertSignal(tx, {
      id: signalId,
      workspaceId: f.workspaceA,
      from: f.owner,
      toUserId: f.second,
      toAgent: null,
      kind: "note",
      body: "gap",
    });
    await addRecipients(tx, signalId, f.workspaceA, [{ user: f.second }]);
  };
  try {
    await inRolledBackTx(sql, f, async (tx) => {
      await write(tx);
      await assert.rejects(
        addRecipients(tx, signalId, f.workspaceA, [{ user: f.third }], 2),
        (error: unknown) => /positions must run 0\.\.n-1/.test(String(error)),
        "a gap in the order is refused, or the count stops being derivable from the highest slot",
      );
    });
    /* Control: the very same second recipient at the NEXT position is taken. */
    await inRolledBackTx(sql, f, async (tx) => {
      await write(tx);
      await addRecipients(tx, signalId, f.workspaceA, [{ user: f.third }], 1);
      assert.ok(true);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("a recipient set cannot be changed, extended with a duplicate, or pointed across a tenant", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const signalId = randomUUID();
  const signalInB = randomUUID();
  const write = async (tx: Tx) => {
    await insertSignal(tx, {
      id: signalId,
      workspaceId: f.workspaceA,
      from: f.owner,
      toUserId: f.second,
      toAgent: null,
      kind: "note",
      body: "immutable",
    });
    await addRecipients(tx, signalId, f.workspaceA, [
      { user: f.second },
      { user: f.third },
    ]);
  };
  try {
    await inRolledBackTx(sql, f, async (tx) => {
      await write(tx);
      await assert.rejects(
        addRecipients(tx, signalId, f.workspaceA, [{ user: f.third }], 2),
        (error: unknown) => /duplicate key value|unique/i.test(String(error)),
        "the same recipient cannot be named twice on one signal",
      );
    });
    await inRolledBackTx(sql, f, async (tx) => {
      await write(tx);
      await assert.rejects(
        tx`
          UPDATE swarm.signal_recipients
          SET recipient_user_id = ${f.bystander}::uuid
          WHERE signal_id = ${signalId}::uuid AND position = 1
        `,
        (error: unknown) => /SWARM_APPEND_ONLY/.test(String(error)),
        "a recipient row cannot be updated",
      );
    });
    await inRolledBackTx(sql, f, async (tx) => {
      await write(tx);
      await assert.rejects(
        tx`
          DELETE FROM swarm.signal_recipients
          WHERE signal_id = ${signalId}::uuid AND position = 1
        `,
        (error: unknown) => /SWARM_APPEND_ONLY/.test(String(error)),
        "a recipient row cannot be deleted",
      );
    });
    /* ★R14, the tenant boundary. The recipient FK is composite on
     * (workspace_id, recipient_user_id) against swarm.memberships, so naming
     * somebody who is not a member of the SIGNAL's workspace cannot be stored
     * even though that person is a real member somewhere else. */
    const writeInB = async (tx: Tx) => {
      await insertSignal(tx, {
        id: signalInB,
        workspaceId: f.workspaceB,
        from: f.owner,
        toUserId: f.owner,
        toAgent: null,
        kind: "note",
        body: "workspace B",
      });
      await addRecipients(tx, signalInB, f.workspaceB, [{ user: f.owner }]);
    };
    /* Each expected failure is the LAST database action in its transaction:
     * one failed statement puts the whole transaction in the aborted state, so
     * a control placed after a refusal cannot run and would be reported as the
     * refusal itself. Measured -- a first draft did exactly that. */
    await inRolledBackTx(sql, f, async (tx) => {
      await writeInB(tx);
      await assert.rejects(
        addRecipients(tx, signalInB, f.workspaceB, [{ user: f.second }], 1),
        (error: unknown) => /foreign key|violates/i.test(String(error)),
        "a member of workspace A is not addressable on a workspace B signal",
      );
    });
    /* Control: the SAME position takes a real member of workspace B, so the
     * refusal above is the tenant boundary and not the position or the row. */
    await inRolledBackTx(sql, f, async (tx) => {
      await writeInB(tx);
      await addRecipients(tx, signalInB, f.workspaceB, [{ user: f.third }], 1);
      const rows = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM swarm.signal_recipients
        WHERE signal_id = ${signalInB}::uuid
      `;
      assert.equal(rows[0]!.n, 2);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("a recipient cannot be attached to a signal a different transaction wrote", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const f = newFixture();
  const sameTransaction = randomUUID();
  const otherTransaction = randomUUID();
  try {
    /* WHAT THIS MEASURES, stated exactly. The trigger's predicate is
     * signal.xmin = the current TOP-LEVEL transaction id. A signal written by
     * an earlier transaction fails it -- and so does one written by a different
     * SUBtransaction of this one, which is the same predicate and is the only
     * form that can be measured without committing rows to a shared database
     * that refuses every DELETE (swarm.signals is append-only, so a committed
     * fixture here would be permanent).
     *
     * The pair is what makes it a measurement: the signal written before any
     * savepoint takes its recipient, and the one written after a savepoint --
     * therefore under a subtransaction id -- does not. */
    await inRolledBackTx(sql, f, async (tx) => {
      await insertSignal(tx, {
        id: sameTransaction,
        workspaceId: f.workspaceA,
        from: f.owner,
        toUserId: f.second,
        toAgent: null,
        kind: "note",
        body: "written by this transaction",
      });
      await tx`SAVEPOINT boundary`;
      await tx`ROLLBACK TO SAVEPOINT boundary`;
      await insertSignal(tx, {
        id: otherTransaction,
        workspaceId: f.workspaceA,
        from: f.owner,
        toUserId: f.second,
        toAgent: null,
        kind: "note",
        body: "written under a different transaction id",
      });

      await addRecipients(tx, sameTransaction, f.workspaceA, [
        { user: f.second },
      ]);
      await assert.rejects(
        addRecipients(tx, otherTransaction, f.workspaceA, [{ user: f.second }]),
        (error: unknown) =>
          /can be inserted only with a new signal/.test(String(error)),
        "who can read an immutable signal cannot be changed after it is written",
      );
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
});
