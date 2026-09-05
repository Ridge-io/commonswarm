import assert from "node:assert/strict";
import { test } from "node:test";
import { BROADCAST_CHIP_LABEL } from "./composer-address.js";
import {
  canStartThread,
  THREAD_REPLY_CHIP_LABEL,
  THREAD_REPLY_REACH_TEXT,
  THREAD_REPLY_TO_TEXT,
  THREAD_ROOT_BLOCKS,
  THREAD_ROOT_LIVE_MARGIN_MS,
  threadReplyBroadcastLabel,
  threadReplyCountLabel,
  threadReplyMayBroadcast,
  threadReplyPlace,
  threadReplyPlaceLabel,
  threadReplyTargetText,
  threadReplyWindowText,
  threadRootBlock,
  threadRootBlockText,
} from "./thread-reply.js";
import { ALL_SIGNALS_SLUG } from "./channels.js";

/*
 * Who may start a thread, and every sentence the reply bar says.
 *
 * The eligibility rules here are `resolveThreadRoot`'s, arm for arm. This file is where they
 * are asserted as a set: the browser's job is to stop offering a control the server refuses,
 * and a missing arm is a button that lies.
 *
 * Gate: `npm --prefix site test` globs `src/lib/*.test.mjs`.
 */

const NOW = 1_700_000_000_000;
const live = (extra = {}) => ({
  to: null,
  toAgent: null,
  threadRootId: null,
  until: null,
  ...extra,
});

test("an undirected, live, top-level message may start a thread", () => {
  assert.equal(threadRootBlock(live(), NOW, false), null);
  assert.equal(canStartThread(live(), NOW, false), true);
  /* And with an expiry comfortably in the future, which is the ordinary case: every signal
     the server stores has one. */
  assert.equal(
    threadRootBlock(live({ until: new Date(NOW + 60_000).toISOString() }), NOW, false),
    null,
  );
});

test("a directed message may not, whichever column carries the recipient", () => {
  /* The disclosure arm. A reply is undirected and readable by everyone who can read the
     thread, so a thread hung off a DIRECTED message would advertise that the private message
     exists. The server enforces it in `resolveThreadRoot`'s WHERE; the browser must not offer
     the control. Both columns, because a resolver that reads one is the defect. */
  assert.equal(threadRootBlock(live({ to: "user-1" }), NOW, false), "directed");
  assert.equal(threadRootBlock(live({ toAgent: "agent-1" }), NOW, false), "directed");
  assert.equal(canStartThread(live({ to: "user-1" }), NOW, false), false);
});

test("an `in_reply_to` row is covered by the directed arm, because the server stores it directed", () => {
  /* The browser's Signal carries no `in_reply_to` field, and this is why it does not need
     one: `resolveSignalWriteTarget` re-addresses an in_reply_to row to the referenced
     signal's author, so every such row arrives here with a recipient. The server asserts
     `in_reply_to IS NULL` as well — belt and braces on its side — and the browser's single
     test is equivalent for every row that can actually exist. */
  assert.equal(threadRootBlock(live({ to: "author-1" }), NOW, false), "directed");
});

test("a reply may not be the root of a second thread", () => {
  assert.equal(
    threadRootBlock(live({ threadRootId: "root-1" }), NOW, false),
    "already-a-reply",
  );
});

test("the control comes off inside the server's own liveness margin, not at the expiry", () => {
  /* The server requires `until > statement_timestamp() + interval '1 second'`, so a root with
     less than a second left is refused even though it has not expired. Offering the control
     in that band is a button the server answers 404 to. */
  const justInside = new Date(NOW + THREAD_ROOT_LIVE_MARGIN_MS - 1).toISOString();
  const justOutside = new Date(NOW + THREAD_ROOT_LIVE_MARGIN_MS + 1).toISOString();
  assert.equal(threadRootBlock(live({ until: justInside }), NOW, false), "expiring");
  assert.equal(threadRootBlock(live({ until: justOutside }), NOW, false), null);
  /* CONTROL: the margin is what makes the first case a block. Without it the boundary would
     sit at the expiry itself, and this pair would not discriminate. */
  assert.equal(
    threadRootBlock(live({ until: justInside }), NOW - THREAD_ROOT_LIVE_MARGIN_MS, false),
    null,
  );
  assert.equal(threadRootBlock(live({ until: new Date(NOW).toISOString() }), NOW, false), "expiring");
});

test("an unreadable expiry leaves the row alone rather than calling it expired", () => {
  /* Inventing an expiry from a value that does not parse would take the control off a message
     that is still on the screen. The feed already drops rows it can read as expired. */
  assert.equal(threadRootBlock(live({ until: "not a date" }), NOW, false), null);
});

