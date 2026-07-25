# `swarm` drops messages silently, and `delivered` cannot tell you

**Found by Dana. Count confirmed by Pitch. Verified by the Lead.** Survived three wrong framings from
the Lead before anyone had the right one.

## The defect

★★ **CORRECTED AFTER FIRST LANDING — THIS DOCUMENT ORIGINALLY CITED THE WRONG COLUMN.** It claimed 37
messages "failed" because they had no row in `message_deliveries`. **Absence of a delivery row does not
mean failure.**

★ **The first explanation for *why* was also wrong, and is corrected here.** It said delivery rows are
an artifact of the hook-injection path and an a2a seat never gets them. **It is not a property of the
a2a class — it is a time cutoff.** The same agent, `Anvil`, has **4-of-4** rows in one swarm on
2026-07-23 and **0-of-3** in another on 2026-07-24/25. The last a2a message with a delivery row
anywhere is **2026-07-23T12:37**.

**`message_deliveries` has had no coverage for a2a seats since then, so for those recipients the table
answers neither yes nor no.** The conclusion survives; the reason did not. Measured:

| recipient | messages | with delivery row |
|---|---|---|
| Dana (a2a, since 07-24) | 32 | **0** — and they all arrive |
| Anvil (a2a, 07-23) | 4 | **4** — same class, same table, rows present |
| Ferry (cmux) | 130 | 129 |
| Lead6 (cmux) | 178 | 177 |

**The count was built on a column that carries no information for that seat.** Retracted by its own
finder within twenty minutes, and re-derived here.

**THE DEFECT IS REAL AND THE EVIDENCE IS THE `delivered` FLAG.** Messages to the wedged seat:

| window | delivered | count |
|---|---|---|
| before 20:40 | 1 | **1685** |
| before 20:40 | 0 | 24 |
| after 20:40 | 1 | **0** ★ |
| after 20:40 | 0 | **15** ★ |

**After 20:39:54, nothing succeeded. Fifteen consecutive failures, zero successes.** The finder
reported the cliff at 20:41:40 from the far side; the sending machine's own store puts it at 20:39:54
— **two independent observations of the same wedge.**

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

★★ **AND THE MITIGATION DOES NOT EXIST.** This property was tolerated on the reasoning that `--now` /
`--interject` provides an urgent path. **It is a documented no-op on Claude and Codex** —
`transport-interface.ts:26` (*"No-op on Claude/Codex"*) and `transport.ts:191` (*"Claude/Codex submit on
the first"*). Only a Grok seat honours it. **In this fleet that is 1 seat of 10; the Lead had been
using `--now` all day for urgent messages and it had done nothing all day.** The gate is not
"queueing with a bypass" — for almost every seat it is queueing, full stop.
*(Read from source in two places by different authors, not from a runtime test — confirm live before
scoping work on it.)*

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
