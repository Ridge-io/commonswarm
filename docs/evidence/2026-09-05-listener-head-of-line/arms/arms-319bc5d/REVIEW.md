# Review brief — lane/listener-head-of-line, SHA 319bc5d

Repo: CommonSwarm (`cswarm` CLI + Supabase backend). You are reviewing ONE commit.

Read `DIFF.patch` in this same directory. **Before any finding, quote back the
first `diff --git` line of that file verbatim**, so it is provable you read it.
The repo checkout is at
`/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-listener-head-of-line`
(branch `lane/listener-head-of-line`); read any file you need there for context.

## What the lane claims

1. A per-delivery bound on how long ONE claimed delivery may hold the listener's
   single worker seat. It reuses `--turn-budget` (no new flag); the runtime
   option is `deliveryHoldBudgetMs`, default `LISTENER_DELIVERY_HOLD_BUDGET_MS`
   (= `LISTENER_PROMPT_TIMEOUT_MS`, 10m). When spent, the runtime clears the
   journal's active claim and emits `delivery_hold_released`, so the next
   delivery is claimed at once instead of the loop sleeping to lease expiry.
2. Nothing is acknowledged on release. The row keeps its live server lease and
   is redelivered on the server's own schedule, costing it no extra attempt.
   `observed` is a TERMINAL ack outcome and is never sent at claim time.
3. `cswarm listen status` gains `currentDeliverySignalId`,
   `currentDeliverySince`, `currentDeliveryElapsedMs`, `queueWaitingSince`,
   `queueWaitingForMsAtLeast`, plus human lines for each.

## Attack these, in order. Attempt refutation; do not summarize.

1. **Abandoning a live lease.** The old code slept to lease expiry and only
   called `journal.clearActive` once `now() >= leasedUntil + margin`. The new
   code clears while the lease is still live. Find a recovery path this breaks:
   `exactRecoveredLease`, `recordLease`, `prepareAck`, `sendPreparedAck`, the
   `claim_pending` / `leased` / `ack_pending` phases in
   `src/listener/delivery-journal.ts`, and the replay-by-command-id contract.
   Can a released delivery be double-replied, double-acked, or lost?
2. **Request amplification.** After release the loop `continue`s and claims
   again immediately; the released row is still leased so the server returns
   nothing and the loop falls to `sleep(pollMs)`. Compare the request rate with
   the OLD behaviour (a single sleep to lease expiry). This host has previously
   hit TCP source-port exhaustion. Is the new steady state worse than normal
   idle polling, and is there any tight loop with no sleep?
3. **The bound itself.** `holdSpent = processAttempt > 0 && now() -
   holdStartedAtMs >= deliveryHoldBudgetMs`. Show a case where a delivery is
   starved (never gets a real attempt), or where the bound never fires, or where
   `holdStartedAtMs` is wrong — in particular a lease RECOVERED across a restart,
   where the hold clock restarts. Also check the interaction with `leaseSpent`
   (which still uses the projected `now() + requiredBudget`): is using a
   projection for one and elapsed for the other correct, or a bug?
4. **The waiting count.** `waitingBehind = pendingDeliveryCount - (current ? 1 :
   0)` in `src/cli.ts`. Verify against the server: `pending_delivery_count` in
   `supabase/functions/command/durable-delivery.ts` counts unacked live
   deliveries for the recipient. Is the subtraction right in every state,
   including after an ack sets `pendingDeliveryCount` to null, and after a
   release where the released row is still unacked?
5. **`queueWaitingSince` honesty.** It is set on a claim that reports waiting
   rows and cleared when none wait. The rendered sentence says the oldest has
   waited "at least that long". Is that claim true, or can the field outlive
   what it describes (e.g. a row that expired, was acked by another path, or a
   restart)? Per this repo's doctrine, a user-readable claim must hold for BOTH
   the hosted workspace and the local listener.
6. **Status file compatibility.** Three new OPTIONAL keys were added to
   `ListenerStatus` in `src/listener/control.ts`: allowlist, validation, and the
   `...(row.X === undefined ? {} : {...})` round-trip idiom. Prove an OLD status
   file still round-trips byte for byte, that `writeListenerStatus` does not
   refuse a status missing them, and that no sensitive value can enter them.
   Also check the new log keys `held_ms` and `release_reason` against
   `appendListenerEvent`'s validation.
