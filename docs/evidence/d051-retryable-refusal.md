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
| ~~`signals.ts:457` status parse~~ | ~~safe — prefix-anchored~~ **DEAD, see below** |
| ~~`signals.ts:481` transport equality~~ | ~~safe — exact equality~~ **DEAD, see below** |
| `signals.ts:488-491` malformed | safe — different prefix, exact equalities |
| `signals.ts` `isFollowCredentialFailure` | **fixed** — see below |
| `engine.ts:238` prompt retryability | not reachable today; see gap |
| `delivery-journal.ts`, `storage.ts` | safe — local storage errors |
| `command-client.ts:974`, `host/transport.ts:311` | display only, not classification |

> ★ **Two rows of the table above are WRONG and are marked dead, 2026-08-05.**
> The D-053 sweep judged the status parse and the transport equality *safe*
> because it asked only one question: can server-controlled text reach them?
> It could not — server text lands after our prefix, and the shape filter
> rejects spaces. But that was the wrong question. **D-058 showed both were
> reachable by any error type spelled the same way**, whatever its origin, and
> the restart classifier turned that into a restart decision. Both sites are now
> identity-tagged and neither reads a message. The reasoning error is worth more
> than the correction: a sweep scoped to one threat model reports "safe" about a
> site that is unsafe under another, and the word "safe" in that table carried
> no scope.

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

`inbox --follow` requires `--ndjson` (enforced by the `if (!args.has("ndjson")) throw` guard in `runSignalRead`; the bare line `cli.ts:2327` cited here previously now resolves to the `"json"` flag entry — see the correction history) and the connect prompt
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

**Status: RESOLVED 2026-08-05 — no bounded recovery. Verity withdrew its own
argument; see "Why the argument for recovery fails" below.** The original
UNDECIDED framing and both arguments are kept intact underneath, because the
reasoning that defeated the proposal is more useful than the conclusion. Recorded here because it
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

---

# Companion 1 is INERT in current production — and now has end-to-end evidence

**Found by Wren, 2026-08-05, confirmed in the code.**

## The interaction between my own two changes

`attempt += 1` sits *inside* the `isRetryableFollowError` branch of
`runInboxFollow`. The D-051 veto makes that branch unreachable for a refused
failure. So:

> Every failure in current production is refused → the veto fires first → the
> read is fatal → the counter is never touched.

Wren verified the premise rather than assuming it — 30 sequential authenticated
reads: `200 ×10`, `500 ×20`, and of those twenty failures **`retryable:false`
×20, `retryable:true` ×0**. There is currently no retryable failure mode on
this path for the decay to act on.

Consequences, stated plainly:

- **Companion 1 has no effect in production today.** It is insurance for a
  failure mode that is not occurring — a 429, or a 5xx the server classifies
  retryable. It is not part of the fix for the current incident.
- It was therefore **unmeasurable in production**, and Wren's null result is
  structural, not the weak-signal null I had warned about. Post-fix cannot emit
  a `retrying` frame at all while every failure is refused, so max-attempt is
  *undefined* for that arm rather than smaller.

## What Wren's measurement did validate

The **diagnosis**, not the remedy. Paired window, same credential, 112s:

```
PRE-FIX  fb94d19: 28 retrying frames over 14 failure events
                  attempt histogram {1: 14, 2: 9, 3: 5}, MAX 3
POST-FIX 5886fa4: zero retrying frames, immediate exit
```

A pre-fix ceiling of exactly 3 is what the reset defect predicts: any success
zeroes the counter, so `attempt` cannot exceed the current consecutive-failure
streak. Wren correctly keeps this separate from whether decaying by one is the
right remedy. Treat 3 as observed-ceiling, not proven-ceiling — one window.

## The end-to-end gate that supplies the missing evidence

`tests/p1-cli/follow-backoff-e2e.test.ts` (new; reached by the
`tests/p1-cli/**/*.test.ts` glob, so `npm run test:p1-cli` runs it — 151 tests
now, was 149).

It spawns **the real CLI** against a loopback stub and reads its stdout, rather
than calling a helper. That is deliberate: D-055 shipped a defect every unit
test missed because the tests called the helper directly while the CLI path
forgot to. A test that passes against the wrong target is not a test.

