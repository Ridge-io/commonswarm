I'll attack the release candidate against the spec and prior arm records. First I read the contract, the claimed fixes, and the candidate diff.Checkout is `63acfdb`. Next I’ll read the spec contract, prior arm findings, and the candidate diff.Nine prior findings are on the table. I’ll verify each claimed fix in code, then attack the rest of the candidate.I’ll verify the nine claimed fixes in source, then inventory fences, the migration, and the session import graph.The first fixes look real. Next I’ll check CLI identity order, the receiver lock, and every mutation fence.I’ll run the tests that lock the nine claimed fixes. The rest of the review is already against the source.SHA under review: `63acfdb336a77fba884070849c8d83cc761855a5`. Spec §8 is the contract. Evidence READMEs were treated as claims. Focused CLI/protocol tests on this tree: 106 pass / 0 fail. I did not run `test:p1-server`, a live listener, or production apply.

## Prior nine findings — each fix is in the tree

| # | Was | Now | Test |
|---|---|---|---|
| 1 | Any write re-armed the 40s timer | `noteSuccessfulWrite` is a no-op (`src/cloud/session-manager.ts:76-82`). Only `renew` sets `lastProofAt` (`:151`) | `tests/p1-cli/session-lifecycle.test.ts:636-649` |
| 2 | View had no membership gate | `20260906000040_agent_execution_sessions_membership.sql:26-38` filters `swarm.is_member` and, for role `swarm_read`, `agent_principal_id`. Read edge installs that claim (`supabase/functions/read/index.ts:568-577`) | `tests/p1-server/agent-execution-sessions.test.ts:1092-1187` (source read; DB gate not run here) |
| 3 | Token renew before identity check | `openBoundAgentCredential` calls `assertLocalSessionBinding` before `openSession` (`src/cloud/session-cli.ts:117-141`). CLI uses it (`src/cli.ts:2575-2589`) | `tests/p1-cli/session-identity.test.ts:314-361` (fetches=0) |
| 4 | Retry ignored binding flags | `SESSION_ACQUIRE_BINDING_FIELDS` (`src/cloud/session-context.ts:701-723`); start calls it (`session-cli.ts:200`) | `tests/p1-cli/session-identity.test.ts:275-307` |
| 5 | Status trusted the file | Top-level `state`/`enforcement` come from the members row (`session-cli.ts:269-347`) | `tests/p1-cli/session-lifecycle.test.ts:657-709` |
| 6 | Custom context invisible | `session start` refuses a path outside the default tree before network (`src/cli.ts:6755-6766`) | `tests/p1-cli/session-cli.test.ts:124-138` |
| 7 | Bad generation became 1 | `acceptedGeneration` throws `session_generation_invalid` (`src/cloud/session-client.ts:139-151`) | `tests/p1-cli/session-lifecycle.test.ts:103-137` (file stays generation 0) |
| 8 | Two receivers | Lock beside the context (`src/cloud/session-context.ts:808-844`); listen and `--foreground` take it (`src/cli.ts:5727`, `session-cli.ts:242`) | `tests/p1-cli/session-context.test.ts:78-101`, `session-lifecycle.test.ts:54-98` |
| 9 | ACP on the session graph | `src/listener/index.ts` no longer re-exports the four model modules. Host/model loads are `require()` at listen executable paths (`src/cli.ts:358-371`) | `tests/p1-cli/session-interactive-nospawn.test.ts:86-96` |

Earlier six also hold: fence `FOR SHARE` (`supabase/functions/_shared/agent-auth.ts:223-251`); acquire binding (`command/index.ts:10096-10110`); unique labels (`site/src/lib/identity-label.ts:65-103`); `is_live` needs non-null `expired_at` (`read/index.ts:643`); dispatcher inventory (`tests/protocol-workspace.test.ts:1708-1755`).

## Whole candidate (git diff e6e4992 63acfdb)

**Opt-in + exemption.** Sole exemption is `acquire_agent_session` (`src/cloud/session-wire.ts:132-134`). Fence runs for every other agent kind before side effects and before idempotent replay (`command/index.ts:7338-7365`, replay at `:7733`). Acquire on an unmanaged principal returns `session_not_managed` and does not set `managed_at` (`:10043-10050`). Enable is human owner/admin, row-locked, and refuses live leases (`:9830-9853`). Agents cannot disable (`HUMAN_ONLY_COMMANDS` in `src/protocol/workspace-commands.ts:377-392`; handler also requires a user at `command/index.ts:9793`).

**Mutation paths.** Inventory derives kinds from the dispatcher (`tests/protocol-workspace.test.ts:1664-1756`). Activity uses the same fence (`activity/index.ts:127-138`). Capability is `swm_cap_` only and does not claim or ACK (`capability/index.ts:45`). Read never calls `claimAgentInbox` / `ackAgentDelivery`. Token renewal is `renew_agent_token`, not exempt.

**Stale process / stale hook.** Fence matches live UUID, generation, and key digest (`agent-auth.ts:260-277`). Same UUID after expiry is `session_expired` (`command/index.ts:10135-10136`). Retired UUIDs cannot acquire (`:10051-10058`). Managed `observed` without `surfaced: true` is `delivery_not_surfaced` (`durable-delivery.ts:699-701`). Hook needs exactly one live context and the host id from stdin (`src/listener/hook.ts:898-910`, `:1047-1050`).

**Interactive / listen never start a model.** `SESSION_MODES` is `["interactive"]` (`src/cloud/session-contract.ts:29`). Receiver has no ACP import. Listen `newModel` is `NullListenerModel` (`src/cli.ts:5948-5951`). `runListenerRuntime` never calls `model.prompt` (only `cancel`/`close`). Renew is a timer (`session-manager.ts:118-152`). Idle listen does not invoke a model.

**Duplicate names.** CLI `--to` takes UUID first and refuses an ambiguous name (`src/cloud/signals.ts:1414-1466`). Mentions refuse a shared name-only tag (`site/src/lib/mention-address.ts:165-199`). Drafts use `resolveStoredIdentityRefs` and never take the first match (`LiveDashboard.astro:2981-2987`). Reply locks To (`:2995-2999`). Rail labels from UUID-backed records (`participant-rail.ts:90-110`). Create still refuses unless `allow_duplicate_name: true` (`command/index.ts:6330-6356`).

**Migration.** `swarm_read.agent_principals` lists columns, omits `wake_id`, keeps `is_member`, grants `authenticated, swarm_read` (`20260906000020_agent_execution_sessions.sql:300-318`). Not `SELECT p.*`. Anon revoked in `20260906000030:99`.

## DEFECT

None.

## GAP

None.

## NIT

- Detached `listen start` spawns the child (`src/cli.ts:6244`) then takes the receiver lock (`:6288`). A busy lock can leave a child that then fails the same lock and exits. Not a second claimer.
- `AGENT_SESSION_TTL_MS` is typed twice (`session-wire.ts:14-17`, `session-contract.ts:22-24`). Values match today.
- CLI `--to` is exact `===` (`signals.ts:1440-1445`). The site folds case. `Dana` and `dana` are two names on the CLI, one name in the UI.

## Not established

- `test:p1-server` / live acquire-ACK on this SHA.
- End-to-end Codex same-chat injection.
- Production apply of `20260906000020` / `000030` / `000040`.

QUOTE-BACK: # Agent UUIDs and one active execution session
VERDICT: PASS
REASON: The nine prior findings are fixed in this SHA with tests that drive them, and the rest of the candidate matches section 8: one exemption, fenced agent writes, no stale ACK, no ACP on interactive receive, UUID duplicate-name routing, and no wake_id on the principals view.
