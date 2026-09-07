# 2026-09-06 RESUME HERE — CSwarmStrategist (2121f81d)

Written for a cold successor. Refs by hash; LIVE vs written stated per item.

## What is LIVE
- cswarm 0.1.61 on every seat (CSwarmDevLead, `e6e4992`): the listener never starts a model; route main only. Operator ruling, absolute: no headless agent answers for a main agent.
- Push delivery (0.1.59/0.1.60). Brain topics `listener-attended` v5 (the worker-in-a-live-seat incident), `commonswarm-roadmap` v7, `app-backlog` v20, `laptop-seats` v2, `hetzner-option` v1.
- CSLaptopLead (`9e38443b`) on the operator's laptop: clone at `/Users/tom/Developer/Ridge.io/commonswarm`, repo-scoped deploy key (GitHub key id 162469691), route-main session with hook; org setting `deploy_keys_enabled_for_repositories` flipped to true.

## What is WRITTEN, not live
- Eight app-backlog specs on `spec/app-backlog` at `7fba7dd`+ (record: `docs/evidence/2026-09-06-app-specs-arms/README.md`); two lanes from NO-TRUNCATION landed via CSLaptopLead and CSwarmDevLead.
- Agent-session identity (CswarmAstra's project, taken over): `lane/agent-identity` head `13e6f46`, code candidate `63acfdb`; lane branches `lane/identity-server-r2`, `lane/identity-names`, `lane/identity-names-r2`, `lane/identity-client`, `lane/identity-client-r6`, all merged into the integration branch. Every gate green, Grok exact + Gemini inversion PASS on the candidate, live control measured on the mini (`docs/evidence/2026-09-06-agent-identity/mini-live-control-63acfdb/`). Handed to CSwarmDevLead for release on 2026-09-06 with the order in the handoff ask and spec section 8. Status: `app-backlog` v24.

## Next file / line / command
- If identity is not yet released: read `app-backlog` item −1 and CSwarmDevLead's reply to the release handoff ask; do not restart lanes. After it lands: delete the identity worktrees under `/private/tmp/cswarm-astra-identity-20260906-01a07471` and the six lane branches when `git cherry main` shows zero for each.
- Then H1: decide `hetzner-option` first (one server carrying the MCP endpoint and the command/read API).

## Deliberately DEFERRED
- Hetzner move and GitHub Free-plan downgrade: options recorded, not decided.
- Codex arms while credits are out; Opus arms only on boundary specs.

## NOT established
- Production apply of the identity migrations; renewal under load; a wake path for non-Claude sessions.

## Corrections to published claims
- My seat's replies to signals 3e9049cf, 61c43c5f, f7442c59, d73f920e, 921dea51 on 2026-09-06 before 19:38Z came from a headless worker I had left running, not from this session (record in `listener-attended` v5).
- `docs/design/2026-09-06-PUSH-DELIVERY.md` cites `20260820000002:103-299` as the live body of `agent_delivery_read_context`; the live body is `20260906000010_wake_delivery.sql:276-483` (correction note at the top of that spec).
