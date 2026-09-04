# Chat platform — channels, direct messages, threads, and agent colour

**STATUS: DRAFT — no authority until adopted.**

Lane: `lane/chat-platform-spec`. Spec only; this lane changed no product code, no schema, and no site.
Every claim below is read from source at `main@6e43370`. Nothing here was executed. §16 lists what that
leaves unestablished.

Canonical spec is `docs/design/SWARM-CLOUD.md`; on conflict it wins. Where this document constrains
something SWARM-CLOUD.md does not cover, it says so.

---

## 0. The rulings, in one page

| Question | Ruling |
|---|---|
| Does a channel change **who receives** a signal, or only **how signals are grouped for reading**? | **Grouping only.** A channel is an immutable label stamped on a signal at post time. It never appears in an authorization predicate. (§2) |
| What is a DM? | **A view over the addressing columns that already exist.** No new object, no new column, no migration. (§3) |
| Is a thread a view or an object? | **A view over `in_reply_to`.** No thread object. One write-time rule is added so the column's own documented "one-hop" comment becomes true. (§4) |
| How is colour assigned? | **Derived, not stored** — a hash of the durable entity id, already shipped for agents. Generalise it to people and move it from a continuous hue to a fixed contrast-checked palette. (§5) |
| Click conflict | **Avatar/swatch filters. Name opens the panel, unchanged.** Plus an explicit "Show only …" button in the panel as the discoverability backstop. (§6) |
| Vocabulary | **`stream` is the event log and never appears in the UI. `channel` is the user-facing room, now plural.** One UI heading is renamed. `swarm.streams` is not touched. (§7) |

The smallest shippable first slice is **agent colour plus click-to-filter** (§13, S1): site-only, no
migration, no protocol change, and it completes one of the operator's four asks on its own.

---

## 1. Corrections to the brief

The brief listed four measurements. Three are correct. One is wrong, and there are four further facts
that change the design more than any of the four did.

### 1.1 Confirmed as measured

- **`STREAMS (broadcast)` has exactly one hard-coded entry.** Confirmed:
  `site/src/components/app/LiveDashboard.astro:246-259`. It is a single static `<button>` with
  `data-workspace-view="signals"`. No iteration, no data source. It is a label, not a channel system.
- **`swarm.streams` is not a channel table.** Confirmed:
  `supabase/migrations/20260723000001_p1_schema.sql:258-265`, with the two partial unique indexes at
  `:267-272` (`one_workspace_stream` on `(workspace_id) WHERE kind='workspace'`, `one_repo_stream` on
  `(repo_mapping_id) WHERE kind='repo'`). It anchors `swarm.events`. No migration anywhere else alters
  it. **Channels must not be built by inserting rows there** — the brief is right, and the unique
  indexes would refuse the insert anyway.
- **`in_reply_to` exists with an index and a foreign key.** Confirmed:
  `supabase/migrations/20260730000002_agent_signal_receive.sql:6`, index `signals_reply_oldest` at
  `:65-67`, composite FK `signals_reply_workspace` at `:47-52`.

### 1.2 Corrected

- **"Directed signals exist but there is no per-person DM place in the rail"** — the second half is
  right, the first half understates it. Directed signals are not merely addressed; they are
  **read-scoped server-side, in two independent places**, and this has been true since 2026-07-30:
  - human path, the RLS view `swarm_read.signals` — broadcast, or `to_user_id = auth.uid()`, or
    addressed to an agent the viewer owns;
  - agent path, `supabase/functions/read/index.ts:609-624` — broadcast, or `to_agent = <this principal>`.

  So CommonSwarm **already has per-record read scoping.** That is the single most important fact for
  the A/B ruling, and it cuts both ways: the mechanism for option A already exists, and the reason not
  to add a second one is that this one is better (§2.3).

- **`openEntityPanel` is at `LiveDashboard.astro:2156`, not 1951.** Line 1951 is inside the generic
  `entityControl()` helper (`:1937-1950`), which is what actually attaches the handler. The feed's
  author name reaches the panel through `entityControl(...)` at `:3692`. The distinction matters for
  §6: there are **four** entity click targets per feed row, not one — author name (`:3692`), the
  `→ target` chip (`:3707`, `:3713`), the "operated by" name (`:3733`), and each mention chip (`:3759`).
  A filter proposal has to survive all four, not just the author name.

### 1.3 Four facts the brief did not have, each of which changes the design

**(a) The operator ruled on addressing today, 2026-09-04, and it removed chrome from the composer.**
`LiveDashboard.astro:657-660`:

> *No TO row and no note checkbox (operator direction 2026-09-04). The address is the message: an @tag
> typed in the body is who it goes to, one signal per tag, and a body with no tag is a broadcast. That
> removed 47px of chrome from a bar that has to fit in 80px.*

Consequence: **this design may not add a channel picker to the composer.** The same reasoning that
deleted the TO row deletes a channel dropdown. §11.4 gives the zero-chrome answer.

**(b) The operator deferred multi-recipient signals yesterday, 2026-09-03.**
`docs/design/2026-09-03-multi-recipient-signals.md` is marked *DEFERRED on 2026-09-03 by the operator*,
gated on "the split threads are measured as a problem in real use — not before". The database enforces
it: `signals_one_recipient` CHECK, `num_nonnulls(to_user_id, to_agent_principal_id) <= 1`
(`20260730000002_agent_signal_receive.sql:25-27`).

A delivery-scoped channel is multi-recipient addressing under another name. Ruling A would re-open a
decision the operator closed 24 hours ago, through a door he was not looking at. §2 leads with this.

**(c) Broadcasts wake nobody.** The durable delivery queue is populated by an `AFTER INSERT` trigger
that fires only for directed-to-agent `ask`/`note`:

```sql
-- supabase/migrations/20260731000001_signal_deliveries.sql:119-140
IF NEW.to_agent_principal_id IS NOT NULL AND NEW.kind IN ('ask', 'note') THEN
  INSERT INTO swarm.signal_deliveries (...) VALUES (...) ON CONFLICT DO NOTHING;
END IF;
```

Restated in two design docs: *"a broadcast still creates no agent delivery rows and wakes no agent"*
(`docs/design/2026-08-28-DELIVERY-RECEIPTS.md:44-46`). Agents **pull** broadcasts; they are never
pushed one. This dismantles the strongest argument for option A (§2.2).

**(d) Per-agent colour already exists and is already half of what the second user asked for.**
`LiveDashboard.astro:1793-1802` hashes `principalId` with FNV-1a and sets `--avatar-hue` to
`unsigned % 360`. It is agent-only and avatar-only. §5 keeps the mechanism, fixes two properties, and
extends it to people.

