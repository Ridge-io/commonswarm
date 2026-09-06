# L2 wake migration — freeze at e00ba932c441522f7655d7d2e5585561b8e4d764

Author family: Grok. Branch: `lane/wake-migration`. Merge-base: `0f37532ca72f8a5bce892f6e3a7b2135ce3b3b26`.

## Claims (three sentences)

Every `swarm.agent_principals` row has a distinct 43-character `wake_id`, `swarm.wake_topic_authorized` admits `anon` to `cswarm-wake:{live id}` and refuses rotated, revoked, malformed, and no-live-token topics with the same Realtime refusal text, and `swarm.rotate_wake_id` called as `swarm_command` changes the id. A delivery inserted as `swarm_command` leaves exactly one `realtime.messages` row on that topic because `swarm.wake_agent_delivery` is owned by `postgres`; when send cannot run, the trigger swallows the failure and the delivery row still commits. `swarm.agent_delivery_read_context` was dropped and re-created from `20260820000002_archive_revokes_access.sql:103-299` with `wake_id` as the eleventh column plus the three privilege statements at `:301,:302,:306`, so `swarm_read` receives `wake_id` and `anon`/`authenticated`/`public` still cannot execute it.

## Files

- `supabase/migrations/20260906000010_wake_delivery.sql`
- `tests/p1-local/wake-realtime-auth.test.ts`
- `package.json` (`test:p1-local` list)
- `tests/p1-cli/test-gate-coverage.test.ts` (`localStackCommand` pin and `localStackTests`)

## Gate exit codes

| command | exit |
|---|---|
| `npm run build` | 0 |
| `npm test` | 0 |
| `npm run test:p1-cli` | 0 (re-run with `FORCE_COLOR` unset; a first run in this shell failed on stderr `NO_COLOR` warnings, not on the pin) |
| `npm run check:edge` | 0 |
| `npm run check:tests` | 0 |
| `npm run test:p1-local` | 0 (48 pass, including the 8 wake tests) |
| `npm run test:p1-server` | 0 (146 pass; includes `command.test.ts:3580-3582` and `:9267-9271`) |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 (6 address-fields) |

`npm run db:reset` applied `20260906000010_wake_delivery.sql` (exit 0) before the stack gates.

## Mutation rows

1. `REVOKE EXECUTE ON FUNCTION swarm.wake_topic_authorized(text) FROM anon` — first test `anon joins a private wake topic for a live id` exits 1 (`CHANNEL_ERROR`, Realtime cannot evaluate the policy without EXECUTE).
2. `DROP TRIGGER signal_deliveries_wake_agent ON swarm.signal_deliveries` — row test exits 1 (`0 !== 1` messages rows).
3. Restored both (`GRANT EXECUTE … TO anon` and re-`CREATE TRIGGER`). First test exit 0, row test exit 0. `git diff --quiet` exit 0.

## NOT established

- Hosted `cloud-swarm-dev` (`ukezjcnxjvkpkeezxaew`): pgcrypto schema, `postgres` `USAGE` on `realtime`, `INSERT` on `realtime.messages`, `BYPASSRLS`. No `supabase db push`, no `--linked`.
- Authenticated join to `cswarm-signals:{workspace_id}` (W2 policy is in the migration; this lane's tests do not join it).
- A live listener `--state-dir` status JSON (`mode: "push"`). Not this lane.
- That Realtime's hosted refusal text matches the local text.
- Merge to `main`. This SHA is not on `main`.
