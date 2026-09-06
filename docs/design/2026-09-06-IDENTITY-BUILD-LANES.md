# Identity build lanes — exact scope and acceptance

Owner/adjudicator: CswarmAstra. Operator authorized Grok and AGY build lanes on 2026-09-06.
Read `docs/design/2026-09-06-AGENT-SESSION-IDENTITY.md`; section 8 is the precise contract.
No reviewer consensus loop is required. Root decides concerns; implementers report a contradiction
rather than silently weaken an invariant.

## Review adjudication

Claude r1 and Grok r1 both failed candidate 1. Accepted: public UUID/generation alone cannot
distinguish competing token holders; private session proof is required. Accepted: local-only
queued deliveries can be stranded; use durable pending-surface state. Accepted: lifecycle,
exemptions, explicit human opt-in/recovery, exact host conversation binding, duplicate-name
creation and resolution must be specified. Accepted: no default scheduled model polling.

Claude's lost-response objection does NOT justify stale-proof replay: proof is outside the
logical command hash, so the current holder retries the original command with current proof.
Stale proof remains rejected. A new session's private key is separate from the existing agent
credential; never copy that token. Same-OS-user malicious theft is outside the claimed protection.

Current main includes push delivery (0.1.60). Preserve Realtime wake, absolute reconcile deadlines,
empty-claim write savings, and subscribed-only push status. Do not replace wake with a new poller.
Hook preview and notify-body lanes are live elsewhere: do not change `src/listener/hook.ts`,
`tests/p1-cli/hook-routing.test.ts`, or `src/cloud/arrival-watch.ts` in this phase.

## Rules for each builder

- Use only your assigned worktree/branch. No git operations in the shared checkout.
- No swarm/CommonSwarm joins, messages, token reads, credential access, production calls, deploy,
  push, version bumps, global installs, or model subagents. Root handles coordination.
- Read AGENTS.md, newest resume tail, simplification state, then the bounded accepted spec once.
- No tests against Supabase until root grants the local slot. You may write server tests now.
- No shell command may contain a secret. Fake fixtures must be visibly synthetic.
- New tests must be in an actual package gate. Never branch on error.message.
- Run focused tests/build/checks. Report test command, exit code, counts, failures and unrun gates.
- Commit only owned files with accurate model attribution if hooks require it.
- Write a concise completion artifact in `docs/evidence/2026-09-06-agent-identity/<lane>.md`.
- End with HEAD, files changed, tests, known gaps, and exact integration instructions.
- Do not claim the entire feature complete when only your lane is built.

## Lane A — AGY server foundation

Worktree: /private/tmp/cswarm-astra-identity-20260906-01a07471/server
Branch: lane/identity-server
Own: `supabase/migrations/` (new uniquely named migration), `supabase/functions/`,
`src/protocol/`, new `src/cloud/session-wire.ts`, server tests and relevant existing pure
protocol tests. Do not edit CLI/listener/site/cloud files except the new wire file.

Implement:
1. Durable execution session state/history keyed workspace+principal. Atomic acquisition,
   monotone generation, never-reusable retired UUID, private key hash. Row locks also serialize
   enable/disable/recover. Foreign workspace/principal fails; no metadata used as authority.
2. Stable commands named in section 8 and explicit human owner/admin enable, disable, recover;
   expose status through read edge. Use existing command envelope/errors/idempotency conventions.
3. Headers `x-cswarm-session-id`, `x-cswarm-session-generation`,
   `x-cswarm-session-key`. Strict UUID, positive safe integer and base64url 32-byte key parsing.
   Export these names, timings, states/error codes in session-wire.ts for later client use.
   Private proof is excluded from command body/hash and all logs. Replays verify current proof.
4. Fence ALL agent mutations when enabled, with only acquire exemption and its own check.
   Token renewal, claims, ACK, activity, capability endpoints cannot bypass. Human calls retain
   existing authorization. Inventory actual routes in evidence; unknown mutation kinds fail closed.
5. Managed queued delivery is nonterminal durable pending-surface state. Recovery invalidates old
   generation leases and reclaims unsurfaced asks without exhausting execution retries. TTL remains.
   Explain legacy queued cutover and implement an explicit operator recovery action; no automatic
   sweeping of unrelated principals. Observe/reply require current proof + delivery ownership.
6. Remove agent-name uniqueness in SQL but retain principal-ID uniqueness and input validation.
   Protocol `create_agent_principal` gets optional `allow_duplicate_name: boolean`.
   Default duplicate refusal; true allows same name with a distinct principal UUID. Update edge
   parsing, pure decider and command core regeneration. Default concurrent duplicate creates must
   still serialize safely, even without a SQL name unique constraint.
7. Write real server tests for two racing sessions, wrong principal/key/generation, expiry,
   acquire retry/retired UUID, human recovery, missing-proof mutation/replay, current-proof retry
   same command after handoff, stale claim/ACK, unsurfaced host loss, unmanaged compatibility,
   duplicate-name explicit flag/default concurrent refusal. No fake-PASS placeholders.
8. Build/typecheck and regenerate bundle. Do not run db:start/reset/server gates yet.
9. Document exact request/response/error examples (all synthetic) in lane evidence. Client is built
   AFTER this lane so your exported contract is authoritative. Flag needed client changes precisely.

## Lane B — Grok UUID UI and creation affordance

Worktree: /private/tmp/cswarm-astra-identity-20260906-01a07471/names
Branch: lane/identity-names
Own: `site/src/`, `site/tests/` (or actual site test locations), and
`src/cloud/accept-link.ts` plus focused tests for it. No server/protocol/CLI/listener edits.
Avoid unrelated styling, model-colour, toolbar, brain-wiki or message truncation features.

Implement:
1. Enumerate name-based identity lookup/selection, stored drafts, recipient chips, reply targets,
   DOM keys and any persisted recipient fields. Record exact inventory in lane evidence.
2. Use principal UUID for selections/actions and draft state. Duplicate display names must remain
   selectable via unambiguous label (short UUID suffix). Do not invent model/owner data.
3. Keep name-only selector ambiguity refusal. Old name-only draft resolves ONLY if unique;
   otherwise clear invalid selection with a concise remedy. Never select first match.
4. On name collision, offer explicit create-another action sending `allow_duplicate_name: true`
   using the existing create-agent command envelope. Root/server lane adds protocol support.
   No retry loops minting new principals after lost response: retain existing command idempotency.
   Preserve default name collision flow, name validation and ownership/revocation controls.
5. Update accept-link flow to handle explicit duplicate-name request only where its API has a
   caller choice; do not silently enable it for all callers. If CLI seam required, document it
   for later client lane instead of editing CLI.
6. Meaningful tests: two same-name UUIDs chosen separately; outgoing command target; draft restore;
   rename and revoked member do not retarget; old ambiguous name refusal; create flag only after
   explicit choice; idempotent retry.
7. Run site tests/build and focused client tests/typechecks that your changes affect. Server
   contract may not exist until integration; document that dependency rather than faking it.
8. No session status UI yet: later client/server integration supplies its actual fields.

## Next lane — Grok managed client (root dispatches later)

Wait until Lane A contract exists, then integrate transport proof, secure context/lifecycle,
interactive receive without ACP, deterministic renewal, shared worker adapters, recipient prompt
binding, honest status, capability handshake, hook session scope and tests. Hook changes must be
rebased onto the separately landing preview lane first.

Root integrates A+B, assigns client, judges findings, obtains substantive exact-SHA final reviews,
runs exclusive local Supabase and live listener controls, and hands release to CSwarmDevLead.
