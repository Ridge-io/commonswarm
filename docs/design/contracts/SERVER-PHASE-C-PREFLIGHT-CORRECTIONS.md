# Server Phase C preflight corrections

Status: **binding preflight; not dispatchable until Phase B exact acceptance**  
Observed Phase-B candidate during preflight: `d972c3f8181c8da927edd8cf9818044261d9b08b`  
Permanent owned path: `tests/p1-server/command.test.ts` only  
Temporary mutant path: `supabase/functions/command/index.ts`, restored byte-identically

The older Phase-C goal is under-instrumented. Observing only the ACK-row and principal locks does
not prove either initial ledger lookup, the original claim charge, or that `resolveLedgerRace`
ran. Use the following corrected topology and gates.

## Preconditions

- Base the goal on the Lead-supplied exact **accepted** Phase-B SHA, never merely `d972c3f` or a
  branch name.
- Require clean `HEAD == local tracking == live remote == accepted Phase-B SHA`.
- Require production blobs equal accepted Phase-A `3039cce13dbb8d70d3c09e0fc75030df4287deec`.
- Require Phase-B helpers to retain monotonic absolute polling deadlines, awaited cancellation
  settlement, bounded remaining-time sleeps, exact arbitrary-primary cleanup identity, and full
  candidate diagnostics.
- Acquire the exclusive DB slot and prove zero matching server-test/function-serve processes.
- Stop if reset exposes schema failure. Actual schema facts:
  - `rate_buckets(bucket_key, window_start, count)` with composite PK;
  - `idempotency_keys` PK `(principal_kind, principal_id, command_id)`;
  - `audit_log` has no `command_id`, so use audit/alert watermarks;
  - delivery column is `recipient_agent_principal_id`;
  - alert JSON intentionally uses `recipient_principal_id`.
- Every race test has a 30-second Node timeout.

## Shared fixture, once for each allowed and denied test

1. Create one fresh agent through public helpers.
2. Post signal A, publicly claim only A, retain its live ACK tuple: `signal_id`, `lease_id`, and
   original listener.
3. Post distinct signal B afterward and prove B is unleased with `attempt_count=0`.
4. Prove `agent_tokens.first_used_at IS NOT NULL`; otherwise concurrent first-use authentication
   can serialize and invalidate the race.
5. Use one fresh shared command ID only for competing ACK and claim. Invoke ACK first so the
   fixture records the eventual ledger winner, then start claim without awaiting either.
6. Delete prior delivery claim/ACK rate rows for the fresh principal.
7. Snapshot the complete signal-B row, zero shared-ledger count, audit and alert max-ID watermarks,
   and all private sentinels.

Use the same principal with distinct keys:

```text
delivery:ack:principal:<workspace>:<principal>
delivery:claim:principal:<workspace>:<principal>
```

## Eliminate minute-boundary flakiness

Use a bounded monotonic DB-clock barrier and start only with at least 15 seconds left in the DB
minute. Record `window_start = date_trunc('minute', statement_timestamp())`. At the ledger barrier,
assert each backend's `xact_start` and current `query_start` truncate to that window. The denied
response must identify exactly `window_start + 1 minute` as `resets_at`. Any crossing invalidates
the instrument; do not widen assertions or rerun blindly.

## Required causal topology

Retain three holders:

```text
L  ACCESS EXCLUSIVE on swarm.idempotency_keys
A  FOR UPDATE on the exact ACK signal_deliveries row
P  FOR UPDATE on the exact recipient agent_principals row
```

Then:

1. Start ACK and claim HTTP promises, ACK first.
2. Observe two distinct function backend PIDs blocked on the initial idempotency-key SELECT, each
   blocked only by L.
3. Start two retained exact-window rate probes: ACK is a zero/no-op upsert on its exact bucket;
   claim is a zero/no-op upsert on the absent allowed bucket or a saturating increment on the
   seeded denied bucket.
4. Prove each probe PID is blocked by exactly one request PID. This maps ACK versus claim and proves
   both original charges, distinct buckets, and absence of hidden principal/auth/pool serialization.
5. Release L.
6. Observe mapped ACK blocked on A and mapped claim blocked on P.
7. While both are blocked, assert the shared ledger is absent. Combined with the earlier table-lock
   observation, this proves both initial lookups returned absent.
8. Release A only. Await exact ACK 200, its rate-probe acquisition/commit, and committed ACK ledger.
9. Re-prove claim remains behind P, then release P.

