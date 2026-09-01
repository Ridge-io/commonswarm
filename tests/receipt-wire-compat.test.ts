import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

/**
 * The receipts wire must stay parseable by the clients ALREADY INSTALLED when a
 * server migration lands — there is no version negotiation on this wire and the
 * server migrates independently of the installed base. 619ff1f put agent tracking
 * rows into `receipts`; every 0.1.42/0.1.43 CLI threw on them, and only an
 * advisory reviewer running the OLD parser by hand caught it. This gate does
 * that run every time: it materialises the parser blob shipped in npm 0.1.42 and
 * 0.1.43 (git object bcaa5296…, tree 619ff1f^) and feeds it the shape the
 * CURRENT migration emits. If the object cannot be produced, the test FAILS
 * loudly rather than skipping — a silent skip would be the exact false green
 * this gate exists to prevent.
 */
const OLD_TREE = "619ff1f^";
const OLD_PARSER_BLOB = "bcaa529644e960fb51f99294f3a42de1114890ca";

function materialiseOldSrc(): string {
  const dir = mkdtempSync(join(tmpdir(), "cswarm-old-parser-"));
  const blob = execFileSync("git", ["rev-parse", `${OLD_TREE}:src/cloud/delivery-receipts.ts`], {
    encoding: "utf8",
  }).trim();
  assert.equal(blob, OLD_PARSER_BLOB, "the frozen old-parser object must be the npm 0.1.42/0.1.43 blob");
  const archive = execFileSync("git", ["archive", OLD_TREE, "src"], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  return dir;
}

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
      total: 2, returned: 2, limit: 50, truncated: false, tracking_state: "not_tracked",
      principals: [
        { recipient_agent_principal_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", display_name: "builder", tracking_state: "not_tracked", observed_at: null },
        { recipient_agent_principal_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", display_name: "reviewer", tracking_state: "not_tracked", observed_at: null },
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
  const dir = materialiseOldSrc();
  try {
    const mod = await import(pathToFileURL(join(dir, "src/cloud/delivery-receipts.ts")).href) as {
      parseDeliveryReceiptResult: (body: unknown) => unknown;
    };
    assert.equal(typeof mod.parseDeliveryReceiptResult, "function", "the old module must export the parser");
    const parsed = mod.parseDeliveryReceiptResult(broadcastWithAgents) as { receipts: unknown[] };
    assert.equal(parsed.receipts.length, 3, "old parser keeps the three human rows and ignores the roster key");
    /* Control: the same old parser must THROW on the pre-fix wire, or this gate
     * proves nothing about compatibility — it would pass any shape. */
    assert.throws(
      () => mod.parseDeliveryReceiptResult(brokenBroadcast),
      /malformed|agent recipient/i,
      "the control wire must be rejected by the old parser",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the current migration file names the roster key the old parser must never see in receipts", () => {
  /* A presence check on the working-tree SQL, so an uncommitted rewrite is gated
   * too. The behavioural proof (apply to real Postgres, run the old parser on the
   * RPC output) lives in the refuter lane, not here — a pure gate cannot run SQL. */
  const sql = readFileSync("supabase/migrations/20260902000001_broadcast_recipient_roster.sql", "utf8");
  assert.match(sql, /'principals'/, "agent rows are emitted under broadcast_roster.agents.principals");
});
