# Push delivery: wake listeners from Supabase Realtime instead of polling

**Status:** SPECIFICATION, draft 1, on branch `spec/push-delivery`. Assignment B from the operator via CSwarmDevLead (ask `3e9049cf`), authored by CSwarmStrategist (principal `2121f81d`). Not implemented. Nothing here is live.
**Authority:** on adoption this document becomes the §2.13 addendum of `docs/design/SWARM-CLOUD.md`; until then the spec wins on conflict.
**Scope ruling (CSwarmDevLead, 2026-09-06):** this spec covers option 3 of the brain topic `edge-function-invocations-2026-09`: wake listeners from Realtime, with a fallback poll. The one-constant change (`LISTENER_IDLE_POLL_MS` 2000→15000, `ACTIVITY_HEARTBEAT_MS` 15000→60000), the read+claim merge, and the retention/index quick cut are **lane A** (Grok, `lane/idle-cost`) and land first. The cross-machine duplicate-listener guard is deferred. Where this spec touches those, it says so and does not redo them.
**Evidence:** `docs/evidence/2026-09-06-push-delivery-spec/` — the code map (`code-map-explore-agent.md`), CodexDesktop's client and server passes, the local Realtime experiment, the local query plans, and the review arms. Every file:line below was confirmed on `d500973` by the author or by one of those passes, and the pass is named where it was not the author.

---

## 0. The answer in one paragraph

A listener today spends its life asking "anything for me?" every two seconds, twice per tick, and the server writes three rows to say "no". Replace the question with a doorbell: when a delivery row is inserted for a principal, a Postgres trigger broadcasts a content-free **wake** on a private Realtime topic that only that principal's live credential can join; the listener, holding one websocket, claims on the wake. Polling stays as the safety net, not the transport: one **reconcile claim** every 5 minutes while the socket is subscribed, and one claim every 15 seconds while it is not. The claim path, the lease, the ack, and the receipts do not change; the wake is a latency hint and the `signal_deliveries` row stays the only truth, so a lost wake costs at most one reconcile interval and never a delivery. An empty claim stops persisting anything. The same wake topic serves `inbox --notify`; a workspace-level topic serves the app's feed. Measured idle cost falls from about 55,000 edge invocations per seat per day to about 1,900, and the surviving rows per idle day fall from about 72,000 to zero.

---

## 1. Stage 1 — the invocation path per idle tick today (measured)

### 1.1 One idle tick of a `durable_claim` listener

| # | call | edge | from | persists |
|---|---|---|---|---|
| 1 | `readAgentSignalPage` (inbox page, limit 100) | `POST /functions/v1/read` | `src/listener/runtime.ts:1075-1082` → `src/cloud/signals.ts:1118,1140-1166` | `swarm.record_renewal_grant_use(...)` on every call (`read/index.ts:490-496`); `agent_delivery_read_context` can UPDATE `agent_tokens` and runs a COUNT(*) join over deliveries×signals (`:437-465`). No audit, no idempotency row. |
| 2 | `claim_agent_inbox` (limit 1) | `POST /functions/v1/command` | `runtime.ts:1365-1394` → `src/cloud/delivery.ts:821-847` | **three rows per empty claim**: `audit_log` (`command/index.ts:8424-8432`), `idempotency_keys` (`:8365-8380`), `rate_buckets` upsert (`checkDeliveryRateLimit`, `:4850`). Zero `signal_deliveries` rows change. |
| 3 | `sleep(LISTENER_IDLE_POLL_MS = 2_000)` | — | `runtime.ts:77`, `:778`, `:1455-1456` | — |

Measured production wall clock per tick ≈ 3.6 s (ledger, `docs/org/2026-08-29-RESUME-HERE.md:2283`), so per idle seat per day: 24,000 reads + 24,000 claims.

### 1.2 The other periodic callers of the same seat

| caller | cadence | edge | source |
|---|---|---|---|
| activity heartbeat | every 15 s idle, up to 1.33/s active | `POST /functions/v1/activity` → `realtime.send` | `src/listener/activity.ts:13`, `:98-146`; `activity/index.ts:142-152` |
| renewal | lazy, ≈ every 54 min, on the next request | `command` | `src/cloud/renewal.ts:852-853`, `:121-125` |
| `inbox --notify` watcher (separate process) | every 25 s | `read` | `src/cloud/arrival-watch.ts:25`, `:357`, `:387-391` |
| Claude hook | on prompt, ≥ 30 s apart | `read` | `src/listener/hook.ts:57`, `:1010-1022` |
| app tab | every 2 s while visible | `read` | `site/src/components/app/LiveDashboard.astro:5774` |

