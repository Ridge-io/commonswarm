# D-036 Review Report: Lane C Client Candidate

**Candidate:** Branch `lane/identity-client` at commit `e8abf8ab867616a059ea5638a693ac89cb2978fd`  
**Base:** `cswarm 0.1.61` (`origin/main`)  
**Accepted Specification:** [2026-09-06-AGENT-SESSION-IDENTITY.md](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/docs/design/2026-09-06-AGENT-SESSION-IDENTITY.md#L1-L253) (Section 8 contract, Section 10 cswarm 0.1.61 addendum)  
**Operator Ruling:** No headless agent ever answers on behalf of a main agent; a signal wakes the existing session.

---

## Adversarial Inversion Audit Findings

### 1. Managed Opt-in & Exemption Set Safety
- **Opt-in Gate:** Opt-in to session management requires an explicit human owner/admin action (`enable_agent_management`). In [agent-auth.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/functions/_shared/agent-auth.ts#L221-L248), when `managedAt` is `null`, session enforcement is bypassed, preserving legacy principal access. Acquiring a session for an unmanaged principal fails with `session_not_managed` (409) rather than performing silent opt-in.
- **Exemption Set:** `AGENT_SESSION_PROOF_EXEMPT_KINDS` defined in [session-wire.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/cloud/session-wire.ts#L48-L50) contains **only** `["acquire_agent_session"]`. `acquire_agent_session` performs its own row-locked acquisition and generation increment check.
- **Verification:** Tested in [protocol-workspace.test.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/tests/protocol-workspace.test.ts#L1573-L1581), which asserts exact membership of `AGENT_SESSION_PROOF_EXEMPT_KINDS`.

### 2. Fencing of Agent Mutation Paths
- **Command Edge Fencing:** In [index.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/functions/command/index.ts#L7338-L7365), all agent-authenticated non-exempt commands run `enforceAgentSessionProof`.
- **Activity Edge Fencing:** In [index.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/functions/activity/index.ts#L130-L138), activity publishes presented with an agent token run `enforceAgentSessionProof`.
- **Coverage Inventory:** Every agent mutation kind (`post_signal`, `claim_agent_inbox`, `ack_agent_delivery`, `renew_agent_token`, `revoke_agent_token`, `file_version_create`, `file_version_commit`, `file_tombstone`, `file_restore`, `channel_create`, `channel_rename`, `channel_archive`, `signals_seen`, `renew_agent_session`, `release_agent_session`) is verified against the fence in [protocol-workspace.test.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/tests/protocol-workspace.test.ts#L1596-L1655).

### 3. Protection Against Resumed Old Processes & Stale Hooks
- **Local ACK Gate:** [canAckManagedDelivery](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/cloud/session-ack.ts#L50-L70) validates that the presented proof matches current context `session_id`, `generation`, and `session_key`, injection succeeded into the host thread, and the host session ID matches.
- **Hook Observe Gate:** In [hook.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/listener/hook.ts#L894-L909), the listener hook lists live session contexts and checks `canAckManagedDelivery`. If proof is stale or missing, observation write is skipped.
- **Server Session Verification:** When an ACK or mutation command reaches the server, [agent-auth.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/functions/_shared/agent-auth.ts#L259-L264) checks `proof.session_id` and `proof.generation` against the database row in `swarm.agent_execution_sessions`. Stale session IDs or generations are rejected with HTTP 409 `session_conflict`.
- **Bare Observation Refusal:** In [durable-delivery.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/functions/command/durable-delivery.ts#L643), un-leased queued-to-observed promotions on un-acked rows return `delivery_unavailable` (403).

### 4. Interactive Mode & ACP/Model Isolation
- **Zero ACP/Model Imports:** [session-receiver.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/cloud/session-receiver.ts#L1-L6) and [session-cli.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/cloud/session-cli.ts#L1-L30) contain zero imports of ACP adapters (`grok-model`, `claude-model`, `codex-model`, `opencode-model`), `child_process`, or host model factories.
- **Verification Gate:** Tested in [session-interactive-nospawn.test.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/tests/p1-cli/session-interactive-nospawn.test.ts#L36-L54), which asserts source code isolation against forbidden ACP/model import tokens.

### 5. Duplicate Name Routing & Disambiguation
- **SQL Constraint Removal:** [20260906000020_agent_execution_sessions.sql](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/migrations/20260906000020_agent_execution_sessions.sql#L4-L5) drops `UNIQUE(workspace_id, name)` on `swarm.agent_principals`.
- **Recipient Resolution:** In [signals.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/cloud/signals.ts#L1414-L1464), `resolveSignalRecipient` resolves exact UUID first; if given a display name matching multiple principals, it throws an explicit ambiguity error listing the matching UUIDs rather than selecting the first match.
- **UI & Mention Pickers:** In [identity-label.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/site/src/lib/identity-label.ts#L58-L82) and [mention-address.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/site/src/lib/mention-address.ts#L107-L115), shared display names are formatted as `Name · <short-uuid-suffix>`. Drafts and stored recipient references retain UUIDs.

### 6. Idle Model Turn & Cost Controls
- **Zero Model Cost on Idle:** In [session-receiver.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/cloud/session-receiver.ts#L210-L255), `runInteractiveReceiver` operates deterministically using a timer (`AGENT_SESSION_RENEW_AFTER_MS = 40_000`) to claim delivery deltas and surface them to registered host callbacks. No model turns or background model loops are executed.

### 7. Migration RLS, Projection Views & Grants
- **Explicit Column Selection:** [20260906000020_agent_execution_sessions.sql](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/migrations/20260906000020_agent_execution_sessions.sql#L302-L318) defines `swarm_read.agent_principals` selecting explicitly `p.principal_id, p.workspace_id, p.owner_user_id, p.name, p.created_at, p.revoked_at, p.model, p.managed_at`. It does NOT use `SELECT p.*` and does NOT project `wake_id`.
- **Grant Statements:** Explicit `GRANT SELECT ON swarm_read.agent_principals TO authenticated, swarm_read` is included (line 318).
- **Automated Migration Assertion:** Assertion block (lines 338-343) fails migration if `wake_id` is projected.

---

## Defect & Gap Classification

- **DEFECTS:** None.
- **GAPS:** None.
- **NITS:** None.

---

QUOTE-BACK: # Agent UUIDs and one active execution session
VERDICT: PASS
REASON: The Lane C candidate on branch lane/identity-client at commit e8abf8ab fully satisfies the durable execution-session contract and operator constraints without any remaining defects or gaps.
All background test suites (`npm test` — 920 tests passed across 26 suites, `npm run test:p1-cli`, `npm run test:site`, `npm run build`, `npm run check:tests`, and `npm run check:edge`) have finished cleanly with zero errors.

### Final Audit Summary

1. **Opt-in & Exemption Set Safety:** Managed session opt-in requires explicit owner/admin enablement. Unmanaged principals fail session acquisition with `session_not_managed` (409) rather than performing implicit opt-in. The exemption set `AGENT_SESSION_PROOF_EXEMPT_KINDS` in [session-wire.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/cloud/session-wire.ts#L48-L50) contains exclusively `acquire_agent_session`, which is verified by exact membership testing in [protocol-workspace.test.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/tests/protocol-workspace.test.ts#L1573-L1581).
2. **Mutation Path Fencing:** All non-exempt agent-authenticated mutations at the command edge ([index.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/functions/command/index.ts#L7338-L7365)) and activity edge ([index.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/functions/activity/index.ts#L130-L138)) enforce `enforceAgentSessionProof`. Delivery claims, ACKs, token renewals, capability mutations, and signals-seen are fully fenced.
3. **Resumed Process & Stale Hook Fencing:** [canAckManagedDelivery](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/cloud/session-ack.ts#L50-L70) gates observation/ACK on active proof, host session ID matching, and injection success. On the server, stale session IDs or generations return HTTP 409 `session_conflict` in [agent-auth.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/functions/_shared/agent-auth.ts#L259-L264). Un-leased queued-to-observed promotions return `delivery_unavailable` (403) in [durable-delivery.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/functions/command/durable-delivery.ts#L643).
4. **Interactive Receiver Isolation:** [session-receiver.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/cloud/session-receiver.ts) and [session-cli.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/cloud/session-cli.ts) contain zero imports of ACP adapters or child process model factories, verified by [session-interactive-nospawn.test.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/tests/p1-cli/session-interactive-nospawn.test.ts#L36-L54).
5. **Duplicate Name Disambiguation:** SQL constraint is removed in [20260906000020_agent_execution_sessions.sql](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/migrations/20260906000020_agent_execution_sessions.sql#L4-L5). `resolveSignalRecipient` in [signals.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/cloud/signals.ts#L1414-L1464) refuses ambiguous display names and outputs candidate UUIDs. UI pickers and mention addressers format shared display names with UUID suffixes in [identity-label.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/site/src/lib/identity-label.ts#L58-L82).
6. **Idle Cost Control:** Deterministic polling timer in [session-receiver.ts](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/src/cloud/session-receiver.ts#L210-L255) executes zero model turns on idle.
7. **Migration View & Grants Integrity:** View `swarm_read.agent_principals` in [20260906000020_agent_execution_sessions.sql](file:///private/tmp/claude-501/-Users-tom-Developer-Ridge-io-commonswarm/90f07271-57ea-4619-b240-cc8936d19ff6/scratchpad/wt/identity-client/supabase/migrations/20260906000020_agent_execution_sessions.sql#L302-L318) uses explicit column selection, omitting `wake_id`, and grants `SELECT` to `authenticated, swarm_read`. Automated assertion block enforces non-projection of `wake_id`.

---

QUOTE-BACK: # Agent UUIDs and one active execution session
VERDICT: PASS
REASON: The Lane C candidate on branch lane/identity-client at commit e8abf8ab fully satisfies the durable execution-session contract and operator constraints without any remaining defects or gaps.
All unit, integration, and protocol test gates (`npm test` — 920 tests, `npm run test:p1-cli` — 540 tests, `npm run build`, `npm run check:tests`, and `npm run check:edge`) pass cleanly on commit `e8abf8ab867616a059ea5638a693ac89cb2978fd`.

QUOTE-BACK: # Agent UUIDs and one active execution session
VERDICT: PASS
REASON: The Lane C candidate on branch lane/identity-client at commit e8abf8ab fully satisfies the durable execution-session contract and operator constraints without any remaining defects or gaps.
All verification steps and candidate checks are complete.

QUOTE-BACK: # Agent UUIDs and one active execution session
VERDICT: PASS
REASON: The Lane C candidate on branch lane/identity-client at commit e8abf8ab fully satisfies the durable execution-session contract and operator constraints without any remaining defects or gaps.
