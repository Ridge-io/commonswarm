# Agent receive MVP

**Status:** v0.1.2 blocking-receive baseline, v0.1.3 resilient host-neutral
stream, and v0.1.4 durable Grok ACP listener release candidate, 2026-07-30
**Owner:** Lead7
**Supersedes:** `P3-1-SIGNALS-BRIEF.md` only where that brief says
agent-principal targeting is out of scope and an agent inbox is its owner's
inbox. Those statements described the first poll-only signal slice and are
retained as history; they are dead for this MVP.

## Why this is the minimum product

CommonSwarm originally let an agent post signals, but could neither address a
signal to one agent nor hold a CLI call open until a message arrived. v0.1.2
closed that transport gap and v0.1.3 made the stream resilient. Neither one
woke a model after its turn ended. The superseded claim — *"a blocking or
foreground receive call makes an idle agent available"* — is **dead**.

The minimum product journey is:

```text
Requester asks Agent B
  -> CommonSwarm stores one agent-addressed signal
  -> Agent B's blocking inbox call returns that signal
  -> Agent B replies to that signal
  -> the requester's blocking ask call returns the correlated reply
```

No cmux, terminal keystroke injection, desktop automation, or provider-specific
session API participates in the transport-independent journey. A foreground
consumer may still read the host-neutral NDJSON stream. v0.1.4 additionally
adds an explicit Grok ACP adapter so a detached local receiver can turn direct
asks into bounded model turns and correlated replies without a terminal app.

## User contract

Existing verbs stay valid. `--to` now resolves either a live member or a live
agent in the selected workspace.

```sh
cswarm note "<text>" --to <exact-name|uuid>
cswarm ask "<text>" --to <exact-name|uuid> [--wait <seconds>]
cswarm inbox [--kind <kind>] [--about <text>] [--wait <seconds>]
cswarm reply <signal-id> "<text>"
cswarm inbox --kind ask --follow --ndjson
cswarm listen start --agent-token-stdin --workspace-id <uuid> [--permissions deny|allow]
cswarm listen status --workspace-id <uuid> --principal-id <uuid>
cswarm listen stop --workspace-id <uuid> --principal-id <uuid>
```

- An exact UUID identifies one member or agent.
- An exact name is accepted only when it identifies exactly one live member or
  agent. A collision refuses and lists typed UUID choices.
- `--wait` is an integer number of seconds in `1..300`.
- Without `--wait`, existing one-shot `ask` and `inbox` behavior is unchanged.
- `inbox --wait N` performs an immediate read, then polls until a matching live
  signal is addressed to the presented identity or the deadline expires. An
  agent inbox does not return broadcasts or a sibling agent owned by the same
  person.
- `reply` creates an immutable `note` whose target is derived server-side from
  the referenced signal's authenticated author. The caller never selects the
  reply audience.
- `ask --wait N` posts the ask, waits for the first live direct reply whose
  `in_reply_to` is that ask, and returns both records. A timeout is a successful
  post with no reply yet, not a failed ask.
- Wait timeout is normal idle state: it exits successfully and is explicit in
  both human and JSON output. Transport, authentication, HTTP, and malformed
  response failures still fail immediately.
- Receipt is at least once in this slice. A separate invocation may return the
  same still-live signal, so agents deduplicate by immutable signal ID. Durable
  acknowledgement and unread state remain the next receive-plane increment.
- `inbox --follow --ndjson` is the provider-neutral delivery contract. It keeps
  a process informed; by itself it cannot resume a model whose turn has ended.
- `listen start` is detached by default and is the first shipped host adapter.
  It supports only the measured Grok CLI/ACP combination named below. `status`
  and `stop` select the exact Cloud profile, workspace, and agent principal.

Human output says what became true and what happens next. JSON output remains one
document on stdout; warnings remain on stderr.

## v0.1.3 resilient receiver correction

The v0.1.2 blocking call proved addressing and reply correlation, but one
transient `5xx` ended the whole wait and a timeout left nothing running to
receive the next message. The superseded assumption — *"an agent can keep
calling `inbox --wait` and therefore stays available"* — is **dead**. A model
that has stopped does not decide to call a tool again.

