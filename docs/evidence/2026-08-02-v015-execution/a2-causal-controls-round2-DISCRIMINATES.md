# Runtime A2 causal controls — Quoin round 2 result

Frozen object: `ab1b240334efc62b50027512f64692e15d0e0752`  
Worktree: `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi`

Every test invocation used `node --import tsx --test --test-timeout=8000` against one
focused file only. Every per-file acceptance run had a 90-second hard wall-clock watchdog,
captured full output, and was followed by cleanup plus the exact residual-process probe
`pgrep -f 'listener-(engine|runtime).test' | wc -l`. Targeted hang-diagnosis runs used the
same per-test timeout and a stricter 15-second hard watchdog.

## Preflight and isolated baselines

Preflight passed without a fetch:

- HEAD: `ab1b240334efc62b50027512f64692e15d0e0752`.
- `origin/deepseek/runtime-reply-deadline-pi`:
  `ab1b240334efc62b50027512f64692e15d0e0752`.
- `git status --porcelain=v1`: empty.
- Initial focused residual-process count: 0.

Per-file baselines both completed, were not watchdog-killed, and were green:

| File | Completion | Tests | Pass | Fail | Residual count |
|---|---:|---:|---:|---:|---:|
| `tests/listener-engine.test.ts` | completed, exit 0 | 24 | 24 | 0 | 0 |
| `tests/listener-runtime.test.ts` | completed, exit 0 | 14 | 14 | 0 | 0 |

## Control 1 — engine credential classifier disabled

Applied only this mutation to `src/listener/engine.ts`:

```diff
-    this.isCredentialFailure = options.isCredentialFailure;
+    this.isCredentialFailure = undefined;
```

### Engine file

Completed in about one second; it was not watchdog-killed. Counts were 24 tests, 21 pass,
3 fail. Named failures:

- `post credential-classified errors restore exact reply_ready and rethrow by identity`
- `credential errors whose message contains cancelled are escapes, never aborts`
- `a throwing credential classifier restores the record and rethrows its own exception`

Residual count after cleanup/proof: 0.

### Runtime file

The full runtime-file run was watchdog-killed after 90 seconds (exit 137). It printed four
named passes but no final `tests` / `pass` / `fail` counts, so no completed count is claimed.

The wedge was isolated and explained. A targeted run of:

> `a trusted injected poster receives the same closed runtime credential classification`

was itself watchdog-killed after 15 seconds with no completed count. The test directly
awaits `runListenerRuntime`, its `readPage` fixture always returns the same ask, its poster
always throws `RenewalRevoked`, and its injected poll sleep resolves immediately. With the
engine classifier disabled, the first post becomes terminal `failed` instead of escaping as
credential loss. Subsequent scans reread the same ask; the engine returns the already-terminal
record, runtime does not set a stop, and the no-op polling loop repeats. This is active product
looping induced by a fixture that assumes credential loss stops the runtime, not an unresolved
test-only stop promise.

Two controls prevented overclaiming that diagnosis:

- The earlier `runtime abort cancels model immediately while a hung prompt is pending` test
  completed 1/1 green in isolation, so it was not the wedge despite the full runner printing
  no result beyond the first four ordered tests.
- `default poster credential failures stop as credential with the identical error and no
  reply fetch` completed 0/1 red rather than hanging; it failed because the stored state was
  `failed` instead of `reply_ready`. Its credential counter eventually causes a later read-side
  credential stop, so it is not the indefinitely spinning fixture.

Every diagnostic run was followed by a residual-process count of 0.

### Restore proof

Ran exactly `git checkout -- src/listener/engine.ts`. Then:

- Working blob and HEAD blob both:
  `b414d9d630a39a349419cb722979682f94144be4`.
- HEAD remained `ab1b240334efc62b50027512f64692e15d0e0752`.
- `git status --porcelain=v1`: empty.
- Residual focused-process count: 0.

## Control 2 — message cancellation before credential

Applied only the requested `src/listener/runtime.ts` mutant:

- `isAbort` recognized `AbortError` names or `/aborted|cancelled/i` message text.
- In the catch around `engine.process`, `isAbort(error)` ran before
  `isCredentialLoss(error)`; exact caller abort state remained first.

### Per-file result

| File | Completion | Tests | Pass | Fail | Residual count |
|---|---:|---:|---:|---:|---:|
| `tests/listener-engine.test.ts` | completed, exit 0 | 24 | 24 | 0 | 0 |
| `tests/listener-runtime.test.ts` | completed, exit 1 | 14 | 12 | 2 | 0 |

The engine file staying green is expected because this control mutates only runtime code.
Named runtime failures:

- `an injected poster throwing typed 401 with hostile text stops as credential, never cancelled`
  — actual stop was `cancelled`, expected `credential`.
- `the default-post HTTP 401/403 path stops as credential, not fatal or cancelled`
  — the first HTTP 401 arm stopped `cancelled`, expected `credential`.

Neither file was watchdog-killed.

### Restore proof

Ran exactly `git checkout -- src/listener/runtime.ts`. Then:

- Working blob and HEAD blob both:
  `313e209f4960c472d17eaa851aeb07b44f3c9f23`.
- HEAD remained `ab1b240334efc62b50027512f64692e15d0e0752`.
- `git status --porcelain=v1`: empty.
- Residual focused-process count: 0.

## Control 3 — poster caller-signal forwarding removed

Deleted only the `src/listener/runtime.ts` spread that passed engine `abortSignal` into
`ThinCommandClient.sendSignal` as `signal`.

### Per-file result

| File | Completion | Tests | Pass | Fail | Residual count |
|---|---:|---:|---:|---:|---:|
| `tests/listener-engine.test.ts` | completed, exit 0 | 24 | 24 | 0 | 0 |
| `tests/listener-runtime.test.ts` | completed, exit 1 | 14 | 13 | 1 | 0 |

The engine file staying green is expected because this control mutates only runtime code.
Named runtime failure:

- `the default poster forwards the runtime caller signal and stays bounded` — its two-second
  race failed with `runtime did not settle after caller abort`.

The runtime file completed rather than being watchdog-killed. The test's fake fetch never
settles and ignores transport abort. Without the caller signal, its two-second bound goes red;
the file then remains alive until the command client's independent
`SIGNAL_REQUEST_TIMEOUT_MS = 30_000` deadline releases the post. Final file duration was about
30.15 seconds, inside the 90-second hard watchdog.

### Restore proof

Ran exactly `git checkout -- src/listener/runtime.ts`. Then:

- Working blob and HEAD blob both:
  `313e209f4960c472d17eaa851aeb07b44f3c9f23`.
- HEAD remained `ab1b240334efc62b50027512f64692e15d0e0752`.
- `git status --porcelain=v1`: empty.
- Residual focused-process count: 0.

## Verdict

Yes. At frozen SHA `ab1b240`, A2's focused engine/runtime suite discriminates all three
requested invariants:

1. Removing the engine credential classifier produces three completed engine failures and
   an explained runtime watchdog kill at a credential-stop fixture.
2. Restoring message-text cancellation and checking it before credential loss produces two
   completed runtime failures that show hostile HTTP text becomes cancellation.
3. Removing caller-signal forwarding produces one completed runtime failure that shows the
   caller abort no longer bounds the default transport post.

The per-file isolation is load-bearing: Control 1's runtime spin does not erase the engine
file's completed 24/21/3 counts.

## Final state and evidence ceiling

The frozen worktree was restored after every control. At completion it remained clean at
`ab1b240334efc62b50027512f64692e15d0e0752`, both mutated source blobs matched HEAD, and the
focused residual-process count was 0.

This work did **not** establish the full `npm test` suite, TypeScript build/check gates,
Runtime C/D composition, database or Supabase behavior, edge functions, provider/live-network
behavior, deployment, release, or production behavior. It did not fetch, merge, rebase, push,
tag, move any SHA, edit package/test files, run database/deploy/release commands, broadcast,
join or update swarm status, or contact `AdvisorClaude2`.
