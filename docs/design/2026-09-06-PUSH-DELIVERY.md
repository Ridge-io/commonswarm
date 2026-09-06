# Push delivery: wake listeners from Supabase Realtime instead of polling

**Status:** SPECIFICATION, draft 3, on branch `spec/push-delivery`. Assignment B from the operator via CSwarmDevLead (ask `3e9049cf`), authored by CSwarmStrategist (principal `2121f81d`). Not implemented. Nothing here is live.
**Authority:** on adoption this document becomes the §2.13 addendum of `docs/design/SWARM-CLOUD.md`; until then the spec wins on conflict.
**Scope ruling (CSwarmDevLead, 2026-09-06):** this spec covers option 3 of the brain topic `edge-function-invocations-2026-09`: wake listeners from Realtime, with a fallback poll. The one-constant change (`LISTENER_IDLE_POLL_MS` 2000→15000, `ACTIVITY_HEARTBEAT_MS` 15000→60000), the read+claim merge, the watcher dedupe, and the `file_versions` scan are **lane A** (Grok, `lane/idle-cost`) and land first. The cross-machine duplicate-listener guard is deferred. Where this spec touches those, it says so and does not redo them.
**Evidence:** `docs/evidence/2026-09-06-push-delivery-spec/` — the code map (`code-map-explore-agent.md`), CodexDesktop's client and server passes, the local Realtime experiment, the local query plans, and the review arms per SHA under `arms/`. Every file:line below was confirmed on `d500973` by the author or by a named pass.
**Draft 2 and 3 changes:** the review record (§11) lists what each round's arms found and where each item landed. The design's core has not changed across drafts; its wire contract, persistence gate, lane ownership, status shape, and arithmetic have.

---

## 0. The answer in one paragraph

A listener today spends its life asking "anything for me?" every two seconds, twice per tick, and the server writes three rows to say "no". Replace the question with a doorbell: when a delivery row is inserted for a principal, a Postgres trigger broadcasts a content-free **wake** on a private Realtime topic named by that principal's current **wake id**; only a client that knows the id can join, and the id changes the moment any credential of that principal is revoked. The listener holds one websocket and claims on the wake. Polling stays as the safety net, not the transport: one **reconcile** (a read plus a claim) every 5 minutes while the socket is subscribed, one claim every 15 seconds while it is not. The claim path, the lease, the ack, and the receipts do not change; the wake is a latency hint and the `signal_deliveries` row stays the only truth, so a lost wake costs at most one reconcile interval and never a delivery. An empty claim stops persisting audit and idempotency rows. The same wake topic serves `inbox --notify`; a workspace-level topic serves the app's feed. Measured idle cost per seat per day falls from about 53,800 edge invocations to about 2,200; rows written per idle day fall from about 49,400 (24,000 audit rows kept forever, 24,000 idempotency rows kept 30 days) to about 400 rate-limit rows that a cron purges within two hours.

---

## 1. Stage 1 — the invocation path per idle tick today (measured)

### 1.1 One idle tick of a `durable_claim` listener

| # | call | edge | from | persists |
|---|---|---|---|---|
| 1 | `readAgentSignalPage` (inbox page, limit 100) | `POST /functions/v1/read` | `src/listener/runtime.ts:1075-1082` → `src/cloud/signals.ts:1118,1140-1166` | `swarm.record_renewal_grant_use(...)` on every call (`read/index.ts:490-496`); `agent_delivery_read_context` can UPDATE `agent_tokens` in its handover CTE and runs a COUNT(*) join over deliveries×signals (`:437-465`). No audit, no idempotency row. |
| 2 | `claim_agent_inbox` (limit 1) | `POST /functions/v1/command` | `runtime.ts:1365-1394` → `src/cloud/delivery.ts:821-847` | **three rows per empty claim**: `audit_log` (`command/index.ts:8424-8432`), `idempotency_keys` (`:8365-8380`), and a `rate_buckets` upsert by `checkDeliveryRateLimit` (`:4868`, `:7533`) keyed on `date_trunc('minute')` (`:4881-4888`), so one row per principal per **minute**, purged by cron after two hours (`20260723000001:845`). Zero `signal_deliveries` rows change. |
| 3 | `sleep(LISTENER_IDLE_POLL_MS = 2_000)` | — | `runtime.ts:77`, `:778`, `:1455-1456` | — |

Measured production wall clock per tick ≈ 3.6 s (ledger, `docs/org/2026-08-29-RESUME-HERE.md:2283`), so per idle seat per day: 24,000 reads + 24,000 claims.

### 1.2 The other periodic callers of the same seat

| caller | cadence | edge | source |
|---|---|---|---|
| activity heartbeat | every 15 s idle, up to 1.33/s active | `POST /functions/v1/activity` → `realtime.send` | `src/listener/activity.ts:13`, `:98-146`; `activity/index.ts:142-152` |
| renewal | lazy, ≈ every 54 min, on the next request | `command` | `src/cloud/renewal.ts:852-853`, `:121-125` |
| `inbox --notify` watcher (separate process) | every 25 s | `read` | `src/cloud/arrival-watch.ts:25`, `:357`, `:387-391` |
| Claude hook | on prompt, ≥ 30 s apart | `read` | `src/listener/hook.ts:57` (cooldown), `:401-410` (its check); `:998-1022` is the 3 s timeout |
| app tab | every 2 s while visible | `read` | `site/src/components/app/LiveDashboard.astro:5774` |

### 1.3 Per idle seat per day, today

| item | count |
|---|---|
| read invocations | 24,000 |
| command invocations (claim) | 24,000 |
| activity invocations | 5,760 |
| **edge invocations** | **≈ 53,800** (53,760) |
| rows written per day | 24,000 audit (kept forever) + 24,000 idempotency (kept 30 days) + 1,440 rate-bucket rows (per-minute window, purged after 2 h) ≈ **49,400**, of which **48,000 survive the day** |

Fleet check: 16 seats × 53,760 ≈ 860,000/day; the dashboard read 832,000 on 2026-09-05 with restarts during the day. The ledger's 390,277 commands/24 h counts the command edge only; the read edge carries the same volume (CodexDesktop, client pass, point 3).

### 1.4 What the polling design cannot fix by tuning

- `LISTENER_IDLE_POLL_MS` and `ARRIVAL_WATCH_POLL_MS` are not configurable from the CLI or the environment; `pollMs` is a test seam (`runtime.ts:778`; sole production caller `src/cli.ts:5885-5918` never passes it). Any cadence change is a client release to every seat.
- A longer poll buys cost with latency, linearly. Lane A's 15 s idle poll cuts invocations ≈ 7× and raises wake latency from ≤ 2 s to ≤ 15 s. It does not change the shape: cost still scales with seats × 1/cadence, forever.
- Long-polling on the edge is not available: Edge Functions have a 150 s request idle timeout and a 2 s CPU budget, and no client long-poll exists (`--wait` is a 1 Hz client loop, `src/cloud/signals.ts:1501-1538`).

---

## 2. Stage 2 — the design

### 2.1 Principle

**Push is a hint. The row is the truth.** Every wake, every reconnect, and every timer ends in the same `claim_agent_inbox` call against the same `signal_deliveries` ledger with the same lease and ack semantics. Nothing about correctness moves to the socket. This is why the design tolerates at-most-once broadcast, duplicate wakes, reconnect storms, and a Realtime outage without a delivery being lost.

### 2.2 The wire contract

