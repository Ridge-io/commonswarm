# D-041 fix and state-space enumeration report

Date: 2026-08-04

Branch: `fix/v015-d040`

Base: `691d3f2381ea2aaf2ec4d494dfd586477d4903ce`

## Outcome

Parts A and B are complete. D-041a and D-041b have causal controls that were captured red before
the runtime change and green afterward. The persisted phase space and all 27 operational fatal stop
sites are enumerated below and durably in
`docs/evidence/2026-08-04-d040-fix/state-space-enumeration.md`.

**THIRD BRICK FOUND BY PART B:** clearing the stale lease alone left the corrupt effect file in
place. The server then requeued the same signal; effect work reread the corruption, stopped fatally
with a new `leased` journal, and repeated forever. The first causal control missed it by returning an
empty next claim. The expanded note control reproduced it red, and an ask control proved the same
state family.

The mandatory exact-SHA review then caught two surviving counterexamples in the first repair: a
process could exit after clear but before re-claim and lose its in-memory repair marker, and
cursor-fallback processing never consumed that marker. It also caught that regenerating an ask reply
could conflict with an already-posted reply. The replacement implementation removes the marker,
covers both delivery modes, and never regenerates a corrupt ask's unknown reply.

The fixed runtime handles an unreadable effect whenever an authoritative claim or fallback read
supplies the signal, without relying on process-local recovery state. It retries the read first;
only a still-unreadable file is replaced. Notes become observed. Asks become a conservative
`local_effect_corrupt` terminal failure without another model turn or reply post, because corruption
may have destroyed the exact body and receipt of a reply that already succeeded. The
enumeration also confirmed one deliberately terminal family outside valid phases: an unreadable,
malformed, or wrong-identity journal fails closed. That already-known parser/downgrade state is
explicitly accepted because its claim/lease/ACK identity cannot be reconstructed safely.

Part C was executed but did not establish a treatment verdict. The accepted frozen control remains
valid. The corrected treatment harness stopped before `ready` because the real OpenCode permission
canary failed; no lease, kill, or restart occurred. The exact output and listener-owned durable
evidence are appended to `docs/evidence/2026-08-04-d040-fix/live-fire-drill.md`.

## Part A — fixes and causal controls

### D-041a — unreadable recovered effect

Change: recovery of a `leased` journal now reads the effect in an explicit recovery boundary. An
unreadable effect is not ACKable, so it is treated as absent for the lease-horizon clear. Whenever
an authoritative claim or fallback page later supplies that signal, the runtime retries the read and
replaces a still-unreadable note with `observed`, or a still-unreadable ask with the conservative
`local_effect_corrupt` terminal state. It never prompts or posts a different reply under the old
deterministic command id.

Control: a real `FileListenerEffectStore` writes a valid effect, the test corrupts that exact on-disk
JSON file, and a restart begins with a stale persisted `leased` journal. The expanded control then
reclaims the *same* note, processes it, ACKs it, and verifies the repaired effect. Sibling controls
prove that an ask is terminalized without a second reply, that a fresh process with no repair marker
can repair a newly claimed signal, and that cursor fallback consumes the same repair path.

Red output before the runtime change:

```text
✖ D-041a: a corrupt recovered effect cannot block stale leased recovery
Error: stored listener effect is malformed
    at parseListenerEffectRecord (.../src/listener/file-store.ts:118:11)
    at FileListenerEffectStore.read (.../src/listener/file-store.ts:433:34)
    at async runListenerRuntime (.../src/listener/runtime.ts:820:15)
```

Green output after the runtime change:

```text
✔ D-041a: a corrupt recovered effect cannot block stale leased recovery
✔ D-041a enumeration: a requeued corrupt ask fails safely without a second reply
✔ D-041 enumeration: a fresh claim repairs corruption without process-local recovery state
✔ D-041 enumeration: cursor fallback consumes a corrupt-effect repair
```

Part B's expanded note control caught the third brick red after the initial clear-only change:

