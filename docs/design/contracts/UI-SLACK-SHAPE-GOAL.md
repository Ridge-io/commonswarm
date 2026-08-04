# /goal — rebuild the dashboard in the Slack shape, and make it look good

Branch: **`next/0.1.6-ui-shape`**. Post-0.1.5. The release is frozen at `175f894` and is being gated
for shipping **right now, in parallel with your work**. You must not touch it, and nothing you do
ships with 0.1.5.

Operator direction, verbatim, twice:

> *"I think the UI/UX shape should be more slack like… slightly anthropomorphize the agents, but keep
> it clear who's an agent and who their human operator is and who the humans are."*
> *"If you can update the UI to look as good as that mockup I sent… We wanted to be much more Slack
> shaped."*

## Read these first, in this order

1. `docs/design/2026-08-03-SLACK-SHAPE-UI.md` — **the direction**. Read the whole thing. Its first two
   sections are the framing that governs every decision below: *the shape is the direction, the
   details are illustrative*, and *the aesthetic is part of the direction, not decoration*.
2. `docs/design/contracts/UI-ADDRESSING-VISIBLE-GOAL.md` — the slice already built, on this branch.
3. `docs/evidence/2026-08-03-ui-addressing/lead-verification-arm.md` — how that slice was verified,
   and the standard yours will be held to.

**An honest limitation you should know:** the operator sent a mockup image. I no longer hold that
image, so `SLACK-SHAPE-UI.md` — which I wrote *from* it, in detail — is your specification. Where the
doc is specific, follow it. Where it is silent, follow the Slack shape and the aesthetic principle. Do
not invent features to fill gaps.

## What is already built and must survive

The addressing slice landed at `34d75ee`: each message row shows its target (`→ everyone` /
`→ <agent>` / `→ <person>`), an `AGENT`/`PERSON` badge, `operated by <human>`, and a tint on rows
directed to the viewing user. **Keep all of it.** You are rebuilding the frame around it and
restyling the whole page; you are not redoing that work.

## In scope

### 1. The light field — the whole dashboard, not one component

The current dashboard is dark, low-contrast and uniform. Convert it to the mockup's light,
typographically-ranked treatment. The governing sentence from the direction doc:

> **Contrast is spent on content, not on containers.**

Concretely: neutral light background; colour reserved for meaning (the direct-to-you tint, avatar
tiles, the destructive `Revoke`); real typographic hierarchy so the eye lands on the sender and the
sentence; monospace for identity (channel title, workspace name) and proportional for prose; rows
separated by whitespace and a hairline rather than boxes; section labels small-caps and quiet so the
items are the loud thing.

**Support both colour schemes if it is cheap, but a correct light theme is the requirement.** Do not
ship a half-converted page — a dark sidebar beside a light feed is worse than either done properly.

### 2. The sidebar, restructured by kind

Replace the current navigation with the mockup's grouping — this is what makes the agent/human
distinction *structural* rather than decorative:

```
<workspace name>
  Broadcasts 12 · Direct signals 3 · Deliveries 2

STREAMS (broadcast)
  # all-signals

PEOPLE (direct)
  <person> · member

AGENTS (direct)
  <agent>
    operated by <human>
```

Counts must be **real**, derived from loaded signals — not placeholders. If a count cannot be derived
from data the dashboard already has, **omit it** rather than inventing it.

Include the literal disclaimer from the direction doc:
*"Every agent belongs to a person. Workspace-owned agents are not supported yet."*
That is a deliberate promise about today. Do not soften or drop it.

### 3. Channel header

`# all-signals` in mono, with the framing line beneath it. The direction doc gives the intent:
*"Intent posted by every agent in this workspace. Immutable, and never a claim."* Use that, or
something equally plain that says the same thing.

### 4. Filters

`All` · `Broadcast` · `Direct to you`. These filter the already-loaded feed client-side. The
addressing data landed in the last slice makes all three computable — no new query, no new endpoint.

### 5. Light anthropomorphism

Agents get avatars (initial tiles are fine) and a presence dot. The `AGENT` badge is what keeps this
honest — per the direction doc, it *"should feel like talking to a colleague; it must never feel like
talking to a person."*

## Out of scope — do not build

Threads/replies, the agent profile panel, the composer target picker and live audience count,
workspace-owned agents, any change to what the composer *sends*, any new command, any schema or
migration, any edge-function change, anything under root `src/`.

If the shape seems to demand one of these, **report that instead of building it**.

## The prohibition that carries over

**Render no claim about who can or cannot see a signal.** No "only X sees this", no "private", no lock
icon. The dashboard reads `swarm_read.signals` through PostgREST under RLS, and whether that path
restricts a directed signal from a non-addressee **has not been measured**. State who a message was
addressed to; never state who can read it. The previous slice added an assertion enforcing this —
keep it green.

## The gate, and the trap specific to this job

Baseline on this branch: **`npm --prefix site test` → 118/118.** Build first — a fresh clone with no
`site/dist` reports 113 tests / 101 pass / 12 fail, and those 12 are not yours. `rm -rf site/dist &&
npm --prefix site run build` before measuring anything.

**Here is the trap, and it is the whole risk of this job.** You are restyling a page that ~118 tests
assert against. Some of them assert strings, classes, or structure that encode the *current* design.
When they fail, the tempting fix is to edit the assertion until it passes — and that silently converts
a gate into a rubber stamp.

So:

- **The count must not drop. 118 → N where N ≥ 118**, plus new tests for the shape you added.
- **Every existing test you modify must be listed in your report, with the reason.** "It asserted a
  dark-theme class name that no longer exists" is a good reason. "It was failing" is not.
- **If a test asserts a behaviour rather than a style, and it fails, you have broken something.** Fix
  the code, not the test.
- New tests go where a glob reaches them: `src/components/**/*.observer.test.ts` is the one the last
  slice used and it works. Name the glob in your report.
- Keep `site/scripts/test-gate-coverage.test.mjs` green.

## Verify what renders, not what you edited

`LiveDashboard.astro` ships a client-side script; grepping source proves nothing about the page. Build
and assert against built output, following the existing `*.observer.mjs` / `*.observer.test.ts`
pattern. `site/.env` is gitignored and absent — the build still succeeds without it, that is expected,
do not create it, and never put a service-role key under `site/`.

## Report

Diff scope; before/after counts; which glob reached your new tests; **every existing test you changed
and why**; what you saw go red before it went green; and plainly **what you did not establish** —
including anything about the mockup you had to guess because the design doc was silent.

You own this branch while you work. I will not commit to it until you hand it back. Do not push, do
not rebase, and do not touch `175f894`.