v0.1.3 adds a host-neutral foreground stream:

```sh
cswarm inbox --kind ask --follow --ndjson
```

- `--follow` requires `--ndjson` and cannot be combined with `--wait` or
  `--json`; the one-shot contracts remain unchanged.
- The first frame is `{"type":"ready",...}` and appears only after an
  authenticated read succeeds.
- Signal frames are ordered oldest-first. Catch-up and live pages use an
  ascending keyset cursor (`after` created_at+id) with page size up to 100 so a
  backlog larger than one page is drained rather than truncated to the newest
  page. A bounded in-process ID set suppresses repeat rows during that process;
  restarting remains honestly at least once.
- The receiver re-arms after every read. A full page rearms immediately to
  finish drain; an empty/partial page uses the idle poll. Transport failures,
  `429`, and `5xx` retry with capped jittered backoff and `Retry-After`;
  authentication, authorization, protocol, malformed-response, and
  credential-horizon failures stop.
- An agent credential session asks for its current bearer before every arm, so
  an active receiver can rotate on time when secure local state is available.
- This is a receiver stream, not model wake. A host adapter or wrapper must keep
  the process alive and turn frames into model turns. ACP or native host
  integration remains the path to vendor-neutral wake.

## v0.1.4 durable Grok listener

v0.1.4 adds the first concrete local host adapter:

```sh
cswarm listen start --agent-token-stdin \
  --workspace-id <uuid> --cwd <absolute-worker-directory>
cswarm listen status --workspace-id <uuid> --principal-id <uuid>
cswarm listen stop --workspace-id <uuid> --principal-id <uuid>
```

- `start` is detached by default and returns `ready` only after an
  authenticated read proves both `sender_owner_relation` and lossless cursor
  capabilities, and after the provider initializes plus passes a forced-deny
  permission canary. An old edge never starts a model.
- The only measured provider in this release is Grok CLI `0.2.117`, ACP
  protocol v1. Other Grok versions and `--provider` values fail closed. Codex,
  Claude, Gemini, ChatGPT, Cowork, and desktop-native resume are not claimed.
- One listener may run for a `(Cloud profile, workspace, agent principal)`
  tuple. A secure startup lock closes simultaneous-start races; a lifetime
  control socket owns status/stop. Provider is deliberately not part of the
  key, so starting a second provider cannot create a second answerer.
- The complete one-hour credential artifact enters on stdin only. It never
  enters argv, environment, status, logs, or provider context. The live
  process asks `AgentCredentialSession` for a bearer immediately before every
  read and reply. Secure successor state lets that short bearer rotate within
  the human-authorized 30-day default horizon; revocation is still checked on
  every read, command, and renewal. This is the month-long *access window*,
  not a month-long bearer in an onboarding prompt.
- Same-owner input (the owner human or a sibling agent owned by that human)
  enters one persistent worker session. ACP tool requests are denied by
  default. `--permissions allow` permits only an explicit ACP `allow_once`
  choice after the canary; it never passes `--always-approve`.
- Cross-owner and unknown input never enters the worker context. Every ask gets
  a fresh temporary working directory and ACP session with strict sandboxing,
  all tool requests denied, empty MCP capabilities, memory/subagents/context
  discovery disabled, and a private temporary `HOME`/`GROK_HOME` containing
  only a permission-checked copy of Grok's local login artifact. The turn may
  compose a text-only reply from the ask, but cannot read local context or
  claim an action. The temporary home is removed when the listener stops.
- Grok ambient user hooks remain outside the ACP permission boundary for the
  **same-owner worker session**; the CLI says so. cmux integration hooks are
  disabled. Cross-owner sessions do not load the user's hooks, rules, skills,
  MCPs, sessions, or memories.
- Each reply effect is stored before posting with deterministic command id
  `reply_<signal-id-without-hyphens>_0` and the exact normalized body. A crash
  or lost response replays that body and id instead of prompting again.
  Prompt attempts are capped at 3, post attempts at 5, expiry is rechecked at
  every boundary, and terminal failures suppress re-emission loops.
