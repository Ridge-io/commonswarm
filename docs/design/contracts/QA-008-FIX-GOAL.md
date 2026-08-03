# /goal — QA-008: the roster "Remove" control renders one letter per line

Worker: **Quarry2** (Codex). Lane: narrow site CSS fix.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE`, asserted in preflight.**

## The defect, already diagnosed and measured — verify, do not re-derive

On the live dashboard the members-roster **Remove** button renders as a vertical stack of single
characters (`R e m o v e`). Measured in production:

```
button.dashboard__text-button   21px wide x 171px tall
parent li.dashboard__agent      display:grid, 247px wide
                                grid-template-columns: 189.594px 21.4062px
button computed overflow-wrap: break-word
```

The member name takes 190px of a 247px sidebar, leaving ~21px for the action column, and
`overflow-wrap: break-word` then breaks the label at every character.

## The part that matters most

**This exact bug was already found and fixed once — in only one of the two places it occurs.**

In `site/src/components/app/LiveDashboard.astro`:
- line ~998: `item.className = "dashboard__agent"` — the **members** row (broken)
- line ~1114: `item.className = "dashboard__agent dashboard__pending-access-row"` — the
  **pending-access** row, which picks up a `white-space: nowrap` rule

and `site/src/components/app/access-lifecycle.observer.test.ts:670` already asserts that rule exists
for `.dashboard__pending-access-row > .dashboard__text-button`.

So the previous fix was scoped to the row where the bug was reported, and the sibling row using the
same component was left broken. **Fix the class of bug, not the reported instance.** Before you
finish, grep the component for every other place a `.dashboard__text-button` sits in a constrained
grid or flex column and confirm none of them can break the same way. Report what you found, even if
the answer is "no others".

## The fix

Apply `white-space: nowrap` where it covers **both** rows — most likely on `.dashboard__text-button`
itself, or on the `.dashboard__agent` row's action column. Prefer the change that makes a third
instance impossible rather than adding a second narrow override.

Do not change the grid template unless `nowrap` alone is insufficient; if it is, say so and explain
why. Do not restyle anything else, and do not "improve" adjacent CSS.

## Tests — required, and must discriminate

Add an observer test mirroring the existing one at
`site/src/components/app/access-lifecycle.observer.test.ts:670`, asserting the members row's button
cannot wrap.

Prove it **RED before and GREEN after**: with your CSS change reverted the new test must fail. If you
cannot make it fail first, say so plainly — that means it does not discriminate and the fix is
unproven.

## Gates

`npm --prefix site test`, and a clean site build:
`cd site && rm -rf dist && npm run build` (the `rm -rf` is load-bearing — Astro does not clean
`dist/`, so stale files survive and a grep of `dist/` can report content no longer in `src/`).
Then `npm --prefix site test` again against the freshly built output.
Also run root `npm test` to prove nothing else regressed.

**Do not deploy.** Building is not deploying; the site deploy is a separate, operator-gated step.

## Deliverable

Commit **once**, push, record the new SHA. Write
`/Users/yulanbot/Developer/Ridge.io/cloud-swarm/scratchpad/2026-07-31-common-swarm-handoff/QA-008-FIX-RESULT.md`
with: the diff, the red-then-green proof, the results of your sweep for other instances, all gate
counts, and the new SHA.

## Non-goals

Nothing outside `site/src/components/app/`. No `src/`, no `supabase/`, no migration, no
`package.json` version, no deploy, no tag, no release. Do not join the swarm or set swarm status —
you share the Lead's cmux surface and would overwrite the Lead's status. No broadcast, no
`AdvisorClaude2`.

## Stop conditions

Preflight fails · the new test cannot be made red before the fix · `nowrap` alone does not fix it and
a grid change would widen scope · any existing site test regresses.

State what you did **not** establish: this is a source fix; the deployed page is unchanged until the
site is deployed, which is not yours to do.
