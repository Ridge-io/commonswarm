# Chat platform — build plan (lanes, in apply order)

Turns `docs/design/2026-09-04-chat-platform-reconciled.md` into landable lanes. That document is the
design and rules on every question it answers; `docs/design/SWARM-CLOUD.md` is canonical over both.
This file adds only sequencing, file ownership, and the gate each lane owes.

Base: `a55c6a1` (`origin/main` when this plan was written).

## Rulings the lead added on 2026-09-05

The reconciled design's §12 listed three decisions the operator owed. All three are now ruled, and §12
of that document records them as adopted with the retired wording kept.

| # | Ruling | Consequence for this plan |
|---|---|---|
| D1 | **No private channels in v1.** | Confirms R1. No `channel_members`, no membership clause, no privacy copy. Appendix A stays a brief. |
| D2 | **`@name` in a body is a mention.** It adds that person to the To: set. It does not open a DM. | Changes the composer, not the schema. **Bounded by `signals_one_recipient`** — see the blocker below. |
| D3 | **A channel is the address of a signal, not a scope on delivery.** | Confirms R1 and §7.3. `channel_id` is a stamped label; `swarm.signal_deliveries` and `swarm.enqueue_signal_delivery()` are untouched in every lane here. |

> **D2 blocker, named rather than discovered.** `signals_one_recipient`
> (`20260730000002_agent_signal_receive.sql:25-27`) allows **at most one** recipient per signal, so a
> "To: set" with two or more members cannot be stored today. `mention-address.ts` works around this by
> posting one **directed** signal per tag, and a directed signal is read-scoped, so `@a @b look at this`
> is two messages nobody else can read. D2 says that is the wrong behaviour. The composer must therefore
> either (a) accept one mention as the single recipient and refuse the second with a message that says
> why, or (b) wait for multi-recipient signals
> (`docs/design/2026-09-03-multi-recipient-signals.md`, deferred until now).
>
> **Ruled 2026-09-05 by the coordinator: option (b), and the wait is short.** The same constraint blocks
> the composer's To: field, which the operator wants as multi-recipient chips, so multi-recipient signals
> stop being a deferred nicety and become lane **L2 `chat-recipients`** below. D2's mention chips ship on
> top of it in L4. Neither blocks L1's migration or edge work.

## Lane table

Apply order is top to bottom. A lane may start only when every lane above it has landed on `main`,
except where the "Parallel" column says otherwise.