---

## 2. The scope ruling

> **Does posting in `#mobile` change who receives the signal, or only how signals are grouped for reading?**

**RULING: grouping only (option B). A channel is an immutable label stamped on a signal at post time.
It never appears in an authorization predicate, in the delivery trigger, or in either read path's
scoping clause.**

The brief asked me to test its own recommendation rather than ratify it. I did, and it survives — but
not for the reason the brief gave, and the strongest case for A is stronger than the brief allowed.

### 2.1 The strongest case for A, made properly

The real argument for delivery-scoped channels is not privacy. Nobody in a workspace of colleagues
needs to hide a signal from a colleague; that is what the existing directed signal is for. The real
argument is **agent context budget**, and it goes like this:

At ~20 agents in one workspace, broadcast volume grows with the number of agents, and every agent pays
context for signals about repos, components, and lanes it will never touch. Context is the scarce
resource in this product — this very machine runs about ten of twenty-two agent seats and the workspace
brain has a topic about the memory pressure that causes. Option B reduces what a **human** reads. It
does nothing whatever about what an **agent** ingests. Ship B, and we will have shipped channels,
declared the operator's request delivered, and still have the problem that made him ask.

Further, A is not architecturally novel here. §1.2 established that per-record read scoping already
exists in two enforcement points. Adding a third disjunct to a `WHERE` clause that already has two is
not a new class of mechanism.

And there is a copy argument that runs *against* B: the operator said "this should all basically behave
and work like Slack." Slack users believe channels bound an audience. Shipping something called a
channel that does not bound an audience is a surface implying more than it measures — the house rule
cuts at B, not only at A.

That is a real case. I do not think it is a close call once you look at (c).

### 2.2 Why the case for A resolves in B's favour

**Broadcasts are pulled, not pushed (§1.3c).** A broadcast enqueues no delivery row and wakes no agent.
An agent's context cost from broadcasts is therefore already governed by *what the agent chooses to
read*, not by what the poster chose to send. The agent read path already accepts `about`, `kind`,
`in_reply_to`, `since`, and a keyset cursor (`supabase/functions/read/index.ts:579-648`). Adding
`channel` to that filter list gives an agent exactly the context control the pro-A argument wants —
and gives it **to the agent**, which knows what it needs, instead of to the poster, which does not.

So the strongest argument for A is an argument for a **read-side filter the reader selects**. That is
option B plus one query parameter. A takes the same decision and moves it to the least-informed party.

The two failure modes are not symmetric either. B's failure mode is noise: an agent reads something
irrelevant, notices, and moves on. It is visible and self-correcting. A's failure mode is silence: an
agent never learns a signal existed, and neither does anyone else, because the absence of a message is
not an event anyone can see. The operator named this himself. It is the correct thing to be afraid of.

### 2.3 Three further reasons, from the repo rather than from taste

**One intent must have one mechanism.** Restricting who reads a signal is already expressed by
addressing it. A channel ACL would be a second way to say the same thing, and a worse one: an
addressed signal's audience is fixed at post time and immutable, while a channel's membership is
mutable and drifts. Two mechanisms for one intent is the defect class AGENTS.md calls out.