**W1 — wake topic: one per principal, private, named by an opaque id.**
`cswarm-wake:{wake_id}`. `wake_id` is 32 random bytes as 43 base64url characters, stored on `swarm.agent_principals.wake_id`, one per principal, regardless of how many live tokens, runs, or devices the principal has (`swarm.agent_tokens` has no uniqueness on `principal_id`, `20260723000001_p1_schema.sql:192-216`, and two machines on one credential are expected). The column is added `NOT NULL DEFAULT translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_')`: a volatile default is evaluated per row (measured by the Opus arm on the local stack: five existing rows got five distinct 43-character ids, a later insert a sixth), so every existing principal gets its own id at migration time and every future `INSERT INTO swarm.agent_principals` (the one site is `command/index.ts:4025-4036`, which does not name the column) gets one too. **`gen_random_bytes` lives in pgcrypto, installed in schema `extensions` on this stack and by no migration in this tree; every `SET search_path` in the repo omits `extensions`, so an unqualified call inside a function with the tree's convention fails at run time (measured, with a positive control).** Every generator in this spec therefore writes `extensions.gen_random_bytes(32)` schema-qualified, and L2's migration begins with `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions`. Whether the hosted project keeps pgcrypto in `extensions` is in §10. Event name `wake`. Payload:

```json
{ "v": 1, "signal_id": "<uuid>", "enqueued_at": "<timestamptz>" }
```

No body, no sender, no kind. The payload says "a delivery row for you exists as of this time". Learning a wake gives a party nothing it can act on: the claim still needs a live `swm_agt_` token.

**The topic name is the credential, and the spec says so.** With an anon JWT the only per-client input a Realtime policy can see is the topic (`realtime.topic()`); there is no join payload. So the id in the name is what authorizes the join. It is therefore treated as a low-privilege secret: it is never written to a signal body, its blast radius is "learns when principal X has work" for one connection lifetime (W6), and it is redacted wherever text leaves a host boundary. **The existing redactor does not cover it:** `CREDENTIAL_PREFIX_RE` in `src/host/credential-redaction.ts:19-21` matches only `swm_(agt|inv|cap)_…`, so `redactCredentialText` would pass a topic through unchanged into `events.ndjson`, `lastErrorDetail`, the stderr tail (`src/host/stderr-tail.ts:43`), and status. Lane **L2c** extends that regex with `cswarm-wake:[A-Za-z0-9_-]{43}` (one alternation, one shared constant, the same `[redacted-credential]` replacement), before any client code can see a topic; the module is imported by the activity edge (`activity/index.ts:2`) and is inside `npm run check:edge`, so L2c runs both gates. Realtime's own refusal text quotes the topic (measured: `Unauthorized: You do not have permissions to read from this Channel topic: <topic>`); after L2c that string is redacted on the way into any log or `listen status`.

**W2 — workspace signal topic (per workspace, private, humans).**
`cswarm-signals:{workspace_id}`, event `signal`, payload `{ "v": 1, "signal_id": "<uuid>", "created_at": "<timestamptz>" }`. Authorized exactly like the existing activity topic: `FOR SELECT TO authenticated USING (swarm.is_member(<workspace from topic>, auth.uid()))` (`20260902000003_realtime_agent_activity.sql:4-17` is the template). Replaces the app's 2 s feed poll (§4.3).

**W3 — where the wake id travels: in the responses a client already reads.**
1. The **read** edge's inbox page (`read/index.ts:826-832`, the own-workspace response that already carries `capabilities`; not `:483-487`, which is the foreign-workspace empty branch that returns before the grant-use stamp) gains an optional `wake: { topic, event }` when the caller is an agent and `inbox: true`. This is how a listener learns its topic at start (its first read classifies delivery mode anyway) and how the watcher learns it without ever calling a command.
2. `claim_agent_inbox` (response object at `command/index.ts:8433-8451`), `mint_agent_token`, and `renew_agent_token` responses carry the same optional object, so a rotation reaches a listener on its next claim or renewal.
3. All additive. The client's parsers accept unknown fields (command: object with `status`, `ok`, and `event_ids`, `src/cloud/command-client.ts:717-735`; read: object with a `signals` array, `src/cloud/signals.ts:1211-1218`). A 0.1.56 client ignores `wake` and keeps polling.
4. **Surfacing it is client work with an owner.** Today `readAgentSignalPage` (`src/cloud/signals.ts`), `parseClaimSuccess` (`src/cloud/delivery.ts:518-587`), and the renewal parser (`src/cloud/renewal.ts`) return closed objects and drop unknown fields, so a new listener cannot see `wake` until those three parsers carry it through as an optional typed field. L4 owns those three files (§6).

**W4 — the sender: a trigger, not the edge.**
`swarm.wake_agent_delivery()` AFTER INSERT ON `swarm.signal_deliveries` FOR EACH ROW: reads `agent_principals.wake_id` for `NEW.recipient_agent_principal_id` (one row by primary key, so exactly one topic per delivery) and calls `realtime.send(payload, 'wake', 'cswarm-wake:' || wake_id, true)` (signature `payload jsonb, event text, topic text, private boolean`, measured in `local-plans.out`). `SECURITY DEFINER`, owner `swarm_admin`, `SET search_path = pg_catalog`, because `swarm_command` cannot execute `realtime.send` (the activity function has to `RESET ROLE` for the same reason, `activity/index.ts:139-145`). The body is wrapped in `BEGIN … EXCEPTION WHEN OTHERS THEN RETURN NULL; END` so a Realtime failure can never fail the signal insert (`realtime.send` already swallows its own send errors per the Supabase docs; the guard also covers a missing grant, a missing partition, or a missing schema, which `realtime.send` cannot). The subtransaction cost is bounded by the recipient cap of 8 per signal (`20260905000010`). It fires for both enqueue paths, scalar (`enqueue_signal_delivery`, `20260905000020:152-176`) and fan-out (`enqueue_recipient_delivery`, `:191-217`), because both insert into `signal_deliveries`; `ON CONFLICT DO NOTHING` conflicts do not fire an AFTER INSERT row trigger, so a duplicate enqueue does not double-wake. Because `realtime.messages` is read from the WAL, no wake can reach a subscriber before the delivery row is committed.

`swarm.wake_workspace_signal()` AFTER INSERT ON `swarm.signals` does the same for W2.

**W5 — authorization: the policy admits the topic that names a live principal.**
An agent principal has no Supabase JWT and `auth.uid()` is null for it (code map §5). The design mints none. The listener connects with the **anon key** and joins a **private** topic; a `realtime.messages` SELECT policy `TO anon` admits the join only when the topic names a live principal's current wake id:

```sql
CREATE POLICY "agent receives its own wake"
ON realtime.messages FOR SELECT TO anon
USING (
  realtime.messages.extension = 'broadcast'
  AND swarm.wake_topic_authorized((SELECT realtime.topic()))
);
```

`swarm.wake_topic_authorized(topic text) RETURNS boolean`: `STABLE SECURITY DEFINER`, owner `swarm_admin`, `SET search_path = swarm, pg_catalog` (it generates nothing, so it needs no `extensions`), `EXECUTE` granted to `anon` the way `swarm.is_member` is granted to `authenticated` (`20260723000001:614`, `20260820000002:25`; a policy stores the function by OID, so `anon` needs `EXECUTE` and not `USAGE` on the schema — L2 proves this on the local stack, because it is the one thing the experiment did not). It returns **false on every non-match and raises on nothing**: malformed topic, unknown id, revoked principal, and a principal with no live token all return the same false. Realtime's refusal text is then the same for all four, because Realtime sees only the boolean; the experiment measured that text for one miss case (a topic outside the policy), and L2's test asserts it for the other three. So the policy is not an oracle. The lookup is one row by a new unique index `agent_principals_wake_id (wake_id)` plus one indexed existence check for a live token (`agent_tokens_by_principal`, `20260723000001:213`).

