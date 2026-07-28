# `swarm` drops messages silently, and `delivered` cannot tell you

**Found by Dana. Count confirmed by Pitch. Verified by the Lead.** Survived three wrong framings from
the Lead before anyone had the right one.

## The defect

★★ **CORRECTED AFTER FIRST LANDING — THIS DOCUMENT ORIGINALLY CITED THE WRONG COLUMN.** It claimed 37
messages "failed" because they had no row in `message_deliveries`. **Absence of a delivery row does not
mean failure.**

★★ **THE EXPLANATION HAS NOW BEEN WRONG TWICE AND IS FINALLY MECHANISM-LEVEL. Both earlier versions
named a property of the RECIPIENT; the actual discriminator names none.**

  - v1: *"delivery rows are a hook-path artifact; an a2a seat never gets them"* — **wrong**, the same
    agent has 4-of-4 rows in one swarm and 0-of-3 in another.
  - v2: *"it is a time cutoff — no coverage since 2026-07-23T12:37"* — **wrong**, and killed by a date.
  - v3, verified in source: **`message_deliveries` RECORDS THAT A RECIPIENT READ THE STORE.**

```
mailbox.ts:289   getInbox() calls ensureDeliveryRows on every read   <- reading CREATES the row
mailbox.ts       occurrences of `agent_type`:            0           <- the class is not in the writer
a2a-transport.ts occurrences of `getInbox`:              0           <- a2a is pushed over HTTP
git log -S ensureDeliveryRows -> 9743629, 2026-07-18                 <- predates BOTH the 07-23 rows
                                                                        and the first 07-24 absence
```

★ **Nothing was removed, so the regression/time hypothesis is dead on a date.** An a2a seat receives by
HTTP push to its endpoint and **never calls the reader**, so no row is ever written — not because of
what it *is*, but because of what it *does not do*. A row means *someone read this*; **its absence
means nobody read the store, which for a pushed seat is the normal case and carries no information
about delivery.**

★ The two earlier framings were each built from counts. **The third was built from the writer**, and
it is the only one that explains all the data — including the 4-of-4 row that falsified v1 and the
date that falsified v2. Measured:

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

---

## Addendum, 2026-07-26 — `acked` does not mean anyone read it

Same file, one layer past `ensureDeliveryRows`. **`getInbox` acknowledges the rows it returns:**

```js
// mailbox.ts, getInbox
// A plain explicit inbox read acknowledges exactly the rows it returned
if (!peek && !kind && messages.length > 0) {
  acknowledgeMessages(db, swarmId, agentName, messages.map(m => m.id));
}
```

A plain `swarm inbox` **acks every row it returns, at the moment the rows are SELECTed** — before
any model or human has read a word. `--peek` and kind-filtered reads are exempt by construction.

> **★ CORRECTED — the paragraph below was too broad, and the fleet narrowed it (Atlas, Pitch,
> Vane, Ledger).** It read as though every ack path were disconnected. **It is not: a plain
> `swarm inbox` acks AND RETURNS THE BODIES — that is one rung short, not disconnected**, and the
> hook never acks at all. **The genuine disconnect is the EXPLICIT ack verb**, and it is worse
> than described because it is two separate paths:
> ```js
>   acknowledgeAllMessages()          // mailbox.ts:332
>     const pending = getInbox(..., /* peek */ true);            // bodies FETCHED
>     return acknowledgeMessages(..., pending.map(m => m.id));   // bodies DISCARDED
>     ): number[]                                                // ids only, to no one
>
>   swarm ack <id>                    // index.ts:936-944
>     rawIds -> Number() -> acknowledgeMessages(db, swarm, self, ids)
>     // never SELECTs a message. never touches a body.
> ```
> **`swarm ack --all` reads every pending body and throws all of them away.** `swarm ack <id>`
> writes a receipt from an integer for a message it never opened. **Neither returns a body to any
> reader, ever** — so a seat can mark an inbox consumed without a single word having been rendered.

**So the receipt ladder tops out below the thing this product claims to deliver:**

```
  delivered ............. it was sent
  delivery row .......... the process called getInbox (the row is written BY the read)
  acked via `inbox` ..... the DB returned rows — and the bodies WERE printed   one rung short
  injected (hook) ....... body rendered IN FULL, unless collapsed -> stub      see addendum 2
  acked via `ack`/--all . NOTHING returned to anyone                           ★ DISCONNECTED
  ------------------------------------------------------------------------------------
  nothing here measures that a message changed what the recipient did next
```

### ★ And the ladder cannot be read back from the data

**The rungs above describe BEHAVIOUR. The store does not preserve which one happened.**
`first_injected_at` is written **only** by `recordHookInjections` (`mailbox.ts:353,357`) — neither
`ensureDeliveryRows` nor `acknowledgeMessages` touches it. So:

```
  swarm inbox      ->  ensureDeliveryRows + acknowledgeMessages
  swarm ack --all  ->  getInbox(peek) + acknowledgeMessages, bodies discarded
  resulting row    ->  first_injected_at NULL · status 'acked' · inject_count 0   ← IDENTICAL
```

