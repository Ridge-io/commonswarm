# D-051 evidence — the read client honours `retryable: false`

**Defect:** production saturation, amplified by our own client.
**Implementation:** Verity, 2026-08-05, branch `d051-honour-retryable` off `main` (root `fb94d19`).
**Measured by:** Wren (dose-response curve), recorded in D-051.

## What the server was already saying

`supabase/functions/read/diagnostics.ts` builds every 500 body as
`PublicReadErrorBody` — `{ error, request_id, retryable }` — and computes
`retryable` from the SQLSTATE (`isRetryableErrorCode`: connection classes,
`40001`, `40P01`, `55P03`, `57014`, `53300`, `57P03`).

Enumerated, not pattern-matched — the set of edge files that emit the field:

```
grep -rl "retryable"  supabase/functions/ | grep -v protocol.js
  -> supabase/functions/read/diagnostics.ts
grep -rl "request_id" supabase/functions/ | grep -v protocol.js
  -> supabase/functions/read/diagnostics.ts
```

One file. The command and capability functions answer with `{error: "..."}`
only (`command/index.ts:6548-6549`, `capability/index.ts:840`) — no
`request_id`, no `retryable`. That bounds the scope of this change; see
"Not established" below.

## Where the instruction was discarded

Two lines, both in `src/cloud/signals.ts`:

1. `fetchSignalRead` returned `{ response, body: null }` for every `!response.ok`
   response. The failure body was never read at all.
2. `throwSignalHttp(response)` took the whole `Response` and touched only
   `.status` and the `retry-after` header.

`isRetryableFollowError` then classified on status alone — `429 || >= 500` —
so a 500 carrying `retryable: false` was retried. Both the CLI follow loop
(`signals.ts` `runInboxFollow`) and the listener read loop
(`src/listener/runtime.ts:792`) call that one function, so both amplified.

## The fix

- `src/cloud/error-envelope.ts` (new): `parseServerErrorEnvelope` is total —
  an absent, non-object, or malformed body yields nulls rather than throwing,
  so `retryable` absent falls back to existing status behaviour.
- `fetchSignalRead` reads failure bodies on the same terms as success bodies,
  under the same deadline; a body that will not parse still yields the
  status-only error.
- `throwSignalHttp(response, body)` attaches the envelope and puts the server's
  `error` and `request_id` in the message.
- `isRetryableFollowError` vetoes retry when `retryable === false`, before
  status is consulted. The veto is **one-directional**: `retryable: true` does
  not promote a status the client would otherwise refuse, so a server cannot
  talk the client into hammering a 401.
- Envelope fields are accepted only in their contract shape (a slug, a
  UUID-ish id). This is not cosmetic: `isFollowCredentialFailure` matches the
  phrase `secret is absent` against `error.message`, so putting unfiltered
  server text into that message would let a response body steer client-side
  credential classification.

## Causal control — measured, both arms

`tests/support/agent-receive-cli.test.ts`, named in the `npm test` literal list
(a file under `tests/support/` is only a gate because that script names it).

One follow run per arm. First read succeeds so the stream reaches `ready`;
every later read returns the same stubbed 500 differing **only** in `retryable`.
Requests are counted, because requests are what fed the saturation.

| arm | body | fetches | `retrying` frames | stop |
|---|---|---:|---:|---|
| refusal | `retryable: false` | 2 | 0 | `error` |
| permitted | `retryable: true` | 4 | 3 | `cancelled` (bounded by the harness) |
| silent | field absent | 4 | 3 | `cancelled` (bounded by the harness) |

The arms diverge, so the instrument discriminates. The test asserts that
divergence explicitly rather than only asserting the refusal arm.

### Inversion — the control is red without the fix

Each inversion applied alone to the tree, tests re-run, then reverted:

```
A. delete the veto line in isRetryableFollowError
   -> 4 D-051 tests fail (pass 41 / fail 4)

B. restore `if (!response.ok) return { response, body: null }` in fetchSignalRead
   -> 3 D-051 tests fail (pass 42 / fail 3)
```

The two inversions fail *different* subsets: B breaks the three wire-level
tests but leaves the veto unit test green, because that test constructs the
envelope directly rather than reading it off a response. A breaks those plus
the veto test. A blanket failure would have been a weaker result.

`D-051: a 500 with no readable body keeps the status-only behaviour` stays
green under both inversions — it covers the fallback, not the feature.

## Gates

