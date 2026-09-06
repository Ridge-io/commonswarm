# Markdown spacing and wordwrap: measure on a phone, then fix what fails

**Status:** SPECIFICATION, draft 2 (Gemini and Grok round-1 findings folded), branch `spec/app-backlog`. Backlog item 3 ("markdown spacing like Notion" and "wordwrap in the agent response box, light text at the bottom, no scroll" — both marked *landed but not verified*). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06, from a read-only code map (`docs/evidence/2026-09-06-app-specs-arms/maps/markdown-colour-model.md`, Spec C).
**Authority:** none until adopted; CSwarmDevLead PMs the lane.

## 0. The answer in one paragraph

Both items are claims that landed without a measurement on the device the operator reads on. The renderer and its CSS exist and are specific (`site/src/lib/message-markdown.ts`; `LiveDashboard.astro:12891-13061`), the mobile fix rewrote the shell's height model (`7dbfbae`), and the phrase "light text at the bottom, no scroll" appears nowhere in the repo, so nobody can say today whether it is fixed, still present, or was something else. This spec is therefore a **QA lane with a fixed corpus and fixed geometry**, run in real Chrome at phone and desktop widths against the shipped stylesheet, that turns each of the two claims into a pass/fail table with screenshots, and fixes only what the table says fails. Spacing targets are stated as numbers so "like Notion" becomes measurable.

## 1. Today, measured

| part | fact | source |
|---|---|---|
| renderer | hand-rolled escape-first Markdown subset with an allowlist sanitizer; entry `setSanitizedMessageMarkdown` | `message-markdown.ts:1-636`, `:625-635`, `:42-46` |
| block spacing | siblings among `p, ul, ol, blockquote, pre, table, hr` get `margin-block-start: var(--s-3)`; nothing before the first block | `LiveDashboard.astro:12916-12923` |
| lists, quotes, code | list indent `--s-6`; quote left border; inline code padded; `pre { white-space: pre-wrap; overflow-wrap: anywhere }`; `pre code` at `--t-sm` | `:12925-12966` |
| tables | `display:block; inline-size:max-content; max-inline-size:100%; overflow-x:auto`; cells `overflow-wrap: normal` on purpose | `:13003-13037` |
| wrap | container `overflow-wrap: anywhere` (`:12896`), but prose is governed by the **type rule** `overflow-wrap: break-word` on `p, li, h1–h6` in `site/src/styles/global.css:175-184`, which beats the inherited container value; no `word-break`; no `white-space` on the container; a test forbids `white-space: pre` on the `pre` rule | `:12896`; `global.css:175-184`; `message-markdown.observer.mjs:32-42` |
| shell height | `--dashboard-viewport-height` from `visualViewport`; composer autogrow cap `min(40 % of it, 20rem)` (`:12427`); mobile textarea cap 25 % / 5 rem; caret restore | `git diff d77b0b0 7dbfbae -- site/src/components/app/LiveDashboard.astro` |
| the phrase | "light text at the bottom, no scroll" is in no doc, test, or comment; the mobile-fix evidence records three other defects (caret reset, 40 px dead space from double clearance, 12 px band mismatch) | `docs/evidence/2026-09-05-mobile-fix-landing/README.md` §3, §6, §7 |
| real-Chrome tests | `message-blocks-layout.observer.test.ts` (tables at 320 px, mutation controls at `:130-141`, `:343-369`; it already asserts the table scrolls inside itself while the message and page do not, `:325-340`; it passes `headingOffset: 1`, `:162-164`, without which headings do not parse, `message-markdown.ts:341-345`; it dumps DOM, not screenshots, `:282`; it sets no `data-theme`, `:143-159`), `mobile-feed-layout.observer.test.ts` (390×844 rectangles), `composer-sprint-browser.observer.test.ts` (composer/caret) | `site/src/components/app/` |
| brain rendering | a brain topic renders through the same renderer but its block spacing lives under `.dashboard__brain-markdown` (`:11976-11999`; the node carries both classes, `:725`); feed headings are not in the message sibling list and take the global `h2` size (`global.css:236-239`) | `LiveDashboard.astro` |

## 2. The measurement

### 2.1 Corpus (checked in as fixtures)

Six bodies under `site/src/components/app/fixtures/markdown-qa/`: (1) two paragraphs then a bullet list of five with one nested level; (2) a heading, a paragraph, a fenced `bash` block with a 140-character command line, a paragraph; (3) a 6×4 table with one 60-character cell; (4) a blockquote followed by a numbered list; (5) a 300-character paragraph of three long tokens separated by two spaces (a URL, a SHA, a path); (6) the operator's own longest channel message of the last seven days, found the way `2026-09-06-NO-TRUNCATION.md` §2 C3 states (`cswarm feed --json --limit 100`, the CLI's maximum; rows carry `from` as a user id, so the id is taken from the readable feed output that prints names), copied verbatim into the fixture with its signal id in a leading comment (it is the reading case that matters). Each is rendered as an agent reply in the feed and, for (1) and (2), as a brain topic. The harness renders with `headingOffset: 1`, as the sibling does.

### 2.2 Geometry (real Chrome, shipped stylesheet)

