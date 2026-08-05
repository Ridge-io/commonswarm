# UI suite report

The first four packets were completed in order on `ui/slack-suite`; the theme-toggle packet was completed on `ui/theme-toggle`. The site test baseline before the suite was 130 tests. No commit was pushed.

## 1. Rail grouped by owner

Commit: `19c26cf` (`Group dashboard agents by owner`)

Scope:

- `site/src/components/app/LiveDashboard.astro`
- `site/src/lib/participant-rail.ts`
- `site/src/components/app/owner-grouped-rail.observer.test.ts`
- `site/src/components/app/slack-shape.observer.test.ts`

The separate PEOPLE and AGENTS sections became one PEOPLE & AGENTS list. Each person row owns a nested agent list; people with no agents remain visible. The repeated `operated by …` line was removed from each agent row because the nesting now carries that relation. The two section headings and their separate counts were condensed into one heading.

Agents whose `ownerUserId` cannot be resolved remain visible in a trailing `Owner unavailable` group. Hiding them would make a roster inconsistency look like the agent did not exist; the fallback preserves the known agent identity without inventing a person.

The `.dashboard__sidebar-agent-list` remains the bounded scrolling element with `block-size: 14rem`, `max-block-size: 14rem`, and `overflow-y: auto`.

Gate: 130 → 132 tests, 0 failures, after a clean site build.

Rendered check: the sample workspace was inspected at 1440 × 1000. It contains two owner fixtures, Dana Rivera and Kenji Ito, with three nested agents. This was not a real workspace.

## 2. Shared site tokens and both colour schemes

Commit: `616c797` (`Adopt shared dashboard color tokens`)

Scope:

- `site/src/components/app/LiveDashboard.astro`
- `site/src/components/app/dashboard-tokens.observer.test.ts`
- `site/src/components/app/slack-shape.observer.test.ts`

The dashboard now imports `site/src/styles/tokens.css`, removes its local fixed-light palette, and consumes the shared semantic roles. The packet described 21 hardcoded literals. The measured source had 22 declarations representing 20 distinct hex strings because `#1264a3` and `#ffffff` each appeared twice. Every declaration was mapped:

| Previous declaration | Shared role |
|---|---|
| `--dashboard-field: #f7f6f2` | `--bg` and the shared `--elev-0` |
| `--dashboard-panel: #ffffff` | `--surface` and the shared elevation roles |
| `--dashboard-rail-field: #f1f0ec` | `--bg-raised` |
| `--dashboard-ink: #1d1c1d` | `--text` |
| `--dashboard-muted: #616061` | `--text-muted` |
| `--dashboard-faint: #777578` | `--text-faint` |
| `--dashboard-line: #e3e1dc` | `--border` |
| `--dashboard-direct: #edf6fc` | `--accent-dim` |
| `--elev-3: #f2f1ed` | shared `--elev-3` |
| `--border-strong: #cbc8c1` | shared `--border-strong` |
| `--border-interactive: #6f6d70` | shared `--border-interactive` |
| `--accent: #1264a3` | shared `--accent` |
| `--accent-hover: #0b4f84` | `--accent-bright` |
| `--accent-bright: #1264a3` | shared `--accent-bright` |
| `--accent-dim: #e5f1f8` | shared `--accent-dim` |
| `--accent-ink: #ffffff` | shared `--accent-ink` |
| `--success: #237b4b` | shared `--success` |
| `--success-dim: #dff3e7` | shared `--success-dim` |
| `--warning: #8b5a16` | shared `--warning` |
| `--warning-dim: #f9edcf` | shared `--warning-dim` |
| `--danger: #b42318` | shared `--danger` |
| `--danger-dim: #fbe8e6` | shared `--danger-dim` |

There is no hover-specific accent token. The primary-button hover uses `--accent-bright`, the nearest documented semantic role. No colour literal was added.

Gate: 132 → 134 tests, 0 failures, after a clean site build.

Rendered check: the sample dashboard was rendered and inspected at 1440 × 1000 in both forced light and forced dark schemes. This was a visual check in addition to the CSS observer. It did not establish contrast ratios beyond those documented by the shared tokens, and it did not cover every viewport.

## 3. Stream entity panel

Commit: `a8cdbee` (`Add stream entity profile panel`)

Scope:

- `site/src/components/app/LiveDashboard.astro`
- `site/src/lib/entity-panel.ts`
- `site/src/components/app/entity-panel.observer.test.ts`
- `site/src/components/app/ui-addressing.observer.test.ts`

Known sender, direct-target, and `operated by` names in the stream are native buttons. `everyone` remains plain text. A desktop panel occupies a third grid column; the narrow layout presents the same panel as a right-side sheet.

Agent profiles show identity, model fallback, owner navigation, shortened principal/token IDs with full-value disclosures, issued/expiry/first-use/revocation state, and a revocation banner. Person profiles link to the agents they operate. Ownership is navigable in both directions. Close and Escape restore focus to the stream control that opened the panel.

No known-issues section was built. There is no generated, committed defect manifest in this tree, so the panel does not hand-maintain defect claims.

Gate: 134 → 138 tests, 0 failures, after a clean site build.