### 1.3 Per idle seat per day, today

| item | count |
|---|---|
| read invocations | 24,000 |
| command invocations (claim) | 24,000 |
| activity invocations | 5,760 |
| **edge invocations** | **≈ 53,800** |
| rows written that survive the tick | 24,000 audit + 24,000 idempotency + 24 rate-bucket rows (hourly upsert) ≈ **48,000** |

Fleet check: 16 seats × 53,800 ≈ 861,000/day; the dashboard read 832,000 on 2026-09-05 with restarts during the day. The ledger's 390,277 commands/24 h counts the command edge only; the read edge carries the same volume (CodexDesktop, client pass, point 3).

### 1.4 What the polling design cannot fix by tuning

- `LISTENER_IDLE_POLL_MS` and `ARRIVAL_WATCH_POLL_MS` are not configurable from the CLI or the environment; `pollMs` is a test seam (`runtime.ts:778`; sole production caller `src/cli.ts:5885-5918` never passes it). Any cadence change is a client release to every seat.
- A longer poll buys cost with latency, linearly. Lane A's 15 s idle poll cuts invocations ≈ 7× and raises wake latency from ≤ 2 s to ≤ 15 s. It does not change the shape: cost still scales with seats × 1/cadence, forever.
- Long-polling on the edge is not available: Edge Functions have a 150 s request idle timeout and a 2 s CPU budget, and no client long-poll exists (`--wait` is a 1 Hz client loop, `src/cloud/signals.ts:1501-1538`).

---

## 2. Stage 2 — the design

### 2.1 Principle

**Push is a hint. The row is the truth.** Every wake, every reconnect, and every timer ends in the same `claim_agent_inbox` call against the same `signal_deliveries` ledger with the same lease and ack semantics. Nothing about correctness moves to the socket. This is why the design can tolerate at-most-once broadcast, duplicate wakes, reconnect storms, and a Realtime outage without a delivery being lost.

### 2.2 The wire contract

**W1 — wake topic (per principal, private).**
`cswarm-wake:{principal_id}:{wake_key}` where `wake_key` is 32 random bytes as 43 base64url characters, minted with the agent token and rotated with it. Event name `wake`. Payload:

```json
{ "v": 1, "signal_id": "<uuid>", "enqueued_at": "<timestamptz>" }
```

The payload carries no body, no sender, no kind. It says "a delivery row for you exists as of this time". A subscriber that learns a wake learns only that; the claim still needs a live `swm_agt_` token.

**W2 — workspace signal topic (per workspace, private, humans).**
`cswarm-signals:{workspace_id}`, event `signal`, payload `{ "v": 1, "signal_id": "<uuid>", "created_at": "<timestamptz>" }`. Authorized exactly like the existing activity topic: `FOR SELECT TO authenticated USING (swarm.is_member(<workspace from topic>, auth.uid()))` (`20260902000003_realtime_agent_activity.sql:4-17` is the template). Replaces the app's 2 s feed poll (§4.3).

**W3 — where the wake key travels.**
1. `mint_agent_token` and `renew_agent_token` responses gain an optional `wake: { topic, event }` object.
2. The `claim_agent_inbox` response gains the same optional `wake` object, so a listener that started on an older token learns its topic on its first claim without a re-mint.
3. Both are additive. The client's response parsers accept unknown fields (command edge throws only on a non-object or a missing `status`, `src/cloud/command-client.ts:717-732`). A 0.1.56 client ignores `wake` and keeps polling.

**W4 — the sender: a trigger, not the edge.**
`swarm.wake_agent_delivery()` AFTER INSERT ON `swarm.signal_deliveries` FOR EACH ROW. It reads the recipient's live wake key and calls `realtime.send(payload, 'wake', topic, true)`. It runs `SECURITY DEFINER`, owner `swarm_admin`, `SET search_path = pg_catalog`, because `swarm_command` cannot execute `realtime.send` (the activity function has to `RESET ROLE` for the same reason, `activity/index.ts:139-145`). The body is wrapped in `BEGIN … EXCEPTION WHEN OTHERS THEN RETURN NULL; END` so a Realtime failure can never fail the signal insert: the row is the truth, the wake is best-effort. It fires for both enqueue paths, scalar (`enqueue_signal_delivery`, `20260905000020:152-176`) and fan-out (`enqueue_recipient_delivery`, `:191-217`), because both insert into `signal_deliveries`.

`swarm.wake_workspace_signal()` AFTER INSERT ON `swarm.signals` does the same for W2.

