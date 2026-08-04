# D-041 persisted-state and fatal-stop enumeration

Date: 2026-08-04

Branch: `fix/v015-d040`

Source frame: the fixed working tree based on `691d3f2`; line numbers below are from the final
`src/listener/runtime.ts` in this change.

## Result

**THIRD BRICK FOUND BY THE ENUMERATION:** merely clearing the stale `leased` journal did not recover
an unreadable effect. The server requeues that same delivery; after the next claim, durable effect
work reread the still-corrupt file, stopped fatally with a new `leased` journal, and repeated the
cycle forever. The first D-041a control missed this because its next claim returned no delivery.

The first repair was itself incomplete: exact-SHA review found that a process exit between clear and
re-claim lost the in-memory repair marker, and that cursor fallback never consumed the marker. It
also found that regenerating a corrupt ask could reuse its command id with a different reply body.
Those counterexamples drove the marker-free, no-second-reply treatment below.

The fix no longer depends on carrying an unreadable signal id in process memory. Whenever an
authoritative claim or fallback page supplies the signal, the runtime rereads first (preserving a
valid file after a transient error). If it is still unreadable, it replaces a note with the
authoritative observed effect. It replaces an ask with `local_effect_corrupt` and performs no model
turn or reply post: corruption may have destroyed the exact body and receipt of an already-posted
reply, so reusing the deterministic command id with a newly generated body would conflict. Causal
controls cover requeue, a new process with no marker, cursor fallback, and both signal kinds.

The enumeration also found one deliberately terminal state outside the valid phase space: an
unreadable, malformed, or identity-mismatched delivery journal fails closed before recovery. That is
explicitly accepted because the runtime cannot reconstruct the claim/lease/ACK identity safely. It
was already named by D-041's closed-parser/downgrade finding; manual repair remains an operational
gap.

The fixed runtime has 27 operational fatal constructions. A raw search reports 28 occurrences of
`reason: "fatal"` because line 167 is the `ListenerRuntimeStop` type member, not a stop site. All 27
operational sites are enumerated below.

## B1 — every persisted journal phase

This is an inventory, not a pattern match. `ListenerActiveClaim.phase` is the closed union
`claim_pending | leased | ack_pending` in `delivery-journal.ts:79`; `ALLOWED_PHASES` admits exactly
the same three values; and the only phase writers are `reserveClaim` (`claim_pending`), `recordLease`
(`leased`), and `prepareAck` (`ack_pending`). `clearActive` writes `active: null`. No other writer to
`active.phase` exists in `src/`.

On restart, `runListenerRuntime` reads and identity-checks the journal before doing provider work
(`runtime.ts:553-566`), retains that exact snapshot, and consumes its `active` value on the first
capability-bearing loop (`runtime.ts:814-826`). Later loops reread the journal.

| phase | how a restart discovers it | is there an exit? | is that exit reachable in `durable_claim`? | what if the exit's own operation fails? |
|---|---|---|---|---|
| `claim_pending` | The initial journal snapshot carries `active.phase`; the phase means a deterministic claim command was reserved, with `claimLastAttemptAt` either null or persisted. | Yes. With no previous attempt it is immediately stale. Otherwise its horizon is `claimLastAttemptAt + 900s + 30s`. At/past the horizon it clears; before it, it replays the exact claim. An empty result clears; a delivery advances to `leased`. | Yes. The stale test is explicitly `deliveryMode !== durable_claim || now >= horizon`, so time makes the clear arm reachable in `durable_claim`; a recent attempt takes exact replay. | A failed clear stops fatally but leaves `claim_pending`, so a later restart retries the same clear. A fatal replay leaves it recoverable at the horizon. `recordClaimAttempt` refreshes the attempt time before a replay, so repeatedly restarting *before* the horizon can postpone it; waiting past the last attempt reaches the clear. A permanently unreadable/unwritable journal remains terminal and is called out below. |
| `leased` | The snapshot contains the exact signal, lease, lease deadline, and optional immutable-signal fingerprint written by `recordLease`. | Yes. A matching terminal effect can advance to `ack_pending` and ACK. Otherwise an expired lease waits through the 30s safety margin and clears. A still-live durable lease replays the exact claim command. An unreadable effect is treated as no terminal effect for stale clearing; any later authoritative claim or fallback row independently enables replacement. | Yes. Expiry, not delivery mode, makes the stale clear reachable; the current `durable_claim` path no longer gates it off. | Failures before `prepareAck` leave `leased`; failures after it may leave `ack_pending`. Both phases have time-bounded recovery. Clear failure leaves `leased` and retries on restart. A still-unreadable note is reconstructed as observed; an ask is conservatively terminalized as local corruption without another reply. The repair does not depend on process memory and also runs in cursor fallback. Repair failure leaves `leased` for another horizon recovery. Permanent journal I/O failure is terminal. |
| `ack_pending` | The snapshot contains the exact lease plus deterministic ACK body written by `prepareAck`. | Yes. Before `leasedUntil + 30s`, a server advertising ACK verifies the terminal effect and retries the exact ACK, clearing only after success. At/past that horizon it clears without replaying the stuck ACK. An ACK-less rollback also waits to the same horizon and clears. | Yes. The horizon check occurs before `sendPreparedAck`; it does not depend on `deliveryAck` being false. This is the D-041b fix. | Verification, nonretryable ACK, credential, or clear failure leaves `ack_pending`. A restart at/past the horizon bypasses ACK replay and retries `clearActive`. Retryable ACK errors can keep one process inside `sendPreparedAck` beyond the horizon; killing/restarting that process reaches the horizon clear, but the lack of an in-process horizon break is an honest stall gap below. Permanent journal I/O failure remains terminal. |

