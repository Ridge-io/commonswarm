/**
 * Pins the idle-cost SQL migrations to the constants they enforce.
 *
 * Bound of this sweep: the SQL in
 * supabase/migrations/20260906000001_idle_cost_retention.sql and
 * supabase/migrations/20260906000002_file_versions_quota_index.sql.
 * There is no 20260906000003. It does not prove the functions run on a
 * live database; p1-server does that.
 *
 * Reached by `npm test` (named in the literal list).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { claimCommandId } from "../src/listener/delivery-journal.js";

const SQL_PATH = "supabase/migrations/20260906000001_idle_cost_retention.sql";
const INDEX_PATH = "supabase/migrations/20260906000002_file_versions_quota_index.sql";
const GONE_PATH = "supabase/migrations/20260906000003_idle_cost_round2.sql";
const INSTANCE_ID = "c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f";

function claimIdRegexFromMigration(sql: string): RegExp {
  const assigned = /claim_id_re text := '([^']+)'/.exec(sql);
  assert.ok(assigned?.[1], "migration assigns claim_id_re from disk");
  return new RegExp(assigned[1]);
}

test("file_versions quota index covers workspace, state, and created_at", () => {
  const sql = readFileSync(INDEX_PATH, "utf8");
  assert.match(sql, /file_versions_workspace_state_created/);
  assert.match(
    sql,
    /ON swarm\.file_versions \(workspace_id, state, created_at\)/,
  );
});

test("retention migration shortens claim-class idempotency only and never names audit_log", () => {
  assert.equal(existsSync(GONE_PATH), false);
  const sql = readFileSync(SQL_PATH, "utf8");
  assert.doesNotMatch(sql, /audit_log/);
  assert.doesNotMatch(sql, /claim_audit_retention_days/);
  assert.doesNotMatch(sql, /purge_idle_claim_audit/);
  assert.doesNotMatch(sql, /purge_idle_cost_tables/);
  assert.doesNotMatch(sql, /cron\.schedule/);
  assert.match(sql, /claim_idempotency_retention_days',\s*'2'/);
  assert.match(sql, /GREATEST\(\s*2,/);
  assert.match(sql, /GREATEST\(\s*30,/);
  assert.doesNotMatch(sql, /claim_agent_inbox_%/);
  assert.doesNotMatch(sql, /command_id LIKE/);
  assert.match(sql, /claim_id_re text := '\^claim_\[0-9a-f\]\{32\}_\[0-9a-z\]\+\$'/);
  assert.match(sql, /command_id ~ claim_id_re/);
  assert.match(sql, /command_id !~ claim_id_re/);
  assert.match(sql, /rate_buckets_window_start/);
  assert.match(sql, /purge_expired_idempotency_keys/);
  assert.doesNotMatch(sql, /batch_size integer DEFAULT/);
  assert.match(sql, /purge_expired_idempotency_keys\(\s*batch_size integer\s*\)/);
});

test("claim-class purge regex matches claimCommandId and rejects claim_agent_inbox_x", () => {
  const sql = readFileSync(SQL_PATH, "utf8");
  const fromDisk = claimIdRegexFromMigration(sql);
  const id = claimCommandId(INSTANCE_ID, 0);
  assert.equal(id, "claim_c3d4e5f6a7b84c9d8e1f2a3b4c5d6e7f_0");
  assert.match(id, fromDisk);
  assert.match(claimCommandId(INSTANCE_ID, 10), fromDisk);
  assert.match(claimCommandId(INSTANCE_ID, 36), fromDisk);
  assert.doesNotMatch("claim_agent_inbox_x", fromDisk);
  assert.equal(/^claim_agent_inbox_/.test(id), false);
});
