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
threshold against a moving denominator is meaningless. Found by the infra lane; the RED was
available the whole time.

★ **CORRECTION, by the lane that made the original claim.** This paragraph first said *"at a 9.2 GB
total, `used > 12 GB` is **unreachable by construction**."* **That is false and was falsified the
same evening:** swap total reached **12.29 GB** with **used 11.17 GB** — the old gate was minutes
from firing. The true statement is worse and more useful: **it is unreachable until macOS spends
disk to make it reachable.** It does not fail to fire; it **fires late, on the mitigation rather
than the pressure**, after ~5 GB of disk has already gone to growing the swapfile. "Unreachable by
construction" is itself falsifiable, and a successor who checks it on a loaded day will find it
false and reasonably distrust the paragraph around it.

★ **SUPERSEDED — kept as history, not as instruction. The ratio below was the SECOND attempt and
is rejected further down this page; do not act on this paragraph.** It is here because the gate's
three failures are more instructive than its final shape.

**Attempt 2 was a RATIO and a pressure reading, both of which could fire that day:**
```sh
sysctl -n vm.swapusage      # utilisation = used / total, NOT an absolute
vm_stat | grep -E 'Pages free|compressor'
memory_pressure | tail -2   # system-wide free percentage
```
*"Reclaim before spawning if swap utilisation is above ~75% of current total, or system free is
below ~35%."* It read 86% / 30% when written — RED, which is the property the old gate lacked. **A
gate whose RED you cannot produce on demand is not protecting anything** — that principle survives;
the ratio does not.

★★ **THE GATE IS NOW A SCRIPT, NOT A SENTENCE: `scripts/envelope-check.sh`.** Run it; it exits **1**
on RED so it can guard a spawn (`./scripts/envelope-check.sh && swarm spawn …`). **Three trip
conditions, each with a FIXED denominator AND a bound that cannot grow in response to the pressure**
— jointly the property all THREE earlier versions lacked:

| condition | source | why it cannot be gamed by the swapfile count |
|---|---|---|
| system free < 30%, **worst of 3** | `memory_pressure` | **physical RAM — cannot move.** Worst-of-3 because the reading is a quantised integer and a threshold placed *inside* its one-point spread is a coin, not a gate |
| memory under duress > 100% | `(vm.compressor_bytes_used + swap used) / hw.memsize` | **physical RAM — cannot move.** The numerator is **no longer bounded below the trip**, which is the defect attempt 3 had. **Not the same as comfortable margin:** the cap is `compressor_max + swap_total` and *still contains* `swap_total`, so the dependency on the moving bound is **reduced, not removed** — at `total` 6144 MB the practical ceiling is ~75% against a 100% trip (Atlas). The script asserts the **hard** ceiling each run and prints `UNREACHABLE` if the trip ever sits outside it |
| swap headroom < 25 GB | `df -k /` **+** `swap_total` | the **conserved** quantity. Raw `disk free` alone is *not* independent of swap — the swapfiles *are* the disk |
| compressor · swap used · swap_total · disk | — | **recorded, NOT trips** — diagnostics only |

★ **THIS TABLE IS ATTEMPT 4.** Attempt 3 shipped `swap used > 8192 MB` and **inherited the exact
defect of attempt 1**: `used` cannot exceed `total`, and `total` is `count(swapfile) × 1 GB` which
macOS **grows in response to the pressure being measured**. It was found unreachable in the live
state (`total` 6144 MB, trip 8192 MB) and, when reachable, fired only *after* the mitigation.
**Caught by a second seat, not by its author, who had written the correction for attempt 1 an hour
earlier.**

★ **THE RULE THAT COMES OUT OF FOUR ATTEMPTS: an absolute threshold is only as good as its BOUND.**
Checking the denominator is not enough — ask what **caps the numerator**. If the cap grows in
response to the pressure, the threshold measures the mitigation.

★ **Rejected, with reasons, by the lane that owns the envelope:** *swap utilisation %* — its
denominator is `count(swapfile) × 1 GB` and was measured moving a full gigabyte inside **twelve
seconds**, so two agents reading the same gate seconds apart legitimately disagree; that is not a
threshold problem and not tunable. *Pageout rate* — needs two samples, is noisy, and the lane
demonstrated the failure itself by extrapolating a slope it withdrew within a minute. **Level gates,
not rate.** *Compressor as a fourth trip* — it moves **with** free%, so it would fire when condition
one fires: **redundancy dressed as rigour.**

