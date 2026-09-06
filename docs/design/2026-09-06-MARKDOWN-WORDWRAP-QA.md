# Markdown spacing and wordwrap: measure on a phone, then fix what fails

**Status:** SPECIFICATION, draft 1, branch `spec/app-backlog`. Backlog item 3 ("markdown spacing like Notion" and "wordwrap in the agent response box, light text at the bottom, no scroll" — both marked *landed but not verified*). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06, from a read-only code map (`docs/evidence/2026-09-06-app-specs-arms/maps/markdown-colour-model.md`, Spec C).
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
| wrap | prose `overflow-wrap: anywhere` on the message container; no `word-break`; no `white-space` on the container; a test forbids reintroducing `white-space: pre` | `:12896`; `message-markdown.observer.mjs:29-` |
| shell height | `--dashboard-viewport-height` from `visualViewport`; composer autogrow cap 40 % of it; mobile textarea cap 25 % / 5 rem; caret restore | `git diff d77b0b0 7dbfbae -- site/src/components/app/LiveDashboard.astro` |
| the phrase | "light text at the bottom, no scroll" is in no doc, test, or comment; the mobile-fix evidence records three other defects (caret reset, 40 px dead space from double clearance, 12 px band mismatch) | `docs/evidence/2026-09-05-mobile-fix-landing/README.md` §3, §6, §7 |
| real-Chrome tests | `message-blocks-layout.observer.test.ts` (tables at 320 px, with mutation controls), `mobile-feed-layout.observer.test.ts` (390×844 rectangles), `composer-sprint-browser.observer.test.ts` (composer/caret) | `site/src/components/app/` |

## 2. The measurement

### 2.1 Corpus (checked in as fixtures)

Six bodies under `site/src/components/app/fixtures/markdown-qa/`: (1) two paragraphs then a bullet list of five with one nested level; (2) a heading, a paragraph, a fenced `bash` block with a 140-character command line, a paragraph; (3) a 6×4 table with one 60-character cell; (4) a blockquote followed by a numbered list; (5) a 300-character paragraph with no spaces except three (a long token test: a URL, a SHA, a path); (6) the operator's own longest recent channel message, copied verbatim (it is the reading case that matters). Each is rendered as an agent reply in the feed and, for (1) and (2), as a brain topic.

### 2.2 Geometry (real Chrome, shipped stylesheet)

Widths 390×844 (phone) and 1440×900 (desktop), both themes. For each fixture the test records: the block gaps in px (paragraph→paragraph, paragraph→list, list→paragraph, paragraph→code, code→paragraph, heading→paragraph), line-height in px, whether any element's `scrollWidth > clientWidth` (a horizontal overflow, which is the "no wrap" defect), whether the message container has a vertical scrollbar of its own (the "no scroll" complaint is about text that cannot be reached; a message must never scroll inside itself — the feed scrolls), and the computed `color` and `opacity` of the last visible line (the "light text" check: it must equal the body colour, not a faded or muted token).

### 2.3 Targets, stated as numbers so "like Notion" is testable

| measurement | target | why |
|---|---|---|
| paragraph → paragraph | 0.75 × line-height (≈ `--s-3`) | Notion's paragraph gap is about three quarters of a line; today's `--s-3` is the intended value; the test pins it |
| paragraph → list / list → paragraph | same as paragraph gap | one rhythm |
| list item → list item | 0.25 × line-height | items read as one block |
| heading → paragraph | 0.5 × line-height below, 1.5 × above | a heading belongs to what follows |
| paragraph → code block / code → paragraph | 0.75 × line-height, and the block has inner padding `--s-3` | code reads as a block, not a line |
| horizontal overflow | none, on any fixture, at 390 px; a table may scroll **inside its own box** (existing rule) but the page and the message never scroll sideways | the wrap defect |
| message self-scroll | never | the reading defect |
| last-line colour | equal to body text colour; no gradient, no opacity < 1 | `6712776`'s rule; the "light text" complaint |
| long token (fixture 5) | wraps within the message width at 390 px | `overflow-wrap: anywhere` is doing its job |

### 2.4 Verdict table

The lane produces `docs/evidence/2026-09-06-markdown-qa/RESULTS.md`: one row per (fixture × width × theme × measurement) with measured value, target, PASS/FAIL, and a screenshot per fixture and width. Only FAIL rows become fixes.

## 3. Fixes, only for FAIL rows

Each fix is a CSS change in the `.dashboard__message-markdown` block or a renderer change in `message-markdown.ts`, with the failing row's test turned into a permanent assertion in `message-blocks-layout.observer.test.ts` (the existing real-Chrome harness) so it cannot regress. No fix is pre-decided by this document; the ledger's "landed" claims are exactly what is being checked.

If every row passes, the lane's deliverable is the RESULTS table and the new assertions, and the two backlog items close as **verified**, with the phrase "light text at the bottom, no scroll" recorded as not reproduced on the fixtures, with an invitation to the operator to send the message that showed it.

## 4. Acceptance

- `RESULTS.md` exists with every cell filled; screenshots for 6 fixtures × 2 widths.
- New assertions in `message-blocks-layout.observer.test.ts` for every target row in §2.3, running under `npm --prefix site test` in real Chrome, with one mutation control per family (a deliberately broken gap, a deliberately broken wrap) proving the assertion can fail.
- Zero horizontal overflow at 390 px on all six fixtures.
- Backlog items 3a and 3b move from "not verified" to either "verified" or "fixed in <commit>", by row.

## 5. Lanes

One lane: **`lane/markdown-wordwrap-qa`** (author Gemini; site only): fixtures, the RESULTS table, assertions in `message-blocks-layout.observer.test.ts`, and CSS/renderer fixes for FAIL rows only. No migration, no CLI. Two D-036 arms on the final SHA; the arms verify that every FAIL row has a fix and every fix has an assertion.

## 6. What was NOT established

- Whether "light text at the bottom, no scroll" was the pre-`6712776` fade, a themed muted colour, or an iOS rendering artefact; the lane reproduces on the fixtures and asks the operator for the original message if none fails.
- Notion's exact spacing values; the targets are ratios chosen to read the same way, not copied.
- Real-device rendering (iOS Safari) versus headless Chrome at 390 px: the harness cannot run Safari. The operator's phone screenshot is the last control, requested in the handoff.
