/**
 * Pins the idle-cost SQL migrations to the constants they enforce.
 *
 * Bound of this sweep: the SQL in
 * supabase/migrations/20260906000001_idle_cost_retention.sql,
 * supabase/migrations/20260906000002_file_versions_quota_index.sql, and
 * supabase/migrations/20260906000003_idle_cost_round2.sql.
 * It does not prove the functions run on a live database; p1-server does that.
 *
 * Reached by `npm test` (named in the literal list).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ROUND2 = "supabase/migrations/20260906000003_idle_cost_round2.sql";

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

test("round-2 restores append-only audit and shortens claim-class idempotency only", () => {
  const sql = readFileSync(ROUND2, "utf8");
  assert.match(sql, /BEFORE UPDATE OR DELETE ON swarm\.audit_log/);
  assert.match(sql, /DROP FUNCTION IF EXISTS swarm\.purge_idle_claim_audit/);
  assert.match(sql, /DROP FUNCTION IF EXISTS swarm\.purge_idle_cost_tables/);
  assert.match(sql, /unschedule\(jobid\)/);
  assert.match(sql, /swarm-purge-idle-cost/);
  assert.match(sql, /claim_idempotency_retention_days',\s*'2'/);
  assert.match(sql, /GREATEST\(\s*2,/);
  assert.match(sql, /GREATEST\(\s*30,/);
  assert.match(sql, /command_id LIKE 'claim_agent_inbox_%'/);
  assert.match(sql, /rate_buckets_window_start/);
  assert.doesNotMatch(sql, /cron\.schedule\(\s*'swarm-purge-idle-cost'/);
});