Widths 390×844 (phone) and 1440×900 (desktop), both themes: the harness sets `data-theme="dark"` and then `"light"` on the root (`tokens.css:15-18` is the shipped switch), which the existing sibling does not do and this lane adds. For each fixture the test records: the block gaps in px (paragraph→paragraph, paragraph→list, list→paragraph, paragraph→code, code→paragraph, heading→paragraph), line-height in px, **horizontal overflow** (any element with `scrollWidth > clientWidth`, **except** a `table`, which is the shipped scroller and may overflow inside its own box, `:13003-13011`, while the message container and `document.documentElement` must not — the same three assertions the sibling already makes at `:325-340`), **message self-scroll** (the message container's computed `overflow-y` is not `auto` or `scroll`, and for an expanded message `scrollHeight ≤ clientHeight + 1`; a collapsed message's `overflow: hidden` is a clip, item 4's concern, not a scrollbar), and the computed `color` and `opacity` of the last visible line (the "light text" check: it must equal the body colour, not a faded or muted token). There is no CSS selector for a last line, so the harness finds it the same way for every fixture: take the last text node inside the message, build a `Range` over it, and take the client rect from `getClientRects()` whose bottom is greatest; the line's colour is `getComputedStyle` of that text node's parent element, its opacity the product of `opacity` up the ancestor chain to the message container, and any `mask-image` or `-webkit-mask` on an ancestor inside the message is itself a FAIL. Every gap target carries a **tolerance of ±2 px**; the overflow, self-scroll, colour, and mask checks are exact. **Screenshots:** the harness launches Chrome with `--screenshot=<path> --window-size=<w>,<h>` per fixture, width, and theme, written to `docs/evidence/2026-09-06-markdown-qa/<fixture>-<width>-<theme>.png` (24 files).

### 2.3 Targets, stated as pixels at a 16 px root so "like Notion" is testable

The shipped tokens are `--t-base: 1rem`, `--lh-base: 1.62` (line-height 25.92 px), `--s-3: 0.75rem` (12 px) (`tokens.css:266-267`, `:287`, `:321`). Targets are given in **pixels**, not as line-height ratios, because the two are different numbers and a lane must not have to choose (a 0.75-line gap would be 19.44 px, which is not what ships and not what Notion does).

| measurement | target (px, ±2) | why |
|---|---|---|
| paragraph → paragraph | 12 (`--s-3`, the shipped sibling gap `:12920-12923`) | Notion's paragraph gap is a little under half a line; the shipped value is right and the test pins it so it stays |
| paragraph → list / list → paragraph | 12 | one rhythm |
| list item → list item | 4 | items read as one block |
| heading → paragraph | 8 below, 24 above | a heading belongs to what follows |
| paragraph → code block / code → paragraph | 12, and the block has inner padding 12 (`:12949`) | code reads as a block, not a line |
| horizontal overflow | none, on any fixture, at 390 px, with the table exemption of §2.2 | the wrap defect |
| message self-scroll | never | the reading defect |
| last-line colour | equal to body text colour; no gradient, no opacity < 1 | `6712776`'s rule; the "light text" complaint |
| long token (fixture 5) | wraps within the message width at 390 px | the governing rule is `global.css:175-184` (`overflow-wrap: break-word` on `p`), so a fix, if needed, lands there, not on the container |

Brain rendering of fixtures (1) and (2) is measured against the same table; a FAIL there is fixed under `.dashboard__brain-markdown` (`:11976-11999`), which §3 allows for that reason.

### 2.4 Verdict table

The lane produces `docs/evidence/2026-09-06-markdown-qa/RESULTS.md`: one row per (fixture × width × theme × measurement) with measured value, target, PASS/FAIL, and a screenshot per fixture and width. Only FAIL rows become fixes.

## 3. Fixes, only for FAIL rows

Each fix is a CSS change in the `.dashboard__message-markdown` block (`:12891-13061`), the `.dashboard__brain-markdown` block (`:11976-11999`) for a brain-only FAIL, the `p` rule in `global.css:175-184` for a prose-wrap FAIL, or a renderer change in `message-markdown.ts`, with the failing row's test turned into a permanent assertion in `message-blocks-layout.observer.test.ts` (the existing real-Chrome harness) so it cannot regress. No fix is pre-decided by this document; the ledger's "landed" claims are exactly what is being checked.

If every row passes, the lane's deliverable is the RESULTS table and the new assertions, and the two backlog items close as **verified**, with the phrase "light text at the bottom, no scroll" recorded as not reproduced on the fixtures, with an invitation to the operator to send the message that showed it.

## 4. Acceptance

- `RESULTS.md` exists with every cell filled; 24 screenshots (6 fixtures × 2 widths × 2 themes).
- New assertions in `message-blocks-layout.observer.test.ts` for every target row in §2.3, running under `npm --prefix site test` in real Chrome, with one mutation control per family (a deliberately broken gap, a deliberately broken wrap) proving the assertion can fail.
- Zero horizontal overflow at 390 px on all six fixtures.
- Backlog items 3a and 3b move from "not verified" to either "verified" or "fixed in <commit>", by row.

## 5. Lanes

One lane: **`lane/markdown-wordwrap-qa`** (author Gemini; site only): fixtures, the RESULTS table, assertions in `message-blocks-layout.observer.test.ts`, and CSS/renderer fixes for FAIL rows only. No migration, no CLI. Two D-036 arms on the final SHA; the arms verify that every FAIL row has a fix and every fix has an assertion. **Shared files:** `LiveDashboard.astro` and `message-markdown.ts` are also touched by `lane/long-messages` and `lane/brain-toc`; this lane runs **first** of those, because its RESULTS table can change the CSS block the others build on, and CSwarmDevLead serialises the rest.

## 6. What was NOT established

- Whether "light text at the bottom, no scroll" was the pre-`6712776` fade, a themed muted colour, or an iOS rendering artefact; the lane reproduces on the fixtures and asks the operator for the original message if none fails.
- Notion's exact spacing values; the targets are ratios chosen to read the same way, not copied.
- Real-device rendering (iOS Safari) versus headless Chrome at 390 px: the harness cannot run Safari. The operator's phone screenshot is the last control, requested in the handoff.
