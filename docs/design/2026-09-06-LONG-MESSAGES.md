# Long messages: a readable collapse and "Show more" that remembers

**Status:** SPECIFICATION, draft 1, branch `spec/app-backlog`. Backlog item 4 ("fade at the bottom of long messages plus a show more"). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06, from a read-only code map (`docs/evidence/2026-09-06-app-specs-arms/maps/truncation.md`, Spec B).
**Authority:** none until adopted; CSwarmDevLead PMs the lanes.

## 0. The answer in one paragraph

The app already collapses long messages and already has a "Show more" (`LiveDashboard.astro:5251-5268`, `:12901-12917`). Two things are wrong with it and one thing the operator asked for must **not** be done. Wrong: the collapse threshold is 60 lines (`MESSAGE_COLLAPSE_LINES`, `message-markdown.ts:37-40`), which on a phone is most of a screen before the control appears; and the expanded state lives in memory only (`expandedSignalIds`, `LiveDashboard.astro:1654`), so a reload or a workspace switch forgets what you opened. Must not be done: a bottom **fade**. Commit `6712776` removed exactly that fade because the box does not scroll and a faded last line is unreadable; the operator's own report was the proof ("the fade makes the last sentence hard to read"). So this spec keeps the hard clip that lands on a whole line, lowers the threshold on phones, makes the control itself carry the missing amount, and remembers expansion per message across reloads.

## 1. Today, measured

| part | fact | source |
|---|---|---|
| detection | after render, `markdown.scrollHeight > clientHeight + 1` inside `requestAnimationFrame` inserts the toggle | `LiveDashboard.astro:5251-5268` |
| clip | `.dashboard__message-markdown--collapsed { max-block-size: calc(var(--message-collapse-lines) * var(--lh-base) * 1em); overflow: hidden; }` — hard clip, no scroll, no fade | `:12901-12917` |
| threshold | `MESSAGE_COLLAPSE_LINES = 60` (was 30), set as a CSS variable at `:5173-5174` | `message-markdown.ts:37-40` |
| the fade | `mask-image: linear-gradient(to bottom, black 88%, transparent)` **removed** by `6712776`; the collapsed height moved to the shared `--lh-base` token in the same commit | `git show 6712776` |
| expansion | class toggle; `expandedSignalIds: Set<string>` keyed by `signal.id`; cleared on workspace reset at `:5755`; no `localStorage`/`sessionStorage` write anywhere | `:5261-5267`, `:1654`, `:5188-5189` |
| clip boundary | the comment admits the cut is "NOT a guaranteed line boundary for everything" (fenced blocks, block margins) | `:12903-12910` |
| existing per-message state | the server-backed seen reporter is keyed by `signal.id` (`human-seen-reporter.ts:39`); no persisted local per-message flag exists | `:1660-1663`, `:5038-5039` |

## 2. The changes

**C1 — threshold by viewport, not one number.** `MESSAGE_COLLAPSE_LINES` becomes two constants exported from `message-markdown.ts`: `MESSAGE_COLLAPSE_LINES_PHONE = 14`, `MESSAGE_COLLAPSE_LINES_DESKTOP = 40`, plus one exported `PHONE_MEDIA_QUERY` string, and the script that already sets the CSS variable (`LiveDashboard.astro:5173-5174`) sets it from `window.matchMedia(PHONE_MEDIA_QUERY).matches`, re-running on the media query's `change` event. **No CSS media query duplicates the breakpoint:** the value lives once, in TypeScript, and the CSS keeps reading `--message-collapse-lines`. `PHONE_MEDIA_QUERY` is set to the shell's existing phone breakpoint, which the lane reads from the mobile-fix CSS (the query that switches the composer and header geometry in `7dbfbae`; `mobile-feed-layout.observer.test.ts` measures at 390 px, so 390 must match it) and pins with a source-text test so the two cannot drift. Why 14: on a 390 px phone with the app bar and composer, 14 body lines is about 55 % of the reading area, so a collapsed message never fills the screen and the control is always visible without scrolling. Why 40 on desktop: more than a typical agent reply, fewer than the 60 that hid the control below the fold on a laptop.

**C2 — the control says what is hidden, in words.** The toggle reads `Show more (about N lines)` where N is computed from `scrollHeight − clientHeight` over `--lh-base`, rounded; `Show less` when expanded. The last visible line stays fully readable (hard clip at a line boundary, `6712776`'s rule kept). No fade, no gradient, no mask; the design bar the commit established stands and this spec restates it so nobody reintroduces it.

**C3 — clip on a whole line, also for blocks.** The collapsed `max-block-size` stays line-based; a fenced code block or table that straddles the boundary is allowed to be cut (as today), but the toggle's N counts the block's lines so the reader knows a block is there. No attempt to make block boundaries perfect (the comment at `:12903-12910` is right that it is not achievable with `max-block-size` alone).

**C4 — remember what you opened.** `expandedSignalIds` is mirrored to `localStorage` under one key per workspace (`cswarm.expanded.<workspaceId>`), as a JSON array of signal ids capped at 200 (oldest dropped), written on toggle and read on workspace open; the in-memory set stays the source during the session. Cleared when the workspace is switched only from memory, not from storage, so coming back restores it. Wrapped in `try/catch` (storage can be unavailable). Nothing leaves the browser; nothing is sent to the server, because expansion is a reading preference, not a receipt.

**C5 — keyboard and screen readers.** The toggle keeps `aria-expanded` (exists) and gains `aria-controls` pointing at the message body, which gets the id `message-body-<signal.id>` (signal ids are UUIDs, so the id is unique and valid); `Enter`/`Space` work because it is a `<button>` (exists).

## 3. Acceptance

- Phone (390 px): a 30-line message shows 14 lines and `Show more (about 16 lines)`; the 14th line is fully legible (no fade); tapping shows all 30 and `Show less`.
- Desktop (1440 px): the same message shows whole; a 60-line message shows 40 and the control.
- Reload after expanding: the message is still expanded; switch workspace and back: still expanded; a fresh browser profile: collapsed.
- `grep -rn "mask-image" site/src/components/app/LiveDashboard.astro` → 0.
- The N in the control equals the hidden line count within ±1 for a plain-paragraph fixture.

## 4. Lanes

One lane: **`lane/long-messages`** (author Gemini, site only): `site/src/lib/message-markdown.ts` (two constants), `site/src/components/app/LiveDashboard.astro` (media query for the CSS variable, toggle copy with N, `localStorage` mirror), `site/src/components/app/message-markdown.observer.mjs` and a new observer case in the existing `message-markdown.observer.test.ts` (no new test file → no gate change). Two D-036 arms on its SHA. No migration, no CLI.

## 5. What was NOT established

- The exact phone breakpoint constant the shell uses after `7dbfbae`; the lane reads it from the code and reuses it rather than adding a second one.
- Whether the operator's "fade" request was aesthetic or a report that the cut hides text: this spec treats it as the second (the measured commit history says so) and makes the cut legible instead.
- `localStorage` quota on iOS Safari for the 200-id cap: about 6 KB per workspace, far under any limit, but not measured.
