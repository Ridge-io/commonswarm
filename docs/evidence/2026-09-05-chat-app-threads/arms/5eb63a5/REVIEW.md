# Review brief — lane/chat-app-threads @ 5eb63a5 (round five)

You are reviewing ONE lane of the CommonSwarm repo. Read the diff at the absolute path you were
given. It is `git diff 89ac83bc75f35581e5ccd090230615968279661d..5eb63a5`. Read it in full before
you write anything.

**Before your findings, quote back the first `diff --git` line of the patch, verbatim.** A review
that does not quote it did not read the diff and does not count.

**The last line of your reply must be exactly `VERDICT: PASS` or `VERDICT: FAIL`.**

## ROUND FIVE. One commit is new, and it is the answer to round four

Round four: one PASS, one FAIL. The FAIL was correct and was about a CLAIM, not behaviour.
Round three had named five comments still stating the retired wake rule as current; the commit
that fixed those five then asserted "no retired claim stands as current", and round four found
four more in one file — including a comment saying nobody is woken directly above the assertion
that Orbit is.

The new commit, `5eb63a5`, fixes those four and turns that twice-wrong general claim into a
control: `composer-address.test.mjs` sweeps five named files for eleven retired phrases and
requires each occurrence to sit inside a `~~ ~~` span.

**Attack the control itself, hardest:**

- Does the sweep do what its header says it does, and is its stated bound the real one? (Ask
  that, not whether it is complete.)
- Its subject is an EMPTY SET. Its mutation therefore breaks the SUBJECT — it puts one retired
  sentence back as current — rather than the checker. Is that mutation reaching the assertion it
  names? Is there a way the sweep passes while a retired sentence stands?
- The two positive controls: can either be satisfied by a sweep that read the wrong thing?
- Are the four newly struck comments now false in the other direction, and is the README's
  narrowed claim actually what the sweep establishes, no more?

Then re-attack the rest, which four rounds of arms have already been over.

## What was new in round four

Round three was PASS/PASS on `8f3a45f`. The only change since is `5791646`, and it is
COMMENTS ONLY: five places that still stated the retired wake rule as though it were current,
found by the round-three arm, now carrying the retired wording in strikethrough beside its
replacement. No behaviour moved, and the gates and the 57-entry mutation table are unchanged.

**Read that commit first and judge it on its own**: is any of the five now saying something
false in the OTHER direction, is any retired sentence simply deleted rather than kept, and does
any of the replacements contradict the code beside it? Then re-attack the rest, which is
described below and which two rounds of arms have already been over.

## The lane also carries a SECOND SUBJECT

The last commit, `8f3a45f`, is not thread work. The coordinator added it mid-lane: another lane
(`lane/wake-all-recipients`, PASS/PASS, deploying with the next release) changed WHO A SIGNAL
WAKES, and this branch carries the site copy for it so the words describe the deployed
behaviour.

**The new rule.** Every AGENT recipient of a multi-recipient signal is woken, at any position.
A person is never woken. The retired rule woke recipient 0 only, and only when it was an agent,
so a set whose first recipient was a person woke nobody at all.

**Attack that commit as hard as the thread work**, and specifically:

- **A sentence that is now false, or one whose list is typed.** Read every string
  `composerDeliveryNote` and `composerPromoteLabel` can produce, for every set the cap allows.
  Does any of them claim a wake that will not happen, or miss one that will? Is the COUNT of
  woken agents computed from the set, or is a number written into a sentence?
- **The migration this copy describes is NOT on this branch.** `supabase/migrations/` here ends
  at `20260905000010_signal_recipients.sql`. So the copy is ahead of the code in this
  repository. Is that stated honestly in the evidence README and in the test that cites the
  predicate, or does something assert a file nobody has?
- **`browserSignalKind` was deliberately NOT changed.** It still returns `ask` when recipient 0
  is an agent, while the wake now follows every agent. Is that defensible, is the reason
  recorded, and — the real question — can the kind and the To: row now disagree in front of a
  reader in any way that matters?
- **`SCALAR_POSITION` survived and `NOTIFIED_POSITION` did not.** The chip's promote control now
  claims to move which recipient the message "shows as addressed to". Is that true? Trace it to
  the wire and to what the feed row prints.
- **Retired wording.** This repo requires a superseded sentence to be kept beside its
  replacement where readers may still meet it. Is any retired claim simply deleted, and is any
  retired claim still standing somewhere as though it were current?

## What round one and round two found, so you do not re-find them

Round one ran on `d257f87`: one arm PASS, one FAIL. Every change since is in the diff you are
reading, and the SHA moved, so **judge the code in front of you, not this summary.** It is here
so you spend your attention on what is new.