**W5 — authorization: the topic is the capability.**
An agent principal has no Supabase JWT and `auth.uid()` is null for it (code map §5). The design does not mint one. Instead the listener connects with the **anon key** and joins a **private** topic, and a `realtime.messages` SELECT policy `TO anon` admits the join only when the topic names a live credential:

```sql
CREATE POLICY "agent receives its own wake"
ON realtime.messages FOR SELECT TO anon
USING (
  realtime.messages.extension = 'broadcast'
  AND swarm.wake_topic_authorized((SELECT realtime.topic()))
);
```

`swarm.wake_topic_authorized(topic text) RETURNS boolean` is `STABLE SECURITY DEFINER` (owner `swarm_admin`, `EXECUTE` granted to `anon`), parses `cswarm-wake:<uuid>:<key>`, and returns true iff a row exists in `swarm.agent_tokens` for that principal with `wake_key = key`, `revoked_at IS NULL`, `expires_at > now()`, whose principal, run, and device are not revoked or ended. One indexed lookup on `(principal_id, wake_key)`.

**Measured, not assumed:** on the local stack an anon-key client joined a private topic covered by such a policy (`SUBSCRIBED`), was refused on a topic outside it (`CHANNEL_ERROR: Unauthorized … cswarm-inbox-other:…`), and received a database-side `realtime.send()` within the 4.5 s observation window. Transcript: `docs/evidence/2026-09-06-push-delivery-spec/realtime-anon-private-topic-experiment.{mjs,out}`. This closes the gap CodexDesktop's server pass named as "Realtime is not available to agents today": it is available through a policy, without a JWT and without Postgres Changes.

Why not mint a JWT: it needs the project's legacy HS256 secret in the edge environment, which Supabase is retiring in favour of asymmetric signing keys (`supabase.com/docs/guides/auth/signing-keys`) and which no edge function holds today (code map §5, unknown 4). The topic-capability needs no secret outside Postgres. The wake key is a **low-privilege** secret: possession lets a party learn when a principal has work, nothing else. It is therefore stored in plaintext on `swarm.agent_tokens.wake_key` so the trigger can build the topic; the token itself stays hashed. The spec states this trade plainly so it is not mistaken for a token leak later.

**W6 — Realtime policy caching.** Realtime evaluates the policy at join and caches it for the connection ("Client access policies are cached for the duration of the connection"). Revoking a token therefore stops new joins immediately and stops an existing subscriber only at its next reconnect or `access_token` refresh. Accepted, because W1 carries nothing a revoked party can act on. The listener re-sends `access_token` on every token renewal (≈ hourly), which re-evaluates the policy (W5) and cuts a revoked subscriber within one renewal period at most.

### 2.3 The listener

**New module `src/listener/wake.ts`** (`WakeSubscriber`): owns one `RealtimeClient` (`@supabase/realtime-js`, already present transitively; becomes a direct dependency) against `${target.url}/realtime/v1` with `params: { apikey: anonKey }`, `heartbeatIntervalMs: 25_000` (the library default), `setAuth(anonKey)`. It exposes:

- `state`: `disconnected | connecting | subscribed | errored(code)`; `subscribedAt`, `reconnects`, `lastWakeAt`, `lastErrorCode`.
- `wakes()`: an async iterator that yields once per coalesced wake (250 ms coalescing window) and once per transition to `subscribed`.
- `setTopic(topic)` when a claim or renewal reports a new `wake.topic` (key rotation): unsubscribe old, subscribe new; the transition to `subscribed` on the new topic triggers a reconcile.

The websocket bypasses `ListenerHttpClient` (`src/listener/http-client.ts`), which is the HTTP keep-alive adapter; that is expected and the status metrics stay HTTP-only.

**Loop change in `src/listener/runtime.ts`.** The idle path (`:1440-1456`, `:1762-1778`) changes from `await sleep(pollMs)` to:

```
await Promise.race([ wake.next(), sleep(pollMsFor(wake.state)) ])
```

with `pollMsFor(subscribed) = LISTENER_RECONCILE_POLL_MS = 300_000` and `pollMsFor(anything else) = LISTENER_IDLE_POLL_MS` (15 s after lane A). The per-tick read at `:1075-1082` is skipped while `wake.state === subscribed` and `deliveryMode === durable_claim`: the claim response already carries the deliveries, and the read is a paid, writing call (§1.1). In `cursor_fallback` mode (server without claim capability) the read stays and the loop behaves as today.

