# Stage 7 causal-control register

> **D-044 update, 2026-08-04:** the cross-owner zero-tool isolation control recorded below was
> deliberately retired. Its replacement regression proves cross-owner turns use the operator's
> worker and prompt provenance. The server authority controls remain unchanged.

Status: nine domains have executed causal controls; claim one-winner remains blind after its exact
lock-removal mutant stayed green and triggered the mandatory stop.

This register separates two facts that the old Stage 7 wording combined:

- the release evidence records **22 independently selectable mutant/test pairs**; and
- **9 of the 10 named Stage 7 domains have a recorded domain-valid causal control**. Claim
  one-winner remains blind at this gate.

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

The wrapper deliberately does not decide whether an arbitrary nonzero exit is the causal red. After
it prints the selected test's transcript, the operator must compare that transcript with the row's
**Expected printed red** cell. A named but different assertion, including an earlier topology
failure, must be recorded as non-evidence even though the wrapper itself returns success.

## Required-domain coverage

Each row below is the ten-domain acceptance inventory. “Observer” means a current named test exists,
but the cited evidence does not record an exact defect mutation and its expected per-test red. It is
not a causal control.

| Required domain | Recorded control | Mutant | Test | Invocation | Expected failure | Slot | Evidence-based disposition |
|---|---|---|---|---|---|---|---|
| Enqueue/backfill | **Yes** | In `20260731000001_signal_deliveries.sql`, independently narrow the enqueue trigger and Section 3 backfill from ask+note to ask-only. | `tests/p1-server/command.test.ts`: `durable-delivery: trigger enqueue ask/note; broadcast and direct-human do not`; `durable-delivery: causal migration backfill enqueues pre-existing direct agent signals`. | Two exact per-test `run_one_control 90` invocations. | Trigger: `note enqueued`; backfill: actual 1, expected 2. | DB | **Both enqueue mechanisms discriminate independently.** |
| Claim one-winner | **No** | Remove both cooperating explicit locks in `durable-delivery.ts`: recipient `FOR UPDATE` and candidate `FOR UPDATE OF d SKIP LOCKED`. | `tests/p1-server/command.test.ts` — `durable-delivery: concurrent claimers produce one lease winner`. | `run_one_control 90` with the exact name. | **GREEN MUTANT**: 1 pass, 0 fail. Mandatory stop; no stronger mutant was attempted. | DB | **Still blind.** The observer did not discriminate removal of both explicit locks in its topology; this does not prove the locks unnecessary or that no other database serialization exists. |
| Stale-lease requeue | **Yes** | Add `AND false` only to Step 2's stale-lease clearing update in `durable-delivery.ts`. | `tests/p1-server/command.test.ts` — `durable-delivery: stale lease requeues; signal TTL expires once; tenth claim poisons`. | `run_one_control 90` with the exact name. | `stale lease requeues for redelivery`; actual false, expected true. | DB | **Stale-lease cleanup/requeue discriminates.** One earlier upstream 502 before the domain was non-evidence; the unchanged rerun printed the causal red. |
| Poison ceiling | **Yes** | Shift both production guards from 10 to 11: `DELIVERY_MAX_ATTEMPTS` and the table's `attempt_count` check constraint. | Same combined server observer as stale-lease requeue. | `run_one_control 90` with the exact name after applying/resetting both guards. | `terminal_delivery_failure_count is 1 on terminalizing claim`; actual 0, expected 1. | DB | **The tenth-claim boundary discriminates.** A TypeScript-only attempt hit the unchanged DB constraint and was non-evidence. |
| Response-loss replay | **Yes** | Delete the `record.replyBody !== null` replay branch in `src/listener/engine.ts`, forcing a second prompt after the persisted post retry. | `tests/listener-engine.test.ts` — `lost response replays the persisted body/id without prompting again`. | `run_one_control 30` with the exact name. | Actual `failed`, expected `done`, after the second model call. | No | **Persisted body/command-ID replay discriminates.** |
| Persist-before-ACK | **Yes** | In `src/listener/runtime.ts`, issue the deterministic delivery ACK immediately after lease recovery, before any effect-store read/write or `prepareAck`. | `tests/listener-runtime.test.ts` — `a durable note is persisted and reread before prepareAck and network ACK`. | `run_one_control 30` with the exact name. | `assert.ok(prepareAt < ackAt)`; actual false. | No | **The forbidden ACK-before-persist order discriminates.** |
| Note with zero prompts | **Yes** | In the cursor-note branch, route the note through `engine.process({ ...signal, kind: "ask" })` before observation, invoking the model/poster. | `tests/listener-runtime.test.ts` — `cursor fallback observes direct notes without model or reply effects`. | `run_one_control 30` with the exact name. | Actual stop `fatal`, expected `cancelled`. | No | **A note routed into the prompt path discriminates.** The early stop assertion fires before the later prompt-count assertion because the mutant also creates an incompatible ask effect record. |
| Cross-owner zero-tool isolation | **Yes** | `src/listener/engine.ts`: change the mode guard from `record.senderOwnerRelation === "same_owner"` to `record.senderOwnerRelation !== "unknown"`, making `cross_owner` select the tool-capable worker. | `tests/listener-engine.test.ts` — `sender relation selects worker only for exact same_owner` | `run_one_control 30 'tests/listener-engine.test.ts' 'sender relation selects worker only for exact same_owner'` | Named `AssertionError`: actual modes `['worker', 'worker', 'isolated']`, expected `['worker', 'isolated', 'isolated']`. | No | **Local relation gate discriminates.** The real two-human canary remains operator-blocked and unproved. |
| Privacy/no-body | **Yes** | `src/listener/delivery-journal.ts`: at the final `ack_pending` write, replace the validated `serialized` bytes with `JSON.stringify({ ...record, signal_body: "PRIVATE_BODY_SENTINEL" })`. | `tests/listener-delivery-journal.test.ts` — `10. Serialized positive metadata exists, while known bearer/body/owner/prompt/reply sentinels are absent` | `run_one_control 30 'tests/listener-delivery-journal.test.ts' '10. Serialized positive metadata exists, while known bearer/body/owner/prompt/reply sentinels are absent'` | Named `AssertionError`: `Sentinel key "signal_body" must be absent`; actual `true`, expected `false`. | No | **Delivery-journal metadata no-body surface discriminates.** Audit, alert, and error-response surfaces were not mutated. |
| Credential absence | **Yes** | `src/listener/control.ts`: change event serialization from `JSON.stringify(event)` to `JSON.stringify({ ...event, credential: "swm_agt_" + "A".repeat(43) })`. | `tests/listener-control.test.ts` — `supervisor becomes ready, stops through the socket, and logs metadata only` | `run_one_control 30 'tests/listener-control.test.ts' 'supervisor becomes ready, stops through the socket, and logs metadata only'` | Named `doesNotMatch` failure prints log rows containing `"credential":"swm_agt_A…"`. | No | **Event-log credential-absence surface discriminates.** Separate argv, environment, status, and host-frame mutants were not run. |