- **The FAIL was verified wrong.** It said the submit's `finally` lowers `composerSending`
  unconditionally, so a send from one workspace would clear the lock in another. The line is
  `if (composerSendToken === sendToken) setComposerSending(false);`, and `resetComposer` bumps
  that token on the way out of a workspace. The line is not in this diff either. Ruled in
  `docs/evidence/2026-09-05-chat-app-threads/arms/d257f87/gemini-RULING.md`, which is in the
  diff — check the ruling if you think it is wrong.
- **The PASS arm found a real error in prose and order.** `already-a-reply` is NOT one of
  `resolveThreadRoot`'s WHERE arms, and the server checks the archive (409) BEFORE it (400).
  The lane had them the other way round, said so in three places, and had a green test pinning
  the wrong claim. Fixed this round.
- **Six more came from the lane's own re-reading**, all in this diff: a false "#all-signals"
  sentence for a channel this page cannot name; a window line written once and left to go stale;
  a past-tense countdown on an expired root; a broadcast control still offered on an archived
  thread; a live-global read inside the send; and a README that under-claimed the app bar
  number it could actually measure.

**Round two's FAIL, and what it cost.** Round one taught the reply BAR that a channel this page
cannot name is its own state. It did not teach the SEND, which went on applying the top-level
rule — resolve the channel or refuse — to a message that sends no channel at all. Under a
channel-list outage the bar said the reply would be filed where the thread is (true) and Enter
refused it with "not in this workspace any more" (false, and the edge would have taken it).
Fixed in `ffd49bb`: a reply is stopped by an ARCHIVED channel only. Four more of that arm's
findings and one of the lane's own are in the same commit.

**So attack the NEW work hardest**: `ThreadReplyPlace` and its three states,
`threadReplyWindowText`'s block arm, `threadReplyMayBroadcast`'s block arm, `threadReplyBlock`
and `threadReplyPlaceOf` in the dashboard, the `syncComposerPlacement()` call added inside
`renderFeed`, and the reordered `THREAD_ROOT_BLOCKS`. A fix round is where this repo's arms have
repeatedly found the NEXT defect: five of the channels lane's seventeen were introduced by an
earlier round's fix.

## What the lane is

CommonSwarm is a coordination service. Agents and people post short immutable signals. The
browser workspace app is `site/src/components/app/LiveDashboard.astro` (a single Astro component
with a large inline client script). The server side is a Deno edge function,
`supabase/functions/command/index.ts`, which this lane does **not** change: `post_signal` has
accepted `thread_root_id` and `broadcast_to_channel` in production since earlier the same day.

This lane adds the browser half of threads:

1. A **reply control** on a message that can be the root of a thread.
2. Replies **collapsed under their root** with a count that expands them in place.
3. A composer **reply bar** naming the root and the channel the root is in, with a
   `broadcast_to_channel` checkbox offered only where the root is in a channel.
4. A thread reply **carries no recipients**: the composer's `To:` row says so and is locked
   while the reply bar is up, with no second write path.
5. Threads and the channel filter **compose**: a reply in `#mobile` reads under its root in
   `#mobile` and again in `all-signals`.

## Rules this repo enforces, so you can judge against them

- **An enumeration inside a user-facing string must be GENERATED from the constant the code
  enforces with**, never typed. This repo measured that failure four times in one release cycle,
  each time after two review arms passed.
- **A claim control proves stability, not truth.** A green test that pins a user-readable string
  can be defending a false claim. Check each claim against what the underlying system does.
- **Never branch on `error.message`.** Classify with a named code or class.
- **A negative result must reach the path it claims to test.** Ask what a probe would return if
  the feature were present and working; if the answer is the same, it measured nothing.
- **Copy must hold for BOTH the hosted workspace and the optional local listener.** No claim of
  privacy, control, authority or enforcement. Plain, calm voice. No em-dashes in user-facing text.
- **Corrections go in the artifact**, with the retired wording preserved where readers may still
  meet it.

## The server rules this lane's browser code must not contradict

From `resolveThreadRoot` in `supabase/functions/command/index.ts` (NOT in this diff — read it in
the repo if you need it). A thread may root only on a signal that is:

- undirected (`to_user_id IS NULL AND to_agent_principal_id IS NULL`),
- not itself an `in_reply_to` row (`in_reply_to IS NULL`),
- not already a thread reply (`thread_root_id IS NULL`),
- live with a one-second margin (`until > statement_timestamp() + interval '1 second'`),
- and its channel not archived.

`chatSignalShapeProblem` in `supabase/functions/_shared/channels.ts` refuses a thread reply that
also carries a recipient, a channel, an `in_reply_to`, or a `working-on` kind.

## Eight things to attack. Try to refute each; say so when you cannot.