```
npm test          -> tests 436, pass 436, fail 0   (baseline on main: 429/429/0)
npm run test:p1-cli -> tests 149, pass 149, fail 0
npm run build     -> clean
npm run check:tests -> clean
```

## Not established

- **Nothing here was measured against production.** The control is a stubbed
  500 in a pure test. Whether this reduces the observed failure rate is a
  claim only a post-deploy measurement can make.
- **`src/listener/engine.ts` `defaultRetryablePromptError` was checked and does
  not need this treatment.** It classifies errors from `model.prompt(...)` — a
  local ACP child process — plus a locally-thrown
  `SenderProvenanceUnavailableError`. No HTTP response reaches it, so there is
  no server envelope to read.
- **Two sibling classifiers have the same shape of defect and were left
  alone:** `isRetryablePostError` (`engine.ts:248`, on `CommandHttpError`) and
  `isRetryableDeliveryError` (`runtime.ts:214`, on `DeliveryHttpError`). Both
  are status-only. Honouring `retryable` there would be inert today because
  the command function never emits the field (enumerated above). The ordered
  fix is server-side first: have `command`/`capability` emit the envelope,
  then extend the client. Doing the client half now would ship an untestable
  branch.
- The human PostgREST read path (`humanSignals`) passes its body through the
  same parser. PostgREST error bodies carry `{code, details, hint, message}`
  and no `retryable`, so that path keeps status-only behaviour unchanged; its
  `message` field is not read into ours.
- `npm run check:edge` was not run — no edge function was modified.

---

# D-051 companions — backoff decay, bounded restart, and the cancellation hole

**Implementation:** Verity, 2026-08-05, same branch. Follows 84f0882, which both
review arms passed while raising the same consequence: honouring the refusal
correctly terminates a receiver, and nothing restarts one.

## Companion 1 — the attempt counter decays instead of resetting

`signals.ts` (`runInboxFollow`) and `runtime.ts` both set the retry attempt
counter to 0 after every successful read. That is the amplifier's engine: an
intermittently-failing receiver climbed, succeeded, reset, and climbed again,
so it never reached the 30s cap. One receiver produced 370 frames in 28 min =
**13.2/min**, where a receiver sitting at the cap produces ~2/min.

`decayFollowAttempt` subtracts one instead. The counter then drifts by
`(2p - 1)` per read at failure probability `p`, so the steady state tracks the
recent failure *rate* rather than the current streak, and a healthy receiver
still returns to zero one step per success.

> ~~Superseded (2026-08-05, now dead): "Against Wren's measured curve: at 71%
> failures (concurrency 8) it climbs to the cap; at 17% (concurrency 2) it
> stays pinned at 0."~~ **Wren retracted the dose-response curve the same day.**
> Interleaved measurement showed a roughly even per-request failure chance that
> load barely moves; the ascending curve was a time confound. At `p` near 0.5
> this counter random-walks rather than converging, so the tuning is NOT
> validated. What survives is the defect: a success wiping backoff the failures
> earned is wrong under any failure distribution.

This holds regardless of what the server says about `retryable`, so it also
covers the endpoints that never emit the field.

**Control** (`tests/support/agent-receive-cli.test.ts`): the arm sequence
success, fail, fail, fail, **success**, fail. The lone success in the middle is
the whole point.

| | attempts | delays (ms) |
|---|---|---|
| decay (fixed) | 1, 2, 3, **3** | 250, 500, 1000, **1000** |
| reset (main) | 1, 2, 3, **1** | 250, 500, 1000, **250** |

Inversion: restoring `attempt = 0` fails the loop-level test while the
arithmetic test stays green — it covers `decayFollowAttempt` directly, which
the inversion does not touch.

## Companion 2 — bounded outer restart

`runListenerSupervisor` now retries `options.run` with full-jitter exponential
backoff: 5 attempts, 1s initial, 60s cap. **Bounded is load-bearing** — an
unbounded restart recreates the amplification D-051 removed, one process at a
time instead of one request at a time.

