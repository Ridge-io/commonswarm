I'll attack the Lane C candidate against the spec, not the evidence READMEs. First I read the contract, the lane briefs, and the actual diff.Checkout matches `27769ea4` on `lane/identity-client`. Next I inventory evidence claims and the actual client/server change set.Prior arms failed this SHA's ancestors. I'll read those FAIL notes, then verify each attack vector in the current code.Prior FAILs named pending-surface ACK and unbound token renewal. I'll verify those in current code and hunt remaining holes.Pending-surface reclaim and dual receivers look like the remaining holes. I'll trace acquire, hook ACK, listen, and token renewal next.I'll check replay-vs-fence order, listen ACK, custom context paths, duplicate-name selectors, and whether interactive still reaches a model.Attack review of `lane/identity-client` @ `27769ea4`. Source only. Evidence READMEs were treated as claims. I did not run `npm test`, `test:p1-server`, or a live listener.

Earlier Grok FAILs (`e8abf8ab`, `0e3b6dfb`) named pending-surface ACK and unbound token renewal. Those holes are closed in this tree.

---

## Attack board

| Question | Result |
|---|---|
| Opt-in + exemption | Safe together. |
| Every mutation path fenced | Command kinds, claim/ACK, token renew, activity, files: fenced. Capability is not agent-auth. |
| Old process / stale hook steal or ACK | Server generation fence holds. A stale hook can try; it cannot complete ACK. |
| Interactive ACP / factory | Interactive receiver has no ACP import or spawn. Listen uses `NullListenerModel` and never prompts. |
| Duplicate names route wrongly | No first-match on CLI `--to`, mention, drafts, replies, connect. Rail is display only. |
| Idle model turns | None on listen idle, session renew, or interactive sleep. |
| Migration `SELECT p.*` / grants | Enumerated columns, no `wake_id`, GRANT present, `anon` revoked in the follow-up migration. |

---

## What holds

**Exemption is only `acquire_agent_session`.** `src/cloud/session-wire.ts:104-107`. The command fence is `!isAgentSessionProofExempt(kind)` before side effects (`supabase/functions/command/index.ts:7338-7365`). Replay of `idempotency_keys` sits later (`index.ts:7726`). Membership is pinned in `tests/protocol-workspace.test.ts:1579-1673`.

**Enable does not happen by accident.** Human owner/admin only (`lockHumanManagedPrincipal`, `index.ts:9781-9827`). Acquire on an unmanaged principal returns `session_not_managed` and does not set `managed_at` (`index.ts:10048-10050`). Live leases block enable (`session_leases_live`, `index.ts:9844-9853`). An agent cannot disable the fence (`HUMAN_ONLY_COMMANDS`, `src/protocol/workspace-commands.ts:377-392`). CLI disable copy warns that legacy writes resume (`src/cli.ts:6605-6606`).

**Acquire sends proof headers, not `key_hash` in the body.** `src/cloud/session-client.ts:146-156`. Same UUID+key retry checks the host binding (`index.ts:10086-10110`). A retired UUID cannot acquire (`index.ts:10051-10058`). Lost-response retry of a stored command uses current proof; old proof dies at the fence first.

**Activity is fenced.** `supabase/functions/activity/index.ts:127-138`. Capability stays on `swm_cap_` and is not agent-auth (`supabase/functions/capability/index.ts:1-24`). Read never calls `claimAgentInbox` / `ackAgentDelivery` (`tests/protocol-workspace.test.ts:1701-1708`). `is_live` matches the fence (`read/index.ts:640`, `agent-auth.ts:236`).

**Stale proof cannot write.** Fence compares live row, session UUID, generation, and key digest (`supabase/functions/_shared/agent-auth.ts:221-273`). Release/recover retire the UUID, bump generation, and reclaim unsurfaced rows including queued (`index.ts:9728-9767`, `10156`, `9978`, `10263`). Same UUID after expiry returns `session_expired` (`index.ts:10135-10136`).

**Queued stays nonterminal until surface.** Managed `observed` without `surfaced: true` is `delivery_not_surfaced` (`durable-delivery.ts:699-701`). A bare queued→observed promotion needs current proof on the row (`durable-delivery.ts:722-728`). Recovery reopens queued-unsurfaced without raising `attempt_count` (`tests/p1-server/managed-delivery.test.ts:509-573`).

