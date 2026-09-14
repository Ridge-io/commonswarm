# Grok Bot same-session wake — research (no implementation)

Implementation note (2026-09-14): this research is preserved as the pre-change record.
The branch implementation and its idle-assertion limit are described in
[GROK-BOT-SAME-SESSION-WAKE.md](GROK-BOT-SAME-SESSION-WAKE.md). The sketch below
proposed persisting a gateway URL; the implementation instead resolves loopback
and the port at serve time. No gateway token is stored in the binding.

Date: 2026-09-13 (America/Chicago). Branch: `feat/grok-bot-same-session-wake`.
Target chat: **YulanOps**, agent id `9c3388a6-717b-4e94-b9c5-5e0733bb9078`.
Constraint: wake **this** session only — no new model, no `cswarm listen start --provider grok`.
Preferred product shape: same path agents use when another Bot wakes a chat (host injects a prompt into an existing seat), not a bolted-on webhook.

This doc ranks what is real on this computer today. **Do not treat any path as `wake_verified` until an idle canary passes.**

---

## Recommendation (ranked)

| Rank | Path | Status on this Bot | Use for CS `receive serve`? |
|------|------|--------------------|-----------------------------|
| **1** | **Local host gateway `POST /api/sendPrompt`** | Real on this box; undocumented internal API | **Yes — preferred implementable wake** |
| **2** | Peer Bot `SendToAgent` relay | Real as an **agent tool only**; needs a live Grok Bot turn | Maybe later; not a Node-callable API |
| **3** | Webhook routine (`crsr_` + POST URL) | Routine exists; **panel hides URL/key** for server-stored routines | Blocked until Cursor surfaces credentials |
| **4** | Slack listener / schedule poll | Works without webhook secrets; not arrival-true wake (or burns tokens) | Honest fallback only |

**Implement next:** Rank 1 (gateway `sendPrompt`) behind a new Grok Bot receive provider. Keep Rank 3/4 documented as human workarounds. Do not start another model.

---

## 1) Preferred: local gateway `sendPrompt` (same-session wake)

### Exact mechanism

Grok Bot’s shared computer runs a private HTTP gateway:

- Env: `SAND_HOST_PORT=1340` (also `SAND_GATEWAY_BIND_HOST=0.0.0.0`).
- Descriptor (same inode): `/home/box/sand-data/gateway.json` ≡ `/home/box/agent-data/gateway.json` (`agent-data` → `sand-data` symlink).
- Descriptor fields (non-secret): `scheme`, `host`, `port`, `pid`, `startedAt`, `token` (43-char bearer; treat as password).
- Live check on this box (2026-09-13): port 1340 listening; unauthenticated `POST /api/listAgents` and `POST /api/sendPrompt` both return `401 {"error":"unauthorized"}` — routes exist and require the gateway token.

Community-confirmed (and Cursor staff pointed at as an undocumented workaround for “wake its own agent chat”):

```http
POST http://127.0.0.1:${SAND_HOST_PORT:-1340}/api/sendPrompt
Authorization: Bearer <gateway.json token>
Content-Type: application/json

{"agentId":"9c3388a6-717b-4e94-b9c5-5e0733bb9078","prompt":"<wake text>"}
```

Companion:

```http
POST http://127.0.0.1:1340/api/listAgents
Authorization: Bearer <token>
Content-Type: application/json

{}
```

References (public):