**On every wake and on every transition to `subscribed`: claim until empty.** The existing drain logic already re-requests immediately on a full page; the same rule applies to claims. If a wake arrives while a claim is in flight, the subscriber sets a dirty flag and the loop claims once more before sleeping. That is the whole duplicate-wake story: extra wakes cost one empty claim each, never a lost delivery.

**Status** (`src/listener/control.ts` `ListenerStatus`, `cswarm listen status`): a `wake` block — `mode: "push" | "poll"`, `subscribedAt`, `reconnects`, `lastWakeAt`, `lastReconcileAt`, `lastErrorCode`, `topicRotatedAt`. The human line reads `push (Realtime), last wake 12 s ago, reconcile every 5 min` or `poll every 15 s — Realtime not connected (<code>)`. It never says `push` unless `state === subscribed` right now (false-success rule). `claimCadenceMs` / `expectedClaims` (`read-health.ts:203-207`, `:403`) become the reconcile cadence in push mode; the tests that round-trip them (`tests/listener-control.test.ts:2336`, `tests/listener-host-limits.test.ts:231`) are updated in the client lane.

### 2.4 Failure modes, one by one

| failure | what happens | worst case | why no delivery is lost |
|---|---|---|---|
| **Missed wake** (Realtime dropped it; broadcast has no replay) | nothing until the reconcile claim | 5 min latency | the row is in `signal_deliveries`; the reconcile claim reads the ledger |
| **Socket down, listener does not know yet** (half-open) | library heartbeat every 25 s detects it; state → `disconnected`; poll at 15 s begins | 25 s detection + 15 s poll = 40 s | same |
| **Socket down, known** | 15 s poll; reconnect ladder `[1, 2, 5, 10] s` (`RealtimeClient.js:16`) | 15 s latency | same |
| **Reconnect** | transition to `subscribed` fires one claim (reconcile-on-join) | — | any row enqueued while disconnected is claimed on join |
| **Duplicate wake** (two listeners on one principal, retried send, coalescing miss) | each subscriber claims; `FOR UPDATE SKIP LOCKED` (`durable-delivery.ts:293`) gives the row to one | one extra empty claim per duplicate | leases are exclusive |
| **Policy refused** (revoked/expired token, key rotated) | `CHANNEL_ERROR`; state → `errored(unauthorized)`; poll at 15 s; the next claim/renewal returns the current `wake.topic`; resubscribe | 15 s latency until re-keyed | claim still works if the token is live; if it is not, the seat is dead by design |
| **Reconnect storm** (Realtime deploy, network blip, our own release) | every seat reconnects on the library ladder; joins are rate-limited server-side (500/s on Pro, `too_many_joins`); the client adds 0–5 s jitter before the reconcile claim | at 10,000 seats ≈ 20 s of throttled joins, then normal | the 15 s poll covers the window |
| **Thundering herd on our deploy** (all listeners restart on a release) | each start = 1 join + 1 reconcile claim + 1 read (first page for mode classification) | 10,000 seats → ≈ 30,000 invocations in one minute, once | — |
| **Wake arrives for a row the listener already claimed** (reconcile raced the wake) | one empty claim | — | — |
| **Realtime message rate exceeded** (500/s Pro) | Realtime disconnects and the client reconnects when under the limit | poll covers | — |
| **Trigger cannot send** (Realtime schema unavailable, partition missing) | exception swallowed; row inserted; wake lost | 5 min | W4's exception guard; the reconcile |
| **Listener behind a proxy that blocks websockets** | `connecting` never reaches `subscribed`; poll at 15 s; status says so | permanent 15 s latency | this is lane A's world, unchanged |

### 2.5 What stays exactly as it is

The claim (`claimAgentInbox`, `durable-delivery.ts:172`), the lease budget, `DELIVERY_MAX_ATTEMPTS`, the ack path, prepared-ack recovery (`runtime.ts:1258`), receipts, the activity heartbeat transport, the hook, `--route`, `--permissions`, the credential rotation. A 0.1.56 listener keeps working at every step (§6).

---

## 3. Persistence and retention

### 3.1 What a poll may persist

Rule, to be written into `SWARM-CLOUD.md` §2.2: **an audit row and an idempotency row are written for a state-changing command or a refused command, never for an empty read-intent command.** `claim_agent_inbox` is the one command that is mutating in general and a read when empty. The change is confined to its branch (`command/index.ts:8348-8445`; there is no shared wrapper to gate, CodexDesktop server pass point 5): gate the `idempotency_keys` insert (`:8365`) and the `insertAudit` (`:8424`) on `ledger.delivery_refs.length > 0 || ledger.terminal_delivery_failure_count > 0`. The `rate_buckets` upsert (`:4850`) stays: it is one row per principal per hour, and it is the abuse control.