```text
✖ D-041a: a corrupt recovered effect cannot block stale leased recovery
AssertionError [ERR_ASSERTION]: D-041a corrupt effect must degrade to no terminal effect and clear the stale lease
+ actual - expected

+ 'fatal'
- 'cancelled'
```

The exact-SHA review controls then ran against rejected commit `f483d2a` and discriminated all three
remaining assumptions:

```text
✖ D-041a enumeration: a requeued corrupt ask fails safely without a second reply
  AssertionError: 1 !== 0 (one unwanted model prompt)
✖ D-041 enumeration: a fresh claim repairs corruption without process-local recovery state
  actual 'fatal', expected 'cancelled'
✖ D-041 enumeration: cursor fallback consumes a corrupt-effect repair
  actual 'fatal', expected 'cancelled'
ℹ pass 2
ℹ fail 3
```

### D-041b — fatal `ack_pending` replay

Change: `ack_pending` computes `leasedUntil + 30s` before ACK replay. Before the horizon it verifies
and retries the deterministic ACK; at/past the horizon it bypasses the stuck ACK and clears directly,
including in `durable_claim`. The direct clear has an explicit fatal boundary so its own failure
leaves the persisted phase available for another restart.

Control: the first runtime forces a nonretryable `sendPreparedAck` failure and proves the journal
remains `ack_pending`; a second runtime restarts past the persisted horizon and asserts that the old
ACK is not sent, the record clears, and the listener can claim again.

Red output before the runtime change:

```text
✖ D-041b: fatal ACK replay recovers after the persisted lease horizon
AssertionError [ERR_ASSERTION]: D-041b fatal ACK state must clear after lease expiry plus the safety margin
+ actual - expected

+ 'fatal'
- 'cancelled'
```

Green output after the runtime change:

```text
✔ D-041b: fatal ACK replay recovers after the persisted lease horizon
ℹ tests 46
ℹ pass 46
ℹ fail 0
```

The five controls live in `tests/listener-runtime.test.ts`, which is literally named by the root
`npm test` script. Root count moved from 390 to 395.

## Part B1 — every persisted journal phase

The closed type, parser set, and writers agree on exactly three values. `reserveClaim` writes
`claim_pending`, `recordLease` writes `leased`, `prepareAck` writes `ack_pending`, and `clearActive`
writes `active: null`.

| phase | how a restart discovers it | is there an exit? | is that exit reachable in `durable_claim`? | what if the exit's own operation fails? |
|---|---|---|---|---|
| `claim_pending` | The initial journal snapshot carries `active.phase`; the phase means a deterministic claim command was reserved, with `claimLastAttemptAt` either null or persisted. | Yes. With no previous attempt it is immediately stale. Otherwise its horizon is `claimLastAttemptAt + 900s + 30s`. At/past the horizon it clears; before it, it replays the exact claim. An empty result clears; a delivery advances to `leased`. | Yes. The stale test is explicitly `deliveryMode !== durable_claim || now >= horizon`, so time makes the clear arm reachable in `durable_claim`; a recent attempt takes exact replay. | A failed clear stops fatally but leaves `claim_pending`, so a later restart retries the same clear. A fatal replay leaves it recoverable at the horizon. `recordClaimAttempt` refreshes the attempt time before a replay, so repeatedly restarting *before* the horizon can postpone it; waiting past the last attempt reaches the clear. A permanently unreadable/unwritable journal remains terminal. |
| `leased` | The snapshot contains the exact signal, lease, lease deadline, and optional immutable-signal fingerprint written by `recordLease`. | Yes. A matching terminal effect can advance to `ack_pending` and ACK. Otherwise an expired lease waits through the 30s safety margin and clears. A still-live durable lease replays the exact claim command. An unreadable effect is treated as no terminal effect for stale clearing; any later authoritative claim or fallback row independently enables replacement. | Yes. Expiry, not delivery mode, makes the stale clear reachable; the current `durable_claim` path no longer gates it off. | Failures before `prepareAck` leave `leased`; failures after it may leave `ack_pending`. Both phases have time-bounded recovery. Clear failure leaves `leased` and retries on restart. A still-unreadable note is reconstructed as observed; an ask is conservatively terminalized as local corruption without another reply. The repair does not depend on process memory and also runs in cursor fallback. Repair failure leaves `leased` for another horizon recovery. Permanent journal I/O failure is terminal. |
| `ack_pending` | The snapshot contains the exact lease plus deterministic ACK body written by `prepareAck`. | Yes. Before `leasedUntil + 30s`, a server advertising ACK verifies the terminal effect and retries the exact ACK, clearing only after success. At/past that horizon it clears without replaying the stuck ACK. An ACK-less rollback also waits to the same horizon and clears. | Yes. The horizon check occurs before `sendPreparedAck`; it does not depend on `deliveryAck` being false. This is the D-041b fix. | Verification, nonretryable ACK, credential, or clear failure leaves `ack_pending`. A restart at/past the horizon bypasses ACK replay and retries `clearActive`. Retryable ACK errors can keep one process inside `sendPreparedAck` beyond the horizon; killing/restarting that process reaches the horizon clear, but the lack of an in-process horizon break is an honest stall gap. Permanent journal I/O failure remains terminal. |

