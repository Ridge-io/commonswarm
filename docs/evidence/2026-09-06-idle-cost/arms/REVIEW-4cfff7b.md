# Adversarial review — lane/idle-cost at 4cfff7be418fbb71489ef9ae56b0e35eeb87c7ac

You are an independent Gemini arm. You did not write this lane. Do not praise it.
Work from the files named below. Change no files.

- Checkout: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-idle-cost`
- SHA: `4cfff7be418fbb71489ef9ae56b0e35eeb87c7ac` (branch `lane/idle-cost`)
- Base: `32842efefa01f7cbe1ff985a98ad9e3ba0568ce7` (`git merge-base origin/main HEAD`)
- Diff: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-idle-cost/arms-4cfff7be418fbb71489ef9ae56b0e35eeb87c7ac/DIFF.patch`

Before any finding, quote back the first `diff --git` line of DIFF.patch exactly. If you cannot, stop and FAIL.

## What the lane claims

1. The listener idle poll default is 15 s (`IDLE_POLL_DEFAULT_MS`), empty polls double to 60 s (`IDLE_POLL_MAX_MS`), any delivery resets to the configured base, `--poll-interval` uses the existing duration flag style, and `cswarm listen status` prints a sentence generated from those constants.
2. An idle `claim_agent_inbox` (no leased row and `terminal_delivery_failure_count = 0`) writes no `audit_log` row and no `idempotency_keys` row; a claim that leases a row, or that terminalizes poison, still writes both. A 0.1.56 listener that retries an idle command id re-executes. Other commands keep the idempotency contract.
3. Historical `audit_log.outcome` cannot tell empty claims from leased ones (both were `accepted`), so retention deletes `command_kind = 'claim_agent_inbox'` older than 7 days in batches, plus expired idempotency keys, on pg_cron `swarm-purge-idle-cost`. `file_versions` gets btree `(workspace_id, state, created_at)`. `inbox --notify` starts at 60 s with the same back-off and refuses a second watcher for the same principal on the same host.

## Eight checks (attack each; attempted refutation required)

For every check: try to refute the claim at the cited lines. A PASS on a check is allowed only after you name the refutation you attempted and why it failed. "Looks fine" is not a review.

1. **One constant set, generated copy.** Prove `LISTENER_IDLE_POLL_MS`, `ARRIVAL_WATCH_POLL_MS`, the `--poll-interval` parser, the status sentence, and the usage sentence all read `src/cloud/idle-poll.ts` and cannot drift. Find a typed list or bound that is not generated. Find an `error.message` classifier (D-053). Find an em-dash in user-facing text.

2. **Back-off and reset.** Attack `nextIdlePollMs` and the runtime `idleSleep` / arrival-watch wait. Does a delivery actually reset, or only a claimed durable row? Does a 1 ms test injection get clamped to 1 s? Does empty streak overflow? Does `--poll-interval 2m` slip through?

3. **Idle persist skip.** Attack `claimAgentInboxPersistsLedger`. Does a hydration failure, a 403, a rate-limit, or a poison terminalization skip the ledger when it must not? Does an idle poll still write `rate_buckets` (the lane says it does — is that named, or hidden)? Does a non-empty claim still 409 on command-id reuse? Quote the p1-server control.

4. **Old 0.1.56 clients.** A fleet still on 0.1.56 will poll at 2 s until restart. The edge skip must not 409 those clients. Find the case where skipping the idle idempotency key breaks a live listener (lost claim, double lease, poisoned replay). If you cannot, say what you searched.

5. **Retention predicate.** The lane says outcome cannot distinguish empty vs leased. Verify against the migration comment and any live `outcome` values in tests. Attack the append-only trigger change (UPDATE-only): can `swarm_command` DELETE? Can a non-definer DELETE? Does `GREATEST(7, …)` let config go below 7? Does the zero-arg `purge_expired_idempotency_keys()` still only drain keys (existing cron) while `purge_idle_cost_tables()` does both?

6. **Quota index honesty.** The evidence README says EXPLAIN after the new index is still Seq Scan at 8k rows, and Index Scan on production was not observed. Attack any sentence that claims the planner now uses the index. Check the hot query in `file-artifacts.ts` matches the indexed columns. Name a cheaper index the query actually wants.

7. **Notify lock.** Attack the lock file: same principal two watchers, stale pid steal, EPERM-alive, wrong principal allowed, path not under the state dir, sentence not generated from the pid. Branching on `error.message` is a FAIL.

8. **Arithmetic.** Recalculate calls/seat/day at 2 s, 15 s, 60 s and the 16-seat 30-day totals from `86400 / interval`. Recalculate rows no longer written (2 rows per idle poll). If the README's table disagrees, FAIL. The 3.6 s measured median is production, not this tree — do not treat it as a code default.

## Output

- Concrete `path:line` for every finding.
- DEFECT vs NIT.
- Last line exactly `VERDICT: PASS` or `VERDICT: FAIL`. FAIL on any DEFECT. Absence of a VERDICT line is not a review.