- Forum: [Grok Bot: Can I send it a message from outside?](https://forum.cursor.com/t/grok-bot-can-i-send-it-a-message-from-outside/168199) (a community curl recipe; Cursor staff earlier pointed Cloud Agent automations as the *official* external path — that starts a **new** cloud agent, not this chat).
- Forum feature request reply: [Let a Grok Bot computer wake its own agent chat](https://forum.cursor.com/t/let-a-grok-bot-computer-wake-its-own-agent-chat/168260) — staff: “Wake mechanics is an area we’re working on” + link to the gateway workaround.
- Unofficial SDK: [`@adam91holt/grokbot-sdk`](https://github.com/adam91holt/grokbot-sdk) / [forum thread](https://forum.cursor.com/t/unofficial-typescript-sdk-for-the-grok-bot-http-gateway-tailscale-remote-internal/168732) — `GrokBot()` reads `sand-data/gateway.json` on-box; exposes `listAgents` / `sendPrompt`. Explicit note: **there is no host `sendToAgent` command**; `sendAsAgent` only by minting a seat that calls the SendToAgent **tool**.

### Auth

- Same-box only for CS serve (Node on the Grok Bot computer).
- Read token from `gateway.json` at serve start (mode `0644` today; still secret — do not log, commit, or ship in profiles).
- Prefer `127.0.0.1` even if descriptor `host` is `0.0.0.0` (SDK rewrites wildcards the same way).
- Never expose `:1340` to the public internet. Remote use would need SSH/Tailscale tunnel (out of scope for CS serve on-box).

### How CS `receive serve` would call it

Sketch only (not implemented in this research pass):

1. **Host detect:** treat Grok Bot when `process.env.CURSOR_AGENT === "1"` and/or `SAND_HOST_PORT` / `CURSOR_AGENT_SOCKET` present. Today `detectAgentHost()` returns `"unknown"` for parent exec `grok` and never looks at these env markers (`src/cloud/agent-host.ts`).
2. **Configure:** new provider e.g. `grok-bot` (or extend wake beyond Claude-only `RECEIVE_WAKE_PROVIDER`). Bind `host_session_id` to the Grok Bot agent UUID (`9c3388a6-…`), not a Claude session id. Persist gateway base URL + agent id in the receive binding; **do not** persist the token — re-read `gateway.json` each serve.
3. **Serve loop:** subscribe to CS realtime wake topic / inbox follow (same family as Claude channel’s `createWakeSubscriber` + poll). On directed arrival (or canary), `POST /api/sendPrompt` with a short prompt that tells this session to run `cswarm check` / handle the signal — same session, same model seat.
4. **Do not** spawn `listen --provider grok` (different process / `grok login` CLI).

Parallel to Claude: Claude wake is a custom-channel MCP that injects into the live Claude session (`src/cloud/agent-channel.ts`). Gateway `sendPrompt` is the Grok Bot analogue of “inject into this seat,” except it is HTTP on localhost instead of an MCP stdio channel.

### `wake_verified` canary

Reuse the Claude canary contract’s intent (`agent-receive.ts` / `agent-channel.ts`):

1. `cswarm receive test` writes `{ nonce, requested_at, … }` with `wake_verified_at: null`.
2. Operator ends the turn so the chat is **idle**.
3. Serve (or a one-shot tester) calls `sendPrompt` with a body that embeds the nonce (mirror `canaryBody(nonce)`: `CommonSwarm wake test <nonce>. Confirm receipt in this session…`).
4. When **this** session runs and sees that prompt (or runs check and posts a receipt / notes the nonce), set `wake_verified_at`. Prefer a cheap confirmation: either the agent runs a small `cswarm` receipt command, or serve observes the agent became non-idle after the POST and the session later acknowledges the nonce in a durable way.

**Until that idle test passes, keep `wake_verified: false`.** HTTP 200 / gateway accept ≠ finished agent turn (same caveat as webhook docs).

### Remaining human step

- **Ideally none** once CS knows the agent UUID and can read `gateway.json` on the same computer.
- One-time: store agent id as `host_session_id` during `receive configure` (YulanOps is already `activeAgentId` and pinned on this host).
- Caveat to disclose in UX: undocumented internal API; Cursor may rename routes or rotate token layout. Prefer reading `gateway.json` over hardcoding port/token paths beyond the documented env + file pair.

### What this is *not*

- Not Cloud Agent Automations (new agent).
- Not `SendToAgent` (tool-only; see §2).
- Not the webhook routine (see §3) — even though the operator prefers “natural inter-agent messaging,” the **callable from Node** path that wakes the same seat is this gateway. Product docs describe Bot-to-Bot messaging as waking the receiver; the host’s implementation surface for an external Node process is `sendPrompt`, not an export of SendToAgent.

---

## 2) Peer agent `SendToAgent` relay (natural messaging; not CS-callable alone)

### What it is

In-product Bot-to-Bot messaging: one agent’s `SendToAgent` tool wakes another’s chat. Protobuf on this host (`agent.v1.SendToAgentArgs`): `tool_call_id`, `agent_id`, `message`, `delivery`, `title`. Success returns `worker_bc_id`, `delivered_as`, `message`.

Managed skill `routines` tells agents: store communication *intent*, not tool names; runtime chooses `SendToUser` / `SendToAgent` / etc. Official Grok Bot marketing/docs: receiver wakes, handles, replies later.

### Why it is Rank 2 for CommonSwarm

- **Agent-tool only.** No host `/api/sendToAgent`. Unofficial SDK states this explicitly (`sendAsAgent` = spin a seat that calls the tool).
- A CS Node process (`cswarm receive serve`) **cannot** invoke SendToAgent without either (a) already being inside a Grok Bot model turn with tools, or (b) using Rank 1 `sendPrompt` to make some Bot call SendToAgent (circular).
- A “tiny always-on wake relay Bot” still needs something to wake *it* on inbox arrival — back to gateway, webhook, Slack, or schedule. So a relay does not remove the need for Rank 1 or 3/4; it only adds another seat.

### When it still matters

- Multi-Bot orchestration *after* CS has woken one Bot via gateway.
- Human/manual: ask another live Bot to `SendToAgent` YulanOps for a one-off test of same-session wake (useful as a canary cross-check that SendToAgent and `sendPrompt` land on the same seat UX).

---

## 3) Webhook fallback (blocked on this Bot)

### Official shape

Docs: [Routines — webhook URL and key](https://cursor.com/help/grok-bot/routines.md).

```http
POST <routine POST URL>
Authorization: Bearer <crsr_ sender key>
Content-Type: application/json
```

JSON body is delivered with the routine instruction. HTTP 200 = run started, not finished. Agent never sees the key; user copies from the routine panel (“POST to”, “key”, “header”).

Skill `routines`: trigger `{ "type": "webhook" }`; deep links under Current routines point at panel fields.

### On YulanOps (this computer)

Already saved under `…/agents/9c3388a6-…/automations/`:

| Automation | Trigger | Enabled | lastRunAt |
|------------|---------|---------|-----------|
| `commonswarm-inbox-wake` | `webhook` | true | **null** (never fired) |
| `commonswarm-inbox-poll` | `@every 15m` | true | null |

Watcher stub: `~/.cswarm/wake-bridge/watch.sh` + `env.example` (`GROKBOT_WEBHOOK_URL` / key in `env.local`). Not armable without credentials.

### Why blocked

Forum consensus for **server-stored** routines (“This Bot keeps its routines on the server”):

- Desktop / mobile **do not show** POST URL or `crsr_` key ([Windows 0.47.0 report](https://forum.cursor.com/t/desktop-grok-bot-webhook-routine-shows-no-post-url-crsr-key-windows-0-47-0/171324); earlier iOS-only confusion later generalized).
- Recreating the routine does not help; the Bot cannot emit the values.
- Cursor staff: no current way to retrieve URL/key for that class of Bot; use Slack trigger or schedule instead.

Older local-panel bots could copy the three fields after save. YulanOps matches the broken server-stored class (webhook routine present, no runnable external credentials, wake-bridge still waiting).

### Exact human step *if* panel ever shows fields

1. Open YulanOps → View conversation details → Routines → **CommonSwarm inbox wake**.
2. Confirm Active. Under When to run / webhook, copy **POST to**, **key** (`crsr_…`), and/or ready-made `Authorization: Bearer …` header.
3. Write to `~/.cswarm/wake-bridge/env.local` (mode `0600`): `GROKBOT_WEBHOOK_URL=…`, `GROKBOT_WEBHOOK_KEY=…`.
4. Run `watch.sh` (follows `cswarm inbox --follow --ndjson` and POSTs `{source, signal_id, kind}`).
5. Idle canary: send a directed CS message while chat idle; confirm this session runs the wake routine and handles the ask. Only then claim wake works.

Until step 2 is possible, Rank 3 is documentation-only.

Protected on-box: `/home/box/sand-data/webhook-keys.json` is host-only (Read refused) — not a substitute for the panel fields for CS.

---

## 4) Other honest options

### Slack listener routine

Staff workaround when webhook credentials are hidden: create a routine with a Slack trigger on a channel the operator controls; have an external system (or CS bridge) post a narrow keyword there. Pros: no `crsr_` needed; uses account integrations. Cons: requires Slack connected + `@Cursor` invited; not a pure CS inbox path; noisy if match is broad; still a routine wake, not SendToAgent.

### Schedule / poll (`commonswarm-inbox-poll`)

Already configured `@every 15m`. Same class as Codex heartbeat doc (`docs/operations/CODEX-SAME-CHAT-RECEIVE.md`): scheduled same-chat check, **not** arrival-triggered wake; burns tokens on empty inbox. Acceptable only if operator accepts cost. Codex parallel: `inbox --follow` alone does not inject into the chat.

### Cloud Agent Automation webhook

Official Cursor path for “external POST starts an agent” — starts a **new** Cloud Agent, violates same-session / no-new-model.

### `CURSOR_AGENT_SOCKET=/tmp/sand-identity.sock`

Present (`srw-------`). Speaks HTTP-ish; probes without auth got `400 Bad Request` / timeouts. Not a documented agent-messaging API. Do not build CS wake on it without a stable protocol spec.

### Other agent platforms

Out of scope (explicit: do not use).

---

## Host detect markers (for CS)

Observed in this executor / shared box environment:

| Marker | Example / note |
|--------|----------------|
| `CURSOR_AGENT` | `1` |
| `CURSOR_AGENT_SOCKET` | `/tmp/sand-identity.sock` |
| `CURSOR_CONVERSATION_ID` | `sand-subagent-…` (subagent) or agent uuid-shaped for main seats |
| `CURSOR_REQUEST_ID` | per-request |
| `SAND_HOST_PORT` | `1340` |
| `SAND_GATEWAY_BIND_HOST` | `0.0.0.0` |
| `SAND_*` | many box/supervisor markers |

`detectAgentHost()` today: parent executable walk → `claude` / `codex` / `codex-desktop` / `unknown`. Parent name `grok` deliberately returns `"unknown"`. Grok Bot is not a `grok` CLI child; env-based detection is the right signal for Rank 1.

YulanOps profile: `name: YulanOps`, `harness: "box"`, `serverId: "845764"`. Gap report: principal `1b34aaf0-…`, workspace `fad2ad53-…`, CLI `0.1.68`, turn-mode instructions work; wake configure refuses (`RECEIVE_WAKE_PROVIDER = "claude"` only).

---

## Dynamic tools / docs on this box (investigation notes)

- **MCP catalog** has no `SendToAgent` / `CreateAgent` / `CreateChannel` / `DraftExternalMessage` / `create_bot_share_json` / `update_state` — those are Grok Bot **dynamic / host tools**, not MCP.
- This executor subagent did not hold `GetDynamicTools`; schema recovered from host worker protobuf + managed skill `routines` (`update_state` target `"routine"`, webhook trigger shape).
- `create_bot_share_json` / `DraftExternalMessage`: no hits in sand-host worker strings searched here; treat as unavailable for wake design unless a parent agent with GetDynamicTools documents them later.
- Inter-agent wake for an **external Node** process collapses to Rank 1 (`sendPrompt`), not to calling SendToAgent directly.

---

## Mapping to Claude / Codex parallels

| Host | Same-session arrival path | Token cost if idle |
|------|---------------------------|--------------------|
| Claude | Custom channel MCP + CS realtime wake (`serveAgentChannel`); `wake_verified` via self-addressed canary + receipt tool | Only on real wakes / canary |
| Codex app | Thread `heartbeat` schedule (not arrival interrupt); documented in `CODEX-SAME-CHAT-RECEIVE.md` | Every interval |
| Grok Bot | **Rank 1 gateway `sendPrompt`** (implement); webhook if credentials appear; else Slack/schedule | sendPrompt only when CS sees mail |

---

## Gaps already filed / still true

From `/home/box/shared/commonswarm/GROK-BOT-RECEIVE-WAKE-GAP-2026-09-13.md` (still accurate on CS main @ research time):

- No first-party `grok-bot` receive provider; wake hard-requires Claude + `--preview-channel`.
- `listen --provider grok` is the wrong session.
- Webhook workaround unverified and credential-blocked here.

**Update from this research:** Rank 1 gateway is the missing implementable bridge. CS should add host id + provider that POSTs `sendPrompt` to the bound agent UUID, plus canary → `wake_verified`. Webhook remains fallback when panel fields exist.

---

## Implementation gates (for the next dispatch — not done here)

1. Extend `DetectedAgentHost` / `RECEIVE_PROVIDERS` / wake rules for Grok Bot.
2. Gateway client: read `gateway.json`, `listAgents` sanity, `sendPrompt` with timeout; never log token.
3. `receive configure --mode wake --provider grok-bot` (name TBD) with `--host-session-id <agentUuid>`.
4. `receive serve` loop: CS inbox/wake subscription → `sendPrompt` (replace or supersede `wake-bridge/watch.sh` webhook design).
5. `receive test` idle canary → `wake_verified_at`.
6. Docs: disclose undocumented gateway; human steps for Slack/schedule if gateway unavailable; webhook arming if Cursor restores panel fields.
7. **Do not** commit secrets; **do not** enable other agent platforms; **do not** default to `listen --provider grok`.

---

## Summary for parent

**Recommend implement Rank 1:** on-box `POST /api/sendPrompt` with bearer from `/home/box/sand-data/gateway.json` (alias `/home/box/agent-data/gateway.json`) to agent `9c3388a6-717b-4e94-b9c5-5e0733bb9078`. That is the only path that both (a) wakes the existing YulanOps seat and (b) is callable from a CS Node serve without another model turn or hidden panel fields. SendToAgent is the product metaphor but not a host API. Webhook routine `commonswarm-inbox-wake` is saved and Active but unfireable until Cursor shows URL/key. Schedule poll exists as a costly interim. Research only — no code committed in this pass.
