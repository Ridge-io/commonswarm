# Adversarial review — lane/idle-cost round 2 at 9e7d2acc68928152ccc99d3e8df9f5ef31321650

You are an independent Gemini arm. You did not write this lane. Do not praise it.
Work from the files named below. Change no files.

- Checkout: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-idle-cost`
- SHA: `9e7d2acc68928152ccc99d3e8df9f5ef31321650` (branch `lane/idle-cost`)
- Base: `32842efefa01f7cbe1ff985a98ad9e3ba0568ce7`
- Diff: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-idle-cost/arms-9e7d2acc68928152ccc99d3e8df9f5ef31321650/DIFF.patch`

Before any finding, quote back the first `diff --git` line of DIFF.patch exactly. If you cannot, stop and FAIL.

Round-1 Gemini on `4cfff7b` FAILed because `IDLE_POLL_DURATION_EXAMPLES` was a typed list. That list is now generated. Also apply the round-2 addendum rulings.

## What the lane claims

1. Idle poll is 15 s, backs off to 60 s, `--poll-interval` examples and bounds come from the same constants, status sentence is generated. Read-edge POSTs share that wait.
2. An idle `claim_agent_inbox` (no unacked delivery, no poison) writes no audit_log, no idempotency_keys, and no rate_buckets upsert. A leased or poison claim still writes the ledger and still rate-limits. Empty command-id retry re-executes; non-empty replay is byte-identical.
3. `audit_log` is append-only again (no purge, 662 MB one-time). Existing idempotency cron honours `claim_idempotency_retention_days=2` for `claim_agent_inbox_%` keys. Quota query uses `file_versions_workspace_state_created` when workspace_id is selective. Cadence needs a client release.

## Eight checks (attack each; attempted refutation required)

1. **Generated examples.** Prove `idlePollDurationExamples()` is built from DEFAULT, DEFAULT*2, and MAX. A typed `["15s","30s","1m"]` is a DEFECT. D-053 and em-dashes in new user-facing text are DEFECTS.

2. **Three-row skip.** Idle polls must not touch `rate_buckets`. Find a path that still upserts on an empty claim. `hasUnackedDeliveries` false-negatives (skipping rate limit when a row exists) or false-positives (charging idle) are DEFECTS. Poison and hydration failure must still persist.

3. **Replay semantics.** Retry of an empty command id must re-execute, not 403. Retry of a non-empty claim must 409 on hash mismatch and 200 replay when identical. Quote the p1-server controls.

4. **No second purge.** `swarm-purge-idle-cost` must be unscheduled. `audit_log_append_only` must be `BEFORE UPDATE OR DELETE`. `purge_idle_claim_audit` / `purge_idle_cost_tables` must be dropped. The existing `swarm-purge-idempotency-keys` job must remain the only idempotency cron.

5. **2-day claim keys.** `claim_idempotency_retention_days` is 2 with GREATEST floor 2. Non-claim keys stay at GREATEST(30, idempotency_retention_days). A 3-day claim key must go; a 3-day `post_signal` key must stay. Identification by `command_id LIKE 'claim_agent_inbox_%'` — find a persisted claim whose id does not match.

6. **Quota EXPLAIN honesty.** README must not claim production Index Scan was observed. Seq scan on a local seed that matches almost every row is expected. A 1-row workspace must be able to Index Scan `file_versions_workspace_state_created`. Attack a UNION ALL rewrite that seq-scans the live arm if one is present.

7. **Both-edge arithmetic.** Recalculate 86400/interval × 2 edges. 2 s both-edges/seat/day = 86,400; 16 seats × 30 days = 41,472,000. 15 s = 11,520/seat/day, 5,529,600/month. If the README disagrees, FAIL.

8. **Cadence is a release.** `--poll-interval` is new surface. Old 0.1.56 listeners stay at 2 s until restart. Apply order must be migration → edge → client release → fleet restart.

## Output

- Concrete `path:line` for every finding.
- DEFECT vs NIT.
- Last line exactly `VERDICT: PASS` or `VERDICT: FAIL`. FAIL on any DEFECT.
