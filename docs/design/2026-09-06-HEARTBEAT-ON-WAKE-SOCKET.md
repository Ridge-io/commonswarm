# Idle heartbeat: fold it into the reconcile read

**Status:** SPECIFICATION, draft 5 (final-round Opus, Gemini, and Grok folded; Grok's `ede7d04` pass folded), branch `spec/app-backlog`. Backlog item 0 (push-delivery successor 1, `docs/design/2026-09-06-PUSH-DELIVERY.md` §9). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06, from a read-only code map (`docs/evidence/2026-09-06-app-specs-arms/maps/heartbeat.md`).
**Authority:** none until adopted; CSwarmDevLead PMs the lanes.
**Design bar (operator, 2026-09-06):** works well, and is extremely cost efficient.
**Draft 2 supersedes draft 1's design.** Draft 1 proposed publishing frames from the listener's anon-key socket; the Opus arm measured that the join is refused without a read policy, that a read policy would expose every member's frames to any anon holder of a workspace id, that `send()` resolves `ok` before the server answers, and that a partial HMAC let a member forge a frame. The record is in `docs/evidence/2026-09-06-app-specs-arms/heartbeat-on-wake-socket/fa44311/`. Draft 2 keeps the goal and drops the mechanism.

## 0. The answer in one paragraph

After push delivery, an idle seat's remaining cost is almost entirely the activity heartbeat: one `POST /functions/v1/activity` every 15 s (60 s after lane A), which the edge relays as a Realtime broadcast so the app can show "alive" (`src/listener/activity.ts:13`; `supabase/functions/activity/index.ts:141-150`). The listener already makes one call every five minutes while idle: the reconcile read (`src/listener/runtime.ts`, push delivery §2.3). **Carry the idle heartbeat inside that read.** The read request gains an optional `activity` object; the read edge, which has already authenticated the agent, relays it with the same server stamp the activity edge applies today. Active-phase frames (an agent running a tool, up to 1.33/s) keep the activity edge unchanged, because they are bounded by work, not by time. Idle heartbeat edge calls per seat-day go from 5,760 (15 s) or 1,440 (60 s) to **zero** additional calls; the panel's "idle, alive" resolution becomes the reconcile interval, which the site states honestly. No new topic, no new policy, no client publishing, no new trust surface.

## 1. Today, measured

| part | fact | source |
|---|---|---|
| cadence | `ACTIVITY_FRAME_INTERVAL_MS = 750` (coalescing), `ACTIVITY_HEARTBEAT_MS = 15_000` (re-armed after every quiet flush) | `src/listener/activity.ts:12-13`, `:285-292`, `:337-341` |
| transport | `POST ${target.url}/functions/v1/activity`, body keys `version, workspace_id, stream_id, sequence, phase, signal_id, tool_title, elapsed_ms`, 5 s abort | `activity.ts:88-147`, `:119-128` |
| edge | closed parser (`activity/core.ts:44-84`, 4,096-byte cap), token auth, membership and archive checks, then `RESET ROLE` and `realtime.send(payload, 'activity', 'cswarm-activity:{workspace_id}', true)`; the server adds `principalId` and `emittedAt` and redacts `toolTitle` with `redactCredentialText` | `activity/index.ts:79-150`, `:118-131`, `:135`, `:141-150` |
| site | subscribes with the member's JWT; fresh within `AGENT_ACTIVITY_STALE_MS = 30_000`; 17 s grace after subscribe; orders by `sequence` within a `streamId`, by `emittedAt` across | `site/src/lib/commonswarm.ts:180-216`; `site/src/lib/agent-activity.ts:6-7`, `:133-140` |
| reconcile read | the listener reads its inbox page every `LISTENER_RECONCILE_POLL_MS = 300_000` (`src/listener/wake.ts:14`, used at `runtime.ts:1551`) while subscribed, every 15 s otherwise; the read edge authenticates the agent (`agent_delivery_read_context`) and stamps grant use on every call (`:493-498`); the read runs as `swarm_read` (`:419`) and parses with an unbounded `request.json()` (`:378`) | push delivery §2.3; `supabase/functions/read/index.ts:437-498` |
| read request parser | `parseBody` closes every branch with `exactKeys` (`read/index.ts:184-192`, `actual.length === keys.length`); the signals branch lists its keys at `:268-281`, and each optional key has its own discriminator computed before the call (`modernShape` `:259`, `chatReadKeys` `:260`, the cursor pair `:262-267`); an unknown top-level key makes the **whole read** `400 invalid_request` (`:396`), the hazard `src/cloud/signals.ts:1156-1160` already documents; the **response** top level is not key-closed on the client (only recipient rows are, `signals.ts:395-400`) | Opus arm on `93792ef`, measured with a control |
| site import | `site/src/lib/agent-activity.ts:1-4` imports `../../../supabase/functions/activity/core.js` | Opus arm |
| why not a client publish | an anon-key client joins a private topic only with a read or write policy for `anon`; the only SELECT policy on the activity topic is `TO authenticated`; adding an anon SELECT policy gated on the topic alone would let any anon holder of a workspace id read every member's frames; `send()` with `ack: false` resolves `ok` before the server answers, so refusals are invisible | Opus arm on `fa44311`, measured with controls on the local stack; `RealtimeChannel.js:563-566` |
| cost | 5,760 heartbeat invocations per idle seat-day at 15 s; 1,440 at 60 s; after push delivery the heartbeat is ~90 % of an idle seat's edge calls at 15 s and ~65 % after lane A | `PUSH-DELIVERY.md` §1.3, §7 |
| listener types and writers | the controller's frame type is camelCase `AgentActivityFrameRequest` (`activity.ts:47-57`, built at `:318-329`); the only snake_case mapping to the wire is inline in `AgentActivityEndpointTransport` (`:119-128`); `activityLastErrorCode` is closed on `ActivityPublishErrorCode` (`activity.ts:17-22`; `STATUS_ACTIVITY_ERROR_CODES`, `control.ts:294-300`, `:607-611`); `activityPublishFailures` is initialised and incremented in `supervisor.ts:321`, `:633-637`; the reconcile runs during work too (`runtime.ts:1549-1551`) | Grok arm on `ede7d04` |

## 2. The design

### 2.1 Principle

**The server stays the only publisher.** Every activity frame the app shows keeps its server stamp (`principalId`, `emittedAt`) and the server's redaction and parser. What changes is which authenticated call carries the idle frame: the read the listener already makes instead of a call made only to carry it.

### 2.2 The wire

The read edge's signals request (`resource: "signals"`, `inbox: true`, the request the listener sends on every reconcile) accepts an optional field `activity` whose value is **exactly an activity-edge request body**, `workspace_id` included:

```json
"activity": { "version": 1, "workspace_id": "<uuid>", "stream_id": "<uuid>", "sequence": 41,
              "phase": "idle", "signal_id": null, "tool_title": null, "elapsed_ms": 0 }
```

The listener builds it with **one serializer**, `activityRequestBody(frame, workspaceId)`, extracted from the inline map in `AgentActivityEndpointTransport` (`activity.ts:119-128`) and used by both the transport and the read attachment, so the two paths cannot drift in key names. The read edge applies the same 4,096-byte bound to the serialized nested object before parsing (its own body parse is unbounded, `:378`) and parses it with the **same** `parseActivityRequest`, unchanged (moved from `activity/core.ts` into `supabase/functions/_shared/activity.ts`; `core.ts` stays as a re-export so the site import at `agent-activity.ts:1-4` keeps building, and both functions import one parser and one 4,096-byte bound). **How the key is optional inside an exact-keys parser:** a fourth discriminator beside the three that exist, `const carriesActivity = Object.hasOwn(body, "activity")`, adds `"activity"` to the signals key list only when present (`read/index.ts:259-281`); L1's tests include a read **without** the key, which must stay green (the control the existing hazard demands). After the read's own work the edge checks the frame the way the activity edge does (`frame.workspaceId === agent.principal_workspace_id` **and** `=== body.workspace_id`, membership, not archived, not revoked, phase `idle`) and runs the same privileged `realtime.send(...)` with the same server-built payload (`principalId`, `emittedAt`, `redactCredentialText(toolTitle)`), **awaited before the response is sent** (one SQL statement on the connection the read already holds; L1 times it). The read's result is unchanged; a rejected frame never fails the read. Two top-level response fields are added (safe for old clients, whose parser ignores unknown top-level keys, `signals.ts:395-400`):

- `activity_carrier: "read"` on **every** signals read served by an edge that supports the field. This is how a listener learns the capability without guessing (§2.3).
- `activity_rejected: <code>` only when a frame was dropped, with `code` from a closed set **exported from `_shared/activity.ts`** and built into the tests from that constant, since none exists today (the activity edge answers `400 invalid_request` / `403 forbidden` with no reason): `ACTIVITY_REJECT_CODES = ["invalid_request", "forbidden", "workspace_mismatch", "not_idle"] as const`. The constant lives in **`src/protocol/`** (pure, no I/O) and reaches the edge through the generated protocol bundle (`npm run build:command-core`, the existing direction of sharing), so the listener's status set below is built from the same array. The relay copies the activity edge's `RESET ROLE` and `search_path` statements (`activity/index.ts:141-144`) because the read's transaction runs as `swarm_read` (`read/index.ts:419`).

Only an **idle** frame rides the read (`not_idle` otherwise); any non-idle frame keeps the activity edge, whose cadence is bounded by the 750 ms coalescing floor and by the length of the work.

### 2.3 The listener

`ListenerActivityController` (`activity.ts:165-343`) keeps its coalescing and phase logic. Changes:

- **The idle heartbeat timer stops once the read carries the frame.** While `activityIdleCarrier` is `edge` (§ below), `armHeartbeat()` (`:285-292`) keeps today's idle cadence, so an upgraded listener against an old edge is never silent; once the capability has been seen it no longer schedules an idle send. The controller exposes `idleFrame()`, which returns **`null` unless `phase === "idle"`** (a reconcile during work carries nothing; the frame is neither an always-idle payload nor a `flush()` clone) and otherwise **increments the sequence** exactly as `flush()` does (`:319`, `sequence: ++this.sequence`), because the site keeps a frame only if its sequence is greater than the last one for the stream (`agent-activity.ts:133-140`); a non-incrementing idle frame would be accepted once and then dropped for the life of the stream while every listed test stayed green. The runtime attaches `idleFrame()` to every reconcile read and to every 15 s fallback read **only when it is non-null and the capability has been seen**. Non-idle phases still flush through the activity edge as today, and the transition **into** `idle` sends one last frame through the edge so the panel shows the phase change within the coalescing floor.
- **Capability detection, so deploy order cannot brick a seat.** `AgentSignalPage` and its parser (`src/cloud/signals.ts:135-153`, `:1232-1251`) copy `wake` and drop every other top-level key today, so L2 adds `activity_carrier` and `activity_rejected` to that parser or the listener never sees them. The listener attaches `activity` only after it has seen `activity_carrier: "read"` on a previous read from this target (a flag in memory, cleared on `invalid_request`). Against an old edge the field is never sent and the read succeeds as today; against a rolled-back edge the one read that carried it is refused, the listener clears the flag and **retries that read once without the field**, and the idle frame simply stops riding until the capability reappears. This removes the deploy-order hazard: L1 and L2 can ship in either order and L1 can be rolled back.
- **One counter semantics.** `activityPublishFailures` counts every frame that did not reach Realtime, whether an edge send failed or a read-carried frame came back with `activity_rejected`; both are written where the counter already lives, `supervisor.ts:321`, `:633-637`. `activityLastErrorCode` records the code from either path; its closed set `ActivityPublishErrorCode` (`activity.ts:17-22`) and `STATUS_ACTIVITY_ERROR_CODES` (`control.ts:294-300`, `:607-611`) are **extended by generation** with `read_${code}` for each member of `ACTIVITY_REJECT_CODES`, so `listen status` never meets a value outside its set. A new closed top-level status field `activityIdleCarrier: "read" | "edge"` says which call currently carries idle frames: `edge` (the timer) until the capability has been seen, `read` after.

`ACTIVITY_HEARTBEAT_MS` becomes the **edge fallback cadence** for non-idle phases only (an agent working for a long time with no phase change still refreshes every 15 s through the edge, bounded by work). `tests/listener-activity.test.ts:158-161` changes from "the 4th frame fires at 15 s while idle" to "with the capability seen, no timer frame fires while idle and two consecutive reconciles carry `idleFrame()` with increasing sequences; a reconcile during `tool-running` carries nothing; without the capability seen the idle timer still fires and reads carry nothing; a tool-running phase still fires at 15 s".

### 2.4 The site

The panel's freshness rule (`AGENT_ACTIVITY_STALE_MS = 30_000`, `agent-activity.ts:6`) is wrong for an idle seat that reports every five minutes. The frame already carries `phase`; the rule becomes:

- phase ≠ `idle`: fresh within 30 s, as today;
- phase = `idle`: fresh within **`AGENT_ACTIVITY_IDLE_STALE_MS = 330_000`** (the reconcile interval plus one 30 s margin), shown as `idle · seen 4 min ago`, so the panel says what it knows and when.

`AGENT_ACTIVITY_INSTRUMENTATION_GRACE_MS = 17_000` (`:7`) stays for the first non-idle frame after subscribe and gains an idle twin of 330 s; the "not instrumented" state is shown only after both. `parseAgentActivityFrame` is unchanged (the frame shape is unchanged). No new key, so an old site build renders new frames as before; only the staleness copy improves on the new build.

### 2.5 Failure modes

| failure | behaviour | bound |
|---|---|---|
| the read is refused or times out | no idle frame that cycle; the panel ages toward `idle · seen N min ago`; the read's own retry path is unchanged | one reconcile interval |
| `activity` object malformed or foreign | dropped at the edge with `activity_rejected`; the read still succeeds; the listener counts `activityPublishFailures` and records the code | one frame |
| read edge rolled back after L2 | one read refused `invalid_request`; the listener clears the capability flag and retries once without the field; delivery continues; idle frames stop riding | one read |
| socket down (15 s poll) | idle frames ride the 15 s reads, so an unsubscribed seat is *more* frequently reported, not less | — |
| agent works for a long time | non-idle frames through the edge at ≤ 1.33/s, refreshed every 15 s | as today |
| Realtime down | `realtime.send` swallows its failure; the read succeeds; the panel ages | as today |

### 2.6 What stays exactly as it is

The activity edge function and its parser (now shared), the topic, the policy, the site subscription, `redactCredentialText`, the wake subscriber, and every cost number push delivery measured except the heartbeat's.

## 3. Cost

Per idle seat-day: heartbeat edge invocations 1,440 (60 s) or 5,760 (15 s) → **0** additional (the 288 reconcile reads already exist and each now carries the frame; a read with an `activity` object is one invocation, as before). Realtime messages: 288 idle broadcasts per seat-day instead of 1,440 or 5,760, so the message line in push delivery §7 falls by the same factor. With push delivery's reconcile (288 reads + 288 claims) and renewals (24), an idle subscribed seat is ≈ **600 edge calls a day** (from ≈ 2,200 after push delivery, ≈ 53,800 before it). At $2 per million: $0.0012 per seat-day.

## 4. Lanes

| lane | branch | author | files | tests | after |
|---|---|---|---|---|---|
| **L1** shared parser + read edge | `lane/activity-on-read` | Grok | `supabase/functions/_shared/activity.ts` (moved parser and topic helpers, one 4,096-byte bound), `supabase/functions/activity/{index,core}.ts` (import the shared module), `supabase/functions/read/index.ts` (the fourth discriminator at `:259-281`; parse, authorize, relay awaited before the response; `activity_carrier` and `activity_rejected`), `site/src/lib/agent-activity.ts:1-4` only if the import path moves, `tests/p1-server/activity-on-read.test.ts` (reached by the `p1-server` glob, `package.json:29`) | a read **without** `activity` is unchanged (the control); an idle frame on a read is relayed with the server stamp and redaction; a non-idle frame is rejected `not_idle`; a foreign `workspace_id` is `workspace_mismatch`; a malformed frame is dropped without failing the read; every response carries `activity_carrier`; the activity edge still works unchanged; `npm run check:edge` green; the reconcile's timing with and without a frame | — (holds the local database) |
| **L2** listener | `lane/idle-frame-on-reconcile` | Gemini | `src/listener/activity.ts` (no idle timer, `idleFrame()`, the into-idle edge frame), `src/listener/runtime.ts` (attach the frame to reconcile and fallback reads), `src/cloud/signals.ts` (request field; `activity_carrier` and `activity_rejected` in the page parser), `src/listener/supervisor.ts:321`, `:633-637` (the counter and code writes), `src/listener/control.ts` + `src/cli.ts` (`activityIdleCarrier`, the generated code set), `src/protocol/` (`ACTIVITY_REJECT_CODES`, then `npm run build:command-core`), `tests/listener-activity.test.ts`, `tests/listener-runtime.test.ts` | no idle send; two reconciles carry two frames with increasing sequences; nothing is sent before the capability is seen; the retry-once path on `invalid_request`; the into-idle frame fires once; a **live control** with `--state-dir <temp>` against the local stack showing **two** panel frames arriving on two reconciles and `listen status` reporting `activityIdleCarrier: read` | none required (capability detection); L1 first is still the natural order |
| **L3** site staleness | `lane/idle-staleness` | Gemini | `site/src/lib/agent-activity.ts` (`AGENT_ACTIVITY_IDLE_STALE_MS`, the phase-aware rule, the idle grace), `LiveDashboard.astro` panel copy, `site/src/lib/agent-activity.test.*`, `entity-panel.observer.test.ts:97` | idle frame 4 min old is `idle · seen 4 min ago`, not stale; non-idle rule unchanged | — (site only; parallel with L1) |
| **L4** measure | `lane/idle-heartbeat-measure` | Grok | `scripts/measure-idle-cost.sh`, `docs/evidence/2026-09-06-idle-heartbeat/RESULTS.md` (the before/after table with the command that produced each number) | activity invocations per 10 idle minutes before/after (40 or 10 → 0); reconcile count unchanged | L2 |
| **L5** docs | with the release | any | `PUSH-DELIVERY.md` §9 (successor 1 done, and the design change from draft 1 recorded) | — | L2 |

Order: L1 ∥ L3 → L2 → L4 → release. A listener that has not upgraded keeps posting to the activity edge; nothing on the server removes that path. **Shared file across specs:** `supabase/functions/read/index.ts` is also edited by `2026-09-06-MODEL-PER-AGENT.md` L1 (`lane/assigned-model`), and both hold the local-database slot; this spec's L1 lands **first** (a smaller change to the same `parseBody` branch), then `lane/assigned-model` rebases; push delivery's `lane/wake-command` is already on `main`. CSwarmDevLead serialises the database slot. On the client, `src/listener/runtime.ts`, `src/listener/control.ts`, `src/cloud/signals.ts`, and `src/cli.ts` are also edited by `2026-09-06-MODEL-PER-AGENT.md` L2 (`lane/listener-assigned-model`); this spec's L2 lands first (it owns the reconcile path), then that lane rebases. `LiveDashboard.astro` (L3's panel copy) is shared with the seven site lanes the sibling specs name (`long-messages`, `markdown-wordwrap-qa`, `brain-tree-site`, `brain-toc`, `entity-colour`, `entity-filter`, `agent-model-rows`); the lead serialises them.

## 5. What this spec does NOT settle

- Retiring the idle branch of the activity edge: it stays for old listeners until a measured month shows none.
- Client-side publishing (draft 1's design): rejected on measurement; recorded so it is not proposed again without a per-principal read topic the site can subscribe to, which Realtime's authorization model does not offer today.
- Successor 2 (one daemon per machine) is unchanged by this spec.

## 6. What was NOT established

- Whether the awaited `realtime.send` adds measurable latency to the reconcile; L1's test times a read with and without a frame.
- The panel's preferred wording for an idle seat; `idle · seen N min ago` is the proposal.
