# Stage 7 causal-control register

Status: inventory only; no control was run while producing this register.

This register separates two facts that the old Stage 7 wording combined:

- the release evidence records **12 independently selectable mutant/test pairs**; and
- **0 of the 10 named Stage 7 domains has a recorded domain-valid causal control**. All 10 domains
  are blind at this gate.

The second count is the release decision. A control for a nearby invariant is not credited to a
domain it does not cause. In particular, the Phase B controls discriminate the database harness,
not production claim one-winner behavior; Phase C discriminates delivery-rate recharge, not the
poison ceiling; Runtime A2 discriminates credential-loss classification, not credential absence
from argv/environment/status/logs; and the command-client controls discriminate typed HTTP
classification, not response-loss replay with a stable body and command ID.

## Binding instrument rules

1. **Per-test, never whole-file.** Every invocation uses an exact `--test-name-pattern`,
   `--test-concurrency=1`, and an external wall-clock watchdog. There is no `timeout` or `gtimeout`
   on this machine. Node's `--test-timeout` is enforced by a timer in the test process, so a
   microtask-starved loop can prevent it from firing. **A hang is not evidence.**
2. **A green mutant is a mandatory stop.** Only the expected printed named failure counts. A
   compile/startup failure, watchdog kill, cleanup failure, earlier-topology failure, or different
   assertion is not causal evidence for the row.

Before any database row, acquire the exclusive DB lane, start/reset the local stack in the Stage 7
sequence, build the generated command core, and prove no competing server/local/function-serve
process. Those shared Stage 7 prerequisites are not repeated as if each were part of the mutant.
Restore every mutant byte-identically before moving to the next row.

The following shell function is the complete external-watchdog wrapper used by every Invocation
cell below. Paste it once into the Stage 7 shell. Each cell then supplies exactly one file and one
test name; it never runs a whole file's test set.

```sh
run_one_control() {
  control_seconds="$1"
  control_file="$2"
  control_name="$3"
  control_pattern="$(node -e 'process.stdout.write("^" + process.argv[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$")' "$control_name")"
  control_output="$(mktemp)"
  control_marker="${control_output}.watchdog-fired"

  node --import tsx --test --test-concurrency=1 \
    --test-name-pattern="$control_pattern" "$control_file" \
    >"$control_output" 2>&1 &
  control_pid=$!
  (
    sleep "$control_seconds"
    if kill -0 "$control_pid" 2>/dev/null; then
      : >"$control_marker"
      kill -TERM "$control_pid" 2>/dev/null
    fi
  ) &
  control_watchdog=$!

  wait "$control_pid"
  control_exit=$?
  kill "$control_watchdog" 2>/dev/null
  wait "$control_watchdog" 2>/dev/null
  cat "$control_output"
  echo "control_output=$control_output exit=$control_exit"

  test ! -e "$control_marker" || {
    echo "WATCHDOG FIRED — not evidence"
    return 124
  }
  test "$control_exit" -ne 0 || {
    echo "GREEN MUTANT — mandatory stop"
    return 1
  }
  rg -F -- "$control_name" "$control_output"
}
```

## Required-domain coverage

Each row below is the ten-domain acceptance inventory. “Observer” means a current named test exists,
but the cited evidence does not record an exact defect mutation and its expected per-test red. It is
not a causal control.

