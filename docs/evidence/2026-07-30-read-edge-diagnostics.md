# Read edge structured diagnostics — Fjord

**SHA:** `e459f8b7bd579e2be23bc9d8b197283208a9daf9`
**Base:** `origin/main` `f62bb3a6948fa64b2c9ea021d96424d4fb62e706`
**Branch / worktree:** `swarm/Fjord/read-edge-diagnostics` @
`/Users/yulanbot/.swarm/wt/cloud-swarm-source/Fjord--read-edge-diagnostics`
**Scope:** diagnostics only — no SQL root-cause fix, no deploy, no push.

## Files

- `supabase/functions/read/diagnostics.ts` (new pure allowlist helpers)
- `supabase/functions/read/index.ts` (phase tracking + structured failure path)
- `tests/read-edge-diagnostics.test.ts` (8 pure regression tests)
- `package.json` (`npm test` names the new test file)

## RED / GREEN

**RED (origin/main `f62bb3a`):** catch logs only
`"read function failure"` + `error.name` and returns
`{ "error": "internal_error" }` with no request_id, retryable, code,
severity, routine, constraint, or phase.

**GREEN (this SHA):** focused suite 8/8 pass; full `npm test` 120/120 pass.

## Gates

| Gate | Result |
|---|---|
| `node --import tsx --test tests/read-edge-diagnostics.test.ts` | 8/8 pass |
| `npm test` | 120/120 pass |
| `npm run check:tests` | pass |
| `npm run check:edge` | pass (all three edge functions) |

## Security review (local, same family)

Allowlisted log fields only: `event`, `request_id`, `phase`, `name`,
`code`, `severity`, `routine`, `constraint`, `retryable`.

Forbidden from logs/public body: `message`, `detail`, `hint`, `query`,
`parameters`, `stack`, `where`, `internal_query`, `position`, schema/table/
column/type names, `token`, `authorization`, `body`, `hash`, `token_hash`,
connection `address`/`port`.

Public 500 body is only `{ error: "internal_error", request_id, retryable }`.
Regression tests inject a synthetic agent token, hash hex, SQL, and query
values and assert they never appear in the log line or public body.

## Not established

- Not deployed to production Supabase.
- Unknown SQL root cause intentionally untouched.
- No live failure reproduction against production logs.
- No push/land of this branch.
- Clients/docs do not yet surface `request_id`/`retryable`.
- Production log drain retention of structured JSON not verified.