0. **The fix round introduced something.** `syncComposerPlacement()` now runs inside
   `renderFeed`, which is called on every poll, every post, every filter click and every expiry
   tick. Does it write anything it should not, read anything mid-transition, or run in a state
   where the composer is not the reader's? Does it cost anything at 25 rows? And
   `threadReplyBlock` reads `channels` and `Date.now()` on every one of those calls — is that a
   render deciding state, or only choosing a sentence?

1. **The reply control lies.** Find a message where the browser offers "Reply in thread" and the
   server would refuse the reply, or the reverse. `threadRootBlock` in
   `site/src/lib/thread-reply.ts` claims to be all five server rules; the browser's `Signal` type
   has no `in_reply_to` field and the code argues that the directed test covers it. Is that
   argument sound for every row that can exist? Is the archived-channel question asked of the
   right channel in every view (note there are now two variables, `rowChannel` and `rootChannel`,
   that look alike and answer different questions)?

2. **The `To:` lock has a second write path.** The lane claims the reply's empty recipient set is
   a DERIVATION (`composerSendRecipients`) and never a write, and that
   `deriveComposerAddress` merely HOLDS while a reply is in progress. Find a handler that assigns
   `composerTo`, `composerToApplied`, or writes storage while a reply is up; or a path where
   cancelling a reply does not give back the address the reader had; or one where an `@tag` typed
   inside a reply reaches the wire.

3. **The wire body is wrong.** `browserSignalCommand` builds the `post_signal` body. Compare what
   a reply sends against `installedPost({ thread_root_id })` in
   `tests/p1-server/chat-signals.test.ts`. Is any key sent that the edge would refuse, or any key
   sent as an explicit `null` (the edge's `exactKeys` refuses unexpected keys)? Is
   `broadcast_to_channel` ever sent without a `thread_root_id`?

4. **The unfinished-send rule is wrong for one of its two callers.**
   `composerAddressStillPromised` is asked by `selectChannel` (retiring an intent when the reader
   moves channel) and by the submit's `catch` (deciding whether Retry may be offered). Construct
   a sequence where it gives the wrong answer: a reply whose Retry is refused when it should be
   offered, or offered when the message would land somewhere the reader is not promising. Note
   `composerIntent` now carries `placementChannelId`, `placementThreadRootId` and
   `broadcastToChannel`, and the command id is the server's idempotency key.

5. **Something the send owns sits behind a screen guard, or the other way round.** This file's
   history is six defects of exactly that shape. The submit captures `replyRoot`,
   `sendDraftKey`, `sendToKey`, `sendToken`, `placementChannelId`, `placementThreadRootId`,
   `broadcastToChannel`. Find work the SEND owns that is skipped when the reader moved workspace,
   or work the SCREEN owns that runs when the composer is no longer this send's.

6. **A sentence is false, or a list inside one is typed rather than generated.** Read every
   string a reader can see in `site/src/lib/thread-reply.ts` and every one built in
   `LiveDashboard.astro`'s reply bar. Does any of them claim a wake that does not happen, a
   privacy this product does not have, a channel that may not exist, or an option the code does
   not offer? Is the archived refusal the same words the server uses?

7. **A control cannot fail, or fails for a reason other than the one it names.** Read
   `site/src/components/app/chat-threads.observer.test.ts`,
   `site/src/lib/thread-reply.test.mjs`, `site/src/lib/signal-feed-threads.test.mjs`, and
   `docs/evidence/2026-09-05-chat-app-threads/mutate.mjs`. Two guards are declared NOT CONTROLLED
   with a stated reason — check those reasons are true. The two source sweeps state their own
   bounds in their headers: **ask whether each sweep does what it says it does**, not whether it
   is complete.

8. **A retired control was weakened rather than moved.** This lane edits four pre-existing
   observer files: `composer.observer.test.ts` (a negative gate on the word "thread"),
   `transcript-shape.observer.mjs` and `composer-sprint.observer.test.ts` (two pins on the
   display reversal), and `chat-channels.observer.test.ts` (several pins on the send's
   placement). In each case, is the CLAIM the same and only its expression changed, or did the
   lane quietly assert less than before?

## Also worth your time

- `groupSignalThreads` in `site/src/lib/signal-feed.ts` is handed the array in DISPLAY order and
  the renderer puts back what it returns. Can any input make it drop a row, render one twice, or
  move a row away from where it was written?
- The phone measurement in `docs/evidence/2026-09-05-chat-app-threads/` reports an app bar of
  97px at 390x844 with the sample banner subtracted, while the design elsewhere says 73px. The
  README states that difference and says the 73px figure belongs to another instrument. Is that
  honest, or is it covering a regression?
- `docs/evidence/2026-09-05-chat-app-threads/README.md` has a "What this lane did NOT establish"
  section. Is anything in the diff claimed more strongly than it was measured, and is anything
  missing from that list that belongs on it?

Report findings with file and line. For each, say what breaks and for whom. If you cannot refute
a claim, say that plainly rather than padding. Then the verdict line.
