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

## Threads

A reply control appears on a message only where the server would accept a thread reply to it: not in
sample mode, not on a reply, not on a message that is already in a thread, and not on a directed
message. `chatSignalShapeProblem` refuses a directed root, and offering a control the server refuses is
a lie in a button.

Replies render **collapsed under their root**, with `N replies` from `threadReplyCountLabel`, and expand
in place by toggling `hidden` on a list that is already built. It is not a re-render: the reader's
scroll position and every open "Show more" survive it.

`groupSignalThreads` keeps the input order and returns a reply whose root is not in the loaded page as a
row of its own. An expired or not-yet-paged root must never take a visible message off the screen.

A reply is undirected. A tag typed into a reply body is refused before anything is posted, with the
reason, rather than silently posting a directed message that means the opposite of what the writer sees.
`broadcast_to_channel` is a checkbox on the reply bar, which is the only place the edge allows it: the
validator refuses `broadcast_to_channel` without a `thread_root_id`.

The reply bar shows the ceiling the server clamps to. A reply cannot outlive the message its thread
starts from, and that remaining window can be short.

## The URL

`?w=<workspace_id>` and `?c=<channel_id>`, by id and not by name, so a rename does not rot a link.
`?w=` is honoured only when it names a workspace already in this reader's own memberships: the address
bar is a convenience, never an authorization.

**A post belongs to the channel it was sent from.** A channel click does not bump `requestVersion`,
because it is not a workspace change, so the composer's success and failure paths were guarded on the
workspace alone: send in one channel, switch while it is in flight, and the row was prepended to the
other channel's page and survived the next poll, which keeps any local id the fetched page does not
carry. The channel is captured with the send now.

**And the channel decides one thing only: where the rows land.** The first fix returned early on a
channel change, which was worse than the defect it answered: it skipped the send's own cleanup, so the
draft stayed saved, the pending rows stayed in two caches, the status stayed on "Posting…", and on the
failure path the body was deleted with no error and no Retry, because the focus move that follows a
channel click blurs the emptied box and flushes the draft. Both arms found it. The early return is
guarded on the workspace alone again; the channel chooses whether the posted rows join the list on
screen, and everything else runs exactly as it does when the reader stays.

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
2. **No thread reply has been posted from the browser.** The reply control is gated on a session, which
   sample mode does not have. Its wire body is asserted byte-exact against the shapes
   `tests/p1-server/chat-signals.test.ts` sends, and that suite needs a local Supabase this lane did not
   take.
3. **The `?m=` message permalink and `?t=` thread permalink are not built.**
4. **Colour is lane L5** and shares these files. Nothing here changes `markAgentAvatar`.
5. **The To: field with multiple recipients is not built** and waits on `chat-recipients` (L2).
6. **No capacity or query-plan work.** `channel_id=eq.` rides the partial index L1 added; no plan was
   read.
7. **The source sweeps in the observer test state their own bounds** in the test headers. A regex over
   source cannot be complete, and neither of them claims to be. The privacy sweep reads double-quoted
   and backtick strings in eight script surfaces plus two pieces of markup plus the composer's
   refusals, with comments stripped and a positive control on the number of strings it read. What it
   cannot constrain, named rather than implied: a channel `purpose`, which a member types and the head
   renders verbatim.
8. **The rail's current mark and the head can no longer disagree**, but that was a defect and not a
   design: the channel buttons carry no `data-workspace-view`, so `activateWorkspaceView`'s own loop
   never reached them and the rail claimed a current channel while the head said Files. Found by a
   review arm. In the unresolved-channel state the rail marks NOTHING current, which both arms read
   and agreed is the honest mark: the reader is in the signals view and in no channel.
9. **Four review rounds cost twelve product defects and two evidence defects**, every one found by an
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
   green for every one. Two of the twelve were introduced by an earlier round's fix, which is the
   argument for running both arms again on every new SHA rather than only on the first.

## Files

```
site/src/lib/channels.ts                    new: types, generated copy, refusal handling
site/src/lib/channels.test.mjs              new
site/src/lib/signal-feed.ts                 thread grouping; the deleted channel filter and why
site/src/lib/signal-feed-threads.test.mjs   new
site/src/lib/commonswarm.ts                 channel read, three commands, placement on post
site/src/components/app/LiveDashboard.astro rail, dialog, feed, composer, threads, URL, mobile
site/src/components/app/chat-channels.observer.test.ts  new
```

`COMPOSER_STREAM` is now `COMPOSER_DRAFT_SCOPE`: `stream` is the wire's word for the event log and
this lane retired it from the app. Its VALUE is frozen at `"all-signals"` and is the one place that
string is deliberately typed rather than built from `ALL_SIGNALS_SLUG` — it names drafts already saved
in readers' browsers, and following the constant would orphan every one of them the day it changed.
Everywhere a reader sees the name it is generated; a review arm found four places where it was not.

Six existing observer tests moved with the code they observe; each keeps the retired wording beside
the reason. `composer-sprint-browser.observer.test.ts` carried an emitted-source anchor that ended at
`createdAt` and silently rewrote an unrelated span once the sample row grew two fields; it now ends at
the first brace after `createdAt`, whatever precedes it.
