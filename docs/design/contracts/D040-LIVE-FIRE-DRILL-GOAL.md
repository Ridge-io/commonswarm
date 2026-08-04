# /goal — D-040 live-fire drill: kill a real listener mid-lease and prove it recovers

Branch: **`fix/v015-d040`** (candidate `de848ee`). This is the **last gate** before v0.1.5 ships.

## Why this exists, and why it is not another test

D-040 is a defect that permanently bricks the listener. It was live in a build with **376 passing
tests and 22 causal controls**, and **every one of those instruments said the build was fine.** It was
found by a human-directed review, not by any gate we own.

The fix now has 18 new causal controls and the suite is 390/390. Those are **the same class of
instrument that already failed** — in-process tests with injected fakes. Re-running a bigger version
of the tool that missed it is not new evidence.

**This drill is the only new class of evidence available:** a real listener process, a real database,
a real `kill -9`, a real expired lease, a real restart. Nothing is mocked.

## The control is the entire point — read this before writing anything

A passing drill proves **nothing** on its own. You must run the identical drill against **both**
builds:

| Arm | Build | Required outcome |
|---|---|---|
| **Control (negative)** | frozen `175f894` | the listener **BRICKS** — fatal stop, does not recover |
| **Treatment** | candidate `de848ee` | the listener **RECOVERS** and continues |

**If the frozen build does NOT brick, the drill is broken and you must stop and say so.** That result
means your harness never reproduced D-040, and a green treatment arm would be measuring nothing. This
repo's standing rule: *"a probe that cannot fail is indistinguishable from one that passed"*, and
*"if both arms produce identical output, the instrument is broken — that is not a result."*

Report both arms' raw output. The control arm is not optional and its failure is the finding.

## Making it run in minutes rather than 15 real ones

`DELIVERY_LEASE_MS = 15 * 60 * 1000` is a hardcoded constant in
`supabase/functions/command/durable-delivery.ts:16`. For the drill only, shorten it (5–10 seconds) in
the **locally served copy**.

**This edit must never be committed.** Verify with `git status` before you finish and state in your
report that the working tree is clean. If shortening the lease changes the failure you observe, that
is itself a finding — say so rather than tuning until you get the answer you want.

## The drill

1. Local Supabase up; migrations applied from the tree under test.
2. Edge functions served with a real env file — **`supabase functions serve` does NOT inherit the
   parent environment**, it gets only what `--env-file` holds. `tests/p1-server` writes a real temp
   env file; copy that approach. A `/dev/null` env file silently runs every env-gated branch at its
   default and is how this repo has fooled itself before.
3. Create a workspace, an agent principal, and a credential. Send the agent a direct signal so a
   delivery is enqueued.
4. Start a **real listener process** (`cswarm listen start`, not an in-process harness) and let it
   claim the signal so the journal reaches the **`leased`** phase. Confirm that from the journal file
   on disk, not by inference.
5. **`kill -9`** the listener process while it is in `leased`. Not SIGTERM — the point is that no
   cleanup handler runs.
6. Wait past the (shortened) lease expiry.
7. **Restart the listener.** Observe what happens.

## What to record

For each arm: the journal contents after the kill, the exact stdout/stderr of the restart, whether
`listen start` reported success, whether the process then died, the stop reason and error text if it
did, and whether it recovered and processed the signal.

**Note specifically whether `listen start` prints success before dying** — that shape is what makes
D-040 so bad for an operator, and confirming it in a live process is worth having on record.

## Also verify, since you will have a live listener in hand

The downgrade hazard, which is currently reasoned about but not measured: a journal written by the
**fixed** build contains a `signalFingerprint` field; the **frozen** build's parser requires exactly
the old key set and should reject it as malformed. Write a journal with the fixed build, point the
frozen build at it, and record what actually happens. If it bricks on parse, that is a real
operational constraint on rollback and it must be written down before anyone plans a rollback around
it.

## Deliverable

Write to `docs/evidence/2026-08-04-d040-fix/live-fire-drill.md` on this branch and commit it. Include
both arms' raw output, the lease-shortening edit you made and proof it is not committed, and a plain
statement of **what the drill did not cover**.

If the drill cannot be built for a reason you hit — some step is not reachable from the CLI, the
harness cannot force the `leased` phase — **report that honestly and stop.** "This could not be
measured, here is exactly where it stopped" is a legitimate and useful outcome. Do not substitute an
in-process simulation and call it a live-fire drill; that would produce the one thing worse than no
evidence, which is evidence of the wrong kind wearing the right label.

Do not push. Do not touch `main` or `175f894`.
