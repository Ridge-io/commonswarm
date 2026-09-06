# Lane L2c report — wake-topic redaction

SHA: `3920d3217448de5f59553369c9a55d3460b47eee`
Base: `a86d73d5e4a124c168c65a3b79857faa21edbfb3`
Branch: `lane/wake-redaction` (2 commits ahead of origin/main)
Author: Yulan Bot `<yulanbot@gmail.com>`

## Claims (three sentences)

One exported `SECRET_SHAPE_RE` matches `swm_(?:agt|inv|cap)_` and `cswarm-wake:` plus 43 base64url characters. stderr and tool titles render a match as `[redacted-credential]`; `localDiagnostic` writes `[redacted]` into `lastErrorDetail`; events.ndjson refuses a match; a status row with one in `lastErrorDetail` or the stderr tail is rejected. `swm_agt_` still matches at all five sites.

## Files (5)

src/host/credential-redaction.ts, src/listener/supervisor.ts, src/listener/control.ts, tests/host-stderr-tail.test.ts, tests/listener-control.test.ts

## Gate exit codes (this SHA)

| gate | exit |
|---|---|
| `npm run build` | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 |
| `npm run check:tests` | 0 |
| `npm run check:edge` | 0 |
| `npm test` | 0 (841 pass) |
| `npm run test:p1-cli` (`FORCE_COLOR` unset) | 0 (482 pass) |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 (4 address-fields) |

## Mutation (topic alternative removed from `SECRET_SHAPE_RE`, then restored)

Baseline: the two owned files, 54 pass.

Mutated: dropped `\|cswarm-wake:[A-Za-z0-9_-]{43}` from the constant. Exit 1. Failures (topic only; no `agent-token` row):

- wake-topic stderr: redaction marker missing
- wake-topic stderr: secret survived
- wake-topic tool title unredacted
- two secrets: topic half left in place
- wake-topic events.ndjson (:829) accepted
- wake-topic lastErrorDetail (:436) accepted
- wake-topic lastWorkerStderrTail (:473) accepted
- wake-topic localDiagnostic: marker missing
- wake-topic localDiagnostic: secret survived
- sweep: definer no longer contains `{43}`

Restored with `git checkout -- src/host/credential-redaction.ts`. 54 pass. `git diff --quiet`.

## Arms

| pid | family | dir | state |
|---|---|---|---|
| **54581** | Gemini (`agy` gemini-3.1-pro-high) | `arms-3920d3217448de5f59553369c9a55d3460b47eee/gemini/` | live; ARM.txt 0 bytes (agy prints on exit) |

Opus arm: not launched. Lead runs it.

DIFF first line: `diff --git a/src/host/credential-redaction.ts b/src/host/credential-redaction.ts`

## NOT established

- Gemini `VERDICT` (pid 54581 still running).
- Opus arm.
- Site build or `npm --prefix site test` (site not in this lane).
- `test:p1-local` / `test:p1-server` / any database.
- A live listener or a real Realtime refusal string.
- Whether hosted `wake_id` is always 43 characters (this lane matches the spec's `{43}`).
- Copy of arm output into `docs/evidence/` (arm has not finished).

## Next

Lead: wait for pid 54581, then run the Opus arm on this SHA. On FAIL, relaunch this lane with the findings. Do not merge yet.