7. **D-053 (never branch on `error.message`)** and this repo's rule that a
   user-readable enumeration must be GENERATED from the constant the enforcement
   reads, never typed. Check the new copy in `src/cli.ts` and the reason
   constant `LISTENER_DELIVERY_HOLD_RELEASE_REASONS` in
   `src/listener/types.ts`.
8. **Terminal states.** The second commit clears `currentDeliverySignalId` and
   `currentDeliverySince` on `stopped`/`failed` (inside `transition`) and in the
   unclean-exit branch of `effectiveListenerStatus`. Find an exit path that still
   leaves a stale delivery in the status file, and say whether `queueWaitingSince`
   should have been cleared too.
9. **The tests.** Six were added in `tests/listener-runtime.test.ts`. For each,
   state whether it would still pass if the behaviour it names were removed —
   name the exact mutation that makes it red. Call out any test that pins a
   claim rather than the behaviour.

Also state anything the lane claims that the diff does NOT establish.

End your reply with exactly one line:
`VERDICT: PASS` or `VERDICT: FAIL`

## Round 2: what changed since 33cd24b, which you must attack directly

Round 1 arms both returned FAIL on two findings. Both are fixed in the third
commit. Re-attack the FIXES, not the original bugs:

10. **The held-back row.** `releasedDeliverySignalId` / `releasedDeliveryAt` are
    set on `delivery_hold_released`, cleared when that signal is claimed again
    or acked, and cleared on the not-watching states. Find a sequence that
    leaves the field naming a row that is no longer held back, or that clears it
    while the lease is still live, or that double-counts / under-counts
    `waitingBehind` (which now subtracts BOTH the in-hand row and the held-back
    one). Check the `releasedDeliveryId === currentDeliveryId` guard.
11. **The reworded queue sentence.** It is now "This listener last saw an empty
    queue 4m ago." Is that claim true in every state it can render in, for BOTH
    the hosted workspace and the local listener? The field is cleared on
    starting/stopped/failed/unclean-exit; is any path left where it is rendered
    from a process that is not observing?
12. **`pendingDeliveryCount` staleness.** It is NOT cleared on the not-watching
    states, on the argument that its own line says it is what the service
    reported. Attack that argument.

## Round 3: what changed since cbcc1da. Attack the FIXES.

Round 2 arms both returned FAIL on items 10, 11 and 12. All three are addressed
in the fourth commit, mostly by REMOVING a claim rather than rewording it.

13. **The waiting count is gone.** No "Deliveries waiting..." line is rendered at
    all, and `queueNonEmptySince` / `queueNonEmptyForMs` are deleted. Is any
    operator-relevant fact now unavailable that the listener genuinely KNOWS?
    Distinguish "the listener knows it and no longer says it" from "the listener
    never knew it". If you claim a regression, name the exact field on the claim
    wire that carries the knowledge.
14. **The dated pending count.** "Pending deliveries reported by the service: 3.
    That count is what the last claim returned, 4m ago." Is that true in every
    state, including `stopping`, a read-retry backoff while `ready`, and a status
    read of a SIGKILLed process repaired by `effectiveListenerStatus`? Note
    `pendingDeliveryCount` is set to null on ack, so the pair can be absent.
15. **The generated release clause.**
    `LISTENER_DELIVERY_HOLD_RELEASE_CLAUSES` is a Record keyed by the reason
    union. Prove a new reason cannot ship without a clause, and check both
    clauses against what the runtime actually does on each path
    (`holdSpent` vs `leaseSpent`). Is either clause false for its own path?
16. **Forgetting a held-back row.** It is cleared when the row is claimed again,
    when it is acked, when a claim reports `pendingDeliveryCount === 0`, and on
    the not-watching states. Find a sequence that keeps a stale row named, or
    that forgets one that is still genuinely held back and unacked. The count is
    reset to 0 with the id: is that right when two were held back and only one
    came back?
17. **The line's final clause**: "It was not answered and not acknowledged, so it
    stays with the service, which decides when it comes back." Is every clause of
    that sentence true at the moment it is rendered, and for BOTH the hosted
    workspace and the local listener?

