I'll attack this as a D-036 review arm: read the spec and lane docs first, then check the candidate against the section 9 questions with file:line evidence.HEAD is `0e3b6dfb` (detached). Next I’ll inventory evidence and the actual code, then attack the section 9 questions.Prior Grok FAIL was at `e8abf8ab`; I’ll re-check those holes at `b0902f68`/`0e3b6dfb` in the source, not the evidence README.Acquire now sends proof headers. Next I’ll check the fence, ACK, hook, and enable/disable paths for remaining holes.Reviewed `0e3b6dfb` (detached HEAD of this checkout) against spec section 8/9. Evidence READMEs were treated as claims. I did not run `npm test`, `test:p1-server`, or a live listener.

Round 2 at `b0902f68` did close the earlier acquire/`key_hash` hole and the hook “copy the host id from the file, send no key” hole. Those two are not defects on this SHA.

---

## Attack board

| Question | Result |
|---|---|
| Opt-in + exemption | Safe together. |
| Every mutation path fenced | Command kinds, claim/ACK, token renew, activity, files: fenced. Capability is not agent-auth. |
| Old process / stale hook steal or ACK | Server generation fence holds. A stale hook can try; it cannot complete ACK. |
| Interactive ACP / factory | Interactive receiver has no ACP import or spawn. Listen uses `NullListenerModel`. |
| Duplicate names route wrongly | No first-match on CLI `--to`, mention, drafts, replies, connect. Rail is display only. |
| Idle model turns | None on listen idle, session renew, or interactive sleep. |
| Migration `SELECT p.*` / grants | Enumerated columns, no `wake_id`, GRANT present. |

---

## What holds

**Exemption is only `acquire_agent_session`.** `src/cloud/session-wire.ts:48-50`. The command fence is `!isAgentSessionProofExempt(kind)` before side effects (`supabase/functions/command/index.ts:7338-7365`). Membership is pinned in `tests/protocol-workspace.test.ts:1573-1667`.

**Enable does not happen by accident.** Human owner/admin only (`lockHumanManagedPrincipal`, `index.ts:9724-9752`). Acquire on an unmanaged principal returns `session_not_managed` and does not set `managed_at` (`index.ts:9963-9969`). Live leases block enable (`session_leases_live`, `index.ts:9775-9785`). An agent cannot disable the fence (`HUMAN_ONLY_COMMANDS` includes enable/disable/recover, `src/protocol/workspace-commands.ts:377-392`).

**Acquire now sends proof headers, not `key_hash` in the body.** `src/cloud/session-client.ts:146-156`. The identity test forbids `key_hash` in the body and requires the two acquire headers (`tests/p1-cli/session-identity.test.ts:177-185`).

**Activity is fenced.** `supabase/functions/activity/index.ts:127-138`. Capability stays on `swm_cap_` and is not agent-auth (`supabase/functions/capability/index.ts:1-24`). Read never calls `claimAgentInbox` / `ackAgentDelivery`.

**Stale proof cannot write.** Fence compares live row, session UUID, generation, and key digest (`supabase/functions/_shared/agent-auth.ts:221-273`). Release/recover retire the UUID and bump generation (`index.ts:9862-9897`, `10110-10162`). Same UUID after expiry returns `session_expired` (`index.ts:10033-10035`). Replay sits after the fence, so old proof cannot read a stored mutation.

**Hook observe is gated.** Exactly one live on-disk context; host id must come from stdin, not the file; proof headers are attached (`src/listener/hook.ts:897-920`, `src/cli.ts:7094-7156`). Print happens before observe (`hook.ts:944-1098`). No host id → no observe. Two live files → no observe.

**Interactive mode does not construct a model.** `src/cloud/session-receiver.ts:1-5`. `--foreground` with no host callback claims nothing (`session-receiver.ts:171-175`). Listen `newModel` is `NullListenerModel` (`src/cli.ts:5917-5920`, `src/listener/runtime.ts:164-176`). Runtime never calls `model.prompt`. Session renew is a timer (`src/cloud/session-manager.ts:117-157`).

**Duplicate names.** CLI `--to` takes a UUID first and refuses an ambiguous name (`src/cloud/signals.ts:1414-1466`). Mentions insert `identityDisplayLabel` (UUID suffix when shared) (`LiveDashboard.astro:2714-2728`, `3616-3621`). Name-only `@Echo` is refused (`mention-address.test.mjs:69-79`). Drafts use `resolveStoredIdentityRefs` and never take the first match (`identity-label.ts:109-141`). Reply locks To (`LiveDashboard.astro:2995-2999`). Connect values are principal UUIDs.