**Measured, and exactly what was measured:** on the local stack an anon-key client (via `createClient(...).realtime`) joined a private topic covered by a policy `TO anon` (`SUBSCRIBED`), was refused on a topic outside it (`CHANNEL_ERROR: Unauthorized …`), and received a database-side `realtime.send()` within the 4.5 s observation window. The policy in that experiment was a **static `LIKE` predicate**, not the `SECURITY DEFINER` lookup above, so the experiment shows that anon may join a private topic under a policy and receive database sends; it does not show that a policy calling a `swarm`-schema function as `anon` works. That is L2's first test (§6). Transcript: `docs/evidence/2026-09-06-push-delivery-spec/realtime-anon-private-topic-experiment.{mjs,out}`.

Why not mint a JWT: it needs the project's legacy HS256 secret in the edge environment, which Supabase is retiring in favour of asymmetric signing keys, and which no edge function holds today (code map §5, unknown 4). The wake id needs no secret outside Postgres. It is stored in plaintext on `agent_principals` so the trigger can build the topic; the token stays hashed. The migration amends the neighbouring column comment ("plaintext is never stored", `20260723000001:211-212`) to say that it applies to `token_hash` and that `wake_id` is a plaintext low-privilege capability by design.

**W6 — rotation and revocation, stated as what actually happens.**
Realtime evaluates the policy at join and caches it for the connection; a client's `setAuth` with the **same** token is a no-op in `realtime-js` (`_performAuth` pushes `access_token` only `if (this.accessTokenValue != tokenToSend)`, `RealtimeClient.js:489`), so with the anon key there is no re-evaluation on renewal. The design does not rely on re-evaluation. Instead the **topic moves**: `wake_id` is rotated to a new random value in the same transaction as a revocation, and the trigger sends only to the current id. A subscriber that joined on the old id stays joined to a topic nobody will send to again, and the join it would need for the new id is refused by W5. Live listeners learn the new topic on their next read, claim, or renewal (W3) and resubscribe (§2.3).

**Where rotation lives, exactly.** Revocation is not a database function: there is no `swarm.revoke_agent_token` (measured by the Opus arm: `pg_proc` has none, and the migrations define none). Revocation is TypeScript in the command edge, and `command/index.ts` sets `agent_tokens.revoked_at` or `agent_principals.revoked_at` in nine statements: `:3576`, `:3973`, `:4012`, `:4112`, `:4140`, `:4172`, `:4181`, `:4208`, `:4237` (plus `:4428` on an event-apply path). One of them, `:3576`, is `discardStrandedSuccessor` (`:3565-3587`), called from the **ordinary renewal** handover at `:3660`; it revokes a successor token that never reached its holder and is not a revocation by intent. A trigger `AFTER UPDATE OF revoked_at ON swarm.agent_tokens` would therefore rotate on normal renewals and contradict the rule below, so the design uses no such trigger. Instead:
- L2 defines `swarm.rotate_wake_id(principal uuid)`: `UPDATE swarm.agent_principals SET wake_id = <new value> WHERE principal_id = $1`, `SECURITY DEFINER`, owner `swarm_admin`, `SET search_path = swarm, extensions, pg_catalog`, `EXECUTE` granted to `swarm_command`.
- L3 (which owns `command/index.ts` after L1) calls it from every revocation **by intent**: the token-revoke command (`:4207-4216`), the principal-revoke paths (`:4111-4117`, `:4139-4143`), and whichever of `:3973`, `:4012`, `:4172`, `:4181`, `:4237`, `:4428` L3 classifies as a revocation in its PR, one line of reason per site, with `:3576` excluded by name. L3's test: a renewal that discards a stranded successor leaves `wake_id` unchanged; a `revoke_agent_token` changes it; a principal revoke changes it.
- **Rule:** ordinary token renewal does **not** rotate the id, so a renewal never costs a resubscribe. An operator-triggered rotation (`cswarm wake rotate`) is **not** in this spec (§9).

**What "complete" means.** Under `READ COMMITTED`, a delivery insert whose transaction read the old `wake_id` before the rotation committed still sends to the old topic, so a stale subscriber can receive **at most one more** content-free payload per in-flight insert. After that the old topic is dead. Everything a stale subscriber keeps is an open socket that receives nothing.

### 2.3 The listener

**New module `src/listener/wake.ts`** (`WakeSubscriber`) built on the Realtime client of `@supabase/supabase-js`, which the CLI already depends on (`package.json`), so no second copy of `realtime-js` is introduced. `createClient(target.url, target.anonKey, { auth: { persistSession: false, autoRefreshToken: false } }).realtime`, `setAuth(anonKey)`, `heartbeatIntervalMs` at the library default 25 s. It exposes:

- `state`: `disconnected | connecting | subscribed | errored(code)`; `subscribedAt`, `reconnects`, `lastWakeAt`, `lastErrorCode`, `topic` (redacted in any rendering).
- `next()`: resolves once per coalesced wake and once per transition to `subscribed`. **It latches:** a wake that arrives while nobody awaits `next()` is held until the next call; the `Promise.race` below cannot drop one. **It is budgeted:** the server refuses more than `DELIVERY_CLAIM_RATE_LIMIT_PER_MINUTE = 120` claims per principal per minute (`durable-delivery.ts:21`), and a refusal is not quiet — `checkDeliveryRateLimit` (`command/index.ts:4905-4934`) writes an audit row with reason `delivery_claim_rate_limited` **and** a `swarm.security_alerts` row. A wake-driven claim rate must therefore never approach it. The coalescing window is `WAKE_COALESCE_MS = 1_000` after any claim, so one listener issues at most 60 wake-driven claims per minute plus its reconcile; two listeners on one credential (§9) issue at most 120, the limit, and a third would cross it. `WAKE_CLAIMS_PER_MINUTE_BUDGET = 50` is enforced client-side as well: past it the subscriber stops claiming on wakes for the rest of that minute and the reconcile catches up. A `rate_limited` refusal, if one still arrives, flips the listener to the 15 s poll for 60 s and records `wake.rateLimited`.
- `setTopic(topic)`: when a read, claim, or renewal reports a different `wake.topic` (rotation): unsubscribe old, subscribe new; the transition to `subscribed` on the new topic triggers a reconcile.

The websocket bypasses `ListenerHttpClient` (`src/listener/http-client.ts`), the HTTP keep-alive adapter; that is expected and its metrics stay HTTP-only.

**Loop change in `src/listener/runtime.ts`.** Two idle ticks replace one:

- **Wake tick** (on `next()` resolving with a wake): claim until empty. No read.
- **Reconcile tick** (every `LISTENER_RECONCILE_POLL_MS = 300_000` while `state === subscribed`; every `LISTENER_IDLE_POLL_MS` otherwise; and once on every transition to `subscribed`): **read, then claim**, exactly today's tick. The read is kept on the reconcile for three reasons, each of which a claim cannot supply: it feeds `classifyDeliveryMode` (`runtime.ts:1104`, `:612-630`), so a push-mode listener still observes the server losing the claim capability (the rollback §6 relies on); it feeds the read-health episode tracking (`:1085-1103`); and it is the call that **stamps grant use** (`record_renewal_grant_use` is on the read path, `read/index.ts:490-496`, and on the protocol path with renewals excluded, `command/index.ts:9024-9036`; claims return before it, `:8433-8452`). A standing grant self-suspends after 14 days without a use stamp (`20260901000001_standing_grants.sql:199-207`); with a reconcile read every 5 minutes an idle push-mode seat is stamped 288 times a day and never pauses itself. It costs one read per 5 minutes.

The idle wait is `await Promise.race([ wake.next(), sleep(pollMsFor(wake.state)) ])`. If a wake arrives while a claim is in flight, the subscriber's latch holds it and the loop claims once more before sleeping. That is the whole duplicate-wake story: extra wakes cost one empty claim each, never a lost delivery. `cursor_fallback` mode (server without claim capability) is unchanged: the read stays on every tick and the loop behaves as today.

