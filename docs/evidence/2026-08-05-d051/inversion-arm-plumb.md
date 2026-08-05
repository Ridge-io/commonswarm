# D-051 cross-family inversion arm — Plumb, exact `84f0882`

Reviewer: **Plumb** (codex family). Author: Verity (claude). Exact arm: ClaudeCswarm. Reviewed on a
**frozen detached tree** at `84f0882` after the Lead contaminated the first one — see the process note.

**Verdict: 3 MAJORs. The commit does not ship alone.**

## Findings

**1 — `retryable: false` permanently kills durable listeners.** Runtime fatal → supervisor failed →
detached process exits, and **no restart loop exists** (`detach.ts:138-173`). One transient production
500 removes that agent's receiver until a human runs `listen start`. Converts request amplification
into permanent receiver loss.

**2 — the non-refusal arm still amplifies.** `signals.ts:1625` and `runtime.ts:774` reset
`attempt = 0` after **every** success, so `fail/fail/success/fail` produces delays of 250 ms, 500 ms,
then 250 ms again — earned pressure is discarded and the 30 s cap is never reached. Reachable with
`retryable: true` (the server marks `53300 too_many_connections` retryable) **and** when the field is
absent, which D-051 deliberately leaves status-based. **The combined decision set is unsafe in both
directions.**

**3 — injection defeat, reproduced.** `error-envelope.ts:37-43` accepts `error='aborted'` and
`request_id='request_aborted_123'` as contract-shaped; `describeServerError:79-87` copies either into
`error.message`; `signals.ts:1496-1498` matches `/aborted/i` **anywhere** in that message; and
`runInboxFollow:1672-1674` checks it **first**.

```
error='internal_error'                             -> stop.reason='error'
error='aborted'                                    -> stop.reason='cancelled'
internal_error + request_id='request_aborted_123'  -> stop.reason='cancelled'
```

Both forged stops carry `error === undefined`, and `cli.ts:2518-2519` returns normally on cancelled —
so a hostile **or merely nonconforming** server makes `cswarm inbox --follow` **exit silently as though
the operator cancelled it.**

**This is a regression of an already-ruled defect class.** `runtime.ts:184-186` is name-only;
`signals.ts:1496` kept a message regex. The A2 credential-escape lane removed message-regex matching
from `isAbort` and the Lead's own review of that lane recorded *"the message regex is gone."* It was
removed from two sites and a third survived.

## Non-findings, each with a positive control — the part that makes the review usable

- **Credential-phrase injection resisted 10/10** hostile case/unicode/nested/long bodies, **with 2/2
  deliberately-unrestricted variants confirming the probe detects a leak when one exists.** Verity's
  contract-shape restriction holds.
- **The veto reaches exactly the two retrying callers** (`signals.ts:1682`, `runtime.ts:792`);
  `pollForSignals` propagates HTTP errors rather than retrying. Verity's "covers both loops" is correct.
- Malformed, truncated, primitive and stream-error bodies fall back to status behaviour.
- `retryable: true` does not promote a 401.
- Edge entrypoints are command/read/capability, and **only `read/diagnostics.ts` contains `retryable`
  — positive-controlled zero in command and capability**, confirming Verity's deliberate omission.

Focused suite 45/45 on the frozen tree, clean status, no edits.

## Process note, recorded because it nearly cost the evidence

The Lead assigned Verity's companion build and Plumb's review to **the same clone**. Plumb detected the
tree changing mid-review, **preserved the other writer's work, re-based its verdict on `84f0882` git
blobs, and discarded its 47-test run as exact-SHA evidence rather than keeping a result it could no
longer stand behind.** A frozen detached tree was then provided.

Third one-writer-per-worktree violation by the Lead in one session.

## Not established by this arm

Full 436/149 gates (re-run by the Lead), production outcome, and unbounded huge-body memory behaviour.
**A replacement SHA requires both arms again.**

---

## Pattern sweep — complete enumeration, exact `84f0882`

**9 semantic `error.message` classifiers across 11 source sites**, every one categorised.

### Unsafe — exploited

1. `signals.ts` `isAbortError` `/aborted/i` — silent cancellation. Reproduced.
2. `engine.ts` `defaultRetryablePromptError` keyword regex — provider controls retry. Reproduced.

### Guarded today, structurally unsafe

3. `signals.ts` `isFollowCredentialFailure` `/secret is absent/i` — **no producer exists in `src`**
   (search finds only the classifier and a comment). On this SHA the read-body parser blocks spaces and
   a typed `CommandHttpError` returns before wording is consulted, so there is **no remaining wire
   path**. **Replace it with a typed secret-missing error anyway: the next free-form producer reopens
   it.** A defect that is unreachable by accident is not fixed.

### Safe — local-only strings, each justified

- `followHttpDetails` — parses a locally-created fixed HTTP prefix, ignores the server-supplied suffix.
- `isTransportFollowMessage` — compares one locally-created exact sentence.
- `isMalformedFollowMessage` — matches only local parser constants.
- `storage.ts:457` — the local `readSecureJsonFile` oversize sentinel.
- `delivery-journal.ts:274` — compares its own static `errMessage`.
- `delivery-journal.ts:658-659`, `1013-1014` — canonicalise the same local oversize sentinel. **Noted
  edge:** a user-chosen path containing the phrase changes their local error label to `malformed`, with
  no authority or retry effect.

Server messages in `command-client`, `auth` and `pending-command` are displayed or wrapped; their
control classifiers branch on typed class or status **first**.

### Rule this sweep supports, now in `AGENTS.md`

**`error.message` is presentation only. Control flow uses named classes or a stable bounded code.**
