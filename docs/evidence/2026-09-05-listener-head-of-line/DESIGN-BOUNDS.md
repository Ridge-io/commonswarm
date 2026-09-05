# Listener seat bound: what the design accepts, and why

Companion to the `lane/listener-head-of-line` commits. These are accepted
bounds, not open defects. Each one was raised by a review arm and kept
deliberately.

## The held-back set can hold an entry the service has already finished with

`ListenerStatus.heldBackDeliveries` records deliveries this listener handed back
before answering them. An entry leaves only on this listener's own evidence: a
claim returned that row, the row was acknowledged, the listener entered a state
where it is not watching, or the cap pushed it out.

The service can finish with a row without this listener hearing. In
`supabase/functions/command/durable-delivery.ts`, a later claim transaction
unleases the row (step 2) and may then acknowledge it as `expired` (step 3) or
`failed_terminal` at the attempt ceiling (step 4). No event reaches the listener.
So the set can name a row the service has already terminated.

This is accepted because no rendered clause depends on the row's server state:

- "Delivery X was handed back 4m ago because ..." is local history.
- "This listener has not answered it" is a fact about this process.
- "After the lease ends the service either delivers it again or terminates it"
  is the mechanism, and names the case that made the entry stale.
- "This listener is still tracking N other handed-back deliveries" describes the
  set itself, which is why it stays true at the cap.

The rejected alternative was trimming the set to the service's pending count.
That inference is unsound in both directions: step 7 counts unacked rows whose
signal `until > statement_timestamp()`, while step 2 unleases only once
`leased_until <= statement_timestamp()`, so a hand-back whose TTL elapses under
a live lease is still leased, still unacked, and absent from the count. The count
also includes rows that were never held back.

## A recovered lease gets one more attempt, and one turn can outlive its lease

CORRECTED. This section previously said the hold clock restarts on a recovered
lease because "the delivery journal does not store the original claim time, and
a bound that cannot be measured is not a bound", and that "the server lease
still caps the hold at 15 minutes". Both sentences were false, and a review arm
found them. They are kept here because a reader may have met them.

The journal DOES store the claim time: `reserveClaim` writes `claimCreatedAt`
and the `leased` phase cannot parse without it. The runtime now measures the
hold from that value, so a lease recovered across a restart keeps its original
clock instead of getting a fresh budget.

What remains, stated accurately:

- A recovered lease still gets ONE `engine.process` before the HOLD bound can
  fire, because `processAttempt` starts at 0 again, so a hold budget shorter
  than one phase cannot starve a delivery. This is not "every lease gets one
  attempt", which an earlier draft said and a review arm refuted: the LEASE
  check is separate and can release at `processAttempt === 0`, when what is left
  of the lease is already under the phase minimum.
- The lease does NOT cap an in-flight turn. `leaseSpent` refuses to START a
  phase when what is left of the lease is under the phase minimum; it does not
  interrupt a turn already running. The prompt timeout is `--turn-budget`, which
  can be set as high as 60m against a 15m lease, so one turn can outlive its
  lease. The honest bound on one delivery's hold is therefore the attempts
  already started plus one turn budget, not the lease.
- That is also why the `hold_budget` remedy names the lease as the point where
  raising stops helping, and says why: past it the turn outlives the lease the
  reply has to be acknowledged under. It is NOT a cap, and the sentence must not
  read as one; nothing clamps the turn budget to the lease.

## The listener cannot know the age of the oldest waiting delivery

The claim wire carries a pending count and the claimed row. It carries no
enqueue times for the rows behind it, and it does not separate leased rows from
claimable ones. Three wordings were tried and all three were refused as claims
the listener cannot support: `queueWaitingSince` / `queueWaitingForMsAtLeast`,
then `queueNonEmptySince` / `queueNonEmptyForMs`, then a derived
"waiting to be claimed" count. Status now reports the pending count with the
time it was observed, and says nothing about which rows are claimable.

Closing this properly needs a server change: return the oldest pending row's
enqueue time on the claim response.