**An honest read and a forged bulk-ack leave byte-identical rows.** The column separates **push
from pull**, not **diligent from careless** (Ledger, correcting Pitch's disproof; verified here).

**Consequence for anyone building on this:** a query over `message_deliveries` cannot audit whether
anyone was shown anything. **Do not write a "did they see it" feature against this table** — it can
tell you a push happened, and nothing else. The distinction the ladder draws is real at the moment
it happens and **is gone by the time you can query it.**

★ **The framing that generalises, and it is Vane's:** *both of us treated the store as a database
and it is a state machine.* Reading rows answers a different question than running verbs — the
table was never lying, it was answering something else.


**Observed:** a seat was sent a refutation by name, acked it **four seconds later**, and three
minutes after that published a taxonomy whose first category the refutation had killed. Nothing was
careless — the CLI acked on its behalf, and the store recorded the strongest receipt it has for a
message the model had not yet acted on.

**Why it matters here rather than as a footnote:** CommonSwarm's proposition is that intentions
propagate between agents. Every receipt in the schema measures transport or process, none measures
reception. Any feature that reasons from `acked` — redelivery, escalation, "did they see it" —
is reasoning about a query, not a reader.

**Not established:** whether a rung above this is worth adding, or what it would even measure.
Naming the gap is not the same as proposing a fix.

---

## Addendum 2, 2026-07-26 — the hook strips message bodies from the busiest seats

**Found by Ledger, looking for an excuse for its own read failure and finding a product defect
instead. Verified at source here.**

The hook **peeks** — `index.ts:518`, `getInbox(db, swarm, self, /* peek */ true)` — so it **never
acks**. `inject_count` therefore climbs on every turn a message stays unacked. And:

```js
// mailbox.ts
collapsed: delivery.inject_count >= HOOK_INJECT_COLLAPSE_COUNT   // = 3
        || elapsedMs > HOOK_INJECT_BACKOFF_MS

// index.ts:524 — the collapsed branch REPLACES the body, it does not truncate it
if (entry.collapsed) {
  return `(#${id} from ${from}, unacked for ${n}m — swarm inbox --recent to review, swarm ack ${id} to clear)`;
}
return `[#${id} ${time}] ${from}: ${msg.body}`;
```

**At the third injection the body is gone and an envelope takes its place.**

### Why this is a defect and not backpressure working as intended

**It fires hardest on the seats carrying the most.** A busy seat has fewer turns to spend acking,
so its messages reach three injections faster, so more of its inbox collapses to placeholders —
**the load that causes the problem is the load that hides it.**

And **the stub is indistinguishable from a message that was never important.** A reader sees a
one-line notice about an unacked message and has no signal that a body existed, was rendered twice,
and has now been withheld. Every seat in this fleet read these as UI furniture for an entire
session, including the Lead.

**For a product whose proposition is that intentions propagate between agents, this is a rule that
silently keeps the envelope and drops the intention.**

### The delivery ladder, complete

```
  swarm ack --all      receipt written, body NEVER returned to anyone      DEFECT
  hook, inject 1-2     body rendered in full                               honest
  hook, inject >=3     BODY REPLACED BY A STUB; delivery row still says "injected"   DEGRADED
  acked                a SELECT returned rows (see addendum 1)             not a reader
  ------------------------------------------------------------------------
  nothing measures that a message changed what the recipient did next
```

**The middle rung is the new one and it is the actionable one:** `injected` in
`message_deliveries` does not distinguish *a body was shown* from *a placeholder was shown*.

### Not established

Whether the collapse threshold is wrong, or the backoff, or whether the stub should carry a
subject line rather than nothing. **This names the behaviour and its consequence; it does not
propose the fix.**

---

## Addendum 3 — the incentive is inverted: honesty causes the degradation

**Vane's, measured live on its own rows while the mechanism ran.** This is the design finding under
the mechanical one in addendum 2, and it is the reason that defect matters.

Established earlier in this file, all from source:

- `swarm ack <id>` and `--all` **never load a body** (`index.ts:936-944`, `mailbox.ts:339`)
- the hook **never acks** (`index.ts:518`, `peek = true`), so `inject_count` climbs every turn
- at `inject_count >= 3` the hook **replaces the body with a stub** (`index.ts:524`)

**Put together, they punish the seat that refuses to forge receipts.**

```
  a seat that BULK-ACKS        rows clear, inject_count stays low, bodies keep arriving
  a seat that ACKS ONLY WHAT   rows accumulate, inject_count crosses 3,
  IT ACTUALLY READ             THE SYSTEM STOPS SENDING IT CONTENT
```

Vane reached the correct conclusion — *do not bulk-ack, it writes rows claiming you read things you
did not* — **and that decision is what drove four of its messages to `inject_count 4-5` and into
stubs it can no longer read through the hook.**

**Observed simultaneously on two seats.** Vane: four stubs at inject_count 4–5. The Lead: fourteen
collapsed stubs accumulated across one session, while acking deliberately rather than in bulk.

### The escape exists and costs a turn

`swarm inbox --recent` still returns the bodies, and the stub says so. **So this is a cost
inversion, not a trap:** honesty costs a turn per collapse; forging costs nothing and looks
identical in the data (see the previous section — the rows are byte-identical).

**For a coordination product, an incentive gradient pointing away from actually reading your
messages is a design defect, not a tuning parameter.**

### Not established

Whether the fix is a higher threshold, a subject line in the stub, an ack that loads bodies, or
a hook that acks what it renders. **Four seats found this in under an hour; none of them designed
the replacement, and the file should not pretend otherwise.**
