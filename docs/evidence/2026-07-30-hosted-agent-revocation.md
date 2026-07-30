# Hosted agent revocation — Forge evidence

Base: `492b6d150223adab66d47f1185fabbb227ca630b` (exact origin/main)
Branch: `swarm/Forge/hosted-agent-revocation`
Worktree: `~/.swarm/wt/cloud-swarm-source/Forge--hosted-agent-revocation`
Task: `hosted-agent-revocation` (claim: code-merged)

## Implementation (unchanged product surface from a8ec975)

Edge wire/prepare/projection, CLI principal/token revoke + agent stdin surrender,
browser Remove. See prior commit message.

## Test evidence revision (Lead7 #17548)

Invalidation of a8ec975 was **test evidence**, not implementation.

### p1-server suite now asserts

1. **Causal successor path:** `seedRenewalGrant` + `seedPredecessor` + `issueRenewal`
   creates a real successor; human revokes the **predecessor** token; already-issued
   successor cannot `post_signal` and cannot renew; a separate unrevoked control
   successor remains green in the same invocation.
2. **Hosted human role matrix:** Member own principal/token accepted; Member foreign
   principal/token → `principal_not_owned` with zero new tombstones; Admin foreign
   principal/token accepted; Owner cascade coverage retained.
3. Agent self-surrender, sibling 403 + zero tombstones, agent principal 403 retained.
4. Double/missing/wrong-workspace domain reasons retained.

### Mutations

| Arm | Result | Log |
|-----|--------|-----|
| Site `await revokeAgentPrincipal(` → `await clearPrompt(` | **RED exit 1** then restored **GREEN exit 0** | `docs/evidence/2026-07-30-agent-revocation-site-mutation-red.log` / `docs/evidence/2026-07-30-agent-revocation-site-mutation-green.log` |
| Agent-self scope exception (`isAgentTokenRevoke`) | **NOT ESTABLISHED** — requires exclusive p1-server slot | after GREEN suite on revised SHA |
| Lineage tombstone insert in `AgentTokenRevoked` projection | **NOT ESTABLISHED** — requires exclusive p1-server slot | after GREEN |

Site mutation measured: observer `agent roster Remove is role-aware…` failed only when the production call site was rewritten; restore returned 3/3 pass. Source is byte-restored (`await revokeAgentPrincipal(` present).

`tests/agent-revocation-mutation.test.ts` holds **seam observers only** (not causal mutation evidence).

## Cheap gates (to re-measure on revised SHA)

Record after re-run on successor commit.

## NOT ESTABLISHED until slot

- `npm run test:p1-server` full TAP
- Edge production RED/restore mutation logs (scope exception + lineage tombstone)
- Push / land / deploy / reviews
