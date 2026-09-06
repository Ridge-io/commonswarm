# Idle edge cost (lane A, round 2)

Local measurements against `127.0.0.1:54322` only. Production was not touched.
Round-1 Gemini arm on `4cfff7be418fbb71489ef9ae56b0e35eeb87c7ac`: `VERDICT: FAIL` on a typed duration-example list. Folded: examples are now generated from `IDLE_POLL_DEFAULT_MS`, its double, and `IDLE_POLL_MAX_MS`.

## Calls per seat per day (both edges)

An idle listener POSTs `/functions/v1/read` and `/functions/v1/command` each tick. `86400 / interval` per edge. Production 2026-09-05: 390,277 command-edge calls in 24 h, 16 seats, median 3.6 s (~24,000 command calls/seat/day). The read edge is the same cadence, so ~48,000 edge POSTs/seat/day before this lane. After: empty polls wait 15 s, then 30 s, then 60 s; both POSTs share `idleSleep`.

| cadence | command/seat/day | both edges / seat/day | 16 seats / 30 days (both) |
|---|---:|---:|---:|
| 2 s (old code default) | 43,200 | 86,400 | 41,472,000 |
| 3.6 s (measured median) | 24,000 | 48,000 | 23,040,000 |
| 15 s (new default, idle) | 5,760 | 11,520 | 5,529,600 |
| 60 s (back-off floor) | 1,440 | 2,880 | 1,382,400 |

`inbox --notify` was 25 s; it now starts at 60 s with the same helper. A second watcher for the same principal on the same host is refused.

Cadence is a client release. `--poll-interval` is new surface. Every seat needs the new binary to leave 2 s.

## Rows no longer written

Idle `claim_agent_inbox` used to write three rows: `audit_log`, `idempotency_keys`, and a `rate_buckets` upsert. After this edge: none of those three, when there is no unacked delivery and no poison. A claim that leases a row, or that terminalizes poison, still writes the ledger and still takes the rate bucket. Retry of an idle command id re-executes (intended). Retry of a non-empty claim replays.

Going forward at the measured 24,000 idle polls/seat/day: 3 × 24,000 = 72,000 rows/seat/day that stop landing (16 seats: 1.15 M/day). At the 15 s default: 3 × 5,760 = 17,280/seat/day, now 0.

## Retention

`audit_log` is never purged. No migration in this lane names that table: no trigger change, no index, no DELETE, no config key. Historical idle-poll audit rows (662 MB) stay as a one-time cost. Going forward idle polls write none.

`idempotency_keys` already had `swarm-purge-idempotency-keys`. No second job. The table has no command-kind column. One migration (`20260906000001`) sets `claim_idempotency_retention_days = 2` (floor 2) for ids that match `claimCommandId()`: `command_id ~ '^claim_[0-9a-f]{32}_[0-9a-z]+$'` (32 lowercase hex, then `_`, then a base-36 ordinal). Other keys keep `GREATEST(30, idempotency_retention_days)`. The predicate `LIKE 'claim_agent_inbox_%'` never matches live client ids, so it is not used. At the measured 24,000 idle polls/seat/day, a 30-day claim-key window would hold 11.52 M rows for 16 seats; a 2-day window holds 768,000. Going forward idle polls write no key, so the 2-day window only bounds persisted (non-empty) claims. The zero-arg purge loops at most 200 batches of 5000 = 1 M rows per nightly run. Production holds ~1.47 M keys, so the first apply drains over two nights.

## file_versions quota query

Hot query: `SUM(size_bytes)` where `workspace_id = $1 AND (state IN ('live','retired') OR (state = 'pending' AND created_at > now()-3h))`.

WHY seq scan on a local seed: the table is small and the seeded workspace matches almost every row (4,061 of 4,170 after ANALYZE), so seq scan is cheaper. Not a function on the column and not a type mismatch.

EXPLAIN ANALYZE, selective workspace (1 row):

```
Aggregate  (cost=8.32..8.33 rows=1 width=32) (actual time=0.082..0.082 rows=1 loops=1)
  ->  Index Scan using file_versions_workspace_state_created on file_versions  (cost=0.28..8.31 rows=1 width=8)
        Index Cond: (workspace_id = '775234fa-5e08-479a-bf30-ef619b226d26'::uuid)
```

EXPLAIN ANALYZE, large local seed (4,084 rows in one workspace): Seq Scan, 0.986 ms. With `enable_seqscan=off`: Bitmap Index Scan on `file_versions_workspace_state`. Production's 2.8 M seq scans are per-call scans of a table where one workspace is a small slice; that is the Index Scan case above. Index Scan on production was not observed.

`rate_buckets` upsert already uses PRIMARY KEY `(bucket_key, window_start)`. Added `rate_buckets_window_start` for the 2-hour purge. Idle polls no longer upsert.

## Apply order

1. Migration (`20260906000001` idempotency + rate_buckets index, `20260906000002` file_versions index).
2. Edge (`command`: idle skip of audit, idempotency, and rate_buckets).
3. Client release (15 s / 60 s, `--poll-interval`, notify lock). Every seat must restart to change cadence.
4. Fleet restart (0.1.56 listeners keep the 2 s poll until they run the new binary).

## Not established

- Production apply, production EXPLAIN, or any write to `cloud-swarm-dev`.
- Age mix of the production 1.47 M idempotency keys (2-day eligible count is a rate projection).
- A live 0.1.56 listener pointed at this worktree's edge.
- `test:p1-local` human-seen-browser (Chrome POST count flake, not this lane).
- Empty-queue `claim_agent_inbox` skips `checkDeliveryRateLimit` (`mustLimit` is false). An agent token with an empty queue has no server-side claim ceiling; each request still runs the claim function's three UPDATEs. Ruled acceptable for now. The next lane (`push`) is where that ceiling returns.