test("the rules are asked in the server's order, which is not the order this file first used", () => {
  /* CORRECTED after a review arm read `resolveThreadRoot` and found the claim wrong.
     ~~"every arm of the WHERE clause, plus the archive check that follows it"~~ put
     `already-a-reply` in the WHERE and ahead of the archive. It is neither. The server's
     sequence is:

       WHERE  directed, `in_reply_to` present, not live with a one-second margin  -> 404
       then   the root's channel is archived                                      -> 409
       then   the root is itself a thread reply                                   -> 400

     so a REPLY IN AN ARCHIVED CHANNEL is told the channel is archived. The old order told it
     that it was a reply, and the old test asserted exactly that — a green control pinning a
     false claim, which is the failure AGENTS.md names. */
  assert.equal(threadRootBlock(live(), NOW, true), "channel-archived");
  assert.equal(threadRootBlock(live({ threadRootId: "r" }), NOW, true), "channel-archived");
  /* And the two 404 arms still outrank both, in either order between themselves: the server
     folds them into one refusal so it is not an oracle for which ids exist. */
  assert.equal(threadRootBlock(live({ to: "user-1" }), NOW, true), "directed");
  assert.equal(
    threadRootBlock(live({ until: new Date(NOW).toISOString(), threadRootId: "r" }), NOW, true),
    "expiring",
  );
});

test("every block the classifier can return has a sentence, and the set is the enumeration", () => {
  /* THE LIST IS GENERATED, NOT TYPED. A fifth rule on the server has to appear in
     THREAD_ROOT_BLOCKS, in the classifier and in the sentence table together; a copy of the
     list written into any one of them is the drift AGENTS.md measured four times. */
  const reached = new Set([
    threadRootBlock(live({ to: "u" }), NOW, false),
    threadRootBlock(live({ threadRootId: "r" }), NOW, false),
    threadRootBlock(live({ until: new Date(NOW).toISOString() }), NOW, false),
    threadRootBlock(live(), NOW, true),
  ]);
  assert.deepEqual(
    [...reached].sort(),
    [...THREAD_ROOT_BLOCKS].sort(),
    "the enumeration is not the set the classifier can return",
  );
  for (const block of THREAD_ROOT_BLOCKS) {
    const text = threadRootBlockText(block);
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0, `${block} has no sentence`);
    assert.match(text, /\.$/, `${block} is not a sentence`);
  }
  /* And no two blocks share a sentence, so a reader can tell which rule they met. */
  const sentences = THREAD_ROOT_BLOCKS.map(threadRootBlockText);
  assert.equal(new Set(sentences).size, sentences.length);
});

test("the archived sentence is the server's own refusal, word for word", () => {
  /* It is the message `resolveThreadRoot` returns for `channel_archived`. Two wordings for one
     refusal is how a reader gets told two different things about the same rule depending on
     whether the browser or the server noticed. */
  assert.equal(
    threadRootBlockText("channel-archived"),
    "That thread is in an archived channel, so it takes no new replies. Its history still reads and its links still resolve.",
  );
});

test("a thread's place has three states, and the unknown one is not the unfiled one", () => {
  /* THE THIRD STATE IS THE POINT. The channel read soft-fails to an empty list, by design, so a
     channel outage cannot take the feed down — and a thread in a real channel then has a
     channelId this page cannot name. Collapsing that into the unfiled case made the bar say
     "in #all-signals" about a reply that lands in a channel, which is a false statement about
     where the reader's own message goes. */
  assert.deepEqual(threadReplyPlace(null, null), { kind: "unfiled" });
  assert.deepEqual(threadReplyPlace("chan-1", "mobile"), { kind: "channel", slug: "mobile" });
  assert.deepEqual(threadReplyPlace("chan-1", null), { kind: "unknown" });
  /* A slug without a channel id cannot occur and is read as unfiled rather than invented. */
  assert.deepEqual(threadReplyPlace(null, "mobile"), { kind: "unfiled" });
});