### Phase-transition closure

The only on-disk transitions are:

```text
active=null -> claim_pending -> leased -> ack_pending -> active=null
                    |             |             |
                    +-------------+-------------+--> active=null (recovery clears)
```

`recordClaimAttempt` updates only `claimLastAttemptAt`; idempotent `recordLease` and `prepareAck`
reassert their existing phase only when their exact identity/body matches. Parser validation rejects
all other phase/field combinations before runtime recovery.

## B2 — every fatal stop site

“Not reachable” below means the persisted phase does not cause that site on restart; the same
external failure can of course coexist with an active journal and delay reaching its recovery block.
“Recoverable” is specifically about the persisted journal: the phase remains valid and a later
restart has a reachable clear/replay transition. It does not claim that a permanently broken disk,
provider, credential, or server repairs itself.

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

### Terminal verdicts

The only accepted terminal family is the journal itself becoming unreadable, malformed, or bound to
the wrong identity (lines 515/517/821). Automatically deleting that file could double-process a
claim, lose an ACK, or reuse a listener command ordinal without knowing which durable mutation won.
The safe automated action is therefore not established. This is a manual-repair requirement, not a
valid phase with a missing transition.

The requeued-corrupt-effect cycle was the additional valid-phase D-040-class brick. It was fixed and
is now covered for both signal kinds.

## B3 — honest gap list

- Part C's treatment arm did not reach a lease. The real OpenCode listener failed its permission
  canary before `ready`, so the fixed build's kill/restart recovery is still not live-fire evidence.
- Permanently unreadable or unwritable journal storage is terminal. The enumeration establishes
  retry paths after transient exit-operation failures; it does not establish recovery from a disk,
  ownership, permissions, or filesystem fault that never clears.
- `sendPreparedAck` can remain inside retryable ACK retries after the persisted horizon passes. A
  restart past the horizon clears it, but the current process has no horizon break; this is an
  indefinite in-process stall, not a permanent restart brick, and was not changed in this scope.
- The clock is wall-clock based. Large backward clock steps can postpone exits; forward steps can
  reach them early relative to elapsed time. Monotonic-clock behavior was not established.
- The exact production reachability of every nonretryable server response was not constructed. In
  particular, D-041's review could not make the real service emit `delivery_ack_conflict`; the
  state-machine result after such a fatal response is established, not that response's frequency.
- A corrupt ask effect cannot establish whether its original reply post succeeded, or recover that
  exact body/receipt. Recovery therefore does not post again and conservatively records local-effect
  failure; a later durable claim can ACK that failure.
- Crash points inside atomic journal writes were reasoned from `writeSecureJsonFile` semantics and
  the closed parser, not fault-injected at every syscall boundary.
- Concurrent manual mutation, malicious local tampering, out-of-disk conditions, and a process that
  holds the file lock forever were not exhaustively exercised.
- External failures before phase dispatch (read service, capability response, provider start) can
  prevent a valid persisted exit from running even though the phase itself has an exit. The table
  distinguishes that delay from a phase-caused brick.
- This inventory is closed over the current phase union and current writers. A future phase or a new
  writer is not covered merely because this document exists; the type, parser set, writers, and
  runtime dispatch must be re-enumerated together.