**Replay semantics, decided here, not deferred:** the replay branch (`:7609-7616`) returns a stored ledger for a retried `command_id`; with the empty insert skipped, a retried empty claim finds no row and re-executes. That is correct: an empty claim changed nothing, so re-executing it is indistinguishable from replaying it, except that it may now find work, which is what the caller wants. A non-empty claim still writes its row and still replays. The `LedgerRace` detector (`:8381-8389`) is untouched for non-empty claims. This is lane A's change if lane A lands it first; this spec records the decision so lane A does not have to.

The read edge writes `record_renewal_grant_use` on every call (`read/index.ts:490-496`). In push mode the per-tick read is gone (§2.3), so this write drops with it; the reconcile is a claim, not a read.

### 3.2 Retention

| table | today | policy |
|---|---|---|
| `swarm.idempotency_keys` | purged daily at 03:17 by `swarm.purge_expired_idempotency_keys()` (`20260723000001_p1_schema.sql:793-816`, cron `:839-843`), retention from config key `idempotency_retention_days` (default 30, `:442`) | replay is needed for seconds, not weeks; set the key to **2 days**, and lower the function's floor if it has one (CodexDesktop read a 30-day floor; the retention lane verifies against the function body). Index `idem_purge (created_at)` exists (`:380`); plan in `local-plans.out` is an index scan |
| `swarm.audit_log` | **append-only by trigger** (`audit_log_append_only`, `:588-590`): DELETE raises; no purge; no index on `occurred_at` alone (`local-plans.out` shows the delete plan using `audit_by_cred` on its second column, i.e. a full index walk) | not stopping the write is the only lever, and §3.1 stops it. Archival after one year stays an external operation, as the migration says (`:791-792`) |
| `swarm.rate_buckets` | hourly upsert per principal per op; PK only (`:416-421`); a cron purges it (`:845`) | unchanged; one row per principal-hour |
| `realtime.messages` | partitioned by day; partitions older than 3 days are dropped by Supabase | nothing to do |
| `swarm.signal_deliveries` | terminal rows purged by cron (`20260731000001_signal_deliveries.sql:272`) | unchanged |

---

## 4. The watcher and the app on the same model

### 4.1 `inbox --notify` (`src/cloud/arrival-watch.ts`)

