# lane/chat-app-threads — what was measured

The thread surface the channels lane cut on 2026-09-05 (`c1774d7`), rebuilt on the base the
composer To: row landed on. `docs/design/2026-09-04-chat-platform-reconciled.md` §6 P4 is the
design; `docs/design/2026-09-05-chat-app-channels.md` records what the cut removed and which
three observer controls it restored.

Schema and edge are lane L1, landed and live in production on 2026-09-05. This lane changes
`site/` only. No wire change: `post_signal` has taken `thread_root_id` and
`broadcast_to_channel` since that landing, and `cswarm reply --thread` already sends them.

## Files here

| file | what it is |
|---|---|
| `mutate.mjs` | The mutation harness. One entry per thing a test claims to defend; `mutation-table.txt` carries the count, so it is not typed twice. |
| `mutation-table.txt` | Its output: baseline green, then red-for-the-named-assertion and green again for every entry, with the count on its last line. |
| `measure-mobile.mjs` | The phone measurement. Serves `site/dist` in sample mode and reads the layout inside an iframe sized to the phone. |
| `mobile-measurements.json` | Its output, both viewports. |
| `mobile-390x844.png`, `mobile-320x568.png` | The feed at rest: threads collapsed, with the reply control and the count. |
| `mobile-reply-390x844.png`, `mobile-reply-320x568.png` | The reply bar open on the thread that is in a channel, with the thread expanded. |
| `arms/` | The two review arms on the final SHA. |

## What the browser does now

**A reply control on a root the server would accept.** `threadRootBlock` in
`site/src/lib/thread-reply.ts` is every arm of `resolveThreadRoot`'s own WHERE clause plus the
archive check that follows it: directed, already a reply, inside the server's one-second
liveness margin, or in an archived channel. The version cut in `c1774d7` asked two of the four
(`!isReply && signal.threadRootId === null && signalIsBroadcast(signal)`), so it offered the
control on a root that had expired and on a root in an archived channel — a button the server
answers 404 and 409 to.

The order of the four follows the server's, and that is not decoration: `resolveThreadRoot`
answers 404 for the three WHERE arms together, deliberately, so the refusal is not an oracle
for which ids exist, and checks the archive separately with its own 409. Asking the archive
first would name the wrong rule and send the reader to fix the wrong thing.

**`in_reply_to` needs no field on the browser's `Signal`.** Every `in_reply_to` row is stored
DIRECTED — `resolveSignalWriteTarget` re-addresses it to the referenced signal's author — so
the directed arm already excludes it. The server asserts `in_reply_to IS NULL` as well, belt
and braces on its side; the browser's single test is equivalent for every row that can exist.

**Replies collapse under their root** with a count that opens them in place. No drawer, no
navigation, and no second copy of the message. A reply whose root is not on the loaded page
keeps its own place as a row of its own: an expired or not-yet-paged root must not take a
visible message off the screen with it.

**The reply bar names the root and the channel it is in**, redrawing the slug from the live
channel list every time it syncs, so a rename between opening a reply and sending it is
reflected rather than frozen. Only the id is held. That is the rule the channels lane arrived
at after a review arm found a frozen slug making a Retry name a channel that no longer existed.

