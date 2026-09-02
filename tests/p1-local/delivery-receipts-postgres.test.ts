/**
 * Real-Postgres coverage for both receipt caller identities and author isolation.
 *
 * This file is reached only by `npm run test:p1-local`. Running it requires an
 * announced exclusive local database slot.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres from "postgres";
import { ackAgentDelivery } from "../../supabase/functions/command/durable-delivery.js";
import { markHumanSignalsSeen } from "../../supabase/functions/command/human-receipts.js";
import { loadOldReceiptsParser } from "../support/old-receipts-parser.js";

interface LocalEnvironment {
  DB_URL: string;
}

/* `receipts` never carries an agent tracking row: pre-roster clients read any
 * non-human `receipts` row as a delivery ledger row (20260902000001). Agents
 * are listed under broadcast_roster.agents.principals. */
interface UntrackedAgentRow {
  principal_id: string;
  recipient_agent_principal_id: string;
  display_name: string;
  seen_at: string | null;
  tracking_state: "not_tracked";
  observed_at: null;
}

interface AgentRosterSection {
  total: number;
  seen: number;
  returned: number;
  limit: number;
  truncated: boolean;
  tracking_state: "not_tracked";
  principals: UntrackedAgentRow[];
}

interface ReceiptResult {
  addressed: boolean;
  receipts: Array<{
    recipient_agent_principal_id?: string;
    recipient_user_id?: string;
    display_name?: string;
    seen_at?: string | null;
  }>;
  broadcast_roster?: {
    members: {
      total: number;
      seen: number;
      returned: number;
      limit: number;
      truncated: boolean;
    };
    agents: AgentRosterSection;
  };
}

/** The agent section without its row list, for a counts-only deepEqual. */
function agentCounts(section: AgentRosterSection | undefined): Omit<AgentRosterSection, "principals"> | undefined {
  if (section === undefined) return undefined;
  const { principals: _principals, ...counts } = section;
  return counts;
}

const ROLLBACK = new Error("receipt fixture rollback");

function databaseUrl(): string {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(parsed.DB_URL, "local Supabase must expose DB_URL");
  return parsed.DB_URL;
}

