# H1 feasibility: a remote MCP endpoint on Supabase Edge Functions

Research date: 2026-09-05. Read-only; nothing in the repo was changed. Repo cites are `path:line` in
`/Users/yulanbot/Developer/Ridge.io/cloud-swarm`.

## Verdict: feasible with caveats

A **stateless** Streamable HTTP MCP server fits Supabase Edge Functions well. The current MCP revision
(2026-07-28) removed protocol sessions, the GET SSE stream, and resumability; every request is one POST
that may be answered with one JSON object. That is exactly one Edge Function invocation per tool call,
inside the 150 s idle / 2 s CPU / 256 MB limits. The official TypeScript SDK v2 (`@modelcontextprotocol/server`
2.0.0, published 2026-07-28) is stateless by default, runs on web-standard `fetch` runtimes including Deno,
serves 2025-era `initialize` clients from the same handler, and lets the app verify any bearer token in
front of the handler. Supabase documents this exact pattern (SDK 1.25.3 + `WebStandardStreamableHTTPServerTransport`).
The caveats: (a) do not offer long-lived streams (`subscriptions/listen`, legacy GET) — they will hit the
150 s idle timeout; (b) the MCP auth spec covers OAuth 2.1 only, so a static `swm_agt_` bearer is "outside
the spec", not forbidden, and every listed client can send one — but OpenClaw has shipped header-forwarding
bugs; (c) SDK v2 under Deno `npm:` and the six clients' current MCP revisions are NOT measured here; (d) the
existing `command` function is a 9,477-line single file whose auth and dispatch are module-private, so
in-process reuse needs a refactor while HTTP self-call needs none.

## 1. MCP transport today, and client support

