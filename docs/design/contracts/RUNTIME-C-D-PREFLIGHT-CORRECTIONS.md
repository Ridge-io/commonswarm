# Runtime C/D preflight corrections — dispatch authority

## Current prerequisite state — 2026-07-31 21:59 CDT

- Runtime A/A2: clean pushed candidate
  `ab1b240334efc62b50027512f64692e15d0e0752`; independent exact acceptance and Lead integration
  still required.
- Runtime B: accepted and integrated at Lead
  `d7c0b1a59646ae624385d6cd09a919ad0b24c43b`.
- Journal/transport/effect store: accepted and integrated.
- Server Phase B: clean pushed candidate
  `d972c3f8181c8da927edd8cf9818044261d9b08b`; independent exact acceptance still required.
- Server Phase C: corrected preflight exists in `SERVER-PHASE-C-PREFLIGHT-CORRECTIONS.md`; no
  implementation candidate exists.
- Runtime C/D: not dispatched. All original blockers therefore remain except Runtime B.

Status: **binding correction layer; C and D are not dispatchable yet**.  
Prepared: 2026-07-31 by Codex exact-code preflight.  
Applies over: `LISTENER-RUNTIME-GOAL-PACKETS.md` and
`LISTENER-RUNTIME-IMPLEMENTATION-SPEC.md`.  
Authority order: accepted integrated code, then this correction, then the older packets.

The core durable claim/journal/effect/ACK design remains sound. The older packets are retained as
history, but their Goal-C/D path ownership and several runtime details are superseded below.

## Dispatch blockers

1. Runtime A must include the accepted deadline/first-winner candidate and a narrow A2 credential
   escape. The current engine restores `reply_ready` for HTTP 401/403, but a
   `credentialSession.bearer()` renewal, revocation, or secret-absence error during posting can
   become terminal before the runtime sees it.
2. Runtime B must receive exact acceptance after its Windows live-listener ordering repair. Its
   accepted API—not any earlier candidate—is authoritative for prepare, UUID, status, and journal
   export.
3. Server Phases B and C must pass exact review and be integrated. Phase A `3039cce` established
   intended source shape but not the required database behavior.
4. Server integration must preserve the current 26-file literal root-test union and append
   `tests/claim-ledger-parse.test.ts` exactly once. Expected post-server root union: **27 unique
   files**. Never accept the server branch's older `package.json` wholesale.

No C candidate may freeze or be called complete until one Lead-supplied exact base contains
accepted A/A2, B, journal `d4148b4`, transport `1465e5c`, effect store `bb0f8145`, the final server,
and the reconciled 27-file test union.

## Corrected Goal C ownership and sequence

Owned paths:

- `src/listener/runtime.ts`;
- optionally one private `src/listener/durable-runtime.ts` module;
- `src/listener/supervisor.ts` only for reducing new delivery events into B's accepted fields; and
- `tests/listener-runtime.test.ts`.

Do not edit package, CLI, journal, transport, engine, types, server, or B's control tests. If A2's
credential classifier is absent, stop. One writer completes three serial checkpoints:

1. configuration, capability modes, cursor fallback, and events;
2. journal recovery, claim, retry, and lease budgeting; and
3. effects, ACK, cancellation, rollback, and crash matrix.

## Corrected Goal C interfaces

Use the accepted A/B names at dispatch time. Add:

```ts
export type ListenerDeliveryMode = "durable_claim" | "cursor_fallback";

export type ListenerDeliveryClient = Pick<
  DeliveryCommandClient,
  "claimAgentInbox" | "ackAgentDelivery"
>;

export type ListenerDeliveryJournalClient = Pick<
  ListenerDeliveryJournal,
  | "read"
  | "reserveClaim"
  | "recordClaimAttempt"
  | "recordLease"
  | "prepareAck"
  | "clearActive"
>;
```

Runtime always supplies explicit ISO timestamps to journal methods. During staged C compatibility,
the option type may make the durable pair optional:

```ts
listenerInstanceId?: string;
deliveryJournal?: ListenerDeliveryJournalClient;
deliveryClient?: ListenerDeliveryClient;
```

Runtime enforcement is closed:

- exactly one of instance ID/journal is fatal before credential acquisition;
- malformed instance ID is fatal before credential acquisition;
- both absent permits legacy cursor fallback;
- any delivery marker without the complete pair is fatal before claim/provider work;
- injected delivery client without the pair is invalid; and
- absent client with a complete pair constructs
  `new DeliveryCommandClient(options.target, options.fetcher)`.

Production Goal D always supplies the pair.

## Event and supervisor contract

Extend `ListenerRuntimeEvent` with:

```ts
{ type: "delivery_mode";
  mode: ListenerDeliveryMode;
  pendingDeliveryCount: number | null;
  ts: string }

{ type: "delivery_claim";
  signalId: string | null;
  pendingDeliveryCount: number;
  terminalDeliveryFailureCount: number;
  ts: string }

{ type: "delivery_terminal_failures";
  count: number;
  ts: string }

{ type: "delivery_ack";
  signalId: string;
  outcome: DeliveryOutcome;
  ts: string }
```

Allow `observed` in the existing effect-event status for cursor-fallback notes. The supervisor
reducer must:

- persist mode plus exact/null pending count on `delivery_mode`;
- persist `lastClaimAt` plus exact pending count on `delivery_claim`, without calling it handled;
- require a positive terminal-failure count and persist the latest count/timestamp;
- persist `lastAckAt`, set pending count to null, and update last handled signal on ACK; and
- translate only to B's closed snake-case fields, never lease/command IDs or content.