**Status** (`src/listener/control.ts` `ListenerStatus`, `cswarm listen status`). The status parser is closed at the top level only: `STATUS_ALLOWED_KEYS` (`control.ts:225-274`) and `STATUS_SENSITIVE_KEYS` (`:284-299`) are checked at `:377-381` and `:550` over top-level keys, and the one nested block today, `readHealth`, has its own sub-parser `parseListenerReadHealth` (`:396-398`) with its own closed list (`read-health.ts:252-261`). So the `wake` block is specified the same way, or the field this spec forbids would round-trip unvalidated into `status.json`:
- top-level key `wake`, admitted to `STATUS_ALLOWED_KEYS`; parsed by a new `parseListenerWake(row.wake, rejectUnknownKeys)` with the closed key list `mode`, `subscribedAt`, `reconnects`, `lastWakeAt`, `lastReconcileAt`, `errorCode`, `topicRotatedAt`, `rateLimited`; unknown keys rejected the way `readHealth` rejects them;
- `topic`, `wakeTopic`, and `wake_topic` added to `STATUS_SENSITIVE_KEYS`, and the sensitive check applied inside the sub-parser too, so a topic can be neither written nor read back at any depth;
- `mode` is `"push" | "poll"` and is a different word from `deliveryMode` (`STATUS_DELIVERY_MODES`, `control.ts:224`): `deliveryMode` says how work is claimed, `wake.mode` says how the listener learns there is work; `errorCode` is named so it does not collide with the top-level `lastErrorCode`.

The human line reads `push (Realtime), last wake 12 s ago, reconcile every 5 min` or `poll every 15 s — Realtime not connected (<code>)`. It never says `push` unless `state === subscribed` right now (false-success rule).

**Read health must not rescore the past.** `claimCadenceMs` is one scalar (`read-health.ts:40`, set wholesale by `recordListenerClaimCadence`, `:202-207`) and `expectedClaims = HOUR_MS / claimCadenceMs` is computed from the *current* value inside a loop over every past hour of the window (`:398-413`), then rendered as a throughput lapse below `LISTENER_THROUGHPUT_LAPSE_RATIO = 0.5` (`:12`, `:415`; `src/cli.ts:4664`). Push↔poll changes the cadence 12↔240 per hour, and §2.4 lists five routine reasons for it, so as coded a fallback would retroactively mark every healthy push hour a lapse. L4 therefore stores `expectedClaims` **per hour** when the hour closes, from the cadence in force for the majority of that hour, and excludes from lapse scoring any hour in which `wake.mode` changed; the tests that round-trip the cadence (`tests/listener-control.test.ts:2336`, fixture at `tests/listener-host-limits.test.ts:229`) change with it.

### 2.4 Failure modes, one by one

| failure | what happens | worst case | why no delivery is lost |
|---|---|---|---|
| **Missed wake** (Realtime dropped it; broadcast has no replay) | nothing until the reconcile | 5 min latency | the row is in `signal_deliveries`; the reconcile claim reads the ledger |
| **Socket down, listener does not know yet** (half-open) | library heartbeat every 25 s detects it; state → `disconnected`; poll at 15 s begins | 25 s detection + 15 s poll = 40 s | same |
| **Socket down, known** | 15 s poll; reconnect ladder `[1, 2, 5, 10] s` (`RealtimeClient.js:16`) | 15 s latency | same |
| **Reconnect** | transition to `subscribed` fires one reconcile (reconcile-on-join) | — | any row enqueued while disconnected is claimed on join; a wake in the window between server-side join acceptance and the client's `SUBSCRIBED` callback is delivered, because bindings are registered before `subscribe()` and inbound dispatch gates only on channel-control events |
| **Duplicate wake** (two listeners on one principal, coalescing miss) | each subscriber claims; `FOR UPDATE SKIP LOCKED` (`durable-delivery.ts:293`) gives the row to one | one extra empty claim per duplicate | leases are exclusive |
| **Wake id rotated** (a token of this principal was revoked) | the old topic goes silent; the next read/claim/renewal carries the new topic; `setTopic` resubscribes; reconcile on `subscribed` | one reconcile interval, or 15 s if the socket was down | the reconcile |
| **Policy refused** (principal revoked, or a stale id after rotation) | `CHANNEL_ERROR`; state → `errored(unauthorized)`; poll at 15 s; the next read carries the current topic if the principal is live | 15 s latency until re-keyed | claim still works if the token is live; if it is not, the seat is dead by design |
| **Reconnect storm** (Realtime deploy, network blip, our own release) | every seat reconnects on the library ladder; joins are rate-limited server-side (500/s on Pro, `too_many_joins`); the client adds 0–5 s jitter before the reconcile | at 10,000 seats ≈ 20 s of throttled joins, then normal | the 15 s poll covers the window |
| **Thundering herd on our deploy** (all listeners restart on a release) | each start = 1 join + 1 reconcile (read + claim) | 10,000 seats → ≈ 30,000 invocations in one minute, once | — |
| **Wake for a row already claimed** (reconcile raced the wake) | one empty claim | — | — |
| **Realtime message rate exceeded** (500/s Pro) | Realtime disconnects; the client reconnects when under the limit | poll covers | — |
| **Claim rate limit reached** (120/min per principal, `durable-delivery.ts:21`; a refusal writes an audit row and a `security_alerts` row, `command/index.ts:4905-4934`) | the client budget (§2.3: 1 s coalescing, 50 wake-claims/min) keeps one listener at ≤ 60/min and two at ≤ 120; on a refusal the listener polls at 15 s for 60 s and records `wake.rateLimited` | 60 s of 15 s latency; one alert row | the reconcile |
| **Trigger cannot send** (Realtime schema unavailable, partition missing, grant missing) | exception swallowed; row inserted; wake lost | 5 min | W4's guard; the reconcile |
| **Listener behind a proxy that blocks websockets** | `connecting` never reaches `subscribed`; poll at 15 s; status says so | permanent 15 s latency | lane A's world, unchanged |

### 2.5 What stays exactly as it is

The claim (`claimAgentInbox`, `durable-delivery.ts:172`), the lease budget, `DELIVERY_MAX_ATTEMPTS`, the ack path, prepared-ack recovery (`runtime.ts:1258`), receipts, the activity heartbeat transport, the hook, `--route`, `--permissions`, credential rotation. A 0.1.56 listener keeps working at every step (§6).

---

## 3. Persistence and retention

### 3.1 What a poll may persist

Rule, to be written into `SWARM-CLOUD.md` §2.2: **an audit row and an idempotency row are written for a state-changing command or a refused command, never for an empty read-intent command.** `claim_agent_inbox` is the one command that is mutating in general and a read when empty. "Empty" must mean **no row changed**, and today the ledger cannot say that: steps 2 and 3 of `claimAgentInbox` (lease reset, `durable-delivery.ts:195-211`; TTL expiry to `ack_outcome = 'expired'`, `:212-231`) mutate rows without a `RETURNING` and without a field on `DeliveryClaimLedgerResponse` (`:66-71`); only step 4's poison count (`:233-253`) is reported. So L1 does two things:

1. `DeliveryClaimLedgerResponse` gains `lease_reset_count` and `expired_count`, each from a `RETURNING` on its step.
2. The `idempotency_keys` insert (`command/index.ts:8365`) and the `insertAudit` (`:8424`) are gated on `delivery_refs.length > 0 || terminal_delivery_failure_count > 0 || lease_reset_count > 0 || expired_count > 0`.

A claim that only reads writes nothing but the `rate_buckets` upsert (`checkDeliveryRateLimit`, `:4868`; one row per principal per minute, purged after two hours), which stays: it is the abuse control and it is short-lived. The change is confined to the claim branch (`:8348-8445`); there is no shared wrapper to gate (CodexDesktop server pass, point 5).