The watcher is a second subscriber to W1, using the same `WakeSubscriber`. On wake it does exactly what it does on a tick today: one `readPage` from its cursor, emit, persist cursor (`:431-437`). Its poll drops from 25 s to a 5-minute reconcile while subscribed and 25 s while not. It never claims or acks (`:338`), so it cannot steal work; it only observes. Where does it get the wake key? The watcher already holds the agent credential; it calls `claim_agent_inbox` with `limit: 0` once at start to learn `wake.topic` (a zero-limit claim leases nothing: `effectiveLimit <= 0 ? []`, `durable-delivery.ts:273`). Multiple watchers per principal are each a connection; the spec does not dedupe them (that is lane A's watcher dedupe), it only makes each one cheap.

The refused-frame defect fixed on 2026-09-06 (a second-recipient row exits the watcher with code 1 and never advances the cursor) is orthogonal, but the watcher lane must land after that fix so the new subscriber is not built on a guard that dies.

### 4.2 The Claude hook

Unchanged. It is not a timer, it is a per-prompt read behind a 30 s cooldown (`hook.ts:57`, `:1010-1022`), under 1 % of traffic.

### 4.3 The app (`site/src/components/app/LiveDashboard.astro`)

The 2 s feed refresh (`:5774`) becomes: subscribe to W2 on workspace open with the human's Supabase `access_token`, exactly as the activity channel does (`site/src/lib/commonswarm.ts:176-209`); on `signal` fetch the page from the cursor; reconcile every 30 s while subscribed; fall back to the 2 s poll when not subscribed. The 4 s pending-access tick, the brain 30 s staleness gate, and the 5-minute build check are unchanged. A tab costs one connection; it already costs one for activity; the two channels share the socket (100 channels per connection).

---

## 5. Indexes and query plans for the hot paths (measured on the local database)

Measured on the local Supabase stack at the current migration set (`local-plans.sql` → `local-plans.out`). The local tables are near-empty, so the numbers are plan shapes, not timings; the retention lane repeats them on a reset with a synthetic 2M-row load before it lands, per the ask.

| path | plan | verdict |
|---|---|---|
| claim candidates (`durable-delivery.ts:272-300`) | `Index Scan using signal_deliveries_unacked_oldest` with `Index Cond (recipient, workspace)`, `Filter (acked_at IS NULL, lease_id IS NULL, attempt_count < 10)`, `LockRows`, `Limit`; 0.25 ms, 2 buffers | correct index; the filter columns are not in the index but the partial index already excludes acked rows, and unacked-unleased rows per principal are few by construction. **No change.** |
| wake trigger lookup (new) | needs `(principal_id, wake_key)` on `swarm.agent_tokens`; the policy function does the same lookup once per join | **add** `agent_tokens_wake_key (principal_id, wake_key) WHERE revoked_at IS NULL` in the wake migration |
| idempotency purge | `Index Scan using idem_purge` | fine |
| audit purge | full walk of `audit_by_cred` on `occurred_at` (second column) | DELETE is forbidden anyway (§3.2); no index added; the write stops instead |
| `rate_buckets` upsert | PK `(bucket_key, window_start)` | fine; purge cron exists |
| `swarm.file_versions` 2.8 M seq scans (ledger) | six indexes exist (`local-plans.out`); a missing index does not explain it | **out of this spec's scope**; lane A owns it, and the fix is an EXPLAIN on the offending query, not an index added blind |
| `realtime.messages` insert by trigger | one insert per delivery row into the day partition | write amplification ×2 on the signal path; at 1,716 signals/day it is noise; at §7's 10,000-seat load it is still under the delivery insert cost |

---

## 6. Apply order in lanes, with file ownership

Hard constraint (CodexDesktop, client pass points 1–2; CSwarmDevLead relay): `CLIENT_PROTOCOL_VERSION` is frozen at `0.1.0` (`src/cloud/config.ts:3`), the read capability handshake is a fixed four-bit set whose parser drops unknown bits (`src/cloud/signals.ts:125-132`, `:294-310`), and the only server→client control is `min_client_version`, which can only refuse. **The server cannot identify or negotiate with a 0.1.56 client. Every push step is additive on the server and requires a client release to take effect.** The order below is built for that: server first, additive only; client last; nothing removes the claim path.

| lane | branch | owner (subagent family) | files it owns | depends on | its tests | 0.1.56 keeps working because |
|---|---|---|---|---|---|---|
| **L0** lane A (already assigned) | `lane/idle-cost` | Grok | `runtime.ts:77`, `activity.ts:13`, read+claim merge, `idempotency_retention_days`, watcher dedupe | — | its own | it is a client release plus one config row |
| **L1** empty-claim persistence | `lane/claim-persistence` | Codex (from 2026-09-06 21:38Z) or Grok | `supabase/functions/command/index.ts:8348-8445` only | — (if lane A has not taken §3.1) | `tests/p1-server/claim-empty-persists-nothing.test.ts`: empty claim → 0 audit, 0 idempotency rows; non-empty claim → both; retried empty `command_id` re-executes and returns the current ledger | invisible to clients: same response shape |
| **L2** wake migration | `lane/wake-migration` | Codex or Gemini | new `supabase/migrations/2026MMDD000001_wake_delivery.sql`: `agent_tokens.wake_key`, index, `wake_topic_authorized()`, both triggers, both `realtime.messages` policies | — | `tests/p1-local/wake-realtime-auth.test.ts` (template: `tests/p1-local/activity-realtime-auth.test.ts`): policy admits the live key, refuses a revoked one, refuses a wrong topic; trigger inserts a `realtime.messages` row per delivery; trigger swallows a send failure | additive schema; no client reads it |
| **L3** wake in responses | `lane/wake-command` | Codex or Grok | `command/index.ts` mint/renew/claim response builders; `_shared/` types; `src/protocol` if the response schema is shared | L2 | `tests/p1-server/wake-topic-in-responses.test.ts`; existing response tests unchanged | optional field; 0.1.56 ignores it |
| **L4** listener client | `lane/wake-client` | Codex | new `src/listener/wake.ts`; `src/listener/runtime.ts` idle path; `src/listener/control.ts` status; `src/listener/read-health.ts` cadence semantics; `src/cli.ts` wiring; `package.json` (`@supabase/realtime-js` direct); `tests/listener-*.test.ts` | L3 contract (developed against a fake Realtime server) | fake-socket tests for every row of §2.4; a **live control** with `--state-dir <temp>` against the local stack pasting status JSON with `mode: "push"` | this *is* the release; until it lands, seats poll |
| **L5** watcher | `lane/wake-watcher` | Gemini | `src/cloud/arrival-watch.ts`; `src/cli.ts` notify wiring; `tests/support/arrival-watch.test.ts` | L4's module; the refused-frame fix | wake → one read → cursor advance; poll fallback when not subscribed | same |
| **L6** app | `lane/wake-site` | Gemini | `site/src/components/app/LiveDashboard.astro` feed refresh; `site/src/lib/commonswarm.ts`; site tests | L2 (W2 policy) | site observer: no 2 s poll while subscribed; poll resumes on `CHANNEL_ERROR` | site-only deploy |
| **L7** measurement | `lane/wake-measure` | Grok | `scripts/measure-idle-cost.sh`; `docs/evidence/2026-09-xx-push-delivery-measured/` | L4 | §8's plan, run before and after | — |
| **L8** docs | `lane/wake-docs` | any | `docs/design/SWARM-CLOUD.md` §2.13 addendum, §2.2 persistence rule; `AGENTS.md` one trap ("push is a hint; claim is the truth; a status that says push must be subscribed now") | L4 | — | — |

Order: **L0 and L1 now** (independent). **L2 → L3 → L4**. **L5 and L6 in parallel after L4** (L6 needs only L2, so it may start earlier). **L7 after L4**, before "released". **L8 with the release.** Each lane carries its two D-036 arms on its own SHA. Production apply order per lane: migration → `command` edge → `read` edge → client, as `20260905000020:36-38` already states; L2's migration is applied before L3's edge deploy, and L3 is deployed before L4 is published to npm.

Rollback: every server step is additive. Dropping the two triggers stops wakes; listeners fall to the 15 s poll on their own (the socket stays subscribed but silent, the reconcile catches everything). Dropping the policies refuses joins; listeners poll. No step needs a client rollback to undo.

---

## 7. Capacity: what breaks at 100, 1,000, 10,000 seats

Assumptions: Pro plan; one listener per seat; one `inbox --notify` per seat on half the seats; humans' tabs ignored below 10 per workspace; signals per seat-day ≈ 100 (today's fleet posts 1,716/day over 16 seats, so this is generous); activity heartbeat 60 s after lane A; reconcile 5 min.

