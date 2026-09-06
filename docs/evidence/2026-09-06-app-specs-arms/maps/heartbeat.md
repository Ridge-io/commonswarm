# Map: the activity heartbeat, the wake socket, and what publishing from the listener needs

Explore subagent report, 2026-09-06, branch `spec/app-backlog` at `origin/main`. Read-only; nothing modified.

## 1. Current heartbeat path, end to end

**Listener side — `src/listener/activity.ts`**
- Constants: `ACTIVITY_FRAME_INTERVAL_MS = 750` (:12), `ACTIVITY_HEARTBEAT_MS = 15_000` (:13), `ACTIVITY_TOOL_TITLE_MAX = 160` (:14), `ACTIVITY_REQUEST_TIMEOUT_MS = 5_000` (:15). 750 ms coalescing gives the "up to 1.33/s active" cadence.
- Frame shape sent to the transport, `AgentActivityFrameRequest` (:48-57): `version`, `workspaceId`, `streamId`, `sequence`, `phase`, `signalId`, `toolTitle`, `elapsedMs`.
- `ListenerActivityController` (:165-343) coalesces state changes into `dirty`, throttles sends to one per `ACTIVITY_FRAME_INTERVAL_MS` (`schedule()` :294-308), and on every phase change clears and re-arms a heartbeat timer (`setPhase` :275-283, `armHeartbeat` :285-292) so that after `flush()` succeeds with nothing new to send it schedules another send exactly `ACTIVITY_HEARTBEAT_MS` later (:337-341).
- Transport: `AgentActivityEndpointTransport.publish` (:88-147) POSTs to `${target.url}/functions/v1/activity` with `authorization: Bearer <agent credential>`, `apikey: <anonKey>`, JSON body keys exactly `version, workspace_id, stream_id, sequence, phase, signal_id, tool_title, elapsed_ms` (:119-128). 5 s `AbortSignal.timeout`; failure classified into `ActivityPublishErrorCode` (:17-39) and surfaced only via `onPublishFailure` (comment :332-336).

**Edge function — `supabase/functions/activity/{index.ts,core.ts}`**
- `core.ts`: `ACTIVITY_EVENT = "activity"` (:1), `ACTIVITY_TOPIC_PREFIX = "cswarm-activity:"` (:2), `ACTIVITY_REQUEST_MAX_BYTES = 4_096` (:3). `parseActivityRequest` (:44-84) is a closed parser (`REQUEST_KEYS` :12-21) with cross-field invariants. `activityTopic(workspaceId)` (:35-38) derives the topic from the authenticated workspace id only.
- `index.ts`: auth requires `Bearer swm_agt_<43 chars>` (:16, :39-43); `boundedJson` (:52-75) enforces 4096 bytes; `handle()` (:78-152) hashes the token, `loadAgentCredential`, checks membership/archive/workspace match/revocation (:93-114), builds the outbound payload (:118-131) with keys `version, workspaceId, principalId, streamId, sequence, phase, signalId, toolTitle, elapsedMs, emittedAt` (server adds `principalId` and `emittedAt`, re-redacts `toolTitle` to 160 via `redactCredentialText`), then `RESET ROLE` and `realtime.send(payload::jsonb, ACTIVITY_EVENT, activityTopic(...), true)` (:141-150).

