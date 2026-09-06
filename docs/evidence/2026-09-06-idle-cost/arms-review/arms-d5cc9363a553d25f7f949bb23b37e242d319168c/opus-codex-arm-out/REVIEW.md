# Adversarial review — lane/idle-cost round 3 at d5cc9363a553d25f7f949bb23b37e242d319168c

You are an independent Gemini arm. You did not write this lane. Do not praise it.
Work from the files named below. Change no files.

- Checkout: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-idle-cost`
- SHA: `d5cc9363a553d25f7f949bb23b37e242d319168c`
- Base: `32842efefa01f7cbe1ff985a98ad9e3ba0568ce7`
- Diff: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-idle-cost/arms-d5cc9363a553d25f7f949bb23b37e242d319168c/DIFF.patch`

Before any finding, quote back the first `diff --git` line of DIFF.patch exactly. If you cannot, stop and FAIL.

## What the lane claims

1. Idle poll 15 s / 60 s, generated `--poll-interval` copy, read and command share the wait.
2. Idle `claim_agent_inbox` writes no audit row, no idempotency key, no rate_buckets upsert. Empty retry re-executes. Non-empty still persists.
3. **No migration in this lane touches `swarm.audit_log`.** `20260906000001` is idempotency batching plus `claim_idempotency_retention_days=2` plus `rate_buckets_window_start`. `20260906000002` is the file_versions index. There is no `20260906000003`. Historical 662 MB audit is never purged.

## Eight checks (attack each; attempted refutation required)

1. **Grep the two 20260906 migrations for `audit_log`.** Any hit is a DEFECT: trigger, index, DELETE, function that deletes those rows, config key `claim_audit_retention_days`. Confirm `20260906000003_idle_cost_round2.sql` does not exist in the tree.

2. **000001 on a fresh database.** It must CREATE OR REPLACE the existing `purge_expired_idempotency_keys` (zero-arg and integer), INSERT the 2-day config ON CONFLICT, CREATE INDEX IF NOT EXISTS on rate_buckets. It must not `cron.schedule` a second job. Existing `swarm-purge-idempotency-keys` stays.

3. **Claim-class 2-day vs 30-day others.** 3-day `claim_agent_inbox_%` keys go; 3-day `post_signal_%` keys stay. Identification by `command_id LIKE 'claim_agent_inbox_%'` — find a persisted claim whose id does not match.

4. **Idle three-row skip** still holds in `command/index.ts`. Empty polls must not upsert `rate_buckets`. Poison still persists.

5. **Generated examples.** `idlePollDurationExamples()` from DEFAULT, DEFAULT×2, MAX. Typed `["15s","30s","1m"]` is a DEFECT.

6. **Quota index honesty.** README must not claim production Index Scan was observed.

7. **Both-edge arithmetic.** 2 s → 86,400 both-edges/seat/day; 16×30 = 41,472,000. 15 s → 11,520 / 5,529,600.

8. **Apply order and cadence.** Migration `000001` then `000002` then edge then client release then fleet restart. 0.1.56 stays at 2 s until restart. A production apply of this SHA must never drop the append-only DELETE guarantee even for one statement.

## Output

- Concrete `path:line` for every finding.
- DEFECT vs NIT.
- Last line exactly `VERDICT: PASS` or `VERDICT: FAIL`. FAIL on any DEFECT.