The stub serves the retryable failure mode production is not currently
producing — `retryable: true` 500s — so the decay is reachable:

| arm | scripted outcomes | attempts observed |
|---|---|---|
| fixed | fail, fail, fail, **success**, fail | `[1, 2, 3, 3]` |
| `attempt = 0` inversion | identical | `[1, 2, 3, 1]` |

Both inversions discriminate, each failing only its own test:

```
restore `attempt = 0`               -> the decay test fails with actual [1,2,3,1]
remove the terminal frame emission  -> the refusal test fails on unparsed stdout
```

The second test also covers the veto and D-055 end to end: a refused read
produces zero retry frames, exits after exactly 2 reads, and its last stdout
line parses as an `error` frame with `server_refused: true`.

## Failure rate is drifting — read every earlier number as a snapshot

Wren measured the same path at three times today: **25%** (cold-start sample),
**50%** (interleaved, concurrency 1), **67%** (30-read sample). No single-
session rate from this incident should be treated as a constant, including the
ones quoted earlier in this document.

## Request ids for the operator

Eight complete ids, harvested from CLI output now that the client surfaces them
(collection needs no dashboard; only reading the server log does):

```
60a897bd-1826-42a6-bbd8-38198fc0cb69
5bdd7856-7334-45bf-bfa1-ff45af5ac17d
a94ec2e2-e8bd-44b6-a0a5-7ab7d8489823
9eb59cf3-70fb-4c2c-94aa-b443f25c5b7d
5868e561-c742-472c-a207-41a04cebb772
4a2e76b2-54aa-439e-8444-b5cf0bba7f74
2e34faad-34df-481a-ad37-ccd4c66610a9
084ecea1-cde8-492f-ad57-f191d930aa88
```

What to read in the function log line for any of them:

- `code` **null** and `name` not `PostgresError` → `retryable:false` was a false
  negative from failed code extraction, never a judgment, and everything
  downstream of it was reasoning about a default value.
- `code` **populated** → a real classification, and since the retryable set is
  small and public (connection classes plus `40001`, `40P01`, `55P03`, `57014`,
  `53300`, `57P03`), any populated code still yielding `false` sits outside it
  and names the ceiling directly.

This is also the log line that settles D-056.

## Why the argument for recovery fails — Verity, withdrawing it

The proposal was "tolerate N refused reads (N=3) with backoff, then die". It
was written believing refusals were a *subset* of failures. Wren then measured
30 sequential authenticated reads: **`retryable:false` ×20, `retryable:true`
×0**. Refusals are not a subset. They are all of them.

Under that fact the proposal is not a safety margin, it is a revert:

| | requests per failure event |
|---|---:|
| pre-fix (measured by Wren) | 2.45 |
| post-fix (measured by Wren) | 1.00 |
| proposed N=3 refusal tolerance | up to 4 |

Pre-fix `attempt` peaked at exactly 3 because any success reset it. An N=3
refusal tolerance would therefore reproduce — or exceed — the behaviour the fix
removed, on 100% of current failures. It would undo the only improvement this
whole change has actually measured, and it would do it by retrying through an
explicit server instruction.

The structural argument against was also right, and it is worth stating
separately because it survives even if the failure mix changes: **the remedy
for "the process exits and nothing restarts it" is supervision, not retry.**
Retry is the remedy for "this request might succeed if repeated", which is
precisely what the server is denying. Companion 2 is supervision and it exists;
it is simply wired to `listen start` and not to the follow loop.

Both points defeat the proposal independently.

## What is NOT solved by deciding this

- **25% of cold starts do not reach ready** on the unsupervised follow path,
  and Wren's failure rate drifted 25 / 50 / 67% across one day, so the true
  figure is regime-dependent and could be worse. Nothing client-side removes
  this without disobeying the server. It is a server-side problem and it stays
  open.
- **Fail-fast is only a policy if something can act on it.** D-055 makes the
  terminal condition parseable on stdout, which serves a host that consumes the
  NDJSON stream — and any host following the connect prompt does. It does not
  serve the supervisor forms that read only an exit status: a shell `until`
  loop, a service unit, a host runner that respawns on nonzero exit. **Every
  cswarm failure is `process.exitCode = 1`** (`cli.ts:3680,3715,3720,3724`
  **as measured at 9df8905** — do not renumber these; the fourth site now calls
  `exitCodeFor`, so refreshing them would turn a true statement about the past
  into a false one about the present), so
  those cannot distinguish "refused, a later attempt may succeed" from
  "credential revoked, do not restart".
  A distinct exit code for the restartable case — reusing the exclusion list
  already written and tested in `isRestartableListenerStop` — would close that
  without costing a single request. Recorded as a proposal, not built, and not
  part of this decision.