**Current spec is 2026-07-28** (https://modelcontextprotocol.io/specification/versioning, read 2026-09-05).
Streamable HTTP in that revision (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http):
- "The server **MUST** provide a single HTTP endpoint path ... that supports POST." Every JSON-RPC
  request/notification is "its own HTTP POST"; the server answers with `application/json` (one object) or
  `text/event-stream` scoped to that request. "The client **MUST** support both."
- Client MUST send `Accept: application/json, text/event-stream`, `MCP-Protocol-Version`, `Mcp-Method`, and
  (for tools/call) `Mcp-Name`; the server MUST reject header/body mismatch with 400 and `-32020`.
- **Removed in this revision:** the GET stream, `Mcp-Session-Id`, DELETE, and `Last-Event-ID` resumability
  ("Resumable SSE streams via `Last-Event-ID` are not supported"). Servers "SHOULD" answer GET/DELETE with 405
  and ignore session headers from older clients. `initialize` is gone; version and client capabilities ride
  in `_meta` on every request; `server/discover` is a mandatory RPC
  (https://modelcontextprotocol.io/specification/2026-07-28/changelog, items 1-4, 9).
- Long-lived server→client notifications exist only as the response stream of a `subscriptions/listen` POST;
  it is optional to implement. Servers MUST validate `Origin` (403 if invalid).
- The prior revision 2025-06-18 (https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
  had the same single endpoint + POST, and made sessions, GET stream, and resumability all **MAY**: "A server
  ... **MAY** assign a session ID"; GET may return 405; resumability "**MAY**". So a stateless server was
  already legal in 2025-06-18 and is the only shape in 2026-07-28.

**Client support for remote Streamable HTTP with a static bearer header** (all docs read 2026-09-05):

| Client | Static header | OAuth | Source |
|---|---|---|---|
| Claude Code | `claude mcp add --transport http <name> <url> --header "Authorization: Bearer <tok>"`; `.mcp.json` `headers` with `${VAR}` expansion | Optional; triggered by 401/403; `claude mcp login` | https://code.claude.com/docs/en/mcp |
| Codex CLI | `codex mcp add <name> --url <url> --bearer-token-env-var MY_TOKEN`; config.toml `bearer_token_env_var`, `http_headers`, `env_http_headers` | `auth = "oauth"` default when no token; `codex mcp login` | https://learn.chatgpt.com/docs/extend/mcp?surface=cli (developers.openai.com/codex/mcp 308-redirects there) |
| Cursor | `mcp.json` `"url"` + `"headers": {"Authorization": "Bearer ${env:TOKEN}"}` | Optional ("supports OAuth for servers that require it") | https://cursor.com/docs/context/mcp |
| OpenCode | `"type":"remote","url":...,"headers":{"Authorization":"Bearer {env:VAR}"}`; `"oauth": false` disables auto-detect | Optional | https://opencode.ai/docs/mcp-servers/ |
| OpenClaw | `mcp.servers.<n>.url`, `transport: "streamable-http"`, `headers: {Authorization: "Bearer ${MCP_REMOTE_TOKEN}"}` | Optional (`auth: "oauth"`, `openclaw mcp login`) | https://docs.openclaw.ai/tools/mcp, https://docs.openclaw.ai/gateway/configuration-reference |
| eve (Vercel) | `defineMcpClientConnection({ url, auth: { getToken: async () => ({ token: process.env.X }) } })`; sent as `Authorization: Bearer` on every request | Optional via `@vercel/connect` | https://eve.dev/docs/connections |

None of the six **requires** OAuth. OpenClaw caveat: two bugs on 2026.4.10 — headers not forwarded on
streamable-http (https://github.com/openclaw/openclaw/issues/65590, opened 2026-04-12, closed) and missing
`Accept` header (https://github.com/openclaw/openclaw/issues/66940, opened 2026-04-15, closed). Fix versions
were not readable from the issue pages; re-test against a current OpenClaw before claiming support.

**Not found:** which MCP *revision* each client speaks today. The Claude Code changelog
(https://code.claude.com/docs/en/changelog, versions 2.1.238-2.1.261) has no entry naming 2026-07-28,
2025-11-25, or `server/discover`. Assume clients may still send `initialize` + `Mcp-Session-Id`; the server
must serve both eras (SDK v2 does, see §3).

## 2. Supabase Edge Functions constraints

From https://supabase.com/docs/guides/functions/limits (read 2026-09-05): memory 256 MB; wall clock 150 s
free / 400 s paid; CPU 2 s per request excluding async I/O; request idle timeout 150 s (then 504).

- **WebSockets: supported**, inbound and outbound (https://supabase.com/docs/guides/functions/websockets):
  "Edge Functions supports hosting WebSocket servers". Locally, set `[edge_runtime] policy = "per_worker"` —
  this repo already does: `supabase/config.toml:383-388`. Not relevant to MCP: neither spec revision defines
  a WebSocket transport, and SDK v2 removed `WebSocketClientTransport`.
- **SSE / streaming responses: supported.** Supabase's own example returns `new Response(new ReadableStream(...),
  { headers: { 'Content-Type': 'text/event-stream' } })`
  (https://github.com/supabase/supabase/blob/master/examples/edge-functions/supabase/functions/streams/index.ts).
  The Supabase MCP guide says the Streamable HTTP transport "requires the `Accept: application/json,
  text/event-stream` header" and works on Edge Functions.
- **Per-instance state:** "A new V8 isolate is spun up for each invocation ... Each isolate has its own memory
  heap"; isolates "can remain active for a period (plan-dependent)"
  (https://supabase.com/docs/guides/functions/architecture). No shared memory across invocations; anything
  a tool call must see later goes in Postgres (matches AGENTS.md "Durable by default").
- **Background work:** `EdgeRuntime.waitUntil(promise)` keeps the instance alive after the response, capped
  by the same wall-clock/CPU/memory limits (https://supabase.com/docs/guides/functions/background-tasks).
  The repo already uses it: `supabase/functions/command/index.ts:9414-9421`.
- **Cost:** billed per invocation "regardless of the response status code"; OPTIONS preflights excluded;
  500K/month free, 2M on Pro/Team, then $2 per 1M
  (https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations). Duration billing is
  not stated on that page (see "not established").

**Does Streamable HTTP need long-lived connections? No.** In 2026-07-28 the only long-lived stream is the
optional `subscriptions/listen`; in 2025-06-18 the GET stream, sessions, and resumability were all MAY. A
server that answers each POST with `application/json` and returns 405 to GET/DELETE is conforming in both.
One tool call = one POST = one invocation, well under 150 s.

## 3. SDKs usable in Deno edge

- **`@modelcontextprotocol/server` 2.0.0** — `npm view` shows `latest: 2.0.0`, modified 2026-07-28T00:03Z;
  implements the 2026-07-28 spec (https://ts.sdk.modelcontextprotocol.io/v2/). `createMcpHandler(factory)`
  "builds a fresh server instance from your factory for every HTTP request and holds nothing between
  requests, so a v2 server is stateless and scales horizontally by default"
  (https://ts.sdk.modelcontextprotocol.io/v2/serving/sessions-state-scaling.html). It "returns a `{ fetch }`
  object — the shape Cloudflare Workers, Deno, and Bun expect" and "the handler performs no Host or Origin
  validation" — you compose `hostHeaderValidationResponse` / `originValidationResponse` in front
  (https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard.html). Legacy clients: default
  `legacy: 'stateless'` serves 2025-era `initialize` clients "from the same factory"; legacy GET/DELETE
  answer 405 (https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html,
  https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html). `responseMode: 'json' | 'sse'`
  selects a single JSON body vs streaming (https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html).
- **`@modelcontextprotocol/sdk` 1.30.0** (v1 line, modified 2026-07-27) — still maintained. Its
  `WebStandardStreamableHTTPServerTransport` is what Supabase's guide uses; stateless mode is
  `sessionIdGenerator: undefined` with a new transport per request
  (https://github.com/modelcontextprotocol/typescript-sdk/releases;
  https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html).
- **Supabase's own example** (https://supabase.com/docs/guides/getting-started/byo-mcp):
  `import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js'`
  + Hono; `supabase functions serve --no-verify-jwt mcp`; URL `http://localhost:54321/functions/v1/mcp`.
  It states: "This guide covers MCP servers that do not require authentication. Auth support for MCP on
  Edge Functions is coming soon." A second example uses `mcp-lite` 0.8.2 and shows
  `claude mcp add my-mcp-server -t http http://localhost:54321/functions/v1/mcp-server/mcp`
  (https://supabase.com/docs/guides/functions/examples/mcp-server-mcp-lite). Both are stateless.
- Local toolchain present on this mini: deno 2.9.4, supabase CLI 2.98.2, Claude Code 2.1.258, codex-cli
  0.153.4 (measured with `--version`).

## 4. Auth: static bearer vs the MCP authorization spec

Every client above puts the value into `Authorization: Bearer <token>`; the repo already parses that header
case-insensitively with `BEARER_RE = /^Bearer +([^\s]+)$/i` (`supabase/functions/command/index.ts:1340-1346`;
same constant in `read/index.ts:170-176`, `capability/index.ts:323`, `activity/index.ts:40`), rejects
anything not matching `AGENT_TOKEN_RE` (`command/index.ts:9334-9344`), hashes with SHA-256
(`command/index.ts:1347-1351`), and resolves the hash in Postgres via `loadAgentCredential`
(`supabase/functions/_shared/agent-auth.ts:51-127`), then `agentCredentialRevoked` (`:129-162`).

The spec (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): "Authorization is
**OPTIONAL** for MCP implementations. When supported: Implementations using an HTTP-based transport **SHOULD**
conform to this specification." Conformance means OAuth 2.1 resource server + RFC 9728 metadata. It also
says "MCP servers **MUST NOT** accept or transit any other tokens" — but that sentence is inside the OAuth
flow it defines (tokens from other authorization servers). The spec does not define or forbid a pre-shared
API key; it is silent on it. The SDK v2 authorization page says the verifier accepts "Local JWT verification,
RFC 7662 introspection, or a call to your identity provider" and "contains no mention of static API keys"
(https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html). Practical consequence: with a static
bearer, H1 is a non-conforming-but-working server (like Figma's `bearer_token_env_var` example in Codex docs).
Consequences to design for: (1) return 401 with a plain `WWW-Authenticate: Bearer` and **no**
`resource_metadata`, or Claude Code/Codex/OpenClaw will start an OAuth flow on 401/403; (2) never accept
Supabase user JWTs on the MCP endpoint (the command function does at `:9346-9384`; the MCP surface should be
agent-only); (3) the spec's "MUST validate `Origin`" is already implemented for `command` in
`supabase/functions/command/cors.ts:26-45` and can be reused.

## 5. Recommended minimal architecture and risks

New function `supabase/functions/mcp/index.ts`, `verify_jwt = false` like the other four
(`supabase/config.toml:437-459`), endpoint `https://api.commonswarm.com/functions/v1/mcp`.

1. Pre-handler guard: method must be POST (GET/DELETE → 405); Origin check via `cors.ts` logic; parse bearer;
   refuse non-`swm_agt_`; hash; `loadAgentCredential` + `agentCredentialRevoked` in one transaction (this
   also stamps first use, which `agent-auth.ts:22-49` says every auth path must do).
2. `createMcpHandler(factory)` from `@modelcontextprotocol/server` (or `WebStandardStreamableHTTPServerTransport`
   from sdk 1.x if v2 fails under `npm:` — measure first), `legacy: 'stateless'`, `responseMode: 'json'`.
   Pass `{ token, clientId: principal_id, scopes, extra: { workspace_id, run_id } }` as `fetch`'s second
   argument; tools read `ctx.http.authInfo`.
3. Tools = existing verbs, one tool each: `working_on`, `note`, `ask`, `reply` → `post_signal`; `feed`,
   `inbox` → `read` resource `signals` (`src/cloud/signals.ts:1147-1149`) or `claim_agent_inbox` /
   `ack_agent_delivery` (`src/cloud/delivery.ts:828,854`); `brain_get`/`brain_put` and `file_get`/`file_put`
   → `file_download_url` / `file_version_create` + `file_version_commit` (`src/cloud/files.ts:268-319`,
   kinds at `supabase/functions/command/file-artifacts.ts:37-49`); `whoami` → what `runWhoami` reads
   (`src/cli.ts:3575-3600`: signal directory + renewal grants over `read`).
4. Do not implement `subscriptions/listen` in H1; `inbox` is a poll. Tool descriptions come from the same
   constants the CLI help uses (`src/cli.ts:532-552`), per AGENTS.md "an enumeration must be generated".

Risks: **idle timeout vs SSE** — any stream open >150 s 504s, so never hold a stream (`responseMode: 'json'`
sidesteps it entirely); **cold start** — the byo-mcp example pulls the SDK + Hono, adding to bundle and first
call latency (Supabase: "milliseconds", third parties: 200-500 ms; not measured here); **cost** — each MCP
POST is one invocation ($2/1M after quota), and 2025-era clients send `initialize` + `notifications/initialized`
+ `tools/list` before the first call, so ~3 extra invocations per session; **CPU 2 s** — postgres.js connect
+ SHA-256 + two auth statements per call is the same budget `command` already spends, but JSON-schema
generation for tools must be static, not per request; **auth-in-front means double connect** if the tool
then calls `command` over HTTP (see §6).

Measure before sizing:
- Hello-world stateless function under `supabase functions serve`, then `claude mcp add --transport http
  h1 http://127.0.0.1:54321/functions/v1/mcp --header "Authorization: Bearer swm_agt_..."` and
  `codex mcp add h1 --url ... --bearer-token-env-var T`; paste `tools/list` and one `tools/call` from each.
- Whether `npm:@modelcontextprotocol/server@2.0.0` resolves under Supabase's Deno edge runtime; fall back to
  `npm:@modelcontextprotocol/sdk@1.30.0`.
- Which revision each client sends (`MCP-Protocol-Version` header, presence of `initialize`).
- Cold vs warm latency and CPU time per call (Supabase dashboard), bundle size (< 20 MB local / 5 MB API).
- Whether a 401 without `resource_metadata` stops clients from attempting OAuth.
- OpenClaw on its current release: headers forwarded and `Accept` sent.

## 6. Reusing existing edge auth and dispatch

Two options.

**A. HTTP self-call (no refactor):** the MCP function verifies the bearer only for identity/early-401 (or not at
all) and forwards each tool call as a POST to `/functions/v1/command` (`src/cloud/config.ts:38-39`) or
`/functions/v1/read` (`:42-43`) with the same `Authorization` header and the exact wire shape the CLI sends
(`src/cloud/command-client.ts:855-866`: `command_id`, `client_version`, `workspace_id`, `stream`, `command`).
Authority stays where it is: `COMMAND_KINDS` (`command/index.ts:854-882`), the agent denylist
(`CONNECT_COMMAND_KINDS`, `:898-908`), rate limits, audit log (`insertAudit`, `:1371-1395`), and the
first-use stamp all run unchanged. Cost: two invocations per tool call, one extra network hop, and the
`swm_agt_` token transits the MCP function (same process trust domain, so not "token passthrough" to a third
party, but log hygiene matters).

**B. In-process shared modules:** import `loadAgentCredential` / `agentCredentialRevoked` from `_shared/agent-auth.ts`
(already shared by four functions) and call the command logic directly. Blocker: `handleTransaction`,
`authenticateAgent` (`command/index.ts:2550`), `resolveRoute`, and the per-kind handlers are module-private
inside a 9,477-line `index.ts` with `Deno.serve(handleRequest)` at the bottom (`:9477`). Reuse needs a lane
that lifts `handlePostRequest`'s body-in/`{status, body}`-out core into `_shared/` (or exports a
`dispatchCommand(body, agentTokenHash)`), with a test proving `command` and `mcp` run the same function.
Cost: refactor plus a second bundle of the same code; benefit: one invocation per tool call, one DB
transaction, no token transit.

Recommendation: ship H1 on **A** (measure it), and open **B** as a follow-up only if the doubled invocation
or latency is measured to matter. Either way the MCP function must not re-implement any kind check; it maps
tool → command kind and lets `command` refuse.

## What was not established

- Which MCP revision Claude Code, Codex CLI, Cursor, OpenCode, OpenClaw, or eve send today (none of their docs
  state it; Claude Code changelog has no entry).
- That `@modelcontextprotocol/server@2.0.0` loads under Supabase's Deno edge runtime via `npm:`. Supabase's
  guide shows only sdk 1.25.3.
- OpenClaw fix versions for issues #65590 / #66940 (issue pages read as "closed", version not shown).
- Supabase per-second/GB-second billing for Edge Functions; only per-invocation pricing was found.
- Cold-start latency on this project; the 200-500 ms figure is third-party (operatoriq.io), not Supabase.
- Whether Supabase's "auth support for MCP on Edge Functions is coming soon" changes anything; date unknown.
- The v2 SDK release date: GitHub releases page rendered the date as "July 27, 2025", npm says 2026-07-28 —
  npm is trusted here.
- No repo file or `docs/org/*RESUME-HERE.md` mentions H1 or MCP as a planned feature (grep found only two
  incidental mentions in `docs/design/SWARM-CLOUD.md:296,363`).
