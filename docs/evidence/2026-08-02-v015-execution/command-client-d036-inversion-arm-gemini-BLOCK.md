### Prioritized Findings

#### CRITICAL
CRITICAL: None.

---

#### MAJOR

##### 1. Typed-HTTP Precedence Violated for 4xx Responses with Unreadable or Non-JSON Bodies
* **Severity**: MAJOR
* **Exact File:Line**: [command-client.ts:958-966](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cloud/command-client.ts#L958-L966)
* **Triggering Sequence**:
  1. `sendSignal` receives response headers with a 4xx status code (e.g., `401 Unauthorized`, `403 Forbidden`, or `429 Rate Limit`).
  2. The TCP stream drops during body read or the endpoint returns non-JSON text (e.g., HTML error page from a proxy).
  3. `parsedJson(response)` throws `CommandTransportError("command response was interrupted...")` or `Error("command endpoint returned non-JSON...")`.
  4. `bodyOutcome` settles with `kind: "error"`.
  5. Line 959 evaluates `if (response.status >= 500)`. Because `response.status` is a 4xx status (`< 500`), this check evaluates to `false`.
  6. Line 965 executes `throw bodyOutcome.error;`, throwing `CommandTransportError` (or a generic `Error`).
* **Production Consequence**: Violates the core error classification invariant ("typed-HTTP precedence must decide, never wording or body settlement"). Non-retryable HTTP 4xx failures (such as `401` auth failures or `403` forbidden) are misclassified as retryable `CommandTransportError` network failures, causing supervisory retry loops to endlessly re-post signals with invalid credentials.
* **Narrowest Correction**:
```typescript
if (bodyOutcome.kind === "error") {
  if (response.status >= 400) {
    throw new CommandHttpError(
      response.status,
      `signal failed (HTTP ${response.status})`,
    );
  }
  throw bodyOutcome.error;
}
```

##### 2. Abort-Induced Fetch/Body Rejections Override Explicit Caller Cancellation
* **Severity**: MAJOR
* **Exact File:Line**: [command-client.ts:934-944](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cloud/command-client.ts#L934-L944) & [command-client.ts:952-966](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cloud/command-client.ts#L952-L966)
* **Triggering Sequence**:
  1. The caller aborts `request.signal` while `fetchWork` or `parsedJson` is pending.
  2. `onCallerAbort` executes `releaseCallerAbort()` and `controller.abort()`.
  3. The underlying `fetcher` or `response.text()` handles `controller.signal` abort and rejects `fetchWork` or `parsedJson` with an error.
  4. If `raceSignalDeadline` resolves the phase with `kind: "error"` (e.g. if the work rejection promise reaction is processed alongside or prior to the caller abort tag), lines 940–944 or 958–966 execute.
  5. `sendSignal` throws `CommandTransportError("signal request failed before a response")` (or body transport error) without checking `callerSignal?.aborted`.
* **Production Consequence**: Violates Runtime A2's explicit caller-abort precedence invariant ("A caller abort surfaces as a genuine AbortError"). Callers filtering on `error.name === "AbortError"` fail to recognize that caller cancellation succeeded and incorrectly handle the rejection as a transport failure.
* **Narrowest Correction**:
```typescript
if (fetchOutcome.kind === "callerAbort" || callerSignal?.aborted) {
  throw signalAbortError();
}
```

---

#### MINOR

##### 1. Inconsistent `ReauthenticationRequired` Throw for 401 `fresh_auth_required`
* **Severity**: MINOR
* **Exact File:Line**: [command-client.ts:968-980](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cloud/command-client.ts#L968-L980)
* **Triggering Sequence**: The server responds to `sendSignal` with HTTP `401` and body `{ "error": "fresh_auth_required" }`.
* **Production Consequence**: Unlike `send` (line 616) and `sendConnect` (line 736) which convert `fresh_auth_required` into a structured `ReauthenticationRequired` exception with clear re-login instructions, `sendSignal` throws a generic `CommandHttpError(401)`.
* **Narrowest Correction**:
```typescript
if (response.status === 401 && error.error === "fresh_auth_required") {
  throw new ReauthenticationRequired();
}
```

---

**VERDICT**: BLOCK — static analysis performed only; runtime tests, network simulation, and live backend execution were NOT verified.

---

# Lead adjudication of this arm's two MAJOR findings

## Finding 1 — CONFIRMED, fixed at `0d88ef1`

Verified in source before dispatching anything. `command-client.ts:958-965` threw the body's own
error for a 4xx whose body could not be parsed, reaching `CommandHttpError` only at `>= 500`.

Consequence traced, not assumed: `isRetryablePostError` returns **true** for
`CommandTransportError`, and Runtime A2's credential escape keys on `CommandHttpError` 401/403. So a
**401 with an unparseable body** — a dropped connection mid-body, or a proxy returning HTML — was
classified as a retryable transport failure, never reached the credential escape, and terminalized.
That is the exact failure A2 exists to prevent, reachable through a path the status check never saw.

**The fix is one character**: `>= 500` → `>= 400`. Plus 100 lines of tests. The caller-abort ordering
was left untouched, as instructed (verified: zero references to it in the diff).

**Proven to discriminate by the Lead**, not read from the worker's report. Reverting the single
character and running the focused file:

```
tests 18 | pass 15 | fail 3
✖ sendSignal keeps a 401 body-read failure as a typed HTTP error
✖ sendSignal keeps a non-JSON 403 as a typed HTTP error
✖ sendSignal keeps a 429 interrupted body as a retryable typed HTTP error
```

Restored byte-identically; tree clean.

## Finding 2 — REJECTED

The claim that abort-induced rejections can override explicit caller cancellation does not hold.
`onCallerAbort` (`:882-885`) calls `releaseCallerAbort()` **before** `controller.abort()`, so the
caller-abort arm's continuation is queued ahead of the fetch rejection and wins `Promise.race`. The
comment at `:879-881` documents that ordering as deliberate, for precisely this reason. Changing it
would break the invariant it protects, so the fix contract explicitly forbade touching it.

## Why this arm mattered

The exact arm passed this file clean. This inversion found a real defect on the credential path —
the mechanism the release's headline work depends on. **One arm would have shipped it.** That is the
concrete case for D-036's two-arm rule, and the first time in this release the two arms have
disagreed on a substantive finding.
