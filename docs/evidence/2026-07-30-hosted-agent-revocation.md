# Hosted agent revocation — Forge evidence

## Lineage

| Item | Value |
|------|--------|
| Pre-rebase tip | `8991ad2989be5ba6c947067e38785369431cd040` |
| Pre-rebase `command/index.ts` sha256 | `42f441dd97fee25c703d9a84538f7046f74f5c4c2c7b9f399ca2f48ecf690291` |
| Original implementation base | `492b6d150223adab66d47f1185fabbb227ca630b` |
| **Product/test tree tip (gates below)** | **`0c4aed938605884ae86c7e45aa7d288d1f21d31c`** — composite successor assert + whitespace follow-up |
| Product/test-tree parent | `04eb407` (rebase / observer-order commit; `0c4aed9` is the composite + whitespace follow-up); base `fb1dfdfd2f2f9d7c70820e76a23523d893cd68a3` (origin/main) |
| Product/test-tree `command/index.ts` sha256 | `42f441dd97fee25c703d9a84538f7046f74f5c4c2c7b9f399ca2f48ecf690291` (byte-identical to pre-rebase edge source) |
| Branch | `swarm/Forge/hosted-agent-revocation` |
| Worktree | `~/.swarm/wt/cloud-swarm-source/Forge--hosted-agent-revocation` |
| Task | `hosted-agent-revocation` (claim: code-merged) |

**Documentation-only successors** of this file (commits that touch only
`docs/evidence/**`) preserve the product and test tree measured below. Gates,
hashes, and causal claims refer to exact `0c4aed9` unless a later product/test
commit is explicitly named. A docs-only SHA is **not** a re-gated product tip.

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
| run-007 (arm2 mut: disable AgentTokenRevoked lineage INSERT) | 1 | 37/38 | **Structural RED only:** lineage count 0≠1 at self-surrender — suite stopped **before** successor post/renew asserts; **successor causal RED NOT ESTABLISHED** on this pre-rebase observer order |
| run-008 (restored) | 1 | 37/38 | Hosted-revocation PASS; same pre-principal flake |
| run-009 (recovery) | 0 | 38/38 | Full suite GREEN after arm2 structural attempt |

Durable logs: `~/.swarm/evidence/9a518dee-…/hosted-agent-revocation/run-00N.log`

Site mutation (cheap, pre-rebase): `docs/evidence/2026-07-30-agent-revocation-site-mutation-red.log` /
`…-green.log` — `revokeAgentPrincipal`→`clearPrompt` RED then restore GREEN.

## Preserved full log

`docs/evidence/2026-07-30-agent-revocation-p1-server-run-003.log` is the pre-rebase TAP
copy of swarm run-003. It is **tracked in this branch** (force-added under
`docs/evidence/`) so it is not silently lost across rebase.

## Measured gates on product/test tree exact `0c4aed9` (source sha256 `42f441dd…`)

Edge source remained byte-identical across inverse restores:
`sha256(supabase/functions/command/index.ts) = 42f441dd97fee25c703d9a84538f7046f74f5c4c2c7b9f399ca2f48ecf690291`
before mutation, after arm2 restore, and after recovery runs.

