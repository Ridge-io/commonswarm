/*
 * Mutation harness for lane/chat-app-threads. Not shipped: run from the worktree root.
 *
 *   node docs/evidence/2026-09-05-chat-app-threads/mutate.mjs
 *
 * Each entry breaks ONE thing a test claims to defend and requires the named test file to go
 * red and then green again when the file is restored. A control that cannot fail is not a
 * control, and a control that fails for the wrong reason is not one either, so every entry
 * carries the text its failure must contain.
 *
 * THAT TEXT IS AN ASSERTION, NEVER A TEST TITLE. A review arm found several entries in the
 * sibling harness matching the title of a file's browser test, which every failure of that file
 * prints: the harness could not tell a wrong reason from the named one. Each `expected` below
 * is the assertion message or the exact value the mutation moves.
 *
 * Entries marked `rebuild` change the dashboard, which the browser observer reads out of
 * `site/dist`. Those rebuild the site between the mutation and the run; the source-reading
 * observers do not need it.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

const DASH = "site/src/components/app/LiveDashboard.astro";
const REPLY = "site/src/lib/thread-reply.ts";
const FEED = "site/src/lib/signal-feed.ts";
const ADDR = "site/src/lib/composer-address.ts";
const CLIENT = "site/src/lib/commonswarm.ts";

const PURE_REPLY = "site/src/lib/thread-reply.test.mjs";
const PURE_FEED = "site/src/lib/signal-feed-threads.test.mjs";
const THREADS = "site/src/components/app/chat-threads.observer.test.ts";
const CHANNELS = "site/src/components/app/chat-channels.observer.test.ts";
const COMPOSER = "site/src/components/app/composer.observer.test.ts";
const FIELD = "site/src/components/app/composer-to-field.observer.test.ts";
const PURE_ADDR = "site/src/lib/composer-address.test.mjs";

/** [test file, source file, target, replacement, what the control defends, expected text] */
const mutations = [
  /* ── THE WAKE RULE (lane/wake-all-recipients' copy, this branch's commit) ──────────────
     Every AGENT recipient is woken at any position, and a person is never woken. The retired
     rule woke recipient 0 only, and only when it was an agent. */
  [PURE_ADDR, ADDR,
    '): ComposerRecipient[] => recipients.filter((entity) => entity.kind === "agent");',
    "): ComposerRecipient[] => recipients.slice(0, 1);",
    "every agent is woken, not only the one at the front",
    "every agent in the set is woken, at any position, and no person ever is"],
  [PURE_ADDR, ADDR,
    '): ComposerRecipient[] => recipients.filter((entity) => entity.kind === "agent");',
    "): ComposerRecipient[] => [...recipients];",
    "a person is never woken, whatever position they take",
    "the woken set is not every agent in the set, and only the agents"],
  [PURE_ADDR, ADDR,
    "      : `${notified.length} agents are notified.`,",
    '      : "Several agents are notified.",',
    "the count of woken agents is computed from the chips rather than typed",
    "the note names who is notified and who only reads"],
  [PURE_ADDR, ADDR,
    "  const readers = recipients.filter((entity) => entity.kind !== \"agent\");",
    "  const readers = [...recipients];",
    "an agent named as notified is not counted again as a reader",
    "the note names who is notified and who only reads"],
  [PURE_ADDR, ADDR,
    "    ? `This message shows as addressed to ${name}`\n    : `Put ${name} ${front}, so the message shows as addressed to ${name}`;",
    "    ? `${name} is notified`\n    : `Put ${name} ${front}, so ${name} is notified`;",
    "no chip label answers the wake question the note under the chips owns",
    "chip label: the chip already at the front says so"],
  /* A SOURCE claim, because the two strings are identical the moment the constant is
     inlined: "first" IS positionWord(0). Only the sweep that reads the module can see it. */
  [FIELD, ADDR,
    "  const front = positionWord(SCALAR_POSITION);",
    '  const front = "first";',
    "the chip label takes its position word from the constant, not from prose",
    "chip label position is not built from the constant"],
  [FIELD, DASH,
    "      const notified = notifiedRecipients(shown);",
    "      const notified = notifiedRecipients(shown).slice(0, 1);",
    "every woken agent's chip carries the mark, not only the first",
    "notifiedMark: the chips carrying the notified mark and the sentence under them disagree",
    true],
  [PURE_ADDR, ADDR,
    "      : `${notified.length} agents are notified.`,",
    "      : `${notified.length + 1} agents are notified.`,",
    "the number in the sentence is the number of agents in the set",
    "the count in the sentence is not the number of agents in the set"],

  /* AND NO RETIRED WAKE SENTENCE STANDS AS CURRENT.

     THE MUTATION IS OF THE SUBJECT, NOT THE CHECKER, and that is the point. The sweep asserts
     an EMPTY SET — no retired phrase outside a strikethrough — so breaking the checker cannot
     fail it: there is nothing for a broken checker to miss. Breaking the SUBJECT can. This puts
     one retired sentence back as current, exactly the way two review arms found nine of them,
     and requires the sweep to name it. */
  [PURE_ADDR, ADDR,
    ' * ~~"which is the only way a reader can change who is woken"~~ retired 2026-09-05: the wake',
    " * which is the only way a reader can change who is woken. As of 2026-09-05 the wake",
    "a retired wake sentence put back as current is caught",
    "stands as current at offset"],

  // ── who may start a thread ────────────────────────────────────────────────────────────
  [PURE_REPLY, REPLY,
    '  if (signal.to !== null || signal.toAgent !== null) return "directed";',
    '  if (signal.to !== null) return "directed";',
    "a message directed at an AGENT cannot root a public thread either",
    "a directed message may not, whichever column carries the recipient"],
  [PURE_REPLY, REPLY,
    '  if (signal.threadRootId !== null) return "already-a-reply";',
    "  if (false) return \"already-a-reply\";",
    "a reply cannot be the root of a second thread",
    "a reply may not be the root of a second thread"],
  [PURE_REPLY, REPLY,
    "export const THREAD_ROOT_LIVE_MARGIN_MS = 1_000;",
    "export const THREAD_ROOT_LIVE_MARGIN_MS = 0;",
    "the control comes off inside the server's own liveness margin, not at the expiry",
    "the control comes off inside the server's own liveness margin"],
  [PURE_FEED, REPLY,
    "export const THREAD_ROOT_LIVE_MARGIN_MS = 1_000;",
    "export const THREAD_ROOT_LIVE_MARGIN_MS = 5_000;",
    "the browser's margin IS the edge's interval, read back out of its SQL",
    "the browser stops offering the reply control at a different moment than the server refuses it"],
  [PURE_REPLY, REPLY,
    "  if (channelArchived) return \"channel-archived\";",
    "  if (false) return \"channel-archived\";",
    "an archived channel closes its threads",
    "the rules are asked in the server's order"],
  /* THE ORDER ITSELF, and it is the thing a review arm found wrong. Putting `already-a-reply`
     back ahead of the archive is the version this lane shipped first: a reply in an archived
     channel was then told it is a reply, when the server tells it the channel is archived. */
  [PURE_REPLY, REPLY,
    "  if (channelArchived) return \"channel-archived\";\n  if (signal.threadRootId !== null) return \"already-a-reply\";",
    "  if (signal.threadRootId !== null) return \"already-a-reply\";\n  if (channelArchived) return \"channel-archived\";",
    "the archive outranks already-a-reply, the way the edge's 409 outranks its 400",
    "the rules are asked in the server's order"],
  [THREADS, REPLY,
    '  "channel-archived",\n  "already-a-reply",',
    '  "already-a-reply",\n  "channel-archived",',
    "the enumeration's order is compared against the edge's own text, not a typed list",
    "the browser asks the two 4xx rules in the opposite order to the edge"],
  /* NOT CONTROLLED, measured rather than claimed: `Number.isFinite(until)` is redundant, and
     removing it changes nothing. `new Date("not a date").getTime()` is NaN and every comparison
     with NaN is false, so the arm returns null either way; Infinity behaves the same. The guard
     stays because it says the intent out loud, and the test that asserts the BEHAVIOUR stays
     because the behaviour is real. There is no mutation for it, and that is stated here rather
     than covered by an entry that cannot fail. */

  // ── the copy, and that it is generated ────────────────────────────────────────────────
  [PURE_REPLY, REPLY,
    '  place.kind === "channel" ? channelLabel(place.slug) : channelLabel(ALL_SIGNALS_SLUG);',
    '  place.kind === "channel" ? channelLabel(place.slug) : channelLabel("everywhere");',
    "an unfiled thread is named from the constant the whole app names that view by",
    "the bar names the root and the channel it is in, and never guesses a place"],
  /* THE THIRD PLACE. A thread whose channel this page cannot name must not borrow the unfiled
     sentence: the reply lands in a channel, and "#all-signals" is a false statement about
     where the reader's own message goes. */
  [PURE_REPLY, REPLY,
    '    ? { kind: "unfiled" }\n    : slug === null\n    ? { kind: "unknown" }\n    : { kind: "channel", slug };',
    '    ? { kind: "unfiled" }\n    : slug === null\n    ? { kind: "unfiled" }\n    : { kind: "channel", slug };',
    "an unresolvable channel is its own state, never the unfiled one",
    "a thread's place has three states, and the unknown one is not the unfiled one"],
  [PURE_REPLY, REPLY,
    '    ? `Replying to ${author}. The channel list did not load, so this page cannot name the channel this thread is in. The reply is filed where the thread is.`',
    '    ? `Replying to ${author} in ${threadReplyPlaceLabel(place)}.`',
    "the unknown place names no channel rather than guessing all-signals",
    "the bar names the root and the channel it is in, and never guesses a place"],
  /* THE BLOCK OUTRANKS THE COUNTDOWN. An expired root printed a past tense about a future. */
  [PURE_REPLY, REPLY,
    "  block !== null\n    ? threadRootBlockText(block)\n    : relativeUntil === null",
    "  false\n    ? threadRootBlockText(block)\n    : relativeUntil === null",
    "a stopped thread says so in the bar rather than counting down to a past moment",
    "a block outranks the countdown, so an expired root does not print a past tense"],
  [PURE_REPLY, REPLY,
    '): boolean => block === null && place.kind === "channel";',
    "): boolean => true;",
    "broadcast is offered only for a thread that has a channel to broadcast to",
    "broadcast is offered only for a thread that is in a channel"],
  [PURE_REPLY, REPLY,
    '): boolean => block === null && place.kind === "channel";',
    '): boolean => place.kind === "channel";',
    "broadcast is not offered on a reply the server is going to refuse whole",
    "broadcast is offered only for a thread that is in a channel"],
  [PURE_REPLY, REPLY,
    "  `Also post this reply in ${channelLabel(slug)}`;",
    "  `Also post this reply in the channel`;",
    "the broadcast control names the channel it would send to",
    "broadcast is offered only for a thread that is in a channel"],
  [PURE_REPLY, REPLY,
    "    ? \"\"\n    : `This thread ends ${relativeUntil}, and a reply cannot outlive it.`;",
    "    ? \"This thread never ends.\"\n    : `This thread ends ${relativeUntil}, and a reply cannot outlive it.`;",
    "a thread with no ceiling produces no sentence rather than a claim about forever",
    "the window line is shown only when the thread has a ceiling"],
  [PURE_REPLY, REPLY,
    '  "A thread reply has no recipients. " + THREAD_REPLY_REACH_TEXT;',
    '  "A thread reply has no recipients.";',
    "the To: sentence carries the reach sentence rather than dropping it",
    "the To: sentence no longer carries the reach sentence"],
  /* ~~inline the same words~~ was the first form of that entry and it could not fail: the two
     strings are byte-identical the moment it is done, so the `includes` assertion still held.
     A mutation that cannot fail is not a control. The entry above DROPS the clause instead. */
  [PURE_REPLY, REPLY,
    '  "Everyone who can read the thread can read this reply. It notifies nobody.";',
    '  "Everyone who can read the thread can read this reply. It notifies them.";',
    "a reply is undirected, so nothing is woken and the sentence may not say otherwise",
    "the reach sentence claims no wake"],
  [PURE_REPLY, REPLY,
    '  "directed",\n  "expiring",',
    '  "directed",',
    "the block enumeration is the set the classifier can return",
    "the enumeration is not the set the classifier can return"],
  [THREADS, REPLY,
    '  "directed",\n  "expiring",',
    '  "directed",',
    "the edge's four arms and the browser's four blocks are compared as SETS",
    "the browser knows a rule the edge does not"],

  // ── the grouping ──────────────────────────────────────────────────────────────────────
  [PURE_FEED, FEED,
    "  for (const signal of signals) {\n    if (isOwnRow(signal)) continue;\n    byRootId.get(signal.threadRootId!)!.replies.push(signal);\n  }",
    "  for (const signal of signals) {\n    if (isOwnRow(signal)) continue;\n    void signal;\n  }",
    "a reply reaches the group of the message it answers",
    "replies collapse under the message their thread starts from"],
  [PURE_FEED, FEED,
    "    signal.threadRootId === null || !rootIds.has(signal.threadRootId);",
    "    signal.threadRootId === null;",
    "a reply whose root is not loaded keeps its own place instead of disappearing",
    "a reply whose root is not loaded keeps its own place in the transcript"],
  /* NOT CONTROLLED, measured rather than claimed: `if (signal.threadRootId === null)` on the
     registration cannot change any output. `byRootId.get` is only reached for a row whose
     threadRootId IS in `rootIds`, and every member of `rootIds` is a row with a null
     threadRootId — which was registered either way. Removing the guard registers ORPHAN replies
     under their own ids, and nothing ever looks one up. The guard stays because it says what a
     root is; the reply-of-a-reply test stays because that behaviour is real and worth pinning.
     There is no mutation for it, and this says so rather than carrying an entry that passes. */

  // ── the wire ──────────────────────────────────────────────────────────────────────────
  [THREADS, CLIENT,
    "    ...(placement.threadRootId === undefined || placement.threadRootId === null\n      ? {}\n      : { thread_root_id: placement.threadRootId }),",
    "    ...({}),",
    "thread_root_id reaches the wire at all",
    "a thread reply's body is the installed body plus thread_root_id"],
  [THREADS, CLIENT,
    "    ...(placement.broadcastToChannel === undefined\n      ? {}\n      : { broadcast_to_channel: placement.broadcastToChannel }),",
    "    ...({}),",
    "broadcast_to_channel reaches the wire when it is asked for",
    "broadcast_to_channel reaches the wire only when it is asked for"],
  [CHANNELS, DASH,
    "          ...(broadcastToChannel ? { broadcastToChannel: true } : {}),",
    "          broadcastToChannel,",
    "an unasked broadcast sends no key rather than an explicit false",
    "the thread branch must send broadcast_to_channel only when it is asked for"],

  // ── the To: lock, and that it is a HOLD rather than a second writer ───────────────────
  /* THE HOLD IS A SOURCE CONTROL, and this says why rather than implying a browser one.
     Its observable effects are on STORAGE and on a roster prune arriving mid-reply, and no step
     in this lane's browser measurement reaches either: after a cancel the chips are the same
     with the hold and without it, because the pass simply runs later over the same body. The
     two entries below break the guard and the argument that feeds it. */
  [FIELD, ADDR,
    "  if (!input.rosterKnown || input.sending || input.replying === true) return held;",
    "  if (!input.rosterKnown || input.sending) return held;",
    "the pass holds while a reply is written, so a tag inside a reply moves no address",
    "the pass commits against an unknown roster, a message already on the wire, or a reply"],
  [THREADS, ADDR,
    "): ComposerRecipient[] => (threadReply ? [] : [...to]);",
    "): ComposerRecipient[] => [...to];",
    "a thread reply carries no recipient, on the row and on the wire alike",
    "replyBar: the bar names the root and the channel, and To: is locked and empty", true],
  /* THAT ENTRY WAS `NOT CAUGHT` UNTIL THE ROW WAS FIXED, and it is the most useful thing this
     harness found. `renderComposerTo` returned early for a reply and drew a hardcoded empty
     state, so "the row draws what the send posts" was true by accident: two separate rules both
     produced nothing, and breaking the derivation changed the WIRE while leaving the row
     identical. The row draws `composerSendRecipients` in every state now. */
  [THREADS, DASH,
    "        replying: composerIsReplying(),",
    "        replying: false,",
    "the pass is told when the box is writing a reply",
    "the pass must be told when the box is writing a reply"],
  [THREADS, DASH,
    "      const shown = composerRecipients();",
    "      const shown = composerTo;",
    "the row draws the set the send posts, not the pair it holds",
    "the row must draw the set the send posts, not the pair it holds"],
  [THREADS, REPLY,
    'export const THREAD_REPLY_CHIP_LABEL = "This thread";',
    'export const THREAD_REPLY_CHIP_LABEL = "Everyone here";',
    "a reply's address is named as the thread, never as the workspace",
    "a reply's address must not be named with the broadcast label", true],
  [COMPOSER, DASH,
    "    const composerRecipients = (): ComposerRecipient[] =>\n      composerSendRecipients(composerTo, composerIsReplying());",
    "    const composerRecipients = (): ComposerRecipient[] => composerTo;",
    "one expression answers for both the row and the send",
    "one expression must answer for both the row and the send"],
  [THREADS, DASH,
    "        if (placementThreadRootId === null) rememberComposerTo(recipients, sendToKey);",
    "        rememberComposerTo(recipients, sendToKey);",
    "a reply does not wipe the set the last real message went to",
    "a reply must not wipe the set the last real message went to"],

  // ── the reply control's own rules ─────────────────────────────────────────────────────
  [THREADS, DASH,
    "        if (!isReply && canStartThread(signal, now, rootChannel?.archivedAt != null)) {",
    "        if (!isReply) {",
    "the control is offered only where the server would accept the thread",
    "atRest: the reply control is offered where the server would accept the thread", true],
  [THREADS, DASH,
    "        const rootChannel = channelById(channels, signal.channelId);",
    "        const rootChannel = activeChannelId === null && signal.channelId !== null\n          ? channelById(channels, signal.channelId)\n          : null;",
    "the archive question is asked of the ROW's channel in every view, not only in all-signals",
    "the archive question must be asked of the row's own channel, in every view"],
  [THREADS, DASH,
    "            if (composerSending) return;\n            /* THE ROOT'S CHANNEL IS CAPTURED HERE",
    "            /* THE ROOT'S CHANNEL IS CAPTURED HERE",
    "a reply cannot be opened while a message is on the wire",
    "a reply must not be opened while a message is on the wire"],

  // ── the reply bar ─────────────────────────────────────────────────────────────────────
  [THREADS, DASH,
    "        if (broadcastRow) broadcastRow.hidden = !mayBroadcast;",
    "        if (broadcastRow) broadcastRow.hidden = false;",
    "the broadcast control is absent for a thread with nowhere to broadcast",
    "replyUnfiled: an unfiled thread has nowhere to broadcast", true],
  [THREADS, DASH,
    "        if (broadcast && !mayBroadcast) broadcast.checked = false;",
    "        if (broadcast && false) broadcast.checked = false;",
    "a box ticked for one thread cannot ride along into a thread that has no channel",
    "a broadcast box ticked for one thread must be cleared for a thread with no channel"],
  [THREADS, DASH,
    "          targetText.textContent = threadReplyTargetText(threadReplyRoot.author, place);",
    '          targetText.textContent = threadReplyTargetText(threadReplyRoot.author, { kind: "unfiled" });',
    "the bar names the channel the thread is actually in",
    "replyInChannel: the control names the channel it would send to", true],
  /* AND THE LINE STAYS LIVE. The design requires the ceiling on screen because it can be
     milliseconds; a line written once when the bar opened is the failure it exists to prevent,
     and it is also what leaves a stopped thread counting down. */
  [THREADS, DASH,
    "      syncComposerPlacement();\n      /* Captured BEFORE the list is rebuilt",
    "      /* Captured BEFORE the list is rebuilt",
    "the reply bar's window line is rewritten on every feed tick",
    "the reply bar must be resynced by the feed, so its window line cannot go stale"],
  /* ── ROUND THREE: THE FAIL, AND THE FIX'S OWN CONTROLS ───────────────────────────────── */
  [THREADS, DASH,
    "        (placementThreadRootId !== null\n          ? placementChannel !== null && placementChannel.archivedAt !== null\n          : placementChannel === null || placementChannel.archivedAt !== null);",
    "        (placementChannel === null || placementChannel.archivedAt !== null);",
    "a channel this page cannot SEE does not stop a reply, which sends no slug",
    "a reply must be stopped by an archived channel only, never by one this page cannot see"],
  [THREADS, DASH,
    "      broadcastToChannel: boolean;\n    } | null = null;",
    "    } | null = null;",
    "the intent's type declares every field the send writes into it",
    "the intent's type and the fields the mint writes are not the same set"],
  /* ONE READ OF ONE MOMENT: the block is captured once and both readers use that value. A RACE
     is not testable in a browser step, so the control is a source claim and the mutation puts
     the second `Date.now()` back exactly where it was. */
  [THREADS, DASH,
    "        const block = replyBlock;",
    "        const block = threadReplyBlock(replyRoot);",
    "the send freezes the block instead of asking Date.now() twice",
    "the send asks Date.now() about the same moment twice"],
  /* AND THE SEND READS THE ROOT IT CAPTURED, never the live global. */
  [THREADS, DASH,
    "        threadReplyMayBroadcast(threadReplyPlaceOf(replyRoot), replyBlock) &&",
    "        threadReplyMayBroadcast(threadReplyPlaceOf(threadReplyRoot), replyBlock) &&",
    "the broadcast flag is read off the root this send captured",
    "the send reads threadReplyRoot somewhere new"],
  [THREADS, DASH,
    "      if (bar) bar.hidden = threadReplyRoot === null;",
    "      if (bar) bar.hidden = false;",
    "the bar is present only while a reply is in progress",
    "cancelled: the held pair comes back, and the body's own tag joins it", true],

  // ── the placement ─────────────────────────────────────────────────────────────────────
  [CHANNELS, DASH,
    "      const freshPlacementChannelId = replyRoot === null\n        ? activeChannel()?.channelId ?? null\n        : replyRoot.channelId;",
    "      const freshPlacementChannelId = activeChannel()?.channelId ?? null;",
    "a reply is filed where its thread is, not where the reader is looking",
    "a reply is filed where its thread is, and a top-level post where the reader is"],
  [CHANNELS, DASH,
    "      const addressStillActive = composerAddressStillPromised(intent);",
    "      const addressStillActive =\n        placementChannelId === (activeChannel()?.channelId ?? null);",
    "one function decides whether an unfinished send may still be replayed",
    "one function must decide whether an unfinished send may still be replayed"],
  [CHANNELS, DASH,
    "      retireComposerIntentOnAddressMove();\n      /* SAMPLE MODE NARROWS LOCALLY",
    "      /* SAMPLE MODE NARROWS LOCALLY",
    "a channel move retires an unfinished send addressed to the channel it left",
    "a channel move must retire an unfinished send addressed to the channel it left"],
  [THREADS, DASH,
    "        if (replyRoot !== null && threadReplyRoot?.id === replyRoot.id) {\n          setThreadReplyRoot(null);\n        }",
    "        void replyRoot;",
    "a landed reply finishes the reply it was for",
    "sentReply: the bar comes down", true],
  /* THE MUTATION KEEPS THE READ COUNT. ~~`if (replyRoot !== null) {`~~ removed a
     `threadReplyRoot` read as well, so the freeze control fired first and the harness reported
     a wrong reason for a correct catch. This one breaks the NAMING and nothing else. */
  [THREADS, DASH,
    "        if (replyRoot !== null && threadReplyRoot?.id === replyRoot.id) {",
    "        if (replyRoot !== null && threadReplyRoot !== null) {",
    "the close names THIS send's own reply, so it cannot close one opened after it",
    "a landed reply must finish the reply it was for, and name it"],
  [THREADS, DASH,
    "      const replyRoot = threadReplyRoot;",
    "      const replyRoot = threadReplyRoot;\n      void threadReplyRoot;",
    "the send does not reach for the reply again after its first await",
    "the send reads threadReplyRoot somewhere new"],
];

