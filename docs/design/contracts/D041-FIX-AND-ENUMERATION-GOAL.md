# /goal — D-041: fix both bricks, then prove the whole state space, not the two we noticed

Branch: **`fix/v015-d040`**. Base for your work: the current branch tip (candidate code is `de848ee`).

## Read this first — why this round is different

Three rounds of work on this subsystem have each produced a **permanent-brick** defect, and **all
three were invisible to a fully green gate** (376/376, then 390/390). Every one was found by a
human-directed reader. **None by any instrument we own.** Round two's defect was created by the fix
for round one.

So the deliverable here is **not** "fix two bugs and re-run the suite". A green suite on this code has
demonstrated close to zero information value. The deliverable is **Part B** — an enumerated argument
about the whole state space. Part A is the easy half.

Read `docs/org/DEFECT-REGISTER.md` **D-040 and D-041** before starting.

---

# Part A — the two confirmed defects

## A1 · D-041a — the rescue code can brick the listener it exists to rescue

`runtime.ts:820`:

```ts
const terminal = recovery.signalId === null
  ? null
  : await options.store.read(recovery.signalId);   // <-- outside the try
if (…) {
  try {                                            // <-- try opens at :826
```

The read is **one line outside** the `try`, and **no `catch` exists between `:686` and `:1226`** —
verified by enumeration. In the frozen build this read was gated to `cursor_fallback` and never ran in
production. The D-040 fix promoted it to **every restart with a `leased` journal**. A malformed or
unreadable effect file now throws uncaught and kills the runtime **before** the stale-lease clear at
`:855-863`.

**Fix intent:** a failure to read a stored effect must be *recoverable*, not fatal. If the effect
cannot be read, the correct behaviour is the same as "no terminal effect exists" — clear the stale
claim and continue. Do not simply widen a `try` so the exception is swallowed silently; decide what
the recovery path *should* do when the effect is unreadable, and make it do that.

**Causal control:** corrupt the stored effect file, restart with a `leased` journal, assert the
listener recovers. Must fail red first.

## A2 · D-041b — `ack_pending` still carries the dead-mode gate that WAS D-040

`runtime.ts:788`:

```ts
if (recovery?.phase === "ack_pending") {
  if (page.capabilities.deliveryAck) { … continue; }   // always true in durable_claim
  … clearActive escape at :802-813 …                    // dead in the only mode we ship
```

`classifyDeliveryMode` (`:382`) returns `durable_claim` **only when `deliveryAck` is advertised**, so
the guard is always true and the escape is unreachable. A fatal from `sendPreparedAck` leaves the
journal at `ack_pending` **permanently**; `supervisor.ts:283-296` does not auto-retry.

**Fix intent:** `ack_pending` needs a reachable escape in `durable_claim`, on the same principle as
`leased` — past the lease horizon, a stuck ACK must be clearable rather than terminal.

**Causal control:** force a fatal `sendPreparedAck`, restart past the horizon, assert recovery.

---

# Part B — the enumeration · THIS IS THE POINT OF THE ROUND

Both defects above, and D-040 itself, are the **same bug three times**: a persisted state with no
reachable exit. We keep finding them one at a time, reactively, by whatever a reviewer happened to
notice. That has now failed three times running. Stop doing it.

Produce `docs/evidence/2026-08-04-d040-fix/state-space-enumeration.md` containing:

### B1 — every persisted journal phase

Enumerate **every** value `active.phase` can hold on disk (read the type and the writers; do not
guess). For each, a table:

| phase | how a restart discovers it | is there an exit? | is that exit reachable in `durable_claim`? | what if the exit's own operation fails? |

That last column is the one that would have caught D-041a. **An exit that can itself throw fatally is
not an exit.**

### B2 — every fatal stop site

There are **27** `stop = { reason: "fatal" }` sites in `runtime.ts`. Enumerate all of them — a table
with line, trigger, and a verdict:

- **not reachable from persisted state on restart** (justify), or
- **reachable, and recoverable** (say how), or
- **reachable and terminal** — which is a D-040-class defect and must be fixed or explicitly accepted
  with a reason.

**Do not sample. Do not stop at the ones named in Part A.** If the enumeration turns up a third
brick, that is a success of this exercise, not a failure of the fix.

### B3 — the honest gap list

What states or transitions could you **not** determine? Name them. An enumeration that claims total
coverage will not be believed, and should not be.

---

# Part C — finish the live-fire drill's treatment arm

`docs/evidence/2026-08-04-d040-fix/live-fire-drill.md` records the **control arm as accepted**: a real
listener on frozen `175f894`, `kill -9`'d mid-lease and restarted past the lease, **genuinely bricks**.
The instrument discriminates.

The candidate arm was **invalidated by a harness-created leftover journal lock** — an artifact, not a
product verdict. Re-run it against your fixed build and record the result. Reuse the existing harness;
handle the lock.

If the treatment arm shows the listener recovering, that is the first evidence in this entire release
that comes from an instrument which has *demonstrably* caught the defect class.

---

## Gate

Baseline: `npm test` **390/390** on `de848ee`. Acceptance **390 → N > 390**, every new control shown
red first, red output quoted.

Also green before you finish: `test:p1-local`, `test:p1-server`, `npm --prefix site test`,
`npm run build`, `check:tests`, `check:edge`.

**`NODE_OPTIONS` on this machine references a deleted preload, so every `node` invocation fails.**
Export `NODE_OPTIONS="--max-old-space-size=4096"` and make sure it propagates into anything you spawn.

**Do not treat a green suite as evidence of anything.** It was green for all three bricks. Part B is
the evidence.

## Scope

`src/listener/runtime.ts` and tests are expected. Anything else, justify in the report. Do not touch
migrations, `site/`, `package.json`, or `main`.

## Report

Per fix: change, control, red output, green output. Plus Part B's two tables in full, and Part C's
result. Then, plainly, **what you did not establish**.

Do not push. Do not touch `175f894` or `main`.
