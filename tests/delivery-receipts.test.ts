import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  deliveryReceiptState,
  parseDeliveryReceiptResult,
  readAgentDeliveryReceipts,
  type DeliveryAckOutcome,
  type DeliveryReceipt,
  type DeliveryReceiptRow,
} from "../src/cloud/delivery-receipts.js";
import { cloudTarget } from "../src/cloud/config.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SIGNAL = "22222222-2222-4222-8222-222222222222";
const RECIPIENT = "33333333-3333-4333-8333-333333333333";
const RECIPIENT_2 = "44444444-4444-4444-8444-444444444444";
const ENQUEUED = "2026-08-28T12:00:00.000Z";
const DELIVERED = "2026-08-28T12:00:01.000Z";
const LEASED = "2026-08-28T12:10:00.000Z";
const ACKED = "2026-08-28T12:00:02.000Z";
const RECEIPT_MIGRATION =
  "supabase/migrations/20260902000001_broadcast_recipient_roster.sql";
const HUMAN_RECEIPT_MIGRATION =
  "supabase/migrations/20260901000020_signal_human_receipts.sql";

function broadcastRoster(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    members: { total: 0, seen: 0, returned: 0, limit: 50, truncated: false },
    agents: {
      total: 0,
      returned: 0,
      limit: 50,
      truncated: false,
      tracking_state: "not_tracked",
    },
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipient_agent_principal_id: RECIPIENT,
    enqueued_at: ENQUEUED,
    delivered_at: null,
    leased_until: null,
    acked_at: null,
    ack_outcome: null,
    attempt_count: 0,
    lease_expiry_count: 0,
    last_error_code: null,
    ...overrides,
  };
}

function response(body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

function agentReceipt(row: DeliveryReceiptRow): DeliveryReceipt {
  assert.ok(
    "recipient_agent_principal_id" in row && !("tracking_state" in row),
    "expected an agent delivery receipt row",
  );
  return row;
}

test("sender reads one minimal receipt per recipient through the agent read surface", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const fetcher: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      addressed: true,
      receipts: [receipt(), receipt({ recipient_agent_principal_id: RECIPIENT_2 })],
    }), { status: 200 });
  };
  const result = await readAgentDeliveryReceipts(
    cloudTarget("https://example.test", "anon"),
    `swm_agt_${"a".repeat(43)}`,
    WORKSPACE,
    SIGNAL,
    fetcher,
  );
  assert.deepEqual(requestBody, {
    resource: "delivery_receipts",
    workspace_id: WORKSPACE,
    signal_id: SIGNAL,
  });
  assert.equal(result.addressed, true);
  assert.deepEqual(
    result.receipts.map((row) => agentReceipt(row).recipient_agent_principal_id),
    [RECIPIENT, RECIPIENT_2],
  );
});

test("broadcast roster is distinguishable from an addressed pending delivery", async () => {
  const target = cloudTarget("https://example.test", "anon");
  const token = `swm_agt_${"a".repeat(43)}`;
  const broadcast = await readAgentDeliveryReceipts(
    target,
    token,
    WORKSPACE,
    SIGNAL,
    response({
      addressed: false,
      receipts: [],
      broadcast_roster: broadcastRoster(),
    }),
  );
  const pending = await readAgentDeliveryReceipts(
    target,
    token,
    WORKSPACE,
    SIGNAL,
    response({ addressed: true, receipts: [receipt()] }),
  );
  assert.deepEqual(broadcast, {
    addressed: false,
    receipts: [],
    broadcast_roster: {
      members: { total: 0, seen: 0, returned: 0, limit: 50, truncated: false },
      agents: {
        total: 0,
        returned: 0,
        limit: 50,
        truncated: false,
        tracking_state: "not_tracked",
      },
    },
  });
  assert.equal(pending.addressed, true);
  assert.equal(deliveryReceiptState(agentReceipt(pending.receipts[0]!)), "enqueued");
});

