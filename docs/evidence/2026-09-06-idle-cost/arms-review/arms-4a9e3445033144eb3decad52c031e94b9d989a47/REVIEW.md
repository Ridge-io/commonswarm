# Adversarial review — lane/idle-cost round 4 at 4a9e3445033144eb3decad52c031e94b9d989a47

You are an independent Gemini arm. You did not write this lane. Do not praise it.
Work from the files named below. Change no files.

- Checkout: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-idle-cost`
- SHA: `4a9e3445033144eb3decad52c031e94b9d989a47`
- Base: `32842efefa01f7cbe1ff985a98ad9e3ba0568ce7`
- Diff: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-idle-cost/arms-4a9e3445033144eb3decad52c031e94b9d989a47/DIFF.patch`

Before any finding, quote back the first `diff --git` line of DIFF.patch exactly. If you cannot, stop and FAIL.

## What the lane claims

1. Idle poll 15 s / 60 s, generated `--poll-interval` copy, read and command share the wait.
2. Idle `claim_agent_inbox` writes no audit row, no idempotency key, no rate_buckets upsert. Empty retry re-executes. Non-empty still persists.
3. **No migration in this lane touches `swarm.audit_log`.** `20260906000001` is idempotency batching plus `claim_idempotency_retention_days=2` plus `rate_buckets_window_start`. `20260906000002` is the file_versions index. There is no `20260906000003`.
4. **Round-4 fix.** Claim-class 2-day retention matches `claimCommandId()` in `src/listener/delivery-journal.ts`: `claim_${cleanUuid}_${base36Ordinal}` via POSIX `^claim_[0-9a-f]{32}_[0-9a-z]+$`. It does not use `LIKE 'claim_agent_inbox_%'`. Other keys keep `GREATEST(30, idempotency_retention_days)`. The integer purge overload has no DEFAULT, so cron `SELECT swarm.purge_expired_idempotency_keys()` uniquely hits the zero-arg wrapper.

## Eight checks (attack each; attempted refutation required)

1. **Grep the two 20260906 migrations for `audit_log`.** Any hit is a DEFECT. Confirm `20260906000003_idle_cost_round2.sql` does not exist.

2. **Read the generator, then the SQL.** `claimCommandId()` at `src/listener/delivery-journal.ts` (cleanUuid = lowercase UUID with dashes stripped = 32 hex; ordinal = `toString(36)`). The migration must assign that exact shape once (`claim_id_re`) and use it for both `~` and `!~`. `LIKE 'claim_agent_inbox_%'` is a DEFECT. `'claim_agent_inbox_x'` must not match.

3. **Zero-arg cron uniqueness.** `swarm-purge-idempotency-keys` runs `SELECT swarm.purge_expired_idempotency_keys()`. The integer overload must have no DEFAULT. A DEFAULT that makes that call ambiguous is a DEFECT.

4. **Pins.** A pure test must read the regex from the migration file on disk, mint an id through `claimCommandId()`, match it, and reject `'claim_agent_inbox_x'`. The p1-server test must mint through `claimCommandId()`, insert a 3-day key, run `swarm.purge_expired_idempotency_keys()`, and assert that key is gone while a 3-day non-claim key stays. A test that inserts `claim_agent_inbox_${hex}` is a DEFECT: it cannot see the live generator.

5. **Idle three-row skip** still holds in `command/index.ts`. Empty polls must not upsert `rate_buckets`. Poison still persists.

6. **Generated examples.** `idlePollDurationExamples()` from DEFAULT, DEFAULT×2, MAX. Typed `["15s","30s","1m"]` is a DEFECT.

7. **Both-edge arithmetic.** 2 s → 86,400 both-edges/seat/day; 16×30 = 41,472,000. 15 s → 11,520 / 5,529,600. README must not claim production Index Scan was observed.

8. **Apply order and cadence.** Migration `000001` then `000002` then edge then client release then fleet restart. 0.1.56 stays at 2 s until restart.

## Output

- Concrete `path:line` for every finding.
- DEFECT vs NIT.
- Last line exactly `VERDICT: PASS` or `VERDICT: FAIL`. FAIL on any DEFECT.
