# Lane wake-measure freeze — `4063e1dce7ed3d4b306b5bc872021fe39d830a30`

Branch `lane/wake-measure`. Merge-base with `origin/main`: `a514d5da65047f0b4dceeccc5902b0214774b2cc`.
Diff: `arms-4063e1dce7ed3d4b306b5bc872021fe39d830a30/DIFF.patch`.

First `diff --git` line: `diff --git a/docs/design/2026-09-06-PUSH-DELIVERY.md b/docs/design/2026-09-06-PUSH-DELIVERY.md`

Do not merge. One Gemini arm on this SHA, scoped to every number in spec §8 vs the evidence files.

## Claims

1. Idle **before** is a live 0.1.57 listener (`bin/v0.1.57/cswarm.sha256` = 48e3ce4d…) at L0 15 s/60 s, not the retired 2 s poll. Serve-log 10 min: read 16 + claim 14 + activity 40 = 70 (`state/before/counts.json`). Seat-attributed empty claims: 10 (`state/before` events.ndjson). Rows: 0/0/0.
2. Idle **after** is 0.1.60 (`bin/v0.1.60/cswarm.sha256` = a57ac093…; listener code of 0.1.59). Clean 10 min: read 2 + claim 2 + activity 39 = 43 (`state/after-0.1.60-clean/counts.json`). Seat-attributed empty claims: 2. Rows: 0/0/0. `ACTIVITY_HEARTBEAT_MS` is still 15 s. 0.1.58 hung (`finishWait`); those numbers are in `state/after/` and `probes/*-0.1.58.json`, not the after column.
3. Wake latency on 0.1.60: mean 525.7 ms, max 937 ms, n=20 (`probes/wake-latency-0.1.60.json`). Anon client 20/20. Realtime down: poll in 65 ms; five asks max 15.7 s; back to push (`probes/realtime-down-0.1.60.json`). Trigger off: 128.6 / 429.0 / 729.5 s (`probes/wake-dropped-0.1.60.json`). Honesty: `cswarm-wake:` count 0 with probe-check CLEAN (`honesty/probe.txt`). Production 10 min audit: `production-audit-10min.txt`.

## Gates

| command | exit |
|---|---|
| `npm test` | 0 (885 pass) — `gate-npm-test.log` was from before the ff-only onto 0.1.60; re-run not done on 4063e1d |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (483 pass) — same caveat |
| `bash -n scripts/measure-idle-cost.sh` | 0 |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 (2 address-fields) |

## NOT established

- 0.1.60 rotation resubscribe timing (token1 already revoked after the 0.1.58 rotation probe). Server-side rotate + old topic `CHANNEL_ERROR` is `probes/rotation-0.1.58.json`.
- Silent half-open after a Phoenix heartbeat reply.
- Production dashboard per-function counters; only the named `--linked` `audit_log` query.
- Re-running `npm test` on SHA 4063e1d (docs/evidence only vs the SHA that was tested).