**Hook observe is gated.** Exactly one live on-disk context; host id comes from stdin, not the file; proof headers go on the observe (`src/listener/hook.ts:897-920`, `src/cli.ts:7097-7165`). Print happens before observe (`hook.ts:1064-1098`). No host id → no observe. Two live files → no observe. Released file → no observe (`tests/p1-cli/hook-routing.test.ts:654-678`).

**Interactive mode does not construct a model.** `src/cloud/session-receiver.ts:1-5`. `--mode worker` is not in `SESSION_MODES` (`src/cloud/session-contract.ts:28-30`). `--foreground` with no host callback claims nothing (`session-receiver.ts:173-178`). Listen `newModel` is `NullListenerModel` (`src/cli.ts:5927-5930`, `src/listener/runtime.ts:165-176`). Runtime routes to main and never calls `model.prompt` (`runtime.ts:1576`). Session renew is a timer (`src/cloud/session-manager.ts:117-157`). Token renewal on `--session-context` uses the bound fetcher before `agentSession` (`src/cli.ts:2563-2577`). Listen binds the same way (`src/cli.ts:5745-5756`).

**Duplicate names.** CLI `--to` takes a UUID first and refuses an ambiguous name (`src/cloud/signals.ts:1414-1466`). Mentions insert `identityDisplayLabel` (UUID suffix when shared) and refuse a name-only tag when shared (`site/src/lib/mention-address.ts:166-179`). Drafts use `resolveStoredIdentityRefs` and never take the first match (`site/src/lib/identity-label.ts:109-141`). Reply locks To (`site/src/components/app/LiveDashboard.astro:2995-2999`). Connect `livePrincipalByName` returns a row only when the name is unique (`src/cloud/accept-link.ts:635-656`). Create still refuses duplicates unless `allow_duplicate_name: true`, under an advisory lock (`index.ts:6330-6356`).

**Migration view is not `p.*`.** `supabase/migrations/20260906000020_agent_execution_sessions.sql:300-318`. Columns are named. `wake_id` is absent. `GRANT SELECT … TO authenticated, swarm_read` is present. A DO block fails if `wake_id` is on the view (`sql:333-342`). Follow-up migration hides `key_hash` from `swarm_read` and revokes `anon` on the principals view (`20260906000030_managed_delivery_session.sql:53-68`, `99`).

---

## DEFECT

None that steal a session, skip the fence, start a model on interactive/listen, publish `wake_id` through `swarm_read.agent_principals`, or first-match a duplicate name.

---

## GAP

None. A later author does not have to invent pending-surface, the exemption set, or a bind for silent token renewal.

---

## NIT

- `src/cli.ts:312-329` still imports `listener/index.js`, which re-exports the four ACP model classes. Interactive start does not construct them. The nospawn test only greps `session-receiver.ts` and `session-cli.ts` (`tests/p1-cli/session-interactive-nospawn.test.ts:36-54`).
- Listen status still defaults a missing `routeMode` to the word `worker` (`src/cli.ts:4999`). `--route worker` cannot start. Copy only.
- `listSessionContexts` only scans the default tree (`src/cloud/session-context.ts:576-584`). A custom `--session-context` path outside that tree is not found by listen/hook. Writes then fail closed on the server.
- CLI `--to` is exact `===` (`signals.ts:1440-1445`). Site folds case/accents. `Dana` and `dana` are two names on the CLI, one name in the UI.
- Participant rail has no UUID `data-*` (`site/src/lib/participant-rail.ts:94-126`). Display only; no click-to-address.
- `AGENT_SESSION_TTL_MS` is typed twice (`session-wire.ts:14-17` and `session-contract.ts:22-24`). Values match today.
- `session-bound-writes.test.ts` covers revoke, activity, `signals_seen`, and `renew_agent_session`. The silent `renew_agent_token` bind is in `cli.ts:2563-2577` but not in that test.

---

## Not established

- Live acquire/ACK against local or production Supabase on this SHA (the live control log is a claim on an older SHA).
- `npm run test:p1-server` green on this SHA.
- End-to-end Codex same-chat injection.
- Foreign-uid context files.

QUOTE-BACK: Agent UUIDs and one active execution session
VERDICT: PASS
REASON: Managed opt-in and the acquire-only exemption hold together, every agent mutation path is fenced, a stale process or hook cannot steal or ACK, and interactive/listen never start a model.
