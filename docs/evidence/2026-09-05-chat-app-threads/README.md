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
`site/src/lib/thread-reply.ts` is every rule `resolveThreadRoot` applies: directed, inside the
server's one-second liveness margin, in an archived channel, or already a reply. The version
cut in `c1774d7` asked two of the four
(`!isReply && signal.threadRootId === null && signalIsBroadcast(signal)`), so it offered the
control on a root that had expired and on a root in an archived channel — a button the server
answers 404 and 409 to.

**The order was wrong in this lane's first SHA, and a review arm found it.**
~~"every arm of `resolveThreadRoot`'s own WHERE clause plus the archive check that follows
it"~~ put `already-a-reply` in the WHERE and ahead of the archive. It is neither. The server's
real sequence, read off the function:

```
WHERE  directed, in_reply_to present, not live with a one-second margin   -> 404
then   the root's channel is archived                                     -> 409
then   the root is itself a thread reply                                  -> 400
```

So a reply in an archived channel is told the channel is archived, and the browser now says the
same. The old order told it that it was a reply, and a green test asserted exactly that — a
control pinning a false claim, which is the failure AGENTS.md names. The order is asserted now
against the EDGE'S OWN TEXT (the archive check must appear before the already-a-reply check in
`resolveThreadRoot`, and `THREAD_ROOT_BLOCKS` must order them the same way) rather than against
a list typed in a test.

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

**A thread's place has THREE states, not two.** The channel read soft-fails to an empty list, by
design, so a channel outage cannot take the feed down — and a thread in a real channel then has
a `channelId` this page cannot resolve to a name. Collapsing that into the unfiled case made the
bar say "Replying to X in #all-signals" about a reply that lands in a channel, which is a false
statement about where the reader's own message goes. `ThreadReplyPlace` separates them, the
unknown case names no place and says why, and `threadReplyMayBroadcast` refuses it, because the
broadcast label has to say which channel it would send to and there is no honest wording for
"some channel".

**The bar's second line is rewritten on every feed tick, and a BLOCK outranks the countdown.**
§6 P4 requires the ceiling on screen precisely because the remaining window can be
milliseconds; a line written once when the bar opened is the failure that requirement exists to
prevent. And the bar is opened against a row and held while a reply is written, so the root can
expire and its channel can be archived in that window: left as a countdown, an expired root
printed "This thread ends 2 minutes ago, and a reply cannot outlive it" — wrong in its tense and
silent about the thing that matters. The same classifier answers the bar and the send, so the
sentence a reader reads while typing is the sentence they get if they press Enter, and an
archived thread stops offering to broadcast rather than promising a second send on top of one
the server will not keep.

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

61 mutations, 0 problems. Two things carry NO mutation, and the harness says so in place rather
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

The review round then added seven more, for the rule order the arm corrected, the three places a
thread can be in, the block outranking the countdown, the broadcast control on a refused reply,
the bar's live tick, and the send reading the root it captured.

## The review rounds