test("human receipt rows preserve not-seen and focused-viewport seen timestamps", () => {
  const notSeen = parseDeliveryReceiptResult({
    addressed: true,
    receipts: [{ recipient_user_id: RECIPIENT, seen_at: null }],
  });
  assert.deepEqual(notSeen.receipts, [{
    recipient_user_id: RECIPIENT,
    seen_at: null,
  }]);

  const seen = parseDeliveryReceiptResult({
    addressed: true,
    receipts: [{ recipient_user_id: RECIPIENT, seen_at: ACKED }],
  });
  assert.deepEqual(seen.receipts, [{
    recipient_user_id: RECIPIENT,
    seen_at: ACKED,
  }]);

  const broadcastSeen = parseDeliveryReceiptResult({
    addressed: false,
    receipts: [{
      recipient_user_id: RECIPIENT,
      display_name: "Seen member",
      seen_at: ACKED,
    }, {
      recipient_user_id: RECIPIENT_2,
      display_name: "Not-seen member",
      seen_at: null,
    }, {
      recipient_agent_principal_id: SIGNAL,
      display_name: "Agent row",
      tracking_state: "not_tracked",
      observed_at: null,
    }],
    broadcast_roster: broadcastRoster({
      members: { total: 2, seen: 1, returned: 2, limit: 50, truncated: false },
      agents: {
        total: 1,
        returned: 1,
        limit: 50,
        truncated: false,
        tracking_state: "not_tracked",
      },
    }),
  });
  assert.equal(broadcastSeen.addressed, false);
  assert.equal(broadcastSeen.receipts.length, 3);
  assert.equal(broadcastSeen.broadcast_roster?.members.seen, 1);
  assert.ok(
    broadcastSeen.receipts.some((row) =>
      "tracking_state" in row && row.tracking_state === "not_tracked"
    ),
  );
});

test("same-workspace different sender and another-workspace caller see no receipts", () => {
  const hidden = parseDeliveryReceiptResult({ addressed: null, receipts: [] });
  assert.deepEqual(hidden, { addressed: null, receipts: [] });
});

test("every ledger state stays distinct, including queued, observed, and replied", () => {
  const outcomes: readonly DeliveryAckOutcome[] = [
    "replied",
    "observed",
    "queued",
    "expired",
    "failed_terminal",
  ];
  assert.equal(
    deliveryReceiptState(agentReceipt(parseDeliveryReceiptResult({
      addressed: true,
      receipts: [receipt()],
    }).receipts[0]!)),
    "enqueued",
  );
  assert.equal(
    deliveryReceiptState(agentReceipt(parseDeliveryReceiptResult({
      addressed: true,
      receipts: [receipt({ delivered_at: DELIVERED })],
    }).receipts[0]!)),
    "delivered",
  );
  assert.equal(
    deliveryReceiptState(
      agentReceipt(parseDeliveryReceiptResult({
        addressed: true,
        receipts: [receipt({ delivered_at: DELIVERED, leased_until: LEASED })],
      }).receipts[0]!),
      Date.parse(DELIVERED),
    ),
    "leased",
  );
  for (const outcome of outcomes) {
    const parsed = parseDeliveryReceiptResult({
      addressed: true,
      receipts: [receipt({
        delivered_at: outcome === "expired" ? null : DELIVERED,
        acked_at: ACKED,
        ack_outcome: outcome,
      })],
    });
    assert.equal(deliveryReceiptState(agentReceipt(parsed.receipts[0]!)), outcome);
  }
});

test("agent cross-sender mutation control pins author id and workspace", async () => {
  const migration = await readFile(RECEIPT_MIGRATION, "utf8");
  assert.match(migration, /v_author_kind := 'agent';[\s\S]*v_author_id := v_agent_principal_id;/);
  assert.match(
    migration,
    /WHERE signal\.id = p_signal_id\s+AND signal\.workspace_id = p_workspace_id\s+AND \(\s+v_human_user_id IS NOT NULL\s+OR \(\s+signal\.from_kind = v_author_kind\s+AND signal\.from_principal = v_author_id\s+\)\s+\);/,
    "agent receipt lookup must bind the signal to the authenticated sender and workspace",
  );
  assert.match(
    migration,
    /p_agent_token_hash IS NOT NULL\s+OR NOT swarm\.is_member\(p_workspace_id, v_human_user_id\)/,
    "a human must use the JWT subject and cannot opt into agent-token identity",
  );
  assert.match(
    migration,
    /FROM swarm\.agent_delivery_read_context\([\s\S]*v_agent_workspace_id <> p_workspace_id/,
    "an agent must pass the existing credential and home-workspace gate",
  );
  assert.equal(
    migration.match(/signal\.from_kind = v_author_kind/g)?.length,
    1,
    "the author-kind predicate must exist only in the agent side of the human-or-agent gate",
  );
});

test("migration exposes only the receipt fields and grants only read callers", async () => {
  const migration = await readFile(RECEIPT_MIGRATION, "utf8");
  assert.match(migration, /SECURITY DEFINER\s+SET search_path = swarm, pg_catalog/);
  assert.match(
    migration,
    /current_setting\('request\.jwt\.claims', true\)/,
    "human identity must come from the transaction JWT claims without auth schema access",
  );
  assert.doesNotMatch(migration, /auth\.uid\(\)/);
  assert.match(
    migration,
    /ALTER FUNCTION swarm_read\.signal_delivery_receipts\(uuid, uuid, bytea\)\s+OWNER TO swarm_admin;/,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION swarm_read\.signal_delivery_receipts\(uuid, uuid, bytea\)\s+TO authenticated, swarm_read;/,
  );
  for (const field of [
    "recipient_agent_principal_id",
    "enqueued_at",
    "delivered_at",
    "leased_until",
    "acked_at",
    "ack_outcome",
    "attempt_count",
    "lease_expiry_count",
    "last_error_code",
    "recipient_user_id",
    "seen_at",
  ]) {
    assert.match(migration, new RegExp(`'${field}'`));
  }
  assert.doesNotMatch(migration, /'lease_id'|'leased_by'|'updated_at'|'last_lease_id'/);
});

test("human receipt schema and command pin first-seen, tenant FKs, and the batch cap", async () => {
  const migration = await readFile(HUMAN_RECEIPT_MIGRATION, "utf8");
  const command = await readFile("supabase/functions/command/human-receipts.ts", "utf8");
  const edge = await readFile("supabase/functions/command/index.ts", "utf8");

  assert.match(migration, /CREATE TABLE swarm\.signal_human_receipts/);
  assert.match(migration, /PRIMARY KEY \(signal_id, user_id\)/);
  assert.match(
    migration,
    /FOREIGN KEY \(signal_id, workspace_id\)\s+REFERENCES swarm\.signals \(id, workspace_id\)/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \(workspace_id, user_id\)\s+REFERENCES swarm\.memberships \(workspace_id, user_id\)/,
  );
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /FOR SELECT TO swarm_command/);
  assert.doesNotMatch(migration, /GRANT (?:UPDATE|DELETE).*swarm_command/);
  assert.match(command, /ON CONFLICT \(signal_id, user_id\) DO NOTHING/);
  assert.match(command, /SIGNALS_SEEN_MAX_IDS = 50/);
  assert.match(command, /signal\.to_user_id === null|signal\.to_user_id !== null/);
  assert.match(edge, /signals_seen_requires_human_credential/);
  assert.match(edge, /signal_ids\.length <= SIGNALS_SEEN_MAX_IDS/);
  assert.doesNotMatch(migration, /auth\.uid\(\)/);
});