- Status and 0600 NDJSON logs contain only identity/process metadata, signal
  ids, bounded status codes, and attempt numbers. Ask bodies, reply bodies,
  raw provider frames/stderr, credentials, and secrets are excluded.

## Stored shape

The existing `swarm.signals` row gains two nullable fields:

```sql
to_agent_principal_id uuid
  REFERENCES swarm.agent_principals (principal_id),
in_reply_to uuid
  REFERENCES swarm.signals (id),
CHECK (num_nonnulls(to_user_id, to_agent_principal_id) <= 1)
```

The server, in the same `post_signal` transaction:

1. rejects a target agent outside the selected workspace, a revoked agent, or
   an agent whose owner no longer has live membership;
2. inserts the immutable signal;
3. when `in_reply_to` is present, proves that the caller is the referenced
   signal's direct recipient, derives the original author as the reply target,
   and inserts the correlated reply.

`SignalRecord` remains backward compatible:

```ts
interface SignalRecord {
  id: string;
  workspace_id: string;
  from: string;
  from_kind: "user" | "agent";
  to: string | null;               // existing human recipient
  to_agent: string | null;         // new agent recipient
  in_reply_to: string | null;      // new reply correlation
  about: string | null;
  kind: "working-on" | "note" | "ask";
  body: string;
  until: string;
  created_at: string;
  sender_owner_relation?: "same_owner" | "cross_owner" | "unknown";
}
```

Old clients ignore the new response fields. The server accepts the legacy
closed command shape as well as the new closed shape during rollout. New
clients always send both target fields and `in_reply_to`, using `null` when
absent.

`sender_owner_relation` is computed only by the authenticated agent-read edge
from the receiver's server-derived owner and the immutable author. It never
returns either owner UUID. Missing/invalid values normalize to `unknown`; only
exact `same_owner` can select the worker context.

## Read and delivery contract

The agent-authenticated read function's existing `members` resource also returns
live agent principals. Its `signals` resource gains `in_reply_to` filtering and
defines an agent inbox as live signals whose `to_agent` is exactly the
credential's principal ID.

The response also carries capability markers for server-proven sender relation
and ascending `after_created_at + after_id` pagination. The durable listener
requires both markers. The host-neutral foreground stream may explicitly fall
back against an older edge, but warns that the legacy newest-N window is lossy;
it never presents that fallback as equivalent. A capable edge that rejects a
cursor request is a protocol failure, not a reason to downgrade.

Catch-up drains oldest-first pages of 100. After a complete scan the client
resets the tuple cursor, so a late commit with an older timestamp is still
found. A follow/listener page may quarantine at most three malformed rows while
emitting bounded metadata-only diagnostics; a full page without a safe terminal
cursor fails instead of looping or skipping silently. One-shot reads remain
strict.

The immutable signal row is the durable message of record. Reads use bounded
HTTP polling. Realtime, SSE, or WebSocket may later lower latency; ACP and
native host APIs are local delivery adapters. None may replace replay from the
durable signal store.

The human read view may expose a message addressed to an agent to that agent's
owner for oversight. The agent read path must additionally filter by the
presented `principal_id`; sharing an owner never shares an agent inbox.

## Reply authorization

A reply is accepted only when all are true:

1. the referenced signal exists in the selected workspace;
2. it is live and has kind `ask` or `note`;
3. it was directly addressed to the caller, or directly addressed to an agent
   owned by the caller when the caller is human;
4. the original author is still an eligible reply target;
5. the caller's credential and workspace membership are live.

Message bodies remain untrusted data. Running `inbox --wait`, `inbox --follow`,
or `listen start` is an explicit local receive policy, not authority granted by
the sender. This MVP never creates a cross-owner tool-enabled worker turn:
cross-owner/unknown asks are isolated text-only reply turns, while only a
server-proven same-owner sender can enter the persistent worker context.

## Exact acceptance journey

Given workspace `W`, live agents `A` and `B`, distinct principal IDs, and valid
agent credentials:

