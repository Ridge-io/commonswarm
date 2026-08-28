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

interface LocalEnvironment {
  DB_URL: string;
}

interface ReceiptResult {
  addressed: boolean;
  receipts: Array<{ recipient_agent_principal_id: string }>;
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

test("delivery receipts work for agent, human, broadcast, and cross-sender paths", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const userId = randomUUID();
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
          ) VALUES (
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
          )
        `;
        await tx`
          INSERT INTO swarm.users (user_id, display_name)
          VALUES (${userId}::uuid, 'Receipt owner')
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

        assert.deepEqual(agentRow?.result.addressed, true);
        assert.deepEqual(agentRow?.result.receipts.length, 1);
        assert.deepEqual(
          agentRow?.result.receipts[0]?.recipient_agent_principal_id,
          recipient,
        );
        assert.deepEqual(broadcastRow?.result, {
          addressed: false,
          receipts: [],
        });
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
        await tx.unsafe("RESET ROLE");

        assert.deepEqual(humanRow?.result.addressed, true);
        assert.deepEqual(humanRow?.result.receipts.length, 1);
        assert.deepEqual(
          humanRow?.result.receipts[0]?.recipient_agent_principal_id,
          recipient,
        );

        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end();
  }
});
