# CC 4xx unreadable-body fix — Mantel

Frozen base: `a276fc5448e77a83c654450a3787918ffc064715`
Branch: `lead7/mvp-release-0.1.5`
Candidate commit: the single commit containing this file; its exact SHA is recorded in the
post-push handoff because a Git commit cannot contain its own object ID.

## Preflight and scope

Before any edit, local `HEAD`, the tracking ref, and the live remote branch all resolved to the
frozen base. The worktree was clean. `tests/support/signal-fetch-deadline.test.ts` is a literal path
in the root `npm test` script, so the new observers are gated without a database slot.

The implementation diff is one threshold change:

```diff
-        if (response.status >= 500) {
+        if (response.status >= 400) {
```

This makes a failed body read or parse yield `CommandHttpError(response.status, ...)` for the whole
HTTP error range. Below 400, the existing `throw bodyOutcome.error` path is unchanged. No deadline,
`Promise.race`, controller, caller-abort, or listener ordering changed.

Five tests and one local response helper were added to the already-gated test file. Before the
evidence file was added, the scoped diff was 101 insertions and 1 deletion across the two owned
implementation/test files.

## RED discrimination

The root baseline before adding tests was 365/365 across 21 suites.

Against the untouched frozen implementation, one exact name-pattern invocation selected only the
three defect cases and returned exit 1:

| Case | Frozen result |
|---|---|
| 401 body read rejects | RED: expected `CommandHttpError(401)`; got `CommandTransportError` |
| 403 body is non-JSON HTML | RED: expected `CommandHttpError(403)`; got bare non-JSON `Error` |
| 429 body read rejects | RED: expected `CommandHttpError(429)`; got `CommandTransportError` |

Runner summary: 3 tests, 0 pass, 3 fail, 0 skipped. All three failed at the typed-error assertion,
not from a timeout or harness error.

The two boundary tests were green on the frozen implementation because they protect behavior the
goal requires preserving. Each was also made RED with a temporary causal mutant before the real
fix, then the source was restored byte-clean:

| Boundary control | Mutant | RED observation |
|---|---|---|
| status 399 keeps the body transport error | threshold `>= 0` | got `CommandHttpError(399)`; 0/1 |
| status 503 keeps typed HTTP precedence | threshold `>= 600` | got `CommandTransportError`; 0/1 |

Neither mutant remained in the worktree. These controls therefore prove both sides of the final
`>= 400` boundary can fail, rather than merely passing alongside the correction.

## GREEN proof

After the production threshold changed to `>= 400`, one exact name-pattern invocation selected all
five new cases: 5 tests, 5 pass, 0 fail, 0 skipped. The complete target file passed 18/18, including
the pre-existing caller-abort and 5xx first-winner observers.

The root gate count rose by exactly the five new tests:

| Gate | Result | Wall time |
|---|---:|---:|
| `npm test` | 370/370, 21 suites | 4.93 s |
| `npm run check:tests` | exit 0 | 3.25 s |
| `npm run build` | exit 0 | 2.57 s |
| `git diff --check` | exit 0 | <0.01 s |

## Review

A read-only Google Gemini 3.1 Pro high-effort inversion reviewed the complete uncommitted diff
against the frozen base and the goal. It substantively checked the package gate, owned scope,
caller-abort invariance, the `< 400` branch, the whole `>= 400` branch, and the five test cases. It
returned PASS with no blocking finding. The first sandboxed invocation produced no review because
repository reads were denied; it was not counted. The successful invocation had tool permission,
was explicitly prohibited from editing, and the worktree was rechecked afterward.

The repository-required exact-SHA Codex review and independent Gemini inversion are run again on
the final commit object after the single commit exists. Their exact-SHA result is necessarily
post-commit evidence and is recorded in the final handoff; any finding that requires a code change
blocks the push rather than creating a second commit.

## Not established

This work does not establish deployment, live Supabase behavior, behavior through a real proxy or
interrupted production connection, or production Runtime A2 recovery. It does not establish any
behavior outside `ThinCommandClient.sendSignal`. It does not change or re-prove the deliberate
caller-abort ordering beyond the existing pure tests. No database, local Supabase, edge-function,
site, migration, version, tag, release, swarm status, broadcast, or AdvisorClaude2 contact is part
of this result.