```text
ACK:   charge ACK -> initial ledger SELECT -L-> ACK row -A-> ledger INSERT/commit
CLAIM: charge CLM -> initial ledger SELECT -L-> principal -P-> losing INSERT/rollback
          rate probes map exact request PIDs
          queued claim-rate gate acquires first
          resolveLedgerRace rate upsert blocks behind that gate
```

## Prove `resolveLedgerRace` directly

Keep the queued claim-rate transaction open after the losing transaction rolls back and the probe
acquires its bucket: count 0 for allowed, count 120 for denied. While it is open, observe the exact
production minute-rate upsert blocked by that probe PID. ACK is already complete, so this later
upsert can only be the recharge at `resolveLedgerRace` entry.

Race this observation against safe settlement summaries of the claim HTTP promise. Retain and
await both arms. If response wins, record only `{status,error}` and continue cleanup. Release the
rate gate only after observing the resolver query.

## Allowed-recharge assertions

- resolver recharge query observed;
- ACK exact normal accepted body;
- claim exact `409 {"error":"command_id_conflict"}`;
- exact ACK bucket count 1 and claim bucket count 1, never 2;
- signal B exactly unchanged;
- exactly one shared ledger row, matching ACK workspace/stream/principal/command/hash;
- ledger response exactly `{"ok":true,"event_ids":[],"signal_id":"<ACK>","outcome":"observed"}`;
- no claim refs/count/listener/body/about/prompt/reply data in ledger;
- exactly two post-watermark audits: ACK accepted with null reason/detail, and claim conflict with
  `command_id_conflict` plus detail exactly `resolved concurrent idempotency race`;
- zero post-watermark alerts.

The exact conflict audit detail is a second resolver-path discriminator; ordinary replay conflict
does not write it.

## Denied-recharge assertions

Seed the captured claim bucket at 119. Before releasing P, the probe must queue behind the mapped
original claim PID; reaching later barriers proves its original charge was the allowed 120th.
After rollback, the saturator acquires first and returns exactly 120; observe resolver recharge
blocked behind it, then release it and require final count 121.

Exact response:

```json
{"error":"rate_limited","limit":120,"resets_at":"<DB window + 1 minute>","message":"Rate limit exceeded. Please retry after the reset window."}
```

Also require integer `Retry-After` 1-60, ACK bucket 1, unchanged signal B, unchanged ACK-winner
ledger, exactly two audits (ACK accepted; claim `rate_limit` / `delivery_claim_rate_limited` with
null detail/hash/stream), and exactly one `delivery_claim_rate_limit` alert with exact allowed
keys `workspace_id`, `recipient_principal_id`, `operation`, `limit`, `resets_at`.

Privacy is surface-specific. Losing response forbids raw token and all token/run/owner/principal/
workspace/command/signal/lease/listener/content sentinels. Audit checks only detail and reason, not
actor metadata. Alert permits only workspace and recipient-principal correlation metadata and
forbids every other secret/content/command marker.

## Recharge-deletion mutant

Temporarily delete only the delivery recharge block at `resolveLedgerRace` entry. The focused
mutant must reach both late topologies and fail causally:

- allowed: `resolverObserved=false`, claim still 409, claim bucket 0 instead of 1;
- denied: `resolverObserved=false`, claim 409 instead of 429, bucket 120, no rate-limit audit/alert.

Compile/startup failure, timeout, cleanup rejection, or earlier topology failure is not accepted
mutant evidence. Restore the exact production blob and prove byte/hash/diff equality.

## Cleanup, diagnostics, and gates

Retain every holder, HTTP request, probe query, marker, transaction, and observation promise.
Releases/cancels are idempotent. In `finally`, release L/A/P and probe gates, cancel pending exact
queries, then `Promise.allSettled` every started promise through the repaired Phase-B adjudicator.
Polls use one monotonic deadline, cancel and await exact SQL, and sleep only recomputed remaining
time. Diagnostics enumerate exact PID, bounded query, state, wait event, blockers, and safe request
summaries. Success proves captured PIDs have no active transaction/lock wait.

Static gates from accepted Phase B: `check:tests`, `check:edge`, build, `npm test`, diff-check.
Exclusive order: zero-process proof, reset, focused pristine two-test pattern, zero-process proof,
mutant expected red, exact restore, zero-process proof, reset, focused pristine green, exactly one
full `test:p1-server`. Do not run `test:p1-cli` in this lane.

Commit/push one test-only checkpoint, prove exact equality, freeze, and leave deployment,
production application, real-load capacity, and integrated-union DB behavior unestablished. Stop
rather than changing production if a pristine assertion exposes a production defect.
