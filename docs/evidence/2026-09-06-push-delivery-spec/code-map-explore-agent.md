# Code map of the current polling mechanism — Explore subagent, read-only at spec/push-delivery base d500973, 2026-09-06

Produced by a read-only Explore subagent under CSwarmStrategist. Every claim carries file:line. Spot-checked by the lead: `src/listener/runtime.ts:77`, `src/listener/activity.ts:12-13`, `src/cloud/arrival-watch.ts:25`, `src/listener/hook.ts:57`, `supabase/functions/command/index.ts:8348-8445`, `supabase/functions/command/durable-delivery.ts:172-300`, `supabase/migrations/20260902000003_realtime_agent_activity.sql`, `supabase/migrations/20260905000020_wake_all_recipients.sql:152-225`.

## 1. Listener main loop — `src/listener/runtime.ts`

One `while (true)` at `:1068`, inside a `try/finally` that closes the model (`:1780-1789`).

Inbox page read at the top of every iteration, `:1075-1082`: `readPage({ token, after, limit: pageLimit, ... })`; default `readPage` `:951-972` → `readAgentSignalPage` with `inbox: true, ascending: true, includeStale: false` (`:956-961`). Edge function **`read`**, `POST ${target.url}/functions/v1/read` (`src/cloud/config.ts:42-44`); body built in `agentSignalPage` (`src/cloud/signals.ts:1118`, `:1140-1166`); headers `authorization: Bearer <agent token>` + `apikey` (`signals.ts:1141-1145`).

Mode: `classifyDeliveryMode` `:612-630` → `"durable_claim"` when the read page advertises both `deliveryClaim` and `deliveryAck`, else `"cursor_fallback"`; called at `:1104`.

Durable claim `:1365-1394`: `deliveryClient.claimAgentInbox({ workspaceId, credential, commandId: active.claimCommandId, listenerInstanceId, expectedPrincipalId })`. Client `src/cloud/delivery.ts:821-847` → `POST /functions/v1/command` (`:769`) with `{ command_id, client_version, workspace_id, stream: { kind: "workspace" }, command: { kind: "claim_agent_inbox", listener_instance_id, limit: 1 } }` (`:775-784`, `:826-830`). Server `supabase/functions/command/index.ts:8348-8390`, `durable-delivery.ts:172`; `DELIVERY_LEASE_MS = 15 min` (`:16`), `DELIVERY_MAX_ATTEMPTS = 10` (`:18`), `DELIVERY_MAX_OUTSTANDING_LEASES = 100` (`:23`).

Idle sleep: `LISTENER_IDLE_POLL_MS = 2_000` (`:77`), `pollMs = options.pollMs ?? LISTENER_IDLE_POLL_MS` (`:778`). Three `sleep(pollMs)` sites: empty claim `:1440-1456`; end of a non-full page `:1762-1778` (`fullPage = page.rawCount >= pageLimit`; otherwise `after = null; await sleep(pollMs)`); after a recovered prepared ACK `:1258`.

**One idle cycle in `durable_claim` mode = 1× POST /read + 1× POST /command{claim_agent_inbox} + 2 s sleep.** Measured production cadence ≈ 3.6 s wall clock.

`cadenceMs: pollMs` is reported on the `ready` event (`:1181`) → `supervisor.ts:441-448` → `read-health.ts:203-207`; `expectedClaims = HOUR_MS / claimCadenceMs` (`read-health.ts:403`).

Other backoffs: `nextFollowBackoffMs` on retryable read failure (`:1141-1160`); `LISTENER_HOST_PORTS_PROBE_MS = 60_000` (`:109`); `LISTENER_DELIVERY_RETRY_INITIAL_MS = 500` / `_MAX_MS = 30_000` (`:106-107`).

## 2. `src/listener/activity.ts`

`ACTIVITY_FRAME_INTERVAL_MS = 750` (`:12`), `ACTIVITY_HEARTBEAT_MS = 15_000` (`:13`), `ACTIVITY_TOOL_TITLE_MAX = 160` (`:14`), `ACTIVITY_REQUEST_TIMEOUT_MS = 5_000` (`:15`). Endpoint `POST ${target.url}/functions/v1/activity` (`:98-146`, `:110`), 5 s abort (`:105`). Heartbeat re-arms after every flush that leaves nothing dirty (`:339-341` → `armHeartbeat()` `:286-293`): **a live listener POSTs /activity at least every 15 s forever.**