## Round 4: what changed since f25e6b8. Attack the FIXES.

Round 3 arms both returned FAIL on items 16 and 17, and one added item 14's
delivery-mode window. All three are addressed in the fifth commit.

18. **The held-back SET.** `heldBackDeliveries` is a bounded array, newest first,
    deduplicated on signal id, capped at `LISTENER_HELD_BACK_MAX`. Entries leave
    on: this claim returned that row, that row was acked, the pending count no
    longer fits the set (`.slice(0, pendingDeliveryCount)`), or a not-watching
    state. Attack the TRIM specifically: is "every held-back row is unacked, so
    the service's pending count is an upper bound on how many survive" true?
    Name a state where the trim drops a row that IS still held back, or keeps
    one that cannot be. Check the newest-first order against which entry the
    trim discards.
19. **The past-tense line.** "Delivery X was handed back 4m ago because
    <clause>. This listener has not answered it. For what the service did with
    it since: cswarm receipt X --workspace-id W". Is EVERY clause true at every
    moment it can render, for the hosted workspace and the local listener? Is
    the `cswarm receipt` command as printed actually runnable by the operator
    reading it (check the verb's real argument requirements in src/cli.ts)?
20. **`pendingDeliveryCountAt`.** Written on the claim event and the
    delivery-mode event, nulled on ack. Find a path that writes
    `pendingDeliveryCount` without it, or a state where the rendered age is
    wrong. Is "When the service reported it was not recorded." reachable, and is
    it true when it renders?
21. **Status file compatibility, again.** `heldBackDeliveries` is the first
    ARRAY-of-objects field added here, parsed by `parseHeldBackDeliveries`.
    Attack that parser: unknown keys, duplicates, a bad reason, over-cap length,
    a non-array, and whether a malformed value makes the whole status
    unreadable (and whether that is the right outcome). Confirm an old file
    without the key still round-trips.

## Round 5: what changed since ae193a3. Attack the FIXES.

Round 4 arms both returned FAIL on items 18 and 19. Both are fixed in the sixth
commit, item 18 by DELETING the unsound inference rather than repairing it.

22. **No trim.** A held-back entry now leaves the set only when a claim returns
    that row or it is acknowledged (plus the not-watching clear and the cap).
    The pending count no longer touches it. Attack the consequence: can the set
    now name a row indefinitely that is provably gone, and does any RENDERED
    clause become false as a result? Distinguish "the set holds a stale entry"
    from "the status tells the operator something untrue". Check the cap
    behaviour when 16 hand-backs accumulate.
23. **The new remedy line.** "Delivery X was handed back 4m ago because
    <clause>. [N other deliveries were handed back earlier and have not come
    back to this listener.] This listener has not answered it. After the lease
    ends the service either delivers it again or terminates it. If this repeats,
    raise the bound: cswarm listen start --turn-budget <duration>"
    Check EVERY clause, including the bracketed one, and the printed command:
    is `cswarm listen start --turn-budget <duration>` the right and sufficient
    remedy for a reader who already has a listener running, and is the "delivers
    it again or terminates it" pair exhaustive enough to be true (see
    durable-delivery.ts steps 2, 3 and 4)?
24. **Regression sweep.** This is the fifth round. Re-check the ORIGINAL claims
    (items 1, 2, 3, 6, 7) against the current SHA, not against your memory of an
    earlier one: the bound itself, lease abandonment, request amplification,
    status-file compatibility, and D-053. Say plainly if any earlier fix has
    been undone or weakened by a later one.

## Round 6: what changed since e5f75c9. This is the final round.

Round 5 arms both returned FAIL on the remedy (item 23); one also found the
capped others-count and an unswept help claim. All are addressed.

25. **Per-reason remedy, final form.** `LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES`
    is a Record keyed by the reason union. Only `hold_budget` names a setting
    (`--turn-budget`, plus that the bound is read at start so the listener must
    be restarted). `lease_budget` names none: "nothing needs changing: the row
    comes back under a new lease with its full length". Attack BOTH:
    - Is "nothing needs changing" true? Can a lease_budget release repeat
      indefinitely for a delivery, so that the operator does in fact need to act?
      Work it through with DELIVERY_LEASE_MS (15m), DELIVERY_MAX_ATTEMPTS (10),
      `effectPhaseBudget`, and a turn budget at the 60m maximum.
    - Is the hold_budget remedy complete and correct as advice?
    - A correction is recorded in `src/listener/types.ts` claiming that
      `effectPhaseBudget` contains no turn budget, contradicting a round-5
      review. Verify that at the source and say which is right.
