/**
 * Pins the idle-cost SQL migrations to the constants they enforce.
 *
 * Bound of this sweep: the SQL in
 * supabase/migrations/20260906000001_idle_cost_retention.sql and
 * supabase/migrations/20260906000002_file_versions_quota_index.sql.
 * It does not prove the functions run on a live database; p1-server does that.
 *
 * Reached by `npm test` (named in the literal list).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SQL_PATH = "supabase/migrations/20260906000001_idle_cost_retention.sql";

test("file_versions quota index covers workspace, state, and created_at", () => {
  const sql = readFileSync(
    "supabase/migrations/20260906000002_file_versions_quota_index.sql",
    "utf8",
  );
  assert.match(sql, /file_versions_workspace_state_created/);
  assert.match(
    sql,
    /ON swarm\.file_versions \(workspace_id, state, created_at\)/,
  );
});

test("retention migration deletes claim audits by kind after 7 days and batches idempotency", () => {
  const sql = readFileSync(SQL_PATH, "utf8");
  assert.match(sql, /claim_audit_retention_days',\s*'7'/);
  assert.match(sql, /GREATEST\(\s*7,/);
  assert.match(
    sql,
    /command_kind = 'claim_agent_inbox'/,
    "cannot distinguish empty vs leased historical rows; delete by kind",
  );
  assert.match(sql, /LIMIT batch_size/);
  assert.match(sql, /cron\.schedule\(\s*'swarm-purge-idle-cost'/);
  assert.match(sql, /BEFORE UPDATE ON swarm\.audit_log/);
  assert.doesNotMatch(
    sql,
    /BEFORE UPDATE OR DELETE ON swarm\.audit_log/,
  );
  assert.match(sql, /purge_idle_cost_tables/);
  assert.match(sql, /idempotency_retention_days/);
});
