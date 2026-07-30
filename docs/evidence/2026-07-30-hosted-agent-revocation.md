# Hosted agent revocation — Forge evidence

Base: `492b6d150223adab66d47f1185fabbb227ca630b` (exact origin/main)
Branch: `swarm/Forge/hosted-agent-revocation`
Worktree: `~/.swarm/wt/cloud-swarm-source/Forge--hosted-agent-revocation`
Task: `hosted-agent-revocation` (claim: code-merged)

## Scope delivered

1. **Edge** (`supabase/functions/command/index.ts`)
   - Wire accepts `revoke_agent_principal` (human CONNECT) and `revoke_agent_token` (workspace; agent self-surrender without a revoke scope).
   - Explicit prepare arms for both kinds; mint is no longer the prepare fallthrough.
   - Projection for `AgentPrincipalRevoked`: principal `revoked_at`, principal tombstone, all live tokens + distinct lineage tombstones, renewal grant revoke.
   - Projection for `AgentTokenRevoked`: token `revoked_at`, token + lineage tombstones.
2. **CLI** (`src/cli.ts`)
   - `cswarm principal revoke --principal-id`
   - `cswarm token revoke --token-id` (human)
   - `cswarm token revoke --agent-token-stdin` (agent self-surrender; derives/validates artifact `token_id`; never argv secret / never prints secret)
3. **Browser** (`/app` roster)
   - Remove only where owner/admin or owner-of-principal; confirmation ends identity+credentials and distinguishes Clear; posts `revoke_agent_principal` via user JWT; success refreshes roster and clears matching live prompt; refusal stays visible.
4. **Tests**
   - Pure: `tests/agent-revocation-mutation.test.ts` (named in `npm test`)
   - CLI observers: `tests/p1-cli/agent-revocation-cli.test.ts` (reached by `test:p1-cli` glob)
   - Site observers: `site/src/components/app/agent-revocation.observer.test.ts` (reached by site `test` glob)
   - p1-server: `tests/p1-server/command.test.ts` suite "hosted agent revocation…" (needs exclusive DB slot)

## Cheap gates (measured)

| Gate | Result |
|------|--------|
| `npm run build` | PASS |
| `npm test` | PASS 102/102 |
| `npm run check:tests` | PASS |
| `npm run check:edge` | PASS (deno check command/read/capability) |
| `site npm run build` | PASS 7 pages |
| `site npm test` | PASS 29/29 (after build) |
| pure mutation + CLI observers | PASS 7/7 |

## Mutations (RED controls)

Causal static mutations in `tests/agent-revocation-mutation.test.ts`:

- remove prepare arm for principal revoke → positive grep fails
- replace lineage tombstone kind → positive grep fails
- replace sibling-gate message → positive grep fails
- replace `revokeAgentPrincipal(` with `clearPrompt(` → site Remove ≠ Clear fails

## NOT ESTABLISHED at this write

- `npm run test:p1-server` / `test:p1-cli` full stack runs (require named exclusive slot from Tundra; one heavy process)
- Push / land / deploy / production verification
- Live browser QA of Remove against hosted deployment

## Ceilings

- No new migration (existing `revoked_at` + `revocation_tombstones` + grant cascade)
- No per-token browser UI
- No Claude review
- No push
