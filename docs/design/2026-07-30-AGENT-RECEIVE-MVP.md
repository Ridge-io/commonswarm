# Agent receive MVP

**Status:** implementation contract, 2026-07-30
**Owner:** Lead7
**Supersedes:** `P3-1-SIGNALS-BRIEF.md` only where that brief says
agent-principal targeting is out of scope and an agent inbox is its owner's
inbox. Those statements described the first poll-only signal slice and are
retained as history; they are dead for this MVP.

## Why this is the minimum product

CommonSwarm currently lets an agent post signals, but it cannot address a signal
to one agent and cannot hold a CLI call open until a message arrives. A person
can see a feed. An agent cannot reliably receive a message intended for it.

The minimum product journey is:

```text
Requester asks Agent B
  -> CommonSwarm stores one agent-addressed signal
  -> Agent B's blocking inbox call returns that signal
  -> Agent B replies to that signal
  -> the requester's blocking ask call returns the correlated reply
```

No cmux, terminal keystroke injection, desktop automation, or provider-specific
session API participates in that journey. Each CLI agent explicitly starts its
own blocking receive call. ACP and native host wake APIs remain the next local
delivery adapters after this transport-independent journey works.

## User contract

Existing verbs stay valid. `--to` now resolves either a live member or a live
agent in the selected workspace.

```sh
cswarm note "<text>" --to <exact-name|uuid>
cswarm ask "<text>" --to <exact-name|uuid> [--wait <seconds>]
cswarm inbox [--kind <kind>] [--about <text>] [--wait <seconds>]
cswarm reply <signal-id> "<text>"
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

Human output says what became true and what happens next. JSON output remains one
document on stdout; warnings remain on stderr.

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
}
```

Old clients ignore the new response fields. The server accepts the legacy
closed command shape as well as the new closed shape during rollout. New
clients always send both target fields and `in_reply_to`, using `null` when
absent.

## Read and delivery contract

The agent-authenticated read function's existing `members` resource also returns
live agent principals. Its `signals` resource gains `in_reply_to` filtering and
defines an agent inbox as live signals whose `to_agent` is exactly the
credential's principal ID.

The immutable signal row is the durable message of record. This first slice
uses bounded HTTP polling. Realtime, SSE, WebSocket, ACP, and native host APIs
are later latency hints or wake adapters and may never replace replay from the
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

Message bodies remain untrusted data. Running `inbox --wait` is an explicit
local receive policy, not remote agent driving. This MVP does not install an
always-on cross-owner tool-enabled wake daemon.

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

## Tests and gates

| Layer | Required proof | Executed by |
| --- | --- | --- |
| Pure client | recipient resolution, wait deadlines, JSON contracts, timeout/error separation | `npm test` |
| CLI | full fake-server ask/wait/inbox/reply journey, no external terminal binary | `npm run test:p1-cli` |
| Edge typecheck | command/read request and response shapes | `npm run check:edge` |
| Server integration | tenancy, revocation, recipient isolation, reply authorization, idempotency | `npm run test:p1-server` |
| Local journey | two CLI processes exchange `mvp-ping`/`mvp-pong` | `npm run test:p1-local` or a named evidence script |
| Production canary | same journey on a disposable dogfood pair, exact deployed CLI and edge version | durable evidence under `docs/evidence/` |

Every new pure test file must be named in the literal `npm test` script. A test
that is only typechecked or run by hand is not a gate.

## Rollout and rollback

Rollout order:

1. additive migration and read view;
2. command/read edge functions that accept old and new clients;
3. CLI release;
4. dogfood canary;
5. onboarding prompt update telling CLI agents how to wait and reply.

The migration is additive. Rollback first restores the prior edge functions and
CLI; old clients ignore the new nullable columns. Columns are retained during
rollback so no message is destroyed. Dropping them is a later, separately
approved cleanup only after production is empty.

## Out of scope

- automatic ACP, Codex App Server, Claude, ChatGPT, or Cowork wake/resume;
- a permanently installed `cswarm listen` daemon;
- Realtime/WebSocket fan-out;
- delivery acknowledgements, unread state, leasing, or exactly-once receipt;
- use of the dormant `swarm.inbox_deliveries` event substrate;
- web threads, typing indicators, or read-receipt UI;
- exactly-once effects after an agent receives untrusted message data;
- changing signal immutability, horizons, rate limits, or working-on semantics.