const rows = [];
let failures = 0;

const buildSite = async () => {
  await run("npm", ["--prefix", "site", "run", "build"], {
    maxBuffer: 40 * 1024 * 1024,
    timeout: 300_000,
  });
};

const runTest = async (file) => {
  try {
    const { stdout, stderr } = await run(
      "node",
      ["--import", "tsx", "--test", file.replace(/^site\//, "")],
      { cwd: "site", maxBuffer: 40 * 1024 * 1024, timeout: 900_000 },
    );
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}\n${error.stderr ?? ""}` };
  }
};

/* Baseline first: every named test file must be GREEN before anything is broken, or a red
 * below would say nothing about the mutation. */
await buildSite();
for (const file of [...new Set(mutations.map(([test]) => test))]) {
  const result = await runTest(file);
  rows.push(`BASELINE ${result.ok ? "green" : "RED"}  ${file}`);
  if (!result.ok) {
    failures += 1;
    console.error(result.output.slice(-2_000));
  }
}

for (const [testFile, sourceFile, target, replacement, defends, expected, rebuild] of mutations) {
  const original = readFileSync(sourceFile, "utf8");
  const count = original.split(target).length - 1;
  if (count !== 1) {
    rows.push(`UNRESOLVED (${count} matches)  ${defends}`);
    failures += 1;
    continue;
  }
  writeFileSync(sourceFile, original.replace(target, replacement));
  try {
    if (rebuild) await buildSite();
    const broken = await runTest(testFile);
    const reached = !broken.ok && broken.output.includes(expected);
    rows.push(
      `${broken.ok ? "NOT CAUGHT" : reached ? "red" : "RED, WRONG REASON"}  ${defends}`,
    );
    if (!reached) {
      failures += 1;
      console.error(`${defends}\n${broken.output.slice(-1_500)}`);
    }
  } finally {
    writeFileSync(sourceFile, original);
  }
  if (rebuild) await buildSite();
  const restored = await runTest(testFile);
  rows.push(`  restored ${restored.ok ? "green" : "RED"}  ${testFile}`);
  if (!restored.ok) {
    failures += 1;
    console.error(restored.output.slice(-2_000));
  }
}

console.log(rows.join("\n"));
console.log(`\n${mutations.length} mutations, ${failures} problems`);
process.exit(failures === 0 ? 0 : 1);
