# /goal — make addressing and identity visible in the dashboard feed

Branch: **`next/0.1.6-ui-shape`**. Post-0.1.5. The release is frozen at `175f894` — **nothing you do
may touch it**, and nothing here ships to production.

Direction: `docs/design/2026-08-03-SLACK-SHAPE-UI.md`. Read it, but read the two framing sections
first: the shape is the direction, the details are illustrative. **This goal is one slice of that
shape, not the whole mockup.** Do not build the sidebar, the profile panel, filters, threads, or the
composer. Do the feed.

## The defect this closes, measured rather than assumed

A signal addressed to a **specific agent** currently renders in the web dashboard **identically to a
broadcast**. Measured on this branch:

| Layer | State |
|---|---|
| Base table | `swarm.signals.to_agent_principal_id` exists (`20260730000002_agent_signal_receive.sql:5`) |
| Read view | `swarm_read.signals` **already exposes it**, aliased: `s.to_agent_principal_id AS to_agent` (same file, `:91`) |
| Dashboard query | `LiveDashboard.astro:1219` selects `id,from,from_kind,to,kind,body,about,until,created_at` — **`to_agent` is absent** |
| Client type | `Signal` (`commonswarm.ts:805-815`) has `to` but **no `toAgent`** |
| Render | `LiveDashboard.astro:1627` handles `signal.to` only — the *person* case |

So the column exists, the view publishes it, and the UI never asks. **This needs no migration and no
edge-function change.** It is a client-only fix, which is why it is worth doing first.

## Files you own — and nothing else

- `site/src/lib/commonswarm.ts`
- `site/src/components/app/LiveDashboard.astro`
- one new test file (see the gate section — its path is not free-form)

**Out of scope, do not edit:** anything under `supabase/`, anything under `src/`, any migration, the
root `package.json` or its lockfile, `site/package.json` version fields. If you believe one of these
must change, **stop and report that instead of changing it** — it means the slice was mis-scoped, and
a migration on this branch is a much bigger decision than this goal covers.

## What to build

### 1. Carry the addressee through

Add `toAgent: string | null` to `Signal`, add `to_agent` to the select, map it the way `to` is mapped
at `commonswarm.ts:844` (null-and-undefined tolerant, `String(...)` otherwise).

### 2. An explicit target on every message

Today the audience is implicit. Make it structural — after the sender, one of:

```
→ everyone            (to === null && toAgent === null)
→ <agent name>        (toAgent set; resolve via agentById, already keyed by principalId at :1594)
→ <person name>       (to set; resolve via the existing people map)
```

Resolve unknown ids to a readable fallback rather than printing a UUID — a raw UUID in the feed is a
worse outcome than "an agent". Never render an id.

### 3. AGENT / PERSON on every line

A literal badge, per identity rule 1 of the direction doc: a reader must never have to *infer* whether
they are reading a person or an agent. `signal.fromKind` already distinguishes them.

### 4. `operated by <human>`, replacing `owned by`

Rule 2: every agent belongs to a human and the line says whose. The data is already there —
`authorAgent.ownerUserId` → `people` (`:1620-1622`). This is a wording and prominence change, not new
data. Keep the existing `?? "Workspace member"` fallback.

### 5. Direct-to-you rows visually distinct

If the signal is addressed to the **viewing user** (or to an agent the viewing user operates), tint
the row. A person scanning a busy feed should find what was aimed at them without filtering.

### 6. The message row's typographic ranking

This is where the aesthetic section of the direction doc applies, and it is the only styling in scope.
Four ranks — sender bold, badge small and quiet, `operated by …` and timestamp recessed, body plain
and readable. Contrast spent on content, not on containers.

**Do not restyle the rest of the dashboard.** The light-field theme is a separate, larger slice; a
half-converted page is worse than a consistent one.

## The one thing you must NOT write

**Do not render any claim about who can or cannot see a signal.** No "only mercury sees this", no
"private", no lock icon.

The reason is specific and I checked it: visibility **is** enforced server-side for the *agent* read
path (`supabase/functions/read/index.ts:376-383` filters `to_agent = <principal>`), but **the
dashboard does not use that path** — it reads `swarm_read.signals` through PostgREST under RLS, which
is a *different* query with its own policy. Whether that view restricts a directed signal from a
non-addressee **has not been measured**, and it is open question 1 in the direction doc.

So: state **who a message was addressed to** (a fact, carried in the row). Do **not** state **who can
read it** (a privacy claim on an unmeasured path). A privacy claim that turns out to be false is the
worst class of defect this product can ship, and this repo has already shipped copy asserting a state
reality did not deliver — see D-023 in `docs/org/DEFECT-REGISTER.md`.

If you want that claim to exist, the deliverable is a **measurement** of the view's RLS, reported
back, not a sentence in the UI.

## The gate — a count that must move

Site suite baseline, measured on this branch at `44f8ec5`: **`npm --prefix site test` → 113/113.**

**Build before you measure anything, including the baseline.** In a fresh clone with no `site/dist`,
the same suite reports **113 tests / 101 pass / 12 fail**. Those 12 are not defects and not yours —
several tests assert against *built output*, so with no `dist` they fail. `rm -rf site/dist &&
npm --prefix site run build` first, and the suite is 113/113. I measured both numbers in your clone
before writing this. If you ever see 101, you are testing a tree that was never built; if you see a
count that disagrees with your source, suspect a **stale** `dist` — Astro does not clean, and that has
produced a false pass in this repo before.

Your acceptance is **113 → N where N > 113**, with the new tests failing against the pre-change code.
Write the test, watch it go red, then fix it. A test that has never been red proves nothing.

**A test file runs only if a script's glob reaches it.** `site/package.json` `test` globs exactly:
`scripts/*.test.mjs`, `emails/*.test.mjs`, `src/components/**/*.observer.mjs`,
`src/components/**/*.observer.test.ts`, plus three named files. Put your test where one of those
globs lands — a file elsewhere typechecks, passes by hand, and gates nothing. This repo has been
bitten by exactly that three times this release. `site/scripts/test-gate-coverage.test.mjs` exists and
will also have an opinion; keep it green.

State in your report **which glob** picked your file up, and paste the before and after counts.

## Verify what you built, not what you edited

`LiveDashboard.astro` ships a client-side script. A source-level grep proves nothing about what
renders. Build the site (`npm --prefix site run build`, after `rm -rf site/dist` — Astro does not
clean, and a stale `dist` has produced a false count in this repo before) and assert against the built
output or a rendered DOM, the way the existing `*.observer.mjs` files do. Follow their pattern rather
than inventing one.

`site/.env` is gitignored and you will not have it. The build still succeeds without it; that is
expected and is not your bug. Do not create it, and **never** put a service-role key under `site/`.

## Reporting

Report: the diff scope, before/after counts, which glob reached your test, what you saw go red, and —
plainly — **what you did not establish**. If the RLS question above tempted you, say so.

You own this branch while you work. The Lead will not commit to it until you hand it back. Do not
push to any other branch, and do not rebase onto or otherwise disturb `175f894`.