test("broadcast roster starts from live memberships and labels agents untracked", async () => {
  const migration = await readFile(RECEIPT_MIGRATION, "utf8");
  assert.match(
    migration,
    /FROM swarm\.memberships AS membership[\s\S]*LEFT JOIN swarm\.signal_human_receipts AS human/,
    "mutation control: dropping the membership roster join must remove this witness",
  );
  assert.match(migration, /membership\.revoked_at IS NULL/);
  assert.match(migration, /LIMIT v_roster_limit/);
  assert.match(migration, /v_roster_limit constant integer := 50/);
  assert.match(migration, /'tracking_state', 'not_tracked'/);
  assert.match(migration, /'observed_at', NULL/);
  assert.match(migration, /'broadcast_roster'/);
  assert.doesNotMatch(migration, /auth\.uid\(\)/);
});

test("agent edge reaches the definer before installing human JWT claims", async () => {
  const edge = await readFile("supabase/functions/read/index.ts", "utf8");
  assert.match(
    edge,
    /body\.resource === "delivery_receipts"[\s\S]*exactKeys\(body, \["resource", "workspace_id", "signal_id"\]\)/,
  );
  const agentPathStart = edge.indexOf('setPhase("credential_lookup")');
  const agentPath = edge.slice(agentPathStart);
  const call = agentPath.indexOf("SELECT swarm_read.signal_delivery_receipts(");
  const claims = agentPath.indexOf("'request.jwt.claims'");
  assert.ok(agentPathStart >= 0, "the read edge must have an agent-authenticated path");
  assert.ok(call >= 0, "the read edge must call the receipt definer");
  assert.ok(claims > call, "agent receipt auth must run before human JWT claims exist");
  assert.match(
    edge,
    /body\.workspace_id !== agent\.principal_workspace_id[\s\S]*body\.resource === "delivery_receipts"[\s\S]*addressed: null, receipts: \[\]/,
    "a foreign workspace must return the same empty author-miss shape",
  );
});

test("browser client reaches the human RPC without an agent identity argument", async () => {
  const browser = await readFile("site/src/lib/commonswarm.ts", "utf8");
  const start = browser.indexOf("export async function browserDeliveryReceipts(");
  const end = browser.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "browser receipt helper must be exported");
  const helper = browser.slice(start, end + 3);
  assert.match(helper, /\.schema\("swarm_read"\)/);
  assert.match(helper, /\.rpc\("signal_delivery_receipts", \{/);
  assert.match(helper, /p_workspace_id: workspaceId/);
  assert.match(helper, /p_signal_id: signalId/);
  assert.doesNotMatch(
    helper,
    /p_agent_token_hash/,
    "a human RPC must derive the JWT subject and never choose an agent identity",
  );
});

test("root npm test literally reaches the delivery receipt controls", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: { test: string };
  };
  assert.match(packageJson.scripts.test, /tests\/delivery-receipts\.test\.ts/);
});
