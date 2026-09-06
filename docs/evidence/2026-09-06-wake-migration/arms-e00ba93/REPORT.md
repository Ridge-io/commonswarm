# L2 wake migration — report

SHA: `e00ba932c441522f7655d7d2e5585561b8e4d764`
Branch: `lane/wake-migration` (not merged)
Worktree: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-migration`
Merge-base: `0f37532ca72f8a5bce892f6e3a7b2135ce3b3b26`
Author: Yulan Bot `<yulanbot@gmail.com>`
Swarm: Windlass (join registered; this shell has no swarm surface for status)

## What landed (three commits)

- `840da64` db: add wake_id and Realtime wake delivery
- `b15496d` test: gate wake Realtime auth on the local stack
- `e00ba93` test: seed auth.users and simulate send failure via owner

Files:

- `supabase/migrations/20260906000010_wake_delivery.sql`
- `tests/p1-local/wake-realtime-auth.test.ts`
- `package.json` (`test:p1-local`)
- `tests/p1-cli/test-gate-coverage.test.ts`

## Gates

| command | exit | note |
|---|---|---|
| `npm run db:reset` | 0 | applied `20260906000010_wake_delivery.sql` |
| `npm run build` | 0 | before other gates |
| `npm test` | 0 | |
| `npm run test:p1-cli` | 0 | 482 pass. First run in this shell failed on `FORCE_COLOR`/`NO_COLOR` stderr noise; re-run with `env -u FORCE_COLOR` passed |
| `npm run check:edge` | 0 | |
| `npm run check:tests` | 0 | |
| `npm run test:p1-local` | 0 | 48 pass, 0 fail. Includes the 8 wake tests |
| `npm run test:p1-server` | 0 | 146 pass, 0 fail. Includes `command.test.ts:3580-3582` and `:9267-9271` |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 | 6 address-fields |

## Mutations

| mutation | result |
|---|---|
| `REVOKE EXECUTE ON FUNCTION swarm.wake_topic_authorized(text) FROM anon` | first test fails (`CHANNEL_ERROR`) |
| `DROP TRIGGER signal_deliveries_wake_agent ON swarm.signal_deliveries` | row test fails (`0 !== 1`) |
| restore both, re-run first + row tests | both exit 0 |
| `git diff --quiet` | 0 |

## Gemini arm

pid: `16041`
command: `agy --dangerously-skip-permissions --model gemini-3.1-pro-high --print-timeout 90m -p …`
output: `lane-wake-migration/arms-e00ba932c441522f7655d7d2e5585561b8e4d764/gemini/ARM.txt`
review: `lane-wake-migration/arms-e00ba932c441522f7655d7d2e5585561b8e4d764/REVIEW.md`
diff: `lane-wake-migration/arms-e00ba932c441522f7655d7d2e5585561b8e4d764/DIFF.patch`

Launched detached (`nohup` + `disown`). Not waited. No `VERDICT` yet.

## NOT established

- Hosted project `cloud-swarm-dev` / `ukezjcnxjvkpkeezxaew`: pgcrypto schema, `postgres` `USAGE` on `realtime`, `INSERT` on `realtime.messages`, `BYPASSRLS`. No `db push`, no `--linked`.
- Authenticated Realtime join to `cswarm-signals:{workspace_id}` (W2 policy is in the migration; tests do not join it).
- Live listener `--state-dir` status JSON.
- Hosted Realtime refusal text.
- Merge to `main`. This SHA is not on `main`. `origin/main` moved while the lane ran (`ahead 3, behind 22` at freeze).
- Gemini arm verdict (process 16041 still running at report time).
