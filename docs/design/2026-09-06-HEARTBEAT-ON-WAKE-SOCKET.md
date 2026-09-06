# Heartbeat on the wake socket: retire the activity edge call

**Status:** SPECIFICATION, draft 1, branch `spec/app-backlog`. Backlog item 0 (push-delivery successor 1, `docs/design/2026-09-06-PUSH-DELIVERY.md` §9). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06, from a read-only code map (`docs/evidence/2026-09-06-app-specs-arms/maps/heartbeat.md`).
**Authority:** none until adopted; CSwarmDevLead PMs the lanes.
**Design bar (operator, 2026-09-06):** works well, and is extremely cost efficient.

## 0. The answer in one paragraph

After push delivery, the listener's activity heartbeat is about 90 % of what an idle seat still costs: one `POST /functions/v1/activity` every 15 s, which the edge function relays as a Realtime broadcast to the workspace's activity topic (`src/listener/activity.ts:13`; `supabase/functions/activity/index.ts:141-150`). The listener now holds a websocket for push delivery (`src/listener/wake.ts`). Send the same frame **over that socket** instead of through the edge: the listener broadcasts to the activity topic itself, and a `realtime.messages` INSERT policy admits the frame only when it carries a proof derived from the principal's wake id, so nothing an anon-key client can forge is accepted. The site keeps its subscription unchanged. Idle heartbeat edge calls go from 5,760 a day (15 s) or 1,440 (after lane A's 60 s) to **zero**; messages per day are unchanged, because the edge was already turning every heartbeat into one broadcast.

## 1. Today, measured

| part | fact | source |
|---|---|---|
| cadence | `ACTIVITY_FRAME_INTERVAL_MS = 750` (coalescing floor), `ACTIVITY_HEARTBEAT_MS = 15_000` (re-armed after every quiet flush) | `src/listener/activity.ts:12-13`, `:285-292`, `:337-341` |
| transport | `POST ${target.url}/functions/v1/activity`, `authorization: Bearer <agent token>`, `apikey`, body keys `version, workspace_id, stream_id, sequence, phase, signal_id, tool_title, elapsed_ms`, 5 s abort | `activity.ts:88-147`, `:119-128` |
| edge | closed parser (`parseActivityRequest`, `activity/core.ts:44-84`, 4,096-byte cap), auth by token hash, membership and archive checks, then `RESET ROLE` and `realtime.send(payload, 'activity', 'cswarm-activity:{workspace_id}', true)`; the server adds `principalId` and `emittedAt` and re-redacts `toolTitle` | `activity/index.ts:78-152`, `:118-131`, `:141-150` |
| site | subscribes with the member's Supabase JWT to `cswarm-activity:{workspace}` (`private: true`), event `activity`; orders by `sequence` within a `streamId`, by `emittedAt` across; fresh within 30 s, 17 s grace after subscribe | `site/src/lib/commonswarm.ts:180-216`, `site/src/lib/agent-activity.ts:6-7`, `:135-141`, `LiveDashboard.astro:2367-2393` |
| policy | one `FOR SELECT TO authenticated` policy keyed on `swarm.is_member(<uuid from topic>, auth.uid())`; **no INSERT policy on `realtime.messages` anywhere** | `20260902000003_realtime_agent_activity.sql:4-16`; the wake migration adds two more SELECT policies and no INSERT |
| wake socket | `WakeSubscriber` creates `createClient(target.url, anonKey).realtime`, `setAuth(anonKey)`, one private channel `cswarm-wake:{wake_id}`; the client and channel are private fields with no accessor | `src/listener/wake.ts:136-141`, `:429-449`, `:111-128`, `:233-234` |
| cost | 5,760 heartbeat invocations per idle seat-day at 15 s; 1,440 at 60 s; the lead measured the heartbeat at ~90 % of idle edge calls after push delivery | `PUSH-DELIVERY.md` §1.3, §7; ledger 2026-09-06 |

Status fields that consume the transport's failures: `activityPublishFailures`, `activityLastErrorCode` (`src/listener/control.ts:174-176`, `supervisor.ts:321-322`, `cli.ts:4890-4891`), pinned by `tests/listener-control.test.ts:591-598`. The 15 s boundary is pinned by `tests/listener-activity.test.ts:158-161`.

## 2. The design

### 2.1 Principle

**Same frame, same topic, same site; only the sender moves.** The frame the site validates (`FRAME_KEYS`, `agent-activity.ts:19-29`) does not change shape, so nothing on the reading side is rewritten. What changes is who inserts the broadcast and how the server knows it is honest.

### 2.2 Trust: the proof in the payload

Today the edge stamps `principalId` and `emittedAt` after authenticating the token, so a frame's identity is server-vouched. A listener publishing from an **anon-key** socket has no identity the policy can see (`realtime.topic()` and the JWT claims are all a policy gets, and the anon JWT has none), so the identity must be **proved inside the payload** and checked by the INSERT policy's `WITH CHECK`, which can read `realtime.messages.payload`:

- The listener adds `proof = base64url(hmac_sha256(key = wake_id, message = principalId || ':' || sequence || ':' || streamId))` to the frame. `wake_id` is the per-principal capability the listener already holds for push delivery (`swarm.agent_principals.wake_id`, `20260906000010_wake_delivery.sql:15-35`); it never leaves the payload in the clear.
- `swarm.activity_publish_authorized(topic text, payload jsonb) RETURNS boolean`: `STABLE SECURITY DEFINER`, owner `swarm_admin`, `SET search_path = swarm, extensions, pg_catalog` (it needs `hmac` from pgcrypto, and `swarm_admin` has no `USAGE` on `extensions` — measured on the push-delivery lane — so the function is **owned by `postgres`** like the wake trigger functions, with `REVOKE ALL FROM PUBLIC` and `EXECUTE` to `anon`). It parses the workspace id from `cswarm-activity:{uuid}`, reads `payload->>'principalId'`, checks the principal belongs to that workspace, is not revoked, and has a live token; recomputes the HMAC with the stored `wake_id`; returns true only on an exact match, false on every other path, and raises on nothing.
- Policy: `CREATE POLICY "agent publishes its own activity" ON realtime.messages FOR INSERT TO anon WITH CHECK (realtime.messages.extension = 'broadcast' AND swarm.activity_publish_authorized(realtime.topic(), realtime.messages.payload))`. **Realtime's broadcast INSERT also needs `USAGE` on schema `realtime` and `INSERT` on `realtime.messages` for `anon`, and `realtime.messages` has RLS enabled with no INSERT policy today** (measured on the push-delivery lane: `anon` holding both grants was still refused by RLS). So this is the first INSERT policy on that table; L1's test proves it admits a correct proof and refuses a wrong one, a stale one, a foreign principal, and a foreign workspace.
- Replay: a captured frame replays as itself. The site drops frames whose `sequence` is not newer within a `streamId` (`agent-activity.ts:135-141`), so a replay can only re-assert a state that was already true. The exposure is "principal X looked alive again for one frame", which the design accepts and states.
- `emittedAt`: today server-stamped. Under this design the listener stamps it; the site's freshness rule (`now - emittedAt <= 30 s`) trusts a clock the listener controls. A listener that lies about time can only make itself look fresh; bounded, and the same trust the listener already has over `sequence` and `phase`.

Members' tabs receive the frame with the proof inside it. The proof is an HMAC over public fields keyed by the wake id; it does not reveal the wake id. Publishing the same frame again is the replay above.

### 2.3 The listener

