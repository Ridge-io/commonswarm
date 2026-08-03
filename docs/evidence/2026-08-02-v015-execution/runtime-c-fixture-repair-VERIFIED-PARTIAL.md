# Runtime C work item 1 — fixture repair, independently verified: PARTIAL

Verified by the Lead against `f30974a3c972e116e4b15ac705a70df3b47a33e0`, by applying the A2
classifier mutant (`this.isCredentialFailure = undefined` in `src/listener/engine.ts`) and measuring.
The engine was restored byte-identically after every probe and residual processes were 0 each time.

## What the worker claimed

That `tests/listener-runtime.test.ts:540` — *"a trusted injected poster receives the same closed
runtime credential classification"* — was repaired with a scan-count cap so the A2 classifier mutant
produces a **printed named failure** instead of an unbounded hang.

## What I measured

| Probe (mutant applied) | Result |
|---|---|
| Test 540 alone, `--test-name-pattern` | **terminates, 0 pass / 1 fail** — printed named red ✅ |
| Whole file, default concurrency, 100 s watchdog | **HANGS** — no counts, no named failures ❌ |
| Whole file, `--test-concurrency=1`, 120 s watchdog | **HANGS** at the same point ❌ |
| Test #23 alone | terminates, 1 pass |
| Test #22 alone | terminates, 1 pass |
| Tests #22 + #23 together | terminates, 2 pass |
| **Whole file, NO mutant** | **terminates in ~2 s, 32/32** ✅ |

The scan-count cap is real and correct (`tests/listener-runtime.test.ts:1714-1731`: `scanCount += 1;
if (scanCount > 1) controller.abort();`). It is an injected stop condition, not a timer in the
starved process.

## The finding

**The worker's specific claim is true; the file-level objective is not met.** Test 540 now prints
named red exactly as intended. But the whole file still wedges under the mutant, and the stall is
**cumulative** — the last test to print is #22, yet #22 alone, #23 alone, and #22+#23 together all
terminate. Something in the preceding twenty-one tests leaves the event loop starved once the engine
is mutated. The worker verified its named test in isolation and did not run the file, so it reported
success in good faith for a narrower claim than the goal asked for.

**This is not a product defect.** It manifests only when the engine is deliberately broken, which
happens only during a causal-control run. Unmutated, the file is green in about two seconds.

## Binding consequence for Stage 7

Stage 7 re-proves that the named causal controls still discriminate. It **must not** run a causal
control by executing a whole test file.

> **Causal controls are run per-test**: `--test-name-pattern="<exact test name>"` plus
> `--test-concurrency=1` plus an **external wall-clock watchdog** (neither `timeout` nor `gtimeout`
> exists on this machine — use background-and-kill). `--test-timeout` alone is insufficient: Node
> enforces it with a timer in the same process, and a microtask-starved loop never reaches the timers
> phase. A whole-file invocation yields a hang, which is **not** evidence — only a printed named
> failure is.

Verified above: the per-test invocation returns a clean 0 pass / 1 fail for control 540.

## Backlog, post-0.1.5

Find and bound the cumulative leak so the runtime file can be mutant-run whole. Candidate approach:
bisect the first twenty-one tests under the mutant to identify which leaves a live runtime, then give
its fixture the same scan-count stop condition. Not worth a SHA movement before the freeze — the
per-test invocation fully covers the release gate's need.

## What this does not establish

The other Runtime C checkpoints (config/modes/events, journal/claim/retry/budget,
effects/ACK/cancel/rollback/crash), which are covered by the worker's own red-then-green records and
the D-036 arms on `f30974a`. Deployment, production behaviour, and real-load capacity remain out of
scope.
