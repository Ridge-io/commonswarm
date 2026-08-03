# /goal — Server Phase-B final harness settlement repair

Status: **worker complete at `d972c3f8181c8da927edd8cf9818044261d9b08b`; awaiting independent
exact acceptance as of 2026-07-31 21:59 CDT.** Do not resume writing or start Phase C until the
four repaired invariants receive exact acceptance.

Lane: durable-delivery server Phase B, final narrow evidence-harness repair.  
Writer: fresh DeepSeek V4-Flash through Pi.  
Worktree: `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery`.  
Branch: `cobalt/durable-delivery-server`.  
Frozen blocked base: `f9689d50e2bbdd42463747e031e42e3b289de54a`.  
Accepted production base: `3039cce13dbb8d70d3c09e0fc75030df4287deec`.

Read root `AGENTS.md`, both Phase-B repair goals, the candidate file, and the exact-audit findings
below. Stop unless HEAD, clean tree, local tracking ref, and live remote branch equal the frozen
base. Preserve the four original success paths and every valid repair already present.

## Ownership and exclusions

Own exactly `tests/p1-server/command.test.ts`. Do not touch production, migrations, generated
protocol, package, design, client, runtime, UI, version, or Phase C. You own the sole DB slot while
running database gates; never overlap actions.

## Exact remaining blockers

The frozen SHA passes focused 8/8 and full 67/67, but its instrument remains release-blocked:

1. When a `mustRemainPending` arm wins `runBlockedBackendsPoll`, the code calls `query.cancel()` and
   returns without awaiting the original query's settlement. The SQL work is still detached.
2. The loop checks its deadline and then unconditionally sleeps 50ms. It can exceed the advertised
   absolute bound, and `Date.now()` is wall clock rather than the claimed monotonic clock.
3. The pre-ready causal control starts `retainedAttempt` before `try` but deliberately excludes it
   from cleanup and from the observation's must-remain-pending arms. An earlier assertion failure
   can release the holder, let that attempt acquire the lock, and leave its returned `done` waiting
   on an unreachable gate.
4. Cleanup uses null/undefined as the no-primary sentinel and wraps non-Error primaries. It cannot
   preserve the exact identity of `throw null`, `throw undefined`, or an arbitrary object when
   cleanup also fails. The current causal control covers only an `Error` primary.

Production blobs, one-file scope, original success paths, causal topology, and package reachability
otherwise passed exact audit.

## Frozen repair

### Poll settlement and monotonic deadline

- When a pending arm wins, cancel the exact postgres.js query **and await its settlement** before
  returning the arm result. Retain the original Query, observe cancellation rejection with
  `Promise.allSettled`, and leave no derived unhandled rejection.
- Use one monotonic absolute deadline (`performance.now()` or `process.hrtime.bigint()`), not wall
  clock.
- After every poll, compute remaining time again. Sleep only
  `min(50ms, max(0, remaining))`; do not enter sleep when no time remains. No retry may reset or
  overshoot the intended deadline by a fixed interval.
- Clear every timer and await every cancelled query on all exits.

### Pre-ready control cleanup

- Include `retainedAttempt` as a must-remain-pending arm when observing its exact blocked query,
  and use the holder PID as the expected blocker.
- Retain the returned `RetainedLock` if the attempt unexpectedly fulfills. Cleanup must release its
  gate and await its `done` before surfacing failure.
- Retain/await the attempt on every path, including failures before PID observation or
  `pg_cancel_backend`. An expected verified cancellation may normalize to a fulfilled cleanup arm;
  an early/unexpected rejection or fulfillment becomes a labelled cleanup failure and is combined
  with the primary failure.
- Never exclude a started promise merely because the success path already asserted its expected
  rejection.

### Exact arbitrary-primary preservation

- Represent primary presence separately from its value, for example
  `{ failed: boolean; value: unknown }`; never use null/undefined as a sentinel.
- If cleanup also fails, `AggregateError.errors` must contain the exact original primary value by
  identity, even when it is `null`, `undefined`, a string, number, symbol, or arbitrary object.
- Label cleanup failures without replacing their causes. With clean cleanup, the original throw
  continues unchanged through the existing `catch { throw }` path.

## Causal controls

Extend the existing controls without adding unbounded work:

- make the pre-ready test fail before/while observing and prove its retained attempt still settles
  and releases; no backend remains;
- demonstrate the wrong-pattern diagnostic respects a short monotonic bound and reports the real
  row;
- demonstrate cancelled poll-query settlement is awaited when a request fulfills/rejects early;
  a tracked or temporary mutant that removes the await must turn the control red or an exact
  instrumented probe must prove the pending query settles before return; and
- run cleanup adjudication with Error, object, null, and undefined primaries plus a cleanup
  rejection, asserting exact identity in `AggregateError.errors`. Reverting to the old sentinel or
  Error wrapper must turn it red.

Restore tracked bytes after any mutant and prove zero residual test/serve processes.

## Gates and handoff

Static gates: `check:tests`, `check:edge`, build, root test, and base diff check. Under the sole DB
slot: prove zero matching processes, one reset, focused Phase-B success/control invocation, bounded
causal mutants, pristine focused rerun only if tracked bytes moved, then exactly one full
`test:p1-server`. Do not run `test:p1-cli` or Phase C.

Commit once, push, prove clean HEAD/local tracking/live remote equality and zero residual processes,
report directly to Lead7, leave swarm, exit Pi, freeze. Never broadcast or contact AdvisorClaude2.
State Phase C, integration-union DB behavior, deployment, production, and real-load capacity as
unestablished.