| SHA | Grok | Gemini | What it found |
|---|---|---|---|
| `324c3a8` | FAIL | PASS | Grok, on two cells of THIS TABLE. It bound the leftover heading to `3315846` as "fixed in the same round" when the fix is `324c3a8` — a reader checking out the SHA in that row still finds the withdrawn claim — and it said `5791646`'s parent had "claimed none did" when `8f3a45f` claimed something narrower. It also typed a count of the class's instances that could not be reconstructed, in a file that already records a typed count of a list being wrong once. Both cells corrected below; the count is gone rather than replaced. |
| `3315846` | PASS | PASS | The withdrawal round. Grok found one leftover: `mutate.mjs`' block heading still read "AND NO RETIRED WAKE SENTENCE STANDS AS CURRENT" — the withdrawn claim standing as a comment, in the file that documents the class. It is fixed in `324c3a8`, the next commit, not in this one. One more instance of the class, found in the artifact about the class, which is the argument for handing the lead the shape rather than another instance. Neither arm could refute the thread surface, the To: lock, the send path, the wire, the mobile numbers, or the wake copy a reader sees. |
| `94ba3e9` | FAIL | FAIL | Both, independently, on one shape: a list of remembered substrings cannot close a family. Two real holes in the sweep besides: the phrase-list strip ran over all six files, and a sentence wrapped across two comment lines matched nothing. |
| `5eb63a5` | FAIL | PASS | Grok: the sweep was green while a retired sentence stood, in a file it named, in words its list missed by one adjective; three of eleven phrases matched nothing; both positive controls were satisfied by one file alone. |
| `5791646` | FAIL | PASS | Grok: four more retired wake sentences standing as current in one file. The claim they falsify is `5791646`'s OWN — its README said "no retired claim stands as current". Its parent `8f3a45f` had claimed something narrower and also false: "every retired sentence is kept beside its replacement". |
| `8f3a45f` | PASS | PASS | Grok: five comments still stating the retired wake rule as current, after the wake commit claimed every retired sentence was kept beside its replacement. |
| `ffd49bb` | — | — | Not reviewed on its own; folded into the `8f3a45f` round. |
| `74888c4` | FAIL | PASS | Grok: under a channel-list outage the send refused EVERY reply to a filed thread with "not in this workspace any more" — false twice over, and contradicting the bar, which correctly said the reply would be filed where the thread is. Plus a stale table cell, a comment still describing the retired two-state model, one still calling `already-a-reply` a WHERE arm, a `composerIntent` type missing `broadcastToChannel`, and a comment claiming the feed's resync "decides nothing" while it clears one control. Gemini: PASS, no findings. |
| `d257f87` | PASS | FAIL | Grok: `already-a-reply` is not a WHERE arm and the server checks the archive BEFORE it, so this lane's order, its prose and a green test were all built on a false claim; and `mobile-measurements.json` carried a To: sentence older than the constant. Gemini's FAIL is verified wrong at the cited lines and is ruled in `arms-d257f87/gemini/RULING.md`. |

**The Gemini finding, and why it is not acted on.** It said the `finally` block lowers
`composerSending` unconditionally, so a send from workspace A would clear the lock for a
composer in workspace B. The line reads
`if (composerSendToken === sendToken) setComposerSending(false);` — guarded on the send's own
token — and `resetComposer` bumps that token and lowers the flag itself on the way out of a
workspace, so the old send finds a token that is no longer its own. The line is also not in this
lane's diff: it landed with `lane/composer-to-field` and carries its own mutation entry there.

**Six more came from reading the lane's own code against the doctrine**, and they are the
reason that round changed behaviour rather than only prose: the false `#all-signals` sentence for
an unresolvable channel, the frozen window line, the past-tense countdown on an expired root, the
broadcast control offered on an archived thread, a live-global read inside the send, and the
README under-claiming the app bar it could measure.

**The round-two FAIL is the sharpest finding of the lane, and it was introduced by the round-one
fix.** Round one taught the BAR that a channel this page cannot see is its own state. It did not
teach the SEND, which went on applying the top-level rule — resolve the channel or refuse — to a
message that sends no channel at all. So the bar said one thing and Enter said another, and under
a channel outage nobody could reply to any filed thread. A reply is stopped by an ARCHIVED
channel only, which is knowable only when the row is loaded; everything else about its thread is
the server's to refuse, in the server's own words. That is five of the channels lane's seventeen
all over again: the next defect lives in the last fix.

**And one of this round's own, found before the arms:** `threadReplyBlock` was called twice in
the submit, each reading `Date.now()`. Across the server's one-second liveness boundary the two
reads can disagree, and one direction is silent — the first says blocked so the broadcast is
dropped, the second says live so the reply posts without the option the reader ticked. It is
captured once now, with everything else the send freezes.

## The wake rule, changed on the coordinator's instruction

`lane/wake-all-recipients` (PASS/PASS, deploying with the next release) makes every AGENT
recipient of a multi-recipient signal woken, at any position, and a person at position 0 no
longer means nobody is woken. This branch carries the SITE half of that as its own commit, so
the copy describes the behaviour that is deployed by the time the site is.

