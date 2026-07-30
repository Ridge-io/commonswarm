# Hosted agent revocation — Forge evidence

## Lineage

| Item | Value |
|------|--------|
| Pre-rebase tip | `8991ad2989be5ba6c947067e38785369431cd040` |
| Pre-rebase `command/index.ts` sha256 | `42f441dd97fee25c703d9a84538f7046f74f5c4c2c7b9f399ca2f48ecf690291` |
| Original implementation base | `492b6d150223adab66d47f1185fabbb227ca630b` |
| **Current base (after rebase)** | **`fb1dfdfd2f2f9d7c70820e76a23523d893cd68a3`** (origin/main) |
| Branch | `swarm/Forge/hosted-agent-revocation` |
| Worktree | `~/.swarm/wt/cloud-swarm-source/Forge--hosted-agent-revocation` |
| Task | `hosted-agent-revocation` (claim: code-merged) |

## Implementation

Edge wire/prepare/projection for `revoke_agent_principal` / `revoke_agent_token`, CLI
principal/token revoke + agent stdin surrender, browser `/app` Remove (role-aware).
No migration.

Rebased onto `fb1dfdf` (workspace entry redesign). **LiveDashboard conflicts: none**
(auto-merge). Manually verified both:

- upstream workspace-entry redesign (create-workspace / zero-workspace create panel)
- revocation roster Remove / error slot / livePrompt clear path

## Test observer order (post-rebase revision)

Hosted revocation p1-server suite order is intentional for arm2 discrimination:

1. Agent principal/sibling **403** (authz only; no tombstone counts)
2. **Causal successor first:** renew → human-revoke predecessor → issue successor
   **post AND renew**, then **one** composite assertion: both statuses ∈ {401,403};
   failure message reports **both** HTTP codes
3. Controls (unrevoked successor + fixture agent) **after** containment
4. Self-surrender accept + double/missing/wrong-workspace + human role matrix
5. **Deferred** token/lineage/principal count asserts (selfTok, predVictim, and others)
   only after behavior

## Measured gates on pre-rebase exact `8991ad2` (source sha256 `42f441dd…`)

| Run | Exit | TAP | What was established |
|-----|------|-----|----------------------|
| run-003 | 0 | 38/38 | Full suite GREEN |
| run-004 (arm1 mut: remove `!isAgentTokenRevoke &&`) | 1 | 37/38 | **Causal RED:** self-surrender HTTP 403 forbidden |
| run-005 (restored) | 1 | 37/38 | Hosted-revocation PASS; pre-principal log-count flake 2≠5 |
| run-006 (recovery) | 0 | 38/38 | Full suite GREEN after arm1 |
| run-007 (arm2 mut: disable AgentTokenRevoked lineage INSERT) | 1 | 37/38 | **Structural RED only:** lineage count 0≠1 at self-surrender — suite stopped **before** successor post/renew asserts; **successor causal RED NOT ESTABLISHED** |
| run-008 (restored) | 1 | 37/38 | Hosted-revocation PASS; same pre-principal flake |
| run-009 (recovery) | 0 | 38/38 | Full suite GREEN after arm2 |

Durable logs: `~/.swarm/evidence/9a518dee-…/hosted-agent-revocation/run-00N.log`

Site mutation (cheap, pre-rebase): `docs/evidence/2026-07-30-agent-revocation-site-mutation-red.log` /
`…-green.log` — `revokeAgentPrincipal`→`clearPrompt` RED then restore GREEN.

`docs/evidence/2026-07-30-agent-revocation-p1-server-run-003.log` — pre-rebase TAP copy of run-003,
force-added so it is not silently lost across rebase.

## NOT ESTABLISHED on the post-rebase tip

- Full `test:p1-server` after rebase/observer revision (**no tests in this cheap lane**)
- Arm2 **successor-causal** RED (post+renew both fail closed) on new tip — needs Tundra grant
- Reviews / push / land / deploy