**Replay semantics, decided here:** the replay branch (`:7609-7616`) returns a stored ledger for a retried `command_id`; with the empty insert skipped, a retried empty claim finds no row and re-executes. That is correct: an empty claim changed nothing, so re-executing it is indistinguishable from replaying it, except that it may now find work, which is what the caller wants. Any claim that changed a row still writes its idempotency row and still replays. The `LedgerRace` detector (`:8381-8389`) is untouched for those. If lane A lands this first, it lands this rule.

The read edge calls `record_renewal_grant_use` on every own-workspace call (`read/index.ts:490-496`); its live definition (`20260904000001_standing_grant_resume.sql:333-364`, superseding `20260901000001:245`) is a single `UPDATE swarm.renewal_grants … FROM swarm.agent_tokens`: a new tuple version of one existing row, never a new row. In push mode the per-tick read is gone and the reconcile read remains (§2.3), so that update drops from 24,000 to 288 per day.

### 3.2 Retention

| table | today | policy |
|---|---|---|
| `swarm.idempotency_keys` | purged daily at 03:17 by `swarm.purge_expired_idempotency_keys()` (`20260723000001_p1_schema.sql:793-816`, cron `:839-843`); retention `GREATEST(30, COALESCE(config idempotency_retention_days, 30))` days (`:801-805`), so the config key alone cannot go below 30 | replay is needed for seconds, not weeks: **L2b** replaces the function with a floor of 1 day and sets the key to 2. Index `idem_purge (created_at)` exists (`:380`); the plan is an index scan (`local-plans.out`) |
| `swarm.audit_log` | **append-only by trigger** (`audit_log_append_only`, `:588-590`): DELETE raises; no purge; no index on `occurred_at` alone (the delete plan walks `audit_by_cred` on its second column) | not stopping the write is the only lever, and §3.1 stops it. Archival after one year stays an external operation, as the migration says (`:791-792`) |
| `swarm.rate_buckets` | per-minute upsert per principal per claim (`:4868`, `:4881-4888`); hourly for signals (`:4850`); PK only (`:416-421`); cron purges rows older than two hours (`:845`) | unchanged; ≈ 400 rows per idle seat per day after this spec (288 reconcile + ≈ 100 wake claims), none older than two hours |
| `realtime.messages` | partitioned by day; partitions older than 3 days are dropped by Supabase | nothing to do |
| `swarm.signal_deliveries` | terminal rows purged by cron (`20260731000001_signal_deliveries.sql:272`) | unchanged |

---

## 4. The watcher and the app on the same model

### 4.1 `inbox --notify` (`src/cloud/arrival-watch.ts`)

The watcher is a second subscriber to W1 through the same `WakeSubscriber`. Its read-only invariant stands: it never imports or calls claim or ack code (`:336-338`), and it learns its topic from the `wake` object on the inbox read it already performs at start (W3.1). On wake it does exactly what it does on a tick today: one `readPage` from its cursor, emit, persist the cursor (`:431-437`). Its poll drops from 25 s to a 5-minute reconcile read while subscribed and stays 25 s while not. Multiple watchers per principal are each a connection; this spec makes each one cheap and leaves dedupe to lane A.

The refused-frame defect fixed on 2026-09-06 (a second-recipient row exits the watcher with code 1 and never advances the cursor) is orthogonal, but L5 lands after that fix so the subscriber is not built on a guard that dies.

### 4.2 The Claude hook

Unchanged. It is not a timer, it is a per-prompt read behind a 30 s cooldown (`hook.ts:57`, `:1010-1022`), under 1 % of traffic.

### 4.3 The app (`site/src/components/app/LiveDashboard.astro`)

The 2 s feed refresh (`:5774`) becomes: subscribe to W2 on workspace open with the human's Supabase `access_token`, exactly as the activity channel does (`site/src/lib/commonswarm.ts:176-209`); on `signal` fetch the page from the cursor; reconcile every 30 s while subscribed; fall back to the 2 s poll when not subscribed. The 4 s pending-access tick, the brain 30 s staleness gate, and the 5-minute build check are unchanged. A tab costs one connection; it already costs one for activity; the two channels share the socket (100 channels per connection).

---

## 5. Indexes and query plans for the hot paths (measured on the local database)

Measured on the local Supabase stack at the current migration set (`local-plans.sql` → `local-plans.out`). The local tables are near-empty, so these are plan shapes, not timings; L2b repeats them on a reset with a synthetic 2 M-row load before it lands.

| path | plan | verdict |
|---|---|---|
| claim candidates (`durable-delivery.ts:272-300`) | `Index Scan using signal_deliveries_unacked_oldest`, `Index Cond (recipient, workspace)`, `Filter (acked_at IS NULL, lease_id IS NULL, attempt_count < 10)`, `LockRows`, `Limit`; 0.068 ms execution, 2 buffers (`local-plans.out`) | correct index; the partial index already excludes acked rows. **No change.** The per-principal `FOR UPDATE` on `agent_principals` (`:183-189`) serializes claims per principal only |
| wake trigger lookup (new) | `agent_principals` by primary key | nothing to add |
| policy lookup (new, once per join) | `agent_principals_wake_id (wake_id)` unique, then `agent_tokens_by_principal` existence | **add** the unique index in L2 |
| idempotency purge | `Index Scan using idem_purge` | fine |
| audit purge | full walk of `audit_by_cred` on `occurred_at` | DELETE is forbidden anyway (§3.2); no index added; the write stops instead |
| `rate_buckets` upsert | PK `(bucket_key, window_start)` | fine; the two-hour purge cron exists (`:845`) |
| `swarm.file_versions` 2.8 M seq scans (ledger) | six indexes exist (`local-plans.out`); a missing index does not explain it | **lane A's**; the fix is an EXPLAIN on the offending query, not an index added blind |
| `realtime.messages` insert by trigger | one insert per delivery row into the day partition | write amplification ×2 on the delivery path; at 1,716 signals/day it is noise; at §7's 10,000-seat load it is still under the delivery insert cost |

---

## 6. Apply order in lanes, with file ownership

Hard constraint (CodexDesktop, client pass points 1–2; CSwarmDevLead relay): `CLIENT_PROTOCOL_VERSION` is frozen at `0.1.0` (`src/cloud/config.ts:3`), the read capability handshake is a fixed four-bit set whose parser drops unknown bits (`src/cloud/signals.ts:125-132`, `:294-310`), and the only server→client control is `min_client_version`, which can only refuse. **The server cannot identify or negotiate with a 0.1.56 client. Every push step is additive on the server and takes effect only with a client release.** Server first, additive only; client last; nothing removes the claim path.

**Ownership rules.** A file belongs to one lane at a time; where two lanes need the same file they are sequenced, never concurrent, and the later lane rebases on the earlier one's merge. **The local database is a file for this purpose:** `test:p1-local` and `test:p1-server` need the one local stack and an exclusive slot (`AGENTS.md`; `tests/p1-cli/test-gate-coverage.test.ts:19-21`), so no two lanes that run them are ever "in parallel". **Test files are gated by name:** `npm test` (`package.json:25`) and `test:p1-local` (`:26`) are literal lists pinned by `test-gate-coverage.test.ts:23-34`, `:85-95`, `:125-133`; a lane that adds a test file owns the matching `package.json` line and the pin for as long as it runs.