`isRestartableListenerStop` (runtime.ts) draws the line at "could the same read
plausibly succeed later". Restart on 5xx, refusal, transport, timeout, dead
model child. Never on: cancelled (the operator's decision), credential, 4xx,
malformed. This matches Plumb's independently-derived exclusion list.

The veto and the recovery operate at different layers and both survive: the
client still does not immediately retry a refused read.

### Two defects found while building it, both in this change's blast radius

1. **`appendListenerEvent` has a strict field allowlist and throws on unknown
   keys.** The new `restart_attempts` / `restartable` / `restarts_exhausted`
   fields were rejected, so the `listener_failed` line — the one that records
   *why* a listener is down — was silently dropped. Added to the allowlist.
2. **A single rejected write poisoned the supervisor's whole write chain.**
   `writes = writes.then(...)` means one rejection skips every *later* status
   persist and event append: the status file freezes mid-lifecycle and the log
   loses exactly the terminal lines that explain the failure. Each link now
   catches its own failure. This was pre-existing; defect 1 exposed it.

### What this does NOT fix, and it would have shipped broken

**A listener model is single-use.** `runListenerRuntime` closes it in a
`finally` on every exit, and all three adapters (`claude-model.ts:147`,
`grok-model.ts:105`, `opencode-model.ts:131`) throw
`"listener model is closed"` once closed — `closed` is never reset. `cli.ts`
built one model and captured it in the `run` closure, so **every restart would
have failed instantly**, burned all 5 attempts in seconds, and ended in
`failed` anyway — while passing any test whose model double is reusable.

`cli.ts` now calls a `newModel()` factory inside `run`, and the `run` option is
documented as "called once per attempt, so it MUST construct its own
per-attempt resources".

The detached path is covered: `buildListenerChildArgs` spawns
`__listen-supervisor`, which is the same `runListenerSupervisor`. That is the
severity that matters — a detached listener exiting means an agent receives
nothing until a human runs `listen start` again.

## Companion 3 — cancellation cannot be forged by wording

`signals.ts` `isAbortError` matched `/aborted/i` against `error.message`.
Parsing failure bodies (84f0882) made that reachable from outside: `aborted` is
slug-shaped, so it passes the contract-shape filter, and a server answering
`{"error":"aborted"}` on a 500 would have produced

```
signal read failed (HTTP 500): aborted, request_id …
```

classified as a clean operator cancellation. **A receiver would have exited
quietly reporting success, having read nothing** — worse than the retry storm,
because it is silent.

Now name-only, matching `runtime.ts:210`. The follow loop's catch also adopts
runtime's documented precedence: our own abort state, then the credential
predicate, then name-only `AbortError`.

### The sweep, not just the instance

Enumerated every `error.message` classifier in `src/` and assessed each for
reachability by server-controlled text. Server text can only ever appear
*after* the fixed prefix `signal read failed (HTTP NNN)`.

| site | verdict |
|---|---|
| `signals.ts:457` status parse | safe — prefix-anchored |
| `signals.ts:481` transport equality | safe — exact equality |
| `signals.ts:488-491` malformed | safe — different prefix, exact equalities |
| `signals.ts` `isFollowCredentialFailure` | **fixed** — see below |
| `engine.ts:238` prompt retryability | not reachable today; see gap |
| `delivery-journal.ts`, `storage.ts` | safe — local storage errors |
| `command-client.ts:974`, `host/transport.ts:311` | display only, not classification |

`isFollowCredentialFailure` tested `/secret is absent/i` unanchored over the
whole message. It survived only because the shape filter rejects spaces — one
layer of defence, and the same pattern as the `/aborted/i` hole. It now returns
on status alone when the error came off the wire; the wording check is reached
only by locally-thrown errors that never crossed the network.

## Gates

```
npm test            -> tests 447, pass 447, fail 0   (84f0882: 436; main: 429)
npm run test:p1-cli -> tests 149, pass 149, fail 0
npm run build       -> clean
npm run check:tests -> clean
```

All four inversions measured red, each failing a distinct subset:

```
restore `attempt = 0`                  -> 1 test  (loop-level only; arithmetic stays green)
restore `/aborted/i`                   -> 2 tests
restart classifier restarts everything -> 2 tests
loosen the restart bound (+2)          -> 1 test
```

## Not established

- **Still nothing measured against production.** Every control is a stub in a
  pure test. Wren confirmed the binary installed on its laptop is released
  0.1.5, which predates 84f0882 entirely, so no receiver anywhere has yet run
  any of this.
- **Receiver lifetime cannot be measured on Wren's host** — it reaps
  long-running background processes (twice observed, ~28 min and ~2 min), so
  lifetime there cannot distinguish a fatal refusal from the reaper. Requests
  per failure event and final `lastErrorCode` remain safe to measure.
- **`engine.ts:238` `defaultRetryablePromptError` still classifies by message
  regex** (`/timeout|temporar|transport|child exit|connection/i`). It is not
  reachable by server text today — prompt errors come from a local ACP child,
  and the one wire error that can land in that catch
  (`readAgentSignalDirectory` → `member read failed (HTTP n)`) carries no
  envelope. It is the same pattern, though, and would become reachable the
  moment anyone adds envelope text to the directory read path. Left alone
  deliberately: changing prompt-error classification is outside this brief and
  destabilises the listener's retry behaviour.
- The restart policy's *defaults* (5 attempts, 1s, 60s) are unmeasured
  judgment. Nothing establishes that 5 is the right bound under real
  saturation.

---

# D-051 sweep, third instance — the peer does not vote on our retry policy

**Implementation:** Verity, 2026-08-05, same branch. Requested by ClaudeCswarm
after Plumb scoped it; I had deferred this one and recorded why, and that
deferral is now withdrawn.

## The instance

`engine.ts` `defaultRetryablePromptError` fell back to
`/timeout|temporar|transport|child exit|connection/i` over `error.message`.

`transport.ts:314` wraps a peer RPC error as
`AcpProtocolError(peerMessage, "rpc_error")` — **the provider's own text,
verbatim**. So a permanent provider refusal worded with any of those keywords
("connection to this model is not permitted for your plan") was classified
retryable, and `engine.ts` scheduled another model prompt: duplicated provider
work and cost on something that can never succeed.

## Fixed on one principle, not three patches

Classify on error **type**, on a code **we** assign, or on the caller's own
`AbortSignal`. A message is for humans; it is never a branch.

- `AcpTransportError` (code `transport`) added to `host/types.ts`.
- `transport.ts` normalises at the boundary: `asAcpHostError` wraps any raw
  stream failure, so everything leaving the transport carries a code we
  assigned. Lines 73, 76 (stream `error` events) and 129 (write failure) were
  the untyped escapes. An already-typed `AcpHostError` passes through unwrapped.
- `defaultRetryablePromptError` is now type/code only:
  `SenderProvenanceUnavailableError`, or `AcpHostError` whose code is in
  `{timeout, child_exit, transport}`. No regex.

Codes we assign that stay permanent: `rpc_error`, `protocol_error`,
`version_refused`, `permission_canary_failed`, `prompts_blocked`, `closed`,
`pending_limit`.

## Controls

`tests/listener-engine.test.ts` — four provider refusals, each worded to match
a retry keyword, must produce `failed` with the model prompted exactly once.
Positive control on the same path: `timeout`, `child_exit` and `transport`
still retry, and `version_refused` / `permission_canary_failed` /
`protocol_error` still do not.

`tests/host-acp-grok.test.ts` — a bare `ECONNRESET` on the stream leaves the
transport as `AcpTransportError` with code `transport` and the original
preserved as `cause`; an `AcpChildExitError` is not re-wrapped.

### Inversion

The first inversion I ran was **not faithful** and would have overstated the
result: it kept the code check ahead of the restored regex, so an
`AcpProtocolError` never reached the regex and only 1 test went red. Replacing
the whole function with the true pre-fix implementation:

```
restore the real pre-fix defaultRetryablePromptError -> 2 tests red
```

Recorded because the weak inversion looked like a pass.

## The class, closed

| # | site | vector | state |
|---|---|---|---|
| 1 | `signals.ts` `isAbortError` | `/aborted/i` → silent cancel | fixed (companion 3) |
| 2 | `signals.ts` `isFollowCredentialFailure` | `/secret is absent/i` → forged credential stop | fixed (companion 3) |
| 3 | `engine.ts` `defaultRetryablePromptError` | provider text → duplicate paid prompt | fixed here |

Remaining `error.message` reads in `src/` are display-only
(`command-client.ts:974`, `host/transport.ts:311`) or match on strings this
codebase produces locally and that never cross the network
(`delivery-journal.ts`, `storage.ts`, the `signals.ts` transport/malformed
equalities). Each was assessed rather than assumed; the table is in the
companion section above.

## Gates

```
npm test            -> tests 452, pass 452, fail 0
npm run test:p1-cli -> tests 149, pass 149, fail 0
npm run build       -> clean
npm run check:tests -> clean
```

## Correction that matters more than any of the above

**Wren retracted the dose-response curve on 2026-08-05.** Interleaved
measurement showed a roughly even per-request failure chance that load barely
moves; the ascending curve (17% at 2, 58% at 4, 71% at 8) was a time confound,
and the per-credential contention hypothesis is dead by Wren's own hand.

That removes the foundation of the D-051 framing. "Concurrency causes failures,
failures cause retries, retries add concurrency" required failures to scale
with concurrency. They do not.

What this does and does not mean:

- **The client defects were real and are still worth fixing.** Retrying a
  request the server refused, wiping earned backoff on one success, letting
  response text forge a cancellation, and letting a provider bill us for a
  retry it already refused — each is wrong on its own terms, whatever is
  happening server-side.
- **None of this should be expected to move the failure rate.** If failures are
  a per-request coin flip independent of load, reducing client request volume
  does not reduce the proportion that fail. Anyone reading a post-deploy
  improvement as vindication of this change would be reading noise.
- **The server-side cause remains unknown**, and Wren has explicitly declined
  to offer a third mechanism after two died. The six `request_id`s plus
  dashboard access are still the only route to the SQLSTATE.

Also unresolved and worth an operator's attention: the server sends
`retryable: false` on these. `read/diagnostics.ts` derives that from
`isRetryableErrorCode(code)`, and `code` comes from `readStringField(error,
"code")` — **any thrown value without a top-level string `code` yields `null`,
and `isRetryableErrorCode(null)` is `false`.** So `retryable: false` here may
be a false negative from failed code extraction rather than a considered
judgment. The operator log line carries `name` and `code`; if `code` is null
and `name` is not `PostgresError`, that is the answer, and it is one log line
away. This client now obeys that field faithfully — which is correct behaviour,
and also means a server-side misclassification propagates straight to us.

---

# D-055 — the stream's last word is a frame

**Implementation:** Verity, 2026-08-05, same branch. Found by Wren's parser
flagging the line UNPARSED during the paired A/B.

`inbox --follow` requires `--ndjson` (`cli.ts:2327`) and the connect prompt
points non-Grok hosts at it, so the stream is machine-consumed by definition.
The terminal condition was written as bare text:

```
cswarm: signal read failed (HTTP 500): internal_error, request_id 5bdd7856-…
```

A wrapper broke on that line instead of reading a terminal condition. The
information was already there; only the encoding was wrong.

`FollowFrame` gains an `error` variant carrying `reason`, `server_error`,
`request_id`, `server_refused` and `message`, built by `followStopFrame`.
A clean cancellation returns `null` — an operator stop is not an error and the
stream simply ends.

## Emitted by the loop, not by the caller

First implementation put the emit in `cli.ts`. **The inversion caught that it
did not gate anything**: removing the CLI's emit left all three D-055 tests
green, because they exercised `followStopFrame` in isolation. A test that
passes against the wrong target is not a test.

`runInboxFollow` now emits the terminal frame through the same `emit` callback
as the rest of the stream, so no caller can forget it, and the CLI's throw is
left as the human-facing exit status only. That is also the correct ownership:
the loop owns the stream.

The parse test was rewritten to read only what was actually emitted —
appending the terminal frame by hand was the same wrong-target defect one
level up.

## Emitted before ready, on purpose

Three pre-existing tests asserted `frames.length === 0` for fatal-4xx and
credential stops. That encoded the old contract: nothing at all before `ready`.
They now assert the stronger one — no `ready` and no `retrying` frame before
ready, and exactly one terminal `error` frame.

This matters for D-056: Wren measured 2 of 8 cold starts dying **before**
ready. Suppressing the terminal frame until ready would leave precisely the
never-started case unparseable, which is the failure that surfaced this.

## Controls

`tests/support/agent-receive-cli.test.ts`: every line of a refused follow
stream `JSON.parse`s, including the last, with a positive control proving the
old bare-text line would fail that same loop. Plus: a cancellation emits no
error frame, and the frame distinguishes a server refusal from a local stop
(`server_refused`, `request_id`, `server_error` all null/false when the
failure never crossed the network).

Inversion — removing the emission from `runInboxFollow`:

```
-> 3 tests red (the two contract tests and the parse test)
```

## Gates

```
npm test            -> tests 455, pass 455, fail 0
npm run test:p1-cli -> tests 149, pass 149, fail 0
npm run build       -> clean
npm run check:tests -> clean
```

## Wren's A/B, for the record

2.45 requests per failure event pre-fix, exactly 1 post-fix. The prediction was
1 and the falsification condition (non-zero retries on a confirmed refusal with
a confirmed-new binary) did not occur. Binaries were identified by sha256
because both report `cswarm 0.1.6`.

Wren's disclosed deviation — copying `dist` plus `package.json` and pointing
both arms at the laptop's existing `@supabase/supabase-js` 2.110.8 — **does not
affect this result.** The read and retry path uses global `fetch`
(`fetchSignalRead`), not `supabase-js`; the only import of that package in
`src/` is `cloud/auth.ts`. Dependencies were also held constant across arms, so
the client-behaviour comparison stands either way.

---

# D-056 — OPEN pre-deploy decision: does the follow loop need bounded recovery?

**Status at time of writing (2026-08-05): UNDECIDED.** Recorded here because it
is a pre-deploy decision that currently exists only in swarm messages, and a
decision that lives in chat never reaches whoever pulls this repo tomorrow.

## The measurement that raised it

Wren, post-fix: **8 cold starts, 6 reached ready, 2 died before ready — 25%.**
Each death carried an in-band error line, so these are genuine refusals rather
than Wren's host reaping processes.

The gap: companion 2 supervises `runListenerSupervisor`, which is
`cswarm listen start`. Wren measured `cswarm inbox --follow` — the CLI follow
loop, **which has no supervisor**. So the restart protection landed on the
durable listener and not on the receiver the connect prompt tells most hosts to
run.

## The argument for bounded recovery (Verity)

1. **The framing "should we add recovery to a fail-fast tool" is backwards.**
   The follow loop already had *unbounded* recovery — `isRetryableFollowError`
   plus backoff retried 5xx forever, which is what produced the 370 frames.
   84f0882 carved refusals *out* of an existing recovery loop. "Keep its
   current fail-fast behaviour" is therefore not the status quo; it is a
   behaviour introduced four commits ago and now measured at 25% never-start.
2. **The justification for the carve-out is the thing Wren retracted.** The
   veto was justified by amplification — retries add concurrency, concurrency
   causes failures. Wren killed the load-dependence. On a flat per-request
   failure chance, a bounded backed-off retry costs a few requests and does not
   worsen the failure rate.
3. **We are obeying a field that may be meaningless.** `retryable: false` may
   be a false negative from failed `code` extraction (see the section above).
   A possibly-bogus server field killing the receiver most hosts run is the
   defect; either half alone would be tolerable.
4. **"A wrapper can restart it" is the weakest link.** It pushes the exclusion
   list — cancelled/credential/4xx/malformed, which Plumb and Verity derived
   independently — into N host integrations, where it will be implemented
   wrongly or not at all. "Foreground and visible" assumes a human is watching;
   the connect prompt directs *agent* hosts to `--ndjson`, where the wrapper is
   whatever the host does with a subprocess, frequently nothing. At 25%, a
   quarter of agents join and go quiet, which is indistinguishable from
   working.

**Proposal:** bounded refusal tolerance *inside* the follow loop — N refused
reads (start at 3) with the existing full-jitter backoff, then stop and emit
the D-055 terminal frame. This honours the refusal (no immediate retry, the
part that must not erode), cannot amplify (bounded *and* backed off: ~2-4
req/min at backoff, against the 13.2/min removed and the ~30/min the rejected
"fall back to the 2s idle poll" option would have cost), removes the 25%
cliff, and still dies loudly and machine-readably.

## The argument against (ClaudeCswarm's lean)

The follow CLI is foreground and visible and should die loudly, **provided**
the D-055 frame makes the failure machine-readable — a wrapper can then decide
to restart. Supervision belongs in the supervisor, not in every client loop.

## What would settle it

If the operator pulls the `request_id` logs and `retryable: false` turns out to
be a **real** classification naming a genuinely permanent ceiling, then dying
immediately is correct and the argument for recovery collapses. That is the
same single log line that resolves the false-negative question, and it is worth
getting *before* this decision rather than after.

## Not established

- **Companion 1 (backoff decay) has no production evidence at all.** Wren's A/B
  measured the retryable veto only. A proposed measurement — maximum `attempt`
  value seen over a fixed number of reads, both arms, same window — separates
  them without server cooperation, because pre-fix any success resets the
  counter so `attempt` cannot exceed the current consecutive-failure run
  (Wren observed a maximum of 3, exactly what the defect predicts). Caveat
  given to Wren: at p≈0.5 the decayed counter random-walks (drift is 2p−1,
  zero at p=0.5), so it separates only slowly and a short window showing no
  difference is **uninformative, not negative**.
- Whether the 6 receivers that reached ready then survived: Wren killed them at
  12s and did not retain the frames, so there is a cold-start death rate but no
  post-ready survival rate.
