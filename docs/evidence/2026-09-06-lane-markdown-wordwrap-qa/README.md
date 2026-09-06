# Lane `lane/markdown-wordwrap-qa` (L3) — evidence

Spec: `docs/design/2026-09-06-MARKDOWN-WORDWRAP-QA.md` (branch `spec/app-backlog`). Base: `origin/main` at `ee61b377`.
Backlog item 3: "markdown spacing like Notion" (3a) and "wordwrap in the agent response box, light text at the
bottom, no scroll" (3b), both marked *landed but not verified*.

## What was measured

`site/src/components/app/markdown-wordwrap-qa.observer.test.ts` renders fixtures 1-5
(`site/src/components/app/fixtures/markdown-qa/*.md`) through the shipped renderer
(`src/lib/message-markdown.ts`, `headingOffset: 1`) inside the stylesheets that `site/dist/app/index.html`
links, in real headless Chrome (`findChrome` → the Playwright `chrome-headless-shell`), served over a loopback
`http` server exactly as the sibling `message-blocks-layout.observer.test.ts` does. Fixture 6 is the operator's
human step and was not supplied; the test prints a notice and continues.

Per fixture × width (390×844, 1440×900) × theme (`data-theme` dark/light stamped on the root before the
stylesheets apply) × surface (feed for all five; brain for fixtures 1 and 2) it records:

- geometric block gaps (`next.top − prev.bottom`, so collapsed UA margins are measured as seen): paragraph→paragraph,
  paragraph→list, list item→list item (top-level and nested), paragraph→heading, heading→paragraph, paragraph→code,
  code→paragraph, quote→list; line-height; fenced-block inner padding;
- horizontal overflow on every element inside the message except `table`, the message box's own
  `scrollWidth`/`clientWidth`, the document width, and (fixture 3) that the table is the scroller;
- self-scroll on the markdown container, the article, and the row (`overflow-y` not auto/scroll, `scrollHeight ≤
  clientHeight + 1`);
- the last visible line: last non-blank text node → `Range` → lowest client rect; its holder's computed `color`
  against the container's `color`, the product of `opacity` up to the container, and any `mask-image` /
  `-webkit-mask-image` on the way;
- fixture 5: the long-token paragraph wraps to more than one line with no overflow.

Targets are read off the shipped tokens on the loaded page (`--s-1`, `--s-2`, `--s-3`, `--s-6`, `--lh-base`) and
pinned once to the spec's numbers (4, 8, 12, 24 px; 25.92 px). Gaps carry ±2 px; every other check is exact.

Mutation controls, one per family, each a separate load with one override `<style>` (fixture 1 or 5, feed, 390,
dark): `gap` (paragraph gap forced to 40 px), `wrap` (`p { overflow-wrap: normal }`), `fade` (a gradient mask on
the container and `opacity: 0.4` on the last block). Each control's rows fail and the test asserts that they do.

Loads: 28 shipped + 3 controls, sequential. Rows: 352. Screenshots: 28, one Chrome process each
(`--headless=new --screenshot --window-size --virtual-time-budget=5000`), at
`docs/evidence/2026-09-06-markdown-qa/<fixture>-<surface>-<width>-<theme>.png`.

## D-036 arms

| SHA | arm | file | verdict |
|---|---|---|---|
| 23255e2d (round 1: fixtures, observer, fix, README) | Gemini (agy) inversion | `arm-agy-inversion-23255e2d.md` | PASS, two nits: the header comment claimed every family has a control (scroll has none) — fixed in the next commit; `h6` absent from the heading selectors — moot, the renderer emits levels 2-5 only (`site/src/lib/message-markdown.ts:349`) |
| 23255e2d | Grok exact | — | started, stopped by the lane when the comment fix moved the SHA; no verdict, not a review |
| 534a8405 (round 2: comment fix, site gate log) | Grok exact | `arm-grok-exact-534a8405.md` | PASS, nits only (README wording on the gap control; fixture 6 noted in the header not per row; assertions in the new file rather than the sibling; `list→paragraph` not in the corpus) |
| 534a8405 | Gemini (agy) inversion | `arm-agy-inversion-534a8405.md` | PASS, no findings |
| — | Codex gpt-5.6-sol | — | not run: operator ruling 2026-09-06, Codex unavailable until the weekly reset at 21:00 CDT |

