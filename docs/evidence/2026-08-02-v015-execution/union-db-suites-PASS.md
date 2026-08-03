PASS

# Merged integration union — database-suite result

Validated the local integrated tree at frozen SHA `8852ce8dd5e3fcc7d82c211b98e22f1d630d5c4e` on branch `lead7/mvp-release-0.1.5`. The complete ordered command block in the goal contains six invocations (stack start, reset, and four gates); all six ran strictly serially and exited 0.

| Command | Exit | Tests | Pass | Fail | Skipped | Elapsed | Matching processes immediately after |
|---|---:|---:|---:|---:|---:|---:|---:|
| `npm run db:start` | 0 | n/a | n/a | n/a | n/a | 1.14s | 0 |
| `npm run db:reset` | 0 | n/a | n/a | n/a | n/a | 28.57s | 0 |
| `npm run test:p1-cli` | 0 | 137 | 137 | 0 | 0 | 7.57s | 0 |
| `npm run test:p1-local` | 0 | 4 | 4 | 0 | 0 | 7.07s | 0 |
| `npm run test:p1-server` | 0 | 69 | 69 | 0 | 0 | 88.03s | 0 |
| `npm run check:edge` | 0 | n/a | n/a | n/a | n/a | 0.25s | 0 |

`check:edge` checked the three named entrypoints: `command/index.ts`, `read/index.ts`, and `capability/index.ts`.

## Applied migrations

`db:reset` recreated the local database and applied this complete 13-file ledger in order:

1. `20260723000001_p1_schema.sql`
2. `20260724000001_connect_loop.sql`
3. `20260724000002_status_workspaces.sql`
4. `20260724000003_signals.sql`
5. `20260727000001_capability_urls.sql`
6. `20260727000002_capability_urls_hardening.sql`
7. `20260728000001_spend_circuit_breaker.sql`
8. `20260728000002_worker_token_renewal.sql`
9. `20260728000003_pending_successor_first_use.sql`
10. `20260728000004_stranded_successor_accounting.sql`
11. `20260730000001_workspace_access_lifecycle.sql`
12. `20260730000002_agent_signal_receive.sql`
13. `20260731000001_signal_deliveries.sql`

The reset completed cleanly. It emitted expected `NOTICE` messages for absent policies/constraints, an already-existing index/extension, and a skipped live arithmetic probe where no renewal-grant row existed; it then seeded data, restarted containers, and exited 0.

## Zero-process proofs

Each proof used the precise match `pgrep -f 'test:p1-server|test:p1-local|supabase functions serve' | wc -l`:

- Preflight: 0
- After `db:start`: 0
- After `db:reset`: 0
- After `test:p1-cli`: 0
- After `test:p1-local`: 0
- After `test:p1-server`: 0
- After `check:edge`: 0

No reset, suite, or function server overlapped the next step.

## Environment-gated branches

Both stack-touching suites create real temporary `test.env` files and pass them to `supabase functions serve --env-file`; neither uses `/dev/null`. Both files contain:

```text
SWARM_ENV=test
SWARM_SELF_SERVE=1
```

The local suite uses a `cswarm-local-fn-env-*` temporary directory; the server suite uses `cswarm-fn-env-*`.

## Final repository state

```text
HEAD:     8852ce8dd5e3fcc7d82c211b98e22f1d630d5c4e
Branch:   lead7/mvp-release-0.1.5
Upstream: 8852ce8dd5e3fcc7d82c211b98e22f1d630d5c4e
git status --porcelain=v1: empty
```

The generated protocol-bundle pretest did not dirty the tracked tree. The local Supabase containers were intentionally left running.

## Not established

This run did **not** establish hosted or production behaviour, real-load capacity, deployment correctness, site behaviour, or the release artifact. It did not touch hosted Supabase or deploy anything.
