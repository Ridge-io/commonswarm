# The coswarm org — charter

**Operator directive, 2026-07-25:** stand up a standing organisation across tabs and workspaces —
product, research, marketing, testing, development, infrastructure, operations — to drive coswarm to
launchable **continuously**. Hunt errors, architectural bugs, poor design, technical debt, marketing
debt. Clean up, test, validate, optimise for performance and cost. **Ship, and ship frequently.**

**The Lead (and every successor) is the final authority on production deploys.**

---

## 0. THE HARD CONSTRAINT THAT SHAPES EVERYTHING

This org runs on **one 16 GB machine**. That is not a footnote; it is the design input.

Measured at charter time, before any expansion: **swap 14.2 GB used of 15.4 GB, 0.02 GB free.**
Reclaiming the local Supabase stack, OrbStack, and ten stale language-server sets took swap to
**8.1 GB used** — a ~6 GB swing, and the only reason expansion is possible at all.

**★ THEREFORE THE ORG IS NOT A ROSTER OF RESIDENT AGENTS. IT IS A SMALL RESIDENT CORE PLUS EPHEMERAL
FAN-OUT.** A resident cmux agent costs a tab, a process, and permanent memory. A workflow subagent
costs tokens and nothing else, and it disappears. **Default to ephemeral. Spend residency only on
lanes that need continuity of context.**

**Before spawning anything, check the envelope.**

★★ **THE FIRST VERSION OF THIS GATE COULD NOT FIRE, AND IT WAS WRITTEN BY THE LEAD WHO SPENT THE DAY
CATALOGUING GATES THAT CANNOT FAIL.** It said *"reclaim if swap used exceeds ~12 GB."* **macOS resizes
the swap file dynamically** — measured within one hour: 15.4 GB → 8.2 GB → 9.2 GB total. An absolute
threshold against a moving denominator is meaningless, and at a 9.2 GB total *used > 12 GB* is
**unreachable by construction.** Found by the infra lane; the RED was available the whole time.

**The gate is a RATIO and a pressure reading, both of which can fire today:**
```sh
sysctl -n vm.swapusage      # utilisation = used / total, NOT an absolute
vm_stat | grep -E 'Pages free|compressor'
memory_pressure | tail -2   # system-wide free percentage
```
**Reclaim before spawning if swap utilisation is above ~75% of current total, or system free is below
~35%.** It read 86% / 30% when written — **RED**, which is the property the old gate lacked. A gate
whose RED you cannot produce on demand is not protecting anything.

★★ **THE GATE IS NOW A SCRIPT, NOT A SENTENCE: `scripts/envelope-check.sh`.** Run it; it exits **1**
on RED so it can guard a spawn (`./scripts/envelope-check.sh && swarm spawn …`). **Three trip
conditions, each with a FIXED denominator** — which is the property the two earlier versions lacked:

| condition | source | denominator |
|---|---|---|
| system free < 35% | `memory_pressure` | **physical RAM — cannot move** |
| swap used > 8192 MB | `vm.swapusage` *used* | **absolute bytes paged out, not a ratio** |
| disk free < 20 GB | `df -k /` | the floor under the swapfiles |
| compressor | `vm.compressor_bytes_used` | **recorded, NOT a trip** — diagnostic only |

★ **Two of three were RED on delivery, without contrivance**, and the GREEN one is the one drifting
toward its threshold — which is the honest picture rather than a gate tuned to fire.

★ **Rejected, with reasons, by the lane that owns the envelope:** *swap utilisation %* — its
denominator is `count(swapfile) × 1 GB` and was measured moving a full gigabyte inside **twelve
seconds**, so two agents reading the same gate seconds apart legitimately disagree; that is not a
threshold problem and not tunable. *Pageout rate* — needs two samples, is noisy, and the lane
demonstrated the failure itself by extrapolating a slope it withdrew within a minute. **Level gates,
not rate.** *Compressor as a fourth trip* — it moves **with** free%, so it would fire when condition
one fires: **redundancy dressed as rigour.**