## Part B2 — every fatal stop site

A raw search has 28 `reason: "fatal"` occurrences: one type member at line 167 and the 27
operational constructions below. “Not reachable” means persisted phase selection does not cause the
site; the external error may still coexist with an active journal.

| line | trigger | verdict |
|---:|---|---|
| 515 | `model.close()` fails while reporting a pre-start validation or initial-journal error. | **Reachable and terminal** when paired with an unreadable/malformed/identity-mismatched persisted journal; explicitly accepted fail-closed because claim identity cannot be reconstructed safely. Otherwise the trigger is an external model-close failure. |
| 517 | Pre-start configuration validation fails, or the initial journal read/identity check fails after the model closes cleanly. | **Reachable and terminal** for unreadable, malformed, or wrong-identity persisted journals; explicitly accepted for the same fail-closed reason. Valid persisted phases do not select this site. |
| 665 | `sendPreparedAck` receives an active record that is not a complete `ack_pending` record. | **Not reachable from valid persisted state on restart.** The closed journal parser enforces every required ACK field and cross-field invariant before the runtime receives it. Reachable only through an invalid injected journal implementation or an in-memory programming error. |
| 673 | Reading the effect for a prepared ACK throws, or the effect is missing/mismatched with the deterministic ACK body. | **Reachable, and recoverable.** `ack_pending` remains on disk; a restart at/past `leasedUntil + 30s` clears without verifying or resending it. |
| 709 | The server reports an expired delivery unavailable, then clearing that stale `ack_pending` record fails. | **Reachable, and recoverable.** The record remains `ack_pending`; every later restart past the horizon retries the direct clear. Permanent journal write failure is the common I/O terminal gap. |
| 717 | Bearer/ACK/clear throws a noncredential, nonretryable delivery error (including a clear failure after the server accepted the ACK). | **Reachable, and recoverable.** The persisted state is still `ack_pending`; the outer restart horizon bypasses this ACK path and clears it. |
| 794 | The inbox read or capability validation fails with a noncredential, nonabort, nonretryable error. | **Not reachable from persisted state on restart.** This occurs before journal phase dispatch and is caused by the read service/capability response, not by any phase value. |
| 802 | Provider/model startup fails. | **Not reachable from persisted state on restart.** Provider startup precedes phase dispatch and is independent of journal contents. |
| 821 | A later journal reread fails after the initial snapshot has already been consumed. | **Reachable and terminal** if the journal became permanently unreadable/malformed; explicitly accepted fail-closed. A transient read error recovers on a later process, but no valid-phase exit can run until the journal is readable. |
| 853 | The direct horizon clear for `ack_pending` fails. | **Reachable, and recoverable.** The same `ack_pending` state is retained and the same already-reached clear arm runs on restart. |
| 893 | Recovered terminal-effect handling throws while mapping/persisting `prepareAck` or rereading the prepared journal. | **Reachable, and recoverable.** Failure before persistence leaves `leased`; failure after persistence leaves `ack_pending`. Each has its own reachable horizon clear. Fatal values returned by `sendPreparedAck` are covered by lines 665/673/709/717, not swallowed here. |
| 911 | The direct stale clear for `leased` fails. | **Reachable, and recoverable.** `leased` remains and restart re-enters the already-reached horizon clear. |
| 936 | The direct stale clear for `claim_pending` fails. | **Reachable, and recoverable.** `claim_pending` remains and restart re-enters the horizon clear. |
| 957 | Reserving a new claim fails while `active` is null. | **Not reachable from an active persisted phase on restart.** No phase exists yet. If the journal store is transiently unavailable, retrying the process can reserve; permanent journal I/O is the common terminal gap. |
| 986 | Exact claim/replay setup or request fails nonretryably: `recordClaimAttempt`, bearer, claim transport protocol validation, or a nonretryable server response. | **Reachable, and recoverable.** `claim_pending` clears after its last-attempt horizon; `leased` clears after its fixed lease horizon. This is the site D-040 originally made terminal for expired `leased`. |
| 1000 | The claim loop exits with both `result === null` and no `stop`. | **Not reachable from persisted state or the fresh path under the current loop invariant.** The loop exits only after setting a nonnull result or setting `stop`; this is a defensive assertion. |
| 1025 | Exact replay of a persisted live `leased` claim returns no delivery. | **Reachable, and recoverable.** The mismatch stops now, retains `leased`, and the persisted lease horizon later reaches direct clear. |
| 1033 | Clearing a zero-delivery claim result fails. | **Reachable, and recoverable** for a replayed `claim_pending` record: it remains and later reaches its horizon clear. A fresh claim has the same valid persisted phase after `reserveClaim`. |
| 1045 | The claimed delivery deadline is invalid or exceeds the fixed 15-minute maximum. | **Reachable, and recoverable.** A `claim_pending` replay remains clearable after its attempt horizon; a `leased` replay remains clearable after the stored lease horizon. |
| 1051 | A persisted live lease replay returns a different signal, lease id, or deadline. | **Reachable, and recoverable.** It fails closed without processing the mismatched delivery, retains the original `leased` state, and clears at that original deadline plus margin. |
| 1066 | Persisting the transition from `claim_pending` to `leased` fails. | **Reachable, and recoverable.** Atomic storage leaves either the old valid `claim_pending` record or the new valid `leased` record; restart dispatches whichever durable record actually won and both have exits. Crash-point ambiguity inside the storage primitive was not separately fault-injected. |
| 1173 | Durable effect work fails: effect read/write/verification, unsupported claimed kind, or engine processing error. | **Reachable, and recoverable.** `recordLease` has already persisted `leased`; restart can resume a valid effect or clear at the lease horizon. Any authoritative claim independently retries and replaces a still-unreadable effect, so process exit cannot lose repair eligibility. Cursor fallback applies the same repair before its effect work. |
| 1201 | Terminal effect reread/mapping, `prepareAck`, or prepared-journal reread throws after effect work. | **Reachable, and recoverable.** Disk contains either `leased` or `ack_pending`; both phase exits remain reachable. Returned ACK fatal stops are enumerated at lines 665/673/709/717. |
| 1228 | Cursor-fallback note repair, persistence, or verification fails. | **Reachable, and recoverable.** A restart can clear stale active state and later receive the same authoritative fallback row. The journal is already inactive; a later process/page retries replacement or observation. Permanent effect-store I/O is the common terminal gap. |
| 1251 | Cursor-fallback ask repair or engine processing fails noncredential/nonabort. | **Reachable, and recoverable.** After stale state clears, the authoritative row independently retries corrupt-effect replacement; no process-local marker is required. The journal is inactive, so a later process/page retries. Permanent effect-store I/O remains terminal. |
| 1269 | A full cursor-fallback page has no safe next cursor. | **Not reachable from an active persisted phase on restart.** Phase recovery completes or continues before cursor fallback reaches pagination. |
| 1290 | `model.close()` throws in the runtime `finally`, replacing the prior stop result. | **Reachable, and recoverable** with respect to any valid persisted phase: close does not mutate the journal, so a later process still dispatches that phase and reaches its horizon exit. A permanently broken model close is an external repeated failure, not an exit supplied by persisted state. |