The activity edge stores nothing durable: auth via opaque token regex `AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/` (`activity/index.ts:15`), sha256 → `loadAgentCredential` (`:93`); membership/revocation checks (`:94-119`); then `RESET ROLE` and `SELECT realtime.send(payload, 'activity', 'cswarm-activity:<workspace>', true)` (`:142-152`); 202 (`:153`). Topic helpers in `activity/core.ts` (`ACTIVITY_TOPIC_PREFIX = "cswarm-activity:"` `:2`, `activityTopic()` `:36-40`). Migration `20260902000003` creates no table: one `FOR SELECT TO authenticated` policy on `realtime.messages` keyed on `swarm.is_member(<topic uuid>, auth.uid())` (`:4-17`).

## 3. Every other periodic caller

- `inbox --notify`: `ARRIVAL_WATCH_POLL_MS = 25_000` (`arrival-watch.ts:25`, applied `:357`), one `readPage` per tick (`:387-391`), sole caller `src/cli.ts:3993`.
- UserPromptSubmit hook: not a timer; file-backed cooldown `HOOK_DEFAULT_COOLDOWN_SECONDS = 30` (`hook.ts:57`), `reserveCheck` skips the network inside the cooldown (`:1010-1022`), hard 3 s ceiling (`:998-1019`).
- Renewal: lazy on every `bearer()` (`renewal.ts:852-853`); `RENEWAL_LEAD_FRACTION = 0.1`, floor 5 min, ceiling 15 min, TTL 1 h (`:121-125`, `:67`) → ≈ one renewal per 54 min piggybacked on the next request.
- Keep-alive (commit `d7f2e29`): `src/listener/http-client.ts` — one `http(s).Agent` pair, `keepAlive: true, maxSockets: 1` (`:73-81`), idle timeout `LISTENER_HTTP_IDLE_TIMEOUT_MS = 60_000` (`:19`), metrics `connectionsOpened` / `connectionReuseRatio` into status (`control.ts:160-163`). **A websocket bypasses this adapter entirely.**
- Site `site/src/components/app/LiveDashboard.astro`: live feed refresh every **2 s** (`:5774`, gated on visibility `:5771-5775`); pending-access tick 4 s (`:5600`, `:5615-5621`) with 12 s / 30 s cooldowns (`:1513-1514`); brain re-read 30 s staleness gate (`:4471`, `:4511`); new-build check 5 min (`:9170-9186`). Human-seen receipts debounced (`human-seen-reporter.ts:3-4`).

Every `claim_agent_inbox` inserts an `idempotency_keys` row (`command/index.ts:8365-8380`) and an `audit_log` row (`insertAudit`, `:1382-1401`), empty or not.

## 4. Delivery data model

| Table | Migration:line | Role |
|---|---|---|
| `swarm.signals` | `20260724000003_signals.sql:3` | immutable bodies |
| `swarm.signal_deliveries` | `20260731000001_signal_deliveries.sql:15` | **mutable at-least-once ledger: inbox, claim, lease** |
| `swarm.signal_recipients` | `20260905000010_signal_recipients.sql:47` | ordered recipient set (≤ 8) |
| `swarm.signal_agent_receipts` | `20260902000004:4` | agent read receipts |
| `swarm.signal_human_receipts` | `20260901000020:8` | human seen receipts |
| `swarm.inbox_deliveries` | `20260723000001_p1_schema.sql:424` | DORMANT, retired by `20260731000001:8-10` |

`signal_deliveries` lease columns `20260731000001:16-32`; PK `(signal_id, recipient_agent_principal_id)` (`:33`); index `signal_deliveries_unacked_oldest (recipient_agent_principal_id, workspace_id, enqueued_at, signal_id) WHERE acked_at IS NULL` (`:76-84`). Grants: `REVOKE ALL FROM PUBLIC, anon, authenticated, swarm_read` (`:100`); policies `swarm_admin_all`, `swarm_command_all` only (`:92-98`).

Enqueue triggers (the natural hook for a wake): `swarm.enqueue_signal_delivery()` AFTER INSERT ON `swarm.signals` (rewritten `20260905000020:152-176`); `swarm.enqueue_recipient_delivery()` AFTER INSERT ON `swarm.signal_recipients` (`:191-217`, trigger `:222-225`); predicate `swarm.agent_delivery_is_wakeable(signal_id, workspace_id, principal)` (`:100-125`): `kind IN ('ask','note')`, `until > statement_timestamp()`, recipient not revoked. Apply order stated in that migration header (`:36-38`): migration → command edge → read edge → client.

