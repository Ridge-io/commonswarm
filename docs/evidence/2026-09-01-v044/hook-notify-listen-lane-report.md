# Hook, notify, and listen CLI defect report

Date: 2026-09-01  
Worktree base: `619ff1f` on `main`  
Status: DONE. No commit, push, deploy, release, database change, or production write was made.

## Debug report

### Symptoms and root causes

1. `hook install claude --write` always called a function that returned
   `<cwd>/.claude/settings.json`. There was no user/repository scope choice and no Git ignore
   check.
2. `inbox --notify` wrote stderr from every `onRetry` callback. The watcher tracked only a retry
   attempt number. It had no continuous-failure episode, threshold, or recovery event.
3. `listen status` and `listen stop` rejected both credential flags in `assertShape`. That made
   `target(args)` use human target resolution while `listen start` used agent target resolution.
   The not-found branch then discarded the computed path and printed a global-sounding message.

### Changes per file

#### `src/cli.ts`

- Added boolean `--repo` to parsing and help.
- `hook install/uninstall claude --write` now uses the full user path
  `~/.claude/settings.json` by default.
- `--repo` resolves the Git worktree root. A write inside a Git repo is refused unless Git reports
  `.claude/settings.json` ignored and untracked. The refusal prints the full target, the full
  `.gitignore` path, and this exact line: `.claude/settings.json`.
- Existing non-CommonSwarm settings and hooks remain in the JSON merge. Install and uninstall
  success output prints the full path written.
- `inbox --notify` now feeds retry and recovery events through the retry notice policy. Retry
  error text is not inspected.
- `listen status` and `listen stop` accept both `--agent-token-file` and
  `--agent-token-stdin`. A complete credential supplies the principal identity and also selects
  agent-mode Cloud target resolution, as `listen start` does. An explicit `--principal-id`, when
  also present, must match the credential.
- Text not-found output is now
  `No listener found under <instance-directory> for profile <profile-id>.` JSON not-found output
  also carries `checked_directory` and `profile_id`.
- Help now states the credential form separately for `listen status` and `listen stop`.

#### `src/cloud/arrival-watch.ts`

- Added a pure 60-second retry-notice state machine.
- Added stable codes `arrival_read_persisting` and `arrival_read_recovered`.
- Added one-line formatting. The persistent line says durable delivery is unaffected, says only
  the monitor view is delayed, and names the next automatic retry. The recovery line says the
  monitor is current again.
- Added an `onRecovery` watcher callback, emitted only after at least one retryable read failure.
- Retryability remains classified by typed errors/status helpers before the emit policy. No
  `error.message` branch was added.

#### `tests/p1-cli/hook-routing.test.ts`

Gate: `npm run test:p1-cli` (the script globs `tests/p1-cli/**/*.test.ts`).

- Proves default `--write` changes a temporary HOME's user settings, not the temporary project.
- Proves unrelated prompt/tool hooks and another top-level setting survive install and uninstall.
- Proves install and uninstall print the full user path.
- Builds a temporary Git repo. Proves `--repo` refuses the non-ignored path, prints the full paths
  and exact ignore line, and writes only after that line is added.
- Proves status resolves the same profile/principal from a 0600 credential file and a stdin JSON
  credential without requiring `--principal-id`.
- Proves both status and stop name the exact checked instance directory and profile on an empty
  result.

#### `tests/support/arrival-watch.test.ts`

Gate: `npm test` (this path is named literally in the package script).

- Proves Gauge's scripted escalating delays from 439ms through 2952ms emit nothing below 60s.
- Proves one line at 60s, no repeated persistent line, one recovery line, and no recovery line for
  a short failure episode.
- Separates a pre-existing accidentally nested notification test so the runner counts it as its
  own test.

### Emit-policy state machine

| State | Event | Output | Next state |
|---|---|---|---|
| healthy | first retryable read failure | none | failing, unannounced |
| failing, unannounced | failure before 60s | none | failing, unannounced |
| failing, unannounced | failure at or after 60s | one `[arrival_read_persisting]` line | failing, announced |
| failing, announced | any later failure | none | failing, announced |
| failing, unannounced | successful read | none | healthy |
| failing, announced | successful read | one `[arrival_read_recovered]` line | healthy |
| healthy | successful read | none | healthy |

The policy consumes retry/recovery events. It does not consume or classify message text.

## Mutation results

Both mutations were applied to the working file, the named control was run, and the mutation was
restored immediately.

1. Per-attempt retry output restored by bypassing the threshold/once guard.
   - Command: `node --import tsx --test --test-name-pattern='retry notices stay silent' tests/support/arrival-watch.test.ts`
   - Result: RED, exit 1.
   - Discrimination: the test expected zero lines for Gauge's series and received eight lines,
     including retry delays 439ms and 2952ms.
2. Checked directory removed from the listener not-found text.
   - Command: `node --import tsx --test --test-name-pattern='listen status and stop name the exact directory' tests/p1-cli/hook-routing.test.ts`
   - Result: RED, exit 1.
   - Discrimination: the exact-path assertion failed.

After restoration, the focused controls and all final gates passed.

## Required serial gates — final tails

### `npm run build` — PASS, exit 0

```text
> cloud-swarm@0.1.43 prebuild
> rm -rf dist
> cloud-swarm@0.1.43 build
> tsc
> cloud-swarm@0.1.43 postbuild
> chmod 755 dist/cli.js
```

### `npm test` — PASS, exit 0

```text
tests 672
suites 25
pass 672
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 13303.810125
```

This exact gate was flaky before the final green invocation. Unchanged retries produced failures
in unrelated host timing/setup controls: held-close elapsed 1888ms, 1315ms, and 1641ms against a
1300ms bound; several OpenCode tests did not reach their `isolatedHome` callback within their
250ms polling window; one Claude version probe hit its 5s deadline. The named failures passed
alone (held-close providers 817–1170ms; affected OpenCode controls 46–74ms). No unrelated product
or test threshold was changed to obtain the green gate.

### `npm run test:p1-cli` — PASS, exit 0

```text
tests 371
suites 0
pass 371
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 39025.674292
```

### `npm run check:tests` — PASS, exit 0

```text
> cloud-swarm@0.1.43 check:tests
> tsc -p tsconfig.tests.json
```

`git diff --check` passed for the four task files.

## Scope and concurrent work

The task changed these four tracked files only:

- `src/cli.ts`
- `src/cloud/arrival-watch.ts`
- `tests/p1-cli/hook-routing.test.ts`
- `tests/support/arrival-watch.test.ts`

`src/cloud/files.ts` became modified by another writer during this task. Its three edits add a
second `true` argument to `FileTransportError` calls. I did not make, edit, revert, or evaluate
that concurrent change. The final gates ran against the combined working tree.

None of the protected surfaces listed in the request was changed.

## What was NOT established

- No real `~/.claude/settings.json` was written. Hook install was tested only with temporary HOME
  and Git fixtures on this macOS host.
- Windows Git/path behavior, a missing Git executable, and concurrent writers to one user settings
  file were not load-tested.
- No 60-second live outage was induced. Notify timing and copy were proved with a scripted clock.
  “Durable delivery is unaffected” rests on the existing read-only watcher boundary; this task did
  not re-prove production delivery during an outage.
- No real detached listener was started against a deployed Cloud target. Status/stop identity and
  directory resolution were proved with secure local credential and listener-state fixtures.
- Database, edge, local-Supabase, site, browser, production, release, install, and deployment paths
  were not run.
- The unrelated `src/cloud/files.ts` change was not established by this report.
