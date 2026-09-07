/**
 * Real-Postgres idempotency key retention floor verification (L2b).
 *
 * This file is reached only by `npm run test:p1-local`. Running it requires an
 * announced exclusive local database slot.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";

interface LocalEnvironment {
  DB_URL: string;
}

function environment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(parsed.DB_URL, "local Supabase must expose DB_URL");
  return parsed as LocalEnvironment;
}

let local: LocalEnvironment;
let sql: ReturnType<typeof postgres>;
const insertedCommandIds: string[] = [];

before(async () => {
  local = environment();
  sql = postgres(local.DB_URL, { max: 1 });
});

after(async () => {
  try {
    if (insertedCommandIds.length > 0) {
      await sql`
        DELETE FROM swarm.idempotency_keys
        WHERE command_id = ANY(${insertedCommandIds})
      `;
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
});

test("swarm.purge_expired_idempotency_keys purges 3-day-old row and retains 1-day-old row", async () => {
  const oldCommandId = randomUUID();
  const recentCommandId = randomUUID();
  insertedCommandIds.push(oldCommandId, recentCommandId);

  const principalId = randomUUID();
  const workspaceId = randomUUID();
  const streamId = randomUUID();

  await sql`
    INSERT INTO swarm.idempotency_keys (
      principal_kind, principal_id, command_id,
      workspace_id, stream_id, request_hash, response, created_at
    ) VALUES
      (
        'agent', ${principalId}, ${oldCommandId},
        ${workspaceId}::uuid, ${streamId}::uuid, 'test-hash-old', '{"ok":true}'::jsonb,
        statement_timestamp() - interval '3 days'
      ),
      (
        'agent', ${principalId}, ${recentCommandId},
        ${workspaceId}::uuid, ${streamId}::uuid, 'test-hash-recent', '{"ok":true}'::jsonb,
        statement_timestamp() - interval '1 day'
      )
  `;

  // Verify initial insertion
  const initialRows = await sql<{ command_id: string }[]>`
    SELECT command_id FROM swarm.idempotency_keys
    WHERE command_id IN (${oldCommandId}, ${recentCommandId})
  `;
  assert.equal(initialRows.length, 2, "both test rows should exist before purge");

  // Execute purge function
  await sql`SELECT swarm.purge_expired_idempotency_keys()`;

  // Verify purge outcomes: 3-day-old removed, 1-day-old kept
  const remainingRows = await sql<{ command_id: string }[]>`
    SELECT command_id FROM swarm.idempotency_keys
    WHERE command_id IN (${oldCommandId}, ${recentCommandId})
  `;
  const remainingIds = remainingRows.map((row) => row.command_id);

  assert.equal(
    remainingIds.includes(oldCommandId),
    false,
    "3-day-old idempotency key row must be removed by purge",
  );
  assert.equal(
    remainingIds.includes(recentCommandId),
    true,
    "1-day-old idempotency key row must be kept after purge",
  );
  assert.deepEqual(
    remainingIds,
    [recentCommandId],
    "only the 1-day-old idempotency key row must remain",
  );
});
