# /goal — names in the stream open a slide-out entity panel

Operator direction, 2026-08-04, with a Buzz screenshot as the reference:

> "In the stream, all names should be links to open a slide-out right column that shows details about
> that entity."

**Post-0.1.5, site-only.** Branch off `main` **after** the workspace-switcher and group-by-owner goals
have landed — all three edit the dashboard.

`docs/design/2026-08-03-SLACK-SHAPE-UI.md` § *The agent profile panel* already specifies most of the
content. **This goal adds the trigger and extends it to people.**

## What the reference gets right

From the Buzz panel, the patterns worth taking:

- A **right-hand slide-out**, titled, with a close control — the message column stays visible.
- **Identity at the top**: avatar, name, and a badge marking what kind of thing it is.
- **`Managed by <person>` is itself a link** to that person. Ownership is navigable, not just printed.
- **A truncated identifier** shown honestly — `f33a9af2…65f5` — rather than a full key or none at all.
- Facets separated (Info / Runtime / Channels / Memories) instead of one long column.

## Build

### The trigger

Every name rendered in the stream becomes a control that opens the panel:

- the **sender** on each message;
- the **target** in the addressing chip (`→ mercury`, `→ Kenji`);
- **`operated by <person>`** wherever it still appears.

Keyboard-reachable and activated by Enter/Space, not a click-only affordance. `→ everyone` is not an
entity and must not be a link.

### The panel

A right-hand region that does **not** cover the feed at desktop widths. Escape closes it and returns
focus to the name that opened it. Follow the existing header-roster dialog's semantics
(`docs/evidence/2026-07-30-header-agent-roster/`) rather than inventing a second pattern.

**For an agent** — every field below already exists on `AgentAccessStatus`
(`site/src/lib/commonswarm.ts:594-605`), so this is display work, not new plumbing:

- `agentName`, an `AGENT` badge, and **`operated by <person>` as a link**
- `model`, or **`Model not specified`** — the honest default. Do not hide the field and do not guess;
  `docs/design/2026-08-03-AGENT-SELF-IDENTIFY.md` records why a confident wrong model is worse than a
  blank.
- `principalId` and `tokenId`, **truncated** in the Buzz style with the full value available on demand
- `issuedAt`, `expiresAt`, `firstUsedAt` — and `firstUsedAt: null` should read as *never used*, not as
  an empty cell
- **`revokedAt` must be unmissable when set.** A revoked agent that looks live is a wrong answer.

**For a person**: display name, a `PERSON` badge, and **their agents listed as links**. That makes
ownership navigable in both directions, which is the reference's best idea.

## What the panel must NOT claim

**No statement about who can read a signal.** No "only X can see this", no lock icon, no "private".

The dashboard reads `swarm_read.signals` through PostgREST under RLS, and whether that path restricts a
directed signal from a non-addressee **has not been measured**. It is open question 1 in the design
doc. A prior slice added an assertion forbidding exactly this copy — **keep it green.**

State who a message was addressed to. Never state who can read it.

## Known issues — take it, and wire it to the register

The design doc calls this *"the strongest idea in the mockup and the easiest to quietly drop"*:
showing an operator that their agent is affected by a **named, open defect**, including *fixed but not
yet deployed*.

That is now more concrete than when it was written. **Durable delivery is disabled in production on
purpose** (D-044 era; the `read` function is not deployed), and four brick-class defects — D-040,
D-041a, D-041b, D-042 — are open against the durable path.

**If you build this section, derive it from a committed source** (`docs/org/DEFECT-REGISTER.md` or a
generated manifest), never a hand-maintained list in the component. A hand-kept list rots into a
confident lie, which is worse than no section at all. **If deriving it is not practical in this pass,
omit the section entirely and say so** — an empty-but-honest panel beats a stale one.

## Gate

Take the baseline from the tree you start on (the two prior goals will have moved it) and state it.
Build first: `rm -rf site/dist && npm --prefix site run build`.

Acceptance: count must not drop, plus an observer proving a name in the stream is an activatable
control, that the panel renders agent identity including the revoked and never-used states, that
`operated by` navigates to the person, and that Escape restores focus.

Do not weaken `header-roster.observer.test.ts`. Do not disturb the bounded AGENTS rail.

`NODE_OPTIONS` here points at a deleted preload; export `NODE_OPTIONS="--max-old-space-size=4096"`.

## Report

Diff scope, before/after counts, whether you built the known-issues section and from what source, every
existing test you changed and why, and plainly **what you did not establish** — including whether the
panel was rendered against a real workspace with a revoked agent, or only fixtures.
