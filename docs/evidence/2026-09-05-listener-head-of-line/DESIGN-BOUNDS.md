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

## The hold clock restarts on a lease recovered across a restart

`holdStartedAtMs` is taken when the lease is in hand. A lease recovered after a
restart therefore gets a fresh budget: the delivery journal does not store the
original claim time, and a bound that cannot be measured is not a bound. The
server lease still caps the hold at 15 minutes.

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