test("the bar names the root and the channel it is in, and never guesses a place", () => {
  assert.equal(
    threadReplyTargetText("Orbit", { kind: "channel", slug: "mobile" }),
    "Replying to Orbit in #mobile.",
  );
  /* THE UNFILED CASE IS NAMED, not left blank: "in nothing" would read as a bug, and the app
     already has one name for the whole feed. It comes from ALL_SIGNALS_SLUG, so a rename of
     that view moves this sentence with it. */
  assert.equal(
    threadReplyTargetText("Orbit", { kind: "unfiled" }),
    `Replying to Orbit in #${ALL_SIGNALS_SLUG}.`,
  );
  /* AND THE UNKNOWN CASE NAMES NO PLACE AT ALL. It must not borrow the unfiled sentence. */
  const unknown = threadReplyTargetText("Orbit", { kind: "unknown" });
  assert.doesNotMatch(unknown, new RegExp(`#${ALL_SIGNALS_SLUG}`));
  assert.doesNotMatch(unknown, /#/);
  assert.match(unknown, /channel list did not load/);
  assert.match(unknown, /filed where the thread is/);
  assert.notEqual(unknown, threadReplyTargetText("Orbit", { kind: "unfiled" }));
  assert.equal(threadReplyPlaceLabel({ kind: "unfiled" }), `#${ALL_SIGNALS_SLUG}`);
  assert.equal(threadReplyPlaceLabel({ kind: "channel", slug: "mobile" }), "#mobile");
});

test("the reach sentence claims no wake, which is what an undirected signal gets", () => {
  /* A thread reply is undirected, so `swarm.enqueue_signal_delivery` writes no delivery row.
     Nothing is woken: not an agent in the hosted workspace, and not a local listener, which
     reads the same rows. The sentence may not promise otherwise in either direction. */
  assert.match(THREAD_REPLY_REACH_TEXT, /notifies nobody/);
  assert.doesNotMatch(THREAD_REPLY_REACH_TEXT, /notif(y|ies) (them|the|everyone)/i);
  /* And it says nothing about privacy, which a channel does not give. */
  assert.doesNotMatch(THREAD_REPLY_REACH_TEXT, /private|only|invite|members of/i);
});

test("the To: row's own sentence says a reply carries no recipients, and contains the reach", () => {
  assert.match(THREAD_REPLY_TO_TEXT, /has no recipients/);
  /* BUILT FROM THE REACH SENTENCE rather than repeating it, so the two cannot disagree about
     what a reply reaches. The mutation that reaches this is one that DROPS the reach clause:
     inlining the same words changes nothing, because the two are byte-identical the moment it
     is done, and a mutation that cannot fail is not a control. */
  assert.ok(
    THREAD_REPLY_TO_TEXT.includes(THREAD_REPLY_REACH_TEXT),
    "the To: sentence no longer carries the reach sentence",
  );
});

test("the window line is shown only when the thread has a ceiling", () => {
  assert.equal(threadReplyWindowText(null), "");
  assert.equal(
    threadReplyWindowText("in 2 minutes"),
    "This thread ends in 2 minutes, and a reply cannot outlive it.",
  );
});

test("a block outranks the countdown, so an expired root does not print a past tense", () => {
  /* The bar is opened against a row and held while a reply is written, so the root can expire
     and its channel can be archived in that window. Left as a countdown, an expired root
     printed "This thread ends 2 minutes ago, and a reply cannot outlive it" — wrong in its
     tense and silent about the thing that matters. */
  assert.equal(
    threadReplyWindowText("2 minutes ago", "expiring"),
    threadRootBlockText("expiring"),
  );
  assert.equal(
    threadReplyWindowText(null, "channel-archived"),
    threadRootBlockText("channel-archived"),
  );
  /* CONTROL: with no block the countdown is still what is shown, so the branch above is the
     block and not a line that stopped working. */
  assert.equal(
    threadReplyWindowText("in 2 minutes", null),
    "This thread ends in 2 minutes, and a reply cannot outlive it.",
  );
});

test("broadcast is offered only for a thread that is in a channel", () => {
  /* `broadcast_to_channel` says "send this reply to the channel as well". An unfiled thread
     has no channel to send it to: the edge stores the flag as true and leaves `channel_id`
     null, so the request is accepted and does nothing. The CLI shipped a sentence claiming
     that send; the browser does not offer the control. */
  assert.equal(threadReplyMayBroadcast({ kind: "channel", slug: "mobile" }), true);
  assert.equal(threadReplyMayBroadcast({ kind: "unfiled" }), false);
  /* AND NOT WHERE THE PAGE CANNOT NAME THE CHANNEL. The label has to say which channel it would
     send to, and there is no honest wording for "some channel". */
  assert.equal(threadReplyMayBroadcast({ kind: "unknown" }), false);
  /* AND NOT WHILE THE WHOLE REPLY IS REFUSED. Offering to send it to a channel as well would be
     a second promise on top of one the server will not keep. `channel-archived` is the case
     that reaches this: channelById finds an archived channel on purpose, so the slug resolves
     and the place IS a channel. */
  assert.equal(
    threadReplyMayBroadcast({ kind: "channel", slug: "mobile" }, "channel-archived"),
    false,
  );
  assert.equal(
    threadReplyMayBroadcast({ kind: "channel", slug: "mobile" }, "expiring"),
    false,
  );
  assert.equal(
    threadReplyBroadcastLabel("mobile"),
    "Also post this reply in #mobile",
  );
});

test("a reply's address is named on the row, and it is not the broadcast label", () => {
  /* An empty To: row is never left blank: an unnamed address reads as a bug. But the broadcast
     label names the WORKSPACE, and a reply's reach is the thread, so the two cannot share a
     name. This is a LABEL for an empty set and not a recipient: the row draws
     `composerSendRecipients` in every state, so a recipient that reached a reply would show up
     as a chip beside it rather than be hidden by an early return. */
  assert.equal(THREAD_REPLY_CHIP_LABEL, "This thread");
  assert.notEqual(THREAD_REPLY_CHIP_LABEL, BROADCAST_CHIP_LABEL);
  assert.doesNotMatch(THREAD_REPLY_CHIP_LABEL, /everyone|here|workspace/i);
});

test("the reply count reads as a count and not as a template", () => {
  assert.equal(threadReplyCountLabel(1), "1 reply");
  assert.equal(threadReplyCountLabel(2), "2 replies");
  assert.equal(threadReplyCountLabel(0), "0 replies");
});