**Migration view is not `p.*`.** `supabase/migrations/20260906000020_agent_execution_sessions.sql:300-318`. Columns are named. `wake_id` is absent. `GRANT SELECT … TO authenticated, swarm_read` is present. A DO block fails if `wake_id` is on the view (`sql:333-342`).

---

## DEFECT

None that steal a session, make acquire unbuildable, or publish `wake_id` through `swarm_read.agent_principals`.

---

## GAP

**1. No durable pending-surface protocol (spec §8 Delivery recovery; client item 9).**

The spec requires: `queued` stays nonterminal for managed seats; a pending-surface phase in Postgres; cache loss must not strand an ask; a bare queued→observed promotion is refused when managed.

This SHA still:

- Sets `acked_at` on `queued` and then promotes `queued` → `observed` with `lease_id: null` and `listener_instance_id: null` (`supabase/functions/command/durable-delivery.ts:637-675`).
- Uses that same promotion as the managed hook success path (`src/cloud/delivery.ts:899-917`, `src/listener/hook.ts:929-934`).
- Only clears unacked leases on recover (`reclaimUnsurfacedLeases`, `index.ts:9683-9697`). A row already `queued` is not reclaimed.

A later author would have to invent the column/handler and a client that uses it. The live control treating hook observe as success does not close this. Lane C acceptance “queue cache deletion + host loss recovered through durable server” is unmet.

**2. CLI `--session-context` does not bind token renewal.**

Listen passes the bound fetcher into `agentSession` (`src/cli.ts:5741-5746`). Ordinary CLI commands call `agentSession(cloud, override, agent)` with no fetcher (`src/cli.ts:2567`), then bind only later (`src/cli.ts:2604`). Silent `renew_agent_token` on a managed seat therefore has no proof. The server fence refuses it. The command may still run on a live predecessor. The bound-writes test covers `renew_agent_session`, not this `renew_agent_token` path.

---

## NIT

- `src/cli.ts:312-329` still imports `listener/index.js`, which re-exports the four ACP model classes. Interactive start does not construct them. The nospawn test only greps `session-receiver.ts` and `session-cli.ts` (`tests/p1-cli/session-interactive-nospawn.test.ts:36-54`).
- Detached listen still requires an absolute ACP binary it never starts (`src/listener/detach.ts:101-113`). That is leftover 0.1.61, not interactive mode.
- After recover, `session stop` hits the fence as `session_expired` (live check is first, `agent-auth.ts:255-257`) and does not mark the local file released. Server still refuses the stale ACK.
- Acquire retry on the server does not compare stored `host_session_ref` (`index.ts:10000-10028`). CLI `assertSameIdentity` does (`session-context.ts:663-670`).
- Read `is_live` uses `expired_at IS NULL OR expired_at > now` (`read/index.ts:640`). The fence uses `expired_at IS NOT NULL AND expired_at > now` (`agent-auth.ts:236`). Status can lie; writes still fail closed.
- `GRANT SELECT` on `swarm.agent_execution_sessions` to `swarm_read` includes `key_hash` (`sql:64-65`). The members query does not project it (`read/index.ts:627-640`). Digest is not the key.
- View recreation does not `REVOKE ALL … FROM anon` the way sibling `swarm_read` views do. GRANT to `authenticated, swarm_read` is present.
- CLI `--to` is exact `===` (`signals.ts:1440-1445`). Site folds case/accents. `Dana` and `dana` are two names on the CLI, one name in the UI.
- `renderRoster` still has a comment that says names are unique (`src/cli.ts:3598-3599`). User-facing `describeAudience` already says they are not (`src/cli.ts:3510-3512`).
- Participant rail has no UUID `data-*` (`site/src/lib/participant-rail.ts:94-126`). Display only; no click-to-address.

---

## Not established

- Live acquire/ACK against local or production Supabase on this SHA (the live control log is a claim).
- `npm run test:p1-server` green on this SHA.
- End-to-end Codex same-chat injection.
- Foreign-uid context files.

QUOTE-BACK: Agent UUIDs and one active execution session
VERDICT: FAIL
REASON: Spec section 8 still needs a durable pending-surface protocol, and this SHA still uses the old managed queued-to-observed ACK path, so cache loss can strand an ask.