**The retired rule, kept because readers will still meet it** in
`20260905000010_signal_recipients.sql` section 4 and in older screenshots of this row:

> ~~recipients 1..N can READ a signal and can REPLY to it. They are not woken.
> `swarm.enqueue_signal_delivery()` reads the scalar column, so it wakes the recipient at
> position 0, and only when that recipient is an agent taking `ask` or `note`. A set whose
> position 0 is a PERSON wakes nobody at all, even when it names agents later in the list.~~

**What the row says now**, all of it generated:

| set | sentence |
|---|---|
| empty | `No agent is notified. Everyone here can read this.` |
| one person | `No agent is notified. Dana can read this and reply.` |
| one agent | `Wren is notified.` |
| a person then an agent | `Wren is notified. Dana can read this and reply.` |
| two agents | `2 agents are notified.` |
| a person then two agents | `2 agents are notified. Dana can read this and reply.` |

`NOTIFIED_POSITION` is gone. `notifiedRecipients` is the one rule, asked by the sentence, by the
mark on each chip, and by the sweep that checks the two agree; the COUNT comes from that
function's result rather than from a number typed in a sentence, and the reach clause counts the
people rather than the whole set, because an agent named as notified must not be counted again
as somebody who only reads.

**`SCALAR_POSITION` stays, because the scalar column is still real** — the edge still fills
`swarm.signals.to_agent_principal_id` from recipient 0, an old reader still shows that as the
target, and the feed row still prints it after its arrow. So the chip's promote control still
does something, and its label now says that thing: ~~"Put Wren first, so Wren is notified"~~ and
~~"Put Dana first. No agent is notified while a person is first"~~ become
`Put Wren first, so the message shows as addressed to Wren`. A test asserts that NO chip label
matches `/notif/i` for any set, because the row answers the wake question in one place.

**`browserSignalKind` is deliberately unchanged, and that is owed.** It still returns `ask` when
recipient 0 is an agent. It CANNOT contradict the row any more, because
`swarm.agent_delivery_is_wakeable` delivers both `ask` and `note`, so the kind no longer says
anything about the wake — but "ask when the set holds any agent" would be the tidier rule, and
it is a WIRE change rather than copy: it moves a body that every installed client and several
byte-exact tests compare literally. Recorded here rather than done in a copy commit.

**What this cannot check from this branch.** `20260905000020_wake_all_recipients.sql` is that
other lane's and is not in `supabase/migrations/` here, which ends at
`20260905000010_signal_recipients.sql`. So the control on the module's citation is a CITATION
control: it asserts the module explains the wake with `agent_delivery_is_wakeable` rather than
with the trigger the retired rule read, and that the retired trigger's name survives only inside
the strikethrough. It cannot assert the predicate exists. A reader who finds no such file has
found the two lanes applied out of order, not a bad citation.

Eight mutations cover it, and four of them were re-aimed after the first run reported a correct
catch under the wrong name.

**Two arms in a row found retired wake wording still standing as current, and the second one
is the more useful.** Round three named five comments; the commit that fixed those five then
claimed "no retired claim stands as current", and round four found FOUR MORE in one file —
including a comment saying nobody is woken sitting directly above the assertion that Orbit is.
Neither is on screen, so neither was a break for a reader. Both made a claim of this lane's own
false.

**THIS CLASS RAN THREE ROUNDS, and the third one was against the control itself.** Round five
found the sweep GREEN while a retired sentence stood — in a file the sweep already named, in
words the phrase list missed by one adjective (~~`the only recipient it wakes`~~ against a
listed ~~`one recipient the service wakes`~~), in a file with no strikethrough anywhere for a
reader to notice. It also found that three of eleven listed phrases matched nothing, that both
positive controls were satisfied by `LiveDashboard.astro` alone (567,988 characters against a
200,000 total), and that the README typed a count of the list and got it wrong.

**ROUND SIX THEN FAILED BOTH ARMS ON THE SAME CLASS AGAIN, and this file's own words were the
instance.** ~~"The sweep is rebuilt rather than patched, and the three things that let it pass
while a sentence stood are each closed"~~ and ~~"a sentence in the family of a listed phrase
cannot slip past on an adjective or a line break"~~ were what this paragraph said. Both arms
refuted it independently and named one shape:

> **A list of remembered substrings cannot close a family.** Normalising case and whitespace
> catches a line break and a capital. It does not catch an adjective in the middle. Grok
> constructed two that pass today: `the only recipient the service wakes`, a blend of the two
> listed forms, and `the sole recipient it wakes`, one adjective off the phrase round five added.
> Each round has added the last miss and then claimed the family; the next standing sentence is
> the wording nobody remembered to type.

**So the claim is withdrawn rather than narrowed again, and the class goes to the lead open.**
What the sweep is, exactly: a NAMED-SUBSTRING control over six named files. It makes the nine
leftovers two arms found un-reintroducible and it fails loudly on wording that has drifted. It
does not close the family, and `composer.observer.test.ts` is on its file list while contributing
zero listed phrases — a retired sentence could stand there in any unlisted wording and the sweep
would stay green.

Two things it does establish that the earlier versions did not, and two holes the arms found in
it that are fixed:

1. **Every listed phrase must match something.** A phrase that matches nothing is a line that
   changes no behaviour; it is a red now, which is the only thing that makes "adding to the list
   changes what runs" a fact rather than a hope.
2. **Every named file must be read individually**, so five paths aimed at one big file cannot
   satisfy a total. A wrong path throws.
3. **The phrase list is stripped from its own file only.** The strip ran over all six, so any
   other file declaring `const retired = [` would have had its contents removed before the scan
   — a hole in the shape of the thing the sweep is for.
4. **Comment markers are dropped before the spaces collapse.** A sentence wrapped across two
   `//` or ` * ` lines normalised to `... the service wakes // nobody ...` and matched nothing,
   which is the same miss one layer down.

The list of files grew to six: `composer-address.test.mjs` itself, which is where the wake
copy's own tests live and which carried a retired sentence in an assertion message that no
earlier list covered. The phrase list is removed from its own scan by its declaration rather
than by skipping that file, so everything else in it is still swept.

**Four mutations, and the first is of the SUBJECT rather than the checker**, which is the shape
an empty-set assertion needs: breaking a checker cannot fail a claim that nothing is there. They
put a retired sentence back as current in two different files, add a phrase that matches
nothing, and point one path at a file that does not exist. An earlier entry that swapped one
path for a duplicate of another changed nothing any assertion could see and was reported
`NOT CAUGHT`.

**And the count in this paragraph is not typed.** `mutation-table.txt` carries it.

**And the CLIENT half of that lane is not on this branch either.** `src/listener/hook.ts` still
filters a delivery on `signal.to_agent === stored.principalId`, which is the check the wake lane
widens in `hydrateDeliveryRefs` so an installed listener takes a position-1 row. That is `src/`,
which this lane does not own. The site copy is therefore ahead of BOTH the migration and the
listener in this repository, and it is correct only once that lane deploys — which is the order
the coordinator specified.

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

**The signed-in app bar is 73px at 390x844 and 57px at 320x568**, and this lane measured it
rather than deferring to another document. Those are `shell.channel.top` from
`mobile-feed-layout.observer.test.ts`, with `shell.channelBody.top` equal to it at both widths,
in this lane's own green run of `npm --prefix site test`. That test is the gate on the rule —
the app bar's height IS the channel section's top edge, and the transcript must start at or
above it — and it runs on a signed-in layout, which is the layout the rule is about.

The table below is SAMPLE MODE, where a banner the signed-in app does not have sits in flow
above everything. It is reported with the banner subtracted so the arithmetic is visible, and
the residue (97px and 65px rather than 73px and 57px) is sample mode's own chrome, not a header
this lane added. What the table establishes is the thing this lane could have broken: the reply
bar is INSIDE the composer, so it adds no band above the transcript.