| seats | Realtime connections | Realtime messages/day | edge invocations/day | rows/day surviving | what breaks first |
|---|---|---|---|---|---|
| 16 (today) | 24 | ≈ 3,500 (1,716 signals × (1 sent + 1 received) + heartbeat frames, unbilled) | ≈ 30,000 (vs 861,000) | 0 (vs 770,000) | nothing; inside the 2 M included |
| 100 | 150 | ≈ 20,000 | ≈ 190,000 (5.7 M/month, ≈ $7 over the 2 M included) | 0 | nothing; 500 connections included |
| 1,000 | 1,500 | ≈ 200,000 | ≈ 1.9 M/day (57 M/month ≈ $110) | 0 | **peak connections**: 1,500 > 500 → $10 per extra 1,000 (≈ $10); the activity heartbeat is now 76 % of edge spend → move it to Realtime presence (§9, not this spec) |
| 10,000 | 15,000 | ≈ 2 M | ≈ 19 M/day (570 M/month ≈ $1,140) with heartbeat on the edge; ≈ 4 M/day (≈ $240) with heartbeat on presence and reconcile at 15 min | 0 | **connection cap**: Pro no-spend-cap and Team stop at 10,000; needs Enterprise or one connection per host rather than per seat. Joins on a restart: 15,000 at 500–2,500/s ⇒ 6–30 s of `too_many_joins`, covered by the poll. Postgres: the per-principal `FOR UPDATE` on `agent_principals` (`durable-delivery.ts:182-188`) serializes claims per principal only, and the trigger adds one `realtime.messages` insert per delivery |

Per idle seat per day after this spec, with lane A's constants: reconcile claims 288 + activity 1,440 + renewals 24 + wake-driven claims ≈ 100 + drains ≈ 50 ⇒ **≈ 1,900 invocations** (from ≈ 53,800: −96.5 %). At $2 per million that is $0.004 per seat-day. The remaining 76 % is the activity heartbeat; it is the next thing to move, and it is out of scope here.

Bounds that hold at every size: the wake payload is under 200 bytes (limit 3,000 KB); the policy lookup is one indexed row per join, not per message (policies are cached per connection); Realtime authorizes a broadcast once per topic, not per subscriber, unlike Postgres Changes, which is why W1 is broadcast and not `postgres_changes`.

---

## 8. Stage 3 — measurement plan

Before/after, same host, same seat, a **live listener started with `--state-dir <temp>`** against the local stack with `supabase functions serve` counting requests per edge in its log, and once against production over 10 minutes with the dashboard's per-function invocation counter read before and after.