## Part C — live-fire treatment

The identical corrected harness was reused with explicit `NODE_OPTIONS`, a fresh local DB reset,
current-tree migrations, the final fixed CLI build (runtime source SHA-256
`9bc514c0c2b02e0e5a42ccd410f9a3b5ba5521af29f3041f698da03508cd658a`), current-tree edge
functions, and only the locally served 8-second lease override. Setup created the user, two real
principals, real credentials, and direct ask `49617484-e5ae-42bc-8392-2ac6032e792f`.

The exact outer result was:

```text
===== initial listen start =====
exit=1 signal=none
--- stdout ---
<empty>
--- stderr ---
cswarm: the listener did not become ready within two minutes; check network access and host login, then retry
```

The listener log was more specific:

```jsonl
{"ts":"2026-08-04T14:35:14.894Z","event":"listener_starting","instance_id":"ad21a2fb-7010-4691-9949-d16335b5dc01","pid":88695}
{"ts":"2026-08-04T14:35:14.941Z","event":"listener_delivery_mode","delivery_mode":"durable_claim","pending_delivery_count":1}
{"ts":"2026-08-04T14:37:16.760Z","event":"listener_failed","failure_code":"permission_canary_failed"}
```

Final journal: `nextClaimOrdinal: 0`, `active: null`. The run did not reach the old harness-created
lock hazard, but it also did not reach the treatment. The lease override was restored exactly, its
tracked diff is empty, and no edge serve/listener process remains.

