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
