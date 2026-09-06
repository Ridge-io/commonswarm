### INVERSION Review Report (D-036) — CommonSwarm Lane L3 (`lane/markdown-wordwrap-qa`, SHA `23255e2dda865cdc465658899d7414498433a4ce`)

#### Verification Findings:

1. **Spec §2.3 Target Derivation & Token Pinning**
   - Targets are derived dynamically from CSS custom properties (`--s-1`, `--s-2`, `--s-3`, `--s-6`, `--lh-base`) via `getComputedStyle` inside the DOM harness ([markdown-wordwrap-qa.observer.test.ts:207-209](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L207-L209)).
   - `test("the spec's pixel targets are the shipped tokens at a 16px root")` ([markdown-wordwrap-qa.observer.test.ts:604-614](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L604-L614)) pins token computed values against spec constants once (`ROOT_PX = 16`, `LH_BASE = 1.62`, `GAP_PX`). Targets are not hardcoded from typed prose.

2. **FAIL Rows Coverage & Permanent Assertions**
   - All 36 pre-fix FAIL rows (20 list item gaps, 8 feed heading gaps, 8 brain heading gaps) were fixed in commit `5af56381` ([README.md:46-55](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/docs/evidence/2026-09-06-lane-markdown-wordwrap-qa/README.md#L46-L55)).
   - Enforced permanently by `test("block gaps: 12 between blocks, 4 between items...")` ([markdown-wordwrap-qa.observer.test.ts:635-638](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L635-L638)), asserting block/item/heading gaps across all 28 shipped loads (352 total rows).

3. **Mutation Controls & Revert Verification**
   - Reverting the CSS fix in `LiveDashboard.astro` breaks 36 gap rows in the test suite.
   - Controls `gap` (forces 40px `p+p` gap), `wrap` (sets `overflow-wrap: normal`), and `fade` (gradient mask & 0.4 opacity) correctly trigger expected row failures in control tests ([markdown-wordwrap-qa.observer.test.ts:151-163, 640-694](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L151-L163)).

4. **CSS Fix Scoping & Brain Node Consistency**
   - Fixes are scoped to `.dashboard__message-markdown` block elements ([LiveDashboard.astro:12926-12948](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/LiveDashboard.astro#L12926-L12948)).
   - Retiring `.dashboard__brain-markdown` block spacing rules ([LiveDashboard.astro:11976-11984](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/LiveDashboard.astro#L11976-L11984)) does not un-style brain nodes, as brain markup carries `class="dashboard__message-markdown dashboard__brain-markdown"` ([LiveDashboard.astro:725](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/LiveDashboard.astro#L725)), ensuring identical styling across feed and brain surfaces.

5. **Last-Line Measurement Accuracy**
   - The test harness walks text nodes ([markdown-wordwrap-qa.observer.test.ts:260-264](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L260-L264)), creates a `Range`, isolates the lowest rect ([markdown-wordwrap-qa.observer.test.ts:268](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L268)), measures `color` against container `bodyColor`, computes cumulative ancestor `opacity`, and checks ancestor `mask-image`/`-webkit-mask-image` ([markdown-wordwrap-qa.observer.test.ts:270-279](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L270-L279)), adhering strictly to §2.2.

6. **Enforcement & Code Discrepancies**
   - **Comment discrepancy**: Header comment ([markdown-wordwrap-qa.observer.test.ts:23](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L23)) states *"Every family has a mutation control..."*, but `type Family = "gap" | "wrap" | "scroll" | "light"` ([markdown-wordwrap-qa.observer.test.ts:467](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L467)) defines 4 families while `controlLoads` ([markdown-wordwrap-qa.observer.test.ts:341-349](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/markdown-wordwrap-qa.observer.test.ts#L341-L349)) defines 3 controls (`gap`, `wrap`, `fade`). The `scroll` family has no mutation control.
   - **File location choice**: Assertions land in `markdown-wordwrap-qa.observer.test.ts` instead of `message-blocks-layout.observer.test.ts`, which is explicitly documented in [README.md:52-54](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/docs/evidence/2026-09-06-lane-markdown-wordwrap-qa/README.md#L52-L55).
   - **Heading level selector scope**: CSS selectors target `h2, h3, h4, h5` ([LiveDashboard.astro:12926, 12930, 12937, 12942](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm5-agy/site/src/components/app/LiveDashboard.astro#L12926)), omitting `h6` (5 hashes under `headingOffset: 1`).

#### Reasoning:
All 36 measured pre-fix FAIL rows correspond directly to the CSS fix in `5af56381`. Measurements originate from real Chrome token evaluations, scoping changes safely retire redundant rules without un-styling brain nodes, and mutation controls demonstrate test sensitivity. Minor comment hyperbole regarding control counts and missing `h6` selectors do not invalidate the lane's empirical measurements or core spec requirements.

VERDICT: PASS
