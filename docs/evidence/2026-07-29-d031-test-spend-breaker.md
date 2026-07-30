# D-031 local spend-breaker isolation

**Date:** 2026-07-29  
**Implementer:** Mica  
**Implementation commit:** `b2e603319860fd0569ed1c5e5ea5bd85bca70788`

## What was measured

The earlier inference that 1,540 accumulated workspaces exhausted a per-identity limit is dead.
The failing requests returned `503`, and the local database held one open automatic
`swarm.spend_breaker` trip for `workspace_create`: observed 102 against the production ceiling
of 100/hour. The per-identity workspace limits use a fresh user for each scenario and were not
the cross-run state.

The production breaker was behaving as designed:

- spend is counted globally across sharded `spend:<proxy>:<shard>` hourly buckets;
- one open trip pauses self-serve workspace creation;
- `swarm.reset_spend_breaker` clears the latch but deliberately leaves counters intact; and
- the `swarm_command` edge role cannot execute the operator reset.

Several P1-server runs in one hour therefore left a global latch that poisoned later runs.
Clearing only the latch would not isolate the suite: the next accepted workspace creation
could cross the still-populated hourly counters and immediately trip it again.

## Decision

Only `tests/p1-server/command.test.ts` changes.

The P1-server setup now calls a test-only helper before starting the local functions. The
helper:

1. requires both the Supabase API URL and PostgreSQL URL to be literal loopback targets;
2. fails before opening its transaction if either target is production-shaped;
3. calls the existing operator reset through the suite's direct local PostgreSQL connection;
4. deletes all local `spend:%` shards; and
5. asserts, inside the same transaction, that no open trip or spend shard remains.

The production function, 100/hour ceiling, latch semantics, migration, and edge-role grants are
unchanged. No reset capability was added to an edge path.

## Observer and production-call-site mutation

The observer uses the real database and command function:

1. `swarm.trip_spend_breaker` opens the global latch;
2. `create_workspace` returns `503 signup_paused`;
3. the local test helper clears the latch and test spend shards; and
4. a new `create_workspace` returns `200` with the requested workspace ID.

The mutation bypassed the production call site
`await enforceSpendBreaker(tx, auth, ignoredIdentity)` in
`supabase/functions/command/index.ts`. The focused observer then failed on the intended
assertion:

```text
✖ D-031 local reset clears a latched breaker and restores signup
ℹ tests 1
ℹ pass 0
ℹ fail 1

AssertionError:
200 !== 503
at tests/p1-server/command.test.ts:2220:12
```

After restoring the production call site, `git diff --exit-code` reported no command-function
change and the same focused invocation returned:

```text
✔ D-031 local reset clears a latched breaker and restores signup
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
```

The named answer to “what fails if someone deletes the production breaker call?” is the
D-031 observer's `503` assertion.

## Gates

All database-touching invocations ran under an announced exclusive local Supabase slot and
were released separately with exact counts.

```text
npm run test:p1-server
tests 35
pass 35
fail 0
cancelled 0
skipped 0
```

The slot-free gates were:

```text
npm run check:tests
exit 0

npm run build
exit 0

npm run check:edge
exit 0

npm test
tests 79
pass 79
fail 0
skipped 0
```

## Rejected alternatives

- **Let the edge function reset the breaker when `SWARM_ENV=test`.** Rejected because the
  migration deliberately makes the edge role unable to clear a production latch. Adding a
  privileged edge reset would weaken the boundary the test is supposed to preserve.
- **Call only `swarm.reset_spend_breaker`.** Rejected because the migration explicitly leaves
  hourly counters intact; measured stale counters would let the next accepted action relatch.
- **Change the production 100/hour ceiling or automatic/manual latch behavior.** Rejected
  because D-031 is test contamination, not evidence that the production product decision is
  wrong.
- **Use fresh identities.** Rejected because the actual latch is global; identity freshness
  cannot isolate global hourly spend.

## Not established

- This does not establish that 100 workspace creations/hour is the right launch ceiling.
- This does not establish production alerting, operator response time, or automatic recovery;
  the production latch remains manual by design.
- This does not make two simultaneous P1-server suites safe. The repository's exclusive DB
  slot remains required because the observer intentionally opens global state.
- This does not prevent a future single suite run that itself exceeds a production proxy
  ceiling from tripping mid-run; it isolates residue at suite start and measures the current
  35-test run below that boundary.
- Literal loopback checks do not defend against an operator intentionally tunneling both a
  production API and production database through loopback. They prevent an ordinary remote
  production configuration from reaching the test-only mutation; the helper also exists only
  in test source.