---

# D-056 follow-up — a restartable exit status

**Approved by ClaudeCswarm after the D-056 resolution; built narrow.**

Deciding not to retry left fail-fast as the policy, and a policy is only real if
something can act on it. D-055 made the terminal condition parseable on stdout,
which serves any host consuming the NDJSON stream. It does not serve the
supervisor forms that read only an exit status — a shell `until` loop, a service
unit, a respawn-on-nonzero runner — and every cswarm failure exited `1`, so none
of them could tell *"refused, a later attempt may succeed"* from *"credential
revoked, do not restart"*.

`inbox --follow` now exits **75** (`EXIT_RESTARTABLE`, sysexits `EX_TEMPFAIL`:
"temporary failure; the user is invited to retry") when the stop is restartable,
and `1` otherwise. Nothing else changed: same stderr line, same frame, same
requests.

## One predicate, so the surfaces cannot drift

> ~~**Superseded 2026-08-05 by D-057, now dead:** "`isRestartableReadError` in
> `signals.ts` is now the single source of the judgement. Both callers use it…
> `runtime.ts` no longer imports the three underlying classifiers separately,
> which is what would have let the two lists drift apart."~~
>
> Both claims became FALSE at 2b5e905 and are kept here rather than edited away.
> The unification was correct as far as it went — Plumb confirmed no regression
> from it — but the thing it unified was already broken: the predicate was
> default-true over a domain that does not include delivery or ACP failures. See
> the D-057 section. `runtime.ts` now owns `isRestartableRuntimeError`, a closed
> classifier that delegates *only the read-path portion* to
> `isRestartableReadError`, and it does import other classifiers. The surviving
> shared-source claims are narrower and specific: `TRANSIENT_ACP_CODES` is
> shared between the engine and the supervisor, and the follow CLI's exit status
> shares the read predicate.

The reasoning that motivated the unification still holds — two surfaces
answering "is this worth another attempt" must not drift — but a shared
predicate is only as good as its domain, which is the D-057 lesson.

## Causal control

`tests/p1-cli/follow-backoff-e2e.test.ts`, through the real CLI against the
loopback stub — the same harness, extended to serve any failure status:

| stop | exit |
|---|---:|
| refused 500 (`retryable:false`) | **75** |
| 401 revoked credential | **1** |

The test asserts the two differ, not merely that each matches — if they were
equal a shell loop could not separate them, which is the entire point.

Both arms must exit naturally: an early `SIGTERM` from the harness replaces the
status with `null`, which is the quantity under test. The first version of this
test killed at 3 frames and measured `null`; that is fixed and noted because it
is the same wrong-target failure mode as D-055.

Inversion — restore `throw stop.error` unconditionally:

```
-> D-056 test fails: actual 1, expected 75
```

## Gates

```
npm test            -> tests 455, pass 455, fail 0
npm run test:p1-cli -> tests 152, pass 152, fail 0   (was 149 before the e2e harness)
npm run build       -> clean
npm run check:tests -> clean
```

## Not established

- **No supervisor anywhere consumes exit 75 yet.** This makes fail-fast
  actionable; it does not act on it. Whether the connect prompt should tell
  hosts to restart on 75 is a separate decision and is not made here.
- The 25% cold-start figure this was motivated by remains server-side and open,
  and remains regime-dependent (25 / 50 / 67% across one day).

---

# D-057 — closed classification, and a derived oracle

**Found by Plumb, confirmed by execution before fixing.** Blocking MAJOR on the
exit-status commit.

## The defect

`isRestartableReadError` was **default-true**: it excluded three signal-read
types and returned `true` for everything else. `isRestartableListenerStop`
delegated *every* fatal stop to it — but the runtime also emits delivery errors
(the claim/ack paths) and ACP startup failures (`model.start()` throwing).

Verified by running the real predicate rather than reading it:

```
RESTART  DeliveryHttpError 400          RESTART  AcpVersionError
RESTART  DeliveryHttpError 409          RESTART  AcpPermissionCanaryError
RESTART  DeliveryProtocolError          RESTART  AcpProtocolError
RESTART  plain TypeError
  stop   SignalHttpError 400            <- positive control: the three types
  stop   SignalMalformedError              the predicate knew were correct
```

So the supervisor did up to five fresh-model restarts on a 400 invalid_request
or a version mismatch, repeating delivery commands and provider starts that
cannot succeed, and contradicting its own stated 4xx/malformed/protocol
boundary. **The set that failed open was exactly the set the tests did not
cover** — `listener-control.test.ts` exercised only `SignalHttpError` and
`SignalMalformedError`, the two types already known.

## The fix

Closed classification in both layers. An unrecognised failure acquires no
decision:

- `isRestartableReadError` (signals.ts) now enumerates the restartable read
  failures — timeout, transport, HTTP 429/5xx — and returns `false` otherwise.
  A refused 500 still restarts: the `retryable:false` veto governs an
  *immediate retry of the same request*, not whether a later run may work.
- `isRestartableRuntimeError` (runtime.ts) covers delivery (status), command
  posts (status), ACP (`TRANSIENT_ACP_CODES` only), `ListenerCapabilityError`,
  renewal horizons, then delegates to the read predicate.
- `TRANSIENT_ACP_CODES` moved to `host/types.ts` and is now shared by the
  engine's prompt-retry decision and the supervisor's restart decision, so the
  two cannot drift.

Adding a new error type now defaults it to "do not restart". That is the safe
direction: a missed restart is a stopped listener an operator can see; a wrong
restart is work repeated against a server.

## Control

A table of **every** error type the runtime can reach a fatal stop with — 40
rows across read, delivery, command, ACP, runtime-local, renewal and
unrecognised — each asserting its verdict. The table also asserts it exercises
both arms (≥10 restartable, ≥20 terminal) so it cannot pass by being uniform.
Plus a closed-classification test using an error class defined inside the test,
and a supervisor test that a `DeliveryHttpError 400` produces zero restarts.

Inversion — restore the default-true predicate and the old delegation:

```
-> 4 tests red, including all three D-057 tests
```

One earlier assertion changed deliberately: an untyped
`Error("listener model is closed")` is no longer restartable. Wording however
transient does not earn a decision; the typed form, `AcpChildExitError`, does
restart and is in the table.

## The derived oracle — a second finding, also Plumb's

The D-056 test imported `EXIT_RESTARTABLE` from `src/cli.ts`. Two problems:

1. **The oracle was derived from the implementation.** If the constant drifted
   75 → 74, the CLI would emit 74, the import would say 74, and the test would
   stay green while the external contract silently broke. 75 is sysexits
   `EX_TEMPFAIL` and supervisors already know it — it is an external contract
   and must be pinned as a literal. It now is.
2. **Importing `src/cli.ts` executes `main()`.** Plumb saw the usage banner
   during its run. A test importing a CLI entrypoint and running it is a hazard
   beyond this assertion. The import is gone.

The redundant `assert.notEqual` was also removed: once both equalities hold
against a literal that is not 1, it adds nothing. It read as rigour and was a
no-op.

## The pattern, now three instances

| | defaulting behaviour |
|---|---|
| D-053 | control flow on untrusted text — the peer's words steering our branches |
| D-054 | the *server* defaulting `retryable:false` for what it cannot classify |
| D-057 | our own classifier defaulting **true** for what it does not recognise |

An unrecognised input must not silently acquire a decision.

## Gates

```
npm test            -> tests 458, pass 458, fail 0
npm run test:p1-cli -> tests 152, pass 152, fail 0
npm run build       -> clean
npm run check:tests -> clean
```

## Not established

- The table is complete against the fatal sites enumerated in `runtime.ts`
  today. It is a snapshot of that enumeration, not a proof that no other type
  can reach a fatal stop — but the closed default means a missed type stops the
  listener rather than restarting it.

---

# D-058 — the closed classification was bypassable by wording

**Found by Plumb on 2b5e905. This is D-053 surviving inside the D-057 fix.**

## The bypass