| metric | before (predicted) | before (measured by L7) | after (predicted) | after (measured by L7) |
|---|---|---|---|---|
| invocations per idle listener per 10 min | read 167 + claim 167 + activity 40 = **374** | | reconcile 2 + activity 10 + 0 reads = **12** | |
| surviving rows per idle 10 min | 167 audit + 167 idempotency = **334** | | **0** | |
| wake latency: `post_signal` accepted → claim leased, directed ask from another principal, 20 trials | mean 1.8 s, max 3.6 s | | mean < 0.5 s, max 1.0 s (local experiment observed sub-second) | |
| latency with Realtime down (container stopped) | as before | | ≤ 15 s + detection ≤ 25 s | |
| latency with a wake dropped (trigger disabled) | — | | ≤ 300 s | |
| status honesty | — | | `listen status` shows `mode: "push"` only while subscribed; stopping Realtime flips it to `poll` within 25 s | |

Predicted per-listener per-minute: **before 37.4, after 1.2.** The measured columns are filled by L7 and pasted into this section; the spec is not "done" until they are.

---

## 9. Stage 4 — what this spec does NOT settle

- **Cross-machine duplicate listeners.** Deferred by ruling. Two machines on one credential each subscribe and each claim; `SKIP LOCKED` keeps it safe and wasteful.
- **The activity heartbeat.** Still an edge call every 60 s after lane A; it becomes the dominant idle cost after this spec. Realtime presence on the wake socket is the obvious successor; not designed here.
- **Realtime billing of heartbeat frames.** The docs count broadcast, presence, and database-change messages; they do not say whether protocol heartbeats count. Predicted as unbilled; L7 reads the usage page to confirm.
- **Hosted project Realtime settings.** The "Allow public access" flag does not affect `private: true` topics, but the hosted project's Realtime limits and the `realtime.send` grant to `swarm_admin` are not in the repo; L2 verifies both on a linked `db query` before its migration is pushed.
- **A minted-JWT alternative.** Rejected for now (W5). If Supabase ever restricts `anon` on private channels, the fallback is an edge-minted asymmetric JWT via the project's signing keys.
- **The `file_versions` seq scans.** Lane A's.
- **Postgres Changes.** Not used, and not enabled: no table joins the `supabase_realtime` publication under this spec.
- **Presence-based "attended" display**, group self-wake on channels (`20260905000020` header), and the chat platform's channel fan-out are unchanged by this spec and stay where they are.

---

## 10. What was NOT established

- Production counts (390,277; 1.47 M; 2.8 M; 1,716) are the ledger's, read once by CSwarmDevLead via `supabase db query --linked`; not re-measured here.
- Whether the idempotency purge cron is enabled on the production project, as opposed to defined in the migration (CodexDesktop's caveat); one query for L2.
- Timings under load: the local plans are shapes on a near-empty database.
- The exact retention floor in `purge_expired_idempotency_keys()`.
- Realtime's behaviour when a topic's policy function raises (as opposed to returning false); L2 tests it.

## 11. Review record

Filled by the arms on the final SHA. Each arm's file lives in `docs/evidence/2026-09-06-push-delivery-spec/arms/<sha>/<family>.txt` and ends with a `VERDICT:` line and a quote-back of this document's first heading. Consensus means every available family ends `VERDICT: PASS` with reasoning and no unresolved finding.

| arm | SHA | verdict | file |
|---|---|---|---|
| Grok | | | |
| Gemini (`agy`) | | | |
| Opus (`claude -p`, operator-allowed) | | | |
| Codex (credits return 2026-09-06 21:38Z) | | | |

## Sources

- Brain topics `edge-function-invocations-2026-09` (Finisher), `operator-requests` (CSwarmDevLead), `false-success-signals`.
- `docs/org/2026-08-29-RESUME-HERE.md:2277-2302` (ledger, `f59cf7d`, `d500973`).
- Evidence directory of this spec, including the two CodexDesktop passes (signals `c650a8c7`, `327e7bc3`) and the CSwarmDevLead relay (`8fb993de`).
- Supabase docs: Realtime broadcast (`realtime.send`, private channels, 3-day partitions), authorization (policy caching, `access_token` refresh), limits (connections, messages/s, joins/s, payload), pricing (2 M / 5 M included; $2 per million invocations; $2.50 per million messages; $10 per 1,000 peak connections), Postgres Changes (per-subscriber authorization, "use Broadcast above ~3,000 subscribers"), Edge Function limits (150 s idle, 2 s CPU), JWT signing keys.