| Lane | Owns (no other lane edits these) | Wire change | Old-client rule | Tests it adds | Parallel |
|---|---|---|---|---|---|
| **L1 `chat-schema`** | `supabase/migrations/20260905000001_channels.sql`, `…0002_signal_channel.sql`, `…0003_signal_threads.sql`; `supabase/functions/_shared/channels.ts`; `supabase/functions/command/index.ts`; `supabase/functions/read/index.ts`; `tests/chat-channel-constants.test.ts`; `tests/chat-signal-wire-compat.test.ts`; `tests/p1-local/chat-channels-postgres.test.ts` | `channel_create` / `channel_rename` / `channel_archive`; `post_signal` gains optional `channel`, `thread_root_id`, `broadcast_to_channel`; `read` gains optional `channel`; the signal record gains `channel_id`, `thread_root_id`, `broadcast_to_channel` | Additive nullable column, no backfill, no `SET NOT NULL`. Every new optional key is its **own** `Object.hasOwn` group; `modernKeys` is not widened | constants + generated messages; wire-compat twin of `tests/receipt-wire-compat.test.ts`; Postgres suite (channels, immutability, tenancy, delivery-neutrality) | — |
| **L2 `chat-recipients`** | `supabase/migrations/20260905000010_signal_recipients.sql`; then `_shared/channels.ts`, `command/index.ts`, `read/index.ts` again | `post_signal` gains optional `to`, an array of `{kind, id}`, in its **own** `Object.hasOwn` group; the record and the view gain a `recipients` set | `to_user_id`/`to_agent_principal_id` STAY and hold the FIRST recipient, so an old reader sees a true recipient rather than none. `signals_one_recipient` is not relaxed | N-recipient visibility; first-recipient fallback; the delivery bound (it wakes the recipient at position 0, and only when that recipient is an agent taking `ask` or `note`; nobody else; and no trigger on the recipients table); the cap and its generated message; wire-compat twin. *(**was**: "one delivery row per agent recipient and no duplicate for the first" — that fan-out was built, refused review, and was removed; see the L2 appendix.)* | **no** — same files as L1 |
| **L3 `chat-client`** | `src/cloud/channels.ts` (new), `src/cloud/signals.ts`, `src/cloud/command-client.ts`, `src/cli.ts`, `tests/p1-cli/chat-cli.test.ts` | sends `channel` and `to` on post; `--channel` on feed; `cswarm channel ls\|new\|rename\|archive` | Client is newer than the edge only after L1 and L2 deploy. Publish the npm client **after** the edge deploy, never before | CLI parse + copy tests; slug resolver reuse of the `--to` name-or-uuid resolver | with L4 |
| **L4 `chat-app-channels`** | `site/src/pages/app/*`, `site/src/lib/*`, `site/tests/*` for channels | none (browser reads the view directly) | Browser names its columns explicitly; L1's view append is safe. A new client against an **un-recreated** view is a PostgREST 400, so deploy order is migration → edge → site | rail, composer stamping, `?w=&c=&m=` round-trip, forbidden-copy scan, D2 mention chips | with L3 |
| **L5 `chat-colour`** | the same site files as L4 | none | site only | colour determinism, contrast, colour-is-not-the-only-signal | **no** — same files as L4, lands after it |
| **L6 `chat-dm`** | `supabase/migrations/20260906*_signal_sender_visibility.sql` + `…_receipt_per_signal.sql`; then the DM surfaces in the L3/L4 files | none on the wire; **one RLS clause** | Feed **grows** for every member, retroactively, on clients that predate DMs. Release note required | before/after visibility suite; the receipts blocker control that fails today | **no** |
| **L7 `chat-threads-ui`** | the L3/L4 files, thread surfaces only | uses L1's `thread_root_id` | Old clients show thread replies inline in the flat feed. Nothing is hidden | reply-addressing pair; clamp; `N replies` query-count | **no** |
| **L8 `chat-copy`** | `README.md`, `SECURITY.md`, `site/src/pages/privacy.astro`, `docs/**`, `P3-1-SIGNALS-BRIEF.md` | none | prose only | claim-family scan | any time after L1 |

`package.json` is the one file every lane must touch (the `test` script is a literal list). **Only one
lane edits it at a time**; the conflict is a one-line merge, but two concurrent lanes will collide.

## The lanes, one paragraph each

**L1 `chat-schema`.** Three migration files, each safe alone because the Supabase CLI commits one file
per transaction (`20260902000001_broadcast_recipient_roster.sql:11-20`). File 1 creates `swarm.channels`
and `swarm_read.channels`; file 2 adds `signals.channel_id` (nullable forever, composite FK, partial
index) and recreates `swarm_read.signals` appending one column; file 3 adds `thread_root_id` and
`broadcast_to_channel` and recreates the view again. Files 2 and 3 stay separate because each takes an
`ACCESS EXCLUSIVE` lock on `swarm.signals`. The command edge gains three channel commands and three
optional `post_signal` fields; the read edge gains one optional `channel` filter. **The whole lane's
compatibility rests on one rule:** every new optional key gets its own `Object.hasOwn` group, because
`modernKeys` is an all-or-nothing pair every installed client always sends, so folding a new key into it
returns 400 on every post and every agent read. `channel_id` is never made `NOT NULL`, never defaulted,
never backfilled — that is what makes the migration-before-edge window harmless.

**L2 `chat-recipients`.** One signal, N recipients — the lane D2 and the operator's To: chips both wait
on. A `swarm.signal_recipients` side table holds `(signal_id, workspace_id, recipient_user_id,
recipient_agent_principal_id, position)`, one recipient kind per row, tenant-pinned by a composite FK to
`swarm.signals (id, workspace_id)` — the unique index L1 already builds for `thread_root_id` is what that
FK needs, so L2 does not add another. **`signals_one_recipient` is not relaxed and the scalar columns are
not dropped:** `to_user_id` / `to_agent_principal_id` keep holding the FIRST recipient, so an installed
CLI or browser that knows only the scalar columns shows a real recipient rather than none. That is the
whole compatibility argument — an old reader is *incomplete*, never *wrong* — and it is what makes this
landable without a client flag day.

