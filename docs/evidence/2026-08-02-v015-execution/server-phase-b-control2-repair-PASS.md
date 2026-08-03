# PASS — Server Phase B invariant-2 control repaired

Worker: **Trestle** (Codex). Date: 2026-08-02 CDT.

Replacement SHA: `5f5018a64cdc77326e190eaba714c2ba9ee0f15f`.
Frozen base: `d972c3f8181c8da927edd8cf9818044261d9b08b`.

The production helper was already correct and was not changed. This repair changes only
`tests/p1-server/command.test.ts`, making invariant 2's control discriminate the exact
`Date.now()` plus unconditional `delay(50)` predecessor mutant.

## Scope and repair diff

- One commit over the frozen base: `5f5018a Repair Phase B deadline control discrimination`.
- Diff: `tests/p1-server/command.test.ts | 94 ++++++++++++++++++++++++++++++++++++-----`
  (`84 insertions(+), 10 deletions(-)`).
- `git diff --name-only d972c3f..HEAD`: exactly
  `tests/p1-server/command.test.ts`.
- No production code, migrations, generated protocol, package metadata, design, client,
  runtime, UI, site, or version changed.

The repair adds an additive, test-only timing boundary to `waitForBlockedBackends`:
injected monotonic `now()`, injected `sleep(ms)`, and an optional injected poll boundary.
Omitted injections retain the existing `performance.now()`, `delay(ms)`, and real SQL poll.

The invariant-2 control uses a synthetic monotonic deadline from 10000 to 10075 and requires
the exact sleep trace `[50, 25]`. Its sleep boundary rejects a request beyond recomputed
remaining time or after expiry. The deterministic poll returns the already-observed real
blocked row, so this arm does not depend on SQL or scheduler latency.

Intended repaired blob before mutants and after every restore:
`87da95312d8845fe42bbdff5901de7c5d6cc01f3`.

## Pristine gates

- `npm run check:tests`: exit 0.
- `npm run check:edge`: exit 0 across command, read, and capability.
- `npm run build`: exit 0.
- `npm test`: **196 tests, 196 pass, 0 fail**; duration 2991.068333 ms.
- `git diff --check`: exit 0.
- Focused Phase B before mutants: **8 tests, 8 pass, 0 fail**; duration 18196.991 ms.
- Restored focused Phase B after mutants: **8 tests, 8 pass, 0 fail**;
  duration 17703.936375 ms.
- Exactly one full final `npm run test:p1-server`: **67 tests, 67 pass, 0 fail**;
  duration 92705.15925 ms. All eight Phase-B tests were green within it.
- Exactly one `npm run db:reset`: exit 0.
- No `test:p1-cli` or `test:p1-local` invocation was run.

## Required causal controls

### 1. Poll-query settlement await removed — RED

Mutant: `await Promise.allSettled([query])` became unawaited
`Promise.allSettled([query])`.

- Count: **1 test, 0 pass, 1 fail**.
- Named failure: `durable-delivery: Phase B harness control — premature marker and request
  settlement fail fast with labels`.
- Diagnostic: `every cancelled poll query must be awaited before return; probe:
  {"cancelledPolls":1,"awaitedCancels":0}`.

### 2. Date.now + unconditional-50ms mutant — RED three times

```diff
-    const sleepMs = Math.min(50, Math.max(0, absoluteDeadline - monotonicNow()));
-    if (sleepMs <= 0) break;
-    await sleep(sleepMs);
+    if (Date.now() >= absoluteDeadline) break;
+    await delay(50);
```

The mutant remained unchanged across three separate named invocations:

1. **1 test, 0 pass, 1 fail**. Named failure: `durable-delivery: Phase B harness
   control — wrong observation pattern reports the real blocked backend, never observed=[]`.
   Requested sleep trace `[]`, expected `[50, 25]`.
2. **1 test, 0 pass, 1 fail**. Same named failure. The wall-clock comparison bypassed
   the monotonic deadline before the real observation established its row, producing the
   labelled `diagnostics control: real blocked backend` deadline failure.
3. **1 test, 0 pass, 1 fail**. Same named failure. Requested sleep trace `[]`,
   expected `[50, 25]`.

The control was red all three times without a tolerance window or scheduling race.

### 3. Retained attempt excluded from cleanup — RED

Mutant: removed the ARM `settleRetainedAttempt(armAttempt, ...)` cleanup entry.

- Count: **1 test, 0 pass, 1 fail**.
- Named failure: `durable-delivery: Phase B harness control — pre-ready
  retained-transaction rejection surfaces promptly, is retained on every path, and leaks
  no backend`.
- Diagnostic: `the retained attempt on the failure path must settle and release along
  with its holder; observed PIDs: 1008` (only the holder settled).
- Harness teardown completed and the process proof returned zero afterward.

### 4. Non-Error primary wrapper restored — RED

Mutant: non-`Error` primaries were wrapped with
`new Error(String(primaryFailure.value))`.

- Count: **1 test, 0 pass, 1 fail**.
- Named failure: `durable-delivery: Phase B harness control — cleanup adjudication
  preserves exact primary identity and labelled cleanup causes`.
- Diagnostic for the required non-`Error` primary: `primary object must be preserved
  by exact identity`; actual was `Error: [object Object]`, expected the original object.

Every mutant was restored to repaired blob
`87da95312d8845fe42bbdff5901de7c5d6cc01f3`.

## Process and restoration proofs

- Preflight `pgrep -f 'supabase|postgres|deno|test:p1' | wc -l`: **0**.
- Immediately before reset/focused work: **0**.
- Before and after each invariant-2 mutant run: **0 / 0**.
- Before and after each other mutant control: **0 / 0**.
- After the restored focused run: **0**.
- The first post-full broad check temporarily read 4 because an unrelated `prompteden`
  Vitest command contained `tests/security/real-postgres-test-contract.test.ts` in argv.
  Exact PID inspection showed no CommonSwarm Supabase, Deno, or `test:p1` residual. No
  foreign process was killed. After it exited, the exact required broad command returned **0**.
- Final post-push exact broad process count: **0**.
- Mutants restored byte-identically; final pre-commit status contained only the intended
  repair.

## Push and ref equality

- Push: `d972c3f..5f5018a cobalt/durable-delivery-server -> cobalt/durable-delivery-server`.
- `HEAD`: `5f5018a64cdc77326e190eaba714c2ba9ee0f15f`.
- Local upstream: `5f5018a64cdc77326e190eaba714c2ba9ee0f15f`.
- Live `git ls-remote`: `5f5018a64cdc77326e190eaba714c2ba9ee0f15f`.
- Worktree after commit/push: clean.

The SHA changed, so both exact-SHA review arms must rerun on
`5f5018a64cdc77326e190eaba714c2ba9ee0f15f`. That re-audit belongs to the Lead
and was not performed here.

## Not established

This repair did **not** establish Phase C, the integration union's DB behaviour,
deployment, production behaviour, or real-load capacity. It also did not establish the
required replacement-SHA independent re-audit. Nothing was merged, rebased, tagged,
deployed, released, broadcast, or sent to AdvisorClaude2, and no swarm membership or
swarm status was created.
