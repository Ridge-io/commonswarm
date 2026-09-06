# Long messages: a readable collapse and "Show more" that remembers

**Status:** SPECIFICATION, draft 3 (round-1 Gemini and Grok, final-round Gemini folded), branch `spec/app-backlog`. Backlog item 4 ("fade at the bottom of long messages plus a show more"). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06, from a read-only code map (`docs/evidence/2026-09-06-app-specs-arms/maps/truncation.md`, Spec B).
**Authority:** none until adopted; CSwarmDevLead PMs the lanes.

## 0. The answer in one paragraph

The app already collapses long messages and already has a "Show more" (`LiveDashboard.astro:5251-5268`, `:12901-12917`). Two things are wrong with it and one thing the operator asked for must **not** be done. Wrong: the collapse threshold is 60 lines (`MESSAGE_COLLAPSE_LINES`, `message-markdown.ts:37-40`), which on a phone is most of a screen before the control appears; and the expanded state lives in memory only (`expandedSignalIds`, `LiveDashboard.astro:1654`), so a reload forgets what you opened (a same-session workspace switch does not: the set is cleared only on auth teardown, `:5755`, never in `openWorkspace`, `:6012`). Must not be done: a bottom **fade**. Commit `6712776` removed exactly that fade because the box does not scroll and a faded last line is unreadable; the operator's own report was the proof ("the fade makes the last sentence hard to read"). So this spec keeps the hard clip that lands on a whole line, lowers the threshold on phones, makes the control itself carry the missing amount, and remembers expansion per message across reloads.

## 1. Today, measured

| part | fact | source |
|---|---|---|
| detection | after render, `markdown.scrollHeight > clientHeight + 1` inside `requestAnimationFrame` inserts the toggle | `LiveDashboard.astro:5251-5268` |
| clip | `.dashboard__message-markdown--collapsed { max-block-size: calc(var(--message-collapse-lines) * var(--lh-base) * 1em); overflow: hidden; }` — hard clip, no scroll, no fade | `:12901-12917` |
| threshold | `MESSAGE_COLLAPSE_LINES = 60` (was 30), set as a CSS variable at `:5173-5174` | `message-markdown.ts:37-40` |
| the fade | `mask-image: linear-gradient(to bottom, black 88%, transparent)` **removed** by `6712776`; the collapsed height moved to the shared `--lh-base` token in the same commit | `git show 6712776` |
| expansion | class toggle; `expandedSignalIds: Set<string>` keyed by `signal.id`; cleared only by `resetWorkspaceSessionState` on auth/session teardown (`:5755`; callers `:5683`, `:7289`, `:7301`, `:7324`, `:7495`, `:9073`), not on a workspace switch; no `localStorage`/`sessionStorage` write for it anywhere (other keys exist under `commonswarm:…`, `:1868`, `:3043`) | `:5261-5267`, `:1654`, `:5188-5189` |
| clip boundary | the comment admits the cut is "NOT a guaranteed line boundary for everything" (fenced blocks, block margins) | `:12903-12910` |
| existing per-message state | the server-backed seen reporter (`HumanSeenReporter`, `human-seen-reporter.ts:39`) is keyed by scope + `signalId` (`:60-61`); no persisted local per-message flag exists | `:1660-1663`, `:5038-5039` |
| tests that pin today's numbers | `site/src/lib/message-markdown.test.mjs:46-48` pins `MESSAGE_COLLAPSE_LINES === 60`; `message-markdown.observer.mjs:47` pins `Show more`/`Show less`, `:75` pins `String(MESSAGE_COLLAPSE_LINES)`, `:61-68` pins no `mask-image` on the collapsed rule; the real-Chrome harness that can measure lines is `message-blocks-layout.observer.test.ts` | `site/src/lib/`, `site/src/components/app/` |

## 2. The changes

**C1 — threshold by viewport, in CSS, one breakpoint.** `MESSAGE_COLLAPSE_LINES` becomes two exports from `message-markdown.ts`, `MESSAGE_COLLAPSE_LINES_PHONE = 14` and `MESSAGE_COLLAPSE_LINES_DESKTOP = 40`, used by tests only. The value the renderer reads is set **in CSS on the feed root**: `.dashboard__feed { --message-collapse-lines: 40 }` and, inside the shell's existing phone media query `@media (max-width: 52rem)` (`LiveDashboard.astro:13439`, the query that switches the composer and header geometry after `7dbfbae`; 390 px is inside it), `--message-collapse-lines: 14`. The per-row `setProperty` inside `buildMessageRow` (`:5172-5175`) is **removed**; rows inherit, a rotation re-evaluates the media query with no script, no listener, and no flash before hydration. A source-text test pins the two CSS literals to the two TypeScript constants and the media query to line `:13439`'s query string, so the three cannot drift; the final-round inversion arm preferred this over a `matchMedia` listener and the spec agrees.