| Required domain | Recorded control | Mutant | Test | Invocation | Expected failure | Slot | Evidence-based disposition |
|---|---|---|---|---|---|---|---|
| Enqueue/backfill | **No** | No recorded enqueue/backfill mutation. | Observers exist in `tests/p1-server/command.test.ts`: `durable-delivery: trigger enqueue ask/note; broadcast and direct-human do not` and `durable-delivery: causal migration backfill enqueues pre-existing direct agent signals`. | None. | None recorded. | DB | **No control recorded — gate is blind here.** |
| Claim one-winner | **No** | No recorded mutation that permits two live winners. Phase B mutates only test-harness settlement/deadline/cleanup; Phase C deletes rate recharge. | Observer: `tests/p1-server/command.test.ts` — `durable-delivery: concurrent claimers produce one lease winner`. | None. | None recorded for a two-winner mutant. | DB | **No control recorded — gate is blind here.** |
| Stale-lease requeue | **No** | No recorded mutation that disables stale-lease cleanup/requeue. | Observer: `tests/p1-server/command.test.ts` — `durable-delivery: stale lease requeues; signal TTL expires once; tenth claim poisons`. | None. | None recorded for stale requeue in isolation. | DB | **No control recorded — gate is blind here.** |
| Poison ceiling | **No** | No recorded mutation that removes or shifts the tenth-claim poison boundary. Phase C's 120-request rate boundary is a different invariant. | Same combined server observer as stale-lease requeue. | None. | None recorded for the poison boundary in isolation. | DB | **No control recorded — gate is blind here.** |
| Response-loss replay | **No** | No recorded mutation that mints a new body/ID or prompts again after a lost response. The recorded 4xx-body mutants below change error taxonomy only. | Observer: `tests/listener-engine.test.ts` — `lost response replays the persisted body/id without prompting again`. | None. | None recorded. | No | **No control recorded — gate is blind here.** |
| Persist-before-ACK | **No** | No recorded reversed-order mutation. Runtime C records RED-before-GREEN and static ordering review, but not an exact mutation run for this domain. | Observers in `tests/listener-runtime.test.ts`: `a durable note is persisted and reread before prepareAck and network ACK` and `a durable ask reaches done, then persists prepareAck before replied ACK`. | None. | None recorded for reversed ordering. | No | **No control recorded — gate is blind here.** |
| Note with zero prompts | **No** | No recorded mutation that calls the model/poster for a durable note. | Observer: `tests/listener-runtime.test.ts` — `cursor fallback observes direct notes without model or reply effects`; the durable-note observer above also checks ordering. | None. | None recorded. | No | **No control recorded — gate is blind here.** |
| Cross-owner zero-tool isolation | **No** | No recorded mutation that gives a cross-owner turn tools/context. The real two-human canary remains operator-blocked and is not a local mutant. | No exact zero-tool isolation test is recorded in the cited evidence/contracts. | None. | None recorded. | No | **No control recorded — gate is blind here.** |
| Privacy/no-body | **No** | No recorded mutation that inserts a body/private sentinel into delivery metadata. Phase C checks privacy while mutating recharge, so its red is not a privacy discriminator. | Observer: `tests/listener-cli-process.test.ts` — `detached CLI completes durable claim reply ACK with one startup UUID and no secret leakage`; Phase C has response/alert sentinels. | None. | None recorded for a body leak. | Mixed | **No control recorded — gate is blind here.** |
| Credential absence | **No** | No recorded mutation that exposes a credential in argv, environment, status, logs, or host frames. Runtime A2's mutants below change credential-loss handling, not credential exposure. | Same detached CLI leakage observer as privacy/no-body. | None. | None recorded for credential exposure. | No | **No control recorded — gate is blind here.** |

Coverage total: **0 domains with recorded controls; 10 domains blind**.

## Recorded mutant/test register

These 12 rows preserve what the release evidence actually established. They are runnable and useful,
but they do not substitute for any blind domain above. The counting rule is one independently
selectable exact test per row; shared mutants therefore appear once for each independently runnable
named assertion.

