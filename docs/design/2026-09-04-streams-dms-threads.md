# Streams, direct messages, and threads

Design only. **No code was written for this document and none should be until the lead approves the
phasing.** Written against `e3df06b` (`origin/main`, 2026-09-04). Operator request of 2026-09-04,
signal `af48eca6`: multiple channels, direct messages, threaded replies, all linkable and
referenceable, "basically behave and work like Slack".

Every citation below was resolved in the tree at `e3df06b`. Where a claim in an existing document
turned out to be false, this file says so and cites the measurement rather than repeating it.

---

## 0. The short version

| Ask | Exists today? | What it really needs |
|---|---|---|
| Multiple channels | No. One hardcoded `#all-signals` label over an unpartitioned table. | A `channel_id` on the signal, a channel table, a default channel backfill. |
| Direct messages | **Partly.** A directed signal already reaches one user or one agent and nobody else. | Not a new delivery path — a *conversation identity* so the two halves of a DM sit together and can be linked to. |
| Threaded replies | **A column exists and is a different feature.** | Thread identity of its own. `in_reply_to` cannot be reused without changing what old clients do. |
| Linkable / referenceable | No. The app has no URL state at all. | A URL grammar, and the rule that a link is an address, not a grant. |

Recommended first ship: **channels, public-only, additive** (Phase 1). It is the only phase that
changes no access-control rule and narrows no wire, so old clients cannot break on it, and it
creates the identity every later phase links to.

---

## 1. Ground truth

### 1.1 A "stream" today is a label, not a partition

There is exactly one stream and it is a string in the markup:

- `site/src/components/app/LiveDashboard.astro:248` — `<h2 id="dashboard-streams-label">STREAMS <span>(broadcast)</span></h2>`
- `site/src/components/app/LiveDashboard.astro:257` — `<span>all-signals</span>`, the only entry.
- `site/src/components/app/LiveDashboard.astro:344` — `<h1 id="dashboard-channel-title" …># all-signals</h1>`
- `site/src/components/app/LiveDashboard.astro:2216` — `const COMPOSER_STREAM = "all-signals";`

`grep` finds no `channel_id`, no conversation table, and no per-channel membership anywhere in
`supabase/migrations/`, `src/`, or `site/src/`. The `#` glyph and the `STREAMS` heading come from
`docs/design/2026-08-03-SLACK-SHAPE-UI.md`, which is explicit that it is a *visual* direction: "treat
this document as a direction, not a specification" (`docs/design/2026-08-03-SLACK-SHAPE-UI.md:11`).
It is Slack-shaped decoration over a single unpartitioned feed, not a partial implementation.

### 1.2 The signal row

`supabase/migrations/20260724000003_signals.sql:3-18` creates `swarm.signals`. Three properties
drive most of this design:

- **`until timestamptz NOT NULL`** (`:12`) with **`CHECK (until <= created_at + interval '30 days')`**
  (`:15`). Every signal expires within 30 days. Server-side ceiling
  `SIGNAL_MAX_UNTIL_MS = 30 * 24 * 60 * 60 * 1000` at `supabase/functions/command/index.ts:512`;
  per-kind defaults at `:513-517` (`working-on` 24h, `ask` 7d, `note` 30d).
- **Append-only.** `CREATE TRIGGER signals_append_only BEFORE UPDATE OR DELETE … EXECUTE FUNCTION
  swarm.prevent_append_only_mutation()` (`:36-38`). A signal cannot be edited or deleted, by anyone,
  including `swarm_admin` through the normal path.
- **One recipient, of one of two kinds.** `to_agent_principal_id` and `in_reply_to` were added by
  `supabase/migrations/20260730000002_agent_signal_receive.sql:4-6`, with
  `CONSTRAINT signals_one_recipient CHECK (num_nonnulls(to_user_id, to_agent_principal_id) <= 1)`
  (`:25-27`).

### 1.3 What `in_reply_to` actually does — it is not threading

This is the single most important correction in this document. `in_reply_to` is a **private
reply-to-author** feature, not a thread.

1. The edge refuses `in_reply_to` unless the signal is an undirected `note`
   (`supabase/functions/command/index.ts:1588-1595`):

   ```js
   inReplyTo === null ||
   (cmd.signal_kind === "note" && cmd.to_user_id === null && toAgentPrincipalId === null)
   ```

   So the client must send `to_user_id: null` and `to_agent_principal_id: null`.

2. The server then **re-addresses the reply to the original sender**
   (`supabase/functions/command/index.ts:5804-5827`). It loads the referenced signal, checks the
   caller was addressed by it, and returns a write target of `{ toUserId: reference.from_principal }`
   or `{ toAgentPrincipalId: reference.from_principal }`. The stored row is *directed*.

   Net effect: the client says "no recipient", the server writes "recipient = the person you are
   answering". `in_reply_to` today means **reply privately to the author**.

3. It is documented as one hop, not a tree:
   `COMMENT ON COLUMN swarm.signals.in_reply_to IS 'Immutable one-hop correlation to a signal in the
   same workspace.'` (`supabase/migrations/20260730000002_agent_signal_receive.sql:71-72`).

4. It is **dead data in the web client**, end to end. `site/src/lib/commonswarm.ts:2007` hardcodes
   `in_reply_to: null` on every browser post; the `Signal` interface at
   `site/src/lib/commonswarm.ts:1248-1260` has no such field; the browser's `select` list
   (`site/src/components/app/LiveDashboard.astro:1748`) does not request the column, so it never
   crosses the wire; and `grep -i "reply\|thread"` over the 10,230-line dashboard returns zero
   matches. There is no reply button in the app.

**Consequence for the spec:** you cannot make `in_reply_to` mean "thread reply" without silently
changing what every installed `cswarm reply` does — from a private answer to a channel-visible post.
That is a privacy regression, not a refactor. Threads need their own field. See §7.

### 1.4 Delivery fan-out — the exact rule

A signal becomes a delivery row through one trigger, and **only for directed agent signals**:

`supabase/migrations/20260731000001_signal_deliveries.sql:119-148`

```sql
IF NEW.to_agent_principal_id IS NOT NULL AND NEW.kind IN ('ask', 'note') THEN
  INSERT INTO swarm.signal_deliveries (signal_id, workspace_id, recipient_agent_principal_id)
  VALUES (NEW.id, NEW.workspace_id, NEW.to_agent_principal_id)
  ON CONFLICT DO NOTHING;
END IF;
```

So, precisely:

- **A broadcast fans out to nobody.** It creates zero delivery rows. The migration header says so:
  "Broadcasts still create no delivery rows and do not wake or track agents"
  (`supabase/migrations/20260902000001_broadcast_recipient_roster.sql:3-4`), and the client repeats
  it: "Broadcast — nobody was addressed or woken" (`site/src/lib/commonswarm.ts:1561`).
- **A directed *human* signal creates no delivery row either** — the trigger tests
  `to_agent_principal_id`. Human "delivery" is a focused-viewport seen attestation
  (`swarm.signal_human_receipts`), not a queue.
- **`working-on` never delivers**, even directed — but it also cannot be directed
  (`supabase/functions/command/index.ts:1580-1587`).
- Fan-out is therefore **at most one row per signal**. There is no N-way fan-out anywhere in the
  system today.

The multi-agent fan-out that exists is **client-side**: the composer posts one signal per `@`-tag,
capped at `MENTION_MAX_RECIPIENTS = 8` (`site/src/lib/mention-address.ts:30`), described at
`site/src/lib/mention-address.ts:2-3` — "the send posts one signal per tag because the wire carries a
single recipient per signal". This was a deliberate choice; the alternative is deferred in
`docs/design/2026-09-03-multi-recipient-signals.md`.

**Why this matters for channels:** a channel is the first thing in the product that has a *roster*.
If a channel post woke every agent in the channel, it would be the first N-way fan-out the system has
ever done, on a table whose delivery ledger was sized for one row per signal. This spec does not do
that in v1 — see §9 and §10.

### 1.5 The read path — there are two, and they disagree

**Humans and the browser read PostgREST directly.** They do not go through the `read` edge function.

- CLI: `src/cloud/signals.ts:890` — `new URL("/rest/v1/signals", target.url)`, with
  `"accept-profile": "swarm_read"` (`:928`) and an explicit select list at `:891-894`:
  `id,workspace_id,from,from_kind,to,to_agent,in_reply_to,about,kind,body,attachments,until,created_at`.
- Browser: `site/src/components/app/LiveDashboard.astro:1746-1750`, schema `swarm_read`, table
  `signals`, select list **without** `in_reply_to`. Keyset cursor on `(created_at, id)` desc,
  `SIGNAL_PAGE_SIZE = 25` (`:1194`). No recipient or stream predicate — it asks for everything in the
  workspace and filters in the browser.

**Agents read the `read` edge function.** And the edge is *agent-only* for signals:
`supabase/functions/read/index.ts:323-326` returns 401 for any non-agent credential unless the
resource is `renewal_grants`. Its visibility predicate is at `:609-617`:

```sql
AND ( (s."to" IS NULL AND s.to_agent IS NULL) OR s.to_agent = <this principal> )
```

**What a channel filter would cost:**

- Browser and CLI: one more query parameter (`channel_id=eq.<uuid>`) against an index. Cheap. The
  view already has `signals_workspace_newest` (`20260724000003:20-21`); a channel needs the
  analogous `(workspace_id, channel_id, created_at DESC, id DESC)`.
- The `read` edge: `parseBody` uses `exactKeys` (`supabase/functions/read/index.ts:222-234`), so a
  new optional key must follow the existing `modernShape` pattern — the same trick already used for
  `in_reply_to` (`:215`, `:230`) and the cursor pair (`:216-221`, `:231`). This is a solved shape in
  this file; copy it.
- Real cost is not the filter, it is the **unread/summary counts** the sidebar will want per channel.
  Out of v1 (§10).

### 1.6 RLS — every gate that decides who sees a signal

`swarm_read.signals` is a `security_barrier` view **owned by `swarm_admin`**
(`supabase/migrations/20260901000010_signal_attachments.sql:135`), so it runs with the owner's
privileges and its `WHERE` clause *is* the policy. The table policy underneath is
`swarm_command_all … USING (true) WITH CHECK (true)` (`20260724000003:32-34`) — it grants everything
to the command role and nothing to end users.

**The view has been redefined three times.** The authoritative one is the newest:
`20260724000003_signals.sql:43-59`, then `20260730000002_agent_signal_receive.sql:77-108`, then
**`supabase/migrations/20260901000010_signal_attachments.sql:122-133`**, which is live:

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

Reading the earlier two files as current is a live trap — the first has no `to_agent` at all.

The full list of gates a private channel or a DM would have to change, each cited:

| # | Gate | Location | What breaks |
|---|---|---|---|
| 1 | `swarm_read.signals` view `WHERE` | `20260901000010_signal_attachments.sql:122-133` | The only human visibility rule. A channel predicate goes here. |
| 2 | `swarm.is_member` | `20260820000002_archive_revokes_access.sql:4-21` | Membership + not-archived. A channel roster is a *second* membership concept; do not overload this one. |
| 3 | `read` edge agent predicate | `supabase/functions/read/index.ts:609-617` | Not RLS, same effect. An agent's channel membership must be applied here or agents see every channel. |
| 4 | `swarm.signals` table policy | `20260724000003_signals.sql:32-34` | `USING (true)` for `swarm_command`. Unchanged — the command edge is trusted; authorization is in the edge. |
| 5 | `swarm_read.signal_delivery_receipts` | `20260902000001_broadcast_recipient_roster.sql:105-110`, replaced by `20260902000004_signal_agent_receipts.sql` | Its human branch admits **any workspace member** (`swarm.is_member`) with no per-signal check. Under private channels a non-member could enumerate who saw a message in a channel they cannot read. **Must change in the same phase as private channels.** |
| 6 | `signal_agent_receipts_live_member_select` | `20260902000004_signal_agent_receipts.sql:66-70` | `USING (swarm.is_member(workspace_id, auth.uid()))`, no per-signal check. Same leak as #5, at table level. Already reads receipts for *directed* signals the member cannot see — see §11.2. |
| 7 | `signal_human_receipts` command policies | `20260901000020_signal_human_receipts.sql:30-67` | Insert/select gates for seen state; a channel-scoped seen rule lands here. |
| 8 | `swarm.signal_attachments` | `20260901000010_signal_attachments.sql:33-35` | Attachments are exposed through the signals view's subquery (`:98-119`), so they inherit #1 automatically. No separate change needed — worth stating so nobody adds one. |
| 9 | `realtime.messages` policy | `20260902000003_realtime_agent_activity.sql:4-17` | Topic is `cswarm-activity:<workspace_id>`, gated by `is_member`. A per-channel topic needs its own policy or private-channel traffic leaks over Realtime. **See the throughput warning below.** |

**Realtime has a measured ceiling, and gate #9 spends it.**
`docs/research/2026-09-01-streaming-into-the-web-ui.md:50` records "about 2 frames/second per
channel, with silent loss above it and `send()` returning `\"ok\"` for every dropped frame". The same
file states at `:196` that it was **not** established whether that limit is per-channel, per-client,
or a project-wide `max_events_per_second` quota.

> **Citation caveat:** that file does not exist at this spec's base SHA. It landed in `6e43370`
> ("docs(research): recover the streaming design investigation out of gitignored scratchpad"), which
> at the time of writing is on the shared checkout's local `main` and **not yet pushed to
> `origin/main`**. Resolve it against `6e43370`, not `e3df06b`. Recorded rather than dropped because
> the number constrains Phase 5. If it is project-wide, then adding one Realtime topic per chat channel competes for the same budget as the live agent panel, and the failure mode is **silent frame loss with a successful-looking send** — the worst shape a bug can have. Re-measure and check the project quota before Phase 5 gives channels their own topics.

Do **not** reach for the cheap workaround of reusing the workspace topic with a client-side filter.
A client-side filter is not an access control: the frame still reaches every workspace member's
browser, so the *fact* that a private channel is active — and its `channel_id`, and who is posting —
leaks to non-members even if the body is withheld. A private channel with no Realtime is honest and
merely slower; a private channel with a filtered shared topic looks private and is not. If the budget
is not measured in time, private channels fall back to the existing poll-and-refresh path.

### 1.7 The protocol core has no signals in it

**`docs/design/2026-09-03-multi-recipient-signals.md:29-30` is wrong on this point.** It says:

> `src/protocol/` — the command and the event gain a recipient set; the reducer decides what
> "addressed to me" means when the set has several members.

Measured at `e3df06b`: `grep -rni "signal" src/protocol/` returns **0** hits across all ten files.
Positive control on the same invocation: the same grep over `src/` finds `post_signal` at
`src/cli.ts:2896`, `src/cli.ts:3114`, `src/listener/runtime.ts:773`,
`src/cloud/command-client.ts:136`, and `src/cloud/seed.ts:15` — so the pattern and the tool work.

The pure core (`src/protocol/index.ts:1-13`) covers the task-lease state machine
(`commands.ts:21-28`: `create`, `acquire`, `renew`, `handoff`, `takeover`, `submit`, `close`,
`reopen`), workspace decisions, idempotency and the brain version window. `post_signal` is validated
and executed **entirely inside the command edge function** —
`supabase/functions/command/index.ts:1524-1639` (validation) and `:5941-6016` (the insert).

`supabase/functions/_shared/protocol.js` *is* generated from `src/protocol/index.ts`
(`package.json:16`) and `command/index.ts:85-96` imports `applyCommand`, `canonicalPrincipal`,
`decideWorkspace`, `reduceTask`, `reduceWorkspace`, `requestHash` and the renewal constants from it —
but nothing signal-shaped.

**So: this feature adds no protocol-core command or event, and needs no
`npm run build:command-core` run.** That is a simplification, and it also removes the reducer as a
place to put channel-membership logic. Authority for "may this principal post to this channel" has to
live in the command edge, beside `resolveSignalWriteTarget`. §6 says where.

### 1.8 Wire compatibility — what actually protects old clients

- **The signal-row parser is forward-compatible by design.** `src/cloud/signals.ts:317-325`:
  "unknown top-level fields are ignored so a newer edge can add columns without killing old clients.
  Absent optional known fields (to_agent, in_reply_to) normalize to null." So **adding `channel_id`
  to the view and the wire cannot break an installed CLI.** Removing or renaming a column would; the
  human path names its columns explicitly (`src/cloud/signals.ts:891-894`), so a PostgREST 400 is the
  failure mode.
- **There is no equivalent gate for the signals wire.** `tests/receipt-wire-compat.test.ts` runs the
  npm 0.1.42/0.1.43 parser blob against the current *receipts* shape (`:19-45`) with a mutation
  control that must throw (`:52-58`). Nothing does that for `signals`. **Phase 1 should add the
  twin**, because Phase 3 and 5 are where a signals-shape mistake would land.
- **The apply order is not negotiable** and is written down at
  `supabase/migrations/20260902000001_broadcast_recipient_roster.sql:58-64`: migration → deploy
  `read`/`command` edge → publish client → site. The reason is at `:11-20`: the Supabase CLI applies
  migration files **one per transaction**, so a shape committed by file N is visible to every client
  until N+1 commits, and it stays applied if N+1 fails. Compatibility cannot be delegated to the next
  file.

#### 1.8.1 The `until` trap — do not make it nullable

A Slack channel's messages do not vanish. A CommonSwarm signal expires within 30 days
(§1.2). The obvious fix — make `until` nullable for channel posts — **silently hides every
non-expiring message from every installed CLI**:

- `src/cloud/signals.ts:898` sets `url.searchParams.set("until", "gt.now")`. A `NULL` fails
  `gt.now`, so the row is filtered out server-side with no error.
- The browser already tolerates it: `site/src/components/app/LiveDashboard.astro:1750` uses
  `.or(\`until.is.null,until.gt.${cutoff}\`)`.

So the browser would show the message and the CLI would not, with no diagnostic on either side.
**Keep `until NOT NULL`.** Relax the ceiling instead (§4.2).

---

## 2. The model

One sentence: **a signal gains a conversation it belongs to, and a thread it belongs to; nothing else
about a signal changes.**

```
swarm.channels          one row per conversation: a named channel, or a DM
swarm.channel_members   who is in it — users AND agent principals
swarm.signals           + channel_id  (which conversation)
                        + thread_root_id  (which thread, NULL = a top-level message)
                        + broadcast_to_channel  (Slack's "also send to channel")
```

`about`, `kind`, `to_user_id`, `to_agent_principal_id`, `in_reply_to`, `until`, immutability — all
unchanged in meaning. Directed signals keep working exactly as they do today and keep their delivery
and wake path (§1.4). This is deliberate: the delivery ledger is the part of the system with the most
invariants (`20260731000001_signal_deliveries.sql:38-74` is 13 CHECK constraints), and this design
does not touch it until it has to.

---

## 3. DM versus a channel of two

**Same table, different type. Not the same mechanism.** `swarm.channels.type IN ('channel', 'dm')`.

Shared: the row, `channel_id` on the signal, the read path, the RLS predicate, the permalink grammar,
threads.

Different, and these differences are why it is a type and not a naming convention:

| | `channel` | `dm` |
|---|---|---|
| Identity | a name a human chose | the **participant set**, canonically |
| Created by | an explicit command | implicitly, on first send |
| Membership | mutable (join/leave/invite) | **immutable** — adding a person makes a *different* DM |
| Name / topic | yes | no |
| Listed in the browser | yes | no |
| Visibility (v1) | every workspace member (§9 P1) | participants only, from day one |

**Why not "a private channel of two".** Because a DM must be idempotent per participant set: sending
to the same person twice, a year apart, must land in the same conversation. That requires a
uniqueness constraint on a canonical key derived from the members — which *is* the `dm` type,
whether or not you name it. Slack reached the same conclusion; making it explicit is what prevents
"rename your DM" and "add a fifth person to a DM" from being reachable states. If you skip the type,
you get those bugs and then add the constraint anyway.

**The participant key spans two principal kinds.** CommonSwarm participants are users *and* agent
principals, so the key is the sorted set of `'<kind>:<uuid>'` tokens over both — not a user-id pair.
Stored as a generated `text[]` with a unique index; see §4.1.

### 3.1 A two-party DM and a group DM are not the same row shape

This is the sharpest constraint in the design and it must be stated, not discovered during
implementation. `CONSTRAINT signals_one_recipient` allows **at most one** of `to_user_id` and
`to_agent_principal_id` (`20260730000002_agent_signal_receive.sql:25-27`), and the delivery/wake
trigger keys off `to_agent_principal_id` alone (`20260731000001:126`). So:

- **A two-party DM keeps the recipient columns set.** `channel_id` points at the `dm` conversation
  *and* `to_user_id`/`to_agent_principal_id` names the other party, exactly as a directed signal does
  today. Result: delivery and wake keep working unchanged, visibility is already granted by view
  clauses (b) and (c), and the row is byte-compatible with what every installed client expects. The
  `channel_id` is what makes the two halves of the conversation addressable as one thing.
- **A group DM (3+ participants) cannot set the recipient columns at all.** There is no room for a
  second recipient. Its rows carry `channel_id` and leave `to_user_id`/`to_agent_principal_id`
  `NULL`. Visibility therefore comes only from clause (d), and — this is the cost — **no agent in a
  group DM is woken**, because the trigger never fires.

Two consequences to accept or reject deliberately:

1. **A group DM is a private channel wearing a different name.** Once the recipient columns are
   empty, the only thing distinguishing it from a private channel is that it has no name and an
   immutable roster. That is a real distinction and it is why the `dm` type still earns its place —
   but it means Phase 3 and Phase 5 share a predicate, and the honest sequencing is to build
   clause (d) once, in Phase 3, and let Phase 5 reuse it rather than invent a second path.
2. **Group DMs are silent for agents until channel wake exists** (§10). An agent added to a group DM
   would never be prompted. That is a bad enough surprise that **v1 should cap DMs at two
   participants** and defer group DMs to the phase that brings channel wake. A two-party DM covers
   the operator's stated ask — "Slack-like direct messages with agents" — completely.

**Recommendation: v1 DMs are two-party only.** It keeps every DM on the existing, well-tested
directed path, wake included, and it avoids shipping a conversation type that silently fails to
notify the agents in it.

**One existing guarantee must survive.** The live view lets a member see signals addressed to an
agent **they own**, for oversight (`20260901000010_signal_attachments.sql:126-132`; the intent is
stated at `20260730000002_agent_signal_receive.sql:74-76`). A DM with someone else's agent must stay
visible to that agent's owner. Dropping it would be a security regression in the direction people
notice late — an operator losing sight of what their own agent was told. The DM RLS predicate in §5
carries it forward explicitly.

---

## 4. Migration sketch

Four migration files, one per phase that needs schema. Each is written so the shape it commits is the
only shape it ever commits (§1.8).

### 4.1 `swarm.channels` and `swarm.channel_members`

```sql
CREATE TABLE swarm.channels (
  channel_id   uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  type         text NOT NULL CHECK (type IN ('channel', 'dm')),
  -- Slack's rules: lowercase, no spaces. NULL for a dm.
  name         text CHECK (name IS NULL OR name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  topic        text CHECK (topic IS NULL OR char_length(topic) <= 500),
  -- v1: every channel is workspace-visible. Phase 5 flips this per row.
  visibility   text NOT NULL DEFAULT 'workspace'
                 CHECK (visibility IN ('workspace', 'members')),
  is_default   boolean NOT NULL DEFAULT false,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at  timestamptz,
  -- The canonical participant key. NULL for a channel; set for a dm.
  dm_key       text[],
  CHECK ((type = 'dm') = (dm_key IS NOT NULL)),
  CHECK ((type = 'dm') = (name IS NULL)),
  CHECK (type = 'channel' OR visibility = 'members')
);

-- One #name per workspace, among live channels.
CREATE UNIQUE INDEX channels_workspace_name
  ON swarm.channels (workspace_id, name) WHERE name IS NOT NULL AND archived_at IS NULL;
-- One DM per participant set per workspace. This is the whole reason 'dm' is a type.
CREATE UNIQUE INDEX channels_workspace_dm_key
  ON swarm.channels (workspace_id, dm_key) WHERE dm_key IS NOT NULL;
-- Exactly one default channel per workspace.
CREATE UNIQUE INDEX channels_workspace_default
  ON swarm.channels (workspace_id) WHERE is_default;
-- The signals FK is tenant-pinned, matching signals_agent_recipient_workspace.
CREATE UNIQUE INDEX channels_channel_workspace
  ON swarm.channels (channel_id, workspace_id);

CREATE TABLE swarm.channel_members (
  channel_id   uuid NOT NULL,
  workspace_id uuid NOT NULL,
  -- Exactly one of these, mirroring signals_one_recipient.
  user_id              uuid,
  agent_principal_id   uuid,
  added_by     uuid NOT NULL,
  added_at     timestamptz NOT NULL DEFAULT statement_timestamp(),
  removed_at   timestamptz,
  CHECK (num_nonnulls(user_id, agent_principal_id) = 1),
  FOREIGN KEY (channel_id, workspace_id)
    REFERENCES swarm.channels (channel_id, workspace_id),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES swarm.memberships (workspace_id, user_id),
  FOREIGN KEY (agent_principal_id, workspace_id)
    REFERENCES swarm.agent_principals (principal_id, workspace_id)
);

CREATE UNIQUE INDEX channel_members_user
  ON swarm.channel_members (channel_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX channel_members_agent
  ON swarm.channel_members (channel_id, agent_principal_id)
  WHERE agent_principal_id IS NOT NULL;
CREATE INDEX channel_members_live_by_principal
  ON swarm.channel_members (workspace_id, user_id, agent_principal_id)
  WHERE removed_at IS NULL;
```

`dm_key` is the sorted array of `'user:<uuid>'` / `'agent:<uuid>'` tokens, computed by the command
edge. It is the DM's identity, so its integrity is the whole design — and a review arm found three
ways the sketch above lets it drift. All three need fixing before this reaches a migration:

1. **Sorting is load-bearing and nothing enforces it.** A Postgres unique index on `text[]` is
   order-sensitive: `{a,b}` and `{b,a}` are different keys, so an unsorted write silently creates a
   *second* DM for the same pair — exactly the bug the type exists to prevent. Add
   `CHECK (dm_key = (SELECT array_agg(t ORDER BY t) FROM unnest(dm_key) AS t))`, and, since a
   duplicate participant would also change the key, `CHECK (cardinality(dm_key) = cardinality(ARRAY(SELECT DISTINCT unnest(dm_key))))`.
2. **`(type = 'dm') = (dm_key IS NOT NULL)` admits the empty array.** `'{}'::text[]` is not NULL, so
   it satisfies the check and the unique index allows exactly one zero-participant DM per workspace.
   Add `CHECK (type <> 'dm' OR cardinality(dm_key) = 2)` — 2, not "≥ 2", per the two-party
   recommendation in §3.1.
3. **A trigger that validates `dm_key` against the roster cannot be an `AFTER INSERT ON channels`
   trigger.** `channel_members` has a foreign key to `channels`, so the channel row must exist
   before any member row does; at channel-insert time the roster is necessarily empty and the
   trigger would either pass vacuously or reject every DM. Use a **deferred constraint trigger**
   (`CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`) that fires at commit, when both the
   channel and its members exist. Without that, `dm_key` can name a set that is not the roster, and
   the unique index then protects the *claimed* participants rather than the real ones — a
   uniqueness guarantee that is worse than none, because it looks sound.

Note `channel_members` is **mutable** (`removed_at`), unlike `swarm.signals`. That is intentional and
is the reason the DM key is frozen at creation: a DM's roster is written once and never updated, so
the unique index stays truthful.

### 4.2 `swarm.signals` gains three columns — in two different phases

**`channel_id` ships in Phase 1. `thread_root_id` and `broadcast_to_channel` ship in Phase 2.** They
are shown together because they are one coherent shape, but they must not land in one migration: a
review arm's advice, and it is right. Phase 1's file already takes an `ACCESS EXCLUSIVE` lock on
`swarm.signals` and is the file that must not break old writers; adding thread columns nobody reads
yet only widens what can go wrong in it, for no benefit before the Phase 2 client exists.

Note `broadcast_to_channel boolean NOT NULL DEFAULT false` is safe as `NOT NULL` precisely because it
**has** a default — which is the contrast that should have caught D1 on `channel_id` in the first
draft.

```sql
-- Phase 1
ALTER TABLE swarm.signals
  ADD COLUMN IF NOT EXISTS channel_id uuid;   -- NOT NULL is deferred; see §4.3

-- Phase 2
ALTER TABLE swarm.signals
  ADD COLUMN IF NOT EXISTS thread_root_id uuid,
  ADD COLUMN IF NOT EXISTS broadcast_to_channel boolean NOT NULL DEFAULT false;

ALTER TABLE swarm.signals
  ADD CONSTRAINT signals_channel_workspace
  FOREIGN KEY (channel_id, workspace_id)
  REFERENCES swarm.channels (channel_id, workspace_id);

ALTER TABLE swarm.signals
  ADD CONSTRAINT signals_thread_root_workspace
  FOREIGN KEY (thread_root_id, workspace_id)
  REFERENCES swarm.signals (id, workspace_id);

CREATE INDEX signals_channel_newest
  ON swarm.signals (workspace_id, channel_id, created_at DESC, id DESC)
  WHERE channel_id IS NOT NULL;
CREATE INDEX signals_thread_oldest
  ON swarm.signals (workspace_id, thread_root_id, created_at, id)
  WHERE thread_root_id IS NOT NULL;
```

**The `until` ceiling — do NOT touch it in Phase 1.**

An earlier draft proposed replacing the 30-day CHECK (`20260724000003:15`) with:

```sql
-- REJECTED. This is a 100-year ceiling on the whole table.
CHECK (
  until <= created_at + interval '30 days'
  OR (channel_id IS NOT NULL AND until <= created_at + interval '100 years')
)
```

The review arm found why that is wrong, and it is worth keeping as a worked example. **After the
§4.3 backfill every row has a `channel_id`**, and the defaulting trigger gives one to every new row
too. So `channel_id IS NOT NULL` is true for the entire table, the second arm of the `OR` always
holds, and the 30-day rule is silently deleted — for `working-on` and `ask` as well as for channel
posts. The draft also contained a contradiction that should have exposed this: it said existing
kinds keep `SIGNAL_DEFAULT_UNTIL_MS` **and** that "a channel post defaults to the long horizon",
which after Phase 1 describes the same rows.

`channel_id` cannot discriminate a "channel post" once everything is in a channel. **So Phase 1
leaves the 30-day CHECK exactly as it is**, and every signal keeps expiring as it does today.

Making channel messages durable is a real requirement and it gets its own phase, with a real
discriminator — a new `kind`, or an explicit `retention` column — never `channel_id IS NOT NULL`.
When that phase comes:

- `until` stays `NOT NULL`. §1.8.1 has the measurement: `src/cloud/signals.ts:898` sends
  `until=gt.now`, so a NULL vanishes from every installed CLI while still showing in the browser.
- `SIGNAL_MAX_UNTIL_MS` (`supabase/functions/command/index.ts:512`, enforced at `:1604-1608`) must
  gain the matching branch in the same phase, or the edge refuses what the constraint allows and the
  change is invisible.
- Resolve the real constraint name from `pg_constraint` before any `DROP` — the CHECK at
  `20260724000003:15` is unnamed in the source, so Postgres generated its name.
  `20260827000001_expand_signal_body.sql:1-6` is the precedent (it drops `signals_body_check` by
  name).

**Consequence to state plainly in the UI:** in Phase 1, a channel is a place, not an archive.
Messages still expire on the existing schedule — `note` at 30 days, `ask` at 7, `working-on` at 24
hours (`:513-517`). A user who expects Slack's permanent history will be wrong until the retention
phase ships.

### 4.3 Backfill — where every existing signal lands

Every existing signal goes to its workspace's new default channel. **No signal is deleted, edited, or
loses a field.** The `signals_append_only` trigger blocks `UPDATE`
(`20260724000003:36-38`), so the backfill must disable it for the statement, in one transaction:

```sql
-- 1. one default channel per live workspace
INSERT INTO swarm.channels (channel_id, workspace_id, type, name, visibility,
                            is_default, created_by, created_at)
SELECT gen_random_uuid(), w.workspace_id, 'channel', 'all-signals', 'workspace',
       true, w.created_by, w.created_at
FROM swarm.workspaces AS w
ON CONFLICT DO NOTHING;

-- 2. every signal joins it. The append-only trigger must stand down for this statement.
ALTER TABLE swarm.signals DISABLE TRIGGER signals_append_only;
UPDATE swarm.signals AS s
SET channel_id = c.channel_id
FROM swarm.channels AS c
WHERE c.workspace_id = s.workspace_id AND c.is_default AND s.channel_id IS NULL;
ALTER TABLE swarm.signals ENABLE TRIGGER signals_append_only;

-- 3. DEFAULT NEW ROWS SERVER-SIDE. This is load-bearing — see the note below.
CREATE OR REPLACE FUNCTION swarm.default_signal_channel()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.channel_id IS NULL THEN
    SELECT c.channel_id INTO NEW.channel_id
    FROM swarm.channels AS c
    WHERE c.workspace_id = NEW.workspace_id AND c.is_default;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER signals_default_channel
  BEFORE INSERT ON swarm.signals
  FOR EACH ROW EXECUTE FUNCTION swarm.default_signal_channel();

-- 4. assert the backfill covered everything
DO $$
DECLARE orphan integer;
BEGIN
  SELECT count(*)::integer INTO orphan FROM swarm.signals WHERE channel_id IS NULL;
  IF orphan <> 0 THEN
    RAISE EXCEPTION 'channel backfill incomplete: % signal(s) have no channel', orphan;
  END IF;
END $$;
```

The assert shape is copied from `20260731000001_signal_deliveries.sql:175-196`, which is the house
pattern for the assert itself (that file does not use `DISABLE TRIGGER`).

**Step 5, and the sketch is not complete without it: recreate `swarm_read.signals`.** The review arm
noticed that no draft step exposed the new column. PostgREST reads the view, not the table, so until
the view is recreated `channel_id` does not exist on the wire and a new client filtering
`channel_id=eq.<uuid>` gets a **400**, not an empty page. Recreate the view from its live definition
(`20260901000010:81-133`), adding `channel_id` **at the end of the select list** and changing nothing
else — same `security_barrier`, same owner, same grants, same `WHERE`. Adding at the end matters:
both installed readers name their columns explicitly (`src/cloud/signals.ts:891-894`,
`LiveDashboard.astro:1748`), so a new trailing column is invisible to them, while reordering or
renaming an existing one is a PostgREST 400 for every old client.

> #### `channel_id` must NOT be `NOT NULL` in this migration
>
> An earlier draft of this section ended with
> `ALTER TABLE swarm.signals ALTER COLUMN channel_id SET NOT NULL;`. **That is an outage**, and the
> review arm caught it. The apply order
> (`20260902000001_broadcast_recipient_roster.sql:58-64`) is migration **first**, edge deploy
> **second**. Between those two steps the OLD command edge is still serving, and its insert
> (`supabase/functions/command/index.ts:5941-6016`) names its columns explicitly and does not
> include `channel_id`. A `NOT NULL` column with no default therefore makes **every signal post in
> production fail** with a not-null violation, for every client, until the edge deploy lands. Reads
> would keep working, so the symptom is "nobody can post" with a healthy-looking feed.
>
> The `BEFORE INSERT` trigger in step 3 is the fix, and it is what makes the old edge keep working:
> `BEFORE` triggers run before constraint checks, so the trigger fills `channel_id` on an insert
> that omits it. Two rules follow:
>
> 1. **The trigger and the backfill ship in the SAME migration file**, and the trigger is created
>    before the file returns. A file that adds the column without the trigger commits a shape that
>    breaks posting, and §1.8 says that shape is live until the next file commits.
> 2. **`SET NOT NULL` is deferred to a later phase**, after the new command edge is deployed
>    everywhere and the trigger has been proven in production. It is a tightening with no
>    behavioural benefit; there is no reason to take the risk in Phase 1. Until then `channel_id` is
>    nullable in the schema and non-null in practice, and every reader should still treat NULL as
>    "the default channel" defensively.

Two cautions:

- **`ALTER TABLE … DISABLE TRIGGER` takes an `ACCESS EXCLUSIVE` lock** and blocks every read of
  `swarm.signals` for the duration of the `UPDATE`. On a large table that is a visible outage.
  **Measure the row count on production before choosing**; this spec cannot decide it from the repo
  (§12). If the count makes a single statement unsafe, batch the `UPDATE` by `workspace_id` with the
  trigger left enabled — `swarm.prevent_append_only_mutation()` blocks the write, so batching means
  dropping and recreating the trigger around the loop, which widens the window in which a signal
  could be edited. Prefer the single statement unless the measurement forbids it.
- Do not "archive" workspaces out of the backfill. `swarm.is_member` already excludes archived
  workspaces (`20260820000002:11-20`), so an archived workspace's signals are unreachable anyway,
  but leaving them NULL would make the "every signal has a channel" assert fail and would leave rows
  that later readers have to special-case. Backfill all of them.
- **The default channel is created with an empty roster, and that is a landmine for Phase 5.** This
  sketch backfills `swarm.channels` and `swarm.signals` but never `swarm.channel_members`. That is
  harmless while `visibility = 'workspace'`, because clause (a) does not consult the roster — which
  is exactly why it would go unnoticed. The moment anyone flips the default channel to
  `visibility = 'members'`, clause (a) stops matching and clause (d) finds no rows, and **every
  member loses the entire workspace history at once**. Two defences, take both: backfill one
  `channel_members` row per live membership for the default channel in this same file, and add
  `CHECK (NOT is_default OR visibility = 'workspace')` so the default channel cannot be made private
  by accident.
- `INSERT … ON CONFLICT DO NOTHING` on `swarm.channels` uses `gen_random_uuid()`, so it can never
  conflict on the primary key; the conflict it actually relies on is `channels_workspace_default`.
  That is fine on a first run and correct on a re-run, but only because that partial unique index
  exists — do not drop it thinking it is redundant with the `is_default` boolean.

### 4.4 DM conversations (Phase 3)

For each existing directed signal, the DM it belongs to is derivable: the participant set is
`{author, recipient}`. Backfill creates one `dm` channel per distinct pair and stamps
`channel_id` onto those signals in place of the default channel. This is a second `UPDATE` under the
same trigger caveat, and it **moves** signals out of the default channel — which is why it is a
separate phase with its own review: it changes what an old client sees in its feed. See §9 P3 for the
compatibility rule that makes it safe.

---

## 5. RLS, spelled out

**Phase 1 changes no visibility rule at all.** Every channel is `visibility = 'workspace'`, so the
existing view predicate is already correct and the view only gains columns. This is the property that
makes Phase 1 safe to ship first, and it is worth defending against the temptation to add private
channels "while we are in there".

The new predicate, introduced at Phase 3 for DMs and generalized at Phase 5 for private channels,
replaces the `WHERE` at `20260901000010_signal_attachments.sql:122-133`:

```sql
WHERE swarm.is_member(s.workspace_id, auth.uid())
  AND (
    -- (a) unchanged: undirected, in a workspace-visible channel
    (
      s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL
      AND EXISTS (
        SELECT 1 FROM swarm.channels AS c
        WHERE c.channel_id = s.channel_id AND c.visibility = 'workspace'
      )
    )
    -- (b) unchanged: addressed to me
    OR s.to_user_id = auth.uid()
    -- (c) unchanged: addressed to an agent I own (oversight, §3)
    OR EXISTS (
      SELECT 1 FROM swarm.agent_principals AS principal
      WHERE principal.principal_id = s.to_agent_principal_id
        AND principal.workspace_id = s.workspace_id
        AND principal.owner_user_id = auth.uid()
    )
    -- (d) NEW: I am in the channel, in person or through an agent I own.
    --     The undirected guard is LOAD-BEARING — see the note below.
    OR (
      s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM swarm.channel_members AS m
        LEFT JOIN swarm.agent_principals AS p
          ON p.principal_id = m.agent_principal_id AND p.workspace_id = m.workspace_id
        WHERE m.channel_id = s.channel_id
          AND m.removed_at IS NULL
          AND (m.user_id = auth.uid() OR p.owner_user_id = auth.uid())
      )
    )
  );
```

> #### Clause (d) without the undirected guard is a mass disclosure of every private message
>
> An earlier draft omitted `s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL` from clause
> (d). The review arm found the consequence, and it is severe.
>
> Phase 1 puts **every existing signal** into the workspace's default `#all-signals` channel (§4.3),
> and the trigger keeps putting every old client's post there. Directed signals — today's private
> messages — are among them: they get a `channel_id` like everything else, and their privacy comes
> only from view clauses (b) and (c). An unguarded clause (d) is OR'd with those, so **anyone who
> joins `#all-signals` reads every directed signal ever sent in the workspace**, including messages
> between other people and messages to agents they do not own. Membership of the default channel
> would be a workspace-wide surveillance grant, and it would arrive silently at the Phase 3
> migration with no error and no log line.
>
> The guard closes it without costing anything, because a directed signal never *needs* clause (d):
> its visibility is fully decided by (b) and (c) whatever channel it sits in. That includes the
> two-party DMs of §3.1, which keep their recipient columns set precisely so this stays true.
>
> Two rules follow:
>
> 1. **Channel membership grants read on undirected messages only.** State it that way in the
>    predicate, in the code comment, and in the docs, so nobody "simplifies" the guard away later.
> 2. **The Phase 3 migration needs a negative test that reaches this path**: a member who is in the
>    default channel and is neither sender nor recipient of a directed signal must get zero rows.
>    Per the repo rule on negative results, the control must be shown to fail when the guard is
>    removed — otherwise it proves nothing about the guard.

> #### Clauses (b) and (c) have no roster test, and that lets private-channel content walk out
>
> The second review arm found this one. Clauses (b) and (c) grant read on a directed signal purely
> from *who it is addressed to* — there is no test that the addressee is in the signal's channel,
> and there deliberately is none today because there were no channels. So once a channel can be
> `visibility = 'members'`, a member of `#exec-comp` who `@`-tags someone outside the roster writes a
> row that clause (b) shows that outsider. Private-channel content leaves the roster, one message at
> a time, and nothing in the predicate stops it.
>
> **Do not fix this in the predicate.** Widening (b)/(c) with a roster test would break the ordinary
> directed message, which must keep working in the default channel and in DMs regardless of any
> roster — and it would change today's behavior for every existing signal.
>
> **Fix it at post time instead.** `resolveSignalChannel` (§6) currently answers only "may this
> principal post here". It must also answer "may this principal address *that* recipient from here":
> in a `visibility = 'members'` channel, refuse a `to_user_id` / `to_agent_principal_id` naming a
> principal who is not a live member of that channel. Refusing the write is the honest outcome — the
> alternative is writing a row whose visibility contradicts the channel it sits in. The refusal
> message should say the recipient is not in the channel and name the remedy (add them, or send a
> DM), and it must be built from the same membership query that enforces it, per AGENTS.md:211-224.
>
> This lands in the same phase that first allows `visibility = 'members'`, alongside clause (a).