> **CORRECTED 2026-09-05 after the lane was built.** The "Delivery fans out" sentence below did not
> survive review: the rows such a trigger writes cannot be delivered, so the trigger was removed and
> **three** things move together, not four. The paragraph is kept as written because it is the plan the
> lane was given. The section "L2 `chat-recipients` — what was built" at the end of this file carries
> what actually landed and why.

Four things move together or the lane is broken. **The view** gains a `recipients` aggregate appended at
the end of the select list, and its `WHERE` gains a disjunct for "I am in the recipient set, in person or
through an agent I own". **The agent read path** (`read/index.ts`) gains the matching arm in SQL — two
enforcement points in two languages, and an agent that is the second recipient sees nothing until both
move. **Delivery fans out**: a trigger on `swarm.signal_recipients` enqueues one row per agent recipient
with the same `ON CONFLICT DO NOTHING` the existing trigger uses, so the first recipient — already
enqueued from the scalar column — is not woken twice. **This is the first N-way fan-out in the system**,
which the reconciled design §10 put out of v1 pending capacity work, so the lane owes a cap:
`SIGNAL_RECIPIENT_MAX`, one constant, with the refusal sentence generated from it
(`MENTION_MAX_RECIPIENTS = 8` at `mention-address.ts:30` is the natural value and the natural place to
read it from).

