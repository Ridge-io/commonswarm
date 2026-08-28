import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  classifyCommandFailure,
  dbCode,
  durableCommandFailure,
  finishCommandFailure,
  type DurableCommandFailure,
} from "../supabase/functions/command/failures.js";

const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20260827000002_command_failures.sql",
);
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

test("command failure writes exactly one classified row with its SQLSTATE", async () => {
  const original = Object.assign(new Error("deadlock detected"), { code: "40P01" });
  const code = dbCode(original);
  const failure = durableCommandFailure({
    commandKind: "post_signal",
    reason: classifyCommandFailure(false, code),
    code,
    error: original,
    requestId: REQUEST_ID,
  });
  const inserted: DurableCommandFailure[] = [];

  const result = await finishCommandFailure(failure, async (row) => {
    inserted.push(row);
  });

  assert.deepEqual(inserted, [{
    command_kind: "post_signal",
    reason: "internal_error",
    db_code: "40P01",
    detail: "Error: deadlock detected",
    request_id: REQUEST_ID,
  }]);
  assert.deepEqual(result, { status: 500, body: { error: "internal_error" } });
});

test("a diagnostic insert failure cannot replace the original 500 response", async () => {
  const failure = durableCommandFailure({
    commandKind: "post_signal",
    reason: "internal_error",
    code: "XX000",
    error: new Error("the original failure"),
    requestId: REQUEST_ID,
  });
  let attempts = 0;
  const result = await finishCommandFailure(
    failure,
    async () => {
      attempts += 1;
      throw new Error("diagnostic table unavailable");
    },
    () => {
      throw new Error("even the fallback logger is broken");
    },
  );

  assert.equal(attempts, 1);
  assert.deepEqual(result, {
    status: 500,
    body: { error: "internal_error" },
  });
});

test("credentials and signal input are not fields of the durable row", () => {
  const token = `swm_agt_${"A".repeat(43)}`;
  const signalBody = "SECRET signal body that must not be durable";
  const request = {
    authorization: `Bearer ${token}`,
    command: {
      kind: "post_signal",
      signal_kind: "note",
      body: signalBody,
    },
  };
  const failure = durableCommandFailure({
    commandKind: String(request.command.kind),
    reason: "test_rollback",
    code: null,
    error: new Error("test rollback before step 15\u0000"),
    requestId: REQUEST_ID,
  });
  const stored = JSON.stringify(failure);

  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes(signalBody), false);
  assert.equal(stored.includes("authorization"), false);
  assert.equal(stored.includes("body"), false);
  assert.equal(failure.detail.includes("\u0000"), false);
  assert.ok(failure.detail.length <= 512);
});

function retainedIdsFromMigration(
  migration: string,
  now: Date,
  rows: Array<{ id: string; occurredAt: Date }>,
): string[] {
  const predicate = /WHERE occurred_at\s*([<>])\s*statement_timestamp\(\)\s*-\s*interval '(\d+) days'/u
    .exec(migration);
  assert.ok(predicate, "the purge predicate must stay directly observable");
  const operator = predicate[1];
  const days = Number(predicate[2]);
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return rows
    .filter((row) => {
      const deleted = operator === "<"
        ? row.occurredAt.getTime() < cutoff
        : row.occurredAt.getTime() > cutoff;
      return !deleted;
    })
    .map((row) => row.id);
}

test("the bounded purge removes old failures and leaves fresh failures", () => {
  const migration = readFileSync(MIGRATION, "utf8");
  const now = new Date("2026-08-27T12:00:00.000Z");
  const retained = retainedIdsFromMigration(migration, now, [
    { id: "old", occurredAt: new Date("2026-07-01T00:00:00.000Z") },
    { id: "fresh", occurredAt: new Date("2026-08-27T11:59:00.000Z") },
  ]);

  assert.deepEqual(retained, ["fresh"]);
  assert.match(migration, /CREATE OR REPLACE FUNCTION swarm\.purge_command_failures\(\)/u);
  assert.match(migration, /SECURITY DEFINER/u);
  assert.match(migration, /'swarm-purge-command-failures'/u);
  assert.match(migration, /'SELECT swarm\.purge_command_failures\(\)'/u);
});

test("the edge catch uses one post-rollback insert and keeps retry policy unchanged", () => {
  const source = readFileSync(
    join(process.cwd(), "supabase/functions/command/index.ts"),
    "utf8",
  );
  const insertFunction = source.slice(
    source.indexOf("async function insertCommandFailure"),
    source.indexOf("async function handlePostRequest"),
  );
  const catchBlock = source.slice(source.lastIndexOf("  } catch (error) {"));

  assert.equal(
    (insertFunction.match(/INSERT INTO swarm\.command_failures/gu) ?? []).length,
    1,
  );
  assert.doesNotMatch(insertFunction, /await db\.begin/u);
  assert.match(catchBlock, /await finishCommandFailure/u);
  assert.match(catchBlock, /40001 \(serialization failure\)/u);
  assert.match(catchBlock, /40P01 \(deadlock\)/u);
  assert.match(catchBlock, /fall through to the existing 500/u);
});

test("the failure table is operator-read and agent-append only", () => {
  const migration = readFileSync(MIGRATION, "utf8");
  assert.match(migration, /ALTER TABLE swarm\.command_failures ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /GRANT INSERT ON TABLE swarm\.command_failures TO swarm_command/u);
  assert.match(migration, /GRANT USAGE ON SEQUENCE swarm\.command_failures_failure_id_seq TO swarm_command/u);
  assert.doesNotMatch(migration, /GRANT SELECT[\s\S]*command_failures[\s\S]*TO swarm_(?:command|read)/u);
  assert.doesNotMatch(migration, /CREATE (?:OR REPLACE )?VIEW swarm_read\./u);
});