Clause (a) is the one that changes behavior, and it is the trap: it must be added **at the same time**
as the first non-`workspace` channel exists, not before and not after. Before, it is a no-op (every
channel is `workspace`). After, a private channel's messages would be world-readable inside the
workspace for the window between the two migrations — and §1.8 says that window is real, because
migrations commit one per transaction. **Ship clause (a) in the same file that first allows
`visibility = 'members'`.**

Clause (d) grants an agent's owner sight of the agent's channels. That is the same oversight rule as
(c), extended. State it in the UI: putting your agent in a channel means you can read that channel.

**Leaving a channel — what happens to history you could already read.** The predicate answers this,
and the answer should be stated rather than left to be discovered:

- **Leaving a public channel loses you nothing.** `removed_at` is set, so clause (d) stops matching,
  but clause (a) still does — the channel is `visibility = 'workspace'`, so every workspace member
  reads it whether or not they are a member. Membership on a public channel is a *subscription*, not
  a grant. This matches Slack.
- **Leaving a private channel revokes the history.** Clause (d) is the only clause that matched, and
  `removed_at IS NULL` stops it. Messages you read yesterday become unreadable. This also matches
  Slack, and it is the correct default, but it is surprising enough to warrant a confirmation in the
  UI ("you will lose access to this conversation's history").
- **A DM has no leave.** Membership is immutable (§3), so this case does not arise.
- **Being removed from the workspace** already dominates all of it: `swarm.is_member`
  (`20260820000002:4-21`) gates every clause.

One consequence worth naming: because signals are immutable and `channel_members` is not, a private
channel's readable history is a function of *current* membership, not of who could see a message when
it was posted. Someone added to a private channel today can read everything posted before they
joined. Slack makes this configurable; v1 does not, and the simple rule is the one above.

The corresponding agent-side predicate in the `read` edge
(`supabase/functions/read/index.ts:609-617`) gains the mirror of (d), keyed on the authenticated
principal rather than on `auth.uid()`.

**Gates #5 and #6 from §1.6 must move in the same phase.** Both admit any workspace member to receipt
data with no per-signal check. Today that is a small leak (§11.2); with private channels it becomes a
way to enumerate participation in a channel you cannot read.

---

## 6. Commands and events

No protocol-core change (§1.7). All of the following are command-edge work in
`supabase/functions/command/index.ts`, validated in the same `parseCommand` chain as `post_signal`
(`:1524-1639`) and executed beside `postSignal` (`:5941`).

**New commands**

| Command | Fields | Notes |
|---|---|---|
| `create_channel` | `name`, `topic?`, `visibility?` | Human-interactive credential only, like workspace creation. Rate-limit beside `MODEL_DECLARE_RATE_LIMIT_PER_HOUR` (`:510`). |
| `archive_channel` | `channel_id` | Sets `archived_at`. Never deletes; signals are immutable. |
| `join_channel` / `leave_channel` | `channel_id`, `principal?` | `principal` names an agent the caller owns; absent means the caller. **Both must refuse `type = 'dm'`** — see below. |
| `open_dm` | `participants[]` | Idempotent. Returns the existing `channel_id` for that key or creates one. |

**`leave_channel` must refuse a DM, and the refusal has to be explicit.** §3 says a DM roster is
immutable, but an earlier draft did not enforce it anywhere, and a review arm traced what happens if
someone leaves one. `channel_members`' unique indexes (`channel_members_user`,
`channel_members_agent`, §4.1) are on `(channel_id, user_id)` with no `removed_at` predicate, so the
row cannot be re-inserted after a leave. A later `open_dm` then finds the same `dm_key`, returns the
existing channel — and clause (d) of §5 no longer matches, because `removed_at IS NOT NULL`. The
person who just "opened" the DM cannot see it, and there is no command that repairs the state. Refuse
the leave at the edge, and add the negative test.

**Join and leave are meaningful only for private channels.** While every channel is
`visibility = 'workspace'` (Phase 1), clause (a) already shows every member every undirected message,
so joining or leaving changes nothing a reader can see. Until Phase 5 these commands drive the
sidebar and nothing else. Say so in the UI rather than implying membership is a permission, or the
first person to "leave" a channel and keep seeing it will file a bug.

**Changed command: `post_signal`**

Adds three optional fields — `channel_id`, `thread_root_id`, `broadcast_to_channel` — following the
existing `modernShape` pattern at `:1532-1541` and `:1570-1576`, which is how `to_agent_principal_id`
and `in_reply_to` were added without breaking the `exactKeys` check at `:1553-1562`.

Authorization goes in a new `resolveSignalChannel(tx, route, auth, command)` beside
`resolveSignalWriteTarget` (`:5740`). It answers two questions — *may this principal post here*, and
(from the §5 note) *may this principal address that recipient from here* — and returns the
`channel_id` to write, or `null` for a 403. Absent `channel_id` resolves to the workspace's default
channel.

**And the insert list must change.** A review arm pointed out that no earlier draft said so, and an
implementer following the spec literally would have deployed a new edge that still did not write the
column. `postSignal` names its columns explicitly at
`supabase/functions/command/index.ts:5966-5983`; `channel_id` has to be added to that column list, to
the `RETURNING` clause at `:5984-5987`, and to the `SignalRecord` the function builds at
`:6004-6018`, so the post response carries the channel the caller's message actually landed in. The `signals_default_channel`
trigger (§4.3) is the safety net for writers that do not do this — it is not a substitute for doing
it.

**No new events.** The signal row is the record; there is no event log for signals to append to.

**One thing to fix while you are here.** `src/cli.ts:2411-2412` types the kind set by hand:

```js
if (!["working-on", "note", "ask"].includes(value)) {
  throw new Error("--kind must be working-on, note, or ask");
}
```

There are four un-synced copies of that set: `src/cloud/signals.ts:31` (`SIGNAL_KINDS`),
`src/cloud/command-client.ts:133` (the `SignalKind` union), `supabase/functions/read/index.ts:19`,
and `supabase/functions/command/index.ts:1542`. This is a standing violation of AGENTS.md:211-224
("An enumeration inside a message must be generated, not typed"), it predates this spec, and it is
where any new signal kind will land and lie. Small, self-contained, worth doing in Phase 1.

---

## 7. Threading

**`in_reply_to` is not enough, and it is not the right column.** §1.3 measured why: it is
edge-restricted to undirected notes, the server re-addresses the result to the original author, and
it is documented as one hop. It is a *private reply-to-author* feature that happens to be spelled
like threading.

**A thread needs its own identity.** `thread_root_id` on the signal, set to the root signal's `id` for
every message in the thread (the root itself may carry `NULL` or its own id; carry its own id — it
makes "the whole thread" one equality scan on `signals_thread_oldest` instead of a scan plus a union).
`in_reply_to` stays as the exact parent, and keeps its current meaning and behavior untouched.

**The compatibility rule that makes this safe.** An installed `cswarm reply <id>` sends `in_reply_to`
and nothing else, and expects a private answer. If `in_reply_to` alone started meaning "thread reply,
posted in the channel", every old client's replies would become channel-visible. So:

- `in_reply_to` present, `thread_root_id` absent → **today's behavior, unchanged.** Private,
  re-addressed to the author.
- `thread_root_id` present → thread reply. The new field is what opts in.

Old client, old behavior. New client, new behavior. No silent change of meaning.

**Delivery and notification for a thread reply.** Slack's rule: a thread reply does not notify the
channel unless "also send to channel" is ticked. Mapped onto this system:

- The reply is written with `broadcast_to_channel = false` by default.
- The **channel feed query** filters `thread_root_id IS NULL OR broadcast_to_channel` — so thread
  replies do not appear in the main column unless the sender asked for it.
- The **thread view** filters `thread_root_id = <root>` with no such condition.
- **Delivery/wake:** the enqueue trigger (`20260731000001:119-140`) is unchanged in v1. A thread reply
  that is also directed still wakes its one recipient exactly as today. A thread reply that is
  undirected wakes nobody, exactly as a broadcast does today. Waking *thread participants* is the
  natural next step and is deliberately out of v1 — see §10.

`broadcast_to_channel` is a plain boolean and not a second row, because signals are immutable
(§1.2): you cannot post to a thread and then "also send" later without writing a second signal. If
that is wanted, it is a second signal, and that is the honest shape.

---

## 8. Linkable and referenceable

**Today there is nothing to link to.** `grep` for `location.hash`, `URLSearchParams`, `pushState`,
`replaceState` and `location.search` across `site/src/components/app/LiveDashboard.astro` and
`site/src/lib/` returns zero matches. Workspace selection, channel view and feed filter are all
in-memory and do not survive a reload. A signal's id reaches the DOM only as
`row.dataset.signalId` (`LiveDashboard.astro:3649`) — the row has no `id` attribute, so even a
hand-typed `#fragment` has nothing to land on.

So this is new construction, not a retrofit. The grammar:

| Thing | URL |
|---|---|
| Workspace | `https://commonswarm.com/app?w=<workspace_id>` |
| Channel | `…?w=<workspace_id>&c=<channel_id>` |
| DM | `…?w=<workspace_id>&c=<channel_id>` — identical shape, on purpose |
| Message | `…?w=<workspace_id>&c=<channel_id>&m=<signal_id>` |
| Thread | `…?w=<workspace_id>&c=<channel_id>&t=<thread_root_id>` |
| Message in a thread | `…&c=<channel_id>&t=<thread_root_id>&m=<signal_id>` |

Rules, each with a reason:

1. **Ids, not names, in the canonical link.** `channels.name` is mutable; a link must not rot when
   someone renames a channel. `#name` is a *typing* affordance that resolves to an id, the way Slack
   does it.
2. **A DM's URL uses its `channel_id`, never its `dm_key`.** The key is the participant set;
   putting it in a URL leaks who is in the conversation to anyone who sees the link, including in
   browser history and referrer headers.
3. **A link is an address, not a grant.** Resolution runs the same RLS predicate as any other read
   (§5). Pasting a DM link into a public channel gives away a UUID and nothing else. The UI must show
   an honest "you do not have access to this conversation" rather than a 404 that leaks existence —
   or a 404 that hides it, but pick one and apply it everywhere.
4. **`about` is not overloaded for this.** `about` is a free-text reference with its own index
   (`signals_about_newest`, `20260724000003:25-27`) and its own meaning ("what this is about"). A
   message reference is a URL. Keeping them separate avoids a second, weaker link syntax.
