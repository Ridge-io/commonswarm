# Idle edge cost (lane A)

Local measurements on 2026-09-05 against `127.0.0.1:54322` only. Production was not touched. The seed was applied with `npx supabase migration up --local` plus INSERT; this was not a `db:reset` (the host shares the local stack). Outcome on historical `claim_agent_inbox` rows cannot tell empty from leased: both were stored as `outcome = 'accepted'`. Retention therefore deletes by kind after 7 days.

## Calls per seat per day

`86400 / interval`. Code default before this lane: `LISTENER_IDLE_POLL_MS = 2000`. Production 2026-09-05: 390,277 edge commands in 24 h, 100% `claim_agent_inbox`, 16 seats, median 3.6 s (~24,000 calls/seat/day). After this lane, empty polls wait 15 s, then 30 s, then 60 s until a delivery resets to the configured base.

| cadence | calls/seat/day | 16 seats / day | 16 seats / 30 days |
|---|---:|---:|---:|
| 2 s (old code default) | 43,200 | 691,200 | 20,736,000 |
| 3.6 s (measured median) | 24,000 | 384,000 | 11,520,000 |
| 15 s (new default, idle, no back-off yet) | 5,760 | 92,160 | 2,764,800 |
| 60 s (back-off floor) | 1,440 | 23,040 | 691,200 |

A fleet that stays idle at the 60 s floor is 30 times quieter than the 2 s default, 16.7 times quieter than the measured 3.6 s median. The 15 s default alone is 7.5 times quieter than 2 s. These numbers count command-edge `claim_agent_inbox` only. An idle listener also POSTs the read edge each tick; that cut is the same client cadence and is not a second persistence row.

`inbox --notify` was 25 s (`ARRIVAL_WATCH_POLL_MS`). It now starts at 60 s and uses the same back-off helper. 21 watchers at 25 s were 3,456 reads/watcher/day; at 60 s that is 1,440. A second watcher for the same principal on the same host is refused (lock file beside the cursor; the sentence names the other pid).

## Rows no longer written

Every empty poll used to INSERT one `swarm.audit_log` row and one `swarm.idempotency_keys` row. Production held 1.47 M of each (1.5 GB) against 1,716 signals. After the edge change, `claimAgentInboxPersistsLedger` is `delivery_refs.length > 0`: an empty claim returns 200 and writes neither row. A claim that leases a row still writes both. Idempotency for every other command is unchanged. A 0.1.56 listener that retries an empty command id re-executes (intended: it can pick up a row that arrived during the retry).

Not skipped: `rate_buckets` still upserts on the claim path (one row per principal per window; `swarm-purge-rate-buckets` already drains it). Poison / hydration failure still write their audit and alert rows.

Going forward, idle seats write 0 of the two growing tables. At the measured 24,000 empty polls/seat/day that is 48,000 rows/seat/day that stop landing (16 seats: 768,000/day, 23.0 M/month). At the new 15 s default, 5,760 empty polls would have written 11,520 of those rows/seat/day; they now write 0. Historical idle rows are bounded by the purge below.

## Retention (local seed)

`audit_log` cannot distinguish empty historical claims, so `purge_idle_claim_audit` deletes `command_kind = 'claim_agent_inbox'` older than `claim_audit_retention_days` (7, floor 7). `purge_expired_idempotency_keys(batch_size)` deletes keys older than `idempotency_retention_days` (floor 30) in batches of 5,000. `purge_idle_cost_tables()` loops both (cap 200 batches each). pg_cron job `swarm-purge-idle-cost` at `23 3 * * *` (`SELECT swarm.purge_idle_cost_tables()`). Existing `swarm-purge-idempotency-keys` at `17 3 * * *` kept. The append-only trigger now blocks UPDATE only; DELETE is reserved for this SECURITY DEFINER purge owned by `swarm_admin`. `swarm_command` still INSERT-only.

Seed (principal `idle-cost-seed`, dedicated workspace): 40 old claim audits + 5 fresh extra (fresh total 71 including pre-existing); 12 old + 3 fresh idempotency keys.

```
SELECT swarm.purge_idle_cost_tables();
-- { "audit_log_deleted": 40, "idempotency_keys_deleted": 12 }
```

After: old claim audits 0, fresh claim audits 71, old keys 0, fresh keys 3. Re-query after the purge (same stack): `claim_old=0`, `claim_fresh=71`, `old_keys=0`, `all_keys=957`. Claim outcomes present on this stack: accepted 51, replayed 6, authz 5, revocation 4, conflict 3, rate_limit 2. None of those outcomes means "empty".

## file_versions quota index

Hot query: `file-artifacts.ts` `SUM(size_bytes)` where `workspace_id = $1 AND (state IN ('live','retired') OR (state = 'pending' AND created_at > now() - 3h))`. Seed: workspace `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaac001`, 8,000 versions; table `reltuples=8090`, 2,015,232 bytes. Indexes already present: unique `(file_id, workspace_id, version_n)`, `(workspace_id, state)`, pending partial on `created_at`. Added: `file_versions_workspace_state_created` btree `(workspace_id, state, created_at)`.

EXPLAIN before (after other indexes, before the new one):

```
Aggregate  (cost=466.38..466.40 rows=1 width=32)
  ->  Seq Scan on file_versions  (cost=0.00..448.25 rows=7252 width=8)
        Filter: ((workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaac001'::uuid) AND ((state = ANY ('{live,retired}'::text[])) OR ((state = 'pending'::text) AND (created_at > (statement_timestamp() - '03:00:00'::interval)))))
```

EXPLAIN after (index listed in `pg_indexes`; planner still Seq Scan, same cost). EXPLAIN ANALYZE after: actual 8,000 rows, 5.531 ms, Seq Scan, 90 rows removed by filter. With `enable_seqscan=off` the same query is `Bitmap Index Scan on file_versions_workspace_state_created` (cost 566.23, 7.426 ms). The index is usable. At 8k rows seq scan is cheaper. Production's 2.8 M sequential scans is the size this index is for. Index Scan on production was not observed.

## Apply order

1. Migration (`20260906000001_idle_cost_retention`, `20260906000002_file_versions_quota_index`).
2. Edge (`command`; empty claims skip both writes).
3. Client release (15 s / 60 s cadence, `--poll-interval`, status sentence, notify lock).
4. Fleet restart (0.1.56 listeners keep the 2 s poll until they run the new binary).

## Not established

- Production apply, production EXPLAIN, or any write to `cloud-swarm-dev`.
- That 8k-row local EXPLAIN would choose the new index.
- That `rate_buckets` upserts stop (they do not).
- That a live 0.1.56 listener was pointed at this worktree's edge (compat is by construction: empty retry re-executes; old clients ignore unknown status fields).
- A `db:reset` seed of the retention shape (the counts above are a dedicated seed on the shared local stack).
