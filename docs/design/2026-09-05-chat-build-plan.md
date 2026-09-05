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
> is two messages nobody else can read. D2 says that is the wrong behaviour. Lane **L3** must therefore
> either (a) accept one mention as the single recipient and refuse the second with a message that says
> why, or (b) wait for multi-recipient signals
> (`docs/design/2026-09-03-multi-recipient-signals.md`, still deferred). D2 is not shippable as written
> without one of those two. It is a client decision, not a schema one, so it does not block L1.

## Lane table

Apply order is top to bottom. A lane may start only when every lane above it has landed on `main`,
except where the "Parallel" column says otherwise.

| Lane | Owns (no other lane edits these) | Wire change | Old-client rule | Tests it adds | Parallel |
|---|---|---|---|---|---|
| **L1 `chat-schema`** | `supabase/migrations/20260905000001_channels.sql`, `…0002_signal_channel.sql`, `…0003_signal_threads.sql`; `supabase/functions/_shared/channels.ts`; `supabase/functions/command/index.ts`; `supabase/functions/read/index.ts`; `tests/chat-channel-constants.test.ts`; `tests/chat-signal-wire-compat.test.ts`; `tests/p1-local/chat-channels-postgres.test.ts` | `channel_create` / `channel_rename` / `channel_archive`; `post_signal` gains optional `channel`, `thread_root_id`, `broadcast_to_channel`; `read` gains optional `channel`; the signal record gains `channel_id`, `thread_root_id`, `broadcast_to_channel` | Additive nullable column, no backfill, no `SET NOT NULL`. Every new optional key is its **own** `Object.hasOwn` group; `modernKeys` is not widened | constants + generated messages; wire-compat twin of `tests/receipt-wire-compat.test.ts`; Postgres suite (channels, immutability, tenancy, delivery-neutrality) | — |
| **L2 `chat-client`** | `src/cloud/channels.ts` (new), `src/cloud/signals.ts`, `src/cloud/command-client.ts`, `src/cli.ts`, `tests/p1-cli/chat-cli.test.ts` | sends `channel` on post; `--channel` on feed; `cswarm channel ls\|new\|rename\|archive` | Client is newer than the edge only after L1 deploys. Publish the npm client **after** the edge deploy, never before | CLI parse + copy tests; slug resolver reuse of the `--to` name-or-uuid resolver | with L3 (disjoint files) |
| **L3 `chat-app-channels`** | `site/src/pages/app/*`, `site/src/lib/*`, `site/tests/*` for channels | none (browser reads the view directly) | Browser names its columns explicitly; L1's view append is safe. A new client against an **un-recreated** view is a PostgREST 400, so deploy order is migration → edge → site | rail, composer stamping, `?w=&c=&m=` round-trip, forbidden-copy scan | with L2 |
| **L4 `chat-colour`** | the same site files as L3 | none | site only | colour determinism, contrast, colour-is-not-the-only-signal | **no** — same files as L3, lands after it |
| **L5 `chat-dm`** | `supabase/migrations/20260906*_signal_sender_visibility.sql` + `…_receipt_per_signal.sql`; then the DM surfaces in the L2/L3 files | none on the wire; **one RLS clause** | Feed **grows** for every member, retroactively, on clients that predate DMs. Release note required | before/after visibility suite; the receipts blocker control that fails today | **no** |
| **L6 `chat-threads-ui`** | the L2/L3 files, thread surfaces only | uses L1's `thread_root_id` | Old clients show thread replies inline in the flat feed. Nothing is hidden | reply-addressing pair; clamp; `N replies` query-count | **no** |
| **L7 `chat-copy`** | `README.md`, `SECURITY.md`, `site/src/pages/privacy.astro`, `docs/**`, `P3-1-SIGNALS-BRIEF.md` | none | prose only | claim-family scan | any time after L1 |

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

