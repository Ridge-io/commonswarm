# /goal — a 4xx whose body fails to parse must stay a typed HTTP error

Worker: **Mantel** (Codex). Lane: command-client transport classification.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE`, asserted in preflight.**
Owned: `src/cloud/command-client.ts` and `tests/support/signal-fetch-deadline.test.ts`.

## The defect — found by the second review arm, then confirmed by the Lead

`src/cloud/command-client.ts:958-965`:

```ts
if (bodyOutcome.kind === "error") {
  if (response.status >= 500) {
    throw new CommandHttpError(response.status, `signal failed (HTTP ${response.status})`);
  }
  throw bodyOutcome.error;          // <-- 4xx falls through to the raw body error
}
```

When the response is **4xx** *and* the body cannot be read or parsed — a dropped connection mid-body,
or a proxy returning an HTML error page instead of JSON — the code throws the body's own error
(`CommandTransportError`, or a bare `Error` from the non-JSON path) instead of a `CommandHttpError`
carrying the status.

**Why that matters, concretely.** `isRetryablePostError` returns **true** for
`CommandTransportError`. And Runtime A2's entire credential-escape mechanism keys on
`CommandHttpError` with status 401/403. So a **401 whose body fails to parse**:

- is classified as a retryable transport failure rather than a credential failure;
- never reaches the credential escape that restores a resumable `reply_ready` record;
- is retried against credentials that cannot work, and eventually terminalizes.

That is precisely the failure Runtime A2 was built to prevent, reachable through a body-read failure
the status check never sees. The 5xx branch already proves the intent — the author knew typed status
must survive a body failure and applied it to one half of the range.

## The fix

Preserve typed-HTTP precedence for the **whole** error range, not just 5xx. Any `response.status >=
400` with a failed body read must throw `CommandHttpError(response.status, …)`. Below 400, a body
failure is genuinely a transport problem and should keep throwing the body error.

Do not change the successful-parse path, the deadline arms, or the caller-abort arms.

## Explicitly NOT in scope — a rejected second finding

The same review claimed abort-induced rejections can override explicit caller cancellation. **The
Lead checked and rejected it.** `onCallerAbort` (`:882-885`) calls `releaseCallerAbort()` **before**
`controller.abort()`, so the caller-abort arm's continuation is queued ahead of the fetch rejection
and wins `Promise.race`; the comment at `:879-881` documents that ordering as deliberate. Do not
"fix" it — changing that ordering would break the invariant it protects.

## Tests — must discriminate

Add to `tests/support/signal-fetch-deadline.test.ts` (already in the `npm test` literal list, so it
is gated):

1. a **401** whose body read rejects → the thrown error is `CommandHttpError` with `status === 401`,
   **not** `CommandTransportError`;
2. a **403** returning non-JSON (e.g. an HTML error page) → `CommandHttpError` with `status === 403`;
3. a **429** with an interrupted body → `CommandHttpError` with `status === 429` (so retry logic
   still sees a retryable *typed* error rather than an untyped transport one);
4. a **sub-400** response with a failed body read still throws the body's own error — the existing
   behaviour must not regress;
5. the existing 5xx behaviour is unchanged.

Prove **RED before, GREEN after** for 1–3 against the current code. If any cannot be made red first,
say so — it does not discriminate and the fix is unproven.

## Gates

`npm test` (expect the count to rise by the tests you add), `npm run check:tests`, `npm run build`,
`git diff --check`. No DB lane needed. **Do not deploy.**

## Deliverable

Commit once, push, record the new SHA. Write
`/Users/yulanbot/Developer/Ridge.io/cloud-swarm/docs/evidence/2026-08-02-v015-execution/cc-4xx-body-fix.md`
— **`docs/evidence/`, committed** — with the diff, each red-then-green proof, gate counts, and the
new SHA.

## Non-goals

Nothing outside the two owned files. No `site/`, `supabase/`, migration, version bump, deploy, tag, or
release. Do not touch the caller-abort ordering. Do not join the swarm or set swarm status. No
broadcast, no `AdvisorClaude2`.

## Stop conditions

Preflight fails · a test cannot be made red first · the fix appears to require changing the deadline
or abort arms (stop and report — that is a scope finding) · any existing test regresses.

State what you did **not** establish.
