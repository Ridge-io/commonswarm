# /goal — workspace switcher at the top of the rail

Operator direction, 2026-08-04:

> "Workspaces should be on the top of the left nav where it says 'CommonSwarm Build'. It should show
> the current one, and be a dropdown to select the other workspaces you have access to, and that's
> where you should also find the option to create a new workspace. This is a common UI pattern."

**Post-0.1.5, site-only.** Branch off current `main`.

## What exists today, and why it is wrong

Three separate things do one job, spread down the rail:

| Line | Element | Today |
|---|---|---|
| `:177-180` | `.dashboard__rail-head` | the `CommonSwarm` wordmark and a sample chip |
| `:182-183` | `.dashboard__workspace-context` | the current workspace name, as static text |
| `:220-226` | `.dashboard__workspace-switcher` | a *separate* "Workspaces" nav section with the list |

So the current workspace is displayed in one place and switched in another, and creating a workspace
is somewhere else again (`createWorkspace` is imported at `:604`, used at `:2531`).

## Build

One control at the top of the rail:

```
┌────────────────────────────┐
│  CommonSwarm Build      ▾  │   ← current workspace, the button
└────────────────────────────┘
     ↓ opens
   CommonSwarm Build      ✓
   Tom's Workspace
   Wren-Laptop-Prod…
   ──────────────────────
   + New workspace
```

- The **button shows the current workspace name** and is the rail's first element.
- Opening it lists **every workspace the signed-in user can reach**, with the current one marked.
- Selecting one switches to it — the same behaviour the existing list has now, moved.
- **`+ New workspace` lives at the bottom of the menu** and uses the existing `createWorkspace`.
- **Remove `.dashboard__workspace-switcher`** (`:220-226`) once its job has moved. Leaving both is the
  failure mode this goal exists to fix.

Where the `CommonSwarm` wordmark goes is your call — it may sit above the switcher, shrink, or move to
the footer. Do not delete the link to `/` without putting it somewhere.

## Accessibility is part of "done", not a follow-up

There is prior art in this repo: the header agent-roster dialog already implements
Escape-to-close, focus restore, and keyboard semantics (Lead7's 2026-07-30 ruling,
`docs/evidence/2026-07-30-header-agent-roster/`). **Follow it rather than inventing a second pattern.**

Required: keyboard open/close, Escape closes and restores focus to the button, `aria-expanded` on the
button, arrow-key or tab navigation through items, and a click-outside close. A dropdown that only
works with a mouse is not done.

## Out of scope

Renaming, deleting, or leaving a workspace. Member management. Anything outside `site/`. No new
command, no schema change, no edge-function change.

## Gate

Baseline on `main`: **`npm --prefix site test` → 124/124** after `rm -rf site/dist && npm --prefix site
run build`. Build first — an unbuilt tree reports false failures.

Acceptance: **124 → N ≥ 124**, with a new observer covering the switcher — that it shows the current
workspace, lists the reachable ones, and offers creation.

**Existing tests assert the old switcher section exists.** Those assertions become wrong. **Invert
them, do not delete them** — a test proving the rail has exactly one workspace control is what stops
the duplicate creeping back. List every test you changed and why.

Two rules that have caught real defects here and apply directly:

- **Do not weaken `header-roster.observer.test.ts`.** A previous attempt at a rail change deleted it
  and the suite count still went *up*, so nothing flagged the loss.
- **The AGENTS rail section must stay bounded.** `.dashboard__sidebar-agent-list` carries
  `block-size: 14rem; max-block-size: 14rem; overflow-y: auto`, and two tests enforce it — including
  one that renders three agents beside fifty and compares heights. Do not disturb it.

`NODE_OPTIONS` on this machine points at a deleted preload; export
`NODE_OPTIONS="--max-old-space-size=4096"` or every node command fails.

## Verify what renders

`LiveDashboard.astro` ships a client script; grepping source proves nothing about the page. Build and
assert against built output, following the existing `*.observer.test.ts` pattern — `slack-shape.observer.test.ts`
is the closest model and already reads the built assets.

## Report

Diff scope, before/after counts, which glob reached your new test, every existing test you changed and
why, and plainly **what you did not establish** — in particular whether you exercised the switcher
against more than one real workspace, or only against fixtures.
