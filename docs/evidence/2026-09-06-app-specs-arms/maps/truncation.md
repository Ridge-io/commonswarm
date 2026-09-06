# Map: every surface that shortens a message body, and the long-message collapse

Explore subagent report, 2026-09-06, branch `spec/app-backlog` at `origin/main`. Read-only.

## Spec A — truncation/preview inventory

| Surface | file:line | limit | preview or loss | notes |
|---|---|---|---|---|
| Claude hook surfaced-signal preview | `src/listener/hook.ts:59` (`HOOK_BODY_PREVIEW_CHARS`), applied `:619-623` (`preview()`), rendered `:636` (`renderHookSignal`) | **240 chars**, not 200 | Preview | `entryFromSignal` (`:592-614`) stores the full `signal.body` on the item; the render appends a reply/read hint (`cswarm reply <id> …`, `cswarm inbox`). |
| `cswarm inbox --notify` monitor snippet | `src/cloud/arrival-watch.ts:34` (`ARRIVAL_SNIPPET_MAX = 180`), `arrivalSnippet` `:355-363`, `arrivalNotification` `:379-393` | 180 chars | **Loss in `--json` too** | the same truncated `snippet` feeds both `--json` and readable output (`runInboxNotifyCommand`, `src/cli.ts:4045-4054`); no full-body field, only `reply_command`. |
| CLI feed/inbox row body | `src/cloud/signals.ts:34` (`SIGNAL_BODY_DISPLAY_MAX = 8_000`), `:1881-1885`, warning `:1902-1905` | 8,000 chars | Preview, effectively dead | server caps bodies at 8,000 (`supabase/functions/_shared/signal-text.ts:2`; `20260827000001_expand_signal_body.sql:6`). |
| CLI feed/inbox `about` | `signals.ts:35` (`SIGNAL_ABOUT_DISPLAY_MAX = 500`), `:1852-1857`, warning `:1906-1909` | 500 chars | Preview | reachable; the warning names `--json`. |
| CLI reply-read failure detail | `signals.ts:1780-1782` (`.slice(0, 240)`), `:1787` (`.slice(0, 300)`) | 240 / 300 | loss of error text | not a body. |
| CLI sanitizers | `src/cli.ts:8125-8130` (`safeError`, 1000), `:8165-8170` (`safeParagraph`, 2000), `:5305-5308` (600) | — | loss of diagnostic text | not a body. |
| Site collapsed message | see Spec B | 60 lines | Preview | full text in the DOM behind "Show more". |
| Site markdown renderer limits | `site/src/lib/message-markdown.ts:20-35` (`inputCharacters = 2,000,000`, `lines = 50,000`), `:137-155` (`boundedLines`), marker `:150` | huge | Preview | unreachable for signals (8,000 cap); reachable for a brain topic, whose Raw toggle has the full text (`:7-19`). |
| Composer draft persistence | `LiveDashboard.astro:3029` (`COMPOSER_DRAFT_STORAGE_MAX = SIGNAL_BODY_MAX * 2` = 16,000), `:3053`, `:3113` | 16,000 | loss of a draft only | sends are capped at 8,000 (`:816`, `:3313-3332`, `:8029`). |
| Entity id display | `site/src/lib/entity-panel.ts:59-60` (`truncateEntityId`) | 8+…+4 | Preview | identifiers only. |

Key finding: the operator's "200 chars" points at the hook, whose constant is 240; the one unconditional loss is the arrival-watch snippet (`ARRIVAL_SNIPPET_MAX = 180`), whose JSON carries only the clipped `snippet`.

## Spec B — collapse/show-more inventory

| Item | file:line | detail |
|---|---|---|
| Fold/toggle build | `LiveDashboard.astro:5251-5268` | after render, `markdown.scrollHeight > markdown.clientHeight + 1` inside `requestAnimationFrame`; inserts a `Show more`/`Show less` button (`.dashboard__message-toggle`) toggling `dashboard__message-markdown--collapsed` and `aria-expanded`. |
| Collapse CSS | `LiveDashboard.astro:12901-12917` | `.dashboard__message-markdown--collapsed { max-block-size: calc(var(--message-collapse-lines) * var(--lh-base) * 1em); overflow: hidden; }` — hard clip, no scroll. |
| Threshold | `site/src/lib/message-markdown.ts:37-40` | `MESSAGE_COLLAPSE_LINES = 60` (comment: "was 30 lines"); CSS var set at `LiveDashboard.astro:5173-5174`. |
| Commit `6712776` | `git show 6712776 --stat`: `LiveDashboard.astro` (+16/-5), `message-markdown.observer.mjs` (+15) | removed `mask-image: linear-gradient(to bottom, black 88%, transparent)` and replaced it with the hard clip because the box does not scroll and faded text was unreadable ("the fade makes the last sentence hard to read"); moved the collapsed height to the shared `--lh-base` token. |
| Expansion | `:5261-5267` | class toggle; `expandedSignalIds` gains/loses `signal.id`; no network, no persistence. |
| Expanded-state memory | `:1654` (`const expandedSignalIds = new Set<string>()`), `:5188-5189`, `:5253`, cleared `:5755` | in-memory only; no `localStorage`/`sessionStorage` write (grep: none). |
| Row keying | `:5188`; threads `expandedThreadIds` `:1589`, `:5291` | by `signal.id`, same id as `deliveryReceiptCache` (`:1663`) and human-seen (`:5039`). |
| Existing per-message state | `HumanSeenReporter` (`site/src/lib/human-seen-reporter.ts:39`), `:1660-1663`, `:4750-4769`, `:5038-5039` | server-backed seen state keyed by `signal.id`; no persisted local per-message flag exists. |

## Unknowns

- Whether the "fade" request means the pre-`6712776` state or a regression: no `mask` code after `6712776` on this branch; current behaviour is hard clip + Show more.
- Toggle behaviour when the collapsed height cuts mid-line in a code block: the comment at `:12903-12910` says the cut is not a guaranteed line boundary; no special handling.
- Whether the 180-char notify snippet is intentional; no comment states a rationale.
- `HOOK_BODY_PREVIEW_CHARS` and `ARRIVAL_SNIPPET_MAX` are compile-time constants; no flag or env override found.