**L2 `chat-client`.** `cswarm channel new|ls|rename|archive`, `--channel` on `post` and `feed`, and
`channel_id` surfaced in the record. Slug resolution reuses the name-or-uuid resolver already written
for `--to` (`src/cloud/signals.ts:1238-1254`). Every user-facing enumeration (valid slugs, the slug
rule, reserved slugs) is generated from the constants L1 exports, never typed — this is the failure
measured four times in one release cycle. The client is published **after** the edge is deployed.

**L3 `chat-app-channels`.** `STREAMS (broadcast)` becomes `CHANNELS`; the rail lists channels; the
composer stamps the channel you are reading and gains no chrome and no `#` parsing of the body; the URL
grammar `?w=&c=&m=` round-trips and a bad id shows an honest empty state rather than the unfiltered
feed. Before the rename lands, **enumerate** the case-insensitive `channel` occurrences in the dashboard
rather than grepping and assuming. D2's mention change lands here, with the blocker above resolved.

**L4 `chat-colour`.** Entity colour from a durable id over a contrast-checked palette, extended to
people; the avatar becomes a real focusable filter control while the name keeps opening the panel; the
filter moves server-side. It needs nothing from the migration and could ship first — it is scheduled
after L3 only because it edits the same files.

**L5 `chat-dm`.** The only RLS change in v1: one clause admitting rows the caller sent, plus the
`signals_from_newest` index nothing else provides. Two things gate it. The view recreation must start
from `pg_get_viewdef` against the target database, never from a migration file, or it silently deletes a
clause an earlier phase added — L1's migrations carry an in-migration assertion for exactly this. And
`swarm_read.signal_delivery_receipts` lets any member read any signal's recipient list
(`20260902000001:103-109`); shipping the word "DM" over that is a privacy claim with no control behind
it, so the per-signal arm lands **before** the DM vocabulary, in this lane.

**L6 `chat-threads-ui`.** Thread drawer, `N replies`, `?t=`. `in_reply_to` behaviour is untouched:
`thread_root_id` present is what opts a reply into thread behaviour, so no installed `cswarm reply`
changes meaning. Reply expiry is **clamped** to the root's remaining window, and refused only when the
caller passed an explicit `until_ms` longer than that window. The composer must show the inherited
ceiling, because the window can be milliseconds.

**L7 `chat-copy`.** The claim family in §11 of the design: the privacy page's two contradictory
sentences, `SECURITY.md:43-45`, the CLI's "omits directed messages, including messages you sent", and
the tests that pin those strings. Two of those tests are hard blockers — a negative gate on the word
"thread" and the settled-noun gate on "workspace" — so read them before choosing terminology.

## D-036 arms per lane

Every lane above changes a SHA, so every one owes two arms on its final SHA, cross-family, excluding the
author's family. Preference order Codex, Grok, Gemini; pick two.

| Lane | What the arms must attack first |
|---|---|
| L1 | The `exactKeys` group (does a body without `channel` still validate?); the view recreation dropping a `WHERE` clause; `channel_id` reachable as `NOT NULL` or defaulted by any path; the composite FK under a NULL; delivery rows created by a channel post |
| L2 | A typed enumeration inside a message; the client publishing before the edge deploy |
| L3 | Copy that implies privacy; a filter that replaces the predicate; the URL falling back to the unfiltered feed on a bad id; D2's second mention |
| L4 | Colour as the only signal; a click handler on the wrong element |
| L5 | The view body resolved from a file instead of the database; the receipts arm passing because it refuses everyone |
| L6 | A thread reply that changes `in_reply_to` addressing; a clamp that silently shortens an explicit request |
| L7 | A correction sent as a message instead of landing in the artifact; retired wording deleted rather than marked |

## What this plan does not settle

1. **Nothing below L1 has been measured.** The file lists for L2-L7 are read from the design, not from a
   diff; the site file paths in particular were not enumerated.
2. **D2 has no shippable form yet** (the blocker above). The ruling is recorded; the mechanism is not.
3. **No performance work.** The two indexes in the design come from query shape, not from a plan.
4. **The deploy order is stated, not rehearsed.** Migration → verify via `schema_migrations` → edge →
   client → site, per `20260902000001:58-64`. *Pushed is not landed and landed is not applied.*