Coverage total: **9 domains with recorded controls; 1 domain blind**.

## Recorded mutant/test register

These 22 rows preserve what the release evidence actually established. They are runnable and useful,
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
| SEC-1 | Cross-owner delivery selects only an isolated, tool-denied prompt mode. | `src/listener/engine.ts`: change `record.senderOwnerRelation === "same_owner"` to `record.senderOwnerRelation !== "unknown"`. | `tests/listener-engine.test.ts` — `sender relation selects worker only for exact same_owner` | `run_one_control 30 'tests/listener-engine.test.ts' 'sender relation selects worker only for exact same_owner'` | Named mode-array assertion prints cross-owner actual `worker` where expected `isolated`. | No | `docs/evidence/2026-08-02-v015-execution/security-causal-controls.md` §1. |
| SEC-2 | Delivery-journal metadata contains no body/private sentinel. | `src/listener/delivery-journal.ts`: at the final `ack_pending` write, replace `serialized` with `JSON.stringify({ ...record, signal_body: "PRIVATE_BODY_SENTINEL" })`. | `tests/listener-delivery-journal.test.ts` — `10. Serialized positive metadata exists, while known bearer/body/owner/prompt/reply sentinels are absent` | `run_one_control 30 'tests/listener-delivery-journal.test.ts' '10. Serialized positive metadata exists, while known bearer/body/owner/prompt/reply sentinels are absent'` | Named assertion prints `Sentinel key "signal_body" must be absent`, actual `true`, expected `false`. | No | `docs/evidence/2026-08-02-v015-execution/security-causal-controls.md` §2. |
| SEC-3 | Listener event logs contain no credential-shaped value. | `src/listener/control.ts`: change `JSON.stringify(event)` to `JSON.stringify({ ...event, credential: "swm_agt_" + "A".repeat(43) })`. | `tests/listener-control.test.ts` — `supervisor becomes ready, stops through the socket, and logs metadata only` | `run_one_control 30 'tests/listener-control.test.ts' 'supervisor becomes ready, stops through the socket, and logs metadata only'` | Named `doesNotMatch` assertion prints `"credential":"swm_agt_A…"` in every log row. | No | `docs/evidence/2026-08-02-v015-execution/security-causal-controls.md` §3. |
| REM-1 | A direct note is enqueued by the insert trigger. | In `20260731000001_signal_deliveries.sql`, change the trigger condition from `NEW.kind IN ('ask', 'note')` to `NEW.kind = 'ask'`, then reset the local database. | `tests/p1-server/command.test.ts` — `durable-delivery: trigger enqueue ask/note; broadcast and direct-human do not` | `run_one_control 90 'tests/p1-server/command.test.ts' 'durable-delivery: trigger enqueue ask/note; broadcast and direct-human do not'` | `AssertionError: note enqueued`. | **DB** | `docs/evidence/2026-08-02-v015-execution/remaining-seven-controls.md` §4a. |
| REM-2 | Section 3 backfill enqueues both pre-existing ask and note signals. | In the migration's Section 3 only, change `s.kind IN ('ask', 'note')` to `s.kind = 'ask'`. | `tests/p1-server/command.test.ts` — `durable-delivery: causal migration backfill enqueues pre-existing direct agent signals` | `run_one_control 90 'tests/p1-server/command.test.ts' 'durable-delivery: causal migration backfill enqueues pre-existing direct agent signals'` | Backfilled row count actual 1, expected 2. | **DB** | Same evidence, §4b. |
| REM-3 | A lost response resumes the persisted reply rather than prompting again. | Delete the `record.replyBody !== null` early replay branch in `src/listener/engine.ts`. | `tests/listener-engine.test.ts` — `lost response replays the persisted body/id without prompting again` | `run_one_control 30 'tests/listener-engine.test.ts' 'lost response replays the persisted body/id without prompting again'` | Actual `failed`, expected `done`. | No | Same evidence, §1. |
| REM-4 | A delivery ACK is not issued before terminal-effect and `prepareAck` persistence. | In `src/listener/runtime.ts`, immediately after `const signal = authoritativeSignal(claimed);`, apply the literal early-ACK insertion recorded in the evidence §2. | `tests/listener-runtime.test.ts` — `a durable note is persisted and reread before prepareAck and network ACK` | `run_one_control 30 'tests/listener-runtime.test.ts' 'a durable note is persisted and reread before prepareAck and network ACK'` | `assert.ok(prepareAt < ackAt)` fails. | No | Same evidence, §2. |
| REM-5 | Cursor-fallback notes never enter the model/reply path. | Insert `await engine.process({ ...signal, kind: "ask" })` in the note branch before observation. | `tests/listener-runtime.test.ts` — `cursor fallback observes direct notes without model or reply effects` | `run_one_control 30 'tests/listener-runtime.test.ts' 'cursor fallback observes direct notes without model or reply effects'` | Stop actual `fatal`, expected `cancelled`. | No | Same evidence, §3. |
| REM-6 | Expired leases are cleared and requeued without terminal acknowledgement. | Add `AND false` to only Step 2's stale-lease clearing update in `durable-delivery.ts`. | `tests/p1-server/command.test.ts` — `durable-delivery: stale lease requeues; signal TTL expires once; tenth claim poisons` | `run_one_control 90 'tests/p1-server/command.test.ts' 'durable-delivery: stale lease requeues; signal TTL expires once; tenth claim poisons'` | `stale lease requeues for redelivery`; actual false, expected true. | **DB** | Same evidence, §6. |
| REM-7 | The tenth completed lease attempt poisons the delivery before an eleventh lease. | Shift both `DELIVERY_MAX_ATTEMPTS` and the table `attempt_count` ceiling from 10 to 11. | Same combined server observer as REM-6. | Same exact per-test invocation after resetting the two-site mutant. | `terminal_delivery_failure_count is 1 on terminalizing claim`; actual 0, expected 1. | **DB** | Same evidence, §7. |

Recorded runnable total: **22**. Required-domain credit: **9 of 10**.

## What this register does not establish

The recorded controls establish only the exact local mutations and observers above. Claim
one-winner remains blind: the exact two-lock removal stayed green, and no stronger mutant was tried.
The controls do not establish hosted or production behavior, real-load capacity, the real two-human
cross-owner canary, or release readiness. SEC-2 covers delivery-journal metadata, not every
audit/alert/error-response surface; SEC-3 covers event-log credential absence, not argv,
environment, status, or host frames. The note control's first printed assertion is the fatal stop
caused by its incompatible ask effect record, not the later prompt-count assertion. Nothing was
deployed.