| Measurement (sample mode) | 390x844 | 320x568 |
|---|---|---|
| Channel section's top, less the sample banner | 97px | 65px |
| Transcript starts at the bar | yes | yes |
| Reply bar is inside the composer element | yes | yes |
| Composer at rest, threads collapsed | 99.38px | 128.81px |
| Composer with the reply bar open | 236.44px | 265.88px |
| Reply bar's own height | 108.88px | 108.88px |
| Reply bar, To: row, send button inside the viewport | yes | yes |
| Expanded replies inside the viewport | yes | yes |
| Document scrolls sideways | no | no |

**A cost, stated.** The composer more than doubles in height while a reply is being written —
99px to 236px at 390x844, 129px to 266px at 320x568 — because the bar carries three lines: the
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
3. **A channel move does not close an open reply bar, and that is deliberate.** A reply is
   addressed to its thread, not to the view, so the box goes on promising that thread whatever
   channel the reader moves to — which is the same reason `composerAddressStillPromised` does
   not retire a reply's unfinished send on a channel move. The root may not be on the new
   channel's page; the reply still lands in the thread. Not measured in the browser.
4. **The reply control can survive its root by up to one poll.** The feed's expiry timer fires
   at the root's `until`, not at `until` minus the server's one-second margin, so in that last
   second the control can still be on screen until the next 2-second poll re-renders. Nothing
   wrong is posted: the send asks the same classifier and refuses with the server's own
   sentence, and the bar now shows that sentence too.
5. **The hold's effect is not measured in the browser.** `deriveComposerAddress` holding while
   `replying` is true is defended by source claims in two files and by the mutation table. Its
   observable effects are on STORAGE and on a roster prune arriving mid-reply, and no browser
   step here reaches either: after a cancel the chips are the same with the hold and without it,
   because the pass simply runs later over the same body. What the hold buys is that nothing is
   written while a reply is being composed, and that a paint cannot move the pair under a reader
   who is looking at a reply's sentence instead of at their chips.
6. **The reply horizon's clamp is not shown to the reader as a number.** The bar states the
   ceiling in words ("This thread ends in 2 minutes, and a reply cannot outlive it") when the
   root has one. The design also asks that **the post response report the clamped value**; the
   browser does not surface it, and the sample rows do not expire, so the window line was
   measured only in its empty form. Owed.
7. **`?t=` (a thread permalink) is not built**, and neither is `?m=`. §8.1 lists both and they
   are still owed, as the channels lane recorded.
8. **The one server number the browser mirrors rather than imports is the liveness margin.** It
   is a SQL interval literal inside a tagged template, so there is no constant to import.
   `signal-feed-threads.test.mjs` reads it back out of the edge and asserts the count of that
   clause before its value. The sweep's bound is stated in the test: it sees one exact clause
   shape inside `resolveThreadRoot` and nothing else, and a rewrite of that clause makes the
   count zero and the test red rather than quiet.
9. **The four-arm comparison is a source read of the edge**, bounded the same way: four exact
   clause strings inside `resolveThreadRoot` alone, each required to appear exactly once. It
   cannot see a rule moved elsewhere or written differently.
10. **No capacity or query-plan work.** A thread reply rides the same `channel_id` narrowing
   channels added; no plan was read.
11. **The wake copy is ahead of the code in this repository.** Neither
   `20260905000020_wake_all_recipients.sql` nor the `src/` half of that lane is on this branch.
   Nothing here measures the new wake against a database or a listener; what is measured is that
   the SENTENCES follow one rule, that the rule and the chip marks agree, and that no retired
   phrase ON A NAMED LIST stands outside a strikethrough IN SIX NAMED FILES. That is narrower
   than "no retired claim stands as current", which is what this file said before round four
   found four counterexamples to it, and it is narrower on purpose: it is what a sweep can
   establish. The behaviour is `lane/wake-all-recipients`' to establish, and it
   reported PASS/PASS.
12. **Sample mode now allows a reply**, which the cut version did not (`!sampleMode` was part of
   its `canReply`). That is deliberate — every browser control here needs the whole send path,
   and the composer To: lane had already made a sample send real — but it means the sample feed
   grows a row that no server holds, exactly as a sample post already did.
