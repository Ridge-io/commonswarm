I'll review this as a D-036 arm: read the spec contract first, then attack the candidate against section 9 with file:line evidence.SHA matches `b7fcd581` on `lane/agent-identity`. Next I’ll join the swarm and pull the lane specs plus mutation-path inventory.I’m already in the swarm as Warden. Next I’ll inventory the mutation paths, the migration, and the exemption set against section 8.I’ll now read the fence, migrations, and mutation edges in parallel so claims can be checked against code.Migration columns look enumerated, not `SELECT p.*`. Next I’ll check grants, fence call sites, and the client mutation paths.The session view may leak across tenants. I’ll verify that, then check hook ACK, interactive ACP, and duplicate-name routing.The fence, opt-in, duplicate-name routing, and no-idle-model path hold. One shipped hole does not: a PostgREST view with no membership gate.

SHA under review: `b7fcd581`. Evidence READMEs were treated as claims. I did not run `npm test`, `test:p1-server`, or a live listener.

## DEFECT

**`swarm_read.agent_execution_sessions` is a PostgREST table with no membership filter.**

`supabase/config.toml:13` exposes `swarm_read`. Sibling views all gate with `swarm.is_member(...)` (example: `supabase/migrations/20260905000001_channels.sql:62-75`). This view does not:

```70:92:supabase/migrations/20260906000030_managed_delivery_session.sql
DROP VIEW IF EXISTS swarm_read.agent_execution_sessions;
CREATE VIEW swarm_read.agent_execution_sessions
WITH (security_barrier = true)
AS
  SELECT
    principal_id,
    workspace_id,
    session_id,
    generation,
    lifecycle_state,
    host_label,
    provider,
    host_session_ref,
    started_at,
    renewed_at,
    expired_at,
    created_at,
    updated_at
  FROM swarm.agent_execution_sessions;

ALTER VIEW swarm_read.agent_execution_sessions OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.agent_execution_sessions TO authenticated, swarm_read;
```

Any logged-in JWT can `GET /rest/v1/agent_execution_sessions` and read every workspace’s `session_id`, `generation`, `provider`, and `host_session_ref` (the bound Codex thread id). The view owner is `swarm_admin`, so table RLS does not hide rows. Public UUID/generation cannot write (spec §8), but this is still a cross-tenant dump of host conversation ids. The read edge join is safe (`read/index.ts:641-646` starts from membership-gated `agent_principals`). PostgREST is not.

The `agent_principals` recreation is not this bug: it lists columns, omits `wake_id`, and grants `authenticated, swarm_read` (`20260906000020_agent_execution_sessions.sql:300-318`). `anon` is revoked in `20260906000030:99`.

## What holds (file:line)

**Opt-in + exemption.** `AGENT_SESSION_PROOF_EXEMPT_KINDS` is only `acquire_agent_session` (`src/cloud/session-wire.ts:106-108`). The command fence is `!isAgentSessionProofExempt(kind)` before route or idempotency replay (`supabase/functions/command/index.ts:7338-7365`, replay at `7726`). Acquire does its own `FOR UPDATE` and returns `session_not_managed` without setting `managed_at` (`10043-10050`). Enable is human owner/admin, row-locked, and refuses live leases (`9781-9853`). Agents cannot disable (`HUMAN_ONLY_COMMANDS` at `src/protocol/workspace-commands.ts:377-392`).

**Every agent mutation path.** Inventory test derives dispatcher kinds and fails closed on a new handler (`tests/protocol-workspace.test.ts:1664-1756`). Activity uses the same fence (`supabase/functions/activity/index.ts:130-138`). Capability is `swm_cap_` only and does not claim/ACK (`capability/index.ts:1-24`, `45`). Read never calls `claimAgentInbox` / `ackAgentDelivery` (`tests/protocol-workspace.test.ts:1783-1791`). Token renewal is `renew_agent_token`, not exempt. Silent CLI renewal with `--session-context` uses the bound fetcher before `agentSession` (`src/cli.ts:2563-2577`). Listen binds the same way (`5745-5756`, `6050`).

**Stale process / stale hook cannot steal or ACK.** Fence compares live row, UUID, generation, and key digest (`supabase/functions/_shared/agent-auth.ts:223-278`). Same UUID after expiry is `session_expired` (`command/index.ts:10135-10136`). Retired UUID cannot acquire (`10051-10058`). Recovery/release/fresh acquire reclaim unsurfaced queued rows without bumping `attempt_count` (`9728-9767`, `10156`, `10263`). Managed `observed` without `surfaced: true` is `delivery_not_surfaced` (`durable-delivery.ts:699-701`). Hook observe needs exactly one live on-disk context and the host id from stdin (`src/listener/hook.ts:898-910`, `934-947`). Print is skipped on refuse (`1047-1050`). Released or two live files cannot observe.

**Interactive / listen never start a model.** `SESSION_MODES` is `["interactive"]` (`src/cloud/session-contract.ts:29`). `session-receiver.ts` has no ACP import (pinned by `tests/p1-cli/session-interactive-nospawn.test.ts:36-54`). Listen `newModel` is `NullListenerModel` (`src/cli.ts:5928-5931`, `src/listener/runtime.ts:166-176`). Runtime routes to main and never calls `model.prompt` (`runtime.ts:1576`). `--route worker|split` is refused (`src/listener/main-routing.ts:36-37`, `103-105`). Renew is a timer (`src/cloud/session-manager.ts:117-150`). Idle listen does not invoke a model.

**Duplicate names.** CLI `--to` takes UUID first and refuses an ambiguous name (`src/cloud/signals.ts:1414-1466`). Mentions insert `identityDisplayLabel` and refuse a shared name-only tag (`site/src/lib/mention-address.ts:165-199`; picker option id is `kind`+UUID at `LiveDashboard.astro:2731-2732`, `3616-3621`). Drafts use `resolveStoredIdentityRefs` and never take the first match (`LiveDashboard.astro:2981-2987`, `identity-label.ts:159-192`). Reply locks To (`LiveDashboard.astro:2995-2999`). Rail is display with UUID suffix (`participant-rail.ts:90-110`). Create still refuses unless `allow_duplicate_name: true`, under `pg_advisory_xact_lock` (`command/index.ts:6330-6356`).

## GAP

None. A later author does not have to invent pending-surface, the exemption set, or proof on silent token renewal.

## NIT

- `src/cli.ts:300-329` still imports `listener/index.js`, which re-exports the four ACP model classes (`src/listener/index.ts:4-7`). Session start does not construct them. The nospawn test does not grep `cli.ts`.
- CLI `--to` is exact `===` (`signals.ts:1440-1445`). The site folds case/accents. `Dana` and `dana` are two names on the CLI, one name in the UI.
- Unmanaged claim will copy parse-ok proof headers onto the delivery row (`command/index.ts:8524-8525`). Old clients do not send them. First acquire after enable reclaims those rows.
- `AGENT_SESSION_TTL_MS` is typed twice (`session-wire.ts:14-17` and `session-contract.ts:22-24`). Values match today.

## Not established

- `test:p1-server` / live acquire-ACK on this SHA.
- End-to-end Codex same-chat injection.
- Production apply of `20260906000020` / `20260906000030`.

QUOTE-BACK: # Agent UUIDs and one active execution session
VERDICT: FAIL
REASON: `swarm_read.agent_execution_sessions` is granted to `authenticated` with no `is_member` predicate, so PostgREST publishes every workspace’s session UUID, generation, and host conversation id.
