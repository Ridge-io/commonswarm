# D-044 completion report

Date: 2026-08-04
Branch: `next/d044-retire-sandbox`

## Outcome

The local listener sandbox is retired. Same-owner and cross-owner turns now reach the
operator's existing Grok or OpenCode worker with the same project working directory,
home, session, and permission path. The prompt identifies the sender, operator, and
owner relation. Cross-owner prompts advise the worker to obtain the operator's explicit
confirmation before a destructive or irreversible action.

`GROK_DISABLE_AUTOUPDATER=1` remains the only Grok-specific environment addition. ACP
`session/request_permission` remains host-mediated for every turn: deny mode rejects,
and explicit allow mode may select `allow_once`. D-044 did not authorize a separate
cross-owner force-ask policy, so none was added or removed.

No file under `supabase/` changed. The server-side authority model, migrations, edge
functions, and generated protocol bundle are unchanged.

## Implementation

- `src/listener/grok-model.ts` uses one operator worker for every relation and validates
  the operator's existing auth file in place.
- `src/host/grok.ts` no longer installs an isolated home, cwd, hook switch, or tool
  kill-switch. Parent environment sanitization and `GROK_DISABLE_AUTOUPDATER=1` remain.
- `src/listener/opencode-model.ts` uses the existing operator worker for every relation;
  it no longer creates per-turn isolated workers or hard-deny tool configurations.
- `src/host/opencode.ts` no longer accepts relation-specific tool denial or disposable
  homes. Its existing forced-ask ACP configuration and project-config suppression remain.
- `src/listener/engine.ts`, `src/listener/types.ts`, `src/listener/runtime.ts`,
  `src/cloud/signals.ts`, and `src/cli.ts` carry resolved sender/operator provenance into
  the prompt, using a fresh bounded directory read for each delivery and IDs when current names
  are unavailable. An agent ask whose operator cannot be resolved retries without starting a model
  turn, so an agent prompt never omits its operator.
- Listener status and startup copy describe shared operator context and provenance.

## User-facing copy inventory

The required grep covered `src/cli.ts`, `README.md`, `docs/`, and `site/`.

Live copy changed:

- `src/cli.ts` — both trapped sandbox descriptions, plus host-limit status keys and
  startup/status explanations.
- `site/src/components/connect/agent-prompt.ts` — agent setup now describes the shared
  worker/project context, provenance, and cross-owner confirmation steer.

`README.md` contained no local-sandbox availability claim and required no edit.

Historical design/evidence documents containing the superseded behavior received a
D-044 current-state banner while retaining their dated record:

- `docs/design/SWARM-CLOUD.md`
- `docs/design/SWARM-CLOUD-V1.md`
- `docs/design/2026-08-02-V015-MASTER-PLAN.md`
- `docs/design/2026-07-30-AGENT-RECEIVE-MVP.md`
- `docs/design/2026-07-31-DURABLE-SIGNAL-DELIVERY.md`
- `docs/design/2026-08-03-STAGE7-CAUSAL-CONTROL-REGISTER.md`
- `docs/design/2026-08-04-LISTENER-PROVIDER-GAP.md`
- `docs/design/contracts/D040-LISTENER-BRICK-FIX-GOAL.md`
- `docs/design/contracts/V015-RELEASE-CHECKLIST.md`
- `docs/design/contracts/REMAINING-SEVEN-CONTROLS-GOAL.md`
- `docs/design/contracts/SECURITY-CONTROLS-GOAL.md`
- `docs/design/contracts/STAGE7-CONTROL-ENUMERATION-GOAL.md`
- `docs/design/contracts/WREN-LAPTOP-DOGFOOD-GOAL.md`
- `docs/evidence/2026-07-30-v0.1.4-agent-listener-release.md`
- `docs/evidence/2026-07-31-aegis-security-review.md`
- `docs/evidence/2026-07-31-handoff/ADVISOR-REVIEW.md`
- `docs/evidence/2026-07-31-handoff/EXECUTION-ORDERS.md`
- `docs/evidence/2026-07-31-handoff/NEXT-EXECUTION-PLAN.md`
- `docs/evidence/2026-07-31-handoff/PRODUCTION-QA.md`
- `docs/evidence/2026-07-31-handoff/README.md`
- `docs/evidence/2026-07-31-handoff/STATE-AND-PRODUCTION.md`
- `docs/evidence/2026-07-31-host-protocol-matrix-reconciliation.md`
- `docs/evidence/2026-07-31-opencode-acp-adapter.md`
- `docs/evidence/2026-08-02-v015-execution/production-delta-d036-inversion-arm-gemini-PASS.md`
- `docs/evidence/2026-08-02-v015-execution/README.md`
- `docs/evidence/2026-08-02-v015-execution/security-causal-controls.md`
- `docs/evidence/2026-08-03-opencode-hard-deny.md`
- `docs/evidence/2026-08-04-d040-fix/worker-report.md`

The D-044 contract and D-044 defect-register entry were found and intentionally retained:
they are the current ruling and quote the retired language as the defect under correction.

## Tests changed