Wire: `post_signal` gains optional `to`, an array of `{kind, id}`, in its **own** `Object.hasOwn` group —
never folded into `modernKeys`, for the reason L1 spells out. Sending `to` together with a conflicting
scalar `to_user_id` is refused, never silently reconciled. Two orderings bind: this is the **second** RLS
predicate change in the plan (L6's sender clause is the other), so the two must not be in flight at once
and each owes the before/after visibility suite; and it makes the L6 receipts blocker worse in kind — a
receipt endpoint that already discloses recipients to any member now discloses a whole roster — so the
per-signal receipt arm lands with or before this lane, not after.

**L3 `chat-client`.** `cswarm channel new|ls|rename|archive`, `--channel` on `post` and `feed`, and
`channel_id` surfaced in the record. Slug resolution reuses the name-or-uuid resolver already written
for `--to` (`src/cloud/signals.ts:1238-1254`). Every user-facing enumeration (valid slugs, the slug
rule, reserved slugs) is generated from the constants L1 exports, never typed — this is the failure
measured four times in one release cycle. The client is published **after** the edge is deployed.

**L4 `chat-app-channels`.** `STREAMS (broadcast)` becomes `CHANNELS`; the rail lists channels; the
composer stamps the channel you are reading and gains no chrome and no `#` parsing of the body; the URL
grammar `?w=&c=&m=` round-trips and a bad id shows an honest empty state rather than the unfiltered
feed. Before the rename lands, **enumerate** the case-insensitive `channel` occurrences in the dashboard
rather than grepping and assuming. D2's mention chips land here, on top of L2's recipient set.

**L5 `chat-colour`.** Entity colour from a durable id over a contrast-checked palette, extended to
people; the avatar becomes a real focusable filter control while the name keeps opening the panel; the
filter moves server-side. It needs nothing from the migration and could ship first — it is scheduled
after L4 only because it edits the same files.

**L6 `chat-dm`.** The SECOND RLS predicate change in the plan, after L2's recipient arm — the design
called it the only one, which stopped being true when multi-recipient signals came into v1. One clause
admitting rows the caller sent, plus the
`signals_from_newest` index nothing else provides. Two things gate it. The view recreation must start
from `pg_get_viewdef` against the target database, never from a migration file, or it silently deletes a
clause an earlier phase added — L1's migrations carry an in-migration assertion for exactly this. And
`swarm_read.signal_delivery_receipts` lets any member read any signal's recipient list
(`20260902000001:103-109`); shipping the word "DM" over that is a privacy claim with no control behind
it, so the per-signal arm lands **before** the DM vocabulary, in this lane.

**L7 `chat-threads-ui`.** Thread drawer, `N replies`, `?t=`. `in_reply_to` behaviour is untouched:
`thread_root_id` present is what opts a reply into thread behaviour, so no installed `cswarm reply`
changes meaning. Reply expiry is **clamped** to the root's remaining window, and refused only when the
caller passed an explicit `until_ms` longer than that window. The composer must show the inherited
ceiling, because the window can be milliseconds.

**L8 `chat-copy`.** The claim family in §11 of the design: the privacy page's two contradictory
sentences, `SECURITY.md:43-45`, the CLI's "omits directed messages, including messages you sent", and
the tests that pin those strings. Two of those tests are hard blockers — a negative gate on the word
"thread" and the settled-noun gate on "workspace" — so read them before choosing terminology.

## D-036 arms per lane

Every lane above changes a SHA, so every one owes two arms on its final SHA, cross-family, excluding the
author's family. Preference order Codex, Grok, Gemini; pick two.

| Lane | What the arms must attack first |
|---|---|
| L1 | The `exactKeys` group (does a body without `channel` still validate?); the view recreation dropping a `WHERE` clause; `channel_id` reachable as `NOT NULL` or defaulted by any path; the composite FK under a NULL; delivery rows created by a channel post |
| L2 | An old reader that sees NO recipient instead of the first; a second agent recipient woken twice or not at all; the recipient RLS arm widening beyond the set; the cap unenforced on one of the two enforcement points |
| L3 | A typed enumeration inside a message; the client publishing before the edge deploy |
| L4 | Copy that implies privacy; a filter that replaces the predicate; the URL falling back to the unfiltered feed on a bad id; D2's second mention |
| L5 | Colour as the only signal; a click handler on the wrong element |
| L6 | The view body resolved from a file instead of the database; the receipts arm passing because it refuses everyone |
| L7 | A thread reply that changes `in_reply_to` addressing; a clamp that silently shortens an explicit request |
| L8 | A correction sent as a message instead of landing in the artifact; retired wording deleted rather than marked |

## L8 addendum — the citation and policy-copy work this lane cut

**Scope ruling, 2026-09-05: this belonged to L8 `chat-copy`, not to L1.** The schema lane grew a tail of
edits under `site/` because adding ~1000 lines to `supabase/functions/command/index.ts` moved every
`file:line` the published pages cite. Rounds 5 and 6 kept finding defects there, in files no schema
change should touch. It was reverted to `main` and is recorded here so it is not lost.

What was found and reverted, for whoever picks up L8:

1. **The citation gate pins code, not prose.** `tests/p1-cli/citation-drift.test.ts` asserts the
   registered lines contain the quoted text. It never reads the citing file, so a comment in
   `privacy.astro` can say `:564` while the table correctly says `:565` and the gate stays green. Both
   arms found this independently. The durable fix is a `citedIn` field naming the citing file, so the
   prose and the table have to agree.
2. **Stale pointers on `main` today**, each verified by reading and then reverted: `privacy.astro` cites
   the GitHub display-name derivation, the audit `ip` column, `COMMAND_KINDS`, and `identityVerified`;
   `terms.astro` and `acceptable-use.astro` cite the signal rate caps, the workspace cap, the hourly
   rate window, and the invitation and agent-token TTL caps; `agent-connect.ts` cites the mint device
   binding and the scope gate; `src/cloud/files.ts` cites the TTL constant. All were pointing at
   unrelated code BEFORE this lane, and this lane's line growth makes them worse.
3. **One wrong number, in a comment and not in published copy.** `acceptable-use.astro`'s source header
   said the agent credential TTL cap is 24 hours; `AGENT_TOKEN_MAX_TTL_MS` is 30 days. The rendered
   sentence on the page already said "30 days at most, 24 hours by default" and is correct, so this is a
   comment defect and not a live false claim.
4. **`privacy.astro`'s `COMMAND_KINDS` summary** does not list `channel_create`, `channel_rename` or
   `channel_archive`, which L1 adds. It was already a partial summary; L8 should say so or complete it.

L1 keeps only the line remaps its own `command/index.ts` growth forces in the existing
`citation-drift.test.ts` entries. It registers nothing new and edits no page.

## What this plan does not settle

1. **Nothing below L1 has been measured.** The file lists for L2-L8 are read from the design and from the
   coordinator's instruction, not from a diff; the site file paths in particular were not enumerated.
2. **L2's shape is a design, not a measurement.** No query plan, no row counts, and no check that the
   delivery trigger's `ON CONFLICT` key actually de-duplicates the first recipient — that is the first
   thing L2's Postgres suite must establish, because the argument for it is read from
   `20260731000001:126-137` rather than run.
3. **D2's mechanism now exists on paper only.** The ruling is recorded and L2 is the route; nothing is
   written.
4. **No performance work.** The indexes in the design come from query shape, not from a plan. L2 adds an
   N-way fan-out to a delivery ledger sized for one row per signal, and its capacity was not measured.
5. **The deploy order is stated, not rehearsed.** Migration → verify via `schema_migrations` → edge →
   client → site, per `20260902000001:58-64`. *Pushed is not landed and landed is not applied.*


## L1 landed 2026-09-05 (merge 8adf55a) — owed residuals and bounds

Three migrations applied to production (`20260905000001..3`), `command` v40 and `read` v20
deployed, live control on production: bad slug → 400 with its reason; `channel_create` → 200;
`post_signal` with `channel` → `channel_id` set; `channel_archive` → 200; post into the archived
channel → 409 `channel_archived` with its reason; the 0.1.54 client still posts and its accepted
signal carries `channel_id`, `thread_root_id`, `broadcast_to_channel`.

Owed, from review round 9 (refusal ORDER only; no accept/refuse boundary moves):
- `declare_agent_model` / `set_agent_model`: the type check is bundled with `exactKeys`, so
  `model: 123` is told the field-list sentence. A started fix is saved as
  `docs/evidence/2026-09-05-chat-schema/post-65bb111-residuals-uncommitted.patch` (unreviewed).
- `chatSignalShapeProblem`: `broadcast_to_channel` + a bad slug is told the slug rule before the
  rule that makes the request impossible; the comment at `channels.ts:279-281` promises the other
  order.

Bound: "every 400 carries its reason" holds for the validation layer. Envelope failures before
it (missing `client_version`, a body that is not the command envelope, auth and route checks)
still answer a bare `invalid_request`; the `read` edge returns a reason only for the channel slug.


## L2 `chat-recipients` — what was built, and what it does not establish

Branch `lane/chat-recipients`, on top of L1's merge `8adf55a`. NOT deployed by this lane: the lead
pushes the migration to production, in order, and only then deploys `command` and `read`.

**Apply order, which this lane cannot loosen.** `20260905000010_signal_recipients.sql` → verify with a
`swarm.schema_migrations` query, not with the `db push` output → deploy `command` and `read` together.
The read edge names `s.recipients`; against a database missing this migration EVERY agent read fails.

**The shape.** `swarm.signal_recipients (signal_id, workspace_id, recipient_user_id,
recipient_agent_principal_id, position)`, one recipient kind per row, tenant-pinned by composite FKs to
`swarm.signals (id, workspace_id)`, `swarm.memberships (workspace_id, user_id)` and
`swarm.agent_principals (principal_id, workspace_id)`. Immutable the same way `swarm.signal_attachments`
is: one trigger refuses an insert whose parent signal is not from this transaction, another refuses every
UPDATE and DELETE. Who can read an immutable signal therefore cannot change after it is written.

**The old-reader guarantee is enforced, not promised.** A DEFERRED constraint trigger refuses the commit
unless positions run 0..n-1 and position 0 is the signal row's own `to_user_id` /
`to_agent_principal_id`. `signals_one_recipient` is untouched.

**No backfill, and that is a property of the view rather than an omission.** `swarm_read.signals` gains
one `recipients` column that reads the rows when there are rows and DERIVES a one-entry set from the
scalar column when there are none. Every signal written before this migration therefore renders exactly
as it would if its row existed, and a signal posted with a one-entry `to` renders identically to the same
address sent the scalar way.

**What "identical" covers, and the one thing it does not.** The `swarm.signals` row is identical column
for column, the `swarm.signal_deliveries` rows are identical, and the rendered `recipients` is identical.
The SIDE TABLE differs: a scalar post writes zero recipient rows and a one-entry `to` writes one. The
view's fallback is exactly what makes the two read alike anyway. A review arm called the compat claim
inaccurate for leaving this unsaid; the served test now asserts the difference as well as the three
identities.

**A recipient can reply to a signal that names them.** `in_reply_to`'s authorization read the scalar
columns, which carry recipient 0 only, so a later recipient could read a signal and got a 403 trying to
answer it. Found by a review arm on this lane. `signalNamesRecipient` adds the second arm, and what it
admits is stated per caller rather than as one sentence about "the read path", because the two read
paths are not the same cut:

- **A human caller** is admitted when the set names them in person, or when it names an agent they own.
  Those are the same two cases `swarm_read.signals` admits through that table.
- **An agent caller** is admitted only when the set names the principal it presented. That is the same
  cut `read/index.ts` makes, and it is NARROWER than the view: an agent cannot read, and cannot reply
  to, a signal addressed to its owner.

It widens nothing else. An UNDIRECTED signal has no recipient set, so nobody is a recipient of one and
`in_reply_to` on it is refused for every caller, exactly as before this lane. A member who is not in
the set still cannot reply, and that is the control on both the human and the agent branch.

**NO DELIVERY FAN-OUT, and this is the lane's biggest correction.** The L2 paragraph above and the
lane's own commit message `5b60f98` both said delivery fans out one row per agent recipient, with the
`ON CONFLICT DO NOTHING` that keeps recipient 0 from being woken twice. That trigger was written, it
worked, and a review arm showed the rows it wrote **cannot be delivered**:

1. `hydrateDeliveryRefs` in `supabase/functions/command/durable-delivery.ts` filters on
   `s.to_agent_principal_id = <the claiming principal>`. That column holds recipient 0, so a row for
   recipient 1 leases, fails to hydrate, answers 403 `delivery_unavailable` and **commits** -- the
   lease and `attempt_count` stick, and ten claims terminalize the row as
   `delivery_attempts_exhausted` with a security alert. The `expired` acknowledgement has the same
   filter.
2. `src/cloud/delivery.ts:423` -- an installed listener refuses any delivery whose `signal.to_agent`
   is not its own principal. So no server-side fix alone can hand the row over. It needs a client
   release (L3), or a wire on which `to_agent` means "this delivery's recipient" rather than "the
   signal's scalar recipient", which is a ruling nobody has made.

The alternative of writing the rows and refusing to lease them was rejected: `pending_delivery_count`
and `oldest_pending_at` would then report a queue that grows and can never be drained, which is a false
signal rather than a missing feature.

**So, exactly: recipients 1..N READ the signal and can REPLY to it. They are not woken.** The wake is
unchanged and it reads the SCALAR column, so it wakes the recipient at position 0, and only when that
recipient is an agent taking `ask` or `note`. A `to` whose position 0 is a PERSON wakes nobody at
all, even when it names agents later in the list. Naming an agent at position 1 never notifies it. Section 4 of the migration
carries the reason; `tests/p1-local/chat-recipients-postgres.test.ts` pins both the behaviour and the
absence of any trigger on the recipients table, and the served suite pins it through the edge.

**The cap** is `SIGNAL_RECIPIENT_MAX = 8` in `supabase/functions/_shared/channels.ts`, enforced twice:
the edge validator refuses a longer list with a sentence built from the constant, and the CHECK on
`position` bounds it at 7, which caps the row count because positions are unique per signal.
`tests/chat-channel-constants.test.ts` fails if the migration's bound, the edge constant, or
`MENTION_MAX_RECIPIENTS` in `site/src/lib/mention-address.ts` disagree.

**Second RLS predicate change.** The migration comment states the predicate before and after. The new
disjunct carries its own `is_member` gate, so ORing it at the top level cannot admit a row to a
non-member; it admits exactly the people the sender addressed, in person or through an agent they own.
The recreation splices the live `pg_get_viewdef` body in two steps (top-level FROM first, then the first
WHERE after it) because the attachments subquery in the select list carries its own WHERE and a single
pass finds that one. `assert_view_clauses_preserved` learns the new marker in the same file.

**Wire.** `post_signal` gains optional `to`, an array of `{kind, id}`, through
`CHAT_SIGNAL_OPTIONAL_KEYS` so it is its own `Object.hasOwn` group. `to` beside a scalar recipient is
refused and never reconciled. `to` on a thread reply, on a `working-on`, or beside `in_reply_to` is
refused by the same rule that already refuses the scalar spelling, with the same sentence.

### What L2 did NOT establish

1. **No capacity measurement, and no fan-out to measure.** The delivery ledger still gets one row per
   signal, so the capacity question §10 of the reconciled design asks about is untouched and unanswered.
   It becomes live the day recipients 1..N are woken.
2. **No query plan.** `s.recipients` is a derived column, so the read edge's containment arm cannot use
   an index; the indexed `to_agent` arm is kept beside it. Nothing was measured.
3. **The receipts blocker is still open.** The reconciled design says
   `swarm_read.signal_delivery_receipts` lets any member read any signal's recipient list, and that a
   recipient SET makes it worse in kind. The per-signal receipt arm is L6's and did not land here.
   Nothing in L2 widens that endpoint, and nothing in L2 fixes it.
4. **Not measured against production.** Local Supabase only.
5. **Group DMs: one of the two mechanical reasons they were out of v1 stopped being true, and one did
   not.** A three-party address is storable and readable. It notifies at most the agent at position 0,
   -- it wakes the recipient at position 0, and only when that recipient is an agent taking `ask` or
   `note` -- and nobody at all when position 0 is a person, so §4's objection -- a conversation type that
   silently fails to notify the agents in it -- still stands for every agent but one. Nobody has ruled
   on whether v1 should have group DMs, and no document in this repo should read as if someone had. §4 and §10 carry the correction, including the intermediate version
   that said "deliverable" and was wrong. The ruling is the coordinator's.

7. **One refusal shows the generic sentence where a better one exists.** A `working-on` whose `to` also
   breaks the cap is answered "signal fields are malformed or over their limits", because the edge
   prefers the chat sentence only when nothing else is wrong and `working-on` takes no recipients at
   all. The cap sentence is reachable whenever the rest of the body is legal. Named by a review arm,
   pinned by a served test, and not fixed: the accept/refuse boundary does not move, and the fix is a
   change to how the edge chooses between two true refusals, which is bigger than this lane.

8. **Waking a later recipient is BLOCKED, not deferred by choice.** The two changes it needs are named
   above and neither is in this lane. Whoever picks it up owes a decision on what `to_agent` means on a
   hydrated delivery before they write any code.
6. **No client, no composer.** L3 and L4 still own `--to` and the mention chips; nothing a person can
   type reaches `to` yet.

## L2 landed 2026-09-05 (merge 060ff67) — rulings and bounds

Migration `20260905000010_signal_recipients` applied to production; `command` and `read` deployed
together (the read view names `s.recipients`). Live control on production: a note with a two-agent
`to` list is accepted with the first recipient in the scalar column and the set in `recipients`;
nine recipients are refused with the cap named; the 0.1.55 client's plain note still posts.

Rulings (lead, 2026-09-05), recorded here because the lane routed them rather than deciding:
- **Group DMs in v1: no.** A multi-recipient signal is a directed note with N readers; it is not a
  conversation surface. Consistent with D1 (no private channels). Revisit with L6 receipts.
- **`to_agent` on a hydrated delivery means the recipient at position 0**, the one that is woken.
  Waking recipients 1..N needs the hydration filter and the installed listener's own-principal
  refusal (`src/cloud/delivery.ts:423`) to change together, client and edge in apply order; that
  is its own lane, not started.

Bounds the review named on the wake clause, pre-existing in `enqueue_signal_delivery()`: an
expired signal still enqueues (the trigger checks `kind`, not `until`); a revoked agent at
position 0 still enqueues; an agent addressing itself still enqueues. Recorded, not fixed here.

Wording residual Grok named on the passing SHA: this plan's original L2 paragraph says the lane
"enqueues one row per agent recipient"; it does not. The L2 row above is the retired wording,
kept; this section is the record.

## Waking every recipient, 2026-09-05 (lane/wake-all-recipients) — written, NOT deployed

Migration `20260905000020_wake_all_recipients` plus the `command` and `read` edges. Nothing in this
section is live: it is on a lane branch and the lead applies it.

Corrections to the L2 section above, which a reader may still meet:

- **RETIRED: "`to_agent` on a hydrated delivery means the recipient at position 0."** It is now the
  recipient the DELIVERY ROW is for, at any position. The scalar column never reaches this wire. A
  feed read of the same signal still reports the scalar column, so the two surfaces answer different
  questions with different values, and `src/cloud/delivery.ts` says so at its own-principal check.
- **RETIRED: "A set whose position 0 is a PERSON wakes nobody at all, even when it names agents
  later in the list."** That shape wakes every agent named after the person.
- **RETIRED: "Waking recipients 1..N ... is its own lane, not started."** It is this lane.

Of the three bounds L2 recorded on the wake clause, two are closed in the shared predicate
`swarm.agent_delivery_is_wakeable` and the third was deliberately left open:

- an expired signal no longer enqueues. Reach: `signals_check` (`until > created_at`) means the edge
  cannot produce this shape at all, so it is a second wall on a backdated direct insert.
- a revoked agent no longer enqueues. Its row was unclaimable and uncounted-down for ever.
- an agent STILL wakes itself. A clause refusing that was written and removed after a review arm
  found `runListenerAttendanceCanary` posts exactly that shape, so `cswarm listen canary` needs the
  wake. What the fan-out adds is the accidental case, an agent posting to a group it belongs to and
  waking itself on every turn; closing that needs a rule that can tell the canary apart from a
  group reply, and this lane does not have one.

Still open, and named rather than fixed: revocation or expiry AFTER the row is enqueued leaves an
unreachable pending row, because the predicate runs once at insert.

### Bounds on the L2 recipient set, as of this lane

Open, named rather than fixed. Each one is a thing a reader will otherwise assume is closed.

1. **Revocation or expiry AFTER the row is enqueued.** `swarm.agent_delivery_is_wakeable` runs once,
   inside the insert. An agent revoked a minute later still owns an unclaimable row that
   `claimAgentInbox` step 1 refuses to take and no step terminalizes, so it counts in
   `pending_delivery_count` for ever. The durable fix is a claim-time sweep for revoked recipients.
2. **An agent still wakes ITSELF, including in a group it belongs to.** A clause refusing that was
   written and removed: `runListenerAttendanceCanary` posts a self-note and `cswarm listen canary`
   needs the wake. With the fan-out an agent that posts to a group containing itself is woken on
   every turn. Closing it needs a rule that can tell the canary apart from a group reply, and this
   lane does not have one.
3. **A hydrated delivery can carry BOTH `to` and `to_agent`.** With a person at position 0 and an
   agent at position 1, `to` is the person and `to_agent` is the claiming agent. That pair was
   impossible before, because the old filter required the scalar agent column and
   `signals_one_recipient` then forced `to` null. Measured once against the served edge; no
   committed test asserts it. Nothing in `src/` treats the two as exclusive: the three places that
   read both ask `to === null && to_agent === null`, which is the broadcast question.
4. **`describeAudience` in `src/cli.ts` names only position 0.** It reads the send response's scalar
   columns, so `cswarm ask --to a --to b` prints one recipient. Incomplete, not wrong, and it is the
   send path rather than the delivery path.
5. **The human half of a delivery receipt names only the scalar `to_user_id`.** A PERSON at position
   1 has no receipt row. People are not woken, so this lane makes no claim about it.

What this lane does NOT change, and what the lead must sequence:

1. **Apply order is migration, then `command`, then `read`, then a client release.** The migration
   alone writes rows the deployed `command` cannot hydrate; each claim would burn one of ten attempts
   and terminalize the row with a security alert.
2. **The site's To: field copy becomes false on deploy.** `site/src/components/app/` states that a
   person in front means the service wakes nobody, and `composer-to-field.observer.test.ts` asserts
   it. That is another lane's file and it was not touched here.
3. **The CLI is now wired to the agent `channels` resource, which makes the DEPLOY ORDER binding.**
   `CHANNEL_LIST_NEEDS_HUMAN_MESSAGE` and `CHANNEL_SELECTOR_NEEDS_ID_MESSAGE` are retired, their
   wording kept in `src/cloud/channels.ts`, and `channelRows` no longer REFUSES an agent credential.
   It still branches on the credential kind, and has to: the read function accepts agent credentials
   only and a person reads `swarm_read` over PostgREST, so the kind picks the transport. (An earlier
   draft of this item, and the `ecbb26b` commit message, said "no longer branches on the credential
   kind". A review arm refuted it twice, here and in `src/cloud/channels.ts`.) A client carrying this
   against a read service without the arm gets HTTP 400 and says the list was refused. Deploy `read`
   before or with the client release.

3b. **One stale comment in the site owner's file, NOT touched here.**
   `site/src/lib/commonswarm.ts:2252` says "The read edge exposes no channel list, so the browser
   reads `swarm_read.channels` directly". The first clause is false once the `read` edge deploys.
   The second clause and the code stay right, because the read function accepts agent credentials
   only and a browser has none. The one-line replacement is: "The read edge's channel list takes an
   agent credential only, so the browser reads `swarm_read.channels` directly". Routed to the site
   owner rather than edited here.

4. **The feed-side scalar re-check is fixed here, and it was a live defect.**
   `src/cloud/arrival-watch.ts` returned `{reason: "error"}` and `src/listener/hook.ts` dropped a row
   for a signal naming this agent at position 1, both reachable from L2 (merge 060ff67) with no part
   of this lane deployed. `parseSignalRecord` now reads `recipients` when the server sends it,
   absent stays absent, and `signalAddressesAgent` is the one question all three sites ask. The
   human REST read still does not name the column, so a person's feed rows carry no set.