- `WakeSubscriber` gains one method, `publishActivity(frame)`: it opens (once) a second private channel on the **same** `realtime` client for `cswarm-activity:{workspaceId}`, and sends `{ type: 'broadcast', event: 'activity', payload }` over the socket (`RealtimeChannel.send`, `realtime-js/dist/module/RealtimeChannel.js:520-566`; when the socket cannot push, the library falls back to its REST broadcast endpoint, which is one Realtime HTTP call, not an edge invocation). No accessor to the raw client is added; the second channel lives inside `wake.ts`.
- `ListenerActivityController` keeps its coalescing and heartbeat timers (`activity.ts:165-343`) and swaps its transport: `AgentActivityEndpointTransport` (HTTP) becomes the **fallback**, used only while `wake.state !== subscribed`. So a seat with no socket still reports through the edge exactly as today, and a seat with a socket reports for free.
- The heartbeat interval stays whatever lane A landed (`ACTIVITY_HEARTBEAT_MS`, 15 s in this checkout, 60 s intended): over the socket, 15 s is affordable again (a broadcast is not an edge invocation), and the site's 17 s grace keeps working. **Decision for the lead:** keep 15 s on the socket and 60 s on the HTTP fallback, so the panel is live where it is cheap and cheap where it is not.
- Status: `activityPublishFailures` / `activityLastErrorCode` keep their meaning; a new `activityTransport: "socket" | "edge"` field on the wake block (`parseListenerWake`'s closed list gains it; `control.ts:397-433`).

### 2.4 The site

Unchanged in what it subscribes to and validates. One line in `parseAgentActivityFrame` (`agent-activity.ts:73-128`): accept and ignore the new `proof` key (the closed key set `FRAME_KEYS` gains it), so an old site build that drops unknown keys and a new one behave the same.

### 2.5 The edge function

Kept, as the fallback publisher. Its parser gains nothing. When every seat is on 0.1.6x, its traffic is the fallback only; retiring it is a later decision, not this spec's.

### 2.6 Failure modes

| failure | behaviour | bound |
|---|---|---|
| socket down | transport flips to the edge fallback; panel keeps its 17 s grace | one heartbeat interval |
| policy refuses (bad proof, rotated wake id) | `send` resolves `error`; controller counts `activityPublishFailures`, sets `activityLastErrorCode = activity_publish_refused`, falls back to the edge for that frame, and re-tries the socket on the next `subscribed` transition (a rotated wake id arrives via the wake hint the listener already tracks) | one frame |
| replayed frame by a member | site drops non-newer sequences; at worst one stale "alive" | one frame |
| Realtime rate limit (500 msg/s Pro) | same as push delivery's row: the client reconnects when under the limit; the edge fallback covers | — |
| hosted RLS/grant missing for `anon` INSERT | broadcast refused → fallback to the edge; L1's pre-push check asks `has_schema_privilege('anon','realtime','USAGE')`, `has_table_privilege('anon','realtime.messages','INSERT')`, and counts INSERT policies before the migration is pushed | zero regressions: the edge path stays |

## 3. Cost

Per idle seat-day: heartbeat edge invocations 1,440 (60 s) or 5,760 (15 s) → **0** on a subscribed seat. Realtime messages unchanged (one send plus one receipt per open tab per heartbeat; today's edge already produced exactly that). With the push-delivery reconcile at 288 reads + 288 claims and renewals at 24, an idle subscribed seat is ≈ **600 edge calls a day** (from ≈ 2,200 after push delivery, ≈ 53,800 before it). At $2 per million: $0.0012 per seat-day.

## 4. Lanes

| lane | branch | author | files | tests | after |
|---|---|---|---|---|---|
| **L1** publish policy | `lane/activity-publish-policy` | Gemini or Grok | new migration: `swarm.activity_publish_authorized()` (owner `postgres`, `REVOKE ALL FROM PUBLIC`, `EXECUTE TO anon`), `GRANT USAGE ON SCHEMA realtime TO anon` and `GRANT INSERT ON realtime.messages TO anon` **only if the hosted check shows they are missing** (local: verify), the INSERT policy; `tests/p1-local/activity-publish-auth.test.ts` (template `activity-realtime-auth.test.ts`) named in `package.json:26` plus the pin `tests/p1-cli/test-gate-coverage.test.ts:23-34,125-133` | admits a correct proof; refuses wrong proof, foreign principal, foreign workspace, revoked principal, no live token; a member's `authenticated` JWT cannot insert; the existing SELECT tests stay green | — (holds the local database) |
| **L2** listener transport | `lane/activity-on-socket` | Grok | `src/listener/wake.ts` (`publishActivity`, second channel), `src/listener/activity.ts` (proof, transport selection, `activity_publish_refused`), `src/listener/control.ts` (`activityTransport` in the closed wake list), `src/cli.ts` status line; `tests/listener-activity.test.ts` (keeps the 15 s pin, adds fallback and refusal cases), `tests/listener-wake.test.ts`, `tests/listener-control.test.ts` | fake-socket: frame goes over the socket when subscribed, over HTTP when not; refusal falls back and counts; proof is an HMAC of the stated fields; a **live control** with `--state-dir <temp>` pasting status with `activityTransport: "socket"` and the site panel showing the frame | L1 |
| **L3** site parser | `lane/activity-proof-key` | Gemini | `site/src/lib/agent-activity.ts` (`FRAME_KEYS` + `proof`), `site/src/lib/agent-activity.test.*` | old and new frames both parse; `proof` never rendered | — (site only, may run beside L1) |
| **L4** measure | `lane/activity-measure` | Grok | `scripts/measure-idle-cost.sh` (exists from push delivery), evidence dir | idle seat: activity invocations per 10 min before/after; messages per 10 min unchanged | L2 |
| **L5** docs | with the release | any | `PUSH-DELIVERY.md` §9 (successor 1 done), `AGENTS.md` one line if the status copy changes | — | L2 |

Order: L1 and L3 now (disjoint; only L1 uses the database) → L2 → L4 → release. Production apply: migration → client. A 0.1.6x listener without the client change keeps posting to the edge; nothing on the server removes that path.

## 5. What this spec does NOT settle

- Retiring the `activity` edge function. It stays as the fallback until a measured month shows no fallback traffic.
- Presence (`channel.track`) instead of broadcast. Presence would give join/leave for free but carries the same trust question (the payload is client-claimed) and adds server-emitted sync frames whose billing is not established; broadcast keeps today's frame and today's site. Revisit if the panel needs join/leave semantics.
- Whether Realtime bills protocol heartbeats (push-delivery §9's open item); unchanged by this spec.
- Successor 2 (one daemon per machine): this spec makes the per-seat socket carry two channels; the daemon would carry them for every seat.

## 6. What was NOT established

- That an `INSERT` policy's `WITH CHECK` may call a `SECURITY DEFINER` function that reads `realtime.messages.payload` under the `anon` role on hosted Realtime; it is standard RLS, and L1 proves it locally first.
- Hosted grants for `anon` on schema `realtime` and on `realtime.messages`: local values were measured during push delivery (`anon` holds both); the hosted project is checked before the migration is pushed.
- Whether `RealtimeChannel.send` over an established socket counts as one billed message plus receipts exactly as `realtime.send` does today; predicted yes (same broadcast), L4 reads the usage page.
- How often a listener is subscribed versus on the fallback in production; L4 measures it.
