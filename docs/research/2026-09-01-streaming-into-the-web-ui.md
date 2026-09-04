# Streaming into the web UI — design investigation

**Date:** 2026-09-01 · **Tree:** `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · **Branch:** `main` @ `619ff1f`
**Status: investigation only.** Nothing was edited, committed, deployed, or pushed. No `supabase db push`, no local Supabase started. Every live probe below was a read-only HTTP/WebSocket call against production.

---

## 1. Executive summary

### What is achievable

**Feature A (streaming message composition) is achievable and is a small-to-medium build.** The partial text already exists, per chunk, in a callback the CLI already owns: `src/host/session.ts:719` calls `this.events.update?.(sanitized)` for every `agent_message_chunk` the ACP child emits. Nothing needs to be invented to *capture* partial output — it is thrown away today. Supabase Realtime broadcast is live on the production project (measured, §3.1) and gives a ~50 ms path to the browser.

**Feature B (live agent view) splits into two very different things, and the split is the honest core of this report:**

| What the operator asked for | Verdict |
|---|---|
| *"see exactly what any agent is doing, as if I opened their terminal"* for an agent whose work runs through `cswarm listen` | **Achievable as a structured activity stream, NOT as a terminal.** We already receive typed ACP events — message chunks, thoughts, tool calls with titles and statuses, plans. That is richer than a scraped pane. It is not a TUI and will not look like one. |
| The same, for an agent that merely holds a credential and posts with `cswarm note` / `ask` / `reply` | **Not achievable at all.** We are not in that process. We see nothing between posts. This is most agents today, including the ones in this repo's own fleet. |
| A raw pixel/ANSI copy of a human's interactive terminal (a cmux tab, a Claude Code session someone is typing in) | **Not achievable, and the repo has already ruled against building toward it.** See §5.3. |

### The single most important existing decision

`src/host/stderr-tail.ts:9-16` already decided the raw-terminal question, in writing, after a real incident:

> "That privacy concern is real, so the capture stays **LOCAL-ONLY**: the tail is handed to a callback whose only consumers write the operator's own 0600 listener log. **It must never ride an error object** — errors travel through retries, replies, and server payloads; the tail must not. That is why `AcpChildExitError` carries no tail field **and never will**."

And the canonical spec made the same call as a product decision, `docs/design/SWARM-CLOUD.md:992`:

> "**live steering is load-bearing, so any default transport must be watchable and tunable — and ACP satisfies that structurally.** Its streamed tool-calls feed the board a richer live view than a scraped pane ever gave … **visibility and tunability are met by the structured stream, not by a terminal tab.**"

So Feature B is not blocked by missing infrastructure. It is blocked by a decision that has already been made *against* streaming raw terminal bytes off a user's laptop. **Reversing it is an operator call, not an implementation detail.** The good news is that the thing the spec chose instead is genuinely better for the panel, and it is what I recommend building.

### The recommended first slice

**Ship the agent-activity panel over Realtime broadcast, live-status only, listener agents only, with an explicit "not instrumented" state for everyone else.**

Concretely: the listener publishes a coalesced status frame (≤ 2/sec, §3.1) to a private per-workspace Realtime channel — *what signal it is working, which phase, which tool it is running right now, elapsed time*. The existing entity panel (`site/src/lib/entity-panel.ts:16-56`) grows a **LIVE** section above the credential fields. Agents that are not listener-run render `Not instrumented — this agent posts messages but does not run through cswarm listen`.

Why this first:
- It is the operator's actual want ("what is this agent doing right now") minus the part that is a security reversal.
- It reuses the panel that already exists and already opens on click.
- Every ingredient is measured present: the ACP event hook, the sanitizer, working Realtime, an authorization-enforced private channel.
- It needs **no schema migration and no new table** — status is genuinely ephemeral (§4.2), so the durability rule is satisfied by not persisting it.

Feature A (token streaming into the transcript) is the natural second slice on the same channel and the same authorization.

### What I could not establish

The measured Realtime throughput ceiling is **about 2 frames/second per channel, with silent loss above it and `send()` returning `"ok"` for every dropped frame** (§3.1). I did not isolate whether that limit is per-channel, per-client, or per-project, and it is very likely a raisable project setting. **This number is load-bearing for both designs and should be re-measured, and the project quota checked, before anyone commits to a frame rate.** Full list in §8.

---

## 2. What exists today

### 2.1 The agent side — partial output is already in memory, already sanitized

**The seam is one line.** `src/host/session.ts:719`:

```ts
this.events.update?.(sanitized);
```

That fires once per ACP `session/update` notification. The payload type, `src/host/types.ts:60-70`:

```ts
export type SanitizedSessionUpdate = {
  kind: SessionUpdateKind;      // agent_message_chunk | agent_thought_chunk
                                // | tool_call | tool_call_update | plan
                                // | available_commands_update | unknown
  sessionId: string;
  text?: string;                // chunk text, already through sanitizeText()
  toolCallId?: string;
  title?: string;               // tool title, e.g. "Read src/cli.ts"
  status?: string;
  toolKind?: string;
  detail?: Record<string, unknown>;  // "Redacted structural fields only"
};
```

Granularity: **per chunk, as the provider emits it** — `src/host/session.ts:496` dispatches `session/update`, `:658` handles it, `:677-682` extracts chunk text. This is the provider's streaming granularity, typically a few tokens to a sentence, not one token.

Today those chunks are consumed and discarded. `src/host/session.ts:608-636` installs a temporary interceptor during a prompt that concatenates `agent_message_chunk` text into `message`, and `src/host/session.ts:648` returns `{ stopReason, message, updates }`. **The full `updates` array is already retained and returned** — so even the structured event history exists per turn. It is simply never sent anywhere.

The hook is declared as a first-class option, `src/host/types.ts:86-89`:

```ts
export type HostSessionEvents = {
  update?: (update: SanitizedSessionUpdate) => void;
  notification?: (method: string, params: unknown) => void;
};
```

and is already plumbed through the provider adapters: `src/host/claude.ts:509` and `src/host/opencode.ts:847` both pass `events: options.events` down.

**Redaction already runs on this path** — `src/host/sanitize.ts`, whose header (`:1-5`) says exactly why it exists: *"Redact secret-like material from session updates exposed to host callers. Tool rawInput/rawOutput may contain commands, tokens, or env dumps — never leak them through the host's public update surface."* Specifics in §6.1.

### 2.2 The listener — a per-signal state machine that never leaves the laptop

`src/listener/types.ts:13-21` defines the states:

```ts
export type ListenerEffectState =
  | "received" | "prompting" | "reply_ready" | "posting"
  | "done" | "expired" | "failed" | "observed" | "routed_main";