test("delivery receipt authorization matrix holds on real Postgres", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const userId = randomUUID();
  const nonMemberId = randomUUID();
  const workspaceId = randomUUID();
  const deviceId = randomUUID();
  const senderA = randomUUID();
  const senderB = randomUUID();
  const recipient = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const tokenA = randomBytes(32);
  const tokenB = randomBytes(32);
  const agentSignal = randomUUID();
  const humanSignal = randomUUID();
  const broadcastSignal = randomUUID();

  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`
          INSERT INTO auth.users (
            id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at
          ) VALUES
            (
              ${userId}::uuid,
              'authenticated',
              'authenticated',
              ${`receipt-${userId}@example.test`},
              '',
              statement_timestamp(),
              '{}'::jsonb,
              '{}'::jsonb,
              statement_timestamp(),
              statement_timestamp()
            ),
            (
              ${nonMemberId}::uuid,
              'authenticated',
              'authenticated',
              ${`receipt-${nonMemberId}@example.test`},
              '',
              statement_timestamp(),
              '{}'::jsonb,
              '{}'::jsonb,
              statement_timestamp(),
              statement_timestamp()
            )
        `;
        await tx`
          INSERT INTO swarm.users (user_id, display_name)
          VALUES
            (${userId}::uuid, 'Receipt owner'),
            (${nonMemberId}::uuid, 'Receipt non-member')
        `;
        await tx`
          INSERT INTO swarm.devices (device_id, user_id, label)
          VALUES (${deviceId}::uuid, ${userId}::uuid, 'receipt-test')
        `;
        await tx`
          INSERT INTO swarm.workspaces (workspace_id, name, created_by)
          VALUES (${workspaceId}::uuid, 'Receipt workspace', ${userId}::uuid)
        `;
        await tx`
          INSERT INTO swarm.memberships (workspace_id, user_id, role)
          VALUES (${workspaceId}::uuid, ${userId}::uuid, 'owner')
        `;
        await tx`
          INSERT INTO swarm.agent_principals (
            principal_id, workspace_id, owner_user_id, name
          ) VALUES
            (${senderA}::uuid, ${workspaceId}::uuid, ${userId}::uuid, 'sender-a'),
            (${senderB}::uuid, ${workspaceId}::uuid, ${userId}::uuid, 'sender-b'),
            (${recipient}::uuid, ${workspaceId}::uuid, ${userId}::uuid, 'recipient')
        `;
        await tx`
          INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
          VALUES
            (${runA}::uuid, ${senderA}::uuid, ${deviceId}::uuid),
            (${runB}::uuid, ${senderB}::uuid, ${deviceId}::uuid)
        `;
        await tx`
          INSERT INTO swarm.agent_tokens (
            token_id, principal_id, run_id, scopes, token_hash,
            expires_at, lineage_id
          ) VALUES
            (
              ${randomUUID()}::uuid,
              ${senderA}::uuid,
              ${runA}::uuid,
              '["post_signal"]'::jsonb,
              ${tokenA},
              statement_timestamp() + interval '1 hour',
              ${randomUUID()}::uuid
            ),
            (
              ${randomUUID()}::uuid,
              ${senderB}::uuid,
              ${runB}::uuid,
              '["post_signal"]'::jsonb,
              ${tokenB},
              statement_timestamp() + interval '1 hour',
              ${randomUUID()}::uuid
            )
        `;
        await tx`
          INSERT INTO swarm.signals (
            id, workspace_id, from_principal, from_kind,
            to_agent_principal_id, kind, body, until
          ) VALUES
            (
              ${agentSignal}::uuid,
              ${workspaceId}::uuid,
              ${senderA}::uuid,
              'agent',
              ${recipient}::uuid,
              'ask',
              'agent addressed',
              statement_timestamp() + interval '1 hour'
            ),
            (
              ${humanSignal}::uuid,
              ${workspaceId}::uuid,
              ${userId}::uuid,
              'user',
              ${recipient}::uuid,
              'note',
              'human addressed',
              statement_timestamp() + interval '1 hour'
            ),
            (
              ${broadcastSignal}::uuid,
              ${workspaceId}::uuid,
              ${senderA}::uuid,
              'agent',
              NULL,
              'note',
              'agent broadcast',
              statement_timestamp() + interval '1 hour'
            )
        `;

        await tx.unsafe("SET LOCAL ROLE swarm_read");
        const [agentRow] = await tx<{ result: ReceiptResult }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid,
            ${agentSignal}::uuid,
            ${tokenA}
          ) AS result
        `;
        const [broadcastRow] = await tx<{ result: ReceiptResult }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid,
            ${broadcastSignal}::uuid,
            ${tokenA}
          ) AS result
        `;
        const [crossSenderRow] = await tx<{ result: unknown }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid,
            ${agentSignal}::uuid,
            ${tokenB}
          ) AS result
        `;
        await tx.unsafe("RESET ROLE");

        /* The wire the installed 0.1.42/0.1.43 clients see, from REAL Postgres —
         * not a hand-built fixture. The old parser must accept both branches and
         * must still reject the pre-fold shape (control), or the compat claim
         * rests on our own parser agreeing with our own SQL. */
        const oldParser = await loadOldReceiptsParser();
        try {
          assert.equal(
            oldParser.parseDeliveryReceiptResult(agentRow!.result).receipts.length,
            agentRow!.result.receipts.length,
            "old parser reads the directed wire from real Postgres",
          );
          assert.equal(
            oldParser.parseDeliveryReceiptResult(broadcastRow!.result).receipts.length,
            broadcastRow!.result.receipts.length,
            "old parser reads the broadcast wire from real Postgres (member rows only)",
          );
          assert.throws(
            () => oldParser.parseDeliveryReceiptResult({
              ...broadcastRow!.result,
              receipts: [
                ...broadcastRow!.result.receipts,
                ...(broadcastRow!.result.broadcast_roster?.agents.principals ?? []),
              ],
            }),
            /malformed|agent recipient/i,
            "control: the pre-fold shape (agent tracking rows in receipts) must throw",
          );
        } finally {
          oldParser.dispose();
        }

        assert.deepEqual(agentRow?.result.addressed, true);
        assert.deepEqual(agentRow?.result.receipts.length, 1);
        assert.deepEqual(
          agentRow?.result.receipts[0]?.recipient_agent_principal_id,
          recipient,
        );
        assert.equal(broadcastRow?.result.addressed, false);
        assert.equal(
          broadcastRow?.result.receipts.filter((row) => row.recipient_user_id).length,
          1,
        );
        assert.equal(
          broadcastRow?.result.receipts.filter((row) =>
            row.recipient_agent_principal_id !== undefined
          ).length,
          0,
          "a broadcast's receipts must hold member rows only",
        );
        assert.deepEqual(broadcastRow?.result.broadcast_roster?.members, {
          total: 1,
          seen: 0,
          returned: 1,
          limit: 50,
          truncated: false,
        });
        assert.deepEqual(agentCounts(broadcastRow?.result.broadcast_roster?.agents), {
          total: 3,
          seen: 0,
          returned: 3,
          limit: 50,
          truncated: false,
          tracking_state: "not_tracked",
        });
        const broadcastPrincipals = broadcastRow!.result.broadcast_roster!.agents.principals;
        assert.equal(broadcastPrincipals.length, 3);
        assert.ok(broadcastPrincipals.every((row) =>
          row.principal_id === row.recipient_agent_principal_id &&
          row.seen_at === null && row.tracking_state === "not_tracked" &&
          row.observed_at === null
        ));
        assert.equal(crossSenderRow?.result, null);

        await tx`
          SELECT set_config(
            'request.jwt.claims',
            ${JSON.stringify({ sub: userId, role: "authenticated" })},
            true
          )
        `;
        await tx.unsafe("SET LOCAL ROLE authenticated");
        const [humanRow] = await tx<{ result: ReceiptResult }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid,
            ${humanSignal}::uuid,
            NULL
          ) AS result
        `;
        assert.deepEqual(humanRow?.result.addressed, true);
        assert.deepEqual(humanRow?.result.receipts.length, 1);
        assert.deepEqual(
          humanRow?.result.receipts[0]?.recipient_agent_principal_id,
          recipient,
        );

        const [humanAgentRow] = await tx<{ result: ReceiptResult }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid,
            ${agentSignal}::uuid,
            NULL
          ) AS result
        `;
        assert.deepEqual(humanAgentRow?.result.addressed, true);
        assert.deepEqual(humanAgentRow?.result.receipts.length, 1);

        await tx.unsafe("RESET ROLE");
        await tx`
          SELECT set_config(
            'request.jwt.claims',
            ${JSON.stringify({ sub: nonMemberId, role: "authenticated" })},
            true
          )
        `;
        await tx.unsafe("SET LOCAL ROLE authenticated");
        const [nonMemberRow] = await tx<{ result: unknown }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid,
            ${agentSignal}::uuid,
            NULL
          ) AS result
        `;
        await tx.unsafe("RESET ROLE");
        assert.equal(nonMemberRow?.result, null);

        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end();
  }
});