**Site consumer**
- `site/src/lib/agent-activity.ts`: `agentActivityTopic = activityTopic` (:66); `AGENT_ACTIVITY_STALE_MS = 30_000` (:6), `AGENT_ACTIVITY_INSTRUMENTATION_GRACE_MS = 17_000` (:7), `AGENT_ACTIVITY_ELAPSED_MAX_MS = 7d` (:8). `parseAgentActivityFrame` (:73-128) re-validates the exact key set `FRAME_KEYS` (:19-29). `agentActivityFrameIsNewer` (:135-141): same `streamId` → strict sequence order; different `streamId` → `emittedAt` compare. `agentActivityPanelView` (:169-232): fresh within `AGENT_ACTIVITY_STALE_MS`.
- `site/src/lib/commonswarm.ts`: `subscribeAgentActivity` (:180-216): `c.realtime.setAuth(active.access_token)` (the member's JWT), `c.channel(agentActivityTopic(workspaceId), { config: { private: true, broadcast: { ack: false, self: false } } })` (:191-196), `channel.on("broadcast", { event: "activity" }, ...)` (:197-200).
- `site/src/components/app/LiveDashboard.astro`: `agentActivityFrames: Map<principalId, frame>` (:1543) filtered by `agentActivityFrameIsNewer` (:2367-2369); 17 s grace after subscribe (:2382-2393).

## 2. The wake subscriber (0.1.58–0.1.60)

`src/listener/wake.ts`, class `WakeSubscriber implements WakeHandle` (:229-495).
- `defaultRealtime()` (:136-141): `createClient(target.url, target.anonKey, { auth: { persistSession: false, autoRefreshToken: false } }).realtime`, narrowed to `WakeRealtimeClient` (:101-109: `setAuth/channel/removeChannel/disconnect`). `connect()` (:429-449): `setAuth(this.target.anonKey)` (:433), `channel(topic, { config: { private: true } })` (:438-440), `on("broadcast", { event: WAKE_EVENT })` and `subscribe` (:442-448).
- Topic `cswarm-wake:{wake_id}` (`src/cloud/wake.ts:7`, `WAKE_TOPIC_RE` :9); `wake_id` on `swarm.agent_principals.wake_id` (`20260906000010_wake_delivery.sql:15-35`).
- States `WAKE_CONNECTION_STATES` (:30-36); `onSubscribeStatus` (:451-473); `setTopic` rotation (:326-339); `detachChannel` (:475-494).
- Budget: `WAKE_CLAIMS_PER_MINUTE_BUDGET = 50` (:16), `WAKE_COALESCE_MS = 1_000` (:15), `WAKE_RATE_LIMIT_POLL_MS = 60_000` (:17).
- `runtime.ts`: `ensureWake()` (:1040-1046), `applyWakeHint` (:1049-1054) from `page.wake`/`result.wake` (:1209, :1548); loop `await wakeSubscriber.next({ until: min(reconcileDueAt, ...) })` (:1162-1166); `emitWake()` (:1058-1064).
- `control.ts`: `parseListenerWake` (:397-433), `wake?: ListenerWakeStatus` (:183), refusal of `wake_*` keys on the wire (:899-915).
- **No accessor for the raw client or channel**: `WakeHandle` (:111-128) exposes state, snapshot, next, setTopic, budget methods, close; `this.realtime`/`this.channel` are private (:233-234). A second channel would be opened inside `wake.ts` on the same client.

## 3. Realtime authorization for a listener to PUBLISH

Every `CREATE POLICY ... ON realtime.messages` in `supabase/migrations` — three policies, all `FOR SELECT`, none `FOR INSERT`/`ALL`:

| migration | policy | role | command | predicate |
|---|---|---|---|---|
| `20260902000003_realtime_agent_activity.sql:4-16` | "workspace members receive agent activity" | `authenticated` | SELECT | `extension = 'broadcast' AND swarm.is_member(<uuid from 'cswarm-activity:{uuid}'>, auth.uid())` |
| `20260906000010_wake_delivery.sql` §6 | "agent receives its own wake" | `anon` | SELECT | `extension = 'broadcast' AND swarm.wake_topic_authorized(realtime.topic())` |
| `20260906000010_wake_delivery.sql` §6 | "workspace members receive signals" | `authenticated` | SELECT | `extension = 'broadcast' AND swarm.is_member(<uuid from 'cswarm-signals:{uuid}'>, auth.uid())` |

`swarm.wake_topic_authorized(topic)` (`20260906000010:44-83`): `STABLE SECURITY DEFINER`, owner `swarm_admin`, `GRANT EXECUTE TO anon` (:79); extracts the 43-char id, checks a non-revoked principal with that `wake_id` and a live token; false on any mismatch or exception.

A client INSERT needs (per the push-delivery spec §9, measured): `USAGE` on schema `realtime`, `INSERT` on `realtime.messages`, and an RLS INSERT policy — there is none today, so only `rolbypassrls`/owner roles can write. An anon-key client publishing is a different trust boundary from the server's trigger and is evaluated nowhere in the tree.

## 4. `@supabase/realtime-js` 2.110.8

- Presence: `RealtimeChannel.track(payload, opts)` (`dist/module/RealtimeChannel.js:230-236`), `.untrack` (:242-247) delegate to `send({ type: 'presence', event: 'track'|'untrack' })`; `presenceState()` (:216-218); `config.presence = { key: '', enabled: false }` default (:95); `on('presence', { event: 'sync'|'join'|'leave' })` (:275-313).
- Broadcast from client: `send({ type: 'broadcast', event, payload })` (:520-566) pushes over the socket when `canPush()`, else falls back to a REST POST; `httpSend` (:417-470) always REST; `config.broadcast = { ack: false, self: false }` (:94).
- `this.private = config.private || false` (:105); a public channel cannot use `broadcast.replay` (:106-108). The library ties RLS to `track()` (:224-229) and to subscription (`RealtimeClient.js:350`); the `extension` distinction is server-side.

## 5. Consumers of activity frames beyond the site

- `src/listener/control.ts:174-176,289-290,603-611` — `activityPublishFailures`, `activityLastErrorCode` on the status row.
- `src/listener/supervisor.ts:321-322,636-637` — initialises and increments them.
- `src/cli.ts:4890-4891,4970-4975` — `listen status` output.
- `tests/listener-control.test.ts:591-598,1238-1239,1258` — round-trip.
- `tests/listener-activity.test.ts:158-161` — pins the exact 15 s heartbeat boundary.
- `tests/p1-local/activity-realtime-auth.test.ts` — live-Supabase SELECT-only authorization proof.
- `site/src/components/app/entity-panel.observer.test.ts:97` — references `AGENT_ACTIVITY_INSTRUMENTATION_GRACE_MS` by name.

## 6. Cost facts

- Today per idle seat-day: 5,760 activity invocations at 15 s (`PUSH-DELIVERY.md` §1.3). After lane A's 60 s: 1,440, about 65 % of what remains after push delivery; the lead measured ~90 % in production on 2026-09-06.
- `ACTIVITY_HEARTBEAT_MS` is still `15_000` in this checkout (`activity.ts:13`).
- Successor 1 is named, not designed, in `PUSH-DELIVERY.md` §9.
- Billing of protocol heartbeats and presence sync frames: not established (push-delivery §9 open item). Pricing figures are cited in the push-delivery spec, not re-fetched here.

## Unknowns

- Safety of an INSERT/presence policy for an anon-keyed listener (client-INSERT trust boundary) — no design evaluated it.
- Hosted billing of presence vs broadcast.
- Whether `WakeSubscriber` gains a channel accessor or activity lives inside `wake.ts` as a second channel on the same client (per-principal wake topic vs per-workspace activity topic are different scopes; one connection carries both).
- The wire shape of a client-originated frame and whether `emittedAt`/`principalId` remain trustworthy without the edge's stamp.