★★ **KNOWN DEFECT, FOUND MINUTES AFTER LANDING: TWO OF THE THREE CONDITIONS ARE ONE MEASUREMENT.**
`disk free` and `swap total` are the same quantity with the sign flipped — **the swapfiles ARE the
disk**. Measured, five samples over twelve seconds:
```
disk_free=28.7G  swap_total=9.0G   SUM=37.72G
disk_free=29.7G  swap_total=8.0G   SUM=37.72G
disk_free=30.7G  swap_total=7.0G   SUM=37.71G   ← components moved 2 GB; sum moved 0.01 GB
```
So a **disk gate fires during any large swap excursion and goes quiet when it recovers** — it reports
the same event as the swap condition rather than bounding it, and *"RED on two of three"* can be
satisfied by **one underlying event**. That is the mirror of a gate that cannot fire: **a gate that
reports RED on a recovering system.**
**The proposed fix, not yet taken:** gate the **conserved sum** `disk_free + swap_total`, which is
what actually bounds the denominator, moved 1–2 GB across an entire session, and is immune to the
excursion. **The absolute `swap used` condition is untouched and was always right.** Redesign belongs
to the envelope lane.

★★ **AND TWO LEAD RECLAIMS WERE MEASURED AND BOTH DID NOTHING.** Removing a worktree and three merged
branches moved swap 94% → 93%. Stopping the local Supabase stack and quitting the container host
moved system free **40% → 36% and swap used 6596 → 7184 MB — slightly worse**, with the gate already
GREEN before the intervention. **The envelope recovers on its own and is dominated by something other
than what a Lead reaches for first.** ★ *A reclaim that is not measured afterwards is a ritual* — and
measured, these two were.

★ **THE CONSTANTS ARE CALIBRATED, NOT DERIVED.** 8192 MB and 20 GB are anchored to one machine on one
day — the session's healthy floor and its observed excursions. **The shapes are principled; the
numbers should be revisited once anyone has a second day of data.** Recorded at the author's
insistence rather than allowed to harden into derived values.

★★ **BUT DO NOT READ A LEVEL AS A TREND, AND DO NOT STAND LANES DOWN ON THE STRENGTH OF ONE.** The
Lead measured 94% once and wrote that the machine was *"structurally over-subscribed"*, and that
phrasing reached the succession baton as a recommendation. **Three readings twelve seconds apart then
showed 85% → 84% → 82%, falling unaided**, and the swap file had already shrunk 12.3 → 10.2 GB on its
own. The envelope **oscillates and recovers** — 4.7 GB after a morning reclaim, 10.5 GB at peak,
falling after. **The gate firing was real; "structural" was invented, and it was the word carrying the
advice.** If the envelope is genuinely a problem it will assert itself again and be measurable then.

Never spawn into pressure; a swapping fleet is slower than a smaller one.

---

## 1. THE PRODUCT SURFACE

| repo | remote | what it is |
|---|---|---|
| `cloud-swarm` | `Ridge-io/cloud-swarm` | the product: protocol, hosted edge functions, `coswarm` CLI |
| `swarm` | `Ridgeio/swarm` | the local coordination CLI this fleet runs on — **and it ships defects** |

Everything else under `Ridge.io/` belongs to other products and is **out of scope**.

★ `swarm` is in scope precisely because we found a shipping defect in it today
(`transport.ts:20`, unbounded `execFileSync`) that cost a day and is the leading candidate for a
two-hour hang recorded months ago. **We are our own most demanding user; the tooling repo is part of
the product surface.**

---

## 2. RESIDENT CORE — continuity of context justifies a tab

| lane | agent | owns |
|---|---|---|
| **Lead** | Lead6 → successors | orchestration, rulings, **sole production-deploy authority** |
| **Architecture & adversarial review** | Sable `[grok]` | every brief before implementation; contracts; security; the collapse test |
| **Development** | Quill `[codex]` | implementation across both repos |
| **QA & validation** | Ferry `[claude]` | uxtest harness, gates, RED-then-GREEN discipline |
| **Research** | Atlas `[claude]` | primary sources, competitive landscape, clean negatives |
| **Cross-device ops** | Dana `[cmux, laptop]` | the second machine, GUI-origin work, cross-device validation |
| **Provisioning** | Anvil `[a2a]` | infra with operator authority — **★ registry entry currently misrouted, fix before use** |

**New lanes, spawned under this charter:**