test("human seen upsert keeps first time and receipt reads keep the authorization matrix", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const userId = randomUUID();
  const otherMemberId = randomUUID();
  const thirdMemberId = randomUUID();
  const revokedMemberId = randomUUID();
  const nonMemberId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const deviceId = randomUUID();
  const sender = randomUUID();
  const otherSender = randomUUID();
  const agentRecipient = randomUUID();
  const runId = randomUUID();
  const otherRunId = randomUUID();
  const token = randomBytes(32);
  const otherToken = randomBytes(32);
  const directSignal = randomUUID();
  const broadcastSignal = randomUUID();
  const otherHumanSignal = randomUUID();
  const agentSignal = randomUUID();
  const revokedSignal = randomUUID();
  const foreignSignal = randomUUID();
  const unknownSignal = randomUUID();

  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        for (const id of [
          userId,
          otherMemberId,
          thirdMemberId,
          revokedMemberId,
          nonMemberId,
        ]) {
          await tx`
            INSERT INTO auth.users (
              id, aud, role, email, encrypted_password, email_confirmed_at,
              raw_app_meta_data, raw_user_meta_data, created_at, updated_at
            ) VALUES (
              ${id}::uuid, 'authenticated', 'authenticated',
              ${`human-seen-${id}@example.test`}, '', statement_timestamp(),
              '{}'::jsonb, '{}'::jsonb, statement_timestamp(), statement_timestamp()
            )
          `;
        }
        await tx`
          INSERT INTO swarm.users (user_id, display_name)
          VALUES
            (${userId}::uuid, 'Seen recipient'),
            (${otherMemberId}::uuid, 'Other member'),
            (${thirdMemberId}::uuid, 'Third member'),
            (${revokedMemberId}::uuid, 'Revoked member'),
            (${nonMemberId}::uuid, 'Non-member')
        `;
        await tx`
          INSERT INTO swarm.devices (device_id, user_id, label)
          VALUES (${deviceId}::uuid, ${userId}::uuid, 'human-seen-test')
        `;
        await tx`
          INSERT INTO swarm.workspaces (workspace_id, name, created_by)
          VALUES
            (${workspaceId}::uuid, 'Human receipt workspace', ${userId}::uuid),
            (${otherWorkspaceId}::uuid, 'Other receipt workspace', ${userId}::uuid)
        `;
        await tx`
          INSERT INTO swarm.memberships (
            workspace_id, user_id, role, revoked_at
          ) VALUES
            (${workspaceId}::uuid, ${userId}::uuid, 'owner', NULL),
            (${workspaceId}::uuid, ${otherMemberId}::uuid, 'member', NULL),
            (${workspaceId}::uuid, ${thirdMemberId}::uuid, 'member', NULL),
            (${workspaceId}::uuid, ${revokedMemberId}::uuid, 'member', statement_timestamp()),
            (${otherWorkspaceId}::uuid, ${userId}::uuid, 'owner', NULL)
        `;
        await tx`
          INSERT INTO swarm.agent_principals (
            principal_id, workspace_id, owner_user_id, name
          ) VALUES
            (${sender}::uuid, ${workspaceId}::uuid, ${userId}::uuid, 'human-sender'),
            (${otherSender}::uuid, ${workspaceId}::uuid, ${userId}::uuid, 'other-sender'),
            (${agentRecipient}::uuid, ${workspaceId}::uuid, ${userId}::uuid, 'agent-recipient')
        `;
        await tx`
          INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
          VALUES
            (${runId}::uuid, ${sender}::uuid, ${deviceId}::uuid),
            (${otherRunId}::uuid, ${otherSender}::uuid, ${deviceId}::uuid)
        `;
        await tx`
          INSERT INTO swarm.agent_tokens (
            token_id, principal_id, run_id, scopes, token_hash,
            expires_at, lineage_id
          ) VALUES
            (
              ${randomUUID()}::uuid, ${sender}::uuid, ${runId}::uuid,
              '["post_signal"]'::jsonb, ${token},
              statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
            ),
            (
              ${randomUUID()}::uuid, ${otherSender}::uuid, ${otherRunId}::uuid,
              '["post_signal"]'::jsonb, ${otherToken},
              statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
            )
        `;
        await tx`
          INSERT INTO swarm.signals (
            id, workspace_id, from_principal, from_kind,
            to_user_id, to_agent_principal_id, kind, body, until
          ) VALUES
            (
              ${directSignal}::uuid, ${workspaceId}::uuid, ${sender}::uuid, 'agent',
              ${userId}::uuid, NULL, 'ask', 'direct to recipient',
              statement_timestamp() + interval '1 hour'
            ),
            (
              ${broadcastSignal}::uuid, ${workspaceId}::uuid, ${sender}::uuid, 'agent',
              NULL, NULL, 'note', 'broadcast to members',
              statement_timestamp() + interval '1 hour'
            ),
            (
              ${otherHumanSignal}::uuid, ${workspaceId}::uuid, ${sender}::uuid, 'agent',
              ${otherMemberId}::uuid, NULL, 'ask', 'direct to another member',
              statement_timestamp() + interval '1 hour'
            ),
            (
              ${agentSignal}::uuid, ${workspaceId}::uuid, ${sender}::uuid, 'agent',
              NULL, ${agentRecipient}::uuid, 'ask', 'direct to an agent',
              statement_timestamp() + interval '1 hour'
            ),
            (
              ${revokedSignal}::uuid, ${workspaceId}::uuid, ${sender}::uuid, 'agent',
              ${revokedMemberId}::uuid, NULL, 'ask', 'direct to revoked member',
              statement_timestamp() + interval '1 hour'
            ),
            (
              ${foreignSignal}::uuid, ${otherWorkspaceId}::uuid, ${userId}::uuid, 'user',
              ${userId}::uuid, NULL, 'note', 'foreign workspace row',
              statement_timestamp() + interval '1 hour'
            )
        `;

        await tx`
          SELECT set_config(
            'request.jwt.claims',
            ${JSON.stringify({ sub: userId, role: "authenticated" })},
            true
          )
        `;
        await tx.unsafe("SET LOCAL ROLE authenticated");
        const [beforeSeen] = await tx<{ result: ReceiptResult }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid, ${directSignal}::uuid, NULL
          ) AS result
        `;
        await tx.unsafe("RESET ROLE");
        assert.deepEqual(beforeSeen?.result.receipts, [{
          recipient_user_id: userId,
          seen_at: null,
        }]);

        await tx.unsafe("SET LOCAL ROLE swarm_command");
        const first = await markHumanSignalsSeen(tx, {
          workspaceId,
          userId,
          signalIds: [directSignal, broadcastSignal, foreignSignal, unknownSignal],
        });
        await tx.unsafe("RESET ROLE");
        assert.deepEqual(first, { status: "accepted", matched: 2 });
        const firstRows = await tx<{
          signal_id: string;
          first_seen_at: Date;
        }[]>`
          SELECT signal_id, first_seen_at
          FROM swarm.signal_human_receipts
          WHERE workspace_id = ${workspaceId}::uuid
            AND user_id = ${userId}::uuid
          ORDER BY signal_id
        `;
        assert.equal(firstRows.length, 2);

        await tx`SELECT pg_sleep(0.01)`;
        await tx.unsafe("SET LOCAL ROLE swarm_command");
        const repeated = await markHumanSignalsSeen(tx, {
          workspaceId,
          userId,
          signalIds: [broadcastSignal, directSignal],
        });
        await tx.unsafe("RESET ROLE");
        assert.deepEqual(repeated, { status: "accepted", matched: 2 });
        const repeatedRows = await tx<{
          signal_id: string;
          first_seen_at: Date;
        }[]>`
          SELECT signal_id, first_seen_at
          FROM swarm.signal_human_receipts
          WHERE workspace_id = ${workspaceId}::uuid
            AND user_id = ${userId}::uuid
          ORDER BY signal_id
        `;
        assert.deepEqual(
          repeatedRows.map((row) => [row.signal_id, row.first_seen_at.toISOString()]),
          firstRows.map((row) => [row.signal_id, row.first_seen_at.toISOString()]),
          "idempotent upsert must keep the first server timestamp",
        );

        await tx.unsafe("SET LOCAL ROLE swarm_command");
        const notRecipient = await markHumanSignalsSeen(tx, {
          workspaceId,
          userId,
          signalIds: [otherHumanSignal],
        });
        const agentTarget = await markHumanSignalsSeen(tx, {
          workspaceId,
          userId,
          signalIds: [agentSignal],
        });
        const nonMember = await markHumanSignalsSeen(tx, {
          workspaceId,
          userId: nonMemberId,
          signalIds: [broadcastSignal],
        });
        await tx.unsafe("RESET ROLE");
        assert.deepEqual(notRecipient, { status: "forbidden", matched: 0 });
        assert.deepEqual(agentTarget, { status: "forbidden", matched: 0 });
        assert.deepEqual(nonMember, { status: "forbidden", matched: 0 });

        await tx.unsafe("SET LOCAL ROLE swarm_command");
        await assert.rejects(
          tx.savepoint(async (sp) => {
            await sp`
              INSERT INTO swarm.signal_human_receipts (
                workspace_id, signal_id, user_id
              ) VALUES (
                ${workspaceId}::uuid, ${revokedSignal}::uuid, ${revokedMemberId}::uuid
              )
            `;
          }),
          /row-level security policy/,
        );
        await tx.unsafe("RESET ROLE");

        await tx`
          SELECT set_config(
            'request.jwt.claims',
            ${JSON.stringify({ sub: userId, role: "authenticated" })},
            true
          )
        `;
        await tx.unsafe("SET LOCAL ROLE authenticated");
        const [directRead] = await tx<{ result: ReceiptResult }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid, ${directSignal}::uuid, NULL
          ) AS result
        `;
        const [broadcastRead] = await tx<{ result: ReceiptResult }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid, ${broadcastSignal}::uuid, NULL
          ) AS result
        `;
        await tx.unsafe("RESET ROLE");
        assert.equal(directRead?.result.addressed, true);
        assert.equal(directRead?.result.receipts[0]?.recipient_user_id, userId);
        assert.ok(directRead?.result.receipts[0]?.seen_at);
        assert.deepEqual(broadcastRead?.result.addressed, false);
        const broadcastMembers = broadcastRead!.result.receipts.filter((row) =>
          row.recipient_user_id !== undefined
        );
        const broadcastAgents = broadcastRead!.result.broadcast_roster!.agents.principals;
        assert.equal(
          broadcastRead!.result.receipts.filter((row) =>
            row.recipient_agent_principal_id !== undefined
          ).length,
          0,
          "a broadcast's receipts must hold member rows only",
        );
        assert.deepEqual(
          broadcastMembers.map((row) => ({
            id: row.recipient_user_id,
            name: row.display_name,
            seen: row.seen_at === null ? null : "seen",
          })),
          [{ id: userId,
            name: "Seen recipient",
            seen: "seen",
          }, { id: otherMemberId, name: "Other member", seen: null }, {
            id: thirdMemberId,
            name: "Third member",
            seen: null,
          }],
          "broadcast must start from all three live memberships, not one attestation",
        );
        assert.equal(broadcastAgents.length, 3);
        assert.ok(broadcastAgents.every((row) =>
          row.principal_id === row.recipient_agent_principal_id &&
          row.seen_at === null && row.tracking_state === "not_tracked" &&
          row.observed_at === null
        ));
        assert.deepEqual(broadcastRead?.result.broadcast_roster?.members, {
          total: 3,
          seen: 1,
          returned: 3,
          limit: 50,
          truncated: false,
        });
        assert.deepEqual(agentCounts(broadcastRead?.result.broadcast_roster?.agents), {
          total: 3,
          seen: 0,
          returned: 3,
          limit: 50,
          truncated: false,
          tracking_state: "not_tracked",
        });

        const capMemberIds = Array.from({ length: 49 }, () => randomUUID());
        await tx`
          INSERT INTO auth.users (
            id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at
          )
          SELECT
            cap.id,
            'authenticated',
            'authenticated',
            cap.id::text || '@cap.example.test',
            '',
            statement_timestamp(),
            '{}'::jsonb,
            '{}'::jsonb,
            statement_timestamp(),
            statement_timestamp()
          FROM unnest(${capMemberIds}::uuid[]) WITH ORDINALITY AS cap(id, ordinal)
        `;
        await tx`
          INSERT INTO swarm.users (user_id, display_name)
          SELECT
            cap.id,
            'Cap member ' || lpad(cap.ordinal::text, 2, '0')
          FROM unnest(${capMemberIds}::uuid[]) WITH ORDINALITY AS cap(id, ordinal)
        `;
        await tx`
          INSERT INTO swarm.memberships (workspace_id, user_id, role)
          SELECT ${workspaceId}::uuid, cap.id, 'member'
          FROM unnest(${capMemberIds}::uuid[]) AS cap(id)
        `;

        await tx`
          SELECT set_config(
            'request.jwt.claims',
            ${JSON.stringify({ sub: userId, role: "authenticated" })},
            true
          )
        `;
        await tx.unsafe("SET LOCAL ROLE authenticated");
        const [cappedBroadcastRead] = await tx<{ result: ReceiptResult }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid, ${broadcastSignal}::uuid, NULL
          ) AS result
        `;
        await tx.unsafe("RESET ROLE");
        const cappedMembers = cappedBroadcastRead!.result.receipts.filter((row) =>
          row.recipient_user_id !== undefined
        );
        assert.equal(cappedMembers.length, 50);
        /* G1: the fixture builds the discriminating case on purpose — the one seen
         * member ("Seen recipient") sorts 51st of 52 by name, so a name-only
         * ORDER BY would cut it while the summary still said "Seen by 1 of 52".
         * Without this line, deleting `human.first_seen_at IS NULL` from the
         * ORDER BY leaves the test green. */
        assert.ok(
          cappedMembers.some((row) => row.seen_at !== null),
          "the seen member must survive the cap",
        );
        assert.deepEqual(cappedBroadcastRead?.result.broadcast_roster?.members, {
          total: 52,
          seen: 1,
          returned: 50,
          limit: 50,
          truncated: true,
        });

        await tx`SELECT set_config('request.jwt.claims', '', true)`;
        await tx.unsafe("SET LOCAL ROLE swarm_read");
        const [agentAuthorRead] = await tx<{ result: ReceiptResult }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid, ${directSignal}::uuid, ${token}
          ) AS result
        `;
        const [agentCrossSenderRead] = await tx<{ result: unknown }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid, ${directSignal}::uuid, ${otherToken}
          ) AS result
        `;
        const [agentBroadcastAuthorRead] = await tx<{ result: ReceiptResult }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid, ${broadcastSignal}::uuid, ${token}
          ) AS result
        `;
        const [agentBroadcastCrossSenderRead] = await tx<{ result: unknown }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid, ${broadcastSignal}::uuid, ${otherToken}
          ) AS result
        `;
        await tx.unsafe("RESET ROLE");
        assert.equal(agentAuthorRead?.result.receipts[0]?.recipient_user_id, userId);
        assert.ok(agentAuthorRead?.result.receipts[0]?.seen_at);
        assert.equal(agentCrossSenderRead?.result, null);
        assert.equal(agentBroadcastAuthorRead?.result.addressed, false);
        assert.equal(agentBroadcastAuthorRead?.result.broadcast_roster?.members.total, 52);
        assert.equal(agentBroadcastCrossSenderRead?.result, null);

        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end();
  }
});