**Realtime publication: nothing.** No table is in `supabase_realtime`; the only `realtime.` references are the activity policy, `activity/index.ts:139,146`, `tests/p1-local/activity-realtime-auth.test.ts:221`, and `config.toml:81-82`. Postgres Changes on `signal_deliveries` is impossible as granted today.

## 5. Agent authentication

Opaque token `swm_agt_` + 43 base64url chars (`src/cloud/agent-credential.ts:36`); server stores `sha256(token)` in `swarm.agent_tokens.token_hash` and looks it up (`_shared/agent-auth.ts:51-100`, `:67`); first-use is stamped on every auth path including `read` (`:23-48`). **Not a JWT; `auth.uid()` is null for an agent.** The CLI uses `@supabase/supabase-js` (`package.json`) for exactly one thing, human PKCE login (`src/cloud/auth.ts:5`, `:238-248`); every agent request is raw `fetch` against `/functions/v1/{read,command,activity}`. `@supabase/realtime-js` 2.110.8 is present transitively.

## 6. The 0.1.46 private Realtime channel

Topic `cswarm-activity:<workspace-uuid>` (`activity/core.ts:2,36-40`; site `agent-activity.ts:2-3,67-68`). Listener publishes via REST POST, holds no websocket (`src/listener/activity.ts:110`, best-effort by design `:159-166`, `:332-337`). Site subscribes with the human's Supabase `access_token`: `site/src/lib/commonswarm.ts:176-209` (`realtime.setAuth(active.access_token)` `:185`; `channel(topic, { config: { private: true, broadcast: { ack: false, self: false } } })`). Freshness: `AGENT_ACTIVITY_INSTRUMENTATION_GRACE_MS = 17_000`, `AGENT_ACTIVITY_STALE_MS = 30_000` (`agent-activity.ts:6-7`), applied `LiveDashboard.astro:2350-2366` ("Broadcast has no replay").

## 7. Duplicate-listener guard — `src/listener/control.ts`

`ListenerAlreadyRunningError` (`:178-183`); enforcement: `prepareSocket` probes the local control socket (`:964-983`), `startupLock` `open(<instanceDirectory>/starting.lock, "wx")` (`:922-962`, `START_LOCK_STALE_MS = 10_000` `:38`). Paths from `listenerInstanceKey({profileId, workspaceId, principalId})` (`file-store.ts:73-91`), socket under `/tmp/cswarm-control-<uid>/` (`:212-217`). **Per machine only.** Server side: `claim_agent_inbox` takes a caller-supplied `listener_instance_id` (`durable-delivery.ts:46`; UUID-validated `command/index.ts:1508-1509`), writes `leased_by` (`:299`), bounds leases per principal at 100 (`:23`, `:258-270`), `FOR UPDATE SKIP LOCKED` (`:293`): two instances interleave safely, wastefully.

## 8. Tests that pin cadence

Nothing pins `LISTENER_IDLE_POLL_MS`: runtime tests override `pollMs` to 0/1/10 (`tests/listener-runtime.test.ts:423,501,576,3087`; `tests/listener-control.test.ts:539,931,1034,1100,2123`). Pinned: `ARRIVAL_WATCH_POLL_MS == 25_000` (`tests/support/arrival-watch.test.ts:238`); `ACTIVITY_FRAME_INTERVAL_MS == 750` and the heartbeat at exactly `ACTIVITY_HEARTBEAT_MS` (`tests/listener-activity.test.ts:77-81`, `:158-163`). `tests/listener-control.test.ts:2336` round-trips `claimCadenceMs` from a synthetic `ready` event; `tests/listener-host-limits.test.ts:231` depends on the same plumbing. `tests/p1-local/activity-realtime-auth.test.ts` is the local-Postgres template for a Realtime policy test.

## Unknowns from the map

1. `swarm.is_member` definition (located afterwards by the lead: `STABLE SECURITY DEFINER`, memberships × workspaces not archived, see `local-plans.out`).
2. Hosted project Realtime settings (public access flag, limits).
3. Identity of the 16 production seats.
4. Any agent-scoped JWT minting server-side (none found in `supabase/functions/`).
5. Replica identity on `signal_deliveries` (default; moot without grants).
6. Cross-machine listener identity (none).
7. `ACTIVITY_HEARTBEAT_MS` 15 s vs the site's 17 s grace: margin rationale undocumented.
