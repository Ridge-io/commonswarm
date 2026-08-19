# Agent-feedback channel — evidence (2026-08-19)

Lane: `worktree-agent-a0a3b2468447eb266` (worker fork). Operator premise: agents
are the users; every CommonSwarm surface should let them report bugs and
feature requests.

## What was built

- **Migration** `supabase/migrations/20260819000001_agent_feedback.sql` —
  `swarm.feedback` (reporter_kind user|agent, category bug|idea|friction, body
  1..4000 with a control-character CHECK, context jsonb). RLS on; the only
  policy is `swarm_command`; REVOKE from PUBLIC/anon/authenticated. v1 read
  path is operator-side SQL, stated in the table comment.
- **Protocol** — `submit_feedback` command (payload field is `category`
  because `kind` is the union discriminator), `FeedbackSubmitted` event,
  `feedback_invalid` rejection reason, fold is a deliberate no-state-change.
  Bounds live in `normalizedFeedbackBody` / `normalizedFeedbackContext`
  (body ≤4000, newline/tab allowed, other controls + bidi overrides refused;
  context flat string map, key ≤64, value ≤512, serialized ≤2048).
- **Edge** (`supabase/functions/command/index.ts`) — wire arm
  normalizes-then-validates (trim, feedback_id lowercased); scope gate takes
  an `isFeedback` class exemption (mirrors `declare_agent_model`: inert
  product data, server-derived attribution, tokens minted before this command
  cannot carry the scope); pre-reducer guards: exact-duplicate body from the
  same reporter within the hour → 200 `duplicate: true` no-op (no row, no
  charge), hourly bucket `feedback:<agent:principal|user:id>` at 10/hour →
  429 `rate_limited` with an audit row; projection inserts the table row.
  NOT in `HUMAN_ONLY_COMMANDS` — both credential kinds submit.
- **CLI** — `cswarm feedback "<text>" --kind bug|idea|friction [--about <ref>]`
  with the standard credential selection and `--json`. Context auto-fill is
  exactly `surface`, `cswarm_version`, `platform`, and optional `about` — no
  env values, no paths. Usage block, credential table, and a help-footer
  paragraph updated (the description gate requires all three).
- **Instructing surfaces** — `site/src/components/connect/agent-prompt.ts`
  (one paragraph), `site/public/llms.txt`, `site/public/api.md` (raw HTTP
  shape for sandboxed agents), `site/public/skills/cswarm/SKILL.md`.

## Tests and which script reaches each

| file | script |
|---|---|
| `tests/protocol-workspace.test.ts` (4 new `submit_feedback` its) | `npm test` (literal list) |
| `tests/p1-cli/feedback-verb.test.ts` (7 tests) | `npm run test:p1-cli` (glob) |
| `tests/p1-server/agent-feedback.test.ts` (6 tests) | `npm run test:p1-server` (glob) |

## Gate results (this worktree, this tree)

| gate | result |
|---|---|
| `npm test` | 552 pass, 0 fail |
| `npm run test:p1-cli` (after `npm run build`) | 279 pass, 0 fail |
| `npm run check:tests` | clean |
| `npm run check:edge` | clean (3 entrypoints) |
| `npm run db:reset` | applied all migrations incl. `20260819000001` |
| `npm run test:p1-server` (fresh reset) | see below |
| `cd site && npm run build` | 8 pages built |
| `npm --prefix site test` | 167 pass, 0 fail (agent-prompt copy pins did not fire) |

p1-server result: RECORDED IN THE COMMIT MESSAGE of this lane's final commit —
the run finished after this file was first written. The new file's 6 tests
must all pass; the only tolerated failures are the 2 known pre-existing
self-serve-cap failures.

## Not established

- No end-to-end run against production; production untouched by this lane.
  The migration is written and locally applied, NOT applied to production;
  the edge function is NOT deployed.
- The operator read path is a claim in a table comment (operator-side SQL),
  not a tested surface.
- The duplicate window and rate limit were tested within one hour of clock;
  bucket expiry across the hour boundary was not exercised.
- Site surfaces (agent-prompt paragraph, llms.txt, api.md, SKILL.md) were
  built and their existing gates ran; no test pins the new copy.
- The web dashboard has no feedback UI — deliberately out of scope for v1
  (reading is operator-side SQL).

## Deviations from the directive

- Payload field is `category`, not `kind` — `kind` is the command-union
  discriminator end to end; the CLI flag is still `--kind`.
- `--kind` is required rather than defaulted; a wrong guessed default would
  misfile reports (the detect-don't-guess rule).
