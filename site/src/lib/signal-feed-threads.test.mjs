import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSignalThreads, threadReplyCountLabel } from "./signal-feed.js";

/*
 * Thread grouping, on its own. The renderer hands this the array in DISPLAY order and puts
 * back what it returns, so a group that loses a row loses a message off the screen.
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

test("the reply count reads as a count and not as a template", () => {
  assert.equal(threadReplyCountLabel(1), "1 reply");
  assert.equal(threadReplyCountLabel(2), "2 replies");
  assert.equal(threadReplyCountLabel(0), "0 replies");
});
