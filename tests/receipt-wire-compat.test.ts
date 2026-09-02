import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadOldReceiptsParser } from "./support/old-receipts-parser.js";

/**
 * The receipts wire must stay parseable by the clients ALREADY INSTALLED when a
 * server migration lands — there is no version negotiation on this wire and the
 * server migrates independently of the installed base. 619ff1f put agent tracking
 * rows into `receipts`; every 0.1.42/0.1.43 CLI threw on them, and only an
 * advisory reviewer running the OLD parser by hand caught it. This gate does
 * that run every time: it materialises the parser blob shipped in npm 0.1.42 and
 * 0.1.43 (git object bcaa5296…, tree 619ff1f^) and feeds it the shape the
 * CURRENT migration emits (tests/support/old-receipts-parser.ts loads it; it
 * fails loudly rather than skipping). The real-Postgres twin of this check
 * lives in tests/p1-local/delivery-receipts-postgres.test.ts.
 */
/** The FINAL broadcast shape: human rows only in receipts; agents under the roster key. */
const broadcastWithAgents = {
  addressed: false,
  receipts: [
    { recipient_user_id: "11111111-1111-4111-8111-111111111111", display_name: "Zoe Seen", seen_at: "2026-09-01T14:03:11.482913+00:00" },
    { recipient_user_id: "22222222-2222-4222-8222-222222222222", display_name: "Alice", seen_at: null },
    { recipient_user_id: "33333333-3333-4333-8333-333333333333", display_name: "Bob", seen_at: null },
  ],
  broadcast_roster: {
    members: { total: 3, seen: 1, returned: 3, limit: 50, truncated: false },
    agents: {
      total: 2, seen: 1, returned: 2, limit: 50, truncated: false, tracking_state: "not_tracked",
      principals: [
        { principal_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", recipient_agent_principal_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", display_name: "builder", seen_at: "2026-09-01T14:04:00.000Z", tracking_state: "not_tracked", observed_at: null },
        { principal_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", recipient_agent_principal_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", display_name: "reviewer", seen_at: null, tracking_state: "not_tracked", observed_at: null },
      ],
    },
  },
};

/** The PRE-FIX shape (619ff1f): agent tracking rows inside receipts. The control. */
const brokenBroadcast = {
  addressed: false,
  receipts: [
    ...broadcastWithAgents.receipts,
    ...broadcastWithAgents.broadcast_roster.agents.principals,
  ],
};

test("the npm 0.1.42/0.1.43 receipts parser parses the current broadcast wire and rejects the pre-fix wire", async () => {
  const old = await loadOldReceiptsParser();
  try {
    const parsed = old.parseDeliveryReceiptResult(broadcastWithAgents);
    assert.equal(parsed.receipts.length, 3, "old parser keeps the three human rows and ignores the roster key");
    /* Control: the same old parser must THROW on the pre-fix wire, or this gate
     * proves nothing about compatibility — it would pass any shape. */
    assert.throws(
      () => old.parseDeliveryReceiptResult(brokenBroadcast),
      /malformed|agent recipient/i,
      "the control wire must be rejected by the old parser",
    );
  } finally {
    old.dispose();
  }
});

test("the current migration file names the roster key the old parser must never see in receipts", () => {
  /* A presence check on the working-tree SQL, so an uncommitted rewrite is gated
   * too. The behavioural proof (apply to real Postgres, run the old parser on the
   * RPC output) lives in the refuter lane, not here — a pure gate cannot run SQL. */
  const sql = readFileSync("supabase/migrations/20260902000001_broadcast_recipient_roster.sql", "utf8");
  assert.match(sql, /'principals'/, "agent rows are emitted under broadcast_roster.agents.principals");
});