**C2 — the control says what is hidden, in words.** The toggle reads `Show more (about N lines)`, `Show more (1 line)` when N is 1, plain `Show more` when N computes to 0 (a sub-pixel remainder), and `Show less` when expanded. N is `Math.ceil((scrollHeight − clientHeight) / lineHeightPx)`, computed inside the existing `requestAnimationFrame` detection that already reads both heights (`:5251-5268`), so no extra reflow is added, where `lineHeightPx` is `parseFloat(getComputedStyle(markdown).lineHeight)` of the clipped `.dashboard__message-markdown` element (`--lh-base` is the unitless `1.62`, `tokens.css:287`, so dividing pixels by it is not a line count; the collapsed height is `calc(lines × --lh-base × 1em)`, `LiveDashboard.astro:12912`, and the computed line-height in pixels is the same product). The last visible line stays fully readable (hard clip at a line boundary, `6712776`'s rule kept). No fade, no gradient, no mask; the design bar the commit established stands and this spec restates it so nobody reintroduces it.

**C3 — clip on a line, also for blocks.** The collapsed `max-block-size` stays line-based; a fenced code block or table that straddles the boundary is allowed to be cut (as today, and the comment at `:12903-12910` is right that a guaranteed boundary is not achievable with `max-block-size` alone). N is the pixel remainder of C2 in body lines, so a hidden fenced block (`--t-sm`, padding, `:12947-12966`) counts as the number of body lines its height covers, not its source lines; the reader learns roughly how much is there, which is the purpose.

**C4 — remember what you opened across a reload.** `expandedSignalIds` is mirrored to `localStorage` under one key per workspace, `commonswarm:expanded:<workspaceId>` (the existing key family, `:1868`, `:3043`), as a JSON array of signal ids capped at 200 (oldest dropped), written on toggle and read in `openWorkspace` **before the first `renderFeed`** of that workspace (the set is populated, then rows render already expanded, so nothing pops after paint); the in-memory set stays the source during the session, and the existing auth-teardown clear (`:5755`) clears memory only, not storage, so signing back in restores it. Wrapped in `try/catch` (storage can be unavailable). Nothing leaves the browser; nothing is sent to the server, because expansion is a reading preference, not a receipt.

**C5 — keyboard and screen readers.** The toggle keeps `aria-expanded` (exists) and gains `aria-controls` pointing at the **clipped node**, the `.dashboard__message-markdown` element (`:5168-5191`; not `.dashboard__message-body`, which is the whole article with its meta, `:5064-5065`), which gets the id `message-body-<signal.id>` (live ids are UUIDs, `20260724000003_signals.sql:4`; sample rows use `sample-1` and the like, `:7088`, which is still a valid id); `Enter`/`Space` work because it is a `<button>` (exists).

## 3. Acceptance

- Phone (390 px): a fixture of 30 short non-wrapping source lines (each under 30 characters, so source lines equal visual lines) shows 14 lines and `Show more (about 16 lines)`; the 14th line is fully legible (no fade); tapping shows all 30 and `Show less`.
- Desktop (1440 px): the same fixture shows whole; a 60-line fixture shows 40 and the control.
- Reload after expanding: the message is still expanded; switch workspace and back: still expanded (memory, as today); a fresh browser profile: collapsed.
- The collapsed rule carries no `mask-image` (the existing scoped pin at `message-markdown.observer.mjs:61-68` stays green; a repo-wide grep is **not** the check, because `.dashboard__wash` legitimately uses a mask at `:9295`).
- The N in the control equals the hidden line count within ±1 for the non-wrapping fixture, measured in real Chrome.

## 4. Lanes

One lane: **`lane/long-messages`** (author Gemini, site only): `site/src/lib/message-markdown.ts` (the three exports) and `site/src/lib/message-markdown.test.mjs:46-48` (the 60 pin becomes two pins); `site/src/components/app/LiveDashboard.astro` (the CSS variable on the feed root inside the existing media query, toggle copy with N, `aria-controls`, the `localStorage` mirror read before the first render); `site/src/components/app/message-markdown.observer.mjs` (`:47` and `:75` pins rewritten to the new constants and copy); and a new real-Chrome case in the existing `site/src/components/app/message-blocks-layout.observer.test.ts` for the 14/40/N acceptance (a source-text observer cannot measure lines). No new test file, so no gate change. Two D-036 arms on its SHA. No migration, no CLI. **Shared files:** `LiveDashboard.astro` and `message-markdown.ts` are also touched by `lane/markdown-wordwrap-qa`, `lane/brain-toc`, `lane/entity-colour`, `lane/entity-filter-ui`, and `lane/agent-model-rows`; CSwarmDevLead serialises these lanes on those two files (this lane after `lane/markdown-wordwrap-qa`, whose RESULTS table may change the same CSS block).

## 5. What was NOT established

- Nothing about the breakpoint: it is `(max-width: 52rem)` at `LiveDashboard.astro:13439`, measured, and the CSS variable lives inside that same query.
- Whether the operator's "fade" request was aesthetic or a report that the cut hides text: this spec treats it as the second (the measured commit history says so) and makes the cut legible instead.
- `localStorage` quota on iOS Safari for the 200-id cap: about 8 KB per workspace as a JSON array of UUID strings, far under any limit, but not measured.