Rendered check: the sample Orbit agent's revoked profile was opened at 1440 × 1000. The measured columns were 296 px / 792 px / 352 px; the close control received focus, and Escape closed the panel and returned focus to Orbit. This used fixtures, not a real workspace or a real revoked credential.

## 4. Composer and rendered mentions, Phase 1

Commit: the fourth commit containing this report.

Scope:

- `site/src/components/app/LiveDashboard.astro`
- `site/src/lib/commonswarm.ts`
- `site/src/components/app/composer.observer.test.ts`
- `REPORT.md`

The stream now has a bottom composer with the exact placeholder `What are you about to do?`. Its visible TO control defaults to `Everyone in # all-signals` and can address one person or agent. Browser-authored signals use the existing `post_signal` command as `note`, with either both target fields null or one direct target field populated. The request keeps one command ID across an unknown-outcome retry.

Typing `@` opens a keyboard-navigable picker above the composer. Person rows show an avatar and name; agent rows also say `agent · managed by <operator>`. Enter resolves the highlighted entity into an atomic, removable chip; Escape closes the picker; arrow keys move its selection; Backspace on an empty text field removes the last chip. The posted sample signal keeps the same chip as an entity-panel control.

Mention references are presentation-only. They are kept in browser memory for signals posted in that session and are not included in `post_signal`. They do not survive reload, appear on another client, or cause delivery. No schema, enqueue, notification, or delivery claim was added. Reactions, threads, attachment controls, emoji controls, formatting controls, and the live activity line were not built.

Gate: 138 → 142 tests, 0 failures, after a clean site build.

Rendered checks: in the sample workspace, broadcast was the initial audience, the count read `3 agents · 2 people in workspace`, typing `@` opened five person/agent rows, keyboard selection produced a chip, and posting kept the chip in the stream. A direct-agent selection rendered `1 agent addressed`. The composer and picker were inspected in both light and dark at 1440 × 1000. No real backend signal was posted, and the composer was not visually checked at every responsive breakpoint.

## 5. Three-state dashboard theme control

Commit: the fifth commit containing this report.

Scope:

- `site/src/pages/app.astro`
- `site/src/components/app/LiveDashboard.astro`
- `site/src/components/app/theme-toggle.observer.test.ts`
- `REPORT.md`

The dashboard rail has one keyboard-native button that cycles `system` → `light` →
`dark` → `system`. Its visible and accessible labels name the current state. The choice
is stored under `commonswarm:theme`. Light and dark set the matching `data-theme` value on
the document root. System stores the literal `system` preference and removes the attribute,
leaving the existing `prefers-color-scheme` path live when the OS preference changes.

The stored preference is read and applied synchronously by an inline script in the document
head. In the built `/app/index.html`, the script closes before the first stylesheet link, so
a pinned light or dark attribute exists before CSS can paint the page. The observer executes
that built script for all three stored states, cycles and persists every state, reloads from
the same storage fixture, and checks the generated head ordering.

`site/src/styles/tokens.css` was not changed. The control uses the existing tokens and adds
no colour values. `header-roster.observer.test.ts` was not weakened, and
`.dashboard__sidebar-agent-list` retains its `14rem` block-size and max-block-size.

Gate: 142 → 145 tests, 0 failures, after `rm -rf site/dist`,
`npm --prefix site run build`, and `npm --prefix site test`. Astro built all eight routes,
and the site gate reported `unreachable = []`.

Rendered check: this packet was not loaded visually in a browser in both schemes. Its
evidence is execution of the inline script extracted from the built page plus assertions
against the built markup and stylesheet order. It did not establish screenshots, a live OS
scheme change, or production behavior.

## Existing tests changed

- `site/src/components/app/slack-shape.observer.test.ts` in packet 1: inverted the flat PEOPLE/AGENTS assertions into grouped participant assertions and changed the rendered geometry fixture to the nested owner structure. The three-versus-fifty height comparison and the 14rem bound remain.
- `site/src/components/app/slack-shape.observer.test.ts` in packet 2: replaced its fixed-light palette assertion with assertions that the shared token import and both scheme paths ship. Feed hierarchy, direct tint, identity, and rail geometry assertions remain.
- `site/src/components/app/ui-addressing.observer.test.ts` in packet 3: changed source-pattern assertions from text-only target/owner construction to the new button-based DOM assembly. It still requires explicit targets, fallback targets, `operated by`, and direct-to-viewer treatment.

No existing test was changed in packets 4 or 5. `header-roster.observer.test.ts` was not changed or deleted and remained green through every gate.

New observers cover owner grouping, shared token adoption, entity-panel behavior, Phase 1 composer/mention behavior, and the three-state theme control. The final site gate reached all test-shaped files.

## Not established across the suite

- No production deployment, push, Supabase mutation, or database test was performed.
- The rendered work used the built sample workspace. It did not establish behavior with production workspace data, a production revoked credential, or a real browser-authenticated post.
- The site tests and sample interactions establish DOM, CSS, command shape, focus, and local presentation behavior. They do not establish mention delivery, multi-client mention persistence, notification, or agent acknowledgement.
- Visual inspection of the earlier packets covered a 1440 × 1000 desktop viewport in light and dark. The theme-toggle packet itself was not visually loaded in both schemes. The suite did not cover every viewport, browser, assistive technology, or OS rendering combination.