| Run | Exit | TAP | What was established |
|-----|------|-----|----------------------|
| run-010 | 0 | 38/38 | Final-SHA full `test:p1-server` baseline GREEN; hosted revocation PASS |
| run-011 (arm2 mut: disable only AgentTokenRevoked distinct lineage INSERT) | 1 | 37/38 | **Causal arm2 RED with revised observer.** Composite assertion ran after **both** already-issued successor **post** and **renew**. Failure text: `post HTTP 200` body `status=accepted` (signal accepted — post **live** under mutation) **and** `renew HTTP 200` body `status=rejected` `reason=renewal_lineage_revoked` (domain rejection of renew). **Causal ceiling:** post remains live when lineage tombstone is absent; renew is **independently** domain-rejected — do **not** claim renew was live (not 200/200 live). |
| run-012 (restored inverse, no checkout) | 1 | 37/38 | Hosted revocation **PASS**; sole fail: pre-principal async log-observer `2 !== 5` (unrelated fixed-delay audit-count flake). Edge hash restored `42f441dd…`; tracked clean on `0c4aed9` |
| run-013 (recovery, no-edit) | 1 | 37/38 | Hosted revocation **PASS**; sole fail: pre-principal async log-observer `4 !== 5` (same flake class). Not a product/reg regression of revocation |
| run-014 | 0 | 135/135 | Full `test:p1-cli` GREEN. agent-revocation-cli: help principal+token paths; principal revoke human-only calm; token revoke human id + agent stdin self-surrender; `ConnectCommand` both revoke kinds — all PASS |
| run-015 | 0 | — | `npm run build` (tsc) GREEN |
| run-016 | 0 | 102/102 | root `npm test` GREEN (includes agent-revocation-mutation observers) |
| run-017 | 0 | — | `npm run check:tests` GREEN |
| run-018 | 0 | — | `npm run check:edge` GREEN (`command` + `read` + `capability`) |
| run-019 | 0 | — | `npm --prefix site run build` GREEN — **7 page(s)** built |
| run-020 | 0 | 33/33 | `npm --prefix site test` GREEN (includes Remove/revokeAgentPrincipal observers) |

Durable logs: `~/.swarm/evidence/9a518dee-…/hosted-agent-revocation/run-01N.log` through `run-020.log`.

### Causal arm2 ceiling (run-011) — read carefully

With the production lineage tombstone INSERT disabled and tests untouched:

- Successor **post** returned HTTP **200** `accepted` (live write succeeded).
- Successor **renew** returned HTTP **200** with domain body **`renewal_lineage_revoked`** (not a live renewal success).

So arm2 proves the composite path executes both calls and that **post containment depends on the lineage tombstone**, while renew still hits an **independent** domain fence under this mutation. Claiming “both remain live (200/200 accepted)” is **false** and must not appear in summaries.

**Causal ceiling note (not a product gate):** renew-also-live under the lineage-INSERT mutation was **not observed** (renew was domain-rejected). That is the measured mutation ceiling only; it does not leave product revocation in doubt under restored source.

## Restored product gate — ESTABLISHED GREEN (Lead ruling)

**Lead ruling:** restored product state is **accepted GREEN**. This is complete product evidence for the measured tree, not a partial result awaiting another recovery slot.

Established by the combination of:

1. Exact product/test-tree run-010 full `test:p1-server` **38/38** GREEN on `0c4aed9`
2. Inverse-restored edge `command/index.ts` sha256 `42f441dd…` (byte-identical to pre-mutation) and tracked-clean HEAD on that tip
3. Hosted revocation **PASS** in post-restore runs 012 and 013

**Instrument caveat (not incomplete product evidence):** no later chronological suite free of the unrelated pre-principal async log-observer flake (`2!==5` / `4!==5` in 012/013) was observed. That is an instrument/observer caveat only. It does **not** leave product revocation uncertain and is **not** a remaining shipping gate.

## Shipping follow-through — ESTABLISHED

The shipping-only items that remained when this evidence was written were completed on
2026-07-30:

- the product tree received fresh exact-SHA Grok and AGY Google-family approvals
- hosted revocation landed on `main`
- production `command` version 13 was deployed and downloaded bytes matched the landed
  source
- the site was deployed, live-browser tested, repaired for one causal Add-agent panel
  defect, and redeployed from product SHA `21c3328`
- the disposable live onboarding, agent signal, removal backend, and complete privileged
  cleanup were exercised

See `docs/evidence/2026-07-30-workspace-first-production-e2e.md` for the production
artifact identities, measured journey, cleanup enumeration, and honest remaining
ceilings.