| ID | Invariant actually proved | Exact mutant | Exact test | Invocation | Expected printed red | Slot | Recorded source |
|---|---|---|---|---|---|---|---|
| PB-1 | Cancelled poll queries settle before the harness returns. | `tests/p1-server/command.test.ts`: change `await Promise.allSettled([query]);` to `Promise.allSettled([query]);`. | `tests/p1-server/command.test.ts` — `durable-delivery: Phase B harness control — premature marker and request settlement fail fast with labels` | `run_one_control 90 'tests/p1-server/command.test.ts' 'durable-delivery: Phase B harness control — premature marker and request settlement fail fast with labels'` | `every cancelled poll query must be awaited before return` with `cancelledPolls:1, awaitedCancels:0`. | **DB** | `docs/evidence/2026-08-02-v015-execution/server-phase-b-control2-repair-PASS.md` §Required causal controls 1. |
| PB-2 | The harness uses a recomputed monotonic absolute deadline and bounded final sleep. | `tests/p1-server/command.test.ts`: replace the `sleepMs` clamp/guard/injected sleep with `if (Date.now() >= absoluteDeadline) break; await delay(50);`. | `tests/p1-server/command.test.ts` — `durable-delivery: Phase B harness control — wrong observation pattern reports the real blocked backend, never observed=[]` | `run_one_control 90 'tests/p1-server/command.test.ts' 'durable-delivery: Phase B harness control — wrong observation pattern reports the real blocked backend, never observed=[]'` | `every sleep must be clamped to the recomputed monotonic remaining time` (observed trace `[]`, expected `[50, 25]`); the recorded alternate one-line bypass prints `requested sleep 50ms exceeds recomputed remaining time 25ms`. | **DB** | `docs/evidence/2026-08-02-v015-execution/server-phase-b-control2-repair-PASS.md` §Required causal controls 2; `docs/evidence/2026-08-02-v015-execution/server-phase-b-d036-inversion-arm-gemini-PASS.md` §1. |
| PB-3 | A pre-ready retained attempt is retained, released, and awaited on failure. | `tests/p1-server/command.test.ts`: delete the ARM cleanup entry `...(await settleRetainedAttempt(armAttempt, ...))`. | `tests/p1-server/command.test.ts` — `durable-delivery: Phase B harness control — pre-ready retained-transaction rejection surfaces promptly, is retained on every path, and leaks no backend` | `run_one_control 90 'tests/p1-server/command.test.ts' 'durable-delivery: Phase B harness control — pre-ready retained-transaction rejection surfaces promptly, is retained on every path, and leaks no backend'` | `the retained attempt on the failure path must settle and release along with its holder`. | **DB** | `docs/evidence/2026-08-02-v015-execution/server-phase-b-control2-repair-PASS.md` §Required causal controls 3. |
| PB-4 | Cleanup adjudication preserves a non-Error primary by identity. | `tests/p1-server/command.test.ts`: replace `causes.push(primaryFailure.value);` with the predecessor behavior that wraps non-Errors in `new Error(String(primaryFailure.value))`. | `tests/p1-server/command.test.ts` — `durable-delivery: Phase B harness control — cleanup adjudication preserves exact primary identity and labelled cleanup causes` | `run_one_control 90 'tests/p1-server/command.test.ts' 'durable-delivery: Phase B harness control — cleanup adjudication preserves exact primary identity and labelled cleanup causes'` | `primary object must be preserved by exact identity`. | **DB** | `docs/evidence/2026-08-02-v015-execution/server-phase-b-control2-repair-PASS.md` §Required causal controls 4. |
| PC-1 | Allowed losing delivery claims recharge once at `resolveLedgerRace`. | `supabase/functions/command/index.ts`: delete only the delivery recharge conditional at the entry to `resolveLedgerRace`. | `tests/p1-server/command.test.ts` — `durable-delivery: Phase C resolveLedgerRace recharge — allowed losing claim is recharged once` | `run_one_control 90 'tests/p1-server/command.test.ts' 'durable-delivery: Phase C resolveLedgerRace recharge — allowed losing claim is recharged once'` | `allowed recharge reaches the late resolver topology and charges exactly once`; recorded facts include `resolverObserved=false` and claim bucket `0` instead of `1`. | **DB** | `docs/design/contracts/SERVER-PHASE-C-PREFLIGHT-CORRECTIONS.md` §Recharge-deletion mutant; `docs/evidence/2026-08-02-v015-execution/server-phase-c-PASS.md` §Recharge-deletion mutant. |
| PC-2 | Denied losing delivery claims cross the exact recharge rate boundary. | Same exact `resolveLedgerRace` recharge deletion as PC-1. | `tests/p1-server/command.test.ts` — `durable-delivery: Phase C resolveLedgerRace recharge — denied losing claim is rate-limited` | `run_one_control 90 'tests/p1-server/command.test.ts' 'durable-delivery: Phase C resolveLedgerRace recharge — denied losing claim is rate-limited'` | `denied recharge reaches the late resolver topology and crosses the exact rate boundary`; recorded facts include `resolverObserved=false`, HTTP `409` instead of `429`, and bucket `120` instead of `121`. | **DB** | Same sources as PC-1. |
| A2-1 | The engine's credential classifier escapes credential loss without terminalizing the effect. | `src/listener/engine.ts`: change `this.isCredentialFailure = options.isCredentialFailure;` to `this.isCredentialFailure = undefined;`. | `tests/listener-runtime.test.ts` — `a trusted injected poster receives the same closed runtime credential classification` | `run_one_control 90 'tests/listener-runtime.test.ts' 'a trusted injected poster receives the same closed runtime credential classification'` | Named test returns `actual: 'cancelled'`, `expected: 'credential'`; watchdog must not fire. | No | `docs/design/contracts/RUNTIME-A2-CREDENTIAL-ESCAPE-GOAL.md` control 1; `docs/evidence/2026-08-02-v015-execution/runtime-c-fixture-repair-VERIFIED-PARTIAL.md` measured per-test result. |
| A2-2 | Hostile cancellation wording cannot outrank typed credential loss. | `src/listener/runtime.ts`: restore message-regex recognition (`AbortError` name **or** `/aborted|cancelled/i`) and, in the engine catch, evaluate `isAbort(error)` before `isCredentialLoss(error)` while leaving caller-abort state first. | `tests/listener-runtime.test.ts` — `an injected poster throwing typed 401 with hostile text stops as credential, never cancelled` | `run_one_control 90 'tests/listener-runtime.test.ts' 'an injected poster throwing typed 401 with hostile text stops as credential, never cancelled'` | `typed 401 must stop as credential`; recorded actual was `cancelled`, expected `credential`. | No | `docs/design/contracts/RUNTIME-A2-CREDENTIAL-ESCAPE-GOAL.md` control 2; `docs/evidence/2026-08-02-v015-execution/a2-causal-controls-round2-DISCRIMINATES.md` §Control 2. |
| A2-3 | The default poster forwards the runtime caller signal to the command request. | `src/listener/runtime.ts`: delete only the spread `...(abortSignal === undefined ? {} : { signal: abortSignal }),` from the `ThinCommandClient.sendSignal` request. | `tests/listener-runtime.test.ts` — `the default poster forwards the runtime caller signal and stays bounded` | `run_one_control 90 'tests/listener-runtime.test.ts' 'the default poster forwards the runtime caller signal and stays bounded'` | `runtime did not settle after caller abort`. | No | `docs/design/contracts/RUNTIME-A2-CREDENTIAL-ESCAPE-GOAL.md` control 3; `docs/evidence/2026-08-02-v015-execution/a2-causal-controls-round2-DISCRIMINATES.md` §Control 3. |
| CC-1 | A 401 whose body read fails remains a typed HTTP error. | `src/cloud/command-client.ts`: change `response.status >= 400` back to `response.status >= 500`. | `tests/support/signal-fetch-deadline.test.ts` — `sendSignal keeps a 401 body-read failure as a typed HTTP error` | `run_one_control 90 'tests/support/signal-fetch-deadline.test.ts' 'sendSignal keeps a 401 body-read failure as a typed HTTP error'` | `caught instanceof CommandHttpError` fails; evidence records `CommandTransportError` instead. | No | `docs/evidence/2026-08-02-v015-execution/command-client-d036-inversion-arm-gemini-BLOCK.md` §Lead adjudication; `docs/evidence/2026-08-02-v015-execution/cc-4xx-body-fix.md` §RED discrimination. |
| CC-2 | A non-JSON 403 remains a typed HTTP error. | Same exact `>= 400` to `>= 500` threshold mutant as CC-1. | `tests/support/signal-fetch-deadline.test.ts` — `sendSignal keeps a non-JSON 403 as a typed HTTP error` | `run_one_control 90 'tests/support/signal-fetch-deadline.test.ts' 'sendSignal keeps a non-JSON 403 as a typed HTTP error'` | `caught instanceof CommandHttpError` fails; evidence records a bare non-JSON `Error` instead. | No | Same sources as CC-1. |
| CC-3 | A 429 whose body read is interrupted remains retryable typed HTTP. | Same exact `>= 400` to `>= 500` threshold mutant as CC-1. | `tests/support/signal-fetch-deadline.test.ts` — `sendSignal keeps a 429 interrupted body as a retryable typed HTTP error` | `run_one_control 90 'tests/support/signal-fetch-deadline.test.ts' 'sendSignal keeps a 429 interrupted body as a retryable typed HTTP error'` | `caught instanceof CommandHttpError` fails; evidence records `CommandTransportError` instead. | No | Same sources as CC-1. |

Recorded runnable total: **12**. Required-domain credit: **0 of 10**.

## What this register does not establish

This inventory did not run a mutant, test, database command, build, edge check, or production probe.
It does not establish that any recorded control still discriminates at the release SHA, that any
observer is green, that the local/hosted database behaves correctly, or that any blind domain is
safe. It does not establish deployment, production behavior, real-load capacity, the real
cross-owner canary, or release readiness.