## Verification

Every invocation exported `NODE_OPTIONS='--max-old-space-size=4096'`; the live-fire harness also
sets it explicitly in `baseEnv` for every spawned Node CLI, detached listener, and model child.

| gate | result |
|---|---:|
| `npm test` | 395 pass, 0 fail |
| `npm run test:p1-local` | 4 pass, 0 fail |
| `npm run test:p1-server` | 69 pass, 0 fail |
| clean `site` build then `npm --prefix site test` | 113 pass, 0 fail |
| `npm run build` | pass |
| `npm run check:tests` | pass |
| `npm run check:edge` | command, read, capability all checked; pass |

The initial site-test attempt was not a gate result: `site/dist` and site dependencies were absent,
so artifact observers returned `ENOENT`. After `npm --prefix site install` and a clean artifact
build, the required site gate passed 113/113. No tracked site, manifest, lockfile, migration,
package, or generated protocol change remains.

## Scope

Changed runtime and tests are the contract's expected scope. `src/listener/engine.ts` additionally
exports the one canonical deterministic ask-start constructor so corrupt-effect repair does not
duplicate that durable record shape. Evidence changed only to add the required enumeration and
append the live-fire treatment result. This root `REPORT.md` is the required handoff. No migration,
site source, package manifest, lockfile, or `main` change was made.

## What this did not establish

- The real-process treatment recovery is not established. OpenCode failed its permission canary
  before `ready`; the fixed listener was never killed in `leased` and never restarted.
- A permanently unreadable, malformed, wrong-identity, or unwritable delivery journal is not
  automatically repaired. That terminal fail-closed state is explicitly accepted; safe manual
  repair is not specified.
- Retryable ACK errors can keep one running process inside `sendPreparedAck` beyond the horizon.
  Restart past the horizon clears the state, but an in-process horizon break is not implemented.
- Wall-clock jumps, every filesystem syscall crash boundary, permanent disk/permission failures,
  malicious local mutation, and an indefinitely held journal lock were not exhaustively tested.
- The real service reachability/frequency of every nonretryable response, especially
  `delivery_ack_conflict`, was not established; the post-fatal persisted-state recovery was.
- A corrupt ask effect cannot establish whether its original reply post succeeded, or recover that
  exact body/receipt. Recovery therefore does not post again and conservatively ACKs a local-effect
  failure once durable delivery supplies the signal.
- No deployment, push, production database change, hosted-Supabase check, other-provider live-fire
  run, or rollback-parser rerun was performed.