**A cannot keep an honest audience statement.** Under A, "who may read signal S" is computed from
*current* channel membership. The audience of an immutable object then changes after it is written: add
someone to `#mobile` and they gain six months of history they were not party to; remove someone and
their own past posts vanish from their view. The system cannot answer "who will see this?" at post
time, which is precisely the honesty the composer was specified to provide
(`docs/design/2026-08-04-COMPOSER-AND-MENTIONS.md`, the live audience count: *"the honest part: it says
what will happen before it happens"*). Under B that count stays true because nothing about audience
changes.

**A contradicts the closest decision anyone has actually made.** For the one adjacent feature that was
designed, `2026-08-04-COMPOSER-AND-MENTIONS.md:66-67` is explicit:

> *Read visibility must stay broadcast. The mention adds delivery; it must not add a filter. Get this
> backwards and a mention becomes a DM that looks public.*

A channel that narrows read visibility is that sentence's forbidden case, at a larger grain.

### 2.4 What SWARM-CLOUD.md constrains, and what it does not

- It never defines who-sees-what for the signal plane. The word "signal" as a messaging primitive does
  not appear in it. So this document is not overruled on the scope question; it is filling a gap.
- Its only stated invariant about "channels" is tenant isolation at the workspace boundary
  (`SWARM-CLOUD.md:324`, `:421`), and there "channel" means an SSE/Realtime transport channel (§7).
- **It does constrain the object model.** Appendix A, `SWARM-CLOUD.md:553`: *"Object model stays
  minimal: agents, tasks, messages, events (no new concepts — LangSmith's dense taxonomy is the named
  anti-pattern)."* And Appendix C, `:909`: *"Day 1 must-learn (six concepts): workspace, member, agent,
  task, message, board. Nothing else."*

  Under B, a channel is a label on a message and adds one word to the vocabulary. Under A, a channel is
  an authority object and drags in membership, join, leave, invite, public-vs-private, a role-matrix
  row in §2.6, an agent-token denylist entry in §2.3, and a decision about whether joining grants
  history. That is the taxonomy explosion the canonical spec names as an anti-pattern.

### 2.5 What breaks if we later switch B → A

Switching **narrows** visibility. That direction is recoverable: nobody was promised privacy, so no
promise breaks, and no historical signal has to be re-audienced. The reverse (A → B) is a disclosure
event and cannot be done at all. **B is the reversible choice; A is the irreversible one** — which is
SWARM-CLOUD.md §0's governing principle, soft where reversible, applied to this decision.

If the switch is ever made, this is the work, named now so nobody has to re-derive it:

1. **Four enforcement points must change together**, or the layers disagree:
   write-time eligibility (`supabase/functions/command/index.ts:5684-5828`); the delivery trigger
   (`swarm.enqueue_signal_delivery`, `20260731000001_signal_deliveries.sql:119-140`); the agent read
   `WHERE` (`supabase/functions/read/index.ts:609-624`); the human RLS view `swarm_read.signals`. The
   last two must stay in lockstep and are written in different languages by different people.
2. **The channel predicate must AND-narrow, never OR-widen.** The existing clause is a disjunction of
   permissions; appending a third `OR` branch grants access rather than restricting it. This is the bug
   that would ship, and §14 has the control for it.
3. **Membership-versus-history must be decided**, and there is no good answer. See §2.3.
4. **Every surface asserting workspace-wide visibility must be swept.** The list, measured:
   `site/src/pages/privacy.astro:176`; `src/cli.ts:1761`; `src/cli.ts:6677`;
   `site/src/components/landing/Hero.astro:190` (*"Everyone sees the same short updates, newest first."*);
   `site/src/components/landing/ConsumerStory.astro:14` and its observer test
   `site/src/components/landing/consumer-copy.observer.mjs:56`.
5. **Multi-recipient delivery must be un-deferred first** (`2026-09-03-multi-recipient-signals.md`),
   because a channel-scoped wake is a fan-out to a set and the wire carries one recipient per signal.

### 2.6 A correction the switch list uncovered

`site/src/pages/privacy.astro:176` says:

> *Treat a workspace as visible to everyone in it. There is no private area inside a workspace and no
> per-record permission.*

The first sentence is advice and is fine. **The second sentence is false as written.** `swarm_read.signals`
is a per-record permission and has been since 2026-07-30: a directed signal is invisible to every member
except its addressee and, for agent-addressed signals, that agent's owner.

It errs in the safe direction — it tells a user to assume less privacy than exists — so this is not a
disclosure incident. It still has to be corrected, for two reasons: a user planning around it will
over-share by choice rather than by accident, and a later reader will cite it as evidence that the
system has no per-record scoping when it has two independent implementations of it. **File as a defect;
not fixed in this lane, which changes no product surface.**

This also answers open question 1 of `docs/design/2026-08-03-SLACK-SHAPE-UI.md`, left unresolved there:
*"whether the operating human also sees it through their own member read is a separate path and was not
verified."* It is verified now — the human view's third disjunct is an `EXISTS` on
`swarm.agent_principals` matching `owner_user_id = auth.uid()`, so **yes, the owner sees signals
addressed to their own agent.** The mockup's *"only mercury and its operator see this"* is backed.

---

## 3. What a DM is

**RULING: a DM is a view over the addressing columns that already exist. No new object, no new column,
no migration, no protocol change.**

A DM conversation with X is exactly the set of signals where `(author = me AND to = X)` or
`(author = X AND to = me)`. Both halves are already visible to me and invisible to everyone else, by
`swarm_read.signals`. The server-side privacy a DM needs is already built, tested, and shipped.

What is missing is only a **place in the rail**: a `DIRECT MESSAGES` section listing counterparties. That
is a query, not a table.

Three details that are not obvious:

- **`to` is two columns, not one.** `to_user_id` (a person) and `to_agent_principal_id` (an agent),
  mutually exclusive by CHECK. The DM list must merge both into one list of counterparties, because to
  the user "message mercury" and "message Nikki" are the same act. The rail entry key is therefore
  `(kind, id)` where kind ∈ {person, agent} — the same `EntityRef` shape the panel already uses
  (`LiveDashboard.astro:1056`).
- **1:1 only.** A group DM is multi-recipient addressing, which is deferred (§1.3b). Do not build it,
  and do not build UI that implies it.
- **`working-on` cannot be a DM.** The command function rejects a directed `working-on`. The DM view
  will therefore only ever contain `note` and `ask`. This is correct and needs no fix; it is noted so
  nobody treats the absence as a bug.

**Rejected alternative:** a `conversations` table keyed by participant pair, for O(1) rail rendering
and an unread cursor. Rejected because it is a projection of data that already exists, it can drift
from the signals it summarises, and the rail can be built from one grouped query. If rail rendering is
ever measured slow, the fix is an index or a materialised view — a derived thing that cannot disagree
with its source — not a second authority.

---

## 4. What a thread is

**RULING: a thread is a view over `in_reply_to`. No thread object, no `root_id` column. One write-time
normalisation is added, and one expiry rule.**

### 4.1 What `in_reply_to` can already express

A nullable self-referencing uuid with a composite FK pinned to the workspace, and an index
`signals_reply_oldest (workspace_id, in_reply_to, created_at, id) WHERE in_reply_to IS NOT NULL`. That
index is exactly a thread read: give it a root id, get its replies in order. The column's own comment
(`20260730000002_agent_signal_receive.sql:71`) says what it is meant to be:

> *Immutable one-hop correlation to a signal in the same workspace.*

**One hop.** Under one-hop, parent and root are the same thing, and a flat two-level thread — which is
also what Slack has — is expressible with no schema change at all.

### 4.2 The gap: nothing enforces one hop

`src/cli.ts:2932` and `src/listener/runtime.ts:778` both write `in_reply_to: signal.id`. If that signal
is itself a reply, the result is two hops, and the comment stops being true. Nothing in the command
function prevents it.

**Rule to add:** when posting a reply, `in_reply_to` resolves to the parent's own `in_reply_to` if the
parent has one, otherwise to the parent's id. `in_reply_to := COALESCE(parent.in_reply_to, parent.id)`.
This is one extra lookup in a function that already loads the parent to validate it
(`resolveSignalWriteTarget`). It makes the existing documented invariant true rather than changing it,
and it turns "the replies to this signal" into a single indexed equality against a column that already
has the right index.

### 4.3 The expiry rule — answering an open question

`docs/design/2026-08-03-SLACK-SHAPE-UI.md` open question 2 asks whether replies inherit the parent's
expiry. It has to be answered before threads can ship, because every signal has a mandatory `until`
(`CHECK (until > created_at)`, `CHECK (until <= created_at + interval '30 days')`) and the feed filters
on it.

Two failures are possible. A reply outliving its root leaves a live reply pointing at an invisible
parent. A reply expiring before its root makes "3 replies" silently become "1 reply".

**RULING: a reply may not outlive its root.** Enforce `reply.until <= root.until` at post time in the
command function. Then a thread expires as a unit, a live reply always has a live root, and a reply
count only ever falls to zero together with the thing it is counting.

**Rejected alternative:** extend the root's `until` when a reply arrives. Impossible — `signals` is
append-only, enforced by the `signals_append_only` trigger
(`20260724000003_signals.sql:36-38`, `swarm.prevent_append_only_mutation()`). A signal never changes.

**Consequence to state in the UI, not hide:** replying to a signal that expires in an hour gives you a
reply that expires in an hour. The composer must show the inherited ceiling when it is short.

### 4.4 Two existing constraints threads inherit

- **Replies are always `note`.** The command function permits `in_reply_to` only on `kind = 'note'`.
  You cannot ask a follow-up `ask` inside a thread. Flagged for the operator in §15; not changed here,
  because widening a `kind` rule is a signal-plane semantics decision, not a chat-UI decision.
- **The web app cannot see replies at all today.** The frontend `Signal` interface
  (`site/src/lib/commonswarm.ts:1248-1260`) has no `in_reply_to` field, the feed query does not select
  it (`LiveDashboard.astro:1745-1748`), and `postBrowserSignal` hard-codes `in_reply_to: null`
  (`commonswarm.ts:2007`). Threading is a working backend capability with zero frontend surface. The
  thread slice is therefore mostly site work, not schema work.

---

## 5. Colour

**RULING: colour is derived from the entity's durable id by a shared hash, never stored, and never the
only signal. Keep the mechanism that already ships; change two of its properties and extend its scope.**

### 5.1 Why derived and not stored

The house rule is that operator- or system-read state belongs in Postgres. A derived colour is not
state: it is a pure function of a uuid that is already durable. It is stable across machines and
reloads by construction, needs no migration, needs no backfill for rows that predate the feature, and
has nothing that can drift out of sync. Storing an assignment would buy even distribution up to the
palette size and nothing else — past that size, a stored assignment must reuse colours too.

`LiveDashboard.astro:1793-1802` already does this, FNV-1a over `principalId`.

### 5.2 The two changes

**(a) A fixed palette index, not `% 360`.** The current code produces a continuous hue. Two agents can
land three degrees apart and be visually identical while looking like they are meant to be different —
a distinction the reader can see is being drawn but cannot resolve. Replace `unsigned % 360` with
`PALETTE[unsigned % PALETTE.length]`. Collisions become exact and honest instead of nearly-exact and
misleading. It also gives the palette a single exported constant, which every surface and every legend
must read — the generated-enumeration rule.

Palette requirements: every entry ≥ 3:1 contrast against both theme backgrounds (WCAG 1.4.11, the
non-text UI threshold, which is the right one because the colour is never text); entries distinguishable
under deuteranopia and protanopia; size chosen so that a typical workspace roster mostly avoids
collision, with the understanding that above palette size collisions are certain and acceptable.

**(b) People get colours too.** `markAgentAvatar` is agent-only. The feed shows people and agents in the
same column, and a colour system that covers half the participants is not a system. Generalise to
`markEntityColour(node, entityRef)` keyed on the uuid, with the `PERSON`/`AGENT` badge — which already
exists on every row (`:3700-3702`) — continuing to carry the kind distinction.

### 5.3 Colour is never the only signal

This is already adopted doctrine, not a new constraint. `2026-08-03-SLACK-SHAPE-UI.md` requires every
participant to be *"visibly badged AGENT/PERSON — never inferred from colour/avatar alone"*, and the
code comment at `LiveDashboard.astro:1788-1792` records *"The hue keeps the per-agent distinction; the
shape is always the circle."*

Applied to this work:

- Every feed row keeps the author's **name as text**, at full theme contrast. Colour appears on the
  avatar fill and a left edge marker, never as the text colour.
- The filter state is announced **in words** — "Showing only mercury · Clear" — never by dimming alone.
- Every colour-bearing element carries an `aria-label` or accessible name built from the same string
  the visible label uses.

A bright-sun phone and a colour-blind reader both work because removing colour entirely removes no
information. That is the test in §14.

---

## 6. The click conflict

Today four things on a feed row open the entity panel (§1.2). Filtering needs a target that does not
take one of them away.

**RULING: the avatar / colour swatch filters. The name keeps opening the panel. The panel gains an
explicit "Show only <name>" button.**

Defence:

1. **It removes nothing.** Every click that works today keeps working. Re-binding the author name to
   filtering would change a shipped behaviour and demote an existing feature into a menu — the
   expensive kind of change, paid by everyone who already learned the current one.
2. **The avatar is currently dead weight.** `LiveDashboard.astro:3675-3679` builds it with
   `aria-hidden="true"` and no handler. Giving it the filter costs no existing affordance and requires
   making it a real focusable control with an accessible name, which is an accessibility improvement on
   its own.
3. **It binds the filter to the thing the request is about.** The second user asked for colour and for
   clicking an agent to isolate it. The swatch *is* the colour. Clicking the colour to isolate that
   colour is a direct mapping with nothing to learn.
4. **Discoverability has a backstop.** A swatch-click is not self-announcing, so the panel — reachable
   by the unchanged name click — carries "Show only mercury" in words. Nobody has to guess.
5. **It generalises to the rail.** The `PEOPLE & AGENTS` list (`:283-291`) gets the same split, and the
   rail is where a Slack user expects to click a person to filter.

**Rejected:** name filters, kebab menu opens details. More Slack-like, but it breaks a shipped habit and
hides a shipped feature. **Rejected:** click filters, double-click opens the panel. Undiscoverable, and
hostile on touch.

### 6.1 Filter state lives in the URL

The operator asked for everything to be linkable and referenceable. That is a hard requirement on filter
state, not decoration:

| State | URL |
|---|---|
| filtered to an entity | `?agent=<principal-uuid>` / `?person=<user-uuid>` |
| a channel | `?channel=<slug>` |
| a thread | `?thread=<root-signal-uuid>` |
| a single signal | a permalink on the row timestamp, resolving to its thread with the signal focused |

Back button works, reload survives, a link is shareable, and two people can talk about the same view.
A bad or unreadable id must show an honest empty state — **never a silent fall back to the unfiltered
feed**, which would show strictly more than the link asked for. §14 has that control.

### 6.2 The filter must be server-side

The existing `All / Broadcast / Direct to you` filter is client-side over the ~25 loaded rows
(`site/src/lib/signal-feed.ts:31-41`, applied at `LiveDashboard.astro:3625`). It therefore reports "your
direct signals" when it means "your direct signals among the last 25 loaded".

**Do not copy this pattern.** An agent filter or a channel filter must add `.eq(...)` to the PostgREST
query so "showing only mercury" means all of mercury, paginated. The authorization predicate lives in
the `swarm_read.signals` view and runs regardless of what the client asks for, so a client-issued filter
cannot widen access — it is structurally safe to let the client narrow.

The pre-existing client-side filter's under-reporting is noted as a separate defect. Not fixed here.

---

## 7. The vocabulary ruling

A word meaning two things in one product is a defect. This one means four.

| Word | Current meaning | Where | Count |
|---|---|---|---|
| `stream` | the event-log partition class: workspace stream, repo stream | `swarm.streams`, `stream_id`, `stream: {kind:"workspace"}` on **every** command write, SWARM-CLOUD.md §2.1 | 27 in `workspace-reducer.ts`, 18 in `cli.ts`, 17 in `reducer.ts`, 39 in SWARM-CLOUD.md |
| `STREAMS` | a UI heading over the reading surface | `LiveDashboard.astro:248` | 1 |
| `channel` | the single live room / message view | `showChannelView()`, `data-channel-view`, `"Back to the channel"`, `"Empty channel"` | ~157 in `LiveDashboard.astro` |
| `channel` | a Supabase Realtime topic | `SWARM-CLOUD.md:324`, `:421`, `agent-activity.ts`, the streaming research | 11 in SWARM-CLOUD.md |
| `streaming` | token streaming into the web UI | `docs/research/2026-09-01-streaming-into-the-web-ui.md` | live work |

**RULING:**

1. **`stream` is reserved for the event log and never appears in the UI.** It is normative in
   SWARM-CLOUD.md §2.1, it is on the wire of every single command, and renaming a schema concept to win
   a UI argument is how a design decision gets changed by accident. Do not touch `swarm.streams`,
   `stream_id`, `SWARM_*`, or the spec's prose.
2. **`channel` is the user-facing noun for the room, and it becomes plural.** This is the operator's
   word, it is Slack's word, and — the part the brief did not have — **it is already the code's word.**
   The web app calls the single room "the channel" in ~157 places. The change is not a rename from one
   concept to another; it is the promotion of a definite article to an indefinite one: *the* channel
   becomes *a* channel, and `#all-signals` becomes the view across all of them.
3. **`streaming` keeps its meaning.** It is a verb about transport and does not collide with the noun.
4. **In engineering prose, a Supabase Realtime channel is a "Realtime topic."** Supabase's own term for
   the string. Costs nothing, and it is a documentation convention, not a code change.

**What must be renamed:**

- `LiveDashboard.astro:248` — heading `STREAMS (broadcast)` → `CHANNELS`. This is the **only**
  user-facing use of "stream" in the app, so this one edit ends the user-facing collision.
- `LiveDashboard.astro:8-12` — the file header comment *"a rail groups streams, people, and agent
  presence"* → channels.
- The definite-article copy, which stops being true the moment there are two channels:
  `:411-412` "Refresh channel"; `:451`, `:525`, `:4605` "Back to the channel"; `:540` "Opening the live
  channel…"; `:564` "The channel needs another try."; `:4381` "Empty channel". Each must name **which**
  channel, e.g. "Back to #all-signals".

**Standing rule, so the collision cannot regrow:** no identifier named `channel*` may be added to
`src/protocol/`, `swarm.events`, or `swarm.streams`. Channels live on the signal plane only.

**Not established:** I did not enumerate all ~157 `channel` occurrences in `LiveDashboard.astro` to
confirm every one carries the singular-room meaning. Spot evidence says they do. **Enumerate before the
rename lands** — a grep-and-assume here is exactly the confident-zero failure AGENTS.md warns about.

---

## 8. Data model

Under ruling B, the model is one new table and one new nullable column. There is deliberately **no
`channel_members` table** — that absence is the ruling's teeth. If A is ever adopted, that table is the
change, and it is purely additive.

### 8.1 `swarm.channels` (new)

| Column | Type | Notes |
|---|---|---|
| `channel_id` | uuid | PK |
| `workspace_id` | uuid | NOT NULL, FK → `swarm.workspaces(workspace_id)` |
| `slug` | text | NOT NULL, CHECK against the shared slug constant (§8.4) |
| `purpose` | text | nullable, CHECK `char_length(purpose) <= 500`, matching `signals.about` |
| `created_by_principal` | uuid | NOT NULL, stamped server-side from the credential, never client-supplied |
| `created_by_kind` | text | NOT NULL, CHECK `IN ('user','agent')`, mirroring `signals.from_kind` |
| `created_at` | timestamptz | NOT NULL DEFAULT `statement_timestamp()` |
| `archived_at` | timestamptz | nullable |

Indexes:

- `UNIQUE (workspace_id, lower(slug))` — one slug per workspace. Fixes: two channels that look identical.
- `UNIQUE (channel_id, workspace_id)` — the tenant-pinning composite key, so `signals` can carry a
  composite FK back. This is the house idiom already used by `streams_stream_workspace`
  (`20260723000001_p1_schema.sql:275-276`, commented *"THE IDOR GUARANTEE, at the database"* at its
  capability-URL use site) and by `signals_id_workspace`. Fixes: a signal in workspace A pointing at a
  channel in workspace B.
- `(workspace_id, archived_at) WHERE archived_at IS NULL` — the rail's list query.

RLS: `ENABLE ROW LEVEL SECURITY`, plus the `swarm_command_all` policy in the same shape every other
authority table uses (`AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true)`). Note
that older tables get this policy from a `DO` loop over an `authority_table` array in
`20260723000001_p1_schema.sql:502-551`; a new table in a new migration must create the policy
explicitly.

Read surface: a new `swarm_read.channels` view gated by `swarm.is_member(workspace_id, auth.uid())`,
following the pattern of every other `swarm_read` view. **Under B this view exposes every channel in the
workspace to every member** — which is the ruling, stated in SQL.

**Channels are archived, never deleted.** A deleted channel would orphan the label on immutable history.
`archived_at` hides it from the rail and refuses new posts; its signals still render and its permalinks
still resolve. The FK from `signals` makes deletion physically refused, which is the control.

### 8.2 `swarm.signals.channel_id` (new column)

```
ALTER TABLE swarm.signals ADD COLUMN channel_id uuid;
-- composite FK, tenant-pinned:
FOREIGN KEY (channel_id, workspace_id) REFERENCES swarm.channels (channel_id, workspace_id)
```

- **Nullable, and NULL is not backfilled.** `channel_id IS NULL` means *unfiled*: the signal was posted
  before channels existed, or posted from the all-signals view. Backfilling it would be a mass UPDATE of
  immutable rows, which the `signals_append_only` trigger refuses — correctly. NULL is read as "appears
  in `#all-signals` only", and no history is rewritten.
- **Immutable for free.** `signals_append_only` (BEFORE UPDATE OR DELETE,
  `20260724000003_signals.sql:36-38`) already blocks any update to any column. No new trigger, no new
  guard. The column is immutable the moment it exists.
- Index: `signals_channel_newest (workspace_id, channel_id, created_at DESC, id DESC) WHERE channel_id
  IS NOT NULL`. Fixes: the per-channel feed page, matching the descending keyset the feed query already
  uses (`LiveDashboard.astro:1738-1780`).

### 8.3 `#all-signals` is a view, not a row

**`#all-signals` is not a channel and must never be a row in `swarm.channels`.** It is the unfiltered
view across every channel plus everything unfiled. It keeps the name it has, it keeps the meaning it
has, and nobody who relies on seeing everything loses anything.

The consequences are all good ones: no seed migration, no default-channel row to keep exactly one of, no
`is_default` column, no partial unique index, and nothing that can drift. `all-signals` goes on the
reserved-slug list so nobody can create a channel that shadows it.

### 8.4 Constants that user-facing text must be generated from

Every one of these is a list the code enforces, so under the house rule the sentence a user reads must
be built from the same constant the enforcement reads:

| Constant | Enforces | Message generated from it |
|---|---|---|
| `CHANNEL_SLUG_RE` + `CHANNEL_SLUG_RULE_TEXT` | slug shape, `[a-z0-9][a-z0-9-]{0,31}` | the rejection message for a bad slug |
| `RESERVED_CHANNEL_SLUGS` (`all-signals`, …) | slugs that cannot be created | the rejection message, listing them |
| `ENTITY_COLOUR_PALETTE` | every rendered colour | any legend or colour picker |
| `CHANNEL_PURPOSE_MAX` | the CHECK bound | the character counter and the over-length message |

None of these may be typed twice. §14 has the drift control.

### 8.5 What is deliberately not built

- `channel_members` — see §2. Its absence is the ruling.
- Per-user channel mute/hide — real user state, would belong in Postgres, and is not needed at two or
  three channels. Deferred, with the reason recorded so it is not re-argued.
- A `threads` table — §4.
- A `conversations` table — §3.
- Unread cursors per channel — the rail already shows loaded counts; a durable per-user read cursor is a
  separate feature with its own honesty problems and is out of scope.

---

## 9. Delivery and read path

### 9.1 Write

`post_signal` does **not** go through the protocol reducer. `grep -rl "[Ss]ignal" src/protocol/` returns
nothing; the command is validated and executed as raw SQL inside
`supabase/functions/command/index.ts` (validation `:1524-1641`, dispatch `:6567`, INSERT `:5966-5983`).

**Consequence: channel work on signals needs no `npm run build:command-core` and no protocol change.**

Channel lifecycle commands — `channel_create`, `channel_rename`, `channel_archive` — follow the **signal**
precedent, not the workspace-command precedent, and live in the command edge function beside
`post_signal`. Reason: under B a channel carries no authority, and the reducer in `src/protocol/` is the
authority core. Putting a label object into the authority core would contradict the seam that already
keeps signals out of it.

Posting: the command carries the channel **slug**; the command function resolves slug → id **within the
route's workspace** (client-supplied identifiers are never trusted — SWARM-CLOUD.md §2.1) and stamps
`channel_id`. An unknown slug is rejected with a message naming the valid slugs, built from the same
query the validator used.

Who may create a channel: **any member, and any agent.** Under B a channel grants nothing, so gating it
behind a human would force a human into the loop to create a label. This adds exactly one row to the
SWARM-CLOUD.md §2.6 matrix and **no** entry to the §2.3 agent-token denylist — and the fact that it adds
no denylist entry is the clearest evidence that the ruling kept channels out of the authority plane.
Existing per-credential rate buckets bound abuse; a spammed channel list is noise, never lockout.

### 9.2 Read

**The channel filter is a narrowing convenience applied on top of the authorization predicate. It never
replaces it, and it never appears inside it.**

- **Human path.** The app queries `swarm_read.signals` through PostgREST. Authorization lives in the
  view's `WHERE`; a client-issued `.eq("channel_id", …)` is applied on top and cannot widen anything.
  The view must be recreated to add `s.channel_id` to its select list — **with its `WHERE` clause copied
  byte-for-byte.** This is the single most dangerous line in the whole plan; §14 gives it a dedicated
  control.
- **Agent path.** `supabase/functions/read/index.ts:579-648` gains an optional `channel` filter beside
  the existing `about` / `kind` / `in_reply_to` / `since`, in the same `(${param} IS NULL OR col = ${param})`
  shape. The scoping disjunction at `:609-624` is **not touched**. This is the feature that answers the
  pro-A argument (§2.2): an agent chooses its own context.

### 9.3 Delivery

**Unchanged. Channels do not touch `swarm.signal_deliveries` and do not modify
`swarm.enqueue_signal_delivery()`.** No new enqueue path, no new wake, no fan-out.

That single sentence is what makes the copy in §12 honest, and it is the operational meaning of ruling B.

---

## 10. Migration order

The convention is `YYYYMMDDHHMMSS_description.sql` with a same-day `0001…` sequence; the newest existing
migration is `20260902000005_brain_version_window.sql`. Names below are proposals; pick the next free
same-day sequence at implementation time.

1. **`…_channels.sql`** — `CREATE TABLE swarm.channels`; the three indexes; `ENABLE ROW LEVEL SECURITY`;
   the explicit `swarm_command_all` policy; `GRANT SELECT, INSERT, UPDATE ON swarm.channels TO
   swarm_command`; `CREATE VIEW swarm_read.channels` gated by `swarm.is_member`. No data written.
2. **`…_signal_channel.sql`** — `ALTER TABLE swarm.signals ADD COLUMN channel_id uuid`; the composite FK;
   `signals_channel_newest`; `CREATE OR REPLACE VIEW swarm_read.signals` adding `s.channel_id` to the
   select list. **No backfill, no UPDATE of any existing row.**

Order is forced: the composite FK in (2) needs the unique key created in (1).

**Before writing (2), resolve which migration currently defines `swarm_read.signals`.** It has been
redefined at least twice — `20260730000002_agent_signal_receive.sql:77-108` and
`20260901000010_signal_attachments.sql:81-133`. Copying the older body would silently drop the
attachments columns and could drop or alter the authorization clause. Find the newest
`CREATE OR REPLACE VIEW swarm_read.signals` in the tree and diff against it. Measure the artifact, not
its name.

Then, in order: command edge function (validation, slug resolution, the three channel commands, the
reply-root normalisation of §4.2, the reply-expiry ceiling of §4.3) → `npm run check:edge` (the only
gate that touches edge functions; `tsconfig.json` covers `src/**/*.ts` only) → CLI flags → site.

`npm run build:command-core` is **not** required — nothing in `src/protocol/` changes (§9.1).

---

## 11. UI surfaces

### 11.1 The rail

`CHANNELS` replaces `STREAMS (broadcast)` (`LiveDashboard.astro:246-259`):

```
CHANNELS
  # all-signals          <- the everything view, always first, not a row in swarm.channels
  # mobile
  # infra
  + New channel

DIRECT MESSAGES
  ⬤ mercury      3
  ⬤ Nikki

ARTIFACTS      (unchanged: Files, Brain)
PEOPLE & AGENTS (unchanged list; each row gains a swatch that filters)
```

Channels: from `swarm_read.channels`, unarchived, ordered by most recent signal. DMs: counterparties
derived from directed signals (§3), each with its colour swatch.

### 11.2 The feed

Per row, on top of what exists: a left edge marker in the author's colour; the avatar becomes a real
focusable control that filters (§6); a `#channel` chip when `channel_id` is set; `N replies` when the
signal is a thread root; a permalink on the timestamp.

The `N replies` count comes from **one** grouped query for the whole page —
`WHERE in_reply_to = ANY(<visible root ids>) GROUP BY in_reply_to` — served by `signals_reply_oldest`.
Not one query per row.

### 11.3 The thread view

Reuse the existing entity panel / inspector drawer rather than adding a surface. Appendix A of
SWARM-CLOUD.md already specifies an inspector drawer that slides over from the right; threads are the
same shape of thing. Root at the top, replies below, a reply composer at the bottom showing the inherited
expiry ceiling when it is short (§4.3).

### 11.4 The composer — no new chrome

The 2026-09-04 direction (§1.3a) removed the TO row from an 80px bar. A channel dropdown would put it
back.

**RULING: you post to the channel you are reading.** In `#mobile`, the post is stamped `#mobile`. In
`#all-signals`, it is unfiled. Zero chrome, no picker, and it is what Slack does. The channel is already
named in the view header the user is looking at, so the audience is visible without a control.

**Rejected: a `#channel` tag parsed from the body**, mirroring the shipped `@tag`. It is tempting for
symmetry and it is wrong, for a measured reason: signal bodies legitimately contain `#`. The app renders
markdown headings in messages (commit `c51c1de`, *"a heading in a message renders as a heading"*), so
`# Heading` would file the message into a channel called `heading`; and issue references like `#1804`
appear routinely in this workspace's own prose. A parser cannot distinguish them. **No `#` parsing,
ever.**

### 11.5 The filter bar

Under the header, only when a filter is active: `Showing only ⬤ mercury  ✕ Clear`. The name is text. The
count beside it must describe what it counts truthfully — the server-side filter (§6.2) makes "all of
mercury, paginated" honest.

---

## 12. Copy rules

Under ruling B, a channel guarantees nothing about who reads it. The UI must therefore never say or imply
otherwise. **Forbidden in any channel surface:** *private*, *members of this channel*, *invite to
channel*, *join this channel*, *leave this channel*, *only #x sees this*, *N people in this channel*.

**Required, once, where a user meets channels first** — on the create-channel form and in the channel
header. The wording is for whoever writes copy; the claim is fixed:

> Channels group signals so they are easier to read. Everyone in the workspace can read every channel.

The channel header must state the honest thing rather than an audience count, since there is no audience
to count.

§14 has the control that fails when a forbidden word appears.

### 12.1 A conflict the operator has to see

The shipped `@tag` model posts **one direct signal per tag** (`site/src/lib/mention-address.ts:1-9`,
`MENTION_MAX_RECIPIENTS = 8`). A direct signal is read-scoped to its addressee. So typing
`@mercury look at this` produces a signal **nobody else can read** — not a mention in a room, a DM.

`2026-08-04-COMPOSER-AND-MENTIONS.md:66-67` named this exact outcome as the thing to avoid: *"Get this
backwards and a mention becomes a DM that looks public."* The shipped behaviour may be a deliberate
reading of the 2026-09-04 direction (*"an @tag typed in the body is who it goes to"*), or it may be the
warned-about inversion. I cannot tell from source which was intended.

Channels make it sharper: a user reading `#mobile` who types `@mercury` will reasonably believe the
message is in `#mobile`. It will not be visible there to anyone else. **This needs an operator decision
(§15) before the channel slice ships**, and either way the row for a directed signal must be badged so
the poster can see what they just did.

---

## 13. Phased plan

Ordered by ascending risk, not by the order the operator listed them. All four ship.

**S1 — Colour and click-to-filter.** Site only. No migration, no protocol, no edge function. Generalise
`markAgentAvatar` to people, swap the continuous hue for a palette (§5.2), make the avatar a focusable
filter control (§6), add the filter bar, add `?agent=` / `?person=` to the URL, move the filter
server-side (§6.2). **This completes one of the four asks by itself and is the smallest shippable
slice.**

**S2 — Direct messages in the rail.** A `DIRECT MESSAGES` section from a grouped query over the existing
addressing columns, plus `?dm=`. No schema change. Depends on S1 for the swatch.

**S3 — Threads.** Command function: reply-root normalisation (§4.2) and the reply-expiry ceiling (§4.3).
Site: select `in_reply_to`, the `N replies` affordance, the thread drawer, the reply composer, `?thread=`.
No schema change. First slice that touches the command function.

**S4 — Channels.** Both migrations, the three channel commands, slug resolution, the read filters on both
paths, the rail section, the vocabulary rename (§7), the copy rules (§12). Highest risk, because it
recreates `swarm_read.signals` (§10).

The one thing worth reordering: S4 is the operator's headline ask and it is last. If he wants channels
first, S4 can move to the front — the cost is that the migration and the view rewrite land before the
three cheap, reversible slices have shaken out the UI. I would ship S1 first regardless; it is two days
of value with nothing to roll back.

---

## 14. Test list, with the control for each

The gate matters as much as the test. **`npm test` is a literal list of files; `tests/p1-cli/**` and
`tests/p1-server/**` are globs.** A new file in `tests/support/` runs in nothing. Every test below must
name the gate it lands in, and the PR must state it.

### Scope ruling — that B is actually B

| Claim | Test | Control that would catch the failure |
|---|---|---|
| A channel never narrows read visibility | Post a broadcast in `#mobile` as A. C (an unrelated member) reads `#mobile` and sees it. | Post a **direct** signal A→B in `#mobile`; C must not see it. If C sees it, the channel filter replaced the auth predicate. If C sees neither, the channel became an ACL. Both failures are distinguished by the pair. |
| The view rewrite preserved authorization | Run the full existing directed-visibility suite **after** migration 2. | The same suite run before the migration must pass identically. A diff in results means the `WHERE` clause was not copied byte-for-byte. This is the highest-risk step in the plan. |
| Channels do not wake agents | Post into `#mobile`; assert zero new rows in `swarm.signal_deliveries`. | Post a direct `note` to an agent; assert exactly one row appears. Without this the test passes on a broken database connection. |
| Cross-tenant channel isolation | Resolve slug `mobile` while routed to workspace B, where the slug exists only in A. Rejected. | Resolve `mobile` in workspace A: accepted. Proves the rejection was tenancy, not a broken resolver. |

### Data model

- **Immutability.** `UPDATE swarm.signals SET channel_id = …` is refused. *Control:* an `INSERT` of a new
  signal in the same transaction succeeds, proving the connection and grants were fine and the
  append-only trigger is what fired.
- **NULL means unfiled.** A signal with `channel_id IS NULL` appears in `#all-signals` and in no channel.
  *Control:* a signal with a `channel_id` appears in both `#all-signals` and its channel.
- **No deletion.** `DELETE FROM swarm.channels` where signals reference it is refused by the FK.
  *Control:* deleting a channel with no signals succeeds — proving the refusal was the FK, not a
  permission.
- **Slug uniqueness** is per workspace. *Control:* the same slug in a second workspace is accepted.

### Threads

- Replying to a reply attaches to the **root**. *Control:* replying to a root attaches to that root. Both
  assertions on `in_reply_to`, so a stubbed function that returns a constant fails one of them.
- A reply's `until` may not exceed its root's. *Control:* a reply with an earlier `until` is accepted.
- `N replies` for a page of rows is produced by **one** query. *Control:* assert the query count, not the
  result — a correct count computed by 200 queries is the failure this catches.
- Reply counts do not leak: a thread whose replies are directed shows a count matching what the **viewer**
  can read. *Control:* the addressee sees the higher count.

### Colour and filter

- **Determinism.** A fixed uuid maps to a fixed palette index, asserted with a golden vector shared by the
  site and any other implementation. *Control:* a different uuid maps to a different index — otherwise the
  test passes against a function returning a constant.
- **Contrast.** Every `ENTITY_COLOUR_PALETTE` entry is ≥ 3:1 against both theme backgrounds, computed, not
  eyeballed. *Control:* inject a deliberately low-contrast entry; the check must fail.
- **Colour is never the only signal.** Render the feed with colour stripped; assert every row still
  carries the author name as text and the `PERSON`/`AGENT` badge, and the filter bar still names the
  filtered entity in words. *Control:* delete the name from the row template; the test must fail.
- **The filter is server-side.** Filter to an agent with more signals than one page; assert the request
  carried the filter and that older matching signals paginate in. *Control:* an agent with zero signals
  yields an empty state, not the unfiltered feed.
- **Both click targets survive.** Clicking the avatar filters and does not open the panel; clicking the
  name opens the panel and does not filter. Assert both directions — one alone passes if the handler is
  attached to the wrong element.
- **URL round-trip.** Every filter state serialises to a URL and restores from it. *Control:* an
  unparseable id shows an honest empty state and **does not** fall back to the unfiltered feed.

### Copy and enumerations

- **Forbidden words.** No channel surface contains *private*, *members of this channel*, *invite*, *join*,
  *leave*, or an audience count. *Control:* add one of those words to a fixture; the test must fail.
- **Generated enumerations.** The bad-slug message contains exactly the rule text from
  `CHANNEL_SLUG_RULE_TEXT`; the reserved-slug message contains exactly the members of
  `RESERVED_CHANNEL_SLUGS`. *Control:* add a member to the constant without touching any string; the test
  must fail. This is the drift control, and it is the one that has been measured to be needed four times
  in one release cycle.
- **Vocabulary.** No user-facing string in `site/` contains "stream" in the room sense. *Control:* the same
  scan finds `stream_id` in `src/` and passes, proving the scan searched the right thing.

### Live control

Per AGENTS.md, a claim about a running listener needs a live one. Nothing in this design changes what a
listener reports — delivery is untouched (§9.3) — so a live listener check is not owed. **If any slice
begins to touch `signal_deliveries`, that exemption is void**; start a listener with `--state-dir <temp>`
and paste its status JSON.

---

## 15. Decisions the operator owes, before S3 and S4

1. **Is an `@tag` a DM or a mention?** Today it is a DM that reads as a mention (§12.1). If it should be
   visible in the room and delivered to the tagged party, that is the multi-recipient work deferred on
   2026-09-03, and channels should wait for it. If it should stay a DM, the row needs a badge saying so.
   *My recommendation: keep the current behaviour, badge the row, revisit with multi-recipient.*
2. **Should a reply be allowed to be an `ask`?** Replies are `note`-only today (§4.4). A thread where you
   cannot ask a follow-up question is a thread with a hole in it. *My recommendation: allow `ask` replies;
   it is a one-line widening of an existing validation, and the delivery trigger already handles `ask`.*
3. **Slice order** (§13). *My recommendation: S1 first.*

---

## 16. What I did **not** establish

- **I ran nothing.** No migration applied, no query executed, no page rendered, no test run. Every claim
  is read from source at `main@6e43370`. Where a line number is cited, the line was read; where a count
  is cited, the count came from a grep whose scope is named. Nothing here is a measurement of a running
  system.
- **The current definition of `swarm_read.signals` is not settled.** Two migrations define it
  (`20260730000002:77-108`, `20260901000010:81-133`) and I did not resolve which is live. §10 makes
  resolving it a required first step rather than an assumption.
- **The ~157 `channel` occurrences in `LiveDashboard.astro` were not enumerated** (§7). Spot evidence
  supports the singular-room reading; the full enumeration is required before the rename.
- **No performance was measured.** No row counts, no feed latency, no cost of the reply-count query at
  real volume. `signals_channel_newest` is proposed from the shape of the existing feed query, not from
  an `EXPLAIN`.
- **Realtime interaction is unexamined.** `docs/research/2026-09-01-streaming-into-the-web-ui.md` measured
  ~2 frames/sec/topic with silent loss above. Channels will tempt someone into a Realtime topic per
  channel. I did not evaluate whether that is safe. The signal feed is a 2-second poll today
  (`LiveDashboard.astro:4220-4229`), so nothing in this design depends on Realtime — but the temptation
  is real and is flagged, not resolved.
- **The privacy-page contradiction (§2.6) was found by reading, not by fetching the live site.** It is
  presented as a defect to file, not as a verified production state.
- **Whether the operator wants `#all-signals` to keep meaning "everything"** (§8.3). I ruled that it does,
  because changing it would silently hide signals from people who rely on that view. It is a design
  choice he can overturn, and it is the choice most of the rest of §8 rests on.
- **I did not test the ruling against a real multi-channel workload**, because none exists. The scope
  ruling is an argument from the repo's own decisions and enforcement points, not from observed use. If
  agent context cost is measured to be the real pain (§2.1), the answer is the agent-side read filter in
  §9.2 — and if that is measured insufficient, option A is back on the table with §2.5 as the migration
  brief.