`followHttpDetails` fell back to matching `/^signal read failed \(HTTP (\d+)\)/`
against the message, and `isTransportFollowMessage` matched exact transport
prose. `isRestartableRuntimeError` delegates unrecognised errors to the read
predicate — so the closed default was reachable around, by spelling.

Executed on 2b5e905 with an unrecognised `FutureRuntimeError`:

```
'some ordinary failure'                          -> false
'timeout transport connection'                   -> false
'signal read could not reach the cloud service'  -> TRUE    <- bypass
'signal read failed (HTTP 500)'                  -> TRUE    <- bypass
'signal read failed (HTTP 429)'                  -> TRUE    <- bypass
'signal read failed (HTTP 400)'                  -> false
```

An unrecognised type acquired a restart decision from its message, contradicting
the D-057 comment, the closed-classification test, and the D-053 ruling at once.

## Why two people missed it

The D-057 table's `FutureRuntimeError` row supplied only innocuous text.
ClaudeCswarm independently checked `'timeout transport connection'` — which
uses retry *words* but not the *colliding spelling* — got `false`, and reported
the closed default as holding. **Both of us tested that the door was shut
without trying the key that fits.** Plumb used the exact spelling.

That is the generalisable lesson: an adversarial control must be written by
someone asking "what input would make this pass wrongly", not by the author
asking "does my case work".

## The fix

Identity, not prose — and the tags mostly already existed:

- **HTTP:** `plainHttpStatus` has tagged every HTTP failure at construction
  since before this workstream. The regex was therefore *redundant* for real
  errors and served only as the bypass. Deleted.
- **Transport:** added a `plainTransportErrors` WeakSet, tagged by a
  `plainTransportError()` constructor used at all three throw sites.
  `isTransportFollowMessage` now checks identity.

## Controls

Adversarial rows in the D-057 table for **both** colliding spellings, including
the envelope-suffixed form, all asserting `false`.

Positive controls in `agent-receive-cli.test.ts` proving the real tagged paths
still classify after the regex was deleted — deleting a fallback is only safe if
the primary works:

- a real HTTP failure through `readSignals` still reports its status for 400,
  401, 429, 500, 503, and the restart verdict still follows the status;
- a real transport failure is still recognised;
- an impostor `Error` constructed with the **identical message string** gets no
  verdict, asserted alongside the real one in the same test so the pair proves
  discrimination rather than absence.

Inversion — restore the regex and the prose match:

```
-> D-057 table red, D-058 impostor test red
```

## Gates

```
npm test            -> tests 461, pass 461, fail 0
npm run test:p1-cli -> tests 152, pass 152, fail 0
npm run build       -> clean
npm run check:tests -> clean
```

## Not established

- Plumb's sweep for other decision-carrying defaults of this shape came back
  clean; D-054 and D-057 are the whole surface it found. That is a sweep, not a
  proof.
- The identity tags are `WeakMap`/`WeakSet` on Error instances, so an error that
  is serialised and reconstructed — across a process boundary, or through a
  wrapper that copies only the message — loses its tag and correctly gets no
  verdict. That is the safe direction, but it means classification depends on
  the original object surviving.

---

# D-058 follow-up — the two attack surfaces, closed by enumeration

Both were named as unestablished when D-058 landed. Neither is now.

## 1. Does any wrapper strip an identity tag before classification?

**No.** Enumerated, and independently re-run by ClaudeCswarm:

- `asError` (`runtime.ts:412`) is
  `error instanceof Error ? error : new Error(String(error))` — a **pass-through
  for Errors**. It is used **27 times** in `runtime.ts`, so it wraps every fatal
  stop site.
- Message-copying wrappers in `src/`: **5**, all in `cloud/auth.ts` wrapping
  Supabase GoTrue errors, against a control of **477** `new Error(` sites — so
  the search was real rather than a lucky zero.
- No catch-and-rethrow in `runtime.ts`, `engine.ts` or `delivery.ts` converts a
  tagged error into an untagged one.

**This was a near-miss, and it is the finding.** Had `asError` reconstructed
instead of passing through, D-058 would have silently destroyed restart
classification for the entire listener **while every test stayed green** — the
fix depended on that property and nobody had checked it. It surfaced only
because a reviewer's assertion ("nothing wraps them today") and an author's
unswept caveat ("I have not swept for wrap sites") contradicted each other, and
the disagreement was treated as the work rather than as two people agreeing to
move on.

