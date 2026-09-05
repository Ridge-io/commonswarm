# Landing lane/mobile-fix onto main, measured in a browser

`lane/mobile-fix-land` rebases `lane/mobile-fix` onto `main` after brain-links landed, reviews it,
and measures the result in a real Chrome. The lane's own before/after work is in
`docs/evidence/2026-09-04-mobile-fix/`; this directory is the landing check, not a repeat of it.

## Files

| File | What it is |
|---|---|
| `01-header-390x844.png` | The one-row header at rest, on the rebased tree |
| `02-keyboard-390x508.png` | The composer with the visible viewport shrunk to 508px |
| `03-keyboard-dismissed-390x844.png` | After the shrunk viewport is restored |
| `measurements.json` | Every rectangle and computed value behind the numbers below |

## The rebase

`git rebase origin/main` applied the single lane commit with no conflict. That is a fact about the
text, not about the behaviour, so brain-links was measured rather than assumed: see below.

## 1. The operator's rule, at 390x844

The rule is that the whole mobile header is no taller than the workspace header row. Stated against
the bars themselves:

| | measured |
|---|---|
| app bar (`.dashboard__rail`) | 73.0px, `top` 115.1 → `bottom` 188.1 |
| header taken out of the reading area (`channelBody.top − appBar.top`) | **73.0px** |
| channel head | 52.0px, `top` 188.1 — starts at the app bar's bottom edge, floating |
| filter row | 40.0px, `top` 188.1 — same band, floating |
| transcript box (`.dashboard__channel-body`) | 655.9px |
| composer | 63.0px, bottom edge 844.0, inside the viewport |

The header that consumes layout is exactly the app bar, to the pixel. The head and the filter row
both begin at the app bar's bottom edge and take none of the transcript's height.

The page carries the sample-data banner above the app bar, which the observer tests do not — they
load `/app` inside a 390x844 iframe. Every rule here is therefore stated against the app bar's own
rectangle, never against absolute `y`.

Reachability, checked rather than assumed: the view switcher is three real buttons in the app bar
(44px tall); the gear is `display: none` and the "Workspace settings" menu item is `flex`; the
channel titleblock is clipped, not removed, and still resolves the channel section's accessible
name through `aria-labelledby` to `# all-signals`; `.dashboard__message` computes `contain: layout`.

## 2. The visible viewport shrinking, at 390x508

| | measured |
|---|---|
| `visualViewport.height` | 508 |
| `--dashboard-viewport-height` | `508px` |
| `.dashboard__product` computed `block-size` | `508px` |
| composer | `top` 409.0 → `bottom` 508.0 — the bottom edge IS the visible viewport's bottom edge |
| textarea | 80.0px tall, cap `80px`, content 88px, about 3.3 lines |
| `window.scrollY` | 0 |

Before this lane the short-viewport rule capped the textarea at `2.75rem` = 44px, one line. Three
lines of what is being typed are visible in `02-keyboard-390x508.png`.

**NOT ESTABLISHED.** This is `Emulation.setDeviceMetricsOverride`, not an iOS keyboard. It models
the size change `visualViewport` reports. It does not reproduce Safari's accessory bar, its
layout-viewport scroll, or its focus and selection behaviour on show and hide. The accessory bar
and the lost caret are addressed in code and are **not proven fixed on the operator's phone**.

## 3. A defect found reviewing the lane, and its control

`composerCaret` started at `{0, 0}` and nothing recorded whether a caret had ever been remembered,
so the first focus that did not follow a pointer ran `setSelectionRange(0, 0)`. Tabbing into a
draft the page restored moved the reader to the START of a sentence they had already written —
the same defect the block exists to remove, reached by a different path.

Probe: on a fresh load, put text in the composer while nothing is focused, then focus with no
pointer. Two builds from the same source, differing only in the guard:

| build | caret after focus |
|---|---|
| with the guard (this lane) | **41** — the end of the text, where the browser put it |
| guard weakened to `if (!input) return;` | **0** — the start of the reader's own sentence |

A blur/focus cycle alone does NOT discriminate: Chrome preserves a textarea's selection across it,
so that probe reads the same whether the restore runs or not. It is not evidence and is not used.