★★ **DEFECT FOUND AND FIXED — the third condition is now the CONSERVED SUM, not raw disk.**
`disk free` and `swap total` are one quantity with the sign flipped, because **the swapfiles ARE the
disk.** Measured over twelve seconds: the components moved 2 GB while their sum moved **0.01 GB**. A
raw-disk gate therefore **reports the swap excursion a second time instead of bounding it**, and
*"RED on two of three"* could be satisfied by one event — the mirror of a gate that cannot fire.
**The trip is now `disk_free + swap_total` — swap headroom**: the space swap already occupies plus the
space it can grow into. Immune to the excursion, moved 1–2 GB across a whole session. Raw disk is
demoted to a printed diagnostic.

★ **AND ALWAYS `df -k`, NEVER `df -h`.** `-h` rounds to whole gigabytes, so a sum of two rounded
readings carries ±1 GB — **which turned out to be the entire apparent "slow disk decline" reported
earlier that evening.** The drift was measurement rounding, not consumption, and it was found by the
lane that had reported the drift.

★★ **AND TWO LEAD RECLAIMS WERE MEASURED AND BOTH DID NOTHING.** Removing a worktree and three merged
branches moved swap 94% → 93%. Stopping the local Supabase stack and quitting the container host
moved system free **40% → 36% and swap used 6596 → 7184 MB — slightly worse**, with the gate already
GREEN before the intervention. **The envelope recovers on its own and is dominated by something other
than what a Lead reaches for first.** ★ *A reclaim that is not measured afterwards is a ritual* — and
measured, these two were.

★ **THE CONSTANTS ARE CALIBRATED, NOT DERIVED.** 30%, 100% and 25 GB are anchored to one machine on one
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

## 4b. ★★ THE SHARED SUBSTRATE — the near-miss that cost nothing only because two agents talked

**Measured: four processes are cwd'd into the same checkout, and one local database stack serves all
of them on fixed ports** (`54321`, `54322`). §1 already records that *branch state is shared* between
two actors in one working directory. **This is that hazard one layer down: the RUNTIME is shared
too.**

★ **The instance, and it was a near-miss rather than a loss.** The infra lane ran a full integration
suite in the shared tree — twice. **That suite spawns its own `supabase functions serve` against the
same local stack the development lane was taking security REDs on.** It was safe only because the
infra lane asked first and the development lane cleared the window. **Had either skipped that, both
would have gotten results they could not explain and no way to attribute them** — a green that was
someone else's serve, or a red that was someone else's teardown.

★★ **AND A GATE POISONED THIS WAY DOES NOT LOOK POISONED.** It looks like a test result. That is the
whole family this org has spent a day cataloguing — a layer reporting success while doing something
else — applied to the substrate the gates themselves run on. **One branch switch away from costing a
ship gate.**

**The rules, and they cost nothing:**
1. **CLAIM THE STACK OUT LOUD BEFORE RUNNING ANYTHING THAT BINDS ITS PORTS**, and say when you are
   done. The development lane did exactly this tonight — *"free to stop when appropriate"* — and it
   is the only reason the collision did not happen.
2. **DO NOT SWITCH THE SHARED CHECKOUT'S BRANCH.** A bare `git commit` there lands on whoever's
   branch is checked out; a branch switch yanks the tree out from under a running suite. Use your own
   worktree outside the repo tree for anything that needs a different ref.
3. **A TEST RESULT FROM THE SHARED TREE IS ONLY ATTRIBUTABLE IF YOU KNOW WHO ELSE WAS IN IT.** Quote
   the branch and the commit with the number — a baseline taken on a checkout that has since moved
   twice is not a baseline. *(An infra baseline of "69/69" was retired tonight for exactly this: the
   suite grew to 72 because the checkout moved from one branch at one commit to another.)*

★ **AND THE ENVELOPE IS MARGINAL, NOT COMFORTABLE.** With the local stack up the gate reads GREEN —
but system free has sat as close as **36% against a 35% trip**, one point from RED, while ranging
29%–64% across the session. **The stack is not what holds it there**; free% was 29% *before* the stack
came back. Read GREEN as *passing*, not as *headroom*.

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

## 6. LAUNCHABLE — the bar   *(§6 — this section. The label is here so grepping for it finds it.)*

Not "the tests pass." A stranger, on their own machine, can:
1. Install `coswarm` and authenticate without being walked through it **— blocked today: THERE IS
   NO INSTALLER.** Distribution was ruled on 2026-07-25 (operator: signed installer, source stays
   private, npm unpublished, `54795ec`) and the guard is measured — **but a ruling is not a
   deliverable and nobody built it.** `prepare`+`files` closed 1(c): install-from-git now yields a
   working binary. **1(a) is DECIDED, NOT BUILT.**