26. **The controls.** `tests/listener-runtime.test.ts` now asserts each reason's
    line carries its own clause and remedy and NOT the other's, and the no-ack
    test asserts the release reason and heldMs. Name the mutation that makes
    each go red, and find any assertion in this file that would stay green under
    a behaviour change it claims to cover. Pay attention to negative assertions:
    one was already found to be over-broad (it banned a phrase the correct
    wording uses).
27. **`DESIGN-BOUNDS.md`.** Three bounds are recorded as accepted. For each, say
    whether the document's stated reason actually holds, and whether any of them
    should be a defect instead of a bound. Check its claims about
    `durable-delivery.ts` steps 2, 3, 4 and 7 at the source.
28. **Final regression sweep.** Re-check items 1, 2, 3, 6 and 7 on THIS SHA.
    Then look for any user-visible sentence anywhere in the diff (help text,
    status lines, code comments that will be read as fact) that asserts
    something the code does not do. That defect class has now landed six times
    in this lane.

## Round 7 (final). What changed since ca424a7.

Round 6 found: the hold clock was restarted on a recovered lease on the written
claim that the journal has no claim time (false), and the design note said the
lease caps the hold (false). Both are fixed and corrected in place.

29. **The hold clock now reads `active.claimCreatedAt`**, clamped with
    `Math.min(claimedAtMs, now())`, falling back to `now()` when unparseable.
    Attack it: is `claimCreatedAt` always present and correct on BOTH a fresh
    claim and a recovered `leased` row? Can the clamp or the fallback be reached
    in a way that silently restores the old fresh-clock behaviour? Does reading
    a claim time that precedes the lease grant make the bound fire too early in
    any real sequence, and is the anti-starvation rule (`processAttempt > 0`)
    still sufficient?
30. **`DESIGN-BOUNDS.md` after correction.** It now says a recovered lease gets
    one more attempt and that one turn can outlive its lease. Verify BOTH at the
    source, and check whether the corrected document still contains anything
    the code does not do.
31. **The two remedies, final.** `hold_budget` names the lease as a ceiling,
    generated from `LISTENER_DELIVERY_MAX_LEASE_MS`, which moved to types.ts.
    `lease_budget` says nothing needs raising and adds that repeated hand-backs
    end with the service no longer retrying. Check both against
    `durable-delivery.ts` and the runtime, and check the constant's move did not
    change any behaviour or break the `export *` surface.
32. **Whole-lane sweep, last pass.** Read every user-visible sentence and every
    factual code comment the diff adds or changes, and name any that the code
    does not do. Six have been found this way already. Then give the final
    verdict on the lane as a whole: is the seat bound correct, is anything the
    status says untrue, and is any earlier fix weakened.

## Round 8. What changed since 8e211d7. Confirmation round.

Round 7 split PASS / FAIL. The three findings on the FAIL side are fixed, and
all three were prose contradicting correct code:

33. **The hold_budget remedy** no longer says "up to the 15 minutes the service
    leases it for". It now says raising past that point stops helping, because
    the turn outlives its lease and the reply can no longer be acknowledged.
    Verify that reason against the ack path (does the ack in fact require a live
    lease?), and confirm the sentence no longer reads as a cap.
34. **`DESIGN-BOUNDS.md`** no longer says "every lease gets one attempt"; it
    distinguishes the hold bound's anti-starvation rule from the lease check,
    which can release at `processAttempt === 0`. Verify both at the source.
35. **The `deliveryHoldBudgetMs` comment** now says the hold is measured from
    `claimCreatedAt` (the reserve, before the grant) and that it is NOT clamped
    to the lease. Verify.
36. **Final sweep and verdict.** Read every user-visible sentence and factual
    comment the whole diff adds or changes and name any the code does not do.
    Then give a verdict on the lane: is the seat bound correct, does the status
    say anything untrue, and is any earlier fix weakened. If you find nothing,
    say so plainly and PASS.
