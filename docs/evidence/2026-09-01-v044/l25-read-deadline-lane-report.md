# L25 report — read body deadline and one retry budget

Status: **DONE**

Branch: `lane/l25-read-deadline`

Commit: `d3573440aabc812d3c46902d7fd4154de2fede06`

The commit is local. It was not pushed, released, or deployed.

## Root cause and mechanism

Before the fix, a controlled 25 ms read was still pending after 100 ms because
`fetchWithDeadline` cleared its timer when response headers arrived. A second probe showed
retry timer delays `[30000,30000]`: `onceRetried` gave each attempt a new 30-second window.

The fix has two parts:

1. `fetchWithDeadline` now owns the body consumer. The same abort promise races both `fetch()`
   and the selected body method. Its timer is cleared only in the final cleanup after the body
   settles. `getObject` consumes `arrayBuffer()` there. Agent and human lists consume `text()`
   there, then parse JSON after the network deadline has completed. A body timeout is normalized
   to the existing typed `FileTransportError` with `noResponse === true`. No control flow matches
   error text.
2. Budgeted `onceRetried` calls compute one absolute end time:
   `min(caller deadline, start + 30 seconds)`. Both attempts receive that same end time. A retry
   starts only when at least 2 seconds remain. Calls that omit the budget keep the old write-path
   behavior and invoke the write callback with zero arguments.

Fresh verification after the fix, with a header-immediate body that ignores the abort signal:

```text
body-stall after 24ms: REJECTED FileTransportError retryable=true
```

## Diff summary

```text
d357344 fix(files): bound read bodies and retries to one deadline
 src/cli.ts                      |  49 ++++++-----
 src/cloud/brain-agent.ts        |  45 +++++-----
 src/cloud/files.ts              | 177 +++++++++++++++++++++++++++++-----------
 tests/p1-cli/file-verbs.test.ts | 163 ++++++++++++++++++++++++++++++++++++
 4 files changed, 350 insertions(+), 84 deletions(-)
```

- `src/cloud/files.ts`: body-covering deadline, absolute retry budget, 2-second retry floor,
  and deadline seams for deterministic tests.
- `src/cloud/brain-agent.ts`: every agent brain list uses budgeted retry and keeps any smaller
  caller deadline.
- `src/cli.ts`: file/brain list and object-download reads opt into the one 30-second budget.
- `tests/p1-cli/file-verbs.test.ts`: body-stall, remaining-budget, retry-floor, and mutation
  controls. The body test covers agent list, human list, and object download.

No write implementation changed. The existing file put/create/commit retry controls also passed.

## Read-call enumeration

Generated with:

```sh
rg -n "fetchWithDeadline|onceRetried|listFilesAsAgent|listFilesAsHuman|getObject|listBrainRowsAsAgent" \
  src/cloud/files.ts src/cloud/brain-agent.ts src/cloud/brain.ts src/cli.ts src/listener/hook.ts
```

Read paths:

- `src/cloud/files.ts:392` — `getObject` uses `fetchWithDeadline` and consumes `arrayBuffer()`
  inside the deadline.
- `src/cloud/files.ts:510` — `listFilesAsAgent` uses `fetchWithDeadline` and consumes the body
  inside the deadline.
- `src/cloud/files.ts:562` — `listFilesAsHuman` uses the same body-covering helper.
- `src/cloud/brain-agent.ts:13` — `listBrainRowsAsAgent` uses budgeted `onceRetried`, then
  `listFilesAsAgent`.
- `src/cli.ts:5547` — agent `fileRows` uses budgeted retry.
- `src/cli.ts:5561` — human `fileRows` uses budgeted retry.
- `src/cli.ts:5740` — `cswarm file get` object download uses budgeted retry.
- `src/cli.ts:5813` — agent brain rows use `listBrainRowsAsAgent`.
- `src/cli.ts:5906` — `cswarm brain get` object download uses budgeted retry.
- `src/cli.ts:4568` and `src/listener/hook.ts:705` — brain digest reads use
  `listBrainRowsAsAgent`, so its internal budget covers them without caller duplication.
- `src/cloud/brain.ts` has no network read. It only validates names and filters rows.

The budgetless `onceRetried` calls at `src/cli.ts:2822`, `:2834`, `:2837`, `:5629`, `:5638`,
and `:5641` are write steps. They deliberately retain their prior behavior.

## Test reachability

Both new tests are in the existing file `tests/p1-cli/file-verbs.test.ts`.

- `npm run test:p1-cli` executes the file through `tests/p1-cli/**/*.test.ts`.
- `npm run check:tests` typechecks it through `tests/**/*`.
- `npm test` does **not** name this file in its literal list. It does not execute the new
  controls.

No new test file was added, so `package.json` did not need a script change.

## OBSERVED mutation firing

### Mutation 1: clear the timer at headers

Mutation: inserted `cancel(timer)` after `fetch()` returned and before body consumption.

Command:

```sh
node --import tsx --test \
  --test-name-pattern='every file read deadline stays armed through a stalled response body' \
  tests/p1-cli/file-verbs.test.ts
```

RED tail:

```text
✖ every file read deadline stays armed through a stalled response body
AssertionError [ERR_ASSERTION]: agent list: headers must not clear the deadline

1 !== 0

BODY_MUTATION_EXIT=1
```

The mutation was removed. The same command then passed.

### Mutation 2: give the retry a fresh budget

Mutation: recomputed `start + timeout` immediately before attempt two.

Command:

```sh
node --import tsx --test \
  --test-name-pattern='one read retry gets only the remaining overall budget' \
  tests/p1-cli/file-verbs.test.ts
```

RED tail:

```text
✖ one read retry gets only the remaining overall budget
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:

  [
    1000,
+   1000
-   150
  ]

BUDGET_MUTATION_EXIT=1
```

The mutation was removed. Both focused controls then passed:

```text
✔ every file read deadline stays armed through a stalled response body
✔ one read retry gets only the remaining overall budget
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

## Required gate tails

### `npm run build`

```text
> cloud-swarm@0.1.43 build
> tsc

> cloud-swarm@0.1.43 postbuild
> chmod 755 dist/cli.js
```

### `npm test`

```text
ℹ tests 678
ℹ suites 25
ℹ pass 678
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 19149.378625
```

### `npm run test:p1-cli`

```text
ℹ tests 378
ℹ suites 0
ℹ pass 378
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 54203.870834
```

### `npm run check:tests`

```text
> cloud-swarm@0.1.43 check:tests
> tsc -p tsconfig.tests.json
```

## NOT established

- No database, local Supabase, remote service, or production path was used. The requested gates
  were pure.
- The production 30-second wall-clock duration was not waited out. The controls use an injected
  25 ms timer and an injected clock; the fresh probe used a real 25 ms timer.
- No release, deploy, install, push, or production behavior was established.
- No independent exact review or cross-family inversion was run on `d357344` in this lane.
- The other findings in `review-codex-044.txt` were not changed or re-reviewed: migration order,
  hook scope, and `CLAUDE_CONFIG_DIR` remain owned by their other lanes.
- Write-path response-body deadlines were not changed or claimed. This lane only preserves the
  prior write behavior.
