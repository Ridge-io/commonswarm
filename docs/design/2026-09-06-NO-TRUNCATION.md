# Stop truncating in the human UI

**Status:** SPECIFICATION, draft 1, branch `spec/app-backlog`. Backlog item 2. Authored by CSwarmStrategist (`2121f81d`), 2026-09-06, from a read-only code map (`docs/evidence/2026-09-06-app-specs-arms/maps/truncation.md`).
**Authority:** none until adopted; CSwarmDevLead PMs the lanes.

## 0. The answer in one paragraph

The operator's complaint was "the hook preview still cuts at 200 chars; the app needs a check". Measured: the hook cuts at **240** characters (`HOOK_BODY_PREVIEW_CHARS`, `src/listener/hook.ts:59`), and it is a *preview* with a path to the full text. The one surface that **loses** text with no path back is `cswarm inbox --notify`: its snippet is 180 characters (`ARRIVAL_SNIPPET_MAX`, `src/cloud/arrival-watch.ts:34`) and its `--json` form carries only that snippet (`arrivalNotification`, `:379-393`; `runInboxNotifyCommand`, `src/cli.ts:4045-4054`). The app does not truncate bodies at all: its only clip is the collapse for long messages, which keeps the full text in the DOM behind "Show more" (item 4's spec). So the rule this spec sets is: **a surface may shorten a body only as a preview, and every preview names where the full text is; a surface that is the only copy a reader gets carries the whole body.** Three changes follow, all small.

## 1. Every surface that shortens a body, measured

| surface | file:line | limit | kind | full text reachable? |
|---|---|---|---|---|
| Claude hook preview (`UserPromptSubmit`) | `src/listener/hook.ts:59` (`HOOK_BODY_PREVIEW_CHARS = 240`), `:619-623` (`preview()`), `:636` (`renderHookSignal`) | 240 chars | preview | yes: the item keeps `signal.body` (`:592-614`) and the line ends with `cswarm reply <id> …` / `cswarm inbox` |
| `cswarm inbox --notify` line and `--json` | `src/cloud/arrival-watch.ts:34` (`ARRIVAL_SNIPPET_MAX = 180`), `:355-363`, `:379-393`; `src/cli.ts:4045-4054` | 180 chars | **loss** | no: `--json` has `snippet` and `reply_command` only; a second command is needed |
| `cswarm feed` / `inbox` rows | `src/cloud/signals.ts:34` (`SIGNAL_BODY_DISPLAY_MAX = 8_000`), `:1881-1885`, warning `:1902-1905` | 8,000 chars | preview, unreachable | the server caps bodies at 8,000 (`_shared/signal-text.ts:2`; `20260827000001_expand_signal_body.sql:6`), so this never fires for a signal |
| `cswarm feed` / `inbox` `about` | `signals.ts:35` (`SIGNAL_ABOUT_DISPLAY_MAX = 500`), `:1852-1857`, warning `:1906-1909` | 500 chars | preview | yes: the warning says `--json` |
| app message body | `site/src/components/app/LiveDashboard.astro:12901-12917`, `site/src/lib/message-markdown.ts:37-40` | 60 lines collapsed | preview | yes: the text is in the DOM, "Show more" reveals it (item 4) |
| app markdown renderer | `message-markdown.ts:20-35`, `:137-155` | 2,000,000 chars / 50,000 lines | preview | unreachable for signals (8,000 cap); reachable for a brain topic, whose Raw toggle has the full text |
| composer draft persistence | `LiveDashboard.astro:3029`, `:3053`, `:3113` | 16,000 chars | loss of a *draft* only | the send limit is 8,000 anyway (`:816`, `:3313-3332`) |
| CLI error/diagnostic text | `signals.ts:1780-1787`, `cli.ts:8125-8130`, `:8165-8170`, `:5305-5308` | 240–2,000 chars | loss of error text, not bodies | out of scope; listed so nobody mistakes them for body cuts |

Not a truncation: entity ids shortened to 8+…+4 (`site/src/lib/entity-panel.ts:59-60`).

## 2. The changes

**C1 — `inbox --notify` carries the whole body in `--json`, and names the path in the readable line.**
`arrivalNotification` gains `body` (the full text, up to 8,000) beside `snippet`; `--json` emits both. The readable line keeps the 180-char snippet (it is a terminal notification, one line by design) and ends with `— full text: cswarm inbox` when the body was longer than the snippet. Rule from `AGENTS.md`: the phrase that says where the full text is must be generated from the same constant the cut uses (`ARRIVAL_SNIPPET_MAX`), never typed.