2. Create their own workspace **— blocked today: `operatorAllowed` ships as a constant `false`**
3. Invite a collaborator who accepts without a terminal ritual **— blocked today: BY ITEM 1, and
   this is the non-obvious one.** The invite path itself is sound and `coswarm accept <link>` is
   the only first-contact verb needing no `--url`. **But an invitee has no `coswarm` to run
   either** (Pitch), so the installer gates the invite path as surely as it gates the installer's
   own item. **Do not schedule 3 as independent work.**
4. Post and read signals from **both** machines **— blocked today: BY ITEM 1.** ★ An earlier version
   of this line said *"the CLI is not on the second machine at all"* and **that is FALSE** (Vane;
   re-measured 2026-07-26 **UTC** = 2026-07-25 ~21:30 local — **the launch audit dates the same
   probe by local clock; there is ONE measurement, not two**): `zsh -lc 'command -v coswarm'` on the laptop returns
   `/opt/homebrew/bin/coswarm`. **It is there — hand-installed by `npm link` into a shared
   checkout, which is exactly what a stranger cannot do.** The blocker is the missing installer,
   not absence. ★★ **Measuring this took three attempts and the first two were FALSE NEGATIVES:**
   non-login `ssh` has no homebrew on PATH (measured: 0 occurrences), and `bash -lc` is the wrong
   shell because the account is **zsh** and homebrew's PATH lives in `.zprofile`. **A positive
   control — `command -v brew` — is the only reason the third reading is trustworthy.**
5. Understand what they are looking at without reading source **— blocked today: THE REPO IS
   PRIVATE, so a stranger cannot read the README at all.** The README opening was fixed on
   2026-07-25 (`c1d1213`: thesis first line, plain-language statement above the fold, the
   invite-accept front door named, no installer claimed) — **that improves the document for
   everyone WITH access and does not move this item.** ★ It is blocked by the operator's
   distribution ruling, which is deliberate and correct; **the unblock is the installer plus a
   public surface to read, not more copy.**

**Every item is a lane. Item 5 is marketing's, and it is the one most likely to be treated as
optional.**

★★★ **RULING (Lead6, 2026-07-25): THE GATE STAYS "STRANGER." DO NOT REPHRASE IT TO "INVITED READER."**
Ledger surfaced the mismatch: this bar says *"a stranger, on their own machine"* and the product says
*"P3-1, invited dogfood."* Those are different audiences, and item 5 **could not** be scored until one
was named — **it is named here, and the question is closed.** **It is the LAUNCH bar. It measures readiness to launch, which is inherently about strangers —
rescoping it to the people already inside would score points by moving the goalposts**, which is the
exact laundering this fleet spent a day refusing.
★★ **AND THE MEASURED CONSEQUENCE IS SHARPER THAN "PRIVATE"** (Ledger, verified here unauthenticated):
```
  github.com/Ridge-io/cloud-swarm            HTTP 404
  raw.githubusercontent.com/.../README.md    HTTP 404      <- not 403
```
**A stranger does not get "you may not read this." They get "this does not exist."** The product is not
unreadable to the public; **it is INDISTINGUISHABLE FROM NONEXISTENT** — the night's zero-versus-absent
confusion, in the one place it reaches a user.
★★★ **BUT "BLOCKED" MUST NOT BECOME "DEFERRED." THE COMPREHENSION WORK IS REAL AND IS NOT GATED ON
GOING PUBLIC.** Ferry's cold read — *"I am cold on the README and not cold on the product,"* which is
exactly an invited dogfooder — named three blockers that hit **a reader who can already clone the repo**:
```
  1. intentions / signals / tasks — three nouns, no stated relationship
  2. "reducer-complete authority core" in the what-is-built section
  3. eighteen commands, not one showing its output
```
**These help the people running the code TONIGHT.** They do not move the bar and **they are not to be
scheduled against it** — track them as product work, not as bar work. **The bar staying at 0 is not a
reason to leave them.** (`LICENSE` was the fourth and landed at `ae1cb74`.)



★★★ **AND THE PRECISE VERSION OF WHY A DAY OF REAL WORK CAN LEAVE THIS AT 0 OF 5** (Vane's
observation, Atlas's guard, corrected once more here). **It is NOT "nothing shipped":** ships 3, 5
and 6 plus the publish guard landed across 13 product files and closed C0, C11, C12, C1 and item
1(c) — real, verified changes. **The true statement is narrower and worse: NOT ONE OF THEM CAN
MOVE A §6 CRITERION, because items 1-4 all require an installer that nobody built, and item 5
requires a stranger who can see the repo.** ★ **A seat reading "moved the bar zero" alone would
conclude the day was wasted. It was not, and this bar does not claim it was** — the bar measures
one thing, and a fleet can do ten hours of correct work that is orthogonal to it.
