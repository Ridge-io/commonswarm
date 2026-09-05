# Channels in the workspace app (lane L4, `chat-app-channels`)

The browser half of the chat platform. `docs/design/2026-09-04-chat-platform-reconciled.md` is the
design and rules on every question it answers; `docs/design/SWARM-CLOUD.md` is canonical over both.
This file records what this lane built, what it measured, and what it did not establish.

Schema and edge are lane L1, landed and live in production on 2026-09-05 (merge `8adf55a`). This lane
changes `site/` only. No wire change: the browser reads `swarm_read.channels` and `swarm_read.signals`
directly and sends the three channel commands the command edge already accepts.

## What a channel is, as the app says it

A channel is the **address** of a message, not a scope on who reads it (design D3). Every member of the
workspace reads every channel. Filing a message in one changes nothing about which agent is woken:
`swarm.signal_deliveries` and `swarm.enqueue_signal_delivery()` are untouched by the whole chat plan.

`all-signals` is not a channel. It is the whole feed, filed and unfiled together, which is why the
command edge reserves that slug (`RESERVED_CHANNEL_SLUGS`). `site/src/lib/channels.test.mjs` asserts
that reservation rather than assuming it: if the edge stopped reserving the name, a member could create
a channel that shadows the one place unfiled messages are readable.

Two facts the design requires in the UI rather than in a help page, and where they are:

| Fact | Where the reader meets it |
|---|---|
| Every member reads every channel, and messages in a channel still expire | `CHANNEL_REACH_TEXT`, at the top of the channel dialog and as a channel's description when it has no purpose |
| Nothing written before a channel existed can be in it | `CHANNEL_EMPTY_TEXT`, in the empty state of a channel |
| Archiving hides and refuses, and deletes nothing | `CHANNEL_ARCHIVED_TEXT`, as an archived channel's description, and the archive control's own hint |

## The narrowing is the query's

`signalPage` takes a `channelId` and applies `channel_id=eq.<uuid>` on the read. Both readers
(`loadSignals`, `refreshLatestSignals`) capture the channel with the request and check it again when
the page lands, the same way they already check the workspace.

This is the one thing the design is explicit about not copying. The shipped
`All / Broadcast / Direct to you` filter runs in the browser over the loaded page, so it says "your
direct signals" and means "among the last 25 loaded". A channel filter of that shape would say
"the messages in #mobile" and mean "the ones that happened to be loaded". `filterSignalsByChannel` was
written, then deleted; `site/src/lib/signal-feed.ts` records why in its place.

The view's `WHERE` remains the authorization. A client-issued equality on top of it cannot widen
anything, which is what makes a client-chosen narrowing structurally safe.

**Sample mode is the one exception and it is bounded.** `/app` served without a deployment renders a
made-up feed with no server behind it, so clearing the rows and asking for a page replaces the sample
with "This saved page is not connected to CommonSwarm" — measured, before the branch that prevents it.
Sample mode narrows its own array. The dishonesty a client-side filter usually carries is absent there
because the sample IS the whole set — which held only until someone posted into it. A sample post
reached `signals` and not the snapshot, so posting and then switching channel made the post vanish and
made that argument false. Found by a review arm; the set grows with the post now.

## The composer posts where you are reading

> **CORRECTED 2026-09-05, `lane/composer-to-field`.** The operator reversed the TO-row half of
> that direction the next day and asked for chips back, so the 80px budget it bought is spent;
> the measured resting height is pinned in `composer-polish.observer.test.ts`. What still holds
> is the CHANNEL half: the composer posts where you are reading and gains no chrome for it. The
> To: row addresses people and agents and never names a channel.

R10, and the 2026-09-04 operator direction that deleted the TO row from an 80px bar. There is **no
channel dropdown**. The task brief for this lane asked for "a channel selector when a channel is
active"; the reconciled design at §8 forbids exactly that ("Zero chrome ... the same reasoning deletes a
channel dropdown"), so the lane followed the design and this paragraph is the record of the difference.

What the reader gets instead is the destination inside the box they are typing into: the placeholder
and the accessible name become `Message #mobile` when a channel is active, and stay
`What are you about to do?` in all-signals, where the post is unfiled. That costs zero pixels.

There is **no `#` parsing of the body, ever**. Bodies contain `#` legitimately: a Markdown heading
renders in a message, and `#1804`-style references are routine in this workspace's own prose. A parser
could not tell an address from prose.

## Threads are not in this lane