**`broadcast_to_channel` is offered only where the design allows it** — a root that is in a
channel. An unfiled thread has nowhere to send a reply: the edge stores the flag as true and
leaves `channel_id` null, so the request is accepted and does nothing. The CLI met exactly this
and a review arm found it there (`threadReplyMessage`, `src/cli.ts`, "Its thread is in no
channel, so --broadcast-to-channel had nothing to send it to"). The browser answers it one step
earlier, by not rendering a control that cannot do anything, and `syncComposerPlacement` clears
a box ticked for one thread so it cannot ride into a thread with no channel.

Every sentence in the bar is built in `thread-reply.ts` from the constants the enforcement
reads: the channel name from `channelLabel`, the unfiled name from `ALL_SIGNALS_SLUG`, the To:
sentence from the reach sentence rather than a second copy of it, the archived refusal from the
edge's own words. `thread-reply.test.mjs` asserts the last of those byte for byte against
`command/index.ts`.

## The To: row, and why there is no second write path

The task's second item: a thread reply carries no recipients, the To: row must say so and lock
while the reply bar is up, without a second write path.

`composerSendRecipients(to, threadReply)` in `site/src/lib/composer-address.ts` is the whole of
it. It is a DERIVATION and never a write:

- `composerRecipients()` — which the submit reads — is that call.
- `renderComposerTo` draws that same call, so the row and the wire cannot disagree.
- `deriveComposerAddress` **holds** while `replying` is true, exactly as it holds while
  `sending` is true and for the same reason: the pair on screen is already right and the
  inputs are not.

Nothing empties the pair, nothing stores an empty one over it, and nothing has to be put back.
An @tag typed inside a reply changes nothing; cancelling gives the reader the chips they had.

**The row draws that call in EVERY state, and a mutation is why.** The first version returned
early for a reply and drew a hardcoded empty row. "The row draws what the send posts" was then
true by accident — two separate rules both produced nothing — and breaking
`composerSendRecipients` changed the WIRE while leaving the row byte-identical. The mutation
reported `NOT CAUGHT`, which is what it is for. The loop is unconditional now, so a recipient
that reached a reply would appear as a chip; the only reply-specific things left are the empty
set's LABEL (`THREAD_REPLY_CHIP_LABEL`, "This thread", because the broadcast label names the
workspace and a reply's reach is the thread) and the sentence under it.
`composer-to-field.observer.test.ts` counts the callers of the pass, and the count moved by
exactly one — `setThreadReplyRoot`, one writer for both opening and closing a reply — with a
second assertion that names that caller so the count alone cannot accept a swap.

**One thing a reply DOES own: the remembered set.** `rememberComposerTo([])` REMOVES the stored
set, so an unguarded reply would have wiped the recipients of the reader's last real message
and the next message would have opened as a broadcast. A reply remembers nothing, because it
went to nobody.

## The mutation table

39 mutations, 0 problems. Two things carry NO mutation, and the harness says so in place rather
than carrying an entry that passes:

- `Number.isFinite(until)` in `threadRootBlock`. Removing it changes nothing: every comparison
  with NaN is false, so an unreadable expiry returns `null` either way, and Infinity behaves the
  same. The guard stays because it says the intent out loud; the test that asserts the
  BEHAVIOUR stays because the behaviour is real.
- `if (signal.threadRootId === null)` on the root registration in `groupSignalThreads`.
  `byRootId.get` is only reached for a row whose `threadRootId` is in `rootIds`, and every member
  of `rootIds` was registered either way, so the guard cannot change an output.

Four rounds of the harness were needed to get there, and each round's finding is recorded beside
its entry: a mutation that could not fail because it made two strings identical; a browser
assertion that read the same constant the render did, so moving the constant moved both; a
mutation that broke two claims at once and reported a wrong reason for a correct catch; and a
throwing wait that turned "the bar did not close" into "the measurement aborted".

## One rule for "is this send still addressed here"

The channels lane wrote two comparisons for that question and both arms found the contradiction
they created. This lane adds no third: `composerAddressStillPromised` is asked by the channel
switch that retires an intent and by the failure path that decides whether Retry may be
offered.

A top-level message is addressed to the channel on screen. A **reply is addressed to its
thread**, and the channel on screen has nothing to do with it: a reply to a message in #mobile
is written from all-signals as readily as from #mobile, and its placement channel is its root's
in both cases. The channel comparison alone would have called every such reply "addressed
somewhere else" and refused a valid Retry.

`composerIntent` therefore carries `placementThreadRootId` and `broadcastToChannel` beside
`placementChannelId`, on the mint AND on the rewrite the failure path makes. Leaving the
placement off that rewrite was a measured defect in the channels lane; leaving the thread off it
would make every retry of a failed reply a new top-level note.

## Threads and the channel filter compose

The task's third item. It holds because the SERVER stamps a reply with its root's channel:
`channel_id=eq.<mobile>` returns the root and its replies together, and so does the unfiltered
read. `groupSignalThreads` then runs over whichever page is on screen. No client-side
resolution through the root, and no second query.

Measured two ways. `signal-feed-threads.test.mjs` groups the same rows filtered and unfiltered
and asserts the #x group is byte-identical between them. The browser observer opens #mobile and
then all-signals and compares the replies under the same root, with the assertion that
all-signals is the wider view so the comparison is not two of the same page.

## Mobile

Measured in Chrome at 390x844 and 320x568 against `site/dist` in sample mode, in an iframe
sized to the phone — headless Chrome on macOS refuses a window narrower than 500px, so
`--window-size=390,844` reports a 500px viewport and would measure a layout no phone has.

| Measurement | 390x844 | 320x568 |
|---|---|---|
| App bar height (channel section's top, less the sample banner) | 97px | 65px |
| Transcript starts at the bar | yes | yes |
| Reply bar is inside the composer element | yes | yes |
| Composer at rest, threads collapsed | 99.38px | 128.81px |
| Composer with the reply bar open | 236.44px | 252.63px |
| Reply bar's own height | 108.88px | 108.88px |
| Reply bar, To: row, send button inside the viewport | yes | yes |
| Expanded replies inside the viewport | yes | yes |
| Document scrolls sideways | no | no |

**The 73px app bar is still the only in-flow header, and the gate on that is not this file.**
`mobile-feed-layout.observer.test.ts` measures the rule directly — the app bar's height IS the
channel section's top edge, and the transcript's own box must start at or above it — on a
signed-in layout with no sample banner, at both viewports, and it is green. The numbers above
are sample mode's, where a banner the signed-in app does not have sits in flow above
everything; it is reported and subtracted rather than hidden, so the arithmetic is visible.
**The 73px figure itself is the channels lane's measurement, on that other instrument. This
lane did not reproduce it and does not claim it.** What this lane establishes is the thing it
could have broken: the reply bar is INSIDE the composer, so it adds no band above the
transcript, and nothing this lane added sits in flow above the reading area.

**A cost, stated.** The composer more than doubles in height while a reply is being written —
99px to 236px at 390x844, 129px to 253px at 320x568 — because the bar carries three lines: the
target, the broadcast control, and Cancel. That is the reading area a reply costs while it is
open, and it is zero at rest, which is what the phone budget in
`composer-polish.observer.test.ts` is measured against.

## What this lane did NOT establish

1. **Nothing was measured against production.** Every live control here ran against `site/dist`
   built in sample mode and served locally. The signed-in paths — a real `post_signal` carrying
   `thread_root_id`, the server's clamp of the reply's horizon, the 404 for a directed root,
   the 409 for an archived channel — are covered by tests and by reading, not by a request that
   left this machine.
2. **The wire bodies are what this client BUILDS.** They are compared byte for byte against the
   bodies `tests/p1-server/chat-signals.test.ts` sends, read out of that file rather than
   retyped, with a positive control on the read. That suite is where a served edge answers for
   the shape, and it needs a local Supabase this lane did not take.
3. **The hold's effect is not measured in the browser.** `deriveComposerAddress` holding while
   `replying` is true is defended by source claims in two files and by the mutation table. Its
   observable effects are on STORAGE and on a roster prune arriving mid-reply, and no browser
   step here reaches either: after a cancel the chips are the same with the hold and without it,
   because the pass simply runs later over the same body. What the hold buys is that nothing is
   written while a reply is being composed, and that a paint cannot move the pair under a reader
   who is looking at a reply's sentence instead of at their chips.
4. **The reply horizon's clamp is not shown to the reader as a number.** The bar states the
   ceiling in words ("This thread ends in 2 minutes, and a reply cannot outlive it") when the
   root has one. The design also asks that **the post response report the clamped value**; the
   browser does not surface it, and the sample rows do not expire, so the window line was
   measured only in its empty form. Owed.
5. **`?t=` (a thread permalink) is not built**, and neither is `?m=`. §8.1 lists both and they
   are still owed, as the channels lane recorded.
6. **The one server number the browser mirrors rather than imports is the liveness margin.** It
   is a SQL interval literal inside a tagged template, so there is no constant to import.
   `signal-feed-threads.test.mjs` reads it back out of the edge and asserts the count of that
   clause before its value. The sweep's bound is stated in the test: it sees one exact clause
   shape inside `resolveThreadRoot` and nothing else, and a rewrite of that clause makes the
   count zero and the test red rather than quiet.
7. **The four-arm comparison is a source read of the edge**, bounded the same way: four exact
   clause strings inside `resolveThreadRoot` alone, each required to appear exactly once. It
   cannot see a rule moved elsewhere or written differently.
8. **No capacity or query-plan work.** A thread reply rides the same `channel_id` narrowing
   channels added; no plan was read.
9. **Sample mode now allows a reply**, which the cut version did not (`!sampleMode` was part of
   its `canReply`). That is deliberate — every browser control here needs the whole send path,
   and the composer To: lane had already made a sample send real — but it means the sample feed
   grows a row that no server holds, exactly as a sample post already did.