Source-shape controls are in `composer-sprint.observer.test.ts` under the key `caret-survival`,
with two mutations. Measured against the real file, not only the in-memory artifact: baseline 2
pass, guard removed 2 fail naming `caret-survival`, restored 2 pass.

## 4. Brain-links after the rebase

`main` changed `LiveDashboard.astro` heavily for brain-links on the same day, so the linkify pass
and the Brain panel were measured, not assumed. Sample mode ships no files and therefore no brain
topics, on `main` as well, so the probe build seeded one — `brain--mobile-header-rule.md` — and
named that topic in one sample signal body. Nothing of that seed is committed; the source was
restored byte-for-byte after each probe build.

- The body renders a control:
  `<button type="button" class="dashboard__brain-link" data-brain-link="mobile-header-rule" …>`.
- Clicking it put `aria-current="page"` on **both** view switchers — the three buttons this lane
  moved into the app bar and the three in the rail — so moving them did not break the wiring.
- The Brain view opened and said: "mobile-header-rule could not be opened: the topic list could not
  be refreshed just now, so CommonSwarm cannot tell whether it is still here." That is correct:
  sample mode has no backend, so the forced re-read cannot succeed and the click declines to open
  against a list it could not read. The control, the click and the decision all ran.

Not established: opening a topic body against a live workspace.

## 5. Desktop, at 1440x900

Nothing moved. Channel head `static`, 76.0px, `top` 47.7 → `bottom` 123.7; transcript from 123.7;
gear `grid`; the app-bar view switcher, the Workspace settings menu item and the account line in
the menu all `none`; channel description `block`; titleblock `static`; a brain link still present.

## Gates

Run once on the rebased tree after building `dist/` and `site/dist`, then again for the site suite:

| gate | result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npm run check:tests` | exit 0 |
| `npm test` | exit 0 |
| `npm --prefix site test` | 323 tests, 322 pass, 1 skip, exit 0 |
| `npm run test:p1-cli` | exit 0 |
| `scripts/check-commit-identity.sh origin/main..HEAD` | OK, 2 address-fields checked |

The site suite went red once on the first round: `composer-sprint-browser.observer.test.ts` timed
out waiting for the mention picker. It passes alone and it passed on the re-run of the whole suite.
The host was at a memory-pressure warning with six lanes running, and that test drives a headless
Chrome under a virtual-time budget. Lowering the budget from 12000 to 4000 did not reproduce it, so
the budget is not the mechanism and the debounce this lane added is not the cause; host contention
is what is left. It is recorded as a flake seen once, not as a green.

`npm run check:edge` was not run: nothing under `supabase/` changed.

## 6. A second defect found reviewing the lane

The floating band costs the reading area nothing only if its clearance is paid ONCE. Three things
agree on `2.5rem`: the filter row's height, the negative margin that takes that height back out of
the flow, and the top padding that keeps the first thing under the band clear of it. "Load older
updates" sits BETWEEN the band and the list, so when it shows it is the element that clears the
band, and the list's own clearance became dead screen.

| | measured at 390x844 |
|---|---|
| gap between "Load older updates" and the first message, before | 40px |
| gap after `.dashboard__feed-more:not([hidden]) + .dashboard__feed { padding-block-start: 0 }` | 0px |
| list clearance when the button is NOT showing | still 40px |

Control: `mobile-feed-layout.observer.test.ts`, "the floating band's clearance is paid once when
older updates can be loaded". It measures both variants in one case, with a positive control that
the button is really on screen, and it re-runs the operator's header rule while the button is up.
Mutation against the real source file: baseline 5 pass, the rule put back to `2.5rem` 1 fail naming
"the band's clearance is paid twice ... (40px)", restored 5 pass.

## 7. What the review arms found, and what came of it

Both arms FAILED the first SHA (`2d901d3`). Every finding was checked at the cited lines before
anything was changed. Arm output: `arms-2d901d3/{grok,gemini}/ARM.txt`.

Confirmed, and fixed:

- **The band's clearance was the wrong height** (Gemini 1 and 9). The band's two floating parts
  are not the same size: the filter row is 2.5rem, the roster cluster 3.25rem. The clearance was
  the shorter one, so at rest the first message began 113px below the top of the app bar while the
  pill ended at 125px — 12px of the first row under the pill. One `--feed-band-height` now feeds
  every clearance. Control in `assertPhoneHeaderRule`; mutation: baseline 5 pass, the property back
  at 2.5rem 1 fail reading "12.0px of the first message sits under the floating roster pill at
  rest", restored 5 pass.
- **`resetComposer` never cancelled the debounced draft write** (Grok 4). It runs on a workspace
  change too. A timer armed against workspace A fires after the switch, reads an empty box and
  writes against B's key, removing the draft B was about to restore. A pointer switch blurs first
  and is safe; a switch that never blurred is not. Fixed and pinned under `composer-reset`.
- **Enter could be judged against a picker that had not rendered** (Grok 4). The mention list is
  debounced 150ms, so typing `@ri` and pressing Enter inside that window sent the raw text instead
  of picking the name — and the recipient rides inside the body, so that is a message addressed to
  nobody. Enter, Escape and the two arrows now flush a pending render; the typing path does not,
  so the measured debounce still holds. Pinned under `combobox-flush`.
- **"Workspace settings" stayed in the desktop menu's arrow list** (Grok, closing). It is
  `display: none` above 52rem, which is not the `hidden` attribute the roving-focus filter tested,
  so arrowing through the desktop menu stopped on an item nobody could see. The filter now also
  requires a box. Control and mutation in `workspace-switcher.observer.test.ts`.
- **A caret remembered in other text** (Gemini 6, Grok 6). `composerCaretKnown` was never cleared,
  so a workspace switch that restores a different draft, followed by focus with no pointer, put
  the old index into the new text. Cleared in `restoreComposerDraft` and in `resetComposer`, with
  two more mutations.
- **A CSS comment named a gear that is not there** (Grok 9). The mobile-header comment listed
  "workspace name and its gear" in the same block that sets the gear to `display: none`.
- **The lane README's headline number** (Grok 9). "171px → 73px" pairs two different measurements.
  Corrected in `docs/evidence/2026-09-04-mobile-fix/README.md`, retired wording kept.

Checked and refuted, with what was measured:

- **"`persistComposerDraft` returns early on empty input and leaves a stale draft"** (Gemini 4).
  The function does the opposite: `if (body === "" && !hadAttachments) { window.localStorage
  .removeItem(key); return; }`. The code the finding quotes is not in the file.
- **"`contain: layout` traps popovers and lets messages paint over the band"** (Gemini 3). Nothing
  inside a message row is absolutely, fixed or sticky positioned — enumerated at runtime, the list
  is empty — and the entity panel is a top-level element, not a row's child. The filter row is
  `position: sticky` with `z-index: 2` and the head `z-index: 4`, both above rows whose z-index is
  auto; the 52rem block overrides neither. `elementFromPoint` at the chips returns a filter button.
- **"`scrollTo(0, 0)` fights a scrolling user"** (Gemini 5). `.dashboard__product` is the measured
  viewport height with `overflow: hidden`, so the layout viewport has nothing to scroll. The write
  is also skipped at (0, 0), so it cannot loop. A pinch-zoom pan on iOS is not established either way.
- **"`scrollComposerCaretIntoView` mishandles a caret at the end of a wrapped paragraph"**
  (Gemini 6). That case returns before the line arithmetic: `if (caret >= input.value.length)
  { input.scrollTop = input.scrollHeight; return; }`. Mid-paragraph soft wraps can still land a
  line or two off, which the code comment already states.

Accepted, not changed:

- The `caret-survival` and `combobox-flush` controls are source-shape assertions, which is this
  file's established pattern. The behaviour itself is measured in section 3 above, in a browser,
  against two builds.
- `assertDensity` no longer applies its band and ratio floors below 1440px. `assertPhoneHeaderRule`
  replaces them with the operator's rule, a floating-head check, a 600px transcript floor and now
  the at-rest clearance. The new clearance case is measured at 390x844 only.