**Cut on 2026-09-05 by the coordinator, after six review rounds.** The thread surface was built here —
a reply control on eligible roots, replies collapsed under their root with a count, a composer reply
bar, and `broadcast_to_channel` — and it is removed to `lane/chat-app-threads` so a smaller correct app
can land. Four of the six defects the arms found in round six lived in that half.

The browser therefore never sends `thread_root_id` or `broadcast_to_channel`. A reply written from the
CLI still reads: it renders inline in the flat feed, interleaved by time, which is exactly what the
reconciled design states for a client that does not know about threads. The feed is noisier and nothing
is hidden.

`groupSignalThreads` and `threadReplyCountLabel` are cut with it; `signal-feed.ts` records where they
went. Three observer controls the thread work had moved are **restored to their original form**: the
composer's `/emoji|reaction|thread/i` gate, and the two reversal pins in `transcript-shape.observer.mjs`
and `composer-sprint.observer.test.ts`.

## The URL

`?w=<workspace_id>` and `?c=<channel_id>`, by id and not by name, so a rename does not rot a link.
`?w=` is honoured only when it names a workspace already in this reader's own memberships: the address
bar is a convenience, never an authorization.

**A post belongs to the channel it was sent from.** A channel click does not bump `requestVersion`,
because it is not a workspace change, so the composer's success and failure paths were guarded on the
workspace alone: send in one channel, switch while it is in flight, and the row was prepended to the
other channel's page and survived the next poll, which keeps any local id the fetched page does not
carry. The channel is captured with the send now.

**And the channel decides one thing only: where the rows land.** Two attempts at that were wrong before
this one, and both arms found both. Returning early on a channel change skipped the send's own cleanup,
so the draft stayed saved, the pending rows stayed in two caches, the status stayed on "Posting…", and
on the failure path the body was deleted with no error and no Retry, because the focus move that
follows a channel click blurs the emptied box and flushes the draft. Comparing the view the send began
in with the view it ended in then dropped a row posted in a channel and read from all-signals, where it
does belong, and stripped rows out of a page that had already fetched them, so a row appeared, vanished
and came back on the next poll.

The rule is the one the list on screen already applies, asked of the row: `showsOnScreen(row)` is true
when there is no channel narrowing or when the row's own `channel_id` — the server's, not the client's
guess — matches it. A row is removed from the list only when it is about to be put back.

**A retry replays the address the message was sent to, and that address is an ID.** `composerIntent`
carries `placementChannelId` beside the command ids, on the mint AND on the rewrite the failure path
makes; leaving it off that rewrite was its own defect, because the replay reads it and
`postBrowserSignal` defaults a missing address to `{}`, so every retry after a partial failure posted
unfiled with no channel switch involved.

It is the id and never the slug. `post_signal` takes a slug and the edge resolves it against the live
row, so a rename between a failed send and its Retry made the replay name a channel that no longer
exists — or, if another member had taken the freed name, someone else's. The slug is resolved from the
id at the moment of sending, and a send whose channel is gone **or archived** is refused with a
sentence rather than posted unfiled. Archived matters on its own: `channelById` finds an archived
channel deliberately, because a permalink into one still has to resolve, so a check that only asked
whether the row exists left a Retry sending into a channel the server refuses, lit, forever.

**An unfinished send survives only while the composer still promises its address.** Two narrower
questions were tried and both were wrong: `changed` also fires when the unresolved state merely
clears, so clicking the place you were already in killed a valid Retry; and comparing the place being
left called a `?c=` heal into a different channel a no-op. The condition asks the thing that matters
directly — is the intent's channel the one the composer is about to name.

**The record of in-flight posts holds the row, not the id, and it is bounded in space and time.** A
channel move empties `signals`, so coming back before the read replica caught up an id-only record had
nothing left to put back. Holding the row then created two problems of its own, both found by arms on
the next SHA: a row that fell off the first page of its channel was re-prepended as the NEWEST message
every time the reader came back and the map grew for the life of the tab, and a message posted in one
workspace was painted into another workspace's feed, which no query of that workspace had returned.

The record exists for exactly one thing — the read replica not yet carrying a row this browser just
wrote — so it is bounded by that: `POSTED_ROW_GRACE_MS` (30 seconds, against a two-second poll) and the
workspace the row was written in. **The grace is a chosen bound and not a measured one**: no replication
lag was measured for this lane.