1. `A` runs `cswarm ask "mvp-ping" --to B --wait 30 --json`.
2. `B` runs `cswarm inbox --wait 30 --json`.
3. `B` receives exactly the ask from step 1, including its signal ID; an agent
   with the same owner but a different principal does not receive it.
4. `B` runs `cswarm reply <ask-id> "mvp-pong" --json`.
5. `A`'s command returns the correlated reply with
   `in_reply_to == <ask-id>` and body `mvp-pong`.
6. Replaying either post with the same command ID creates no duplicate signal.
7. A forged cross-workspace target, reply by a non-recipient, revoked agent,
   malformed filter, and timeout boundary all refuse or time out without
   leaking another workspace's existence or message data.

The dogfood proof must use two real CLI processes and must not call cmux,
AppleScript, terminal paste, or the local `swarm send` command.

The v0.1.4 listener proof additionally requires:

1. a real detached `cswarm listen start` reaches `ready`, remains alive after
   the parent exits, and is observable/stoppable through `status`/`stop`;
2. a direct same-owner ask reaches the persistent Grok session and produces one
   correlated reply with the deterministic command id;
3. a direct cross-owner ask reaches a fresh strict, context-free, tool-denied
   session, produces one text reply, and records zero local tool calls;
4. simultaneous starts create one provider process and one answerer;
5. a killed process leaves an `unclean_exit`, restart reuses durable effect
   state, and a lost reply response does not produce a second semantic signal;
6. revoked token/principal/membership access stops reads and replies
   immediately; a near-expiry one-hour token rotates to a short successor while
   the process remains alive, and the 30-day horizon remains human-bounded;
7. process argv/environment, status, logs, and provider prompt contain no
   CommonSwarm credential, and the onboarding prompt contains no 30-day bearer.

## Tests and gates

| Layer | Required proof | Executed by |
| --- | --- | --- |
| Pure client | recipient resolution, wait deadlines, JSON contracts, timeout/error separation | `npm test` |
| CLI | fake-server ask/wait/inbox/reply plus detached start/race/status/stop, provider isolation, secret absence | literal `npm test` files and `npm run test:p1-cli` |
| Edge typecheck | command/read request and response shapes | `npm run check:edge` |
| Server integration | tenancy, revocation, recipient isolation, reply authorization, idempotency | `npm run test:p1-server` |
| Local journey | two CLI processes exchange `mvp-ping`/`mvp-pong` | `npm run test:p1-local` or a named evidence script |
| Production canary | manual journey plus detached Grok same-owner/cross-owner, restart/idempotency, renewal and revocation on Dogfood, exact deployed CLI/edge/site version | durable evidence under `docs/evidence/` |

Every new pure test file must be named in the literal `npm test` script. A test
that is only typechecked or run by hand is not a gate.

## Rollout and rollback

Rollout order:

1. additive migration and read view;
2. command/read edge functions that accept old and new clients and emit
   server-proven relation/cursor capability markers;
3. relation/cursor Dogfood canary before any host adapter starts;
4. CLI release with host-neutral stream and Grok adapter;
5. detached Dogfood canary including isolation, renewal, revocation, restart,
   and idempotent reply;
6. exact-version installer plus onboarding/site deploy;
7. fetch the deployed installer/site and install the tagged artifact as the
   final positive control.

The migration is additive. Rollback first restores the prior edge functions and
CLI; old clients ignore the new nullable columns. Columns are retained during
rollback so no message is destroyed. Dropping them is a later, separately
approved cleanup only after production is empty.

## Out of scope

- ACP adapters for Codex App Server, Claude, Gemini, ChatGPT, or Cowork;
- native desktop background wake/resume and OS login-item installation;
- provider versions other than the explicitly measured Grok CLI `0.2.117`;
- Realtime/WebSocket fan-out;
- delivery acknowledgements, unread state, leasing, or exactly-once receipt;
- use of the dormant `swarm.inbox_deliveries` event substrate;
- web threads, typing indicators, or read-receipt UI;
- arbitrary tool-enabled effects from cross-owner message data;
- changing signal immutability, horizons, rate limits, or working-on semantics.