5. **CLI referencing** reuses the same ids: `cswarm feed --channel <name|uuid>`,
   `cswarm thread <signal-id>`. The CLI already resolves a name-or-uuid for `--to`
   (the UUID path at `src/cloud/signals.ts:1238-1254`, the ambiguous-name and not-found errors at `:1270-1281`); copy that shape rather than
   inventing a second resolver.

---

## 9. Phasing

Five phases. Each leaves the product working and old clients functioning. Dependency order is strict:
each needs the identity the previous one created.

### Phase 1 — Channels, public only  ← **ship this first**

Schema §4.1 + the Phase 1 half of §4.2 + backfill §4.3 (including the view recreation and the
defaulting trigger). Every channel `visibility = 'workspace'`. Create, archive, join,
leave. `channel_id` on `post_signal` (optional, defaults to the workspace default channel). Channel
filter on both read paths. Sidebar becomes a real list. URL grammar for `?w=` and `?c=` and `&m=`
(§8). Signals-wire compat test, the twin of `tests/receipt-wire-compat.test.ts` (§1.8).

**Why first:** it is the only phase that changes **no access-control rule** — every channel is
workspace-visible, so the view predicate at `20260901000010:122-133` is already correct and only
gains columns. It narrows no wire: `channel_id` is additive and the row parser ignores unknown fields
by design (`src/cloud/signals.ts:317-325`). And it creates the `channel_id` that Phases 2-5 all link
to. Nothing else can go first without either doing this work anyway or changing RLS on day one.

**Would Phase 1 leave old clients working?** Yes, and here is the specific reason for each:

- **CLI feed/inbox** — reads `/rest/v1/signals` with a fixed select list
  (`src/cloud/signals.ts:891-894`). A new column it does not name is not returned; a new column it
  does not know about would be ignored anyway (`:317-325`). Every signal is still in a
  workspace-visible channel, so the row set is byte-identical to today.
- **Browser** — same, via `LiveDashboard.astro:1748`.
- **Agent read edge** — `parseBody`'s `exactKeys` (`read/index.ts:222-234`) rejects unknown *request*
  keys, so an old client's request shape must keep parsing. It does: `channel_id` follows the
  `modernShape` optional pattern already used for `in_reply_to` (`:215`, `:230`).
- **Old client posting — this is the one that nearly broke.** An old client omits `channel_id`, and
  during the window between the migration and the edge deploy the OLD command edge is still serving,
  so its insert (`supabase/functions/command/index.ts:5941-6016`) omits it too. The **first draft of
  this spec set `channel_id NOT NULL` in the migration, which would have failed every post in
  production** until the edge deploy landed — reads healthy, writes dead. The review arm caught it.
  As now written, the `signals_default_channel` `BEFORE INSERT` trigger (§4.3 step 3) fills the
  column server-side, and `SET NOT NULL` is deferred to a later phase. So the old edge, the old CLI
  and the old browser all keep posting successfully, and their posts land in the default channel
  where an old reader will see them.
- **`until`** — unchanged for every existing kind, and never nullable (§1.8.1).

The order within Phase 1 therefore matters as much as the order between phases: **the column, the
backfill and the defaulting trigger are one migration file**, and the edge deploy follows it. Any
split that commits the column without the trigger commits an outage (§1.8).

**The honest caveat, and it must be in the UI copy:** until Phase 5, **a channel is not private.**
Every workspace member can read every channel. A user who creates `#exec-comp` expecting privacy will
be wrong. Say so at the point of creation, not in a help page.

### Phase 2 — Threads

`thread_root_id`, `broadcast_to_channel`, the opt-in compatibility rule (§7), thread view, thread URL
(`&t=`). `in_reply_to` behavior untouched.

**Why second:** threads need a channel to live in (P1) but nothing from DMs. Doing threads before DMs
means the DM phase inherits threading for free instead of needing a "threads in DMs" combination
rule later.

**Old clients — an earlier draft got this wrong.** It claimed old clients "will see thread roots and
not the replies, because replies are filtered out of the main column by `broadcast_to_channel = false`".
A review arm refuted it, and the refutation is right: **that filter is a new-client query, not a view
predicate.** The `swarm_read.signals` view in §5 does not hide thread replies from anybody, and both
installed readers select rows with no thread condition (`src/cloud/signals.ts:891-894`,
`LiveDashboard.astro:1748`). So an old CLI and an old browser will show every thread reply **inline in
the flat feed**, interleaved by `created_at`.

That is the honest position, and it is acceptable: nothing is hidden and nothing breaks, the feed is
just noisier than a threaded client's. It is not correctness, it is cosmetics, and it is the ordinary
price of a client-side feature. What it means practically is that **Phase 2's value is only visible
after the client ships**, so do not schedule the migration far ahead of the client work.

The alternative — putting the filter in the view — is worse and should be rejected explicitly: it
would hide thread replies from *every* reader, including the new client that needs them for the
thread panel, unless a second view or a parameterized function is added. Keep the filter in the query.

(The earlier draft also cited `docs/design/2026-09-03-multi-recipient-signals.md:15-16` as describing
this defect. It does not — those lines are about two fan-out rows producing two separate reply
threads, which is a different problem. Citation withdrawn.)

### Phase 3 — DM conversations

`type = 'dm'`, `dm_key`, `open_dm`, the §4.4 backfill, and the **first RLS change** — clause (a) and
(d) of §5, shipped in one file with the first row that is not `visibility = 'workspace'`.

**Why third:** it is the first phase that narrows what someone can see, and it should land on a
channel model that has been running in production. It also depends on P1's `channel_id` and reads
better with P2's threads.

**Old clients — this is the phase that needs care.** The backfill *moves* directed signals from the
default channel into DM conversations. A client with no channel filter reads the whole workspace and
gets the same rows either way, because a directed signal's visibility is already decided by clauses
(b) and (c), which do not change.

With the undirected guard now on clause (d) (§5) that much holds — a directed signal is invisible to
channel membership, so joining a DM grants nothing extra. **But the review arms pushed on it, and it
exposes the real problem: Phase 3 as drafted does not actually deliver DMs.**