**C2 — the hook preview names its cut and its cap is one constant, raised.**
`HOOK_BODY_PREVIEW_CHARS` 240 → **1,000**, and the rendered line appends `[… N more chars — cswarm inbox]` computed from the same constant, only when a cut happened. The full body stays on the item. Why 1,000: the hook injects text into the model's context at prompt time; the operator's messages on this channel are commonly 300–900 characters, and a 1,000-character preview carries nearly all of them whole while keeping a 40-signal backlog under the hook's own budget. The constant remains the single source; the test asserts the `N` in the copy equals `body.length − HOOK_BODY_PREVIEW_CHARS`.

**C3 — the app's check.** Nothing in the app slices a body; the collapse is item 4. This spec's app work is a **test that fails if a body ever is sliced**: a site observer test renders a maximum-length (8,000-char) body and asserts the DOM text equals the source text (modulo Markdown), on desktop and phone widths, and a fixture body containing the strings the operator reported as cut. It is the control that turns "the app needs a check" into a claim the code enforces.
Harness and fixtures, so nothing is invented: the test is a sibling of `site/src/components/app/message-blocks-layout.observer.test.ts` and uses its harness exactly (headless Chrome via `findChrome` from `participant-rail.fixture.ts`, the built `dist/` stylesheet, Node's test runner under `npm --prefix site test`; no Playwright, no Vitest). Fixtures live in `site/src/components/app/fixtures/no-truncation/`: `max-length.md` (8,000 characters generated deterministically from a seed so the file is reviewable) and `operator-corpus.md`, which the lane fills by running `cswarm feed --json --limit 200` as any member and copying the five longest bodies posted by member Ridgeio in the last seven days, each preceded by its signal id in a comment; the corpus file is the durable record of what was checked.

**Not changed:** the 8,000-char body cap (server), the feed row's 8,000 display cap (dead code, left in place with its warning), the 500-char `about` preview (it says where the full text is), diagnostics.

## 3. Acceptance

- `cswarm inbox --notify --json` → a line whose `body` equals the posted body for an 8,000-char ask; the readable line ends with the generated path phrase.
- The hook renders a 2,000-char body as the first 1,000 plus `[… 1000 more chars — cswarm inbox]`, and a 900-char body whole with no suffix.
- The site test renders the 8,000-char fixture without loss at 390 px and 1440 px.
- No new constant is typed into copy: `grep -rn "180\|240\|1000" src/cli.ts src/cloud/arrival-watch.ts src/listener/hook.ts` finds only the constants and tests.

## 4. Lanes

| lane | branch | author | files | tests | after |
|---|---|---|---|---|---|
| **L1** notify body | `lane/notify-full-body` | Gemini | `src/cloud/arrival-watch.ts`, `src/cli.ts:4045-4054`; `tests/support/arrival-watch.test.ts` | `--json` carries `body`; readable line's path phrase generated from `ARRIVAL_SNIPPET_MAX`; the existing 180 pin updated to assert the phrase, not the number alone | — |
| **L2** hook preview | `lane/hook-preview-1000` | Grok | `src/listener/hook.ts:59`, `:619-636`; `tests/listener-hook*.test.ts` (existing hook tests) | the suffix arithmetic; no suffix under the cap; 40 signals × 1,000 stay under the hook budget (assert the budget constant, named in the test) | — |
| **L3** app no-loss control | `lane/app-body-control` | Gemini | new `site/src/components/app/message-body.observer.test.ts` only; no product code | 8,000-char fixture rendered whole at two widths; a fixture with the operator's reported cut strings | — |

All three are disjoint and can run in parallel; L1 and L2 are pure (`npm test`), L3 is site-only. No migration, no edge change, no D-036 hazard beyond each lane's two arms.

## 5. What was NOT established

- The exact strings the operator saw cut (screenshots were described, not attached to the backlog); L3's fixture uses the operator's own recent channel messages as the corpus.
- The hook's context budget constant and whether 40 × 1,000 fits it: L2 asserts it against the real constant rather than this document's estimate.
- Whether any third-party render (the phone's OS notification from a Monitor line) truncates further; outside this repo.
