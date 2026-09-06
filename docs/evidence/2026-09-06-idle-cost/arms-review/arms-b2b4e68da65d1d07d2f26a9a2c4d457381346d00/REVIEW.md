# Adversarial review — lane/idle-cost round 5 at b2b4e68da65d1d07d2f26a9a2c4d457381346d00

You are an independent Gemini arm. You did not write this lane. Do not praise it.
Work from the files named below. Change no files.

- Checkout: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-idle-cost`
- SHA: `b2b4e68da65d1d07d2f26a9a2c4d457381346d00`
- Base: `32842efefa01f7cbe1ff985a98ad9e3ba0568ce7`
- Diff: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-idle-cost/arms-b2b4e68da65d1d07d2f26a9a2c4d457381346d00/DIFF.patch`

Before any finding, quote back the first `diff --git` line of DIFF.patch exactly. If you cannot, stop and FAIL.

## What the lane claims

1. Idle poll 15 s / 60 s, generated `--poll-interval` copy, read and command share the wait.
2. Idle `claim_agent_inbox` writes no audit row, no idempotency key, no rate_buckets upsert. Empty retry re-executes. Non-empty still persists.
3. No migration in this lane touches `swarm.audit_log`. Claim-class keys purge at 2 days when `command_id` matches `claimCommandId()` (`^claim_[0-9a-f]{32}_[0-9a-z]+$`). Other keys keep 30 days. Integer purge has no DEFAULT.
4. **Round-5 fix.** Claim throughput scores each completed hour against the cadence in force during that hour (`claimHours[].cadenceMs`), not the latest `claimCadenceMs`. An hour idled at 60 s then reset to 15 s does not lapse. An hour wedged at 15 s still lapses after cadence is later 60 s. Old status files without per-hour cadence fall back to `claimCadenceMs`.

## Eight checks (attack each; attempted refutation required)

1. **Grep the two 20260906 migrations for `audit_log`.** Any hit is a DEFECT. Confirm `20260906000003` does not exist.

2. **Claim-id regex** still matches `claimCommandId()` and rejects `claim_agent_inbox_x`. Integer purge has no DEFAULT.

3. **Per-hour cadence.** `summarizeListenerReadHealth` must not compute `expectedClaims = HOUR_MS / health.claimCadenceMs` once and apply it to every past hour. `recordListenerClaimCadence` must take `ts` and write `cadenceMs` onto that hour bucket. Supervisor idle_poll and ready must pass `event.ts`.

4. **The two tests.** Drive 60 claims at 60 s then reset to 15 s: no lapse. Drive 60 claims at 15 s then later 60 s: still lapse (`60/240`). A test that only constructs objects without `recordListenerClaimCadence` is weaker; a test that still scores against the latest cadence is a DEFECT.

5. **Old files.** `parseListenerReadHealth` must accept `{hourStart, claims}` without `cadenceMs` when `rejectUnknownKeys` is true, and must accept `cadenceMs` as an optional known key.

6. **Idle three-row skip** still holds. Empty polls must not upsert `rate_buckets`. README Not established must name the empty-queue rate-limit skip and that the next lane is `push`.

7. **Purge cap.** README must say the 200 × 5000 = 1 M nightly cap cannot drain 1.47 M keys in one run (two nights). Generated duration examples. Both-edge arithmetic: 2 s → 86,400; 15 s → 11,520.

8. **Apply order.** `000001` then `000002` then edge then client release then fleet restart.

## Output

- Concrete `path:line` for every finding.
- DEFECT vs NIT.
- Last line exactly `VERDICT: PASS` or `VERDICT: FAIL`. FAIL on any DEFECT.
