# UI suite report

All four packets were completed in order on `ui/slack-suite`. The site test baseline was 130 tests. No commit was pushed.

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

## Existing tests changed

- `site/src/components/app/slack-shape.observer.test.ts` in packet 1: inverted the flat PEOPLE/AGENTS assertions into grouped participant assertions and changed the rendered geometry fixture to the nested owner structure. The three-versus-fifty height comparison and the 14rem bound remain.
- `site/src/components/app/slack-shape.observer.test.ts` in packet 2: replaced its fixed-light palette assertion with assertions that the shared token import and both scheme paths ship. Feed hierarchy, direct tint, identity, and rail geometry assertions remain.
- `site/src/components/app/ui-addressing.observer.test.ts` in packet 3: changed source-pattern assertions from text-only target/owner construction to the new button-based DOM assembly. It still requires explicit targets, fallback targets, `operated by`, and direct-to-viewer treatment.

No existing test was changed in packet 4. `header-roster.observer.test.ts` was not changed or deleted and remained green through every gate.

New observers cover owner grouping, shared token adoption, entity-panel behavior, and Phase 1 composer/mention behavior. The final site gate reached all test-shaped files.

## Not established across the suite

- No production deployment, push, Supabase mutation, or database test was performed.
- The rendered work used the built sample workspace. It did not establish behavior with production workspace data, a production revoked credential, or a real browser-authenticated post.
- The site tests and sample interactions establish DOM, CSS, command shape, focus, and local presentation behavior. They do not establish mention delivery, multi-client mention persistence, notification, or agent acknowledgement.
- Visual inspection covered a 1440 × 1000 desktop viewport in light and dark. It did not cover every viewport, browser, assistive technology, or OS rendering combination.

---

# Claude listener provider report

Date: 2026-08-04 (America/Chicago)
Branch: `feat/claude-provider`

## Result

CommonSwarm now accepts an explicit `--provider claude` listener backed by
`@agentclientprotocol/claude-agent-acp@0.64.2`. The bridge is pinned exactly,
resolved to one absolute realpath before probe and spawn, version-probed with
the child environment, and closed with verified SIGTERM → SIGKILL → exit
teardown.

The listener uses the operator-selected project cwd and normal Claude Code
home/keychain state. It does not create an isolated home or move a worker into
a temporary canary cwd. A Claude-specific canary asks the Write tool to target
a unique `/tmp` sentinel while the host denies permission; the real bridge
emitted the permission request and correlated denied tool result, and the
sentinel remained absent. The code removes the sentinel if a future bridge
writes it before denial.

Omitting `--provider` now fails before target, credential, or provider work.
The error lists Grok, OpenCode, and Claude with their pinned install/sign-in
hints, and says that `working-on`, `note`, `ask`, and `feed` work without a
listener while detached live receipt needs an adapter. The dashboard handoff
uses `--provider claude`, includes the exact bridge install command, and carries
the same listener-versus-core-command distinction.

## Diff scope

- Added `src/host/claude.ts` and `src/listener/claude-model.ts`.
- Added the Claude version bound and host/listener exports.
- Added Claude to durable status parsing, detached supervisor argv, CLI
  provider selection, runtime construction, host limits, and failure copy.
- Added `--claude-executable`; detached starts resolve it before spawning the
  supervisor. Claude rejects `--model` and `--effort` because no bridge mapping
  for either was measured.
- Bumped the CLI manifest and lockfile to 0.1.6. The independent site minimum
  is also 0.1.6 because its handoff now prints `--provider claude`, which older
  CLIs reject.
- Updated the site agent handoff and its observer tests.
- Added named root tests for the host, model, and explicit CLI provider; the CLI
  test is also under the `test:p1-cli` glob. Existing detached Grok process
  tests now select `--provider grok` explicitly.
- No `supabase/` path changed. No Supabase function or database deployment ran.

## What came from OpenCode

Only these three mechanisms were carried over:

1. PATH walk plus `realpathSync`, so version probe and spawn use one resolved
   executable.
2. Version probing with the same sanitized environment used for the ACP child.
3. Verified SIGTERM → bounded wait → SIGKILL → confirmed-exit teardown.

The OpenCode isolated-home, auth-copy, owner-marker, stale-home sweep,
forced-config probe, and canary-cwd lifecycle were not copied.

## Verification

Baseline from the goal contract and final result:

- Root `npm test`: 399/399 → **429/429**, 0 failures.
- `npm run test:p1-cli`: 143/143 → **149/149**, 0 failures.
- Clean-from-absent site build: 8 routes built.
- `npm --prefix site test`: **142/142**, 0 failures.
- `npm run build`: exit 0.
- `npm run check:tests`: exit 0.
- `npm run check:edge`: exit 0; command, read, and capability entrypoints checked.
- `git diff --check`: exit 0.
- Old allowlist assertion: 0 occurrences of
  `this release supports --provider grok or --provider opencode`, with 1
  occurrence of `--provider is required` as the same-file positive control.
- All three new test files are named by the root `test` script; the provider
  CLI test is also reached by `test:p1-cli`.

`site/.env` was absent. The site build is evidence for source and rendered
layout, not a deployable backend-connected artifact. Nothing was deployed.

## Live measurements

The exact global package was installed:

```text
npm install -g @agentclientprotocol/claude-agent-acp@0.64.2
command -v: /opt/homebrew/bin/claude-agent-acp
realpath: /opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js
--version: 0.64.2
```

Through CommonSwarm's own `openClaudeAcpSession`, a real authenticated bridge
turn returned:

```json
{"protocolVersion":1,"version":"0.64.2","stopReason":"end_turn","message":"CLAUDE_ACP_OK"}
```

Through `ClaudeListenerModel.start()`, the real permission canary passed and
the model closed with confirmed child exit.

The requested real-workspace `cswarm listen start --provider claude` signal
journey was not completed. This machine's saved human refresh token was
rejected, its identified stored agent successor had expired before the run,
and the other stored successor lacked usable principal/run metadata. I did not
mint a replacement or change production state. Consequently this run did not
establish a real signal receipt or a non-null `lastSignalId`.

## Not established

- Claude authentication through `ANTHROPIC_API_KEY`. The sanitizer strips that
  variable; keychain/OAuth is the measured path.
- Behavior on a machine with no Claude authentication at all. Failure copy
  points to Claude Code keychain/OAuth sign-in, but that stranger path was not
  executed here.
- Behavior on a machine without Claude Code installed. The bridge embeds the
  Claude Agent SDK and may not need a separate `claude` binary, but this machine
  has Claude Code.
- Claude configurations that rely on `CLAUDE_CONFIG_DIR` instead of normal
  `HOME`. The measured sanitizer strips every `CLAUDE_*` variable, and this
  adapter keeps that measured boundary.
- Forward compatibility with any bridge version other than 0.64.2.
- Native Windows execution. A pure process-boundary test covers npm's global
  `.cmd` shim resolution and Node launch shape, but this run used macOS. The
  shared child-environment allowlist does not establish Windows home, PATH
  casing, or `SystemRoot` behavior.
- Publication of the v0.1.6 CLI artifact. This branch was committed without a
  push as requested. Publish v0.1.6 before deploying the site; otherwise the
  0.1.6 download pin and minimum-version handoff cannot complete their install.
- A production workspace signal handled by the Claude listener, or
  `lastSignalId` persistence from that live service path.