| lane | owns |
|---|---|
| **Product & launch** | the gap between *works* and *launchable*; roadmap; what "done" means; cutting scope |
| **Marketing & narrative** | positioning, onboarding copy, docs, **marketing debt** — the product is unexplainable to a stranger today |
| **Infra, cost & performance** | hosted resources, deploy pipeline, latency, spend, monitoring |

**Ephemeral, never resident:** consistency audits, fan-out reviews, deep research sweeps, migration
passes, adversarial verification. These run as **workflows** and cost no memory.

---

## 3. THE STANDING HUNT — what everyone looks for, always

1. **Gates that cannot fail.** Two found in one harness today; one asserted a property that was never
   in force. Every gate needs a demonstrated RED.
2. **Claims verified against the wrong object.** The day's dominant error: a shell measured for a tab,
   a registry for a machine, a fix's presence for its completeness.
3. **Layers that report success without doing the work.** A card that resolves to the wrong agent, a
   port that accepts without serving, a surface that outlives its process. Three instances in one day.
4. **Unbounded waits.** No timeout is a hang waiting for a bad day.
5. **Marketing debt.** If a stranger cannot tell what this is and why it matters in 30 seconds, that
   is a defect with the same standing as a failing test.
6. **Cost and performance.** Hosted spend and latency are product properties, not ops trivia.

---

## 4. HYGIENE — non-negotiable, because the machine is the constraint

**★ TWO OBJECTS, TWO CLEANUPS.** `kill <pid>` ends a process; **the cmux surface survives it**, and
`swarm leave` does not close a tab either. Capture the surface id from `swarm spawn`'s own success
line — *"(new tab: workspace:1, surface:83)"* — and close it:
```
cmux close-surface --surface <id>
```
Four orphaned surfaces accumulated on one machine in a single day, unnoticed.

**★ BUT NOT BLINDLY.** Probe residue is *contamination for a round* and *evidence for a diagnosis*,
and which one depends on what happens next. Those same four orphans were the only observable sample
of a spawn-created persona environment in existence. **Sweep before a measurement; preserve while
diagnosing.** The sweep belongs in a round's pre-flight, not in the prober's reflex.

**Rotation (§0c).** Watch compaction counts. **≥10 compactions or ≥12h continuous is due.** Rotate at
a task boundary — near-zero cost before implementation, steep once mid-file. Capture the outgoing
agent's non-obvious knowledge as a durable on-disk note first. Frame it as hygiene, not judgement.

**Resource discipline.** Check swap before spawning. Stop the local Supabase stack when not running
integration tests — but **verify what is *runnable*, not only what is *running***: stopping it
silently removed three tests and cost a review round.

**Debris.** `swarm janitor tick --observe`; `git worktree prune`; kill stale language servers.

---

## 5. SHIP CADENCE — the Lead's standing obligation

**Ship small, ship often, ship verified.** The bar for a production deploy:

1. **Reviewed** — through Sable before implementation, not after.
2. **RED-then-GREEN** — every gate has a demonstrated failing state.
3. **★ VERIFIED BY THE LEAD'S OWN EXECUTION.** Not the worker's report. Re-run it. This has caught
   real defects from good workers.
4. **Narrow claim.** State exactly what is proven and what is not. *"Deployed and denies correctly,
   accept path unproven"* beats *"it's live."*
5. **Revert-able**, and the revert stated before the deploy.
6. **Linear history**, docs-and-code, no merge commits.

**The Lead is the sole production-deploy authority and may not delegate it.** A dispatch is not a
clearance — that distinction cost this fleet sixteen minutes today when an agent correctly refused a
valid order that arrived without its authorisation attached. **Authorisation and instruction travel
on the same channel, or the recipient is right to refuse.**

---

## 6. LAUNCHABLE — the bar

Not "the tests pass." A stranger, on their own machine, can:
1. Install `coswarm` and authenticate without being walked through it
2. Create their own workspace **— blocked today: `operatorAllowed` ships as a constant `false`**
3. Invite a collaborator who accepts without a terminal ritual
4. Post and read signals from **both** machines **— blocked today: the CLI is not on the second machine at all**
5. Understand what they are looking at without reading source

**Every item is a lane. Item 5 is marketing's, and it is the one most likely to be treated as
optional.**