Test declarations increased by four; none were removed. The root pure gate increased from
395 to 399 passing tests.

- `tests/host-acp-grok.test.ts` (20 -> 20): inverted sandbox-environment assertions to
  prove the operator home remains, the updater is disabled, and sandbox/hook/tool
  kill-switches are absent.
- `tests/host-acp-opencode.test.ts` (7 -> 7): proves forced-ask configuration remains and
  no owner-relation kill-switch is installed.
- `tests/listener-cli-process.test.ts` (4 -> 4): the detached-process journey now proves
  one Grok worker serves both relations in the operator cwd/home and permission path; its
  fake-provider audit proves resolved local/remote sender and operator provenance plus the
  cross-owner confirmation steer reach the model prompt, and one fresh bounded directory
  read supplies each delivered prompt. The cursor-fallback fake also supplies its sending
  agent's operator, so both delivery modes exercise the fail-closed provenance path.
- `tests/listener-engine.test.ts` (24 -> 27): inverted relation routing to the operator
  worker, added resolved-provenance coverage, updated prompt-envelope escaping checks, and
  proves a delayed provenance lookup cannot start a turn after expiry or cancellation. A new
  negative-path control proves a missing sending-agent operator retries without a model turn.
- `tests/listener-grok-model.test.ts` (3 -> 3): proves cross-owner turns share the operator
  worker, cwd, home, canary, and configured permission mode.
- `tests/listener-host-limits.test.ts` (4 -> 4): replaces false isolation claims with the
  current host-configuration, cross-owner-context, and local-state-lifecycle contract.
- `tests/listener-opencode-model.test.ts` (29 -> 29): inverted eight per-turn-isolation
  cases to prove shared worker/cwd/permission behavior, cancellation and close semantics,
  and a single worker-home lifecycle.
- `tests/listener-runtime.test.ts` (46 -> 47): proves durable prompt-start admission reserves
  the directory lookup's bounded deadline before the ACP, reply, and ACK budgets. Its agent-ask
  fixture now supplies resolved operator provenance, preserving the runtime path under the new
  fail-closed prompt invariant.
- `tests/p1-cli/signals.test.ts` (20 -> 20): the fake directory now supplies
  `owner_user_id`, exercising the provenance parser used by the CLI.
- `site/src/components/connect/agent-prompt.observer.test.ts` (5 -> 5): proves setup copy
  teaches the shared worker and project context, provenance, and confirmation steer without
  claiming a fresh strict session.

## Verification

All commands ran with `NODE_OPTIONS=--max-old-space-size=4096`.

| Gate | Result |
|---|---|
| `npm test` | 399/399 pass |
| `npm run test:p1-cli` | 143/143 pass |
| `npm run test:p1-local` | 4/4 pass |
| `npm run test:p1-server` | 69/69 pass |
| clean `npm --prefix site run build` | pass; 8 pages built |
| `npm --prefix site test` | 113/113 pass |
| `npm run build` | pass |
| `npm run check:tests` | pass |
| `npm run check:edge` | pass; all three existing entrypoints checked |
| `git diff --check` | pass |
| `git diff --name-only -- supabase` | empty |

The database suites ran sequentially against the already-running local Supabase instance.
The server test prehook regenerated `supabase/functions/_shared/protocol.js`, but the result
was byte-identical and is not present in the diff.

The first exact-SHA review rejected `b518ba8`: it found that the optional directory read could
outlive cancellation or ask expiry, that its timeout was absent from lease admission, and that
the canonical spec plus two release-planning surfaces still asserted the retired behavior. The
replacement checks the caller signal and ask deadline immediately before `model.prompt`, passes
both into the directory read, reserves its 30-second ceiling in the lease budget, adds causal
controls, and supersedes all four live documents (`SWARM-CLOUD-V1.md` carried the same rule).

The next exact-SHA review rejected `2621908`: its long-lived directory cache could preserve a
changed human display name and state stale provenance as fact, and three per-file test-declaration
counts in this report were wrong. The final candidate reads the current directory once per prompt,
has a process-level assertion for that cadence, and records the parent-to-candidate counts above.

The next exact-SHA review rejected `ff46696`: a failed or incomplete agent-directory lookup could
still start a prompt without the sending operator while live copy promised operator provenance on
every prompt. The replacement treats missing agent-operator provenance as a retryable prompt-start
failure and proves both lookup-error and missing-owner cases start zero model turns.

## Not established

- This lane did not deploy or mutate production, push a branch, or call a live Grok or
  OpenCode model. Provider behavior is covered through ACP and process fakes.
- `site/.env` was absent. The clean static build and site tests passed, but this does not
  establish a backend-connected site build or a deployed-page result.
- Provenance and the cross-owner confirmation instruction are advisory prompt context, not
  a new server authority control. Missing names fall back to IDs; if the sending agent's operator
  ID cannot be resolved, the delivery retries without starting a model turn.
- This lane did not change or independently re-prove the production authority model. The
  existing P1 server suite passed and the `supabase/` diff is empty.
- No decision was made about a cross-owner-specific ACP force-ask. The existing
  `session/request_permission` path remains active and relation-neutral.
