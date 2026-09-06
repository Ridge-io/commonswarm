# Push delivery measured (L7)

Local stack only, except `production-audit-10min.txt` which is the one
read-only `--linked` query named in the L7 brief.

## Binaries

| file | version | sha256 |
|---|---|---|
| `bin/v0.1.57/cswarm` | 0.1.57 | `bin/v0.1.57/cswarm.sha256` (48e3ce4d…) |
| `bin/v0.1.58/cswarm` | 0.1.58 | `bin/v0.1.58/cswarm.sha256` (154be397…) |

v0.1.57 is the GitHub release asset. v0.1.58 is a copy of `~/.local/bin/cswarm`
as installed when the lane started. Each dir has `package.json` `{"type":"commonjs"}`
so Node 22+ will run the CJS bundle from inside this repo (`"type": "module"`).

## Cadence (say this next to every idle number)

"Before" is **not** the retired 2 s poll. L0 already shipped 15 s idle poll with
empty backoff to 60 s, and empty claims persist nothing (no audit, no
idempotency, no rate_buckets). Predicted §8 "before" 167/167/344 is the old 2 s
world; measured before is the 15 s/60 s world.

"After" is 0.1.58 push + 5 min reconcile. Production live control of 0.1.58
failed (ledger `6ea3863`): status could say `push` while the listener did not
receive the wake. This lane measures the **local** stack. If wakes do not
arrive here either, the after idle numbers are still the reconcile+activity
cost, and wake-latency rows record that.

## How idle counts were taken

`scripts/measure-idle-cost.sh` starts a live `cswarm listen start --state-dir`
against `supabase functions serve` (log: `serve.log`). After `ready` it waits
30 s so startup ticks are outside the window, then 600 s.

- Invocations: `grep -c 'serving the request with supabase/functions/<fn>'` on
  the serve log **line range** recorded at window start/end (`state/*/counts.json`).
- Rows: `docker exec supabase_db_cloud-swarm psql` counts of
  `swarm.audit_log`, `swarm.idempotency_keys`, `swarm.rate_buckets` in `[t0, t1)`
  for the listener principal.
- Honesty: `scripts/probe-check.sh` with a positive-control grep on the same
  file, then `grep -o 'cswarm-wake:'` (subject). `grep -c` of the subject is
  also recorded; the control is not `grep -c` (that prints `0` on a miss and
  cannot be a control).

## Other files

| path | what |
|---|---|
| `state/before/`, `state/after/` | `--state-dir` trees, window timestamps, status JSON, counts |
| `honesty/probe.txt` | row 7 greps |
| `serve.log` / `serve.pid` / `serve.env` | local `functions serve` |
| `probes/` | rows 3–6 (wake latency, realtime down, trigger off, rotation) |
| `production-audit-10min.txt` | row 8, `--linked` to `ukezjcnxjvkpkeezxaew` |
| `harness/` | seed, fake grok, probes, watchers |
| `gate-*.log` | `npm test` and `test:p1-cli` |

`creds/` and `fixture.json` hold local-stack tokens and are gitignored.
