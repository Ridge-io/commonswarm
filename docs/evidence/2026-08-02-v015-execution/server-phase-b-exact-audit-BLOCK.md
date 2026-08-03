# BLOCK — Server Phase B exact audit at `d972c3f8181c8da927edd8cf9818044261d9b08b`

Girder, independent exact-review arm under D-036. Audit date: 2026-08-02 CDT.

The candidate is blocked because required control 2 does not discriminate the predecessor defect. Reverting the observation deadline to `Date.now()` plus an unconditional 50 ms sleep left the named bound control green (1/1). Under the exact-audit goal, a green mutant is a mandatory stop condition; the later mutants and the one full `test:p1-server` run were therefore not run.

## Frozen artifact and scope

- `HEAD`: `d972c3f8181c8da927edd8cf9818044261d9b08b`
- `origin/cobalt/durable-delivery-server`: `d972c3f8181c8da927edd8cf9818044261d9b08b`
- branch: `cobalt/durable-delivery-server`
- initial `git status --porcelain=v1`: empty
- `git diff --stat f9689d5..d972c3f`: exactly `tests/p1-server/command.test.ts | 436 +++++++++++++++++++++++++++++++---------` (`341 insertions(+), 95 deletions(-)`)
- `git diff --name-only f9689d5..d972c3f`: exactly `tests/p1-server/command.test.ts`

## Source inspection of the four invariants

### 1. Poll settlement is awaited — source SATISFIES; control DISCRIMINATES

Exact implementation:

```ts
8945  const query = sql<BackendActivityRow[]>`
...
8982  if (winner.kind === "arm") {
...
8988    query.cancel();
8989    await Promise.allSettled([query]);
8990    if (settlementProbe !== undefined) {
8991      settlementProbe.cancelledPolls += 1;
8992      if (querySettled) settlementProbe.awaitedCancels += 1;
...
9000  } finally {
9001    if (cancelTimer !== null) clearTimeout(cancelTimer);
```

The original postgres.js `Query` is retained, the exact query is cancelled, its settlement is awaited through `Promise.allSettled`, the cancellation rejection is observed, and the timer is cleared.

Mutant: replaced `await Promise.allSettled([query])` with an unawaited call. Printed red:

- tests 1; pass 0; fail 1; duration 4930.019583 ms; real 4.96 s
- failing test: `durable-delivery: Phase B harness control — premature marker and request settlement fail fast with labels`
- diagnostic: `every cancelled poll query must be awaited before return; probe: {"cancelledPolls":1,"awaitedCancels":0}`

Restore proof: candidate and restored worktree blobs both `e8714b67c72582b36aeb883b8a0478fdaad0b99e`; clean status; residual process count 0.

### 2. One monotonic absolute deadline — source SATISFIES; control DOES NOT DISCRIMINATE

Exact implementation:

```ts
9040  const monotonicStart = performance.now();
9041  const absoluteDeadline = monotonicStart + deadlineMs;
...
9049    const remaining = absoluteDeadline - performance.now();
9050    if (remaining <= 0) break;
9051    const poll = await runBlockedBackendsPoll(pendingArms, remaining, opts.settlementProbe);
...
9084    const sleepMs = Math.min(50, Math.max(0, absoluteDeadline - performance.now()));
9085    if (sleepMs <= 0) break;
9086    await delay(sleepMs);
```

The candidate source itself uses one `performance.now()` absolute deadline, recomputes remaining time around every poll, avoids sleeping with no time left, and clamps sleep to `min(50, max(0, remaining))`. `runBlockedBackendsPoll` clears its timer in `finally`, and its deadline cancellation settles through the awaited query/race path.

Required mutant: reverted those lines to `Date.now()` and the predecessor's unconditional `await delay(50)` after only a deadline check. It stayed green:

- tests 1; pass 1; fail 0; duration 6185.205667 ms; real 6.22 s
- green test: `durable-delivery: Phase B harness control — wrong observation pattern reports the real blocked backend, never observed=[]` (3164.800459 ms)

This fails the exact-audit acceptance contract. The current assertion only requires the measured operation to finish in `<8000 ms` for a nominal 1500 ms deadline, so a fixed 50 ms overshoot and a wall-clock implementation are both admitted.

Narrowest repair: make this control deterministically exercise the deadline clock and final sleep calculation (for example, inject the monotonic clock/sleep boundary into the harness and assert every requested sleep is at most the recomputed remaining time), and add an assertion that turns red when the helper bypasses that clock for `Date.now()`. The exact `Date.now()` plus unconditional-50-ms mutant must print red without relying on scheduling luck or an 8-second tolerance.

Restore proof: candidate and restored worktree blobs both `e8714b67c72582b36aeb883b8a0478fdaad0b99e`; clean status; residual process count 0.

### 3. `retainedAttempt` retained, released, and awaited on every pre-ready path — source SATISFIES; mutant NOT RUN after stop

Exact implementation:

```ts
10028  const armAttempt = retainPrincipalRowLock(...);
...
10037    mustRemainPending: [armAttempt],
...
10047  armHolder.release();
10048  await settleCleanupTruthfully(armFailure, [
10049    { label: "ARM principal holder", promise: armHolder.done },
10050    ...(await settleRetainedAttempt(armAttempt, ...)),
...
10086  const retainedAttempt = retainPrincipalRowLock(...);
...
10095    blockerPids: [holder.pid],
10098    mustRemainPending: [retainedAttempt],
...
10163  holder.release();
10164  await settleCleanupTruthfully(... [
10167    { label: "principal holder", promise: holder.done },
10168    ...(await settleRetainedAttempt(retainedAttempt, ...)),
```

The helper itself awaits the exact attempt settlement (`9213`), releases an escaped lock (`9222`), awaits its `done` settlement (`9223`), and labels unexpected rejection/fulfillment (`9214-9239`). Both the deliberately pre-PID-observation arm and the normal path retain the started attempt through cleanup. Source contract is satisfied. The exclusion mutant was not run because invariant 2's green mutant triggered the mandatory stop.

### 4. Arbitrary primary preserved by exact identity — source SATISFIES; mutant NOT RUN after stop

Exact implementation:

```ts
9154  async function settleCleanupTruthfully(
9155    primaryFailure: { failed: boolean; value: unknown },
...
9166  if (cleanupFailures.length === 0) return;
...
9171  if (primaryFailure.failed) {
9172    causes.push(primaryFailure.value);
...
9176    new Error(..., { cause: failure.reason }),
...
9182  throw new AggregateError(causes, ...);
```

Presence is separate from value, the exact primary is inserted without wrapping, cleanup failures are labelled while preserving exact causes, and clean cleanup returns so the caller's original throw continues unchanged. The control enumerates Error, object, string, number, symbol, null, and undefined at `10386-10423`. Source contract is satisfied. The sentinel/wrapper mutant was not run because invariant 2's green mutant triggered the mandatory stop.

## Gates and process proofs

Static gates, all green:

- `npm run check:tests`: exit 0; real 5.70 s
- `npm run check:edge`: exit 0 across command/read/capability; real 0.31 s
- `npm run build`: exit 0; real 3.78 s
- `npm test`: 196/196 passed, 0 failed; duration 4662.429208 ms; real 4.88 s
- `git diff --check f9689d5..d972c3f`: exit 0; real 0.03 s

DB-slot gates before the stop:

- DB SLOT START sent directly to ClaudeCswarm as Girder.
- competing-process count immediately before DB work: 0
- exactly one `npm run db:reset`: exit 0; real 34.08 s
- focused pristine Phase-B invocation: 8/8 passed, 0 failed; duration 18704.706583 ms; real 18.73 s
- process count after reset, pristine focused run, mutant 1 restore, and mutant 2 restore: 0 each
- final tracked candidate blob equals HEAD: `e8714b67c72582b36aeb883b8a0478fdaad0b99e`
- final worktree status: clean

Not run due to the mandatory stop: retained-attempt exclusion mutant, arbitrary-primary sentinel/wrapper mutant, pristine focused rerun after mutants, and the single full `npm run test:p1-server`.

## Not established

This audit did not establish acceptance of the Phase-B harness because invariant 2's control did not discriminate. It also did not establish Phase C, the integration union's DB behaviour, deployment, production behaviour, or real-load capacity. The stopped audit did not establish the later invariant-3/invariant-4 mutant discrimination or a pristine full 67-test server result at this SHA.
