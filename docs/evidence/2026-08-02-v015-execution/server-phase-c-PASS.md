# Server Phase C result — delivery recharge at `resolveLedgerRace`

Worker: Keystone  
Branch: `cobalt/durable-delivery-server`  
Frozen accepted Phase-B base: `5f5018a64cdc77326e190eaba714c2ba9ee0f15f`  
Pushed test-only checkpoint: `e3dc295321abcbeac28b6418b396e85d69b99f6f`

## Outcome

Phase C passed. The pristine production path reached and directly exposed the delivery-rate
recharge at `resolveLedgerRace` in both allowed and denied topologies. The narrow mutant that
deleted only that recharge block reached both late topologies and failed with the exact causal
outcomes required by the binding corrections. Production was restored byte-identically before
the final reset and gates.

Permanent diff: `tests/p1-server/command.test.ts` only, +845 lines.  
Temporary mutant: `supabase/functions/command/index.ts`, absent from the committed diff.

## Preflight proofs

- `HEAD`, `origin/cobalt/durable-delivery-server`, and live
  `refs/heads/cobalt/durable-delivery-server` all equalled
  `5f5018a64cdc77326e190eaba714c2ba9ee0f15f` before work.
- `git status --porcelain=v1` was empty.
- No `git fetch` was run.
- Production scope diff from accepted Phase A
  `3039cce13dbb8d70d3c09e0fc75030df4287deec` was empty.
- Exact production blob controls matched Phase A and Phase B:
  - `supabase/functions/command/index.ts`: `64d2912dbdd652f810d5295f1019c6b5e96f9685`
  - `supabase/functions/command/durable-delivery.ts`: `7b877787f1d0565362a31d3097361d249cd82289`
  - `src/protocol/index.ts`: `bd15b855a9dd12288d2807695a1d8f2c3dd45050`
- The Phase-B helper remained unchanged, including the optional `timingControl` seam, monotonic
  absolute polling deadline, recomputed bounded sleep, awaited cancellation settlement, arbitrary
  primary identity preservation, and full candidate diagnostics.
- Initial exact process probe
  `pgrep -f 'supabase_db_cloud-swarm|test:p1-server' | wc -l` returned `0`.

## Causal topology observed

The final full-suite observations are recorded below. Backend reuse after ACK completion is
expected: the resolver is a new transaction and may reuse the ACK backend PID.

### Allowed

- DB minute: `2026-08-03T04:10:00.000Z`; both request `xact_start` and current `query_start`
  truncated exactly to this window at the ledger barrier.
- Holders: L=`7379` (ACCESS EXCLUSIVE on `swarm.idempotency_keys`), A=`7378` (exact ACK
  `signal_deliveries` row FOR UPDATE), P=`7474` (exact recipient `agent_principals` row FOR UPDATE).
- Initial request PIDs: ACK=`7524`, claim=`7722`; two distinct backends, each blocked only by L.
- Both bounded initial queries were:
  `SELECT workspace_id, stream_id, request_hash, response FROM swarm.idempotency_keys WHERE principal_kind = $1 AND principal_id = $2 AND command_id = $3 LIMIT 1`.
- Exact rate probes: ACK=`492`, claim=`7723`. The `phase_c_ack_rate_probe` and
  `phase_c_claim_allowed_rate_probe` each had exactly one blocker and mapped the two request PIDs
  one-to-one, proving both original charges and no hidden principal/auth/pool serialization.
- After L released, mapped ACK `7524` blocked only on A at bounded query
  `SELECT ack_outcome, acked_at, last_lease_id, last_leased_by FROM swarm.signal_deliveries ... FOR UPDATE LIMIT 1`;
  mapped claim `7722` blocked only on P at bounded query
  `SELECT principal_id, revoked_at FROM swarm.agent_principals ... FOR UPDATE`.
- Shared ledger count while both were behind A/P: `0`.
- A released: exact ACK 200 committed; ACK probe acquired count `1` and committed; shared ledger
  count became `1`; claim `7722` was re-observed behind P.
- P released: queued claim probe acquired first at count `0`.
- Resolver recharge PID=`7524` was then directly observed on the production
  `INSERT INTO swarm.rate_buckets ... ON CONFLICT ...` blocked only by claim probe `7723`.

### Denied

- DB minute: `2026-08-03T04:10:00.000Z`; both request time fields truncated exactly to it.
- Holders: L=`7378`, A=`492`, P=`7723`.
- Initial request PIDs: ACK=`7524`, claim=`7722`; each initial ledger query blocked only by L.
- Exact rate probes: ACK=`7474`, claim saturator=`7724`; each had one exact request blocker and
  together mapped both request PIDs.
- After L released, ACK `7524` blocked only on A and claim `7722` blocked only on P using the same
  bounded production queries above; shared ledger count remained `0`.
- A released: ACK committed, ACK probe acquired count `1`, winner ledger count became `1`, and
  claim was re-observed behind P.
- P released: the queued denied probe acquired first and returned exactly `120`, proving the
  original claim charge had been the allowed 120th charge before its losing transaction rolled back.
- Resolver recharge PID=`7524` was directly observed blocked only by claim probe `7724`.

No barrier assertion was widened. Every holder, HTTP promise, probe, observation, and settlement
arm was retained; cleanup used the repaired Phase-B adjudicator.

## Pristine assertion sets

Allowed:

- `resolverObserved=true`
- ACK: exact 200 body
  `{"status":"accepted","ok":true,"event_ids":[],"signal_id":"<A>","outcome":"observed"}`