And the grace bounds how long a row may stand in, not WHERE it belongs. Replica lag and a page roll
share every other bit: both are a row the page does not carry. The difference is the timestamp, and
both timestamps are the server's. The boundary is the page's **oldest** row, compared on the whole key
the query orders by (`created_at DESC, id DESC`) and not the timestamp alone: a stand-in belongs when
the page is the whole history, or when it sorts at or above the last row on it. A row below that
has rolled off, and it is not lost — it is in history, where Load older fetches it.

Both halves of that took an arm. First the resurrection: a 20-second-old message painted above rows
newer than it, whenever a place filled 25 messages while the reader was away. Then the boundary
itself: comparing against the page's **newest** dropped a row that still belongs whenever one message
newer than it had already replicated, which in all-signals is any other member's next post — and the
observer control had **enshrined** that wrong comparison, which is the claim-control failure AGENTS.md
describes, caught by an arm and not by the gate. The stand-in is merged by the query's own order
rather than prepended, because it can be the second newest row and not the first. A third arm pass
then found the floor comparing timestamps only, which kept a row that shares the floor row's timestamp
with a smaller id — rolled off, but held on a page whose bound is twenty-five.

**And an unfinished send does not follow the reader to another channel.** Moving channel retires the
intent and says so, because the composer is about to promise the new channel and replaying the old
address would contradict the box being typed in. The hops that already landed stay where they landed.

That retirement then had to survive the failure that caused it: the catch block wrote the intent back
with the old placement, so Retry reused the old ids and the old address and the row landed in a channel
the reader had left, filtered off their screen. `resumable` is `unsent` AND still addressed to the
channel on screen; Retry is offered only when it can finish what it started, and the sentence otherwise
says where the message was going.

**A page fetched before a post landed does not drop that post.** A channel click starts a fresh page and
does not cancel a send. That page was requested before the post committed, so it cannot carry it, and
replacing the list wholesale dropped a row the new screen should show: posted in a channel, read from
all-signals, the message appeared, vanished, and came back on the next poll. `postedSinceReset` is
cleared as the request goes out and holds the ids this browser posted while it was in flight. Both the
success and the failure path record what they prepend — only the success path did at first, so a
partial failure during a channel click lost the hop that HAD landed — and an id leaves the set as soon
as a fetched page carries it, so it cannot grow for as long as a reader stays in one channel.

**Only an actual move retires an unfinished send.** The first version gated the retirement on `changed`,
which is also true when the unresolved state merely clears, so clicking the place you were already in
killed a valid Retry, replaced the send error with a sentence about a move that did not happen, and
left Enter minting fresh command ids that reposted every hop that had already landed. That is one of
six defects in this lane created by an earlier round's fix.

**A `?c=` belongs to the workspace its `?w=` names, and the URL is written on every open.** The first
version wrote it only when a channel was clicked, so switching workspace from the menu carried the
previous workspace's channel id into the new one, where it is not: the reader who chose workspace B was
shown "Channel not found" instead of B's feed, and a reload took them back to A. Found by a review arm.
A link the reader followed still resolves, because its own `?w=` is the workspace being opened.

A `?c=` that resolves to no channel here becomes an **honest empty state**, never the unfiltered
feed. The loaded rows in that case ARE the whole workspace's, because a channel that cannot be
resolved cannot narrow the query, so `renderFeed` stops before it renders a row and offers
`Open #all-signals`. The bad id **stays** in the address bar: dropping it would turn the link into the
unfiltered feed on the next reload, which is the same failure one step later.

**And there is no composer in that state.** Both review arms passed the rendered-rows claim; one then
found the hole beside it. The unresolved state is a `feed` view, the composer is shown in a `feed`
view, and a post from it went to the **unfiltered feed** while the head said Channel not found, with
`renderFeed` discarding the pending row so the writer saw nothing at all. The composer is now hidden
while `unknownChannelId` is set, and the submit refuses independently of that: visibility is the
affordance, the guard is the rule.

**What the state may say.** There is no such thing as a channel a member may not read, so the copy
may not imply one. An earlier version said "a channel that is not in this workspace, **or one you
cannot read**", which named a permission this product does not have; both arms caught it. The two
honest causes are that the id names no channel here, and that the channel list did not load — the
channel read soft-fails to an empty list so a channel outage cannot take the feed down, which makes an
empty list ambiguous. `channelListFailed` is what tells the two apart, and the sentences are generated
from it.

`?m=` (a message permalink) and `?t=` (a thread permalink) are **not** in this lane. §8.1 lists them and
they are owed.

## Mobile: the 73px app bar is still the only standing header