```

That *is* "what is this agent doing right now", at a coarse grain, and it is already computed and already durable — **locally**. It is written to an owned 0600 file store (`src/listener/file-store.ts`) via `ListenerEffectStore` (`src/listener/types.ts:54-57`), and the record carries `promptAttempts`, `postAttempts`, `failureCode`, `updatedAt` (`src/listener/types.ts:36-52`). The engine drives it: `src/listener/engine.ts:484` is the `model.prompt(...)` call, wrapped in the state transitions at `:474-512`.

**None of it is reported to the cloud.** The listener posts exactly two things beyond ordinary signals: `claim_agent_inbox` and `ack_agent_delivery` (`src/cloud/delivery.ts:730,756,787`). I grepped `src/` for `heartbeat`, `presence`, `last_seen`, `activity` — the only two hits are unrelated prose in comments (`src/host/session.ts:399`, `src/protocol/workspace-reducer.ts:311`). **There is no liveness or status channel to the server today.** The canonical spec anticipated one and it was never built — `docs/design/SWARM-CLOUD.md:320`: *"No Supabase Presence in v1. Hooks and ordinary CLI commands POST throttled authenticated heartbeats to a TTL soft-state table on server time."* No such table exists in any of the 29 migrations.

### 2.3 The cloud — everything is a buffered JSON round-trip

Every response from every edge function is a fully buffered `JSON.stringify` string. The complete inventory of `new Response(` under `supabase/functions/`:

| Site | Body |
|---|---|
| `supabase/functions/read/index.ts:122` | `JSON.stringify(body)` |
| `supabase/functions/command/index.ts:1152` | `JSON.stringify(body)` |
| `supabase/functions/capability/index.ts:291` | `JSON.stringify(body)` |
| `supabase/functions/capability/index.ts:312` | `null` (204 preflight) |
| `supabase/functions/command/cors.ts:61` | `null` (204 preflight) |
| `supabase/functions/command/cors.ts:73` | rewrap of an already-buffered response, to attach CORS headers |

Zero occurrences of `ReadableStream`, `TransformStream`, `text/event-stream`, `pipeThrough`, or chunked transfer anywhere in `supabase/`. The only two `getReader()` calls are on the *request* body (`command/index.ts:1218`, `capability/index.ts:371`), both bounded accumulate-then-parse loops that abort at 128 KiB.

**There is no streaming, no SSE, no long-poll, and no push anywhere in the backend.** Liveness is entirely client-side polling.

The `read` function does support incremental reads well: a keyset cursor `(after_created_at, after_id)` (`supabase/functions/read/index.ts:215-221, 546-550, 605-617`), advertised as `capabilities.cursor_after: 1` (`:97-100`), max page size **100** (`:257-259`).

**The `read` function IS deployed.** Measured: `POST https://api.commonswarm.com/functions/v1/read` returns **405** (method check at `read/index.ts:311-313`) while `functions/v1/nope` returns **404** — a discriminating pair. Response headers carry `x-served-by: supabase-edge-runtime`, `sb-project-ref: ukezjcnxjvkpkeezxaew`. *(This corrects a stale claim in `docs/design/contracts/UI-ENTITY-PANEL-GOAL.md`, which says "the `read` function is not deployed" — true in the D-044 era, not true now.)*

### 2.4 The browser — polling, no realtime, and a panel that is already built

- **One Supabase client per page**, `site/src/lib/commonswarm.ts:115`, created with **only** auth options — no `realtime` config block:
  ```ts
  cached = createClient(d.url, d.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  ```
- **Realtime is not used at all.** I grepped `site/src/` for `.channel(`, `realtime`, `EventSource`, `WebSocket` — **zero hits.** (The many `broadcast` hits in `LiveDashboard.astro` are the product's own "broadcast signal" concept, unrelated.)
- `@supabase/realtime-js@2.110.8` is already in the tree as a transitive dependency of `@supabase/supabase-js` (`package-lock.json:514,547`), in both the root and `site/` manifests. **Adding Realtime requires no new dependency.**

**Refresh loops in `LiveDashboard.astro`:**

| Line | Cadence | Calls | Visibility-gated |
|---|---|---|---|
| `4041` (`armLiveFeed`, defined `4033`) | **2,000 ms** `setInterval` | `refreshLatestSignals()` | **Yes** — armed only when `document.visibilityState === "visible"` (`:4037`), cleared on `visibilitychange` (`:4102`); `refreshLatestSignals` re-checks (`:3765`) |
| `3903` | `PENDING_POLL_TICK_MS = 4_000` (`:3888`) | `renderPendingAccess()` + `refreshPendingAccess()` | Yes (`:3897-3899`) |
| `3408` | dynamic — next signal `until` expiry, clamped `[25 ms, 2^31-1]` | `renderFeed` | No |

One `visibilitychange` listener at `:4099-4113` plus a `focus` listener at `:4115`. **The polling is already well-behaved** — it pauses when the tab is hidden, which is more than the design doc's Appendix A fallback asks for.

**Signals are read straight from PostgREST, not from the `read` edge function.** `site/src/lib/commonswarm.ts:1883-1896` (`feed()`) uses `c.schema("swarm_read").from("signals")`; the dashboard has its own inline keyset query `signalPage` at `LiveDashboard.astro:1695-1737` (`:1702-1707`), called at `:3742` (older) and `:3770` (live poll). The `read` edge function is used by the browser for exactly one thing: `renewal_grants` inside `agentAccessStatuses()` (`commonswarm.ts:657`). Writes go to `functions/v1/command` (`commonswarm.ts:404`).

**⚠️ The transcript is a full rebuild on every poll.** `renderFeed` at `LiveDashboard.astro:3393` calls `list.replaceChildren()` at **`:3431`** and re-creates every `<li>` from scratch from `:3470`. No keying, no diffing, no append path — `renderFeed("latest")` from `refreshLatestSignals` (`:3795`) takes the same branch; the argument only affects scroll anchoring. `previousSignalIds` (`:1092`) exists but drives new-row highlighting, not incremental DOM updates. **This is the main structural obstacle to Feature A** and is sized in §4.4.

**The entity panel the operator described already exists, fully wired.**

| Piece | Line |
|---|---|
| Markup — `<aside class="dashboard__entity-panel" data-entity-panel … hidden>` | `LiveDashboard.astro:719-740` |
| `openEntityPanel(entity, trigger)` | `:1951-1965` |
| `closeEntityPanel(restoreFocus)` | `:1770-1782` |
| `renderEntityPanel()` — `body.replaceChildren()` at `:1839`, agent branch `:1852`, **runtime `<dl>` `:1900-1923`** | `:1836-1949` |
| `entityControl(...)` — makes every name in the stream a `<button>` that opens it | `:1785-1798`, used at `:3512, 3527, 3533, 3553, 3579, 2315` |
| View model `AgentEntityView` | `site/src/lib/entity-panel.ts:16-56` (honest `"Model not specified"` default at `:38`) |
| Data source `AgentAccessStatus` (20 fields) | `site/src/lib/commonswarm.ts:623-644` |

It is chartered by `docs/design/contracts/UI-ENTITY-PANEL-GOAL.md` and specified in `docs/design/2026-08-03-SLACK-SHAPE-UI.md:123-140` ("The agent profile panel"), which already lists **"current status (*'Listening. Working the claim path refactor.'*)"** as its first field — a field with no data source today.

**The operator's ask is precisely: fill in that first field with something live, and put it where the avatar is.** The container, the click trigger, the focus handling, and even a `runtime` section (`:1900-1923`) are already built.

---

## 3. Transport options

### 3.1 Measured facts about Supabase Realtime on THIS project

All measured 2026-09-01 against `https://api.commonswarm.com` with the anon key from `site/.env`, using the already-installed `@supabase/supabase-js`.

| Probe | Result |
|---|---|
| Broadcast channel subscribe + round-trip | **SUBSCRIBED, round-trip OK.** Realtime is enabled and reachable through the custom domain. |
| Private channel (`config: { private: true }`) with anon key, **no user JWT** | **`CHANNEL_ERROR — "Unauthorized: You do not have permissions to read from this Channel topic"`.** Realtime Authorization is active and fail-closed. This is the mechanism a workspace-scoped channel needs. |
| Latency, two separate clients, 2 frames/sec, 400-byte payload | **20/20 delivered. p50 54 ms, max 133 ms.** |
| Same at ~4/sec | **4 of 20 delivered.** |
| Same at ~10/sec | **5 of 30 delivered.** |
| `channel.send()` return value at 10/sec | **`{"ok": 30}` — every one of 30 sends acked "ok", 5 arrived.** |

**Two findings that shape everything below:**

1. **Usable throughput measured at about 2 frames/second per channel.** Above that, frames are lost.
2. **The loss is silent and the acknowledgement is success-shaped.** `send()` returned `"ok"` for 30 of 30 sends when 25 were dropped. This is exactly the failure family `AGENTS.md` names in *"a true word in a success-shaped response gets skipped"* — except here the word is not even true. **Any design over this transport must treat delivery as best-effort and must carry a sequence number so the receiver can see a gap, not trust the ack.**

I did **not** establish whether the ceiling is per-channel, per-client, or a project-wide `max_events_per_second` quota, nor whether it is raisable in the project dashboard. It probably is. Re-measure before choosing a frame rate.

### 3.2 The options

| Option | Latency | Auth | Volume ceiling | What breaks at 10–20 agents | Verdict |
|---|---|---|---|---|---|
| **Realtime Broadcast, private channel** (`realtime.send()` from the edge function, or client-side `channel.send()`) | **p50 ~50 ms, measured** | **Enforced, measured fail-closed.** RLS on `realtime.messages` scopes a topic to workspace members. | **~2 frames/sec/channel, measured.** Silent loss above. | One channel per *agent* keeps per-channel rate independent; a single workspace-wide channel would be the bottleneck. At 20 agents on 20 channels the browser holds 1 socket (channels multiplex) but must handle 40 frames/sec of decode. Fine. | ✅ **Recommended.** Only option with sub-100 ms latency, working auth, and zero new infrastructure. |
| **Realtime `postgres_changes`** | ~100 ms | **Broken by design here.** | n/a | n/a | ❌ **Not viable.** `swarm.signals` is `REVOKE ALL … FROM PUBLIC, anon, authenticated` (`supabase/migrations/20260724000003_signals.sql:40`) with a policy only for `swarm_command` (`:32-34`). Browser reads go through the **view** `swarm_read.signals`, and **views cannot be added to a publication**. `postgres_changes` applies RLS against the base table as the subscribing role, which has no grant. It would deliver nothing. Also: no `ALTER PUBLICATION` exists in any of the 29 migrations. ⚠️ A `postgres_changes` subscribe returns `SUBSCRIBED` even for `nosuchschema.nope` — I measured this. **`SUBSCRIBED` is not evidence the subscription works.** |
| **SSE from an edge function** | ~50 ms once open | Bearer header works (not `EventSource`, which cannot set headers — would need `fetch` + `ReadableStream`) | Bounded by the function wall-clock limit | Each open stream pins an edge invocation. 20 agents × N watchers = N×20 concurrent long-lived invocations, billed and quota'd. | ⚠️ **Possible but worse.** Requires writing the first streaming response in the codebase (§2.3: there are none). The wall-clock ceiling means every stream must reconnect on a timer. **I did not measure the platform limit** — Supabase publishes 150 s (Free) / 400 s (Pro); the project is Pro (the $10/mo custom-domain add-on requires it), so ~400 s is the likely ceiling, **unverified**. Reconnect-every-6-minutes is worse ergonomics than a socket that stays up, for no latency gain. |
| **Poll a tail table** | 2 s (the current cadence) | Reuses the existing view + RLS pattern. Well-understood. | Write side is the killer. | 20 agents × 2 frames/sec = 40 writes/sec = 144,000/hour. | ❌ **Not viable for frames.** `SIGNAL_CREDENTIAL_LIMIT` is **120/hour per credential** (`supabase/functions/command/index.ts:517`) — one write per 30 s. Even a new dedicated table would need its own limits and a purge job, and the read side still costs a round-trip per agent per poll. |
| **Storage blobs** (`swarm-files`) | seconds | Signed URLs, 300 s TTL (`file-artifacts.ts:50`) | 30 uploads/hour (`file-artifacts.ts:47`) | — | ❌ **Not viable.** Rate limit alone rules it out; the MIME/extension allowlist (`file-artifacts.ts:60-64`) rejects anything not in a document/image set. |
| **Direct laptop→browser (WebRTC / tunnel)** | lowest | We would have to build it | unbounded | — | ❌ **Out of scope and against the architecture.** `docs/design/SWARM-CLOUD.md:290`: *"Agents prompt each other across machines through the coordination plane, never through a direct agent-to-agent socket — that indirection is where auth, tenancy, ordering, and audit live."* |

### 3.3 The rule this must respect

`docs/design/P1-COMMAND-API.md:618` already states the contract, and both features must honour it verbatim:

> "**Realtime/Broadcast (P3) is a latency hint only; cursor replay is the delivery-of-record.**"

Nothing streamed may ever become the authority for anything. The durable row and the existing cursor path stay exactly as they are.

---

## 4. Feature A — streaming message composition

### 4.1 Shape

```
ACP child
  │  session/update {agent_message_chunk, text:"…"}
  ▼
src/host/session.ts:719  events.update(sanitized)          ← the seam, exists today
  │
  ├─► existing: accumulate into `message` (session.ts:627-635)   [UNCHANGED]
  │
  └─► NEW: coalescing buffer, flush ≤ 2/sec
        │
        ▼
      Realtime broadcast → private topic  ws:<workspace_id>:agent:<principal_id>
        payload { seq, signal_id, phase:"drafting", delta:"…", chars_so_far }
        │
        ▼
      browser: append to a PROVISIONAL bubble in the transcript
        │
        ▼
      the real signal lands via the existing 2 s poll → provisional bubble
      is REPLACED by the durable row, keyed on signal_id
```

### 4.2 The durability boundary

| Thing | Where it lives | Why |
|---|---|---|
| The finished message | `swarm.signals.body`, unchanged — the only `INSERT INTO swarm.signals` in the repo is `supabase/functions/command/index.ts:5963-5985` | Delivery-of-record. Untouched by this feature. |
| Delivery / claim / ack state | `swarm.signal_deliveries`, unchanged | Durable by default. Untouched. |
| **In-flight chunks** | **Nowhere. RAM on both ends.** | Legitimately re-derivable: the final message supersedes every chunk within seconds. `AGENTS.md` permits RAM "for genuinely re-derivable state" — this is the clean case. |

**What happens when nobody is watching:** the listener publishes anyway (fire-and-forget, no subscriber check) or, better, publishes only while a `presence`-tracked watcher is on the topic. Either way, dropping every frame changes nothing about the outcome — the durable signal still posts through the unchanged path. **This is the property that makes Feature A safe: it is decorative on the success path and invisible on the failure path.**

### 4.3 Non-obvious requirements

1. **A sequence number per stream, and a visible gap.** Frames are silently lost above ~2/sec (§3.1) and `send()` lies about it. The browser must render a gap honestly rather than concatenating across it. Given the provisional bubble is replaced by the durable row within seconds, showing `…` for a gap is sufficient and truthful.
2. **Coalesce, do not forward.** A provider emitting 20 chunks/sec into a 2/sec transport loses 90% of them. Buffer deltas and flush on a timer.
3. **The provisional bubble must be visually distinct and must never be quotable, copyable-as-final, or receipt-eligible.** It is not a signal. It has no id, no `until`, no addressing. This repo's rule against surfaces implying more than they measure applies directly.
4. **The existing accumulator must not be disturbed.** `src/host/session.ts:608-636` carries a load-bearing D-086 fix — text is accumulated only from `fromOurSession`. A new sink must sit *beside* it under the same session check, never replace it.

### 4.4 The obstacle nobody would guess from the backend

**`renderFeed` destroys and rebuilds the entire transcript every 2 seconds** — `list.replaceChildren()` at `site/src/components/app/LiveDashboard.astro:3431`, full re-creation from `:3470`, no keying and no diffing (§2.4). A provisional streaming bubble appended into that `<ul>` would be **wiped on the next poll tick**, roughly twice per second of streaming.

Three ways out, cheapest first:

| Approach | Cost | Note |
|---|---|---|
| **Render the provisional bubble OUTSIDE the `<ul>`** — a sibling element pinned below the last row, owned by the stream code and never touched by `renderFeed` | **Small.** No change to `renderFeed` at all. | Loses in-list positioning if several agents stream at once; acceptable for one-at-a-time. |
| Teach `renderFeed` to preserve nodes carrying a `data-provisional` attribute across the rebuild | Medium | One targeted change to a function with load-bearing scroll-anchoring geometry (`:3414-3419`). |
| Make `renderFeed` keyed/diffed | **Large** | A real improvement for the whole dashboard, and out of scope for this feature. |

**Take the first.** It keeps Feature A entirely additive and leaves `renderFeed` — which has scroll anchoring, seen-reporting, and highlighting entangled in it — untouched.

**Size: MEDIUM.** The capture is a handful of lines at an existing hook; the transport is Phase 1's channel; the browser work is a self-contained provisional element plus reconciliation on the polled row. Without the sibling-element trick it would be LARGE, because it would mean reworking `renderFeed`.

---

## 5. Feature B — the live agent view

### 5.1 The honest capability split

This is the part that must not be softened. **Three populations, three different truths.**

**(a) Listener-run agents — `cswarm listen start --provider grok|opencode|claude|codex`** (`src/cli.ts:490`).
We host the ACP child. We receive typed events for everything it does: message chunks, thought chunks, tool calls with titles and statuses, plans (`src/host/types.ts:51-58`). We also own the per-signal state machine (`src/listener/types.ts:13-21`).
**We can truthfully show: which signal it is working, which phase, which tool is running right now with its title, elapsed time, turn budget remaining, and streaming reply text.**
**We cannot show a terminal**, because there is no terminal — the child is a JSON-RPC subprocess over stdio pipes, not a pty. There are no ANSI frames to forward. A "TUI view" of a listener agent would be something we *render*, not something we *capture*.

**(b) Credential-holding agents — everything else.**
Every agent that runs `cswarm note`, `ask`, `reply`, `feed`, `inbox` with a token. Our CLI is a short-lived process that posts and exits. **Between posts we are not running and we observe nothing.** No amount of backend work changes this; the information does not exist on our side of the wire.
**The panel must say so plainly.** Something like: *"Not instrumented. This agent posts messages but does not run through `cswarm listen`, so there is nothing live to show."* Followed by what we *do* honestly know — last post time, credential state.

**(c) A human's interactive terminal — a cmux tab, a Claude Code session someone is typing in.**
We are not in that process at all. **Nothing is capturable.** The operator's phrase *"just as if I opened their terminal"* describes this case, and it is the one case that is flatly impossible.

**Most agents in this repo's own fleet are (b) or (c).** So the honest headline is: **"exactly what any agent is doing" is achievable for listener-run work only, and even there it is a structured activity view rather than a terminal.**

### 5.2 What the panel shows, per population

```
┌─ mercury                                    AGENT ─┐
│  operated by Tom Yulan                             │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │   ← where the avatar is
│  │ ● LIVE            [listener · claude · 4m12s]│  │
│  │                                              │  │
│  │ Working  ask 8f3a…  "audit the retry path"   │  │
│  │ Phase    prompting                           │  │
│  │ Now      Read  src/cloud/signals.ts          │  │
│  │                                              │  │
│  │ ▸ Grep  "nextFollowBackoffMs"        done    │  │
│  │ ▸ Read  src/cloud/delivery.ts        done    │  │
│  │ ▸ Read  src/cloud/signals.ts      running    │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  PRINCIPAL  …existing fields, unchanged…           │
└────────────────────────────────────────────────────┘
```

For (b) and (c) the same box renders the not-instrumented state and nothing else. **One component, two states, and the empty state is a sentence, not a spinner.** A spinner implies data is coming.

### 5.3 The decision that has to be made explicitly

Building (a) needs **no** policy reversal — `SanitizedSessionUpdate` was designed to be exposed to host callers (`src/host/sanitize.ts:1-5`) and the spec already chose the structured stream over the terminal (`docs/design/SWARM-CLOUD.md:992, 1067`).

Building a **real** terminal view would need to reverse `src/host/stderr-tail.ts:9-16`, which says the capture is local-only and *"must never ride an error object … and never will."* That decision was made after a measured incident and is defended by the bounded ring buffer, the ANSI strip, the credential-prefix redactor, and the deliberate absence of a `tail` field on `AcpChildExitError`.

**My recommendation: do not reverse it.** The structured view is more useful (it is queryable, diffable, and renderable at any width), it carries far less secret-bearing material, and it is what the spec already promised. If the operator specifically wants a terminal, that is a separate, explicit decision with its own review — not a phase of this work.

### 5.4 Where the data comes from

Nothing new is needed on the capture side:

| Panel field | Source, today |
|---|---|
| phase | `ListenerEffectState`, `src/listener/types.ts:13-21` |
| which signal | `ListenerEffectRecord.signalId`, `src/listener/types.ts:38` |
| current tool + title + status | `SanitizedSessionUpdate{toolCallId,title,status,toolKind}`, `src/host/types.ts:60-70`, emitted at `src/host/session.ts:719` |
| provider / model | already on the panel, `site/src/lib/entity-panel.ts:38` |
| elapsed / budget | `--turn-budget`, `src/cli.ts:564-574` |
| liveness | presence on the Realtime topic — no new table |

The **only** new plumbing is the publish call in the listener and the subscribe in the panel.

---

## 6. Privacy and security model

### 6.1 What redaction exists, and what it does not catch

`src/host/sanitize.ts` runs on every update before it reaches any caller. Two layers:

- **Key-based drop** (`:32-40`): any object key matching `/secret|token|password|authorization|api[_-]?key|credential/i` becomes `[redacted]`, and `rawInput`, `rawOutput`, `env` are dropped wholesale. **This is the strong layer** — and note `handleSessionUpdate` never even builds `detail` from tool payloads, only from `{kind, status, title}` (`src/host/session.ts:707-711`), so raw tool I/O does not reach the update surface at all.
- **Value-pattern redaction** (`:7-16`): `SECRET_VALUE_RE` catches `api_key: …` / `token = …` style assignments of ≥8 chars; `JWT_RE` catches `eyJ…` triplets. Strings are truncated at 4,096 chars (`:21-23`).

**What this does NOT catch, and must be stated in any review:**
- A bare secret on its own line with no `key:` prefix — `sk-ant-api03-…`, `ghp_…`, an AWS key, a private key body. `stderr-tail.ts` has a `CREDENTIAL_PREFIX_RE` for exactly this; `sanitize.ts` does not.
- File contents the model quotes back in prose. An `agent_message_chunk` saying *"the .env has `FOO=…`"* is the model's own text and flows through `sanitizeText` only.
- Anything in the tool **title**, which is passed through `sanitizeText` (`src/host/session.ts:684`) but is otherwise free text from the provider.

**Recommendation:** before any of this leaves the machine, port `stderr-tail.ts`'s `CREDENTIAL_PREFIX_RE` and its exotic-separator normalisation (`src/host/stderr-tail.ts:27-47` — the machinery that reassembles a token laced with zero-width joiners *before* redacting) into the shared path. That code exists, is reasoned, and was written after a real leak. **Do not write a second redactor beside it.**

### 6.2 Consent

The `ps` argv scar is directly relevant and the repo already acts on it: `src/cli.ts:4792` — *"listen start requires --agent-token-file or --agent-token-stdin; credentials are never accepted on argv."* Streaming an agent's working output is a strictly larger exposure than argv, because it includes file contents the agent read.

**Proposal, minimal and defensible:**
- **Opt-in per listener, at start.** A `cswarm listen start --share-activity` flag. **Default off.** An operator who never passes it streams nothing and the panel shows "not instrumented" for their agent, which is *true*.
- **The CLI states what it will share, once, at start** — in the product voice, naming the surface: which fields go up, that they are workspace-visible, and the exact command to stop.
- **Presence is visible both ways.** If a teammate opens the panel, the agent's operator can see that someone is watching. Asymmetric observation of a colleague's machine is a trust problem, not a feature.

### 6.3 Who may watch whom

Two defensible positions:

| Model | Rule | Argument |
|---|---|---|
| **Workspace members** | Any live member of the workspace may open any agent's live panel | Matches the existing signal-visibility boundary — `swarm.is_member` (`supabase/migrations/20260820000002_archive_revokes_access.sql:4-26`) — and matches the mockup's premise that the workspace is a room everyone is in. |
| **Operator only** | Only `agent.owner_user_id` may watch | Matches the "own fleet only" principle the spec already applies to redirects (`docs/design/SWARM-CLOUD.md:289`: *"only the local human or the local coordinator may initiate that tool-enabled turn"*). |

**I would ship operator-only first** and widen it deliberately. Widening later is easy; narrowing after teammates have been watching each other's machines is a retraction. The mechanism is identical either way — an RLS policy on `realtime.messages` for the topic — so the choice costs nothing to defer *in the narrow direction only*.

The authorization mechanism is measured working: a private channel refused an anon client with *"Unauthorized: You do not have permissions to read from this Channel topic"* (§3.1).

### 6.4 One thing that must not ship

**No copy on this panel may assert who can or cannot see something.** `docs/design/contracts/UI-ENTITY-PANEL-GOAL.md` already forbids it for the existing panel — *"No statement about who can read a signal. No 'only X can see this', no lock icon, no 'private'"* — and there is a green assertion defending that. A live panel is exactly where someone will be tempted to add "only you can see this". **State what is shared. Never state who can read it.**

---

## 7. Phased plan

| # | Phase | Size | Ships what | Depends on |
|---|---|---|---|---|
| **1** | **Live status in the entity panel** — listener publishes a coalesced status frame (signal, phase, current tool title, elapsed) to a private per-agent Realtime topic; panel subscribes and renders it, with an honest not-instrumented state for non-listener agents | **M** | **The operator's actual ask, minus the security reversal.** Answers "what is this agent doing right now" for every listener-run agent. | Publish at `src/host/session.ts:719`; render in `renderEntityPanel` beside the runtime `<dl>` at `LiveDashboard.astro:1900-1923`; RLS policy on `realtime.messages`; `--share-activity` flag; a `realtime` block in `createClient` (`site/src/lib/commonswarm.ts:115`) |
| **2** | **Tool-call activity log in the panel** — the last N tool calls with status, from the same frames | **S** | Turns a one-line status into "what has it been doing", which is most of the felt value of watching a terminal | Phase 1. Panel body is already `replaceChildren`-rendered (`:1839`), so a list is cheap here — unlike the feed |
| **3** | **Streaming reply text (Feature A)** — provisional bubble in the transcript, replaced by the durable row | **M** | Token-by-token composition in the feed | Phase 1's channel + auth; the sibling-element approach from §4.4, so `renderFeed` is not touched |
| **4** | **Realtime wake for the feed** — an event refresh on top of the existing 2 s poll, which stays as the fallback | **S–M** | Lower latency for the whole dashboard. Listed in `TODO.md:551` as "realtime wake hints", and `docs/design/P1-COMMAND-API.md:618` already fixes the contract: the wake is a hint, cursor replay stays delivery-of-record. The poll is already visibility-gated (`:4037`) so this is an addition, not a replacement | Phase 1 |
| **5** | **Raw terminal view** | **L** | The literal ask | **A reversal of `src/host/stderr-tail.ts:9-16` and its own security review.** Not recommended; listed for completeness. |

**Phase 1 is the genuinely useful first slice** and I would ship it alone. It is the only phase that changes what the operator can *know*; 2 and 3 make it nicer, 4 makes the rest of the app faster.

**Before Phase 1 starts, one measurement is required** (30 minutes, no code): re-run the throughput probe in §3.1 and check the project's Realtime quota in the dashboard. **If the ceiling really is ~2 frames/sec, the frame budget for the whole workspace has to be designed around it, and that changes the shape of Phase 1** — one topic per agent rather than one per workspace, and a 500 ms coalescing floor.

---

## 8. Open questions and what I could NOT establish

**Measured, but incompletely:**

1. **The Realtime rate ceiling.** I measured 20/20 at 2/sec, 4/20 at 4/sec, 5/30 at 10/sec, two separate clients, `send()` acking `"ok"` every time. I did **not** isolate whether the limit is per-channel, per-client, or per-project, and did **not** check the project's Realtime quota in the Supabase dashboard. **This number is load-bearing and should be re-measured before committing to a frame rate.**
2. **Whether `realtime.send()` (broadcast-from-database, callable from the edge function or a trigger) is available on this project.** The private-channel probe proves Realtime Authorization is on, which strongly implies the same version ships `realtime.send()`. I did not call it. This matters for Feature A: publishing from the `command` function would be cleaner than publishing from the CLI. **Check with:** `select proname from pg_proc join pg_namespace n on n.oid=pronamespace where n.nspname='realtime' and proname in ('send','broadcast_changes');`

**Not measured at all:**

3. **The edge-function wall-clock limit on this project.** Supabase publishes 150 s (Free) / 400 s (Pro); the project is Pro by inference (the custom-domain add-on requires it), but I did not verify the tier or the limit. Only matters if SSE is chosen over Realtime — and I recommend it is not.
4. **Whether Cloudflare (which fronts `api.commonswarm.com`, per the `server: cloudflare` header) buffers `text/event-stream`.** Same conditional relevance.
5. **Realtime's cost on this plan.** I did not measure billing for concurrent connections or message volume. At 20 agents × 2 frames/sec × N watchers this is a real number and nobody has looked at it.
6. **Whether the four providers differ in chunk granularity.** I read the shared ACP path (`src/host/session.ts`) but not each adapter's emission rate. Claude, Codex, Grok, and OpenCode may stream at very different rates, which changes the coalescing budget per provider.
7. **Whether presence-gating the publish is worth it.** I assumed the listener can cheaply learn whether anyone is watching (Realtime presence). Not verified.
8. **I did not run any of this against a real workspace with a live listener.** Every claim about the ACP event stream is read from source, not observed in flight. The chunk *granularity* in particular — "a few tokens to a sentence" — is inferred from the ACP protocol shape, **not measured**.
9. **`gtimeout`/`timeout` were not used anywhere in this investigation**, so none of the zeros above are the documented dead-command artifact. Every negative result here has a matched positive control on the same invocation, except where §3.1 notes the `postgres_changes` `SUBSCRIBED` control *failed* — which is why that row says the probe proves nothing.

**Corrections to existing artifacts found along the way:**

10. `docs/design/contracts/UI-ENTITY-PANEL-GOAL.md` states *"the `read` function is not deployed"*. **Dead.** Measured 405-vs-404 with `x-served-by: supabase-edge-runtime` — it is deployed. That doc's known-issues section reasons from the stale state.
11. The same doc cites `AgentAccessStatus` at `site/src/lib/commonswarm.ts:594-605`. **Stale** — it is now at `:623-644` and carries 20 fields, not the shorter set the doc lists.
12. `supabase/config.toml` comments cite `command/index.ts:4516/4529/4541` for the `verify_jwt = false` rationale. **Those line numbers are stale**; the real ones are `7890 / 7895 / 7911`.
13. `supabase/functions/command/index.ts:655` describes the `signal_post` spend proxy as *"row writes plus Realtime fan-out"*. **There is no Realtime fan-out.** The comment is aspirational and reads as a statement of current behaviour.
