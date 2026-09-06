# Adversarial review — lane/idle-cost round 6 at 446ebb43b84693a30704a4b4bd59e5ad7b1b60bb

You are an independent Gemini arm. You did not write this lane. Do not praise it.
Work from the files named below. Change no files.

- Checkout: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-idle-cost`
- SHA: `446ebb43b84693a30704a4b4bd59e5ad7b1b60bb`
- Base: `32842efefa01f7cbe1ff985a98ad9e3ba0568ce7`
- Diff: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-idle-cost/arms-446ebb43b84693a30704a4b4bd59e5ad7b1b60bb/DIFF.patch`

Before any finding, quote back the first `diff --git` line of DIFF.patch exactly. If you cannot, stop and FAIL.

## What the lane claims

1. Idle poll 15 s / 60 s, generated `--poll-interval` copy, read and command share the wait.
2. Idle `claim_agent_inbox` writes no audit row, no idempotency key, no rate_buckets upsert.
3. No migration in this lane touches `swarm.audit_log`. Claim-class keys purge at 2 days on the `claimCommandId()` regex. Other keys keep 30 days.
4. **Round-6 fix.** An hour is scored at the slowest cadence recorded in it (`Math.max` of `cadenceMs`). Last-writer-wins is a DEFECT. A 60 s hour with a 15 s mid-hour record and 61 claims must not lapse. A 15 s hour that later records 60 s mid-hour with 60 claims also must not lapse (documented under-detection). Round-5 across-hour tests stay green. Old files still parse.

## Eight checks (attack each; attempted refutation required)

1. **Grep the two 20260906 migrations for `audit_log`.** Any hit is a DEFECT.

2. **Claim-id regex** still matches `claimCommandId()` and rejects `claim_agent_inbox_x`. Integer purge has no DEFAULT.

3. **`recordListenerClaimCadence` keeps `max(existing, new)`.** Overwrite (`hour.cadenceMs = cadenceMs`) is a DEFECT. The comment at `read-health.ts` must state the slowest-cadence rule in one sentence.

4. **Tests.** (a) 60 s then 15 s mid-hour, 61 claims: no lapse. (b) 15 s then 60 s mid-hour, 60 claims: no lapse. Round-5: 60 s hour then 15 s next hour: no lapse; 15 s hour then 60 s next hour: still lapses `60/240`. Tests must drive `recordListenerClaimCadence`, not only hand-built objects.

5. **README Not established** must say: scoring at the slowest cadence cannot false-lapse; it can miss a wedge only inside one hour that also had a slow interval. Time-weighted segments must not be present.

6. **Idle three-row skip** still holds. Empty-queue rate-limit skip named in README; next lane `push`.

7. **Generated duration examples.** Both-edge arithmetic: 2 s → 86,400; 15 s → 11,520. Purge cap 1 M/night, two-night drain.

8. **Apply order.** `000001` then `000002` then edge then client release then fleet restart.

## Output

- Concrete `path:line` for every finding.
- DEFECT vs NIT.
- Last line exactly `VERDICT: PASS` or `VERDICT: FAIL`. FAIL on any DEFECT.