Round 1 and round 2 differ only in a comment in the observer test and in this directory, so the round-1 Gemini review reads on the same code.

## Results

- Before any fix: `RESULTS-before-fix.md` in this directory — 316 PASS, **36 FAIL**, all in the gap family.
- After the fix: `docs/evidence/2026-09-06-markdown-qa/RESULTS.md` — **352 PASS, 0 FAIL**.
- Wrap (3b, "wordwrap"), self-scroll (3b, "no scroll"), and last-line colour/opacity/mask (3b, "light text at the
  bottom") passed on every row before and after; nothing in that family was changed. The phrase "light text at the
  bottom, no scroll" is **not reproduced** on the fixtures; the operator is invited to send the message that showed it.

### FAIL rows and their fix

All 36 FAIL rows were fixed in one commit: `5af56381` (`site/src/components/app/LiveDashboard.astro`,
`.dashboard__message-markdown` block, and a retirement note in the `.dashboard__brain-markdown` block).

| rows | fixtures | surfaces | measured before | target | cause | fix |
|---|---|---|---|---|---|---|
| `gap item→item`, `gap item→item (nested)` (20 rows) | 1, 4 | feed, brain | 0 px | 4 px (`--s-1`) | no `li` rule | `.dashboard__message-markdown li + li { margin-block-start: var(--s-1) }` |
| `gap paragraph→heading` (4), `gap heading→paragraph` (4) | 2 | feed | 0 px / 0 px | 24 / 8 px | headings absent from the feed's margin and sibling lists; `* { margin: 0 }` (`site/src/styles/global.css:82-84`) zeroes them | `h2-h5` added to both lists; `block + heading` gets `--s-6`, `heading + block` gets `--s-2` |
| `gap paragraph→heading` (4), `gap heading→paragraph` (4) | 2 | brain | 12 px / 0 px | 24 / 8 px | the brain's own sibling rule (was `LiveDashboard.astro:11976-11983`) is written before the feed's `margin: 0` rule at the same (0,1,0) score, so a block after a heading took 0 | the brain duplicates are retired (reason recorded in place); the shared-class rules above serve both surfaces |

Each fixed row is a permanent assertion: `block gaps: 12 between blocks, 4 between items, 24 above and 8 below a
heading (±2 px)` in `markdown-wordwrap-qa.observer.test.ts`, with the `gap` control proving it can fail. The spec
(§3) named `message-blocks-layout.observer.test.ts` as the home for new assertions; the lane brief placed them in
the new file instead, which the same `npm --prefix site test` glob (`src/components/**/*.observer.test.ts`) reaches.
The sibling file is unchanged and still green.

Backlog rows: **3a "spacing like Notion" → fixed in `5af56381`** (verified for paragraph, list, code, quote, and
table gaps; fixed for headings and list items). **3b "wordwrap / light text / no scroll" → verified** on fixtures
1-5 at 390 and 1440, both themes, feed and brain.

## Gates

`npm --prefix site test` (whole site suite, after `npm --prefix site run build`) with `site/.env` present
(`PUBLIC_SUPABASE_URL=https://api.commonswarm.com` and the anon key, supplied by the lane lead after the build agent
reported the env-less run below; log `gate-site-test.log` in this directory, 2026-09-06 14:35 local):

| tests | pass | fail | skipped |
|---|---|---|---|
| 523 | 522 | 0 | 1 |

The build agent's earlier run WITHOUT `site/.env` (log `/tmp/mdqa-site-test-3.log` on the build host, 14:33 local)
read 523 / 515 pass / 7 fail / 1 skipped; the paragraph below records that run and its attribution, which the
env-supplied run confirms: all 7 clear once the target metadata is present.

The new file contributes 11 of the passes (8 assertions + 3 controls). The sibling
`message-blocks-layout.observer.test.ts` is unchanged and green under the new CSS.

The 7 failures are the same set on every clean run and are **not this lane's**:

- `app-signed-out.observer.test.ts` ×1 and `provider-buttons.observer.test.ts` ×2: their own assertion text names
  the cause — the build had no `site/.env` (none exists in this worktree or in the main checkout), so the built
  `/app` page publishes empty target metadata and renders no provider button.
- `mobile-feed-layout.observer.test.ts` ×4 ("the app bar is not a one-row bar (188px)", "Sign out has no box"):
  re-run with the **base** `LiveDashboard.astro` (`ee61b377`) swapped in and rebuilt under the same env — the
  same 4 fail identically (1 pass, 4 fail), so they follow from the env-less signed-out layout, not from this
  lane's CSS. The lane file was restored and `dist` rebuilt afterwards (`git status` clean apart from this README).

One more failure was this lane's and is fixed in `0993bc7c`: the sign-in sweep's coverage control did not know
the `.md` file type the fixtures introduced under `site/src`.

Two intermediate runs are recorded for the reader who meets them in a log: the first run (8 fail) was before
`0993bc7c`; a second run (34 fail, every extra failure a 15-25 s timeout or its cascade) coincided with a host
load average of 88 and memory pressure level 2 — a contention signature, and the following run on the same SHA
returned to the 7 above.

`npx tsc --noEmit -p site`: **70 errors, all pre-existing in files this lane did not touch** (`src/protocol/*.ts`
TS1484 type-only imports under `verbatimModuleSyntax`, `site/astro.config.mjs`,
`site/src/components/connect/agent-prompt.observer.test.ts`, `dead-session.observer.test.ts`). Zero errors name
`markdown-wordwrap-qa.observer.test.ts`, `LiveDashboard.astro`, or the fixtures. The site `tsconfig.json`
includes `**/*`, which is why root `src/protocol` is in its program.

## Commits on this lane

Base `ee61b377` (origin/main). In order:

1. `83b7817e` chore(lane): write canary (pre-existing on the branch; `write-canary.md` untouched).
2. `972bac40` test(site): fixtures 1-5, the observer, the RESULTS.md generator, and `RESULTS-before-fix.md`
   (36 FAIL rows measured against the shipped CSS).
3. `5af56381` fix(site): block rhythm in `LiveDashboard.astro` — headings 24/8, items 4, brain duplicates retired;
   `RESULTS.md` regenerated (352/352 PASS) and the 28 screenshots.
4. `0993bc7c` test(site): sign-in sweep scans `.md`.
5. This README (the commit after `0993bc7c`).

Nothing was pushed. No worktree or branch was created; `cswarm`, `gh`, and git config were not touched.

## Not established

- **iOS Safari / a real phone.** Only headless Chrome at 390×844 was measured. A wash painted by an overlay or a
  GPU layer is invisible to a computed-style walk; the operator's phone screenshot is the outstanding control, and
  the 28 committed PNGs are what to compare it against.
- **Fixture 6.** Not supplied (the operator's longest channel message of the last seven days is a human step); its
  rows read `not supplied` and the screenshot set is 28, not 32.
- **The original complaint.** Whether "light text at the bottom, no scroll" was the pre-`6712776` fade, a themed
  muted colour, or an iOS artefact. No fixture reproduces it.
- **Notion's exact values.** The targets are the spec's pixel numbers; nothing was compared against Notion.
- **The collapsed state.** Every render is expanded; `.dashboard__message-markdown--collapsed` (a clip, spec §2.2)
  was not measured here.
- **Feed heading sizes.** A feed `h3` takes the global `--t-xl`; the brain sets smaller heading sizes. Only the gaps
  were in scope; sizes were not compared.
- **Heading→heading and list→list pairs.** Not in the corpus; they take the general 12 px rule and were not measured.
- **`file://` loading.** The spec's optional `file://` idea was not used; the loopback server was.
- **D-036 arms.** Not run by this lane (the lead runs them on the final SHA).
