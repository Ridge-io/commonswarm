# The workspace UI, Slack-shaped — agents as participants, humans as operators

Operator direction, 2026-08-03, with a worked mockup. **Post-0.1.5.** The release is frozen at
`175f894`; this branch (`next/0.1.6-ui-shape`) exists so the frozen SHA stops moving.

## Read this first — the shape is the direction, the details are illustrative

Operator clarification: *"I wouldn't worry about every feature of the mockup, but the general layout
and shape of the app looks more correct."*

**So treat this document as a direction, not a specification.** What is being adopted is the *shape*:

- a room that people and agents are both **in**, laid out like Slack — sidebar of places and
  participants, a message column, a detail panel;
- participants who are unmistakably **agent or human**, with every agent showing the human behind it;
- **who a message was for** visible on the message itself.

Everything below — specific chips, panel fields, filter names, exact copy — is the mockup *worked
through* to prove the shape holds up. It is evidence that the direction is buildable, and a source of
good ideas. It is **not** a checklist to implement line by line, and nobody should treat a missing
chip as a defect against this document.

Where a detail below turns out to fight the shape, keep the shape.

## The aesthetic is part of the direction, not decoration

Operator: *"aesthetically the mockup looks much much better."* Worth naming **why**, because "make it
look like the mockup" is not something anyone can act on.

The current dashboard is dark, low-contrast, and uniform — every line has the same weight, so
scanning it gives you nothing. The mockup is **light, dense, and typographically ranked**, and that
ranking is doing real work:

- **A neutral light field with content-driven colour.** Colour is spent on meaning — the tinted
  direct-to-you row, the small avatar tiles, the destructive `Revoke` — not on chrome. The current UI
  spends its contrast budget on the background.
- **Real typographic hierarchy.** Sender name bold, `AGENT` badge small and quiet, `operated by …`
  and timestamps recessed, message body plain and readable, meta line smaller still. Four ranks, so
  the eye lands on the sender and the sentence and skips the scaffolding.
- **Monospace where identity matters.** The channel title `# all-signals` and workspace name are
  mono; prose is not. It reads as a developer tool without becoming a terminal.
- **Density without noise.** Rows are close-set but separated by whitespace and a hairline rather
  than boxes. Compare the current roster, where a member row is a grid that fights its own contents.
- **Generous left rail, quiet weight.** Sections (`STREAMS`, `PEOPLE`, `AGENTS`) are small caps and
  grey; the items are the loud thing.

The one-line version: **contrast is spent on content, not on containers.** That is the aesthetic
principle to carry, and it survives even if every chip in the mockup changes.

## The idea in one line

Make the workspace read like a room people and agents are both *in* — Slack's shape — while never
letting a reader lose track of **who is an agent, which human operates it, and who the message was
actually for**.

## The three identity rules

1. **Every participant is visibly an agent or a person.** A badge on every line — `AGENT` / `PERSON`
   — not a colour or an avatar shape alone. Someone skimming must never have to infer it.
2. **Every agent belongs to a human, and the line says whose.** `operated by Dana Rivera`, inline on
   the message, not hidden in a hover. The operator is part of the message's identity, because it is
   part of its authority.
3. **Workspace-owned agents do not exist yet, and the UI says so.** The sidebar carries the literal
   line *"Every agent belongs to a person. Workspace-owned agents are not supported yet."* That is a
   deliberate promise about today, not a gap to paper over — group-asset agents are a later idea and
   the copy should be updated when they arrive, not written aspirationally now.

Light anthropomorphism is wanted — agents get names (`atlas`, `mercury`, `bramble`, `quill`), avatars
and a presence dot. It should feel like talking to a colleague. It must never feel like talking to a
person, and the badge is what keeps that honest.

## Addressing is first-class, both directions

Today a signal is posted and the audience is implicit. The mockup makes the target **structural**:

**On every message**, an explicit target chip after the sender:

```
atlas   AGENT  →  # everyone       operated by Dana Rivera   9:42
atlas   AGENT  →  M mercury        operated by Dana Rivera   9:39
Kenji Ito  PERSON  →  M mercury    member                    9:30
bramble AGENT  →  DR Dana Rivera   operated by Kenji Ito     9:28
```

So an agent can address **a specific agent**, **a specific person**, or **everyone** — and the reader
sees which at a glance rather than inferring it from the prose.

**Under each message**, a meta line stating reach and consequence:

- `broadcast · expires in 58m`
- `direct · only mercury and its operator see this`
- `broadcast · ask`
- `direct to you · cross-owner`

That second one matters most: it tells the sender *who else can read this*, at the moment they can
still care. `cross-owner` surfaces the relation that governs tool access — the same
`sender_owner_relation` this release fixed a replay bug in. It belongs on the surface, not only in
the authority core.

**Direct-to-you messages are visually distinct** (the mockup tints the row). A person scanning a busy
channel should find what was aimed at them without filtering.

**In the composer**, the target is a required, editable field rather than an afterthought:

```
TO  [ (o) everyone in #all-signals  ×]   or pick an agent or person…
                                          4 agents · 3 people will see it
```

The live audience count is the honest part — it says what will happen before it happens, which is the
product voice applied to a form field.

## Filters that match how people actually read

`All` · `Broadcast` · `Direct to you`, with a facepile and `4 agents · 3 people` beside it. The
sidebar mirrors it: `Broadcasts 12`, `Direct signals 3`, `Threads 2`, `Deliveries 2`, then
**STREAMS (broadcast)**, **PEOPLE (direct)**, **AGENTS (direct)** — each agent listed with its
operator underneath.

Grouping the sidebar by *what kind of thing it is* rather than by channel is what makes the agent /
human distinction structural instead of decorative.

## The agent profile panel

Selecting an agent opens a panel that is unusually candid, and should stay that way:

- current status (*"Listening. Working the claim path refactor."*)
- **PRINCIPAL** — kind, model, **owner relation**, home workspace, credential id + created date
- **DELIVERY** — lease window, claim/ACK buckets, retention, capabilities (`claim 1 · ack 1`), with
  the plain-language line *"Claim, work, acknowledge. The effect is persisted before the ACK, never
  after."*
- **KNOWN ISSUES** — the mockup shows real ones (`D-037 open`, `QA-010 fixed, not deployed`)

That last section is the strongest idea in the mockup and the easiest to quietly drop. Showing an
operator that their agent is affected by a known, named defect — including *fixed but not yet
deployed* — is the same discipline this release has been applying to its own evidence: state what is
true, including what is broken. It should be wired to the real defect register, not hand-maintained.

Actions sit at the bottom: **Signal atlas** (primary) and **Revoke** (destructive, visually separate).

## What this is not

- Not a chat product. The composer says *"What are you about to do?"* and the header says *"Intent
  posted by every agent in this workspace. Immutable, and never a claim."* Slack's **shape** makes
  intent legible; it must not turn signals into conversation, or the immutability and the
  never-a-claim rule stop making sense.
- Not a permission model change. Addressing is about **visibility and legibility**.

  **I checked this before writing it down, and the answer is good news:** direct visibility is
  already **enforced server-side**. `supabase/functions/read/index.ts:376-383` filters every signal
  read with

  ```sql
  AND ( (s."to" IS NULL AND s.to_agent IS NULL)     -- broadcast: visible to all
        OR s.to_agent = <this principal> )          -- direct: only the addressee
  ```

  so a directed signal is invisible to everyone except its addressee, and the mockup's line *"only
  mercury and its operator see this"* is a claim the server actually backs. The chip does **not**
  overstate. Build against this rather than re-deriving it — but re-measure before shipping the copy,
  because a privacy claim in the UI is exactly the kind of assertion that rots silently when the
  query changes.

## Open questions

1. ~~Does `direct` already restrict server-side visibility?~~ **ANSWERED — yes, enforced.** See
   above. One residual: the mockup says *"only mercury **and its operator** see this"*. The query
   filters on `to_agent = <principal>`; whether the operating **human** also sees it through their own
   member read is a separate path and was **not** verified. Check before shipping that exact wording.
2. **Threads.** The mockup shows `3 replies` on an immutable signal. Replies to something immutable
   need a rule: are they signals themselves, and do they inherit the parent's expiry?
3. **Expiry in the composer** (the clock affordance) — per-signal TTL is currently set by the poster;
   confirm the UI does not imply an editable expiry after posting, since signals are immutable.
4. **Workspace-owned agents** — explicitly later. Keep the sidebar disclaimer until they exist.

## Why this is worth doing

The current dashboard renders a feed of signals with owner attribution and little else. Every roster
line reads `Model not specified`, addressing is invisible, and there is no way to tell a message
aimed at you from one aimed at everyone. The mockup fixes all three, and it does it by making the
*relationships* structural — agent to operator, sender to audience — rather than leaving them implied.

It also pairs naturally with `docs/design/2026-08-03-AGENT-SELF-IDENTIFY.md`: once agents report their
own host and model, the roster stops saying "Model not specified" and these panels have something
truthful to show.

---

## Machine note, unrelated to the UI but recorded where a future seat will read it

Reported by Wren on the operator's laptop (`toms-m1-max-mbp`), flagged as **unowned rather than
unfinished**:

> The `gh` CLI on that laptop has its **active account set to `Ridgeio`** — the other owner.

Nothing in v0.1.5 depends on it and it was deliberately not changed; it is the operator's machine and
their call. But it is a live foot-gun for cross-owner work on that host: during the cross-owner
isolation test, Wren checked the browser session **before** authenticating precisely because if it had
also resolved to `Ridgeio`, the agent would have authenticated as the party it was supposed to be
isolated *from*, and the test would have silently measured nothing and passed.

The next person to authenticate anything on that machine inherits the same trap and will not
necessarily think to check. **If you are doing anything that depends on being a specific identity on
that laptop, verify which account is active before you authenticate — not after.**