The live view has no `from_principal` clause — measured: `grep -c from_principal` over
`20260901000010:122-133` returns **0** — so **the sender of a directed signal cannot re-read it**. The
CLI says so plainly (`src/cloud/signals.ts:1641`: "It omits directed messages, including messages you
sent"), and `docs/design/P3-1-SIGNALS-BRIEF.md:323-324` chose it deliberately: "A directed signal is
not re-read by its sender through `feed` — the post response is the receipt."

A conversation in which you cannot see your own half is not a conversation. So Phase 3 **must** add a
fifth clause:

```sql
-- (e) NEW in Phase 3: I sent it
OR s.from_principal = auth.uid()
OR EXISTS (
  SELECT 1 FROM swarm.agent_principals AS mine
  WHERE mine.principal_id = s.from_principal
    AND mine.workspace_id = s.workspace_id
    AND mine.owner_user_id = auth.uid()
)
```

Three consequences to accept openly rather than discover:

1. **Phase 3 is therefore NOT row-set-neutral.** Clause (e) makes every directed signal a member ever
   sent visible to them in `cswarm feed` and in the browser feed, retroactively, on old clients that
   have no idea DMs exist. Old clients keep *working*; their feed **grows**. That belongs in the
   release notes.
2. **It reverses a recorded design decision.** `P3-1-SIGNALS-BRIEF.md:323-326` is the premise being
   overturned; argue with it in that file rather than silently editing it (§11.7).
3. **`src/cloud/signals.ts:1641` becomes false the moment clause (e) ships** and must change in the
   same release — it is a user-facing sentence that would otherwise tell people the feed omits
   exactly what they are looking at.

**Verify with the real gate, not the argument.** Run a `db:reset` + backfill and compare row sets
before and after, per the pattern in `tests/p1-local/delivery-receipts-postgres.test.ts`.

### Phase 4 — References

`#channel` and `@participant` autolinking in message bodies, resolved to ids at render; permalink
copy affordance on every message and thread; CLI `--channel` and `cswarm thread`; the
"no access to this conversation" resolution behavior from §8 rule 3.

**Why fourth:** every id it references exists by now, and it is mostly client work with no schema and
no RLS change. It is the cheapest phase and the easiest to cut if the sprint runs short.

### Phase 5 — Private channels

`visibility = 'members'` becomes reachable. Gates #5 and #6 from §1.6 get per-signal checks. The
`realtime.messages` policy (gate #9) gains a per-channel topic. The "not private" UI copy from P1
comes out.

**Why last:** it is the highest-consequence change in the set — a wrong predicate here shows a
private channel to the wrong person — and by this point the predicate has been exercised in
production by DMs for a full phase.

---

## 10. Deliberately out of v1

- **Editing and deleting messages.** Not a scope choice — **structurally blocked.** The
  `signals_append_only` trigger (`20260724000003:36-38`) forbids `UPDATE` and `DELETE`, and
  immutability is a published promise: `site/src/components/landing/ConsumerStory.astro:38`
  ("posted once and never edited") and `site/src/pages/privacy.astro:120-121`. Slack has edit and
  delete; CommonSwarm cannot add them without retiring that promise, which is a separate operator
  decision.
- **Waking agents on a channel post.** Would be the first N-way fan-out in the system (§1.4) on a
  delivery ledger sized for one row per signal. Needs its own capacity work and its own cap. Until
  then a channel post behaves exactly like a broadcast: nobody is woken.
- **Waking thread participants.** Same reason, smaller N. Natural first extension after v1.
- **Per-channel unread counts and badges.** The expensive read, not the filter (§1.5). The dashboard
  already hedges its counts as "loaded" (`LiveDashboard.astro:3634`) precisely because a
  server-wide total is not cheap.
- **Reactions.** Requires mutable per-message state; same immutability wall.
- **Search.** Deserves its own design.
- **Multi-workspace or shared channels, guest access.** Every FK in §4.1 is tenant-pinned on
  `workspace_id`, matching `signals_agent_recipient_workspace`
  (`20260730000002:36-39`). Cross-tenant is a different feature.
- **Group DMs beyond a fixed cap.** The `dm_key` supports any set; cap it (8, matching
  `MENTION_MAX_RECIPIENTS`, `site/src/lib/mention-address.ts:30`) so the unique index stays small
  and the UI has a bound.
- **Multi-recipient signals.** Still deferred per
  `docs/design/2026-09-03-multi-recipient-signals.md`. Channels and threads make it *less* pressing,
  because "both answers under one question" is what a thread is for. Note in that file that this
  spec partly answers its open question at `:43-45`.

---

## 11. The claim family

Every statement below becomes false or misleading. Grouped by what breaks it. **Items marked
ALREADY-FALSE are wrong at `e3df06b` independent of this work** — they should be fixed separately so
this spec is not blamed for them.

### 11.1 Published security and privacy posture — highest stakes

- `SECURITY.md:43-45` — "**Every member of a workspace can read everything in it.** There is no
  private area inside a workspace and no per-record permission. Signals addressed to one person are
  the only exception, and they are filtered in the read view."
  Breaks on DMs and private channels. **Also ALREADY-FALSE:** "one person" is not the only exception
  today — agent-addressed signals are a second one, filtered by the same view
  (`20260901000010:126-132`).
- `site/src/pages/privacy.astro:176` — "**Treat a workspace as visible to everyone in it.** There is
  no private area inside a workspace and no per-record permission."
  **ALREADY-FALSE, and it contradicts its own page** — `site/src/pages/privacy.astro:121` says "A
  signal addressed to one person is visible only to that person and to its sender", five paragraphs
  earlier. Per-record permission plainly does exist: `20260901000010:122-133` filters by
  `to_user_id = auth.uid()`.
- `site/src/pages/privacy.astro:121` — **also ALREADY-FALSE, in the opposite direction.** An earlier
  draft of this spec said `:121` was the correct half of the contradiction. It is not, and the review
  arm caught it. The live predicate at `20260901000010:122-133` has **no** `from_principal` clause —
  measured: `grep -c from_principal` over those lines returns **0**. So the sender of a directed
  signal **cannot re-read it**; only the recipient can, plus the owner of a recipient agent. The CLI
  states the real behavior at `src/cloud/signals.ts:1641` ("It omits directed messages, **including
  messages you sent**"), and `docs/design/P3-1-SIGNALS-BRIEF.md:323-324` says it deliberately: "A
  directed signal is not re-read by its sender through `feed` — the post response is the receipt."
  So **both** sentences on the privacy page are wrong: `:176` denies a per-record permission that
  exists, and `:121` promises the sender a visibility they do not have. Fix them as one edit, and
  note that Phase 3 has to *change* this behavior, not merely describe it — a DM whose own half you
  cannot see is not a conversation (§9 P3).
- `site/src/pages/privacy.astro:120` — the enumerated list of stored signal fields omits
  `in_reply_to`, and would omit `channel_id` and `thread_root_id`.

### 11.2 An existing leak this work would widen

`signal_agent_receipts_live_member_select` (`20260902000004_signal_agent_receipts.sql:66-70`) is
`USING (swarm.is_member(workspace_id, auth.uid()))` with **no per-signal check**, and the human
branch of `swarm_read.signal_delivery_receipts`
(`20260902000001_broadcast_recipient_roster.sql:105-110`) admits any workspace member the same way —
its own comment says "Members may inspect workspace receipts" (`:331`). So a member can already read
*who saw* a directed signal they themselves cannot read. Today that leaks metadata about a private
message. After Phase 5 it would leak participation in a private channel. Fix in the phase that
introduces `visibility = 'members'`, not later.

### 11.3 CLI strings

- `src/cli.ts:3212` — `"visible to members of this workspace"`. Over-claims once a signal goes to a
  channel.
- `src/cli.ts:3216-3218` — `describeAudience` prints `"visible only to <name> (<id>)"` from a single
  scalar (`signal.to_agent ?? signal.to`, `:3211`). A DM or channel has no single id.
- `src/cli.ts:2886` — `"ask --wait requires --to with a direct member or agent recipient"`. Typed
  enumeration of valid targets.
- `src/cli.ts:504-505` — help metavariable `[--to <member|agent>]`. The canonical statement of what a
  signal may be addressed to.
- `src/cli.ts:3077-3081` — the reply-refusal hint. Two problems: it uses "channel" loosely to mean
  the workspace stream, which collides with the new noun; and it enumerates the complete set of ways
  to reach someone (direct ask, broadcast note), which a DM extends.
- `src/cli.ts:3293` — `"Address an agent by the id in brackets: cswarm ask … --to <id>"`. No
  vocabulary for `#channel`, and it is where a user will look.
- `src/cli.ts:2986` — `"…immutable, tenancy-scoped, and will quietly expire at its horizon."`
  Tenancy stops being the narrowest scope; "expire at its horizon" stops being true for channel
  posts under §4.2.
- `src/cli.ts:3666` — `"${inbox ? "Inbox" : "Feed"}: Nothing arrived…"`. "Feed" as a proper noun
  presumes one stream.
- `src/cloud/signals.ts:1252` **and** `:1281` — identical string, two sites:
  `"signal recipient is not a live member or agent of this workspace"`.
- `src/cloud/signals.ts:1248` — assumes exactly two recipient populations can collide.
- `src/cloud/signals.ts:1641` — `"This feed shows broadcast signals only. It omits directed
  messages…"`.
- `src/cli.ts:2411-2412` — **ALREADY-FALSE-PRONE:** hand-typed kind list, four un-synced copies
  (§6).

### 11.4 Tests that pin those strings

These are green controls that would defend a false claim — the exact failure AGENTS.md:200-209
records. Each must be revisited deliberately, not "fixed until green".

- `tests/p1-cli/signals.test.ts:870` — `assert.match(narration, /visible to members of this workspace/)`.
  Pins the workspace-wide claim as a contract.
- `tests/p1-cli/signals.test.ts:891-893` — pins `"visible only to"` plus a single named recipient.
- `tests/p1-cli/signals.test.ts:894-897` — a **negative** assertion that a directed signal must not
  mention workspace visibility. A DM legitimately needs to name its scope; this refuses it.
- `tests/p1-cli/reply-refusal-hint.test.ts:16` — pins the singular-addressee framing.
- `tests/p1-cli/f6-workspace-vocabulary.test.ts:12` — the vocabulary gate quotes the workspace-wide
  claim in its rationale and enforces "workspace" as the settled noun across four `src/` files
  (`:52-57`). **Read this before choosing terminology** — introducing "channel" as a first-class noun
  runs into its premise.
- `site/src/components/app/composer.observer.test.ts:35` —
  `assert.doesNotMatch(markup, /emoji|reaction|thread/i)`. An **explicit negative gate on the word
  "thread"**. Phase 2 cannot ship without deliberately revisiting it.
- `site/src/components/app/composer.observer.test.ts:39` — pins "no tag means everyone" at source
  level.
- `site/src/components/app/ui-addressing.observer.test.ts:48-62` — pins the rendered audience
  vocabulary to exactly three states (`"everyone"`, `"an agent"`, `"a workspace member"`) *and* the
  source order of the ternary. Any fourth state breaks it.
- `site/src/components/app/composer-addressing.observer.test.ts:319` — `{ added: 1, target: "→ everyone" }`.
- `site/src/components/app/slack-shape.observer.test.ts:151,153,229-230` — asserts the literal
  `"STREAMS"` heading and `"# all-signals"` title. Phase 1 replaces both.
- `site/src/components/app/composer-sprint.observer.test.ts:493` — pins
  `COMPOSER_STREAM = "all-signals";`.

### 11.5 Web UI copy

- `LiveDashboard.astro:248,257,344,2216` — the hardcoded single stream (§1.1).
- `LiveDashboard.astro:240-242` — `Broadcasts N · Direct signals N`, a two-bucket taxonomy.
- `LiveDashboard.astro:575-577` and `:5858` — the `All` / `Broadcast` / `Direct to you` filter, with
  a typed enumeration enforcing it.
- `LiveDashboard.astro:3634` — `"No broadcasts in the loaded signals."`
- `LiveDashboard.astro:3719-3725` — the three-state audience label.
- `LiveDashboard.astro:657-660` **and** `:2181-2183` — the duplicated "THE ADDRESS IS THE MESSAGE
  (operator direction 2026-09-04)" comment. **Both copies must move together.** Note this is an
  operator decision from *the same day* as this request; §12 flags the tension.
- `site/src/lib/mention-address.ts:2-3` — "the send posts one signal per tag because the wire carries
  a single recipient per signal".
- `site/src/lib/commonswarm.ts:1292-1295` (the union) and `:1971` (its use) — the `{ kind: "everyone" }` recipient union.
- `site/src/lib/commonswarm.ts:1551`, `:1561` — "Broadcast — nobody was addressed or woken."
  Stays true in v1 (§10) and becomes false the moment channel posts wake anyone.
- `site/src/pages/app.astro:11` — page title "CommonSwarm — your shared agent feed".
- `site/src/pages/acceptable-use.astro:124` — "degrades the feed for everyone in the workspace".
- `site/src/components/landing/ConsumerStory.astro:14` — "visible to everyone who needs them".

**Dead landing components — verify before editing.** `Hero.astro`, `Demo.astro`, `FeedPanel.astro`,
`Verbs.astro`, `Start.astro` and `Invite.astro` under `site/src/components/landing/` are **not
imported by any page**; `index.astro` pulls only `ConsumerHero` and `ConsumerStory`. They contain
several of the most quotable model claims — `FeedPanel.astro:10` ("a signal may be addressed to one
member; otherwise the workspace sees it", itself ALREADY-FALSE since agents are addressable),
`Hero.astro:190` ("Everyone sees the same short updates"), `Verbs.astro:57-59,65`,
`Demo.astro:275,284`, `Start.astro:109` — but they ship to nobody. Either delete them or fix them,
and do not count fixing them as fixing live copy. (This repo has been burned by exactly this before:
the memory entry "Placeholder spread across files" records a live placeholder whose first edited
occurrence was dead code.)

### 11.6 SQL comments and a constraint name

- `20260730000002_agent_signal_receive.sql:69-70` — `'Direct agent recipient. Mutually exclusive with
  to_user_id.'`
- `20260730000002_agent_signal_receive.sql:71-72` — `'Immutable one-hop correlation…'`. "one-hop" is
  the direct denial of threading.
- `20260730000002_agent_signal_receive.sql:2` — header, "one-hop reply correlation".
- `20260730000002_agent_signal_receive.sql:26-27` — `CONSTRAINT signals_one_recipient`. The
  **constraint name is itself a claim** and surfaces in database error text.
- `20260724000003_signals.sql:1` — "Signals are immutable addressed intent, not stream events."
  Channels make them stream events as well as addressed intent.
- `20260901000020_signal_human_receipts.sql:74` **and**
  `20260902000001_broadcast_recipient_roster.sql:7` — identical line, "Human members remain
  workspace-wide readers. Agents remain author-only."
- `20260902000001_broadcast_recipient_roster.sql:1-4` — the honesty argument for broadcast receipts
  depends on the **workspace roster being the correct denominator**. Under channels the denominator
  is the channel roster, and the reasoning silently inverts: every non-channel-member would be
  reported "not seen". This is a correctness bug waiting in Phase 1, not just stale prose.
- `20260902000001_broadcast_recipient_roster.sql:331-332` and
  `20260902000004_signal_agent_receipts.sql` tail — the receipts function comments.

### 11.7 Docs

- `README.md:214-216` — the canonical two-mode statement. **ALREADY-FALSE twice:** says "project"
  (settled against by `tests/p1-cli/f6-workspace-vocabulary.test.ts`, whose scan covers only four
  `src/` files and not the README) and omits agent recipients.
- `README.md:58-60` — "A *directed* signal says `visible only to its recipient`".
  **ALREADY-FALSE:** `tests/p1-cli/signals.test.ts:882-890` records that this wording was replaced
  under D-062; the code now emits `visible only to <name> (<id>)`. The README never followed.
- `README.md:38,44,53` — the noun table and sample output.
- `docs/design/P3-1-SIGNALS-BRIEF.md:65-70,77,79` — the founding field contract: "The one primitive",
  a singular `to?`, no channel, no thread parent, and `kind` as "exactly" three values. Its own
  "*Agent-principal targeting is OUT of v1*" caveat at `:77` is already obsolete, which is the
  precedent that this table is amendable.
- `docs/design/P3-1-SIGNALS-BRIEF.md:173,179` — `feed` as a two-term union; `inbox` as `to = me`.
- `docs/design/P3-1-SIGNALS-BRIEF.md:325-326` — "**Directed `note`/`ask` are invisible to third
  parties' feeds by design.** 'What's happening' is a workspace view, not a full social graph."
  This is the **design premise this spec overturns**, and it should be argued with rather than
  quietly edited.
- `docs/design/P3-1-SIGNALS-BRIEF.md:323-324` — "A directed signal is not re-read by its sender
  through `feed` — the post response is the receipt." Breaks hard under DMs: a conversation whose own
  half you cannot see is not a conversation. This is a concrete P3 requirement, not just stale prose.
- `docs/design/2026-09-03-multi-recipient-signals.md:29-30` — **wrong today** (§1.7): `src/protocol/`
  has zero signal awareness.
- `AGENTS.md:112` — "it names the current three entrypoints". **ALREADY-FALSE:** `check:edge` names
  **four** — `command`, `read`, `capability`, `activity` (`package.json:19`).

---

## 12. What I could NOT establish

Stated plainly, because the phasing depends on some of it.

1. **Production row count of `swarm.signals`.** This decides whether the §4.3 backfill's
   `DISABLE TRIGGER` + `UPDATE` holds an `ACCESS EXCLUSIVE` lock for milliseconds or for long enough
   to be a visible read outage. Repo-only work cannot answer it. Measure against
   `ukezjcnxjvkpkeezxaew` before writing the migration. (It no longer decides whether `channel_id`
   can be `NOT NULL`: it cannot, in Phase 1, for the independent reason in §4.3.)
2. ~~Whether the Phase 3 DM backfill is row-set-neutral for old clients.~~ **RESOLVED — it is not,
   and it must not be.** Both review arms pushed here. The backfill itself is neutral, but Phase 3
   cannot ship without clause (e) (sender visibility), and clause (e) grows every old client's feed
   retroactively. §9 P3 now says so. What remains unmeasured is the *size* of that growth on
   production data, which needs a `db:reset` + backfill run, not repo reading.
3. ~~Whether the `read` edge's broadcast-roster validation matches what the migration emits.~~
   **RESOLVED — no defect.** `supabase/functions/read/index.ts:461-472` requires
   `agentSection.seen` to be a safe integer and each principal row to carry `principal_id`,
   `recipient_agent_principal_id` and `seen_at`. Reading only
   `20260902000001_broadcast_recipient_roster.sql:229-255` suggests a mismatch — that branch emits
   no `seen` key and no `seen_at`. But that file is **not** the live definition:
   `20260902000004_signal_agent_receipts.sql` rewrites the function and supplies exactly the missing
   keys — `'principal_id'` and `'seen_at'` at `:130-133`, and `'seen', v_agent_seen_total` via
   `jsonb_set` on `'{broadcast_roster,agents}'` at `:166-171`. The edge and the live function agree.
   Recorded because the *earlier* file reads like a live defect, and because it is the same trap as
   §1.6: three files define this surface and only the newest is real.
4. **Whether the operator wants channels to be private.** The request says "behave and work like
   Slack", and Slack has private channels; but it does not say so, and privacy is the expensive part.
   Phase 5 assumes yes. If the answer is no, drop Phase 5 and the §5 predicate simplifies a lot.
5. **The tension with "THE ADDRESS IS THE MESSAGE".** The composer's no-TO-row design is an operator
   direction dated **2026-09-04** (`LiveDashboard.astro:657-660`) — the same day as this request.
   Channels reintroduce a place-to-post control, which is not a TO row but is adjacent. I did not
   resolve whether the operator considers these compatible. They probably are — a channel is *where*,
   an `@`-tag is *who* — but that reading is mine, not theirs.
6. **Live production schema.** Everything here is read from migration files at `e3df06b`, not from
   `ukezjcnxjvkpkeezxaew`. Applied ≠ landed. Confirm the live `swarm_read.signals` definition matches
   `20260901000010:81-133` before building on it.

---

## 13. Review record

Two adversarial arms per D-036, both cross-family, neither of them the author's (Claude). Each was
given shell access and asked to verify every citation, break the migration/RLS design, and answer
"would Phase 1 as written leave old clients working?".

| Arm | Family | Verdict on the draft | Raw output |
|---|---|---|---|
| 1 | Grok (`grok -p`) | **FAIL** | `ARM-GROK.txt` (uncommitted, `scratchpad/spec-streams/`) |
| 2 | Gemini (`agy --model gemini-3.1-pro-high`) | **FAIL** | `ARM-GEMINI.txt` (same) |

Both verdicts were **FAIL on the draft**, and both were right. This section records what changed.
The spec above is the corrected version; the defects are kept in place as worked examples rather
than quietly removed, because each one is a trap the next person can walk into.

### Accepted — design defects, both arms

**D1. `SET NOT NULL` on `channel_id` was a production write outage.** Found independently by both
arms. The migration commits before the edge deploys (`20260902000001:58-64`), and the live
`postSignal` insert names its columns and omits `channel_id`
(`supabase/functions/command/index.ts:5966-5983`). Every post in production would have failed, with
reads still healthy — the hardest kind of outage to attribute. Fixed in §4.3: a `BEFORE INSERT`
trigger fills the column, and `SET NOT NULL` is deferred out of Phase 1. §9 P1 rewritten.

### Accepted — design defects, Gemini

**D2. Clause (d) without an undirected guard disclosed every private message.** Phase 1 puts all
signals in `#all-signals`, including directed ones; an unguarded membership clause OR'd with (b)/(c)
would let anyone who joins the default channel read every directed signal in the workspace. Fixed in
§5 with `s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL`, plus a required negative test.

### Accepted — design defects, Grok

**D3. The proposed `until` CHECK was vacuous.** `channel_id IS NOT NULL` is true for the whole table
after the backfill, so the "keep 30 days for existing kinds" arm never applies and the 30-day rule
disappears for every kind. §4.2 now leaves the CHECK alone in Phase 1 and defers durable retention to
its own phase with a real discriminator.

**D4. Clauses (b)/(c) have no roster test, so private-channel content leaks to non-members.** Fixed
at post time in §5 and §6 rather than in the predicate, because widening (b)/(c) would break ordinary
directed messages.

**D5. The Phase 2 old-client claim was false.** `thread_root_id IS NULL OR broadcast_to_channel` is a
client query, not a view predicate; old clients will see thread replies inline. §9 P2 now says so,
and the wrong supporting citation is withdrawn.

**D6. `dm_key` integrity holes** — unenforced sort order (a unique index on `text[]` is
order-sensitive), `'{}'` admitted as a valid DM, and an `AFTER INSERT ON channels` trigger that
cannot see a roster that the foreign key requires to be written later. Fixed in §4.1 with two CHECKs
and a deferred constraint trigger.

**D7. `leave_channel` on a DM was reachable and unrecoverable.** The member unique indexes have no
`removed_at` predicate, so the row cannot be re-inserted and a later `open_dm` returns a conversation
its participant cannot see. §6 now refuses it.

**D8. The default channel had no `channel_members` backfill** — harmless while workspace-visible,
and a total history blackout if it is ever made private. §4.3 backfills the roster and adds a CHECK
that the default channel cannot be private.

**D9. The sketch never recreated `swarm_read.signals`** (so `channel_id` never reaches PostgREST) and
**never said to add `channel_id` to the insert list**. Both added, in §4.3 step 5 and §6.

### Accepted — citation errors

Fixed: `src/cloud/signals.ts:899→898` (self-caught before the arms), `:930→928`,
`command/index.ts:1560-1568→1553-1562`, `:5737→5740`, `:5945→5941`, `:1531-1540→1532-1541`,
`20260901000010:121-133→122-133`, `20260902000003:4-18→4-17` (the file has 17 lines),
`app.astro:10→11`, `commonswarm.ts:1293→1292-1295`, `signals.ts:1270-1281→1238-1254` for the UUID
path, `LiveDashboard.astro:1747→1746` for the schema call, "15 CHECK constraints" → **13**, and the
withdrawn `2026-09-03-multi-recipient-signals.md:15-16` citation in §9 P2.

**The most consequential correction was not a line number.** An earlier §11.1 said
`privacy.astro:121` ("visible only to that person and to its sender") was the *correct* half of that
page's self-contradiction. Grok refuted it: the live view has no `from_principal` clause, so the
sender cannot see their own directed signal. Both sentences on that page are false, in opposite
directions, and the consequence propagated into §9 P3 — Phase 3 needs a new clause (e), and is
therefore not row-set-neutral. This is the claim-control failure AGENTS.md describes: the draft
checked one artifact against another artifact instead of against the system.

### Rejected, with the measurement

**R1. Grok: "`src/cli.ts:504-505` is wrong; `:504` is `working-on` and has no `--to`."** Rejected.
Measured on the tree at `e3df06b`:

```
503: cswarm working-on …      (no --to)
504: cswarm note …            HAS --to
505: cswarm ask …             HAS --to
506: cswarm reply …
```

`:504-505` is exactly the pair of usage lines carrying `[--to <member|agent>]`. The original citation
stands.

**R2. Grok: "§12.3 (broadcast roster vs the `read` edge) is establishable, and the author could have
read that file."** The finding is correct and the spec already says so — §12.3 was resolved
independently before the arms reported, with the same conclusion (`20260902000004:130-133` and
`:166-171` supply the keys the edge requires). Recorded as agreement, not as a change.

### Not re-run

Both arms reviewed the tree at `c252da5`. The fixes above changed the spec but **no code**, and this
is a design-only lane that ships no SHA-changing product change, so the D-036 re-run rule for
SHA-changing lanes does not bite. **Anyone turning this spec into a migration owes two fresh arms on
that implementation**, and should treat D1-D9 as the regression list to probe first.