## 2. Is there an untagged-but-legitimate producer whose classification changed?

**No, and the regex turns out to have had no legitimate effect at all.**

```
sites that SET the http tag                  -> 1   (signals.ts:449, in throwSignalHttp)
sites constructing 'signal read failed (HTTP' -> 2   (signals.ts:144 SignalHttpError ctor,
                                                      signals.ts:447 throwSignalHttp)
```

`followHttpDetails` handles `SignalHttpError` by `instanceof` **before** the tag
lookup, and `throwSignalHttp` tags at 449. So the only strings the deleted regex
could match came from errors already classified correctly by type or by tag.

Every other `failed (HTTP n)` message in the codebase uses a different prefix —
`member read`, `project read`, `workspace read`, `command`, `signal failed`,
`login device registration`, `delivery command` — and the regex was `^`-anchored.
`command-client.ts:962` is `signal failed (HTTP n)`, one word short of colliding.

**Therefore deleting it was a zero-behaviour-change fix for real errors and a
total fix for impostors.** Its entire live behaviour was the bypass.

## 3. Remaining, stated not closed

The 40-row table is a snapshot of the enumeration of `runtime.ts` fatal sites
*today*, not a proof that no other type can reach a fatal stop. The closed
default is what makes a missed type safe rather than wrong.

---

# Register — the directory read discards failure detail (pre-existing)

**Form note.** This entry was rewritten after its narrative form required
repeated correction. Every line below carries its own scope, and no quantifier
appears that was not enumerated. The correction history is kept as a record of
what was claimed and refuted; it makes no claim about a common cause.

## What was measured

| # | Fact | Call site | How observed |
|---|---|---|---|
| 1 | The directory read never parses the response body, so `request_id` and `retryable` are not captured. | `signals.ts:944-946` | Read: `throw new Error(\`member read failed (HTTP ${response.status})\`)` with no body access. |
| 2 | The same throw interpolates the HTTP status into the message string. | `signals.ts:946` | Read. Plumb confirmed a raw read carries HTTP 503. |
| 3 | No identity tag is set on that Error, so its status is not available through the typed/identity channel. | `signals.ts:944-946` vs `:449` | Enumerated: `plainHttpStatus.set` occurs at exactly one site, `:449`, inside `throwSignalHttp`. This enumerates TAG SITES, not classifiers — see "what is not established". |
| 4 | `settleSignalAuthorLabels` converts a rejected directory read into a **fulfilled** promise carrying empty maps. | `signals.ts:1220-1227` | Read: `labels.catch(() => ({users: new Map(), agents: new Map()}))`. Plumb measured a 503 resolving to empty maps. |
| 5 | All four `signalAuthorLabels` call sites are wrapped by it. | `cli.ts`, every `signalAuthorLabels(` call | Enumerated: 4 call sites, all 4 immediately inside `settleSignalAuthorLabels(`. |
| 6 | Empty maps are what `renderSignals` reads for author names. | `signals.ts:1341-1343` | Read. |
| 6a | On a lookup miss `renderSignals` emits `${authorKind} ${signal.from}` — the sender kind and id already present on the signal record. It emits no absence marker. | `signals.ts:1344-1345` | Read. |
| 7 | The listener's provenance lookup discards the Error entirely in a bare `catch`. | `engine.ts:434` | Read; the `catch` carries a comment stating the design intent. |
| 8 | For an **agent** sender, missing provenance throws a typed `SenderProvenanceUnavailableError`, which `defaultRetryablePromptError` classifies retryable. | `engine.ts:453`, `:246-247` | Read. Control: `tests/listener-engine.test.ts` "agent prompts retry without a model turn when operator provenance is unavailable". |
| 9 | For a **human** sender, `operatorId` is set from `signal.from` regardless of the directory, so the guard at `:453` never fires and the prompt proceeds with null `senderName`/`operatorName`. | `engine.ts:92-99`, `:453` | Read. ClaudeCswarm verified independently on the gate tree. |
| 10 | The `--to` recipient-resolution path calls `signalDirectory`, which propagates the Error to the caller. | `cli.ts` `signalDirectory()`, its call in `resolveSignalRecipient` | Read; not wrapped. |
| 11 | `readAgentSignalMembers` is `@deprecated` but exported, and propagates the Error unchanged. | `signals.ts:971-983` | Read. Its only in-repo caller is `tests/support/signal-fetch-deadline.test.ts:816`. Plumb found it. |

