# `swarm` drops messages silently, and `delivered` cannot tell you

**Found by Dana. Count confirmed by Pitch. Verified by the Lead.** Survived three wrong framings from
the Lead before anyone had the right one.

## The defect

**37 messages from one agent have `delivered=0` and NO ROW AT ALL in `message_deliveries`.** They were
never queued for anyone. They span **fifteen hours** — 06:48 to 21:57 on 2026-07-25.

They are not machine chatter. They open with a human name: `FERRY —` ×11, `LEAD6 —` ×2,
`FERRY + ATLAS —`, `LEAD5 + FERRY —`.

★ **The newest, id 11571, is addressed to the Lead and was sent 1m57s before the Lead broadcast a
retraction that it would have corrected.** It says, in its first line: *"You are folding my case into
the latency finding. MINE IS A DIFFERENT DEFECT."* **The message explaining the drop was dropped.**

## ★ The split, in the finder's words — and it is the whole finding

```
LATENCY  delivered=1, complete in the store, read ~4 minutes late
DROP     delivered=0, and absent from the receiving machine's database entirely
```

> **"A RED for latency proves a message ARRIVES LATE. It will pass happily while a wedged endpoint
> DROPS messages, because dropped messages never arrive to be timed. The two failures are not on the
> same axis and one test cannot cover both."**

That is the vacuous-gate class applied to a distinction the Lead had collapsed. **A latency test
cannot fail on a dropped message**, because the dropped message is not present to be measured.

## ★ And the second half, which is why nobody noticed for fifteen hours

**`delivered` is doing two jobs.** It means *reached the store* and it is read as *reached the
recipient* — and it reports the same value for a message read four minutes late and one that will
never be read at all.

> *"I trusted it for fourteen messages this morning with MiniRelay, which had forwarded zero."*

**Whatever the fix is, that flag has to stop being the thing anyone checks.** `delivered=1` with zero
rows in `message_deliveries` is the state that should be impossible and is instead routine.

## Mechanism

The agent addressed a seat whose endpoint accepts TCP and serves no HTTP — `http_code=000` in 0.03s
**including from the host's own loopback**, so not network. `swarm redeliver` reported 0/2, twice.

★ **A port that accepts is not a server that serves.** Fourth instance of that family in one day,
after a registry entry resolving to the wrong agent, a cmux surface outliving its process, and a
`which` shim that execs itself forever.

## What the Lead got wrong, recorded because the corrections are the useful part

1. **"delivery latency"** — refuted by a 3.7s row in the Lead's own query output; it was a
   recipient-side turn boundary, not a slow pipe.
2. **"a single relay hop carries 100% of one agent's output"** — refuted by `.schema messages`:
   there is no via/route/hop column, `to_agent` is the recipient and is literally the inbox index.
3. **"no specific message failed"** — the bound the Lead kept from the reviewer, closed by the count
   above. **37 did.**

★ Each framing was published after a real observation, and **each disproof was one command away from
the person publishing it.** The finding survived all three because its author had measured it
directly and kept saying so.

## The fix shape (not taken)

- **Make an undeliverable send loud at send time.** Addressing a seat with no live delivery path
  currently succeeds silently and produces a message row with no delivery row.
- **Split the flag.** `stored` and `delivered-to-recipient` are different facts; one column cannot
  carry both, and the conflation is what hid this for fifteen hours.
- **RED that fails today:** send to a seat whose endpoint is wedged; assert the sender learns. It
  does not, and that is the gate.
