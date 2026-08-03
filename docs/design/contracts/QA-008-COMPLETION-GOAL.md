# /goal — QA-008 completion: `nowrap` alone does not fix it, the grid must change too

Worker: **Quarry3** (Codex). Lane: completing the QA-008 site fix.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE`, asserted in preflight.**
Owned: `site/src/components/app/` only.

## What already landed, and why it is not enough

Commit `160386e` added `.dashboard__text-button { white-space: nowrap; }`. That was correct and
should stay — it stops the label breaking into a vertical character stack. The previous worker was
explicitly honest that it had **not** established "a visually correct Remove control", and it was
right.

The Lead then tested the committed rule against the live broken page by injecting exactly that CSS
and re-measuring. Result:

| CSS applied | button width | label clipped? |
|---|---:|---|
| production today (no fix) | 21px × 171px | stacked vertically |
| **`nowrap` alone — what landed** | **21px × 44px** | **yes, still clipped** — renders "Remo" |
| `nowrap` + `grid-template-columns: minmax(0,1fr) auto` + ellipsis on the name | **77px × 44px** | **no — correct** |

`nowrap` stops the stacking but the grid column stays `21.4062px`, so the label simply clips instead.
The name span claims 190px of a 247px sidebar and starves the action column.

## The fix, already proven in a live browser

Keep the existing `nowrap` rule. Additionally, for the row that holds a text action:

```css
li.dashboard__agent { grid-template-columns: minmax(0, 1fr) auto; }
li.dashboard__agent > span { overflow: hidden; text-overflow: ellipsis; }
```

Measured effect: action column 21px → **77px**, `scrollWidth > clientWidth` becomes false, the row
does not overflow, and the name truncates with an ellipsis at 134px instead of starving the button.

Adapt the selectors to the component's real structure — the above is the proven *shape*, not
necessarily the exact selector text. `minmax(0, 1fr)` rather than `1fr` is load-bearing: a bare `1fr`
has an automatic minimum of min-content and will not yield the space.

## Also address: the three-child row the previous sweep found

That sweep reported "three direct children in the base two-column `.dashboard__agent` grid. The
action auto-places onto a second grid row." Decide explicitly whether that row is correct as
rendered, and either fix it or record why it is acceptable. Do not leave it unstated a second time.

## Acceptance — geometry, not just CSS presence

The previous test asserted a CSS *rule exists*. That is why the defect survived it. Your test must
assert the **rendered outcome**:

- the action button's `scrollWidth` does not exceed its `clientWidth` (the label is not clipped);
- the button's width is greater than its height (a horizontal control, not a vertical stack);
- the row does not overflow its container.

Prove it **RED before and GREEN after**: with your grid change reverted — but the existing `nowrap`
rule still present — the new assertion must fail. That is the exact state that shipped, so if your
test cannot fail against it, it does not discriminate and this fix is unproven.

## Gates

`npm --prefix site test`; clean site build (`cd site && rm -r -- dist && npm run build` — the removal
is load-bearing, Astro does not clean `dist/`); `npm --prefix site test` again against fresh output;
root `npm test`. **Do not deploy.**

## Deliverable

Commit once, push, record the new SHA. Write
`/Users/yulanbot/Developer/Ridge.io/cloud-swarm/scratchpad/2026-07-31-common-swarm-handoff/QA-008-COMPLETION-RESULT.md`
with the diff, the red-then-green proof, the three-child-row decision, gate counts, and the new SHA.

## Non-goals

Nothing outside `site/src/components/app/`. No `src/`, `supabase/`, migration, version bump, deploy,
tag, or release. Do not join the swarm or set swarm status. No broadcast, no `AdvisorClaude2`.

## Stop conditions

Preflight fails · the new assertion cannot be made red against `nowrap`-only · a site test regresses ·
the fix requires touching anything outside the owned directory.

State what you did **not** establish: the deployed page is unchanged until the site is deployed, which
is not yours to do.
