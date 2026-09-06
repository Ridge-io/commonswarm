### INVERSION Review (Arm D-036) — CommonSwarm Lane L3 (`lane/markdown-wordwrap-qa`, SHA `534a8405`)

1. **Spec §2.3 targets & Token constants:**
   Every §2.3 target is asserted in [markdown-wordwrap-qa.observer.test.ts:606-640](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L606-L640). Values are extracted at runtime from CSS custom properties (`remPx`, `px`, [L294-297](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L294-L297)) and pinned against spec constants (`GAP_PX`, `LH_BASE`, `ROOT_PX`, [L58-62, L606-616](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L58-L62)).

2. **FAIL rows, Fixes & Permanent Assertions:**
   All 36 baseline FAIL rows (20 list item gaps, 8 feed heading gaps, 8 brain heading gaps) are fixed in [LiveDashboard.astro:12926-12948](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/LiveDashboard.astro#L12926-L12948) (adding headings and list items to `.dashboard__message-markdown` rules) and [LiveDashboard.astro:11976-11985](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/LiveDashboard.astro#L11976-L11985) (retiring brain duplicate rules). Fixed rows are permanently asserted across all 28 shipped loads in [markdown-wordwrap-qa.observer.test.ts:637-640](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L637-L640).

3. **Mutation Controls:**
   Controls (`gap`, `wrap`, `fade` in [L153-165](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L153-L165)) inject overrides and are verified in [L642-696](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L642-L696). Each control reaches the assertion path and fails its targeted family while leaving unaffected rows passing. Reverting any CSS fix causes the gap assertion in `test("block gaps...")` to fail.

4. **CSS Scoping & Brain Node:**
   CSS changes are restricted to `.dashboard__message-markdown` in [LiveDashboard.astro:12926-12948](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/LiveDashboard.astro#L12926-L12948). Retiring rules under `.dashboard__brain-markdown` ([L11976-11985](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/LiveDashboard.astro#L11976-L11985)) is valid because the brain element carries both class names (`class="dashboard__message-markdown dashboard__brain-markdown"`, [LiveDashboard.astro:725](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/LiveDashboard.astro#L725)). Both `feed` and `brain` surfaces are measured and pass ([L56, L93-96](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L56)).

5. **Last-line Measurement:**
   The DOM walker ([L262-281](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L262-L281)) selects the final non-blank text node, inspects client rects via a `Range`, computes `color` and ancestor `opacity` products up to the container, and flags any non-`none` `mask-image` / `-webkit-mask-image`, exactly fulfilling spec §2.2.

6. **Claims vs Code Enforcement:**
   All claims made in comments, README, `RESULTS.md`, and test names match the code implementation. Test suite execution via `npm --prefix site test` reaches `markdown-wordwrap-qa.observer.test.ts` via the `src/components/**/*.observer.test.ts` glob.

VERDICT: PASS