**The difference between sender kinds, from facts 8 and 9, stated as internal
outcomes only:** on the agent path the ask enters `retry_pending` with
`failureCode = senderprovenanceunavailableerror`; on the human path the model
prompt proceeds with null `senderName`/`operatorName`. Nothing here establishes
what a user sees or how long either state persists — see "what is not
established".

**On facts 4, 6 and 6a together:** the two internal states are indistinguishable
for label lookup — nothing downstream of `settleSignalAuthorLabels` can tell
"directory unreachable" from "this workspace has no members", because both are
an empty map — and names degrade to ids in the rendered line. That is what was
measured. No claim is made here about what a user concludes from it.

**On facts 2 and 3 together:** the status survives only inside a message string.
It is therefore not reachable through the typed/identity channel, and in-repo
policy forbids branching on `.message` (D-053, D-058). Whether any code
nonetheless parses it is a separate question and is not established.

## What is not established

- **Whether any consumer outside this repo calls `readAgentSignalMembers`.** It
  is exported; the enumeration in fact 11 covers in-repo callers only.
- **Whether a failing directory read has actually occurred in production.** No
  measurement; every fact above is read from source or probed locally.
- **What a human user sees end to end when fact 4 fires.** Empty maps reach
  `renderSignals`, but no one has run that path and looked at the output.
- **Which classifiers, if any, read this Error at all.** Fact 3 enumerates tag
  sites, not classifiers. No classifier enumeration was done for this path.
- **Whether any consumer parses the status out of the message string.** In-repo
  policy forbids it, but policy is not enforcement, and consumers of the
  exported wrapper (fact 11) are outside this repo's policy entirely.
- **Whether the same shape exists on other read paths** (`cloudWorkspaceDirectory`,
  `settleSignalStatus`). Not enumerated.
- **Whether the deliberate display fallback in fact 4 is the right design.** It
  is deliberate and its cost is now written down; nobody has ruled on it.

## Why it is not fixed here

It predates this workstream, D-058 changed nothing about it, and a fix needs its
own change with its own control.

## Correction history

Each claim below was made in an earlier version of this entry, then refuted.
Kept so the record is readable without re-deriving it.

| # | Claim | Why wrong | Found by |
|---|---|---|---|
| 1 | The directory Error reaches `defaultRetryablePromptError`, which declines it, so an ask fails. | It never reaches that classifier; `engine.ts:434` swallows it and `:453` throws a typed retryable error instead. | Plumb |
| 2 | "A transient 500 there is treated as permanent." | No layer makes that verdict. Absence of a retry decision is not a decision not to retry — the same conflation as D-054. | Plumb |
| 3 | The consequence stated without a sender kind. | True for agent senders, silently false for human ones. | Verity |
| 4 | "Discards status." | Layer 1 keeps status in the message; layer 2 loses it. Two layers were collapsed into one claim. | Plumb |
| 5 | "A fourth surface of the same **shape** as D-051." | Same family, not the same shape — this branch created the difference by tagging status as identity on the signal read. | Verity |
| 6 | `cli.ts:2025` surfaces the status. | All four of its call sites wrap it in `settleSignalAuthorLabels`. | Plumb |
| 7 | `settleSignalAuthorLabels` "loses everything". | It converts a failure into a success carrying empty maps — indistinguishable from an empty workspace. | ClaudeCswarm |
| 8 | "Exactly one consumer propagates." | The exported deprecated wrapper also propagates. The information had already been supplied and was dropped while compressing. | Plumb |
| 10 | `cli.ts:2327` cited as the `--follow` requires `--ndjson` enforcement. | Correct at the SHA it was written on; after main's additions `:2327` is the `"json"` flag entry. It still RESOLVES, to the wrong thing — the kind a reader believes. Repointed to the guard by symbol. | Plumb (merge-only) |
| 9 | The label fallback "reports absence" and "tells the user something untrue". | `renderSignals:1344-1345` emits `${authorKind} ${signal.from}` and no absence marker. The two internal states are indistinguishable for label lookup. No user-visible claim was measured. | Plumb |