- claim: exact 409 `{"error":"command_id_conflict"}`
- exact buckets: ACK `1`, claim `1` (claim probe acquisition was `0`)
- signal B byte snapshot unchanged
- exactly one shared ACK-winner ledger row with exact workspace/stream/principal/command/hash and
  response `{"ok":true,"event_ids":[],"signal_id":"<A>","outcome":"observed"}`
- losing claim refs/listener/content sentinels absent from the ledger response
- exactly two audits: ACK accepted/null reason/null detail; claim conflict/
  `command_id_conflict`/`resolved concurrent idempotency race`
- zero alerts

Denied:

- `resolverObserved=true`
- ACK exact 200; claim exact 429 body with limit `120`, reset exactly recorded window + one minute,
  required message, and integer `Retry-After` in `1..60`
- exact buckets: ACK `1`, claim `121` (claim probe acquisition was `120`)
- signal B and ACK-winner ledger unchanged
- exactly two audits: ACK accepted; claim `rate_limit` / `delivery_claim_rate_limited` with null
  detail/hash/stream
- exactly one `delivery_claim_rate_limit` alert with only `workspace_id`,
  `recipient_principal_id`, `operation`, `limit`, and `resets_at`
- response and alert privacy sentinels passed their surface-specific forbidden-marker checks

## Recharge-deletion mutant

Pre-mutation production file SHA-256:
`b84f0304b1e81158195fd51c3a59e770b5170066b88d094c697418e009e486f0`.

Only the delivery recharge conditional at `resolveLedgerRace` entry was deleted. The focused mutant
started normally, reached both complete late topologies, and failed 0/2 in 22.95 s:

- Allowed window `2026-08-03T04:08:00.000Z`: L/A/P=`529/601/602`, ACK/claim=`604/582`,
  ACK/claim probes=`603/605`; queued claim probe acquired `0`; final
  `resolverObserved=false`, ACK 200, claim 409, ACK bucket `1`, claim bucket `0`, audits `2`, alerts `0`.
- Denied same window: L/A/P=`606/529/605`, ACK/claim=`604/582`, probes=`603/602`; queued claim
  probe acquired `120`; final `resolverObserved=false`, ACK 200, claim **409 instead of 429**,
  ACK bucket `1`, claim bucket `120`, audits `2`, alerts `0`.

This was not a compile failure, startup failure, timeout, cleanup rejection, or earlier-topology
failure. Both failures were the expected missing-recharge outcomes printed in the assertion diff.

## Restore proof

- Post-restore SHA-256:
  `b84f0304b1e81158195fd51c3a59e770b5170066b88d094c697418e009e486f0` (exact pre-mutant match).
- Working-tree blob: `64d2912dbdd652f810d5295f1019c6b5e96f9685`.
- Accepted Phase-B blob: `64d2912dbdd652f810d5295f1019c6b5e96f9685`.
- `git diff --exit-code 5f5018a... -- supabase/functions/command/index.ts` returned 0.
- Final committed diff contains no production path.

## Gates and elapsed time

Authoritative restarted static sequence after the only test-side assertion normalization:

- `npm run check:tests`: exit 0, 1.83 s.
- `npm run check:edge`: exit 0, all three entrypoints, 0.19 s.
- `npm run build`: exit 0, 1.06 s.
- `npm test`: 196/196 pass, 0 fail, 2.29 s.
- `git diff --check`: exit 0, 0.02 s.

Exclusive sequence:

- zero-process proof: `0`.
- `npm run db:reset`: exit 0, schema and seed applied, 26.24 s.
- focused pristine, exact two-test invocation: 2/2 pass, 20.79 s.
- zero-process proof: `0`.
- focused mutant: 0/2 pass, 2 expected causal failures, 22.95 s.
- exact restore proofs above.
- zero-process proof: `0`.
- `npm run db:reset`: exit 0, 26.76 s.
- focused restored pristine: 2/2 pass, 5.70 s.
- exactly one final unfiltered `npm run test:p1-server`: 69/69 pass, 0 fail, 87.45 s.
- final zero-process proof: `0`.

Before the authoritative restart, one intended focused command used npm argument placement that
put `--test-name-pattern` after the glob; Node therefore ran all 69 tests. Both Phase-C topologies
and final facts were correct, but the two new tests failed only because postgres.js `Result(2)` is
not prototype-equal to a plain array. The test-only fix was `Array.from(result.audits)`; assertions
were not widened. The ordered static and exclusive sequences above were then restarted. An earlier
pre-restart static sequence also passed (check:tests 1.78 s, check:edge 0.23 s, build 1.10 s,
196/196 root tests 2.34 s, diff-check 0.02 s).

## Push/equality proof

- Commit: `e3dc295321abcbeac28b6418b396e85d69b99f6f`.
- Commit stat: exactly one test file, +845 lines.
- Push advanced remote branch `5f5018a..e3dc295`.
- Clean `HEAD`, local tracking ref, and live remote ref all equal
  `e3dc295321abcbeac28b6418b396e85d69b99f6f`.
- Final matching process count: `0`.

## Not established

This lane did **not** establish deployment, production application, production traffic behavior,
real-load capacity, or integrated-union database behavior. It did not merge, rebase, tag, deploy,
release, run `test:p1-cli`, run `test:p1-local`, join/set swarm status, broadcast, or contact
AdvisorClaude2. Exact re-audit and the independent cross-family inversion on the replacement SHA
remain the Lead's responsibility.
