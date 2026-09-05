# Review brief — lane/chat-app-threads @ d257f87

You are reviewing ONE lane of the CommonSwarm repo. Read the diff at the absolute path you were
given. It is `git diff 89ac83bc75f35581e5ccd090230615968279661d..d257f87`. Read it in full before
you write anything.

**Before your findings, quote back the first `diff --git` line of the patch, verbatim.** A review
that does not quote it did not read the diff and does not count.

**The last line of your reply must be exactly `VERDICT: PASS` or `VERDICT: FAIL`.**

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
