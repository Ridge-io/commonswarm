# Chat platform — channels, DMs, threads, colour (reconciled)

Design only. No product code, schema, or site change was written for this document, and none should be
until the lead approves the phasing.

This reconciles two drafts written the same day by sessions that did not know about each other:

- **A** — `docs/design/2026-09-04-streams-dms-threads.md` on `spec/streams-dms-threads` (1487 lines).
  Two adversarial arms were run on its first version; both returned FAIL and their findings were folded
  in. Transcripts: `docs/evidence/2026-09-04-streams-spec-review/`.
- **B** — `docs/design/2026-09-04-CHAT-PLATFORM.md` on `lane/chat-platform-spec` (937 lines). Marked
  DRAFT; no arms were run.

Where they conflicted, this document rules by measuring, names which draft the ruling came from, and
says why the other lost. Base tree: **`d57d480`**, which was `origin/main` when this branch was cut; `origin/main` has since
moved to `6465afa`, so resolve every citation against `d57d480` rather than against today's tip. Every
citation below was resolved in that tree. `docs/design/SWARM-CLOUD.md` is canonical; on conflict it wins.

## 0. Rulings

| # | Question | Ruling | From | Why the other lost |
|---|---|---|---|---|
| R1 | Does a channel narrow **who may read** a signal? | **No.** A channel is an immutable grouping label stamped at post time. It never appears in an authorization predicate. No `channel_members` table in v1. | **B** | A's Phase 5 private channels are not v1. `SWARM-CLOUD.md:553` forbids new object-model concepts and `:909` caps day-1 vocabulary; B→A is a reversible narrowing while A→B is a disclosure event that cannot be undone; and the operator never asked for privacy. A's predicate work is summarised in Appendix A for the day it is asked for (the long form stays on its branch) — it is correct, it is just not v1. |
| R2 | Is a thread a view over `in_reply_to`? | **No.** A thread gets its own identity: `thread_root_id`. `in_reply_to` keeps its exact current meaning and behaviour. | **A** | B misread the column. Measured below (§1.2): `in_reply_to` means *reply privately to the author*, not *reply in public*. B's proposed `in_reply_to := COALESCE(parent.in_reply_to, parent.id)` normalisation redirects the server's audience derivation from the parent to the root, silently changing the recipient of every second-and-later reply — including the listener's own reply loop. |
| R3 | Does a DM need a conversation object? | **No conversation table.** But B's headline claim "no migration" is **false**: DMs need a new view clause (e) and a new index. | **B** for the shape, **A** for the requirement | B's premise — "both halves are already visible to me" — is false as measured (§1.3): the live view has no `from_principal` clause, so the sender cannot re-read their own directed signal. A's conversation table is still not needed for a 1:1 DM, because a two-party DM is addressable from the counterparty ref alone (§4). Group DMs are still listed out of v1, and since 2026-09-05 nobody has ruled on why — see §4. |
| R4 | Is `#all-signals` a row, and is `channel_id` backfilled? | **Not a row. Not backfilled.** `channel_id` is nullable forever in v1; `NULL` means *unfiled*; `#all-signals` is the unfiltered view. **Price, stated: no pre-migration signal ever appears in a named channel** (§6 P1). | **B** | A's default-channel backfill requires `DISABLE TRIGGER` on `signals_append_only` — the strongest invariant in the schema and a published promise — an `ACCESS EXCLUSIVE` lock of a duration A could not measure, a defaulting trigger, an orphan assert, and a member-roster backfill. Its own two arms found four separate defects in those five moving parts (A D1, D3, D8, D9). B's shape has none of them because it writes no row. |
| R5 | Which slice ships first? | **Public channels** (in B's no-backfill shape). | **A** | Ranked on the four stated criteria in §6. B's S1 (colour + click-to-filter) wins only on risk, which is not one of the criteria: it creates no identity a later phase needs, and it completes the smallest of the four asks. It ships *alongside*, not first. |
| R6 | Retention / `until` | **`until` stays `NOT NULL`. No retention change in v1.** A channel is a place, not an archive; say so in the UI. | **A** | B does not trip the `until` trap but never names it, and B's own ruling that `#all-signals` means "everything" is false as written — the feed already hides expired signals (§1.5). |
| R7 | Vocabulary | `stream` is the event log and never appears in the UI; `channel` is the user-facing room and becomes plural. | **both agree** | — |
| R8 | Colour | Derived from the entity's durable id, fixed contrast-checked palette, extended to people. Never the only signal. | **B** | A does not cover it. |
| R9 | Click conflict | The avatar/swatch filters; the name keeps opening the panel; the panel gains an explicit "Show only …". | **B** | A does not cover it. |
| R10 | Composer chrome | You post to the channel you are reading. No picker, and **no `#` parsing of the body, ever**. | **B** | A does not cover it. B's reason holds: message bodies legitimately contain `#` (markdown headings, `#1804` issue refs), so a parser cannot discriminate. |
| R11 | May a thread reply be an `ask`? | **Yes** — `ask` or `note`, never `working-on`. `in_reply_to`'s note-only rule is untouched. | **new** | R2 separates thread identity from `in_reply_to`, which answers B's open operator question 2 without widening any shipped validation. B had to escalate it because its thread rode on `in_reply_to`. |
| R12 | Thread expiry | A reply may not outlive its root. The server **clamps**, it does not refuse — see §6 P4. | **B**, corrected | A does not cover it. Both failure modes B names are real, and the append-only trigger makes the alternative (extend the root) impossible. But B's rule as literally written refuses almost every reply; the clamp is this document's correction to it. |
| R13 | Linkable / referenceable | Id-based URL grammar; a link is an address, not a grant. | **A** (grammar) + **B** (filter state in the URL) | Neither lost; A's grammar is more complete and B added that filter state must round-trip. |

## 1. Ground truth

Nine facts. Everything downstream rests on these.

### 1.1 The signal row

`supabase/migrations/20260724000003_signals.sql:3-18` creates `swarm.signals`:

- `until timestamptz NOT NULL` (`:12`), `CHECK (until > created_at)` (`:14`),
  `CHECK (until <= created_at + interval '30 days')` (`:15`). **Every signal expires within 30 days.**
  Server ceiling `SIGNAL_MAX_UNTIL_MS` at `supabase/functions/command/index.ts:512`; per-kind defaults
  at `:513-517`.
- **Append-only.** `CREATE TRIGGER signals_append_only BEFORE UPDATE OR DELETE … EXECUTE FUNCTION
  swarm.prevent_append_only_mutation()` (`:36-38`; the function is at
  `20260723000001_p1_schema.sql:554`). No row is ever edited or deleted through the normal path.
- **At most one recipient, of one of two kinds.** `to_agent_principal_id` and `in_reply_to` were added
  by `20260730000002_agent_signal_receive.sql:4-6`, with `CONSTRAINT signals_one_recipient CHECK
  (num_nonnulls(to_user_id, to_agent_principal_id) <= 1)` (`:25-27`).

### 1.2 `in_reply_to` means "reply privately to the author" — this is the decisive measurement

Both the ruling on threads (R2) and the rejection of B's normalisation rest on three lines of code.

**(a) The validator admits `in_reply_to` only on an undirected `note`** —
`supabase/functions/command/index.ts:1588-1595`:

```js
inReplyTo === null ||
(cmd.signal_kind === "note" && cmd.to_user_id === null && toAgentPrincipalId === null)
```

**(b) The server then re-addresses the row to the referenced signal's author** —
`supabase/functions/command/index.ts:5804-5827`. `resolveSignalWriteTarget` loads the reference,
requires it was addressed to the caller (`addressedToCaller`, `:5789-5802`), and returns
`{ toUserId: reference.from_principal }` or `{ toAgentPrincipalId: reference.from_principal }`. The
stored row is **directed**. If the reference was not addressed to the caller it returns `null`, and the
dispatcher at `:6567-6582` turns that into a **403 `forbidden`** with audit reason
`"signal target or reply is not eligible"`.

**(c) Every writer knows this.** Both reply write sites send null targets and rely on the server:

- `src/cli.ts:3112-3119` — the comment is explicit: `// Audience is derived server-side from the
  referenced signal; client sends null targets.`
- `src/listener/runtime.ts:772-780` — the listener's reply poster, identical shape.

Two more surfaces say it in their own words: `20260730000002:71-72` —
`'Immutable one-hop correlation to a signal in the same workspace.'` — and `src/cli.ts:3159`, the reply
verb's success line: **`"Reply shared. It is immutable and addressed to the original author."`** There is
also **no `--in-reply-to` flag anywhere in the CLI**: `reply <signal-id>` is the only way to set the
column, and it always sends null targets. No caller can express "reply publicly" today.

**A's reading is correct and B's is wrong** — though the first draft overstated *how*, and a review arm
was right to refuse it. The live function uses **one** `inReplyTo` value as both lookup key and stored
value (`:5747`, `:5781`, `:5813`), and the audience comes from the row that lookup loads. B's rule
(`in_reply_to := COALESCE(parent.in_reply_to, parent.id)`) never says which it rewrites, and **both
readings are wrong, differently**:

- **Stored value only** (B's "already loads the parent" reads this way): addressing is unchanged, but the
  stored `in_reply_to` names the root while the recipient is the *parent's* author — the column stops
  meaning what its comment says, and `signals_reply_oldest`, the index B builds threads on, no longer
  agrees with the audience.
- **Lookup key**: `addressedToCaller` and `reference.from_principal` are computed from the root, changing
  the recipient. In `A → agent → A → agent`, hop 3 resolves against A's root ask, `signalAgentOwnedByUser`
  (`:5795-5800`) passes because A owns the agent, and the reply is addressed to **A herself**.

**Claim only this:** B's rule is under-specified exactly where it decides addressing, and neither branch
is safe. The earlier draft asserted the second branch as measured and called the listener loop dead; that
was a naive-wiring risk, not a measurement, and is withdrawn. R2's conclusion does not depend on the
branch — it is enough that a rule presented as harmless normalisation reaches the audience resolver.

Two citation corrections to B: `src/cli.ts:2932` is not a reply write (it is `in_reply_to` inside the
**read** poll of `ask --wait`; the write is `:3119`), and the reply verb prints two different success
sentences for one event — only the plain one at `:3159` names the author; the `--json` twin at `:3144`
does not.

### 1.3 The read view — and the clause that is missing from it

`swarm_read.signals` is a `security_barrier` view owned by `swarm_admin`. **Three migrations define it**
(`20260724000003_signals.sql`, `20260730000002_agent_signal_receive.sql`,
`20260901000010_signal_attachments.sql`); only the newest is live —
**`20260901000010_signal_attachments.sql:81-133`**, `WHERE` at `:122-133`:

```sql
WHERE swarm.is_member(s.workspace_id, auth.uid())
  AND (
    (s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL)
    OR s.to_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM swarm.agent_principals AS principal
      WHERE principal.principal_id = s.to_agent_principal_id
        AND principal.workspace_id = s.workspace_id
        AND principal.owner_user_id = auth.uid()
    )
  );
```

The view is `security_barrier`, **owned by `swarm_admin`** (`:135`); there is **no `security_invoker`
anywhere in the repo** and `swarm.signals` never gets `FORCE ROW LEVEL SECURITY`, so the owner bypasses
the table's RLS and **the view's `WHERE` clause *is* the policy**. The table's one policy grants
everything to the command role and nothing to end users (`20260724000003:32-34`); `authenticated` and
`anon` are revoked on the base table (`:40`) and `anon` on the view (`:137`).

**There is no `from_principal` clause, so the sender of a directed signal cannot re-read it.** The CLI
says so in user-facing text — `src/cloud/signals.ts:1641`: *"This feed shows broadcast signals only. It
omits directed messages, including messages you sent."* — and `P3-1-SIGNALS-BRIEF.md:323-324` chose it
deliberately.

This kills B's §3 premise ("Both halves are already visible to me"). It is half true: the other party's
half is visible, **your own is not**. A DM whose own half you cannot see is not a conversation, so DMs
need a fifth clause (§5) — and B's "no migration" claim does not survive.

### 1.4 The agent read path is separate and does not go through RLS

Agents read the `read` edge function, which is agent-only for signals
(`supabase/functions/read/index.ts:323-326` — 401 for any non-agent credential unless the resource is
`renewal_grants`). Its visibility disjunct is at `:610-613`:

```sql
AND (
  (s."to" IS NULL AND s.to_agent IS NULL)
  OR s.to_agent = ${agent.principal_id}::uuid
)
```

Its request parser uses `exactKeys` (`:222-234`), so a new optional request key must be its **own
`Object.hasOwn` group** — the cursor-pair shape (`:216-221`, `:231`) — and **must NOT join the
`in_reply_to` `modernShape` group** (`:215`, `:230`), because agent bodies always send `in_reply_to`
(`src/cloud/signals.ts:983`). §7.1 has the measurement; it was a live defect here until an arm found it.

**The non-obvious part, and neither draft stated it.** The edge does not bypass the view — it reads
`FROM swarm_read.signals` (`:600`) as role `swarm_read` (`:342`) with `request.jwt.claims.sub` set to
**the agent's OWNER, not the agent** (`:485-494`), then narrows in SQL at `:610-617`. Hence §5:
**clause (e) does not widen what any agent sees** — a row it newly admits is one the owner *sent*, so it
has a recipient and fails both arms of `:611-612`. The agent path also filters expiry itself (`:618`).

**Two enforcement points, two languages, two authors. They must move together or never.**

### 1.5 Delivery fan-out is at most one row per signal

`20260731000001_signal_deliveries.sql:126-137`:

```sql
IF NEW.to_agent_principal_id IS NOT NULL AND NEW.kind IN ('ask', 'note') THEN
  INSERT INTO swarm.signal_deliveries (...) VALUES (...) ON CONFLICT DO NOTHING;
END IF;
```

So: a broadcast creates **zero** delivery rows and wakes nobody; a directed **human** signal creates
none either; `working-on` never delivers. There is no N-way fan-out anywhere in the system.

This is what resolves R1. The strongest case for delivery-scoped channels is agent context budget — but
agents **pull** broadcasts, so an agent's context cost is already governed by what it chooses to read.
The fix is a read filter the **agent** selects (§7.2), not a scope the **poster** picks. The poster is
the least-informed party. B made this argument and it holds.

### 1.6 The `until` trap, and what `#all-signals` really means

`until` is `NOT NULL` **with no database default** (`20260724000003:12`); every value is computed by the
edge (`command/index.ts:5949-5950`, `:5981`) from `SIGNAL_DEFAULT_UNTIL_MS` (`:513-517`). **The view does
not filter on it** — `s.until` is projected and appears in no `WHERE` — so expiry is filtered by each
caller, three different ways:

- CLI: `src/cloud/signals.ts:897-899` sets `until=gt.now`, skipped under `--include-stale`.
- Agent edge: `read/index.ts:618`, `AND (${body.include_stale} = true OR s.until > statement_timestamp())`.
- Browser: `LiveDashboard.astro:1750` uses `.or(\`until.is.null,until.gt.${cutoff}\`)`, plus a
  client-side re-filter at `:3573-3576`.

**If `until` were ever made nullable, a NULL row would vanish from the CLI and the agent edge while still
rendering in the browser**, with no error anywhere. The browser's `until.is.null` arm invites a wrong
conclusion and is **inert against server data** — the schema makes NULL impossible; it exists for the
locally-constructed sample and optimistic rows that set `until: null` (`LiveDashboard.astro:4909, 4921,
4933, 5671, 5733`). **Keep `until NOT NULL`** (R6).

Corollary correcting B: B's own §8.3 rules `#all-signals` means "everything" and its §16 defends it because
changing it "would silently hide signals". It already does — `#all-signals` is *every live signal you may
read*, and never showed expired ones. State it that way.

### 1.7 Old clients are protected by a parser contract, and only that

`src/cloud/signals.ts:315-326`: *"Forward-compatible: unknown top-level fields are ignored so a newer
edge can add columns without killing old clients."* So **adding a column is safe; removing, renaming or
reordering one is a PostgREST 400**, because both installed readers name their columns explicitly
(`src/cloud/signals.ts:891-894`, `LiveDashboard.astro:1748`).

The apply order is written down at `20260902000001_broadcast_recipient_roster.sql:58-64`: push the
migration and **verify via a `schema_migrations` query, not the push output** → deploy the edge functions
→ publish the client → deploy the site. The reason is at `:11-20`: the Supabase CLI applies migration
files **one per transaction**, so the shape file N commits is live for every client until N+1 commits,
and it stays applied if N+1 fails.

### 1.8 The insert names its columns

`supabase/functions/command/index.ts:5966-5983` — `INSERT INTO swarm.signals (id, workspace_id,
from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to, about, kind, body, until,
created_at) VALUES (…)`. Explicit column list, no `channel_id`. This is why §3.2's rule exists.

### 1.9 The protocol core has no signals in it

`grep -rni "signal" src/protocol/` returns 0. Positive control on the same invocation: the same grep over
`src/` finds `post_signal` at `src/cli.ts:2896`, `src/cli.ts:3114`, `src/listener/runtime.ts:773`,
`src/cloud/command-client.ts:136`, `src/cloud/seed.ts:15`. So the tool and the pattern work; the core
genuinely has none.

**Consequence: this feature adds no protocol-core command or event and needs no
`npm run build:command-core`.** All authority work lands in the command edge function beside
`resolveSignalWriteTarget` (`command/index.ts:5740`). Both drafts agree; recorded because
`docs/design/2026-09-03-multi-recipient-signals.md:29-30` claims the opposite and is wrong.

## 2. The model

A signal gains **a channel it is filed in** and **a thread it belongs to**. Nothing else about a signal
changes. Addressing, delivery, wake, immutability, `until`, and `in_reply_to` all keep their exact
current meaning.

```
swarm.channels            one row per named room. No membership. No privacy.
swarm.signals  + channel_id      nullable forever in v1; NULL = unfiled
               + thread_root_id  nullable; NULL = a top-level message
               + broadcast_to_channel  boolean NOT NULL DEFAULT false
```

There is deliberately **no `channel_members` table, no `conversations` table, and no `threads` table.**
Each absence is a ruling (R1, R3, R2), not an omission.

**This is new construction, not a retrofit — enumerated, not pattern-matched.** In `supabase/` the word
`channel` occurs exactly once, in a comment (`read/index.ts:662`): no table, column, view, function or
request field. In `src/` it occurs five times, all prose. `swarm.streams`
(`20260723000001_p1_schema.sql:257-276`) is the event-log partition anchoring `swarm.events` and
`swarm.tasks`; **`swarm.signals` has no `stream_id` and no migration links the two** —
`20260724000003_signals.sql:1` says so on purpose: *"Signals are immutable addressed intent, not stream
events."* The `STREAMS` heading and `#` glyph are decoration over one unpartitioned feed
(`LiveDashboard.astro:248, 257, 344, 2216`) from a note that calls itself *"a direction, not a
specification"* (`docs/design/2026-08-03-SLACK-SHAPE-UI.md:11`).

There is likewise **no URL state to retrofit**: `location.hash`, `URLSearchParams`, `pushState`,
`replaceState`, `location.search` return zero matches across `LiveDashboard.astro` and `site/src/lib/`.
A signal's id reaches the DOM only as `row.dataset.signalId` (`:3649`). §8.1 builds this, not extends it.

## 3. Migration sketch

Three files. Each commits a shape that is safe on its own, because §1.7 says the shape it commits is
live until the next file commits.

### 3.1 File 1 — `swarm.channels`

```sql
CREATE TABLE swarm.channels (
  channel_id   uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  slug         text NOT NULL,                      -- CHECK from the shared constant, §8
  purpose      text CHECK (purpose IS NULL OR char_length(purpose) <= 500),
  created_by_principal uuid NOT NULL,              -- stamped server-side, never client-supplied
  created_by_kind      text NOT NULL CHECK (created_by_kind IN ('user','agent')),
  created_at   timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at  timestamptz
);

CREATE UNIQUE INDEX channels_workspace_slug ON swarm.channels (workspace_id, lower(slug));
-- The tenant-pinning composite key, so signals can carry a composite FK back.
-- House idiom: streams_stream_workspace (20260723000001_p1_schema.sql:275-276),
-- signals_agent_recipient_workspace (20260730000002:36-39).
CREATE UNIQUE INDEX channels_channel_workspace ON swarm.channels (channel_id, workspace_id);
CREATE INDEX channels_live ON swarm.channels (workspace_id, archived_at) WHERE archived_at IS NULL;

ALTER TABLE swarm.channels OWNER TO swarm_admin;
ALTER TABLE swarm.channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.channels
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE swarm.channels FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON swarm.channels TO swarm_command;

CREATE VIEW swarm_read.channels WITH (security_barrier = true) AS
  SELECT c.channel_id, c.workspace_id, c.slug, c.purpose,
         c.created_by_principal, c.created_by_kind, c.created_at, c.archived_at
  FROM swarm.channels AS c
  WHERE swarm.is_member(c.workspace_id, auth.uid());
ALTER VIEW swarm_read.channels OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.channels TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.channels FROM anon;
```

`swarm.is_member` (`20260820000002:4-21`) already excludes archived workspaces. **Every member sees every
channel. That is the ruling, stated in SQL.** Older authority tables get `swarm_command_all` from a `DO`
loop over an `authority_table` array (`20260723000001_p1_schema.sql:502-551`); the loop will not reach a
new table in a new file, so create the policy explicitly.

**Channels are archived, never deleted** — a delete would orphan an immutable label, and the FK in file 2
makes it physically refused, which is the control.

### 3.2 File 2 — `swarm.signals.channel_id`, and the rule that prevents an outage

```sql
ALTER TABLE swarm.signals ADD COLUMN channel_id uuid;   -- nullable. No default. No backfill.

ALTER TABLE swarm.signals
  ADD CONSTRAINT signals_channel_workspace
  FOREIGN KEY (channel_id, workspace_id) REFERENCES swarm.channels (channel_id, workspace_id);

CREATE INDEX signals_channel_newest
  ON swarm.signals (workspace_id, channel_id, created_at DESC, id DESC)
  WHERE channel_id IS NOT NULL;

-- Recreate swarm_read.signals from the LIVE body, adding s.channel_id AT THE END
-- of the select list and changing NOTHING else. Resolve that body with
--   SELECT pg_get_viewdef('swarm_read.signals'::regclass, true);
-- against the target database -- NEVER by copying a migration file. See the
-- chaining rule below; at this point the live body is 20260901000010:81-133.
```

> #### The migration-before-edge window, in both directions
>
> A's first draft ended file 2 with `ALTER COLUMN channel_id SET NOT NULL`. Both of its arms found the
> same thing: that is a **production write outage**. The migration commits before the edge deploys
> (`20260902000001:58-64`); the old edge is still serving in between, and its insert names its columns
> and omits `channel_id` (§1.8). Every post fails with a not-null violation while reads stay healthy —
> the hardest kind of outage to attribute.
>
> **This spec makes it unreachable rather than mitigated.** A fixed it with a `BEFORE INSERT` defaulting
> trigger plus a deferred `SET NOT NULL`; B removed the need for both by never backfilling. B's shape
> wins (R4), and the rule is one sentence: **`channel_id` is nullable for the life of v1 — no
> `SET NOT NULL`, no `DEFAULT`, no backfill, no defaulting trigger, in any phase.** `NULL` means
> *unfiled*, a state readers must handle anyway, so tightening buys nothing and can only re-open the
> outage.
>
> **The reverse direction — edge before migration — is the same outage mirrored.** The new edge names
> `channel_id`; against a database where file 2 has not committed, every post fails with
> `column "channel_id" does not exist`. Two guards, take both: (1) verify the migration applied with a
> `schema_migrations` query, **not** the `db push` output (`20260902000001:58-60` says exactly this) —
> *pushed ≠ landed ≠ applied*; (2) deploy `read` and `command` after that verification and before
> publishing any client that filters on `channel_id`, since a new client against an un-recreated view
> gets a PostgREST **400**, not an empty page.
>
> **The view recreation is protected on shape, not on meaning.** `CREATE OR REPLACE VIEW` cannot rename,
> retype, drop or reorder a column, so "append `channel_id`" is mechanically enforced. The `WHERE` has no
> such protection and **three files define this view** (§1.3), so the control belongs there: run the
> directed-visibility suite before and after and require identical results (§9). §3.3 generalises this
> into the view-chaining rule after an arm found this document violating it.

### 3.3 File 3 — threads (ships with the thread phase, not with channels)

```sql
ALTER TABLE swarm.signals
  ADD COLUMN thread_root_id uuid,
  ADD COLUMN broadcast_to_channel boolean NOT NULL DEFAULT false;

ALTER TABLE swarm.signals
  ADD CONSTRAINT signals_thread_root_workspace
  FOREIGN KEY (thread_root_id, workspace_id) REFERENCES swarm.signals (id, workspace_id);

CREATE INDEX signals_thread_oldest
  ON swarm.signals (workspace_id, thread_root_id, created_at, id)
  WHERE thread_root_id IS NOT NULL;

-- Recreate swarm_read.signals AGAIN. Resolve the body with pg_get_viewdef against
-- the target database, NOT from any migration file -- by now it carries BOTH
-- channel_id (file 2) AND clause (e) (P3). Append thread_root_id and
-- broadcast_to_channel at the end; change nothing else.
```

`broadcast_to_channel NOT NULL DEFAULT false` is safe **because it has a default** — the old edge's
insert omits it and gets `false`. That contrast is exactly what should have caught A's `channel_id`
defect, and it is why it is spelled out here.

> #### The view-chaining rule — this spec's own phase order reverted its RLS
>
> Three migrations already define `swarm_read.signals`, and this plan adds three more edits (file 2, P3's
> clause (e), file 3). A review arm found the consequence: **file 3 as first drafted said to recreate the
> view from `20260901000010:81-133`**, the body live when file 2 was written. By then P3 has added clause
> (e). Recreating from the old file appends the thread columns correctly and **silently deletes clause
> (e)** — every sender loses sight of their own DMs again, with no error and no failed column check,
> because `CREATE OR REPLACE VIEW` protects column shape and not the `WHERE` (§3.2).
>
> **Rule: every view recreation resolves its starting body from the database
> (`pg_get_viewdef('swarm_read.signals'::regclass, true)`), never from a migration file; each edit is a
> diff against what the previous migration actually left.** *Measure the artifact, not its name.* §9
> carries the control, with a failing arm.

**Do not combine file 2 and file 3.** Each takes an `ACCESS EXCLUSIVE` lock on `swarm.signals` and
recreates the view; combining them widens the blast radius of the riskiest step for no benefit before
the thread client exists.

### 3.4 The `until` CHECK is not touched, in any file

An earlier A draft proposed relaxing the 30-day CHECK for channel posts via
`channel_id IS NOT NULL`. Under **A's** model that discriminator was vacuous (everything gets a
channel after the backfill) and would have deleted the 30-day rule for `working-on` and `ask` too. Under
**this** model there is no backfill, so `channel_id IS NOT NULL` is a real discriminator — and it is
still the wrong one, because it discriminates *filed-ness*, not *retention intent*. Durable history is a
real requirement and gets its own phase with a real discriminator (a new `kind`, or an explicit
`retention` column), never `channel_id IS NOT NULL`. When it comes:

- `until` stays `NOT NULL` (§1.6).
- `SIGNAL_MAX_UNTIL_MS` (`command/index.ts:512`, enforced at `:1604-1608`) must gain the matching branch
  in the same phase, or the edge refuses what the constraint allows.
- Resolve the CHECK's generated name from `pg_constraint` before any `DROP` — it is unnamed in the
  source. `20260827000001_expand_signal_body.sql:1-6` is the precedent.

## 4. Direct messages

**A DM is the set of signals between me and one counterparty.** No table, no `dm_key`, no `open_dm`
command, no backfill.

```
DM(me, X) = signals where (from = me AND to = X) OR (from = X AND to = me)
```

`to` is two columns — `to_user_id` (a person) and `to_agent_principal_id` (an agent), mutually exclusive
by `signals_one_recipient`. The rail merges both into one list of counterparties keyed on
`(kind, id)`, the `EntityRef` shape the entity panel already uses (`LiveDashboard.astro:1056`).

**Is a stable URL possible from the existing columns alone? Yes, for 1:1 — which is what "linkable" needs
here.** The conversation URL is `?dm=user:<uuid>` / `?dm=agent:<uuid>`, naming the **counterparty**, so it
is **viewer-relative**: each participant has a different URL for the same conversation. That is honest
rather than defective — only those two principals resolve either form, and RLS gives a third party nothing
whichever they are handed. A **message** permalink inside a DM is globally stable already
(`&m=<signal_id>`, RLS-resolved), so "referenceable" needs no new object.

A conversation row would buy one canonical URL shared by both participants, at the cost of a second
authority that can drift from the signals it summarises. **Not worth it**; if rail rendering is ever
measured slow, the fix is an index or a materialised view. (A loses the narrow question; A's group-DM
reasoning is upheld below.)

**Group DMs are still listed out of v1. Nobody has ruled on why, and the mechanical argument below is
half-retired.**

> **was**, until 2026-09-05: *"Group DMs are out of v1, and not as a scope choice.
> `signals_one_recipient` allows at most one recipient (§1.1), so a 3-party DM's rows cannot set the
> recipient columns at all — they would be undirected rows whose privacy came from nothing, and the
> delivery trigger keys off `to_agent_principal_id` (§1.5), so no agent in a group DM would ever be
> woken. A conversation type that silently fails to notify the agents in it is worse than none.
> Two-party covers the ask completely."*
>
> Two of the three mechanical clauses in that paragraph stopped being true on 2026-09-05. L2's
> `swarm.signal_recipients` stores an ordered set of up to `SIGNAL_RECIPIENT_MAX` recipients and the
> view's predicate admits every one of them, so a three-party address is storable and readable by all
> three. `signals_one_recipient` still exists and is still not relaxed; it now bounds the SCALAR
> columns only.
>
> The THIRD clause is **nearly** true, and THREE earlier versions of this note got it wrong in three
> different ways. It read *"no agent in a group DM would ever be woken."* Exactly, and this is the
> wording that survives review:
>
> **The wake is unchanged.** `swarm.enqueue_signal_delivery()` fires on INSERT into `swarm.signals` and
> reads the SCALAR column, so a signal wakes the recipient at position 0, and only when that recipient
> is an agent and the kind is `ask` or `note`. Nothing reads `swarm.signal_recipients` on the way to
> the delivery ledger. So a three-party address whose position 0 is a PERSON wakes nobody at all, even
> when it names agents at positions 1 and 2; and one whose position 0 is an agent wakes exactly that
> agent. Naming an agent later in the list never notifies it.
>
> The original clause is therefore right about every agent except one, and the conversation-type
> objection it supports still stands. The three retired versions: the first said L2 wakes every agent
> in the set; the second said the clause was false; the third said a three-party conversation
> "notifies its first agent recipient", which is false whenever the first agent is not position 0.
>
> **What is NOT settled: whether v1 should have group DMs.** That is a product decision and nobody has
> made it. This document must not read as if the constraint decides it, because the constraint no longer
> does. Routed to the coordinator with L2, not decided here.

**`working-on` cannot be a DM** — the validator refuses a directed `working-on`
(`command/index.ts:1816-1824`), so the DM view holds only `note` and `ask`. Correct; noted so nobody
treats the absence as a bug. *(**was**, until 2026-09-05: `:1580-1587`. L1 and L2 added ~1000 lines
above that check and `:1580` now lands in `signals_seen`. The behaviour claim is unchanged; only the
pointer moved. Found by a review arm, not by the citation gate, which registers no entry for this line.)*

## 5. RLS, spelled out

**The channel phase changes no visibility rule at all.** Every channel is workspace-visible, so the live
predicate (§1.3) is already correct and the view only gains columns. This is the property that makes
channels safe to ship first, and it should be defended against the temptation to add privacy "while we
are in there".

**The DM phase adds exactly one clause**, and it is the only RLS change in v1:

```sql
WHERE swarm.is_member(s.workspace_id, auth.uid())
  AND (
    (s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL)   -- (a) unchanged: undirected
    OR s.to_user_id = auth.uid()                                  -- (b) unchanged: addressed to me
    OR EXISTS (                                                   -- (c) unchanged: to an agent I own
      SELECT 1 FROM swarm.agent_principals AS principal
      WHERE principal.principal_id = s.to_agent_principal_id
        AND principal.workspace_id = s.workspace_id
        AND principal.owner_user_id = auth.uid()
    )
    -- (e) NEW: I sent it, in person or through an agent I own.
    OR s.from_principal = auth.uid()
    OR EXISTS (
      SELECT 1 FROM swarm.agent_principals AS mine
      WHERE mine.principal_id = s.from_principal
        AND mine.workspace_id = s.workspace_id
        AND mine.owner_user_id = auth.uid()
    )
  );
```

(The letter (d) is skipped, not reused: it was A's channel-membership grant, which R1 deletes. Skipping
keeps the two documents readable side by side.)

**Clause (e) needs an index that does not exist**, and neither draft named it. Every index on
`swarm.signals` is keyed on `workspace_id` plus `to_user_id`, `about`, `in_reply_to` or `created_at`
(`20260724000003:20-27`, `20260730000002:65-67`); nothing indexes `from_principal`, so clause (e) and the
DM query's `from = me` half both filter after a scan. Add:

```sql
CREATE INDEX signals_from_newest ON swarm.signals (workspace_id, from_principal, created_at DESC, id DESC);
```

**Three consequences of clause (e), to accept openly rather than discover:**

1. **The DM phase is not row-set-neutral.** Every directed signal a member ever sent becomes visible to
   them, retroactively, in `cswarm feed` and the browser feed — on old clients that have no idea DMs
   exist. They keep **working**; their feed **grows**. Release notes.
2. **`src/cloud/signals.ts:1641` is already half wrong, and clause (e) breaks the other half.** It reads
   *"This feed shows broadcast signals only. It omits directed messages, including messages you sent."*
   The Grok arm measured that the first half is **already false**: the view admits `to_user_id =
   auth.uid()` (`20260901000010:125`) and `cswarm feed` does not filter it off
   (`src/cloud/signals.ts:891-896`), so directed messages *to you* already appear. Clause (e) falsifies
   the remaining clause, *"including messages you sent"*. Fix the whole sentence in the same release,
   not just the half this spec breaks.
3. **It reverses a recorded decision.** `P3-1-SIGNALS-BRIEF.md:323-326` chose sender-blindness
   deliberately. Argue with it in that file rather than silently editing it.

**The agent path gets no RLS change and is not widened by clause (e).** `read/index.ts:610-613` is
untouched; it gains only the optional `channel` filter of §7.2, outside the scoping disjunct. Clause (e)
does reach the agent path (the edge reads this same view as the agent's owner, §1.4), but every row it
newly admits has a recipient set, so it fails both arms of `:611-612`. **Assert this, do not assume it** —
the §9 control requires an agent read returning zero rows for a signal its owner sent to someone else.

## 6. Phasing

Four phases. Each ships on its own and leaves old clients working.

Ranked on the four criteria the lead set — *ships alone; leaves old clients working; creates the identity
later phases need; how much of the operator's ask it completes*:

| Candidate first slice | Ships alone | Old clients OK | Creates needed identity | Completes the ask |
|---|---|---|---|---|
| **Public channels** | yes | yes — additive nullable column, no backfill, no `NOT NULL`, parser ignores unknown fields (§1.7) | **yes** — `channel_id`, which P2/P3/P4 all link to | the headline ask |
| Colour + click-to-filter (B's S1) | yes | yes — site only | **no** | the smallest of four |

**Channels win 4 criteria to 2.** B's S1 wins only on risk, which the lead did not list. It ships in
parallel — it needs nothing from the migration — but it does not go first.

### P1 — Channels, public only ← ship first

Migration files 1 and 2 (§3.1, §3.2). Commands `channel_create`, `channel_rename`, `channel_archive` in
the command edge. `channel_id` optional on `post_signal`, resolved slug → id **within the route's
workspace**. Channel filter on both read paths. `CHANNELS` replaces `STREAMS (broadcast)` in the rail
(§8). URL grammar `?w=&c=&m=`. Copy rules (§8). Signals wire-compat test, the twin of
`tests/receipt-wire-compat.test.ts`.

**Would P1 leave old clients working?** Yes on every surface — **conditional on §7.1**, which is the
correction a review arm forced. Two of these rows were "yes" for schema reasons while the parser could
still have broken them.

| Surface | OK? | Why |
|---|---|---|
| CLI read | **YES** | Fixed select list (`src/cloud/signals.ts:891-894`); unknown columns ignored by contract (`:315-326`). No RLS clause changed and no row moved, so the row set is byte-identical. |
| Browser read | **YES** | Same, via `LiveDashboard.astro:1748`. |
| Agent read | **YES, only if** `channel` is its **own** `Object.hasOwn` group like the cursor pair (`read/index.ts:216-221`). **NO** if folded into the `in_reply_to` `modernShape` group (`:215`, `:230`) — agent bodies always send `in_reply_to` (`src/cloud/signals.ts:983`), so that fold 400s every agent read. | §1.4, §7.1. |
| CLI / browser / agent write, **schema** | **YES** | The old edge omits `channel_id`; the column is nullable with no default, so the insert succeeds and the signal is unfiled. The composite FK is `MATCH SIMPLE`, so a NULL passes it (both arms confirmed independently). Unfiled signals appear in `#all-signals`, where an old reader is looking. This is the failure mode A's first draft had and this shape cannot reach. |
| CLI / browser / agent write, **parser** | **YES, only if** §7.1's `exactKeys` rule is followed | The schema argument above is necessary and was **not** sufficient. Every shipped client always sends the `modernKeys` pair, so extending that group 400s every post after a perfectly ordered migration. This was a live defect in this document. |
| Post response | **YES** | A new `channel_id` on the returned signal crashes nothing: `parseSignalRecord` validates only known required fields and ignores the rest (`src/cloud/signals.ts:315-326`); the command response's `signal` is a typed field on a cast object (`command-client.ts:52`), not strictly validated; the browser has no `exactKeys` check on responses. |
| `until` | **YES** | Unchanged for every kind, never nullable. |

**Two honest caveats, in the UI and not in a help page.**

1. **A channel is neither private nor an archive.** Every member reads every channel, and messages still
   expire — `note` 30 days, `ask` 7, `working-on` 24 hours (`command/index.ts:513-517`).
2. **No pre-migration signal will ever appear in a named channel** — the price of R4, which a review arm
   was right that the document hid. Nothing is backfilled, so every signal written before file 2 keeps
   `channel_id NULL` permanently and named-channel reads, `?c=` permalinks and the agent `channel=` filter
   never see that history; it lives only in `#all-signals`. This is the one thing A's backfill bought, and
   R4 trades it for never running `DISABLE TRIGGER` on `signals_append_only`. A product gap, not an
   outage, and it shrinks daily — but **on day one the channels are empty** and the operator must expect
   it.

### P2 — Colour and click-to-filter (parallel with P1)

Site only; no migration, no edge, no protocol. Generalise `markAgentAvatar`
(`LiveDashboard.astro:1793-1802`) to `markEntityColour` covering people; swap `unsigned % 360` for
`PALETTE[unsigned % PALETTE.length]`; make the avatar (today `aria-hidden="true"` with no handler,
`:3675-3679`) a real focusable filter control; add the filter bar and `?agent=` / `?person=`; move the
filter server-side.

Two rules from B, kept:

- **Colour is never the only signal.** Name as text at full contrast, `PERSON`/`AGENT` badge, filter state
  announced in words. Strip colour and no information is lost.
- **The filter must be server-side.** The shipped `All / Broadcast / Direct to you` filter is client-side
  over ~25 loaded rows (`site/src/lib/signal-feed.ts:31-41`, applied at `LiveDashboard.astro:3625`), so it
  says "your direct signals" and means "among the last 25 loaded". Do not copy that. Authorization lives
  in the view whatever the client asks, so a client-issued narrowing is structurally safe.

**Sequencing:** P1 and P2 both edit `LiveDashboard.astro`. One lane, or land P1 first — never two agents
at once.

### P3 — Direct messages

Clause (e) and `signals_from_newest` (§5). `DIRECT MESSAGES` rail section from a grouped query over the
existing addressing columns. `?dm=` URL. **No new table, no backfill, no row moves.** The only phase that
changes an RLS predicate — and it needs the before/after visibility-suite control of §9.

> #### P3 BLOCKER: receipts disclose who received a DM
>
> `swarm_read.signal_delivery_receipts` is `SECURITY DEFINER` owned by `swarm_admin`, so it never goes
> through `swarm_read.signals`. Its human branch checks two things — no agent-token digest supplied, and
> `swarm.is_member(...)` (`20260902000001:103-109`). **No per-signal check.** The file states the intent
> at `:68`: *"members read every receipt in their workspace."* So any member holding a signal id reads
> that signal's recipients and their `seen_at`, including a directed signal between two other people.
> Same for `signal_agent_receipts_live_member_select` (`20260902000004:66-70`).
>
> **This pre-exists; P3 does not cause it.** But P3 is what names these rows a **DM**, and a DM whose
> recipient list any colleague can query is not what the word promises. An earlier draft filed this under
> Appendix A as a private-channel concern — the wrong home, since private channels are out of v1 and DMs
> are not.
>
> **Before P3 ships, not after:** add a per-signal arm to the function (caller is author, addressee, or
> owner of an addressee agent), or hold the DM vocabulary until it exists. Shipping the word without the
> fix is the claim-control failure AGENTS.md describes — a privacy claim defended by tests that never ask
> this endpoint.

### P4 — Threads

Migration file 3 (§3.3). `thread_root_id` on `post_signal`, `ask` or `note` (R11), never `working-on`.
Thread drawer, `N replies` affordance, `?t=` URL. **`in_reply_to` behaviour is untouched** (R2).

**Reply expiry: the server clamps, it does not refuse.** B's rule — a reply may not outlive its root — is
right, but taken literally it is unshippable, and this is my own defect rather than an arm's. The per-kind
defaults are `note` 30 days, `ask` 7 days, `working-on` 24 hours (`command/index.ts:513-517`). A `note`
reply to an `ask` root therefore defaults to a horizon past the root's for **every** reply after t=0, so a
literal `reply.until <= root.until` would refuse almost every thread reply. So:

```
untilMs = min(requested_or_default, root.until - statement_timestamp())
```

Refuse **only** when the caller passed an explicit `until_ms` longer than the remaining window — silently
shortening an explicit request is the dishonest branch, and it is the one case where a refusal tells the
truth. The clamp is always satisfiable: `resolveSignalWriteTarget` already requires the reference to
satisfy `until > statement_timestamp()` (`command/index.ts:5783`), so the remaining window is strictly
positive and `CHECK (until > created_at)` (`20260724000003:14`) cannot be violated. But that window can be
milliseconds, so **the composer must show the inherited ceiling and the post response must report the
clamped value** — otherwise a user writes a considered reply into a thread that expires while they read it.

**The opt-in compatibility rule.** `in_reply_to` present and `thread_root_id` absent → today's behaviour
exactly: private, re-addressed to the author. `thread_root_id` present → thread reply, undirected, visible
in the channel. The new field is what opts in, so no installed `cswarm reply` changes meaning.

**Old clients under P4 — the honest position.** `thread_root_id IS NULL OR broadcast_to_channel` is a
**new-client query, not a view predicate**. The view hides thread replies from nobody, and both installed
readers select with no thread condition. So an old CLI and an old browser show every thread reply **inline
in the flat feed**, interleaved by `created_at`. Nothing breaks and nothing is hidden; the feed is just
noisier. Do not "fix" it by putting the filter in the view — that would hide replies from the new client's
thread panel too. **P4's value is only visible after the client ships**, so do not schedule the migration
far ahead of the client work.

## 7. Commands and read filters

No protocol-core change (§1.9). Everything below is command-edge work in
`supabase/functions/command/index.ts`, validated in the same `parseCommand` chain as `post_signal`
(`:1524-1639`) and executed beside `postSignal` (`:5941`).

### 7.1 Write

| Command | Fields | Notes |
|---|---|---|
| `channel_create` | `slug`, `purpose?` | **Any member, and any agent.** A channel grants nothing, so gating it behind a human would force a human into the loop to create a label. Adds one row to `SWARM-CLOUD.md` §2.6 and **no** entry to the §2.3 agent-token denylist — that absence is the clearest evidence the ruling kept channels out of the authority plane. Existing per-credential rate buckets bound abuse. |
| `channel_rename` | `channel_id`, `slug` | Slug is mutable; the URL uses the id, so links do not rot. |
| `channel_archive` | `channel_id` | Sets `archived_at`. Hides from the rail, refuses new posts. Signals still render, permalinks still resolve. Never deletes. |

`post_signal` gains three optional fields — `channel` (slug), `thread_root_id`, `broadcast_to_channel`.

> #### `exactKeys` has TWO patterns, and copying the wrong one 400s every installed writer
>
> A review arm found this as a live write outage in this document. An earlier draft said to add the three
> fields "following the `modernShape` pattern at `:1532-1541`". **Wrong pattern.** `modernKeys` is an
> **all-or-nothing pair**: `modernShape` is true if *either* `to_agent_principal_id` *or* `in_reply_to` is
> present (`:1532-1534`), and `exactKeys` then demands **both** (`:1539-1541`, `:1571-1576`).
>
> Every installed writer always sends that pair, so `modernShape` is always true in production:
> `command-client.ts:983` states it (*"New clients always send both target fields and in_reply_to"*), the
> browser sends both (`commonswarm.ts:2005-2007`), the listener sends both (`runtime.ts:772-780`), and
> agent **reads** always send `in_reply_to` (`src/cloud/signals.ts:983`) — so the trap is in the `read`
> edge too (§1.4).
>
> Adding `channel` to `modernKeys` would require every existing body to send `channel`, and `exactKeys`
> (`:1553-1562`) would return **400 on every post and every agent read** — after a correctly ordered
> migrate-then-deploy, with the schema perfectly healthy. It is the P1 outage this document claims to have
> made unreachable, reintroduced one layer up.
>
> **Correct pattern: the adjacent one** — `until_ms` and `attachments` at `:1535-1538`, each its own
> `Object.hasOwn` group spread in independently (`command-client.ts:992-995` writes the same shape).
> **Rule: every new optional field gets its own `Object.hasOwn` group. Never extend `modernKeys`, never
> widen `modernShape`.**

**The insert list must change too.** `postSignal` names its columns explicitly at `:5966-5983`. Adding a
column to the table does not write it. `channel_id` (and later `thread_root_id`,
`broadcast_to_channel`) must be added to that list, to the `RETURNING` at `:5984-5987`, and to the
`SignalRecord` built at `:6004-6018`, so the post response carries the channel the message landed in.

Slug resolution runs **within the route's workspace**; client-supplied identifiers are never trusted. An
unknown slug is rejected with a message naming the valid slugs, built from the same query the validator
used.

### 7.2 Read

- **Human path** — the view's `WHERE` is authorization; a client-issued `channel_id=eq.<uuid>` is applied
  on top and cannot widen anything.
- **Agent path** — `read/index.ts:579-648` gains an optional `channel` filter beside the existing
  `about` / `kind` / `in_reply_to` / `since`, in the same `(${param} IS NULL OR col = ${param})` shape.
  The scoping disjunct at `:610-613` is **not touched**. This is the feature that answers the agent
  context-budget argument (§1.5): the agent, which knows what it needs, chooses its own filter.

### 7.3 Delivery — unchanged

Channels and threads do not touch `swarm.signal_deliveries` and do not modify
`swarm.enqueue_signal_delivery()`. No new enqueue path, no new wake, no fan-out. That sentence is what
makes the copy in §8 honest, and it is the operational meaning of R1.

## 8. Vocabulary, UI, and copy

**`stream` is the event log and never appears in the UI.** It is normative in `SWARM-CLOUD.md` §2.1 and
on the wire of every command. Do not touch `swarm.streams`, `stream_id`, or `SWARM_*`.

**`channel` is the user-facing room, and it becomes plural.** It is already the code's word: the web app
calls the single room "the channel" in ~157 places. The change is a definite article becoming indefinite.

- `LiveDashboard.astro:248` — `STREAMS (broadcast)` → `CHANNELS`. **The only user-facing use of "stream"
  in the app**, so this one edit ends the collision.
- The definite-article copy must name *which* channel: `:411-412`, `:451`, `:525`, `:540`, `:564`,
  `:4381`, `:4605`.
- **Enumerate the 147 case-insensitive `channel` occurrences before the rename lands.** Neither draft did. A
  grep-and-assume here is the confident-zero failure AGENTS.md warns about.
- In engineering prose, a Supabase Realtime channel is a **"Realtime topic"**.
- **Standing rule:** no identifier named `channel*` may be added to `src/protocol/`, `swarm.events`, or
  `swarm.streams`. Channels live on the signal plane only.

**Composer: you post to the channel you are reading** (R10). In `#mobile` the post is stamped `#mobile`;
in `#all-signals` it is unfiled. Zero chrome — the 2026-09-04 operator direction
(`LiveDashboard.astro:657-660`, duplicated at `:2181-2183`; **both copies move together**) deleted the TO
row from an 80px bar, and the same reasoning deletes a channel dropdown. **No `#` parsing of the body,
ever:** bodies legitimately contain `#` (markdown headings render in messages; `#1804`-style refs are
routine in this workspace's own prose), so a parser cannot discriminate.

### 8.1 Linkable and referenceable

| Thing | URL |
|---|---|
| Workspace | `https://commonswarm.com/app?w=<workspace_id>` |
| Channel | `…?w=<workspace_id>&c=<channel_id>` |
| DM | `…?w=<workspace_id>&dm=user:<uuid>` or `&dm=agent:<uuid>` — viewer-relative (§4) |
| Message | `…&c=<channel_id>&m=<signal_id>` |
| Thread | `…&c=<channel_id>&t=<thread_root_id>` |
| Entity filter | `…&agent=<principal_id>` / `&person=<user_id>` |

1. **Ids, not slugs, in the canonical link** — `slug` is mutable and a link must not rot on rename;
   `#slug` is a typing affordance that resolves to an id.
2. **A link is an address, not a grant.** Resolution runs the same RLS predicate as any read (§5), so a
   pasted DM link gives away a UUID and nothing else. Show an honest "no access", or a 404 that hides
   existence — pick one and apply it everywhere.
3. **`about` is not overloaded for this** — it is free-text reference with its own index and meaning
   (`signals_about_newest`, `20260724000003:25-27`). A message reference is a URL.
4. **Every filter state round-trips**, and a bad id shows an honest empty state — **never a silent fall
   back to the unfiltered feed**, which shows strictly more than the link asked for.
5. **CLI referencing reuses the same ids** (`cswarm feed --channel`, `cswarm thread <id>`); copy the
   name-or-uuid resolver for `--to` (`src/cloud/signals.ts:1238-1254`, errors `:1270-1281`).

**Copy rules.** A channel guarantees nothing about who reads it, so no channel surface may say or imply
otherwise. **Forbidden:** *private*, *members of this channel*, *invite*, *join this channel*, *leave this
channel*, *only #x sees this*, *N people in this channel*. **Required once, where a user meets channels
first** (create form and channel header):

> Channels group signals so they are easier to read. Everyone in the workspace can read every channel.
> Messages still expire.

The second sentence is this document's addition to B's rule: B forbade the privacy claim and left the
permanence claim unchallenged, and R6 says both are wrong.

**Constants that user-facing text must be generated from**, per AGENTS.md — none may be typed twice:
`CHANNEL_SLUG_RE` + `CHANNEL_SLUG_RULE_TEXT`, `RESERVED_CHANNEL_SLUGS` (containing `all-signals`),
`ENTITY_COLOUR_PALETTE`, `CHANNEL_PURPOSE_MAX`, and the signal-kind set — which today has **seven
un-synced copies**: `src/cli.ts:2411-2412`, `src/cloud/signals.ts:31`,
`src/cloud/command-client.ts:133`, `read/index.ts:19`, `command/index.ts:1542`, `command/index.ts:176`
(`type SignalKind`), and the table CHECK itself at `20260724000003_signals.sql:10`. An earlier draft of
this document said **five** and named the first five — a typed enumeration inside a section about typed
enumerations, which is exactly the failure it describes; the Grok arm supplied the two it missed. This
predates the spec and is where any new kind will land and lie. Small, self-contained, worth doing in P1.

## 9. Controls

Every test must name the gate it lands in. `npm test` is a **literal list of files**; `tests/p1-cli/**`
and `tests/p1-server/**` are globs; a new file in `tests/support/` runs in nothing.

| Claim | Test | Control that would catch the failure |
|---|---|---|
| **The view rewrite preserved authorization** — the highest-risk step in the plan | Run the full existing directed-visibility suite **after** each view recreation | The same suite before the migration must pass **identically**. Any diff means the `WHERE` was not copied. `CREATE OR REPLACE VIEW` protects column shape but not the predicate (§3.2). |
| A channel never narrows read visibility | A posts a broadcast in `#mobile`; C (unrelated member) reads `#mobile` and sees it | A posts a **direct** signal A→B in `#mobile`; C must not see it. The pair discriminates: C seeing both means the filter replaced the predicate; C seeing neither means the channel became an ACL. |
| Channels do not wake agents | Post into `#mobile`; assert zero new `swarm.signal_deliveries` rows | Post a direct `note` to an agent; assert exactly one row. Without it the test passes on a dead connection. |
| Cross-tenant channel isolation | Resolve slug `mobile` while routed to workspace B where it exists only in A → rejected | Resolve `mobile` in workspace A → accepted. Proves the rejection was tenancy, not a broken resolver. |
| `channel_id` is immutable | `UPDATE swarm.signals SET channel_id = …` refused | An `INSERT` in the same transaction succeeds, proving grants were fine and `signals_append_only` is what fired. |
| **`in_reply_to` behaviour is unchanged by threads** | An old-shape reply (`in_reply_to` set, `thread_root_id` absent) still lands directed to the referenced signal's author | A thread reply (`thread_root_id` set, `in_reply_to` absent) lands **undirected**. Both assertions on the stored row's `to_user_id`/`to_agent_principal_id`, so a resolver that ignores one of the two fields fails one of them. |
| **Old clients keep posting through the channel migration (schema)** | Replay the pre-deploy edge's exact insert column list against the post-migration schema; it must succeed and yield `channel_id IS NULL` | The same insert against a schema where `channel_id` was made `NOT NULL` must fail. Without the negative arm this cannot distinguish a safe migration from a lucky one. |
| **Old clients keep posting through the channel migration (parser)** | Send the exact body an installed client sends — `to_user_id`, `to_agent_principal_id`, `in_reply_to` all present, **no** `channel` — to the new `post_signal` validator; it must be accepted | Send the same body plus `channel`; also accepted. Both must pass, which is what proves `channel` is an independent `Object.hasOwn` group and not part of `modernKeys`. Run the twin against the `read` edge with an agent body that always carries `in_reply_to`. This is the arm-found outage of §7.1. |
| **A view recreation never reverts an earlier phase's `WHERE`** | After file 3, assert clause (e) is present in `pg_get_viewdef('swarm_read.signals'::regclass, true)` **and** re-run P3's sender-visibility test | Run the same assertion after file 2, where clause (e) does not yet exist, and require it to fail. Without that arm the test passes against a view that never had clause (e) at all. |
| **Receipts do not disclose a DM's recipients** (P3 blocker, §6 P3) | A member who is neither author nor addressee calls `swarm_read.signal_delivery_receipts` with a directed signal's id and gets nothing | The author of that signal calls it and gets the receipts. Without the positive arm the test passes on a function that refuses everyone. **This test fails today** — that is the point of listing it. |
| Clause (e) grants sender visibility and nothing more | The sender reads back their own directed signal | Two negative arms, both required: a third member gets zero rows for it, **and** an agent reading the `read` edge gets zero rows for a signal its own owner sent to someone else (§1.4). Without the third-member arm the test passes on a view with no predicate at all; without the agent arm it cannot see a widening of the agent path. |
| Reply may not outlive its root | A reply with `until` past the root's is refused | A reply with an earlier `until` is accepted. |
| Reply counts do not leak | A thread with directed replies shows a count matching what the **viewer** may read | The addressee sees the higher count. |
| `N replies` is one query per page | Assert the **query count**, not the result | A correct count computed by 200 queries is the failure this catches. |
| Colour determinism | A fixed uuid maps to a fixed palette index (golden vector) | A different uuid maps to a different index — otherwise it passes against a constant-returning function. |
| Palette contrast | Every entry ≥ 3:1 against both theme backgrounds, computed | Inject a low-contrast entry; the check must fail. |
| Colour is never the only signal | Render with colour stripped; every row still carries the name as text and the `PERSON`/`AGENT` badge | Delete the name from the row template; the test must fail. |
| Both click targets survive | Avatar filters and does not open the panel; name opens the panel and does not filter | Assert both directions — one alone passes with the handler on the wrong element. |
| URL round-trip | Every filter state serialises and restores | An unparseable id shows an honest empty state and **does not** fall back to the unfiltered feed. |
| Generated enumerations | The bad-slug message contains exactly `CHANNEL_SLUG_RULE_TEXT`; the reserved message contains exactly `RESERVED_CHANNEL_SLUGS` | Add a member to the constant without touching any string; the test must fail. Measured to be needed four times in one release cycle. |
| Forbidden copy | No channel surface contains *private*, *members of this channel*, *invite*, *join*, *leave*, or an audience count | Add one of those words to a fixture; the test must fail. |
| Vocabulary | No user-facing string in `site/` uses "stream" in the room sense | The same scan finds `stream_id` in `src/` and passes, proving the scan searched the right thing. |

**Live listener control.** THE EXEMPTION IS VOID as of 2026-09-05: L2's claim response gained
`oldest_pending_at`, which is a new READ of `swarm.signal_deliveries` on the claim path. Every later
slice owes whatever the standing rule asks of a lane that touches delivery.

> **was**, for a few hours on 2026-09-05: this paragraph also said *"L2 touches `signal_deliveries`
> from two directions. A trigger on `swarm.signal_recipients` writes rows to it."* That trigger existed
> and was removed the same day; see §10. Nothing L2 landed WRITES to the delivery ledger. Kept because
> a reader who met that sentence needs to know it is retired, and because §10 and this section
> disagreed for those hours -- a review arm found the disagreement, not the citation gate.

> **was**, until 2026-09-05: *"Nothing here changes what a listener reports — delivery is untouched
> (§7.3) — so a live listener check is not owed. If any slice begins to touch `signal_deliveries`, that
> exemption is void: start one with `--state-dir <temp>` and paste its status JSON."* The condition the
> sentence named has now happened, which is why the wording is kept: it is the clause that voids itself.

What L2 established instead of a live listener run, stated exactly: no file under `src/` changed in that
lane, so the listener binary is byte-identical to the one v0.1.54 shipped and what it renders cannot have
moved; and `tests/delivery-client.test.ts` feeds the new response shape through the REAL client parser and
shows both new fields reach nothing, with a control that a broken required marker still refuses. What it
did NOT establish: a running listener against the new edge. The edge is not deployed.

## 10. Out of v1

- **Private channels and `channel_members`.** R1. Appendix A holds the design for the day it is asked for.
- **Group DMs.** §4. *(**was**, until 2026-09-05: "a hard constraint (`signals_one_recipient`), not a
  scope choice." L2 made a three-party address storable and readable, so that constraint no longer
  decides it. It is NOT deliverable to a later agent recipient, so the notification argument in §4
  still stands. Nobody has ruled; §4 carries the full correction, including a middle version of this
  note that said "deliverable" and was wrong.)*
- **Editing and deleting messages.** Structurally blocked by `signals_append_only`
  (`20260724000003:36-38`), and immutability is a published promise
  (`site/src/components/landing/ConsumerStory.astro:38`, `site/src/pages/privacy.astro:120-121`).
  Retiring it is a separate operator decision.
- **Waking agents on a channel post.** Still out, and it would still be the first N-way fan-out in the
  system. L2 addresses N recipients and wakes nobody it did not already wake: the trigger reads the
  scalar column, so a signal wakes position 0 and only when position 0 is an agent taking `ask` or
  `note`.

  > **CORRECTED twice on 2026-09-05, and the middle version was wrong.** For part of that day this
  > bullet said *"L2 is that first fan-out: `swarm.signal_recipients` enqueues one delivery row per
  > agent recipient."* L2 did carry that trigger, and a review arm showed the rows it wrote could not
  > be delivered: `hydrateDeliveryRefs` filters on `swarm.signals.to_agent_principal_id`, which holds
  > recipient 0, so a row for recipient 1 leases, fails to hydrate, answers 403 and commits, burning
  > an attempt each time until the row terminalizes; and `src/cloud/delivery.ts:423` makes an installed
  > listener refuse a delivery whose `signal.to_agent` is not its own principal. The trigger was
  > removed. Section 4 of `20260905000010_signal_recipients.sql` carries the whole reason, and two
  > tests pin the absence so the next author meets it.

- **Waking recipients 1..N of a multi-recipient signal.** New, and out of v1 for a measured reason
  rather than a scope choice. Two things have to move together: the claim path taught the recipient
  set, and a client that accepts a delivery whose signal's scalar `to_agent` is another recipient. The
  second is a wire-semantics ruling nobody has made -- `to_agent` on a hydrated delivery would have to
  mean "this delivery's recipient" rather than "the signal's scalar recipient". Until then a later
  recipient reads the message and replies to it in their own time.

- **Waking thread participants.** Same reason, smaller N. The natural first extension after v1.
- **Durable channel history / retention.** §3.4 — its own phase, with a real discriminator.
- **Per-channel unread counts, badges, mute/hide.** The expensive read, not the filter. The dashboard
  already hedges its counts as "loaded" (`LiveDashboard.astro:3634`) because a server-wide total is not
  cheap.
- **Reactions, search, multi-workspace/shared channels, guest access.** Each a separate feature. Every FK
  above is tenant-pinned on `workspace_id`; cross-tenant is a different product.
- **A Realtime topic per channel.** `docs/research/2026-09-01-streaming-into-the-web-ui.md:50` records
  ~2 frames/second per topic with **silent loss above it and `send()` returning `"ok"` for every dropped
  frame**; `:196` records that it was **not** established whether that ceiling is per-topic, per-client,
  or a project-wide quota.

  > **Citation caveat — resolve against `6e43370`, not this document's base SHA.** That file **is not on
  > `origin/main`** at `d57d480` (`docs/research/` there holds only `ACP-AND-BUZZ.md`,
  > `AGENT-ORCHESTRATION-UX.md`, `screenshots/`). It is on the shared checkout's local `main` and on
  > `6e43370`. Draft B cited it with no caveat; a reader grepping `origin/main` gets a confident zero.

  Nothing here depends on Realtime — the feed polls (`LiveDashboard.astro:4220`, `armLiveFeed`). Measure
  the project quota before anyone adds a topic per channel.
- **Multi-recipient signals.** IN v1, built as lane L2 `chat-recipients` (migration
  `20260905000010_signal_recipients.sql`). A side table holds the ordered recipient set;
  `signals_one_recipient` is NOT relaxed and the scalar columns keep the FIRST recipient, so an
  installed reader is incomplete rather than wrong. The cap is `SIGNAL_RECIPIENT_MAX = 8`.

  > **was**, until 2026-09-05: *"Still deferred per `docs/design/2026-09-03-multi-recipient-signals.md`.
  > Channels and threads make it less pressing, because 'both answers under one question' is what a
  > thread is for."* The coordinator un-deferred it on 2026-09-05 because it blocks BOTH D2's mention
  > chips and the operator's To: field, which the build plan records. The sentence is kept because a
  > reader may still meet it, and because `2026-09-03-multi-recipient-signals.md` itself is still
  > written as a deferred proposal.

## 11. The claim family

Statements this work makes false or misleading. **ALREADY-FALSE** items are wrong today, independent of
this work — fix them separately so this spec is not blamed for them.

**Published privacy posture (highest stakes).** `privacy.astro` **contradicts itself and both halves are
ALREADY-FALSE, in opposite directions**: `:176` (*"no private area … and no per-record permission"*)
denies a per-record permission live since 2026-07-30 (`20260901000010:122-133`) — it errs safe, so not a
disclosure incident, but a later reader will cite it as proof no per-record scoping exists when there are
two; `:121` (*"visible only to that person and to its sender"*) promises the sender a visibility they do
not have (§1.3). Fix as one edit, and note P3 *changes* `:121`'s behaviour rather than describing it.
`:120`'s stored-field list omits `in_reply_to` and would omit `channel_id`/`thread_root_id`.
`SECURITY.md:43-45` (*"addressed to one person are the only exception"*) is **ALREADY-FALSE** — agent
addressing is a second; it survives R1 and breaks on DMs at P3. `ConsumerStory.astro:14` and observer
`consumer-copy.observer.mjs:56` carry workspace-wide claims — **verify liveness first**: `Demo`,
`FeedPanel`, `Verbs` and `Start` are imported by no page (`index.astro` pulls only
`ConsumerHero`/`ConsumerStory`), and fixing dead code is not fixing live copy (memory: "Placeholder
spread across files").

> **was**, until 2026-09-05: this list also named `landing/Hero.astro:190`, and the liveness list also
> named `Hero` and `Invite`. `03960bc` deleted both files for the reason given above; the pointer is
> retired rather than retargeted because there is nothing left to point at.

**CLI strings.** `src/cloud/signals.ts:1641` (**must change with clause (e)**; already half false, §5);
`src/cli.ts:3212`, `:3216-3218` (`describeAudience`, a single scalar), `:3077-3081` (reply-refusal hint —
uses "channel" for the workspace stream, colliding with the new noun), `:2886`, `:504-505`, `:3293`,
`:2986`, `:3666`; `src/cloud/signals.ts:1252` and `:1281` (identical string, two sites), `:1248`. Also
`src/cli.ts:3144` vs `:3159` — two different success sentences for one event, and only `:3159` says the
reply is addressed to the author; pre-existing, but load-bearing once a thread reply is *not*.

**Tests pinning those strings — green controls defending claims.** Revisit deliberately, never "fix until
green". ⛔ **Two are hard blockers**: `composer.observer.test.ts:35`
(`assert.doesNotMatch(markup, /emoji|reaction|thread/i)` — an explicit negative gate on **"thread"**, so
P4 cannot ship without it) and `tests/p1-cli/f6-workspace-vocabulary.test.ts:12`, `:52-57` (enforces
"workspace" as the settled noun — read before choosing terminology, §8). Then
`signals.test.ts:870`, `:891-893`, `:894-897` (the last is a **negative** assertion that a directed signal
must not name workspace visibility, which a DM legitimately must);
`slack-shape.observer.test.ts:151,153,229-230` (literal `"STREAMS"` and `"# all-signals"`);
`ui-addressing.observer.test.ts:48-62` (three states *and* the ternary's source order);
`composer-sprint.observer.test.ts:493`; `composer-addressing.observer.test.ts:319`;
`reply-refusal-hint.test.ts:16`.

**SQL comments and docs.** `20260724000003_signals.sql:1`; `20260730000002:2`, `:69-70`, `:71-72`
("one-hop" — R2 keeps this **true**, which is the point); `20260902000001:1-4`, whose honesty argument
assumes the **workspace roster is the correct denominator** — R1 keeps that true and any future private
channel inverts it; `P3-1-SIGNALS-BRIEF.md:65-70,77,79`, `:173,179`, `:323-326` (the premise P3
overturns); `2026-09-03-multi-recipient-signals.md:29-30` (**wrong today**, §1.9 — though its error is
about the protocol core, not about channels); `2026-08-03-SLACK-SHAPE-UI.md` open questions 1 and 2, both
answered here (§1.3 clause (c); R12); `README.md:214-216`, `:58-60`, `:38,44,53`; `AGENTS.md:112`
(**ALREADY-FALSE, verified**: it says `check:edge` names "three entrypoints"; `package.json:19` names
**four** — `command`, `read`, `capability`, `activity`).

**Web UI copy.** `LiveDashboard.astro:248,257,344,2216` (the hardcoded single stream); `:240-242`;
`:575-577` and `:5858` (the filter and its typed enumeration); `:3634`; `:3719-3725`; `:8-12`;
`mention-address.ts:2-3`; `commonswarm.ts:1292-1295`, `:1971`, `:1551`, `:1561` ("Broadcast — nobody was
addressed or woken", which **stays true in v1** per §7.3); `app.astro:11`; `acceptable-use.astro:124`.

## 12. Decisions the operator owed — all three ruled on 2026-09-05

**Section status: closed.** The lead ruled all three on 2026-09-05. Each item below keeps its original
question and reasoning under a `was:` note, because a reader who met the earlier wording needs to see
what changed rather than a section that never had an open question in it. The build plan is
`docs/design/2026-09-05-chat-build-plan.md`.

### D1 — ADOPTED: no private channels in v1

Confirms R1. No `channel_members`, no membership clause in `swarm_read.signals`, and no channel surface
may say or imply privacy (§8 forbidden copy). Appendix A stays a brief for a day that has not come.

> **was:** *"Should channels ever be private? 'Behave and work like Slack' implies it; the request never
> says it, and privacy is the expensive part. Ruled no for v1, with the brief in Appendix A. B→A is a
> reversible narrowing; A→B is a disclosure event that cannot be undone. Leave it out until asked."*
> The document had already ruled this; D1 is the operator-level confirmation it was waiting for.

### D2 — ADOPTED: `@name` in a body is a mention, not a DM

A mention adds that person to the **To:** set of the message being written. It does not open a DM and it
does not produce a separate message. A message with a mention stays readable by everyone who could read
it without the mention.

> **was:** *"Is an `@tag` a DM or a mention? Today it is a DM that reads as a mention: the composer posts
> one direct signal per tag (`mention-address.ts:1-3`; `MENTION_MAX_RECIPIENTS = 8` at `:30`), and a
> direct signal is read-scoped — so `@mercury look at this` produces a signal nobody else can read.
> `2026-08-04-COMPOSER-AND-MENTIONS.md:66-67` named this exact outcome as the thing to avoid: 'Get this
> backwards and a mention becomes a DM that looks public.' Decide before P1 ships. Keep the behaviour,
> badge the row, revisit with multi-recipient."* The recommendation to keep the behaviour was **not**
> adopted; D2 reverses it.

⛔ **D2 is not shippable as written until one of two things happens, and the constraint is measured, not
guessed.** `signals_one_recipient` (`20260730000002_agent_signal_receive.sql:25-27`) allows **at most
one** recipient per signal, so a To: set of two or more principals has nowhere to be stored. The
composer's present workaround — one directed signal per tag — is precisely what D2 forbids, because each
of those signals is read-scoped to its single recipient. So the composer lane must either:

- **(a)** address a single mention as the message's one recipient and refuse the second mention with a
  message that says the limit and why, or
- **(b)** wait for multi-recipient signals (`docs/design/2026-09-03-multi-recipient-signals.md`, still
  deferred per §10).

This is a client change, not a schema one. It does not block P1's migration or edge work.

### D3 — ADOPTED: a channel is the address of a signal, not a scope on delivery

Confirms R1 and §7.3. `channel_id` is an immutable label stamped at post time. It never appears in an
authorization predicate, and no phase of v1 touches `swarm.signal_deliveries` or
`swarm.enqueue_signal_delivery()`. A channel post creates zero delivery rows and wakes nobody, exactly as
a broadcast does today.

> **was:** *"Are channels compatible with 'THE ADDRESS IS THE MESSAGE'? That direction is dated
> 2026-09-04, the same day as this request (`LiveDashboard.astro:657-660`), and channels reintroduce a
> place-to-post concept. §8 answers with zero chrome, but reading a channel as where and an `@`-tag as
> who is this document's, not the operator's."* D3 settles it: the reading is now the operator's. It also
> makes §9's delivery-neutrality control load-bearing rather than defensive — that test is what keeps D3
> true.

### The original section, for reference


1. **Should channels ever be private?** "Behave and work like Slack" implies it; the request never says
   it, and privacy is the expensive part. Ruled **no** for v1, with the brief in Appendix A. B→A is a
   reversible narrowing; A→B is a disclosure event that cannot be undone. *Leave it out until asked.*
2. **Is an `@tag` a DM or a mention?** Today it is a DM that reads as a mention: the composer posts one
   **direct** signal per tag (`mention-address.ts:1-3`; `MENTION_MAX_RECIPIENTS = 8` at `:30`), and a
   direct signal is read-scoped — so `@mercury look at this` produces a signal **nobody else can read**.
   `2026-08-04-COMPOSER-AND-MENTIONS.md:66-67` named this exact outcome as the thing to avoid: *"Get this
   backwards and a mention becomes a DM that looks public."* Channels sharpen it: a user reading `#mobile`
   who types `@mercury` will believe the message is in `#mobile`. **Decide before P1 ships.** *Keep the
   behaviour, badge the row, revisit with multi-recipient.*
3. **Are channels compatible with "THE ADDRESS IS THE MESSAGE"?** That direction is dated **2026-09-04**,
   the same day as this request (`LiveDashboard.astro:657-660`), and channels reintroduce a place-to-post
   concept. §8 answers with zero chrome, but reading a channel as *where* and an `@`-tag as *who* is this
   document's, not the operator's.

## 13. What this document does NOT establish

1. **Nothing here was executed** — no migration applied, no query run, no page rendered, no test run.
   Every claim is read from source at `d57d480`; where a line is cited, the line was read.
2. **Live production schema.** Read from migration files, not from `ukezjcnxjvkpkeezxaew`.
   *Applied ≠ landed.* Confirm the live `swarm_read.signals` body matches `20260901000010:81-133` before
   building on it — three files define it and only the newest is real.
3. **No performance was measured** — no row counts, no `EXPLAIN`, no latency. `signals_channel_newest`
   and `signals_from_newest` come from the shape of the existing queries, not a plan, and clause (e)'s
   cost on production data is unknown.
4. **The size of the P3 feed growth is unmeasured** (§5); it needs a `db:reset` + real data.
5. **The 147 case-insensitive `channel` occurrences in `LiveDashboard.astro` were not enumerated** (§8). Spot evidence
   supports the singular-room reading; enumerate before the rename lands.
6. **Realtime is unexamined**, and its supporting file is not on `origin/main` (§10 caveat).
7. **The privacy-page contradiction (§11) was found by reading, not by fetching the live site.** Filed as
   a defect, not verified as production state.
8. **The scope ruling was not tested against a real multi-channel workload,** because none exists. R1
   argues from the repo's own decisions and enforcement points, not from observed use. If agent context
   cost is measured to be the real pain, the answer is the agent-side read filter (§7.2); if that is
   measured insufficient, private channels return with Appendix A as the brief.

## Appendix A — the private-channel brief (NOT v1)

If R1 is ever reversed, **draft A already designed this in full and its two arms hardened it**: read
`git show spec/streams-dms-threads:docs/design/2026-09-04-streams-dms-threads.md` (its own §4.1, §5 and
§6 — not this document's) rather than re-deriving it. The four traps its arms found, so nobody rediscovers them the expensive way: the
membership clause needs an undirected guard or joining a channel reads every directed signal in it; the
addressed-to-me clauses have no roster test, which must be fixed at post time and never by widening the
predicate; a `dm_key` needs enforced sort order, a cardinality CHECK, and a *deferred* constraint trigger;
and `leave_channel` must refuse a DM. Add to those: four enforcement points move together
(`command/index.ts:5684-5828`, `20260731000001:126-137`, `read/index.ts:610-613`,
`20260901000010:122-133`), the visibility clause ships in the same file that first allows a non-public
channel, `channel_members` must be backfilled for any channel that becomes private, membership-versus-
history has no good answer, and multi-recipient signals must be un-deferred first.

The receipts leak that used to live here has moved to §6 P3 — it is a v1 blocker, not a private-channel
concern (M2).

## Review record

Two adversarial arms per D-036, both cross-family, neither the author's family (Claude). Each had shell
access and was asked to check every citation, find the migration/RLS case that breaks, and answer "would
the first slice leave old clients working?".

| Arm | Family | Verdict | Raw output |
|---|---|---|---|
| 1 | Grok (`grok -p`) | **FAIL** | `docs/evidence/2026-09-04-chat-reconciled-review/ARM-GROK.txt` |
| 2 | Gemini (`agy --model gemini-3.1-pro-high`) | **FAIL** | `docs/evidence/2026-09-04-chat-reconciled-review/ARM-GEMINI.txt` |

Both verdicts were FAIL on the reviewed draft and both were right. The defects are kept above as worked
examples rather than quietly removed.

### Accepted — Grok (G) and Gemini (M)

**G1. §7.1 named a parser pattern that would 400 every installed writer.** `modernKeys` is an
all-or-nothing pair and every shipped client always sends it, so folding `channel` into it returns 400 on
every post — and on every agent read, because §1.4 pushed the same wrong pattern there. A P1 write outage
one layer above the schema outage this document already guarded. Fixed in §7.1, §1.4, and two §9 controls.

**G2. R2's worked example asserted an outcome that is not measured.** B's rule never says whether it
coalesces the stored value or the lookup key; only the second reading kills the conversation. §1.2 now
gives both branches, claims only that the rule is under-specified where it decides addressing, and
withdraws "the listener loop dies".

**G3. The R4 product gap was hidden.** No backfill means no pre-migration signal ever appears in a named
channel. Now the second honest caveat in §6 P1, and noted in R4.

**G4. Citations and one enumeration**, all re-verified before folding: delivery `IF` at `:126-137`;
read-edge disjunct at `:610-613`; `runtime.ts:772-780`; `mention-address.ts:1-3` with the constant at
`:30`; base SHA `d57d480` is no longer `origin/main` (now `6465afa`); 147 case-insensitive `channel` hits,
not ~157; and the kind-set list said **five** typed copies where there are **seven** — a typed enumeration
inside the section arguing against typed enumerations.

**G5. `signals.ts:1641` is already half false** — directed messages *to* you already appear in `feed`;
only "messages you sent" is the half clause (e) breaks. §5 now says both.

**M1. This document's own phase order silently reverted its only RLS change.** File 3 said to recreate
`swarm_read.signals` from `20260901000010:81-133`, but P3 adds clause (e) to that view first, and
`CREATE OR REPLACE VIEW` protects column shape and not the `WHERE`. §3.3 now carries the view-chaining
rule — resolve every starting body with `pg_get_viewdef` against the database, never from a migration
file — with a §9 control that has a failing arm.

**M2. Delivery receipts disclose who received a DM, and it was filed in the wrong place.** Verified: the
human branch checks only `is_member`, with no per-signal test (`20260902000001:103-109`), and the file
states that intent at `:68`. It pre-exists and P3 does not cause it — but P3 is what makes these rows a
**DM**, so the promise breaks then, not at private channels. Moved out of Appendix A into a **P3 blocker**
with a control that fails today.

### Rejected, with the measurement

Nothing was rejected outright. The arms' one apparent disagreement — Grok calling the receipt leak
pre-existing and already recorded, Gemini calling it a live disclosure bug — is recorded as **both**: the
code is unchanged by this work, and the product claim it contradicts is new at P3. Grok's "Appendix A
already records it" was true of the reviewed draft, which is why the placement, not the finding, was the
defect.

### Process facts, because they bound what these verdicts are worth

- **The first arm pair reviewed a moving file** — I was still compressing while they read. Both were
  killed and rerun against a frozen file (md5 `2577df39c581e528f672adba4c506687`, commit `b2ef0d7`).
  Aborted transcript kept as `ARM-GROK-aborted-stale-file.txt`.
- **Gemini's first rerun reviewed the wrong document.** It resolved `./REVIEW.md` to an unrelated lane's
  file (`docs/evidence/2026-09-04-mobile-arms/REVIEW.md`) and returned a confident `VERDICT: FAIL` about
  `lane/mobile-fix`. A verdict-shaped reply about the wrong artifact is not a review. Kept as
  `ARM-GEMINI-wrong-file-run.txt`; the prompt was rewritten with absolute paths and a required quote-back
  of the target's first heading. **If an arm cannot name what it reviewed, discard the verdict.**
- **The host was at `kern.memorystatus_vm_pressure_level = 2`** with 3867M/5120M swap used. Both wrapper
  shells were killed (exit 144) while the arm processes survived and kept writing; waiting on the output
  files rather than the wrappers recovered both runs.
- **A mechanical citation resolver** written by an arm resolved **99 of 100** citations. The one miss is
  `docs/research/2026-09-01-streaming-into-the-web-ui.md:50`, which §10 already flags as absent from
  `origin/main` — confirming the caveat rather than finding a defect.

### Not re-run after the fixes

The fixes above changed this document and **no code**; this is a design-only lane that ships no
SHA-changing product change, so D-036's re-run rule does not bite. Draft A recorded the same reasoning.
**Anyone turning this spec into migrations owes two fresh arms on that implementation**, and should treat
G1, M1, M2 and draft A's D1-D9 as the regression list to probe first — G1 and M1 in particular are both
"the schema is fine and the feature is still broken" defects, which is the shape this family of change
keeps producing.
