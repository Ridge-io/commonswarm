# Lane A report — idle-cost round 6

SHA: `446ebb43b84693a30704a4b4bd59e5ad7b1b60bb`
Base: `32842efefa01f7cbe1ff985a98ad9e3ba0568ce7`
Branch: `lane/idle-cost`
Author: Yulan Bot `<yulanbot@gmail.com>`
On top of round 5: `b2b4e68da65d1d07d2f26a9a2c4d457381346d00`

## Defect (Opus on b2b4e68)

`recordListenerClaimCadence` was last-writer-wins. An hour idled at 60 s with one 15 s record at 10:59:30 scored 61/240 (0.254) and false-lapsed. Measured by the arm; reproduced here.

Fix: keep `max(existing, new)` for that hour. Slowest cadence. Cannot false-lapse. Can miss a wedge only inside one hour that also had a slow interval. No time-weighted segments.

## Claims (three sentences)

Idle poll is 15 s, backs off to 60 s, and the read POST shares that wait. An idle `claim_agent_inbox` writes no audit, no idempotency key, and no rate_buckets upsert. Each claim-throughput hour is scored at the slowest cadence recorded in it.

## Pins

- 60 s then 15 s mid-hour, 61 claims: no lapse (arm's case).
- 15 s then 60 s mid-hour, 60 claims: no lapse (under-detection, pinned).
- Round-5 across-hour tests stay green.

## Mutation

| mutate | mutated | restored |
|---|---|---|
| last-writer-wins (`hour.cadenceMs = cadenceMs`) | test (a) fail, exit 1, 61/240 (0.254) | pass, exit 0 |

## Gates (this SHA)

| gate | exit |
|---|---|
| `npm run build` | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 |
| `npm test` | 0 (858 pass) |
| `npm run test:p1-cli` | 0 (483 pass; `FORCE_COLOR` unset) |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 (36 address-fields) |

**Not run this round:** `db:reset`, `test:p1-local`, `test:p1-server`. Another lane holds the local database. This diff is client TS only. Round-5 server gates on `b2b4e68` still stand (147 pass after db:reset).

## Files (27)

docs/evidence/2026-09-06-idle-cost/README.md, docs/evidence/2026-09-06-idle-cost/arms/REVIEW-4cfff7b.md, docs/evidence/2026-09-06-idle-cost/arms/gemini-4cfff7b-FAIL.txt, package.json, src/cli.ts, src/cloud/arrival-watch.ts, src/cloud/idle-poll.ts, src/listener/control.ts, src/listener/detach.ts, src/listener/read-health.ts, src/listener/runtime.ts, src/listener/supervisor.ts, supabase/functions/command/durable-delivery.ts, supabase/functions/command/file-artifacts.ts, supabase/functions/command/index.ts, supabase/migrations/20260906000001_idle_cost_retention.sql, supabase/migrations/20260906000002_file_versions_quota_index.sql, tests/claim-ledger-parse.test.ts, tests/idle-cost-retention.test.ts, tests/idle-poll.test.ts, tests/listener-detach.test.ts, tests/listener-host-limits.test.ts, tests/listener-runtime.test.ts, tests/p1-cli/citation-drift.test.ts, tests/p1-cli/listener-provider.test.ts, tests/p1-server/command.test.ts, tests/support/arrival-watch.test.ts

This SHA: read-health.ts, listener-host-limits.test.ts, README.md.

## Arithmetic (both edges)

| cadence | both edges / seat/day | 16 seats / 30 days |
|---|---:|---:|
| 2 s | 86,400 | 41,472,000 |
| 15 s | 11,520 | 5,529,600 |
| 60 s | 2,880 | 1,382,400 |

## NOT established

- Production apply.
- Round-6 Gemini verdict (pid 81355 still running).
- Time-weighted expected claims (ruled out).
- Empty-queue claim ceiling (deferred to `push`).
- A wedge inside one hour that also had a slow interval (by design).
- This round did not re-run p1-server.

## Apply order

1. `20260906000001` then `20260906000002`
2. Edge `command`
3. Client release
4. Fleet restart (0.1.56 stays at 2 s until restart)

## Arm pids

| pid | what | state |
|---|---|---|
| 35875 | Gemini round 1 on 4cfff7b | gone; VERDICT: FAIL |
| 89287 | Gemini round 2 on 9e7d2ac | gone; VERDICT: FAIL |
| 13094 | Gemini round 3 on d5cc936 | gone |
| 47444 | Gemini round 4 on 4a9e344 | gone |
| 65678 | Gemini round 5 on b2b4e68 | not waited |
| 81355 | Gemini round 6 on 446ebb4 | live; ARM.txt 0 bytes |