## Frozen constants and budgets

Import existing transport/host deadlines; do not duplicate them. Mirror the server contract with
cited runtime constants:

- maximum lease: 900,000 ms;
- safety margin: 30,000 ms;
- prompt-start minimum: 210,000 ms;
- reply-only minimum: 90,000 ms;
- ACK-only minimum: 60,000 ms; and
- retry: 500 ms exponential full jitter, capped at 30 seconds.

Do not import a Deno edge module into Node client TypeScript.

## Corrected Goal C behavior

- Default reads omit `kind:"ask"`; fallback must receive direct asks and notes.
- Both markers select durable mode; neither selects fallback; claim without ACK is fatal.
- ACK-only is rollback mode: replay `ack_pending`, finish safely live in-memory work, ACK an
  already-terminal recovered effect, but wait lease expiry plus margin and rewind when a recovered
  nonterminal lease cannot be rehydrated.
- If both markers disappear with active state, never cursor-race a possibly live lease. Drain when
  proven possible; otherwise wait through the ambiguity horizon before rewind.
- Re-probe before every claim and switch fallback to durable before processing probe rows. Ignore
  probe rows in durable mode.
- Pending counts are exact server values or null; never decrement locally.
- Retry ambiguous claim/ACK with the same journaled body and command ID and a fresh bearer each
  attempt. Respect typed `retryAfterMs` for 429.
- Cancellation uses caller abort state and trusted typed errors, never arbitrary message regexes.
- Pass the caller signal into both engine and default reply poster. Pass the accepted credential
  classifier through A2.
- Do not add caller abort to `DeliveryCommandClient`; an already-sent delivery request settles
  through its own 30-second transport deadline.
- Before engine invocation, compare an existing effect against authoritative signal ID, kind,
  body, TTL, and outer sender relation. Mismatch is fatal and unacked before engine write.
- Direct notes use `newObservedNoteRecord`, persist, reread, and verify before ACK; zero model/post.
- ACK only after terminal effect reread and exact verification.
- Stale-403 clearing requires all three: process began with `ack_pending`, local time is beyond the
  stored lease deadline, and the error is exact `DeliveryHttpError(403,
  "delivery_unavailable")`. A newly prepared/live ACK never uses it.
- Lease expiry is never signal expiry.
- Positive poison counts emit once per claim command ID per live process, without exposing that ID;
  restart may emit again.

Closed terminal mapping:

- model refusal, non-caller model cancellation, blank reply -> `provider_refused`;
- exhausted typed ACP/host failure -> `host_session_failed`;
- exhausted noncredential post/transport/HTTP conflict -> `local_effect_failed`;
- integrity/corruption/unknown -> fatal and unacked; and
- credential loss stops and preserves state; do not manufacture `credential_unavailable`.

## Added Goal C causal controls

In addition to the existing crash matrix, prove:

- incomplete durable configuration fails before provider/credential work;
- fallback actually observes notes;
- renewal/reauthorisation during posting leaves exact `reply_ready`;
- delivery events update B fields, never fall through as malformed;
- recovered nonterminal lease behavior under ACK-only and neither-marker states;
- hostile `aborted`/`cancelled` text cannot override typed delivery/read errors;
- effect mismatch fails before engine write;
- poison warning suppression is internal and does not expose command ID; and
- the exact 27-file package union reaches transport, effect, journal, runtime, and parser tests.

## Corrected Goal D contract

D starts only after accepted C is integrated. Owned paths:

- `src/cli.ts`;
- `src/cloud/delivery.ts` comment only;
- `tests/listener-cli-process.test.ts`; and
- `tests/support/agent-receive-cli.test.ts`.

No package/runtime/supervisor/control/journal/server/site/release edits.

Inside `runConfiguredListener`:

1. hold an initially-unset closure-local selected journal;
2. supply supervisor `prepare(proposedInstanceId)`;
3. only there call `openListenerDeliveryJournal` with exact profile/workspace/principal/state
   directory/proposed UUID;
4. retain the selected journal and listener ID and return the ID;
5. in `run(signal, onEvent, listenerInstanceId)`, fail closed if journal is missing or IDs differ;
6. call runtime with selected ID, retained journal, signal/onEvent, effect store, model, and
   credential session; and
7. omit delivery client so runtime constructs the accepted default. Generate no second UUID and
   duplicate no retry/claim/ACK policy.

Correct the delivery comment: transport never logs or persists the lease; the secure listener
journal intentionally may persist it for exact ACK recovery.

Status JSON normalizes all six omitted legacy fields to null and adds no duplicate snake-case
aliases. Human output distinguishes durable/fallback, prints pending only when non-null, never
renders unknown as zero, and emits one bounded last-claim failure sentence only for positive count.
It must contain no sender, body, lease, command, bearer, prompt, or reply content.

Goal-D causal process tests prove the complete fake read-capability -> claim -> reply -> ACK flow,
one UUID across every layer, losing concurrent startup without journal rotation, distinct mode
rendering, null/zero/positive count distinctions, bounded failure copy, and secret sentinel absence
from stdout/stderr/status/events. Existing legacy cursor process tests remain green.

## Conflict and evidence verdict

- Server package reconciliation is manual and must produce 27 unique literal test paths.
- C follows accepted B because both touch supervisor; C follows A2 because it consumes the seam.
- D follows accepted C and is otherwise path-disjoint.
- No C/D worker runs concurrently on CLI, runtime, supervisor, or their shared tests.
- This preflight performed no test, edit to product code, DB, live network, deploy, or production
  validation. Those facts remain unestablished until their bound lanes execute.