| lane | branch | author family | files it owns (exclusively while it runs) | starts after | its tests | 0.1.56 keeps working because |
|---|---|---|---|---|---|---|
| **L0** lane A (assigned) | `lane/idle-cost` | Grok | `src/listener/runtime.ts` (constants + read/claim region), `src/listener/activity.ts:13`, `src/cloud/arrival-watch.ts` (dedupe), the `file_versions` EXPLAIN. The config row `idempotency_retention_days` is **L2b's**, not L0's (it is a no-op below the 30-day floor until L2b moves the floor) | — | its own | client release |
| **L1** empty-claim persistence | `lane/claim-persistence` | Codex (from 2026-09-06 21:38Z) or Grok | `supabase/functions/command/durable-delivery.ts` (ledger counters); `supabase/functions/command/index.ts` claim branch `:8348-8445` | — | `tests/p1-server/claim-empty-persists-nothing.test.ts`: empty claim → 0 audit, 0 idempotency; claim that expired a lease → both rows; non-empty claim → both; retried empty `command_id` re-executes | same response shape plus two optional counters |
| **L2** wake migration | `lane/wake-migration` | Codex or Gemini | new `supabase/migrations/…_wake_delivery.sql`: `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions`; `agent_principals.wake_id` (schema-qualified volatile default, W1) + unique index; `wake_topic_authorized()` + `GRANT EXECUTE TO anon`; `rotate_wake_id()` + `GRANT EXECUTE TO swarm_command` (W6); both triggers; both `realtime.messages` policies; the column-comment amendment; **plus the test gate**: `package.json:26` and the pin in `tests/p1-cli/test-gate-coverage.test.ts:23-34,125-133` | — | `tests/p1-local/wake-realtime-auth.test.ts` (template `activity-realtime-auth.test.ts`), named in the gate: **first**, as `anon`, a policy calling the `SECURITY DEFINER` function admits the live id (the thing the experiment did not measure); refuses a rotated id, a revoked principal, a malformed topic, a principal with no live token, and asserts Realtime's refusal text is identical for all four; every existing principal has a distinct `wake_id` after the migration and a fresh INSERT gets one; `rotate_wake_id` changes it and resolves `gen_random_bytes` under the function's own `search_path`; trigger inserts one `realtime.messages` row per delivery; trigger swallows a send failure | additive schema with a default; no INSERT site and no client changes |
| **L2b** retention | `lane/retention` | Gemini | new migration replacing `swarm.purge_expired_idempotency_keys()` with a 1-day floor; the config row `idempotency_retention_days` to 2; the loaded-plan evidence for §5; **the test gate lines after L2 has merged** (`package.json:26`, the pin) | **L2** (same gate lines, same local database) | `tests/p1-local/idempotency-retention.test.ts`, named in the gate: purge removes a 3-day-old row and keeps a 1-day-old one | server-only |
| **L2c** topic redaction | `lane/wake-redaction` | Gemini | `src/host/credential-redaction.ts` (`CREDENTIAL_PREFIX_RE` gains the `cswarm-wake:` alternation); the cases in the existing `tests/host-stderr-tail.test.ts` and `tests/listener-control.test.ts` (no new file, so no gate change) | — | a topic in stderr, in `lastErrorDetail`, and in a tool title is rendered `[redacted-credential]`; `swm_agt_` still is; `npm run check:edge` green because `activity/index.ts:2` imports the module | client and edge share the constant; nothing on the wire changes |
| **L3** wake in responses and rotation calls | `lane/wake-command` | Codex or Grok | `supabase/functions/read/index.ts` (inbox page `wake`, `:826-832`); `command/index.ts` after L1 has merged: the mint/renew/claim response builders (claim at `:8433-8451`) and the `rotate_wake_id` calls at the revocation-by-intent sites (W6, nine `revoked_at` statements classified in the PR); `_shared/` types; `src/protocol` if the response schema is shared | L1, L2 | `tests/p1-server/wake-topic-in-responses.test.ts` (named in `package.json:27`'s glob, so no gate edit) and `tests/p1-server/wake-rotation.test.ts`: revoke rotates, principal revoke rotates, a renewal that discards a stranded successor does not | optional field; 0.1.56 ignores it |
| **L4** listener client | `lane/wake-client` | Codex | new `src/listener/wake.ts`; `src/listener/runtime.ts` (after L0 merged); `src/listener/control.ts` (`STATUS_ALLOWED_KEYS`, `STATUS_SENSITIVE_KEYS`, `parseListenerWake`); `src/listener/read-health.ts` (per-hour `expectedClaims`); `src/cloud/signals.ts`, `src/cloud/delivery.ts`, `src/cloud/renewal.ts` (the three parsers carry `wake` through, W3.4); `src/cli.ts` listener wiring; new `tests/listener-wake.test.ts` **and therefore `package.json:25` plus the pin, after L2b has merged**; the existing `tests/listener-*.test.ts`. No dependency change: the Realtime client comes from the existing `@supabase/supabase-js` | L0, L2b (gate lines), L2c (redaction), L3 (contract; developed against a fake Realtime server) | fake-socket tests for every row of §2.4 incl. the latch, the budget, and the per-hour read-health rule; a **live control** with `--state-dir <temp>` against the local stack pasting status JSON with `mode: "push"`, then with Realtime stopped showing `mode: "poll"`, and showing no topic anywhere in the status file | this *is* the release; until it lands, seats poll |
| **L5** watcher | `lane/wake-watcher` | Gemini | `src/cloud/arrival-watch.ts` (after L0's dedupe merged); `src/cli.ts` notify wiring (after L4 merged); `tests/support/arrival-watch.test.ts` | L0, L4, the refused-frame fix | wake → one read → cursor advance; poll fallback when not subscribed; the read-only invariant test stays green | same |
| **L6** app | `lane/wake-site` | Gemini | `site/src/components/app/LiveDashboard.astro` feed refresh; `site/src/lib/commonswarm.ts`; site tests | L2 | site observer: no 2 s poll while subscribed; poll resumes on `CHANNEL_ERROR` | site-only deploy |
| **L7** measurement | `lane/wake-measure` | Grok | `scripts/measure-idle-cost.sh`; `docs/evidence/2026-09-xx-push-delivery-measured/` | L4 | §8's plan, before and after | — |
| **L8** docs | `lane/wake-docs` | any | `docs/design/SWARM-CLOUD.md` §2.13 addendum, §2.2 persistence rule; `AGENTS.md` one trap ("push is a hint; the row is the truth; a status that says push must be subscribed now") | L4 | — | — |

Order: **L0, L1, L2, L2c now, in parallel** (disjoint files; only L2 uses the local database). **L2b after L2** (same gate lines, same database). **L3 after L1 and L2.** **L4 after L0, L2b, L2c, and L3.** **L5 after L4; L6 after L2 (may run beside L3; site tests only).** **L7 after L4, before "released."** **L8 with the release.** Each lane carries its two D-036 arms on its own SHA. Production apply order per lane: migration → `command` edge → `read` edge → client, as `20260905000020:32-33` already states; L2's migration is applied before L3's edge deploy, and L3 is deployed before L4 is published to npm.

Rollback: every server step is additive. Dropping the two triggers stops wakes; listeners keep their silent subscription and the reconcile catches everything at 5-minute latency. Dropping the policies refuses joins; listeners poll at 15 s. Removing the claim capability from the read response drops a push-mode listener to `cursor_fallback` on its next reconcile read (§2.3). No step needs a client rollback to undo.

---

## 7. Capacity: what breaks at 100, 1,000, 10,000 seats

Assumptions: Pro plan; one listener per seat; one `inbox --notify` on half the seats; humans' tabs ignored below 10 per workspace; signals per seat-day ≈ 100 (today's fleet posts 1,716/day over 16 seats, so this is generous); activity heartbeat 60 s after lane A; reconcile 5 min.

**Per idle seat per day after this spec:** reconcile 288 reads + 288 claims = 576; activity 1,440; renewals 24; wake-driven claims ≈ 100; drains ≈ 50 ⇒ **≈ 2,200 invocations** (≈ 2,580 with a watcher: 288 reconcile reads + ≈ 100 wake reads more), from ≈ 53,800: **−96 %**. Wake-driven claims stay far under the 120/min server limit: 100 per day is 0.07 per minute against a client budget of 50. Rows written: ≈ 400 `rate_buckets` rows (288 reconcile + ≈ 100 wake claims, per-minute window), all purged within two hours; nothing kept. At $2 per million: $0.0044 per seat-day. The activity heartbeat is 65 % of what remains; it is the next thing to move (§9). The 10,000-seat "presence + 15-minute reconcile" figure below is 10,000 × (96 reads + 96 claims + 24 renewals + 150 wake claims and drains + 97 watcher reads) ≈ 4.6 M/day.

| seats | Realtime peak connections | Realtime messages/day | edge invocations/day (with watchers) | rows/day kept past two hours | what breaks first |
|---|---|---|---|---|---|
| 16 (today) | 24 | ≈ 6,000: one W1 send per **delivery row** (1,716 signals × mean fan-out, ≤ 8 recipients; today mostly 1) received by each subscriber (listener + watcher), plus one W2 send per signal received by each open tab; heartbeat frames predicted unbilled | ≈ 38,000 (vs 860,000) | 0 (vs 768,000) | nothing; inside the 2 M included |
| 100 | 150 | ≈ 40,000 | ≈ 240,000 (7.2 M/month, ≈ $10 over the 2 M included) | 0 | nothing; 500 connections included |
| 1,000 | 1,500 | ≈ 400,000 | ≈ 2.4 M/day (72 M/month ≈ $140) | 0 | **peak connections**: 1,500 > 500 → $10 per extra 1,000 (≈ $10); the heartbeat is now most of the edge spend → Realtime presence (§9) |
| 10,000 | 15,000 | ≈ 4 M (of 5 M/month included: fine per day, ≈ 120 M/month ⇒ ≈ $290 in messages) | ≈ 24 M/day (720 M/month ≈ $1,440) with the heartbeat on the edge; ≈ 4.6 M/day (≈ $280) with the heartbeat on presence and reconcile at 15 min | 0 | **connection cap**: Pro no-spend-cap and Team stop at 10,000; needs Enterprise or one connection per host rather than per seat. Joins on a restart: 15,000 at 500–2,500/s ⇒ 6–30 s of `too_many_joins`, covered by the poll. Postgres: one `realtime.messages` insert per delivery, and the per-principal claim lock serializes per principal only |

Bounds that hold at every size: the wake payload is under 200 bytes (limit 3,000 KB); the policy lookup is one indexed row per join, not per message; Realtime authorizes a broadcast once per topic, not per subscriber, unlike Postgres Changes, which is why W1 is broadcast and not `postgres_changes`.

---

## 8. Stage 3 — measurement plan

Before/after, same host, same seat, a **live listener started with `--state-dir <temp>`** against the local stack with `supabase functions serve` counting requests per edge in its log, and once against production over 10 minutes with the dashboard's per-function invocation counter read before and after.

| metric | before (predicted) | before (measured, L7) | after (predicted) | after (measured, L7) |
|---|---|---|---|---|
| invocations per idle listener per 10 min | read 167 + claim 167 + activity 40 = **374** | | reconcile 2 reads + 2 claims + activity 10 = **14** | |
| rows written per idle 10 min | 167 audit + 167 idempotency + 10 rate-bucket = **344** (334 kept) | | **2** rate-bucket rows, purged within two hours; **0** kept | |
| wake latency: `post_signal` accepted → claim leased, directed ask from another principal, 20 trials | mean 1.8 s, max 3.6 s | | mean < 0.5 s, max 1.0 s (local experiment observed sub-second) | |
| latency with Realtime down (container stopped) | as before | | ≤ 15 s + detection ≤ 25 s | |
| latency with a wake dropped (trigger disabled) | — | | ≤ 300 s | |
| latency after a rotation (`cswarm wake rotate`) | — | | ≤ 300 s, or ≤ 15 s if the socket was down | |
| status honesty | — | | `listen status` shows `mode: "push"` only while subscribed; stopping Realtime flips it to `poll` within 25 s; the topic never appears in status or logs | |

Predicted per-listener per-minute: **before 37.4, after 1.4.** The measured columns are filled by L7 and pasted here; the spec is not "done" until they are.

---

## 9. Stage 4 — what this spec does NOT settle

- **Cross-machine duplicate listeners.** Deferred by ruling. Two machines on one credential each subscribe to the same topic and each claim; `SKIP LOCKED` keeps it safe and wasteful, and two is the most the 120/min claim limit tolerates at the client budget (§2.3).
- **An operator-triggered rotation** (`cswarm wake rotate`). Not in this spec; rotation happens on revocation only. If wanted later it is one command kind plus one CLI verb.
- **The design bar, from the operator (2026-09-06): "a system that works well, and is extremely cost efficient."** Works well means the row stays the only truth and a lost wake costs latency, never a delivery. Extremely cost efficient means idle cost stops growing with seats. This spec gets an idle seat from ≈ 53,800 to ≈ 2,200 invocations a day; the two successors below take it to ≈ 800 and make the connection count per computer, not per seat. Both are named here so they are not lost, and neither is in this spec's lanes.
- **Successor 1 — the activity heartbeat on the wake socket.** Still an edge call every 60 s after lane A, and 65 % of what remains after this spec. Realtime presence on the same socket replaces it; not designed here.
- **Successor 2 — one `cswarm` daemon per machine (operator's proposal, 2026-09-06).** Measured on the mini: per seat ≈ 23 MB supervisor + 18 MB ACP bridge + 10 MB notify watcher of duplicated plumbing beside a 65–140 MB model worker; nine seats ≈ 520 MB of plumbing against 590 MB of agents, and one Realtime connection per seat. A per-host daemon holds one socket with every seat's topic (100 channels per connection), runs the reconcile polls and the watcher reads for every seat with each seat's own token, and hands wakes over the existing local control socket. The model worker and the credential stay per seat: the daemon routes, the seat claims, so attribution and revocation do not move. The `WakeSubscriber` module L4 builds is the piece that migrates into it. It also absorbs the per-host duplicate-listener guard and the watcher dedupe.
- **Realtime billing of heartbeat frames.** The docs count broadcast, presence, and database-change messages; they do not say whether protocol heartbeats count. Predicted unbilled; L7 reads the usage page to confirm.
- **Hosted project Realtime settings.** The "Allow public access" flag does not affect `private: true` topics; the hosted project's limits and the `realtime.send` grant to `swarm_admin` are not in the repo (locally `EXECUTE` is `PUBLIC`, `local-plans.out`); L2 verifies both on a linked `db query` before its migration is pushed.
- **A minted-JWT alternative.** Rejected for now (W5). If Supabase ever restricts `anon` on private channels, the fallback is an edge-minted asymmetric JWT via the project's signing keys.
- **Postgres Changes.** Not used and not enabled: no table joins the `supabase_realtime` publication under this spec.
- **Broadcast replay.** Supabase now offers an opt-in 72-hour replay for broadcast (Grok arm, from the current limits page). This design does not use it: the ledger is the replay, and the reconcile bounds the gap. If replay is ever adopted, it shortens the missed-wake worst case, not the correctness argument.
- **Presence-based "attended" display**, group self-wake on channels (`20260905000020` header), and the chat platform's channel fan-out are unchanged.

---

## 10. What was NOT established

- Production counts (390,277; 1.47 M; 2.8 M; 1,716) are the ledger's, read once by CSwarmDevLead via `supabase db query --linked`; not re-measured here.
- Whether the idempotency purge cron is enabled on the production project, as opposed to defined in the migration (CodexDesktop's caveat); one query for L2b.
- Timings under load: the local plans are shapes on a near-empty database.
- That a `realtime.messages` policy may call a `swarm`-schema `SECURITY DEFINER` function as `anon` with only `EXECUTE` granted; inferred from how `swarm.is_member` serves the `authenticated` activity policy; L2's first test.
- Realtime's behaviour when a policy function raises (the design returns false everywhere so it never should); L2 tests it.
- Whether the hosted project keeps pgcrypto in schema `extensions` (it does locally; `pg_cron` is in `pg_catalog`); L2 verifies on a linked `db query` before its migration is pushed, beside the `realtime.send` grant.
- Which of the six unclassified `revoked_at` statements in `command/index.ts` (W6) are revocations by intent; L3 classifies them in its PR with the code open, not this document.

## 11. Review record

Each arm's file lives in `docs/evidence/2026-09-06-push-delivery-spec/arms/<sha>/<family>.txt` and ends with a `VERDICT:` line and a quote-back of this document's first heading. Consensus means every available family ends `VERDICT: PASS` with reasoning and no unresolved finding on the **final** SHA.

**Draft 1, `ff8a398`:**

| arm | verdict | findings and where they landed in draft 2 |
|---|---|---|
| Gemini (`agy`, inversion) | PASS, 2 nits | watcher reads added to §7; "which wake key does the trigger read" resolved by the per-principal id (W1, W4) |
| Opus (`claude -p`, adversarial) | **FAIL**: 5 defects, 4 gaps, 3 nits | D1 `setAuth` no-op → W6 rebuilt on rotation, not re-evaluation; D2 `limit: 0` is rejected by the validator (`command/index.ts:1510`, `:1435-1437`) → the watcher learns its topic from the read response (W3.1, §4.1), read-only invariant kept; D3 lease-reset and TTL-expiry mutations were invisible to the gate → ledger counters (§3.1); D4 one key per principal is not what the schema allows → `wake_id` on `agent_principals` (W1); D5 arithmetic → §0, §7, §8 recomputed with `rate_buckets` kept; G1 lane overlaps → sequenced ownership (§6); G2 purge floor `GREATEST(30, …)` → L2b; G3 mode classification starved without reads → reconcile = read + claim (§2.3); G4 the experiment's static policy vs the function → stated in W5, first test of L2, supabase-js client instead of bare realtime-js; N1 the latch; N2 the column comment; N3 citation `:183-189` |
| Grok (exact) | **FAIL**: 6 defects, 10 nits | D1 watcher `limit: 0` → same fix as Opus D2 (W3.1, §4.1); D2 skipping the read would stop the standing-grant use stamp (`command/index.ts:9024-9036`, `20260901000001:199-207`) → the reconcile read stays and the reason is stated (§2.3); D3 claim `rate_buckets` are per-minute (`:4868`, `:4881-4888`), not hourly → §1.1, §1.3, §3.1, §3.2, §7, §8 recomputed; D4 `test:p1-local` is a literal list (`package.json:26`, `test-gate-coverage.test.ts:23-34,125-128`) → L2 owns the gate lines; D5 the new column needs an additive story → volatile default on `agent_principals.wake_id`, no INSERT site touched (W1); D6 L1∩L3 → sequenced (§6). Nits: hook citation, apply-order lines `:32-33`, `ok`/`event_ids`, 0.068 ms, `GREATEST(30, …)` floor (L2b), W6 wording, `STATUS_ALLOWED_KEYS`, the 4.6 M derivation, `realtime.send` swallowing errors, opt-in broadcast replay (§9) |
| CodexDesktop (not an arm; three questions, signal `2cf19b81`) | — | the name is the credential and is redacted (W1); the policy is not an oracle (W5); rotation and revocation semantics stated (W6) |

**Draft 2, `f6bcd83`:**

| arm | verdict | findings and where they landed in draft 3 |
|---|---|---|
| Gemini (`agy`, inversion) | PASS, no findings | all six draft-2 inversions refuted |
| Opus (`claude -p`, adversarial) | **FAIL**: 4 defects, 4 gaps, 6 nits; confirmed every draft-1 item fixed, and measured the volatile default (5 rows → 5 ids) | DA `revoke_agent_token` is not a database function and an `AFTER UPDATE OF revoked_at` trigger would rotate on renewals → rotation is `swarm.rotate_wake_id()` (L2) called from the revocation-by-intent sites by L3, nine `revoked_at` statements enumerated, `:3576` excluded (W6); DB `gen_random_bytes` is in `extensions` and no `search_path` in the tree names it (measured with a positive control) → schema-qualified everywhere, `CREATE EXTENSION … WITH SCHEMA extensions`, hosted question in §10 (W1); DC `redactCredentialText` does not match `cswarm-wake:` → L2c extends `CREDENTIAL_PREFIX_RE` (W1); DD L2/L2b contend on the gate lines, the local database, and the config row → L2b sequenced after L2, the row is L2b's, the database is a file (§6); GA the status parser is closed at the top level only → `parseListenerWake` with a closed list, `topic` in `STATUS_SENSITIVE_KEYS` at every depth, `errorCode`, `wake.mode` vs `deliveryMode` (§2.3); GB read health rescores past hours on a cadence change → per-hour `expectedClaims`, mode-change hours excluded (§2.3); GC the 120/min claim limit and its audit + security alert → 1 s coalescing, a 50/min client budget, a failure row (§2.3, §2.4, §7, §9); GD L4's new test file needs `package.json:25` → L4 owns it after L2b (§6). Nits: audit rows are kept forever (§0); messages/day now count deliveries × subscribers plus W2 (§7); citations `:8433-8451`, `:229`, `:202`; `record_renewal_grant_use` is one UPDATE (§3.1); `read/index.ts:826-832` (W3.1); "complete" bounded by one in-flight insert (W6) |
| Grok (exact) | **FAIL**: 2 defects, 9 nits; confirmed all six draft-1 defects fixed | D1 L2b's test outside the literal gate while L2 owns it → same fix as DD; D2 no lane owned the client parsers that must surface `wake` → L4 owns `signals.ts`, `delivery.ts`, `renewal.ts` (W3.4, §6). Nits: redaction (→ L2c), `tests/listener-wake.test.ts` gate (→ GD), L0 config key (→ L2b), "kept forever", the 2,580 arithmetic, `read/index.ts:826-832`, pgcrypto (→ DB), W5 refusal text measured for one miss case (stated), `cswarm wake rotate` owned by no lane (→ removed, §9) |

**Draft 3 arms:** to be run on the draft-3 SHA and recorded here.

## Sources

- Brain topics `edge-function-invocations-2026-09` (Finisher), `operator-requests` (CSwarmDevLead), `false-success-signals`.
- `docs/org/2026-08-29-RESUME-HERE.md:2277-2302` (ledger, `f59cf7d`, `d500973`).
- Evidence directory of this spec, including the two CodexDesktop passes (signals `c650a8c7`, `327e7bc3`), the CSwarmDevLead relay (`8fb993de`), and CodexDesktop's questions on draft 1 (`2cf19b81`).
- `node_modules/@supabase/realtime-js/dist/main/RealtimeClient.js:12` (heartbeat 25 s), `:16` (reconnect ladder), `:489` (`access_token` pushed only on change).
- Supabase docs: Realtime broadcast (`realtime.send`, private channels, 3-day partitions), authorization (policy caching, `access_token` refresh), limits (connections, messages/s, joins/s, payload), pricing (2 M / 5 M included; $2 per million invocations; $2.50 per million messages; $10 per 1,000 peak connections), Postgres Changes (per-subscriber authorization), Edge Function limits (150 s idle, 2 s CPU), JWT signing keys.
