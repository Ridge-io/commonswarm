import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { groupSignalThreads } from "./signal-feed.js";
import { THREAD_ROOT_LIVE_MARGIN_MS } from "./thread-reply.js";

/*
 * Thread grouping, on its own. The renderer hands this the array in DISPLAY order and puts
 * back what it returns, so a group that loses a row loses a message off the screen.
 *
 * Gate: `npm --prefix site test` globs `src/lib/*.test.mjs`.
 */

const row = (id, threadRootId = null) => ({ id, threadRootId });

test("replies collapse under the message their thread starts from", () => {
  const groups = groupSignalThreads([
    row("root-a"),
    row("reply-a1", "root-a"),
    row("root-b"),
    row("reply-a2", "root-a"),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.root.id, group.replies.map((reply) => reply.id)]),
    [["root-a", ["reply-a1", "reply-a2"]], ["root-b", []]],
  );
});

test("the input order is the output order, in either direction", () => {
  const oldestFirst = [row("r1"), row("c1", "r1"), row("r2")];
  const newestFirst = [...oldestFirst].reverse();
  assert.deepEqual(
    groupSignalThreads(oldestFirst).map((group) => group.root.id),
    ["r1", "r2"],
  );
  /* The feed keeps its array newest-first for the cursor and reverses once for display, so
     this function has to be right when a reply is met BEFORE its root. A single-pass
     version that looked the root up as it met each reply threw here. */
  assert.deepEqual(
    groupSignalThreads(newestFirst).map((group) => group.root.id),
    ["r2", "r1"],
  );
  assert.deepEqual(groupSignalThreads(newestFirst)[1].replies.map((c) => c.id), ["c1"]);
});

test("a reply whose root is not loaded keeps its own place in the transcript", () => {
  /* The root can be expired, or simply older than the loaded page. Dropping the reply would
     take a visible message off the screen; appending it at the end would move it away from
     the rows it was written between. */
  const groups = groupSignalThreads([
    row("first"),
    row("orphan", "root-not-loaded"),
    row("last"),
  ]);
  assert.deepEqual(groups.map((group) => group.root.id), ["first", "orphan", "last"]);
  assert.deepEqual(groups[1].replies, []);
});

test("every input row appears exactly once in the output", () => {
  const input = [
    row("a"),
    row("b", "a"),
    row("c"),
    row("d", "missing"),
    row("e", "c"),
    row("f", "a"),
  ];
  const seen = groupSignalThreads(input)
    .flatMap((group) => [group.root.id, ...group.replies.map((reply) => reply.id)]);
  assert.deepEqual([...seen].sort(), input.map((entry) => entry.id).sort());
  assert.equal(seen.length, new Set(seen).size, "no row may be rendered twice");
});

test("a channel narrowing and a thread compose: the same grouping runs over either page", () => {
  /* THE CLAIM: a reply in channel X reads under its root in X and in all-signals. It holds
     because the SERVER stamps a reply with its root's channel, so both reads return the pair
     together and the browser resolves nothing. This drives that: the same rows, filtered the
     way `channel_id=eq.<X>` filters them and not filtered at all, group identically.

     The control is the pair of assertions: if the grouping needed anything the narrowed page
     does not carry, the first would differ from the second. */
  const all = [
    { id: "unfiled-root", threadRootId: null, channelId: null },
    { id: "x-root", threadRootId: null, channelId: "chan-x" },
    { id: "x-reply", threadRootId: "x-root", channelId: "chan-x" },
    { id: "unfiled-reply", threadRootId: "unfiled-root", channelId: null },
  ];
  const inChannelX = all.filter((entry) => entry.channelId === "chan-x");
  assert.deepEqual(
    groupSignalThreads(inChannelX).map((group) => [
      group.root.id,
      group.replies.map((reply) => reply.id),
    ]),
    [["x-root", ["x-reply"]]],
    "in #x the reply is under its root",
  );
  const unfiltered = groupSignalThreads(all).map((group) => [
    group.root.id,
    group.replies.map((reply) => reply.id),
  ]);
  assert.deepEqual(
    unfiltered,
    [["unfiled-root", ["unfiled-reply"]], ["x-root", ["x-reply"]]],
    "and in all-signals it is under the same root, beside the unfiled thread",
  );
  /* And the #x group is BYTE-IDENTICAL between the two, which is what "compose" means here:
     the narrowing changes which rows are on the page and nothing about how they group. */
  assert.deepEqual(
    unfiltered.find(([rootId]) => rootId === "x-root"),
    ["x-root", ["x-reply"]],
  );
});

/*
 * THE ONE SERVER NUMBER THIS LANE MIRRORS RATHER THAN IMPORTS.
 *
 * `resolveThreadRoot` requires a root to be live with a one-second margin, and that bound is
 * a SQL interval literal inside a tagged template — there is no exported constant to import.
 * A typed copy of an enforced number is the drift AGENTS.md measured four times in one release
 * cycle, so the copy is read back out of the edge here.
 *
 * WHAT THIS SWEEP DOES AND DOES NOT CLAIM. It is a single-line source read, bounded on
 * purpose: it asserts that the edge contains exactly one `s.until > statement_timestamp() +
 * interval '<n> second'` clause and that `<n>` seconds equals THREAD_ROOT_LIVE_MARGIN_MS. It
 * does NOT claim that clause is the only liveness rule in the edge, and it cannot see a margin
 * expressed any other way — as milliseconds, as a bound variable, or moved into SQL. A rewrite
 * of that kind makes the anchor count zero and this test red, which is the outcome that
 * matters: it fails loudly rather than passing quietly.
 */
const libDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(libDir, "..", "..", "..");
const commandEdge = readFileSync(
  join(repoRoot, "supabase", "functions", "command", "index.ts"),
  "utf8",
);

test("the browser's thread liveness margin is the edge's own interval", () => {
  const matches = [
    ...commandEdge.matchAll(
      /s\.until > statement_timestamp\(\) \+ interval '(\d+) second'/g,
    ),
  ];
  /* POSITIVE CONTROL on the read itself: a regex against a guessed shape can make a confident
     zero, so the count is asserted before the value is. */
  assert.equal(matches.length, 1, "expected exactly one thread-root liveness clause in the edge");
  assert.equal(
    Number(matches[0][1]) * 1_000,
    THREAD_ROOT_LIVE_MARGIN_MS,
    "the browser stops offering the reply control at a different moment than the server refuses it",
  );
});