test("queued receipt count stays inside its recipient and workspace, then observation removes it", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const deviceId = randomUUID();
  const recipient = randomUUID();
  const sameWorkspaceOtherRecipient = randomUUID();
  const otherWorkspaceRecipient = randomUUID();
  const signalId = randomUUID();
  const sameRecipientSignalId = randomUUID();
  const sameWorkspaceOtherSignalId = randomUUID();
  const otherWorkspaceSignalId = randomUUID();
  const leaseId = randomUUID();
  const listenerInstanceId = randomUUID();

  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`
          INSERT INTO auth.users (
            id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at
          ) VALUES (
            ${userId}::uuid, 'authenticated', 'authenticated',
            ${`observed-${userId}@example.test`}, '', statement_timestamp(),
            '{}'::jsonb, '{}'::jsonb, statement_timestamp(), statement_timestamp()
          )
        `;
        await tx`
          INSERT INTO swarm.users (user_id, display_name)
          VALUES (${userId}::uuid, 'Observed owner')
        `;
        await tx`
          INSERT INTO swarm.devices (device_id, user_id, label)
          VALUES (${deviceId}::uuid, ${userId}::uuid, 'observed-test')
        `;
        await tx`
          INSERT INTO swarm.workspaces (workspace_id, name, created_by)
          VALUES
            (${workspaceId}::uuid, 'Observed workspace', ${userId}::uuid),
            (${otherWorkspaceId}::uuid, 'Other workspace', ${userId}::uuid)
        `;
        await tx`
          INSERT INTO swarm.memberships (workspace_id, user_id, role)
          VALUES
            (${workspaceId}::uuid, ${userId}::uuid, 'owner'),
            (${otherWorkspaceId}::uuid, ${userId}::uuid, 'owner')
        `;
        await tx`
          INSERT INTO swarm.agent_principals (
            principal_id, workspace_id, owner_user_id, name
          ) VALUES
            (
              ${recipient}::uuid, ${workspaceId}::uuid,
              ${userId}::uuid, 'recipient'
            ),
            (
              ${sameWorkspaceOtherRecipient}::uuid, ${workspaceId}::uuid,
              ${userId}::uuid, 'same-workspace other recipient'
            ),
            (
              ${otherWorkspaceRecipient}::uuid, ${otherWorkspaceId}::uuid,
              ${userId}::uuid, 'other-workspace recipient'
            )
        `;
        await tx`
          INSERT INTO swarm.signals (
            id, workspace_id, from_principal, from_kind,
            to_agent_principal_id, kind, body, until
          ) VALUES
            (
              ${signalId}::uuid, ${workspaceId}::uuid,
              ${userId}::uuid, 'user', ${recipient}::uuid,
              'ask', 'show this at the next prompt',
              statement_timestamp() + interval '1 hour'
            ),
            (
              ${sameRecipientSignalId}::uuid, ${workspaceId}::uuid,
              ${userId}::uuid, 'user', ${recipient}::uuid,
              'ask', 'second queued delivery for this recipient',
              statement_timestamp() + interval '1 hour'
            ),
            (
              ${sameWorkspaceOtherSignalId}::uuid, ${workspaceId}::uuid,
              ${userId}::uuid, 'user', ${sameWorkspaceOtherRecipient}::uuid,
              'ask', 'queued for a different recipient in this workspace',
              statement_timestamp() + interval '1 hour'
            ),
            (
              ${otherWorkspaceSignalId}::uuid, ${otherWorkspaceId}::uuid,
              ${userId}::uuid, 'user', ${otherWorkspaceRecipient}::uuid,
              'ask', 'queued in a different workspace',
              statement_timestamp() + interval '1 hour'
            )
        `;
        await tx`
          UPDATE swarm.signal_deliveries
          SET
            lease_id = ${leaseId}::uuid,
            leased_by = ${listenerInstanceId}::uuid,
            leased_until = statement_timestamp() + interval '15 minutes',
            delivered_at = statement_timestamp(),
            attempt_count = 1,
            updated_at = statement_timestamp()
          WHERE signal_id IN (
            ${signalId}::uuid,
            ${sameRecipientSignalId}::uuid,
            ${sameWorkspaceOtherSignalId}::uuid,
            ${otherWorkspaceSignalId}::uuid
          )
        `;

        const deliveries = [
          { workspaceId, recipientPrincipalId: recipient, signalId },
          {
            workspaceId,
            recipientPrincipalId: recipient,
            signalId: sameRecipientSignalId,
          },
          {
            workspaceId,
            recipientPrincipalId: sameWorkspaceOtherRecipient,
            signalId: sameWorkspaceOtherSignalId,
          },
          {
            workspaceId: otherWorkspaceId,
            recipientPrincipalId: otherWorkspaceRecipient,
            signalId: otherWorkspaceSignalId,
          },
        ];
        for (const delivery of deliveries) {
          const queued = await ackAgentDelivery(tx, {
            ...delivery,
            leaseId,
            listenerInstanceId,
            outcome: "queued",
            lastErrorCode: null,
          });
          assert.equal(queued.status, "accepted");
        }
        const [queuedRow] = await tx<{ ack_outcome: string; acked_at: Date }[]>`
          SELECT ack_outcome, acked_at
          FROM swarm.signal_deliveries
          WHERE signal_id = ${signalId}::uuid
            AND recipient_agent_principal_id = ${recipient}::uuid
        `;
        assert.equal(queuedRow?.ack_outcome, "queued");

        await tx`
          SELECT set_config(
            'request.jwt.claims',
            ${JSON.stringify({ sub: userId, role: "authenticated" })},
            true
          )
        `;
        await tx.unsafe("SET LOCAL ROLE authenticated");
        const [queuedReceiptRow] = await tx<{
          result: {
            receipts: Array<{
              ack_outcome: string;
              pending_for_main_count?: number;
            }>;
          };
        }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid,
            ${signalId}::uuid,
            NULL
          ) AS result
        `;
        await tx.unsafe("RESET ROLE");
        const queuedReceipt = queuedReceiptRow?.result.receipts[0];
        assert.equal(queuedReceipt?.ack_outcome, "queued");
        assert.equal(queuedReceipt?.pending_for_main_count, 2);
        assert.equal(
          Object.hasOwn(queuedReceipt ?? {}, "pending_for_main_count"),
          true,
        );

        await tx`SELECT pg_sleep(0.01)`;
        const observed = await ackAgentDelivery(tx, {
          workspaceId,
          recipientPrincipalId: recipient,
          signalId,
          leaseId: null,
          listenerInstanceId: null,
          outcome: "observed",
          lastErrorCode: null,
        });
        assert.equal(observed.status, "accepted");
        const [observedRow] = await tx<{ ack_outcome: string; acked_at: Date }[]>`
          SELECT ack_outcome, acked_at
          FROM swarm.signal_deliveries
          WHERE signal_id = ${signalId}::uuid
            AND recipient_agent_principal_id = ${recipient}::uuid
        `;
        assert.equal(observedRow?.ack_outcome, "observed");
        assert.ok(observedRow!.acked_at > queuedRow!.acked_at);

        await tx`
          SELECT set_config(
            'request.jwt.claims',
            ${JSON.stringify({ sub: userId, role: "authenticated" })},
            true
          )
        `;
        await tx.unsafe("SET LOCAL ROLE authenticated");
        const [receiptRow] = await tx<{
          result: { receipts: Array<{ ack_outcome: string }> };
        }[]>`
          SELECT swarm_read.signal_delivery_receipts(
            ${workspaceId}::uuid,
            ${signalId}::uuid,
            NULL
          ) AS result
        `;
        await tx.unsafe("RESET ROLE");
        const observedReceipt = receiptRow?.result.receipts[0];
        assert.equal(observedReceipt?.ack_outcome, "observed");
        assert.equal(
          Object.hasOwn(observedReceipt ?? {}, "pending_for_main_count"),
          false,
        );

        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end();
  }
});