Measured in Chrome at 390x844 and 320x568, saved to
`docs/evidence/2026-09-05-chat-app/mobile-measurements.json` with screenshots beside it.

The rail's channel list is hidden on a phone with the rest of the rail, exactly as the STREAMS list was.
The control that replaces it rides in the feed toolbar, which floats over the transcript on a negative
margin equal to its own height, so it costs the reading area no height at all.

| Measurement | 390x844 | 320x568 |
|---|---|---|
| App bar height | 73px | 57px (the ≤34rem rules, unchanged by this lane) |
| Rail channel list height | 0 (hidden) | 0 (hidden) |
| Channel control height | 40px, the band's own 2.5rem | 40px |
| First message top, transcript at scrollTop 0 | 240.1 | 229.8 |
| First message clear of the floating band | 0px (it begins exactly at the band's bottom) | 0px |
| Document horizontal overflow | none | none |

**The first version of that file was wrong and a review arm found it.** It reported a 390x844 composer
rect under a 320x568 heading. The dashboard sizes itself from `visualViewport`, and CDP's device
metrics override does not always fire that event, so the page kept the previous layout while
`window.innerHeight` already reported the new one. The measurement now reloads after each resize, waits
until `innerWidth`, `innerHeight`, `visualViewport.height` and a rendered feed all agree with the size
being claimed, scrolls the transcript to the top (it opens pinned to the newest row, where the first
row is above the fold and says nothing about clearance), and then asserts every rect it reports lies
inside the viewport it names.

**A defect the measurement found, and the fix.** A slug may be 32 characters — `CHANNEL_SLUG_MAX`, the
edge's own bound. Uncapped, the control rendered 249px of it and the filter row beside it fell to **24px
of visible width at both widths**. The control is now capped at `8rem` with an ellipsis on its label:
128px at the longest legal name, leaving the filters 110px at 390 and 40px at 320, both scrollable, with
the first filter fully on screen in every case.

**A cost, stated.** The filter row now scrolls sideways at 390px, where all three labels used to fit.
That row already scrolled at 320px. The alternative was a second header row, which the 2026-09-04 ruling
forbids.

## What this lane did NOT establish

1. **Nothing was measured against production.** Every live control here ran against `site/dist` built in
   sample mode and served locally. The signed-in paths — the channel read from `swarm_read.channels`,
   the three commands against the real edge, the server-side `channel_id` narrowing, and the `?w=` /
   `?c=` round trip, which sample mode deliberately skips — are covered by tests and by reading, not by
   a request that left this machine.
2. **No thread reply can be posted from the browser at all**, by the cut above. What is asserted is the
   negative: the dashboard sends neither `thread_root_id` nor `broadcast_to_channel`. The wire bodies
   that ARE sent are checked byte-exact against the shapes `tests/p1-server/chat-signals.test.ts` sends,
   and that suite needs a local Supabase this lane did not take.
3. **The `?m=` message permalink and `?t=` thread permalink are not built.**
4. **Colour is lane L5** and shares these files. Nothing here changes `markAgentAvatar`.
5. **The To: field with multiple recipients is not built.** L2 `chat-recipients` is live in production
   (a signal can carry a `to` list of up to 8, and the read view carries `recipients`), and the To:
   field is its own lane after this one.
6. **Two composer paths pre-existing on `main` are routed, not fixed.** `refreshLatestSignals` builds
   `[...page.rows, ...signals.filter(not on page)]`, so a row the replica has not caught up to sits
   below the page for one tick (`d9fa25b:4360`). And staging or removing an attachment nulls
   `composerIntent` without hiding Retry, so a Retry after a file is added mints fresh command ids and
   reposts hops that already landed (`d9fa25b:2468` and `:2489`). Both were raised by an arm, both are
   byte-identical on `main`, and neither is about channels.
7. **The poll's own ordering was not changed.** `refreshLatestSignals` builds
   `[...page.rows, ...signals.filter(not on page)]`, so a row the replica has not caught up to sits
   below the page for one tick. An arm raised it; it is byte-identical on `origin/main` at
   `d9fa25b:4360`, it is not about channels, and it is routed rather than fixed here.
8. **No capacity or query-plan work.** `channel_id=eq.` rides the partial index L1 added; no plan was
   read.
9. **The source sweeps in the observer test state their own bounds** in the test headers. A regex over
   source cannot be complete, and neither of them claims to be. The privacy sweep reads double-quoted
   and backtick strings in eight script surfaces plus two pieces of markup plus the composer's
   refusals, with comments stripped and a positive control on the number of strings it read. What it
   cannot constrain, named rather than implied: a channel `purpose`, which a member types and the head
   renders verbatim.
10. **The rail's current mark and the head can no longer disagree**, but that was a defect and not a
   design: the channel buttons carry no `data-workspace-view`, so `activateWorkspaceView`'s own loop
   never reached them and the rail claimed a current channel while the head said Files. Found by a
   review arm. In the unresolved-channel state the rail marks NOTHING current, which both arms read
   and agreed is the honest mark: the reader is in the signals view and in no channel.
11. **Fifteen review rounds cost thirty-six product defects and two evidence defects**, every one found by an
   arm and none by a gate: the read-permission claim in the copy; the composer that posted into the
   unfiltered feed from an unresolved link; a double current mark on Files and Brain; four typed
   copies of the view's name; a workspace switch that opened as "Channel not found"; a channel-list
   flag that never followed the second read; sample posts vanishing on a channel switch; a post from
   one channel prepended to another channel's page when the reader switched while it was in flight;
   `renderChannel` re-marking all-signals current after the rule that had just cleared it; two
   channel reads racing with no generation between them; a channel-change guard that skipped the
   send's own cleanup and swallowed a failure whole; a workspace open whose channel read took its
   generation after the fetch, so a slow open could overwrite a channel the reader had just created
   and then call it "Channel not found"; a measurement file reporting one viewport's rects under
   another's heading; and a shell inventory that had started inventorying a comment. The gates were
   green for every one. Two more rounds then found a retry that filed the rest of a partial send in
   the channel the reader had moved to, a landing rule that dropped rows the screen should show and
   stripped rows the page already had, an auth change that left the channel dialog open over the
   signed-out surface with the previous workspace's channel names on it, and a `?c=` resolved against
   an empty list with no second chance. **Five of the seventeen were introduced by an earlier round's
   fix**, which is the argument for running both arms again on every new SHA rather than only on the
   first, and for preferring a rule the system already applies over a new comparison invented to
   answer one report. Rounds six and seven added: a retry that posted unfiled because the failure
   path rewrote the intent without its address; that same rewrite undoing the retirement a channel
   change had just made; a `?c=` heal that resolved the id without moving the screen; a rename from
   Files that wrote the channel's name over a Files body; a failed channel read that rendered half its
   own sentence; and a reset page dropping a row that was posted while it was in flight. Two arm
   findings were checked and **not** acted on, both from the same arm and both wrong: "the failure
   path never calls renderFeed" (it is the last statement of that catch block) and "the session reset
   does not close the channel dialog" (it is the thirteenth line of that function). A third was
   verified as **pre-existing on `main`** and routed rather than fixed: the composer's early return on
   a workspace change skips `clearComposerDraft()`, so a message that lands after the reader switches
   workspace is restored into the composer on the way back. It is byte-identical at
   `d9fa25b:6202`, it has nothing to do with channels, and it sits in the exact region that produced
   six of this lane's defects. It is owed to a follow-up.

## Files

```
site/src/lib/channels.ts                    new: types, generated copy, refusal handling
site/src/lib/channels.test.mjs              new
site/src/lib/signal-feed.ts                 the deleted channel filter and why; the cut thread helpers
site/src/lib/commonswarm.ts                 channel read, three commands, placement on post
site/src/components/app/LiveDashboard.astro rail, dialog, feed, composer, URL, mobile
site/src/components/app/chat-channels.observer.test.ts  new
```

`site/src/lib/signal-feed-threads.test.mjs` was written and is **deleted** with the surface it
covered; it moves to `lane/chat-app-threads` with `groupSignalThreads` and
`threadReplyCountLabel`.

`COMPOSER_STREAM` is now `COMPOSER_DRAFT_SCOPE`: `stream` is the wire's word for the event log and
this lane retired it from the app. Its VALUE is frozen at `"all-signals"` and is the one place that
string is deliberately typed rather than built from `ALL_SIGNALS_SLUG` — it names drafts already saved
in readers' browsers, and following the constant would orphan every one of them the day it changed.
Everywhere a reader sees the name it is generated; a review arm found four places where it was not.

Six existing observer tests moved with the code they observe; each keeps the retired wording beside
the reason. `composer-sprint-browser.observer.test.ts` carried an emitted-source anchor that ended at
`createdAt` and silently rewrote an unrelated span once the sample row grew two fields; it now ends at
the first brace after `createdAt`, whatever precedes it.
