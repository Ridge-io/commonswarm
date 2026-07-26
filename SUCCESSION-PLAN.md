# cloud-swarm — Lead succession & build plan

**Read this first if you are a new Lead.** This is the durable baton-pass for the
cloud-swarm build. It is version-controlled so every Lead updates it before
rotating out. If you are picking this up, you are the current Lead — adopt the
succession protocol below for yourself.

---

## 0. The succession protocol (do this for yourself too)

The operator's standing rule: **when your context reaches ~60% utilization or
more, rotate out.** To rotate:

1. Get the current phase to a **clean, committed, green checkpoint** (never hand
   off mid-file or on red tests).
2. **Update this file** — status, what's done, what's next, any in-flight work
   (background reviews, dispatched agents) with how to collect their results.
3. Commit it. Then spawn / designate a **fresh Lead** and point it at this file,
   or tell the operator you've hit the rotation point and P<n> is a clean
   checkpoint for the next Lead to resume from.
4. The successor Lead **inherits this same protocol.**

Rotate at a **phase boundary** whenever possible — it's the cleanest resume point.

**New Lead, first actions (do these before picking up the phase):**
1. **Enable remote connection** — run **`/remote-control`** so the operator can
   supervise and drive this long-running autonomous build remotely (operator
   directive). Confirm it's active.
2. Read this whole file + `docs/design/SWARM-CLOUD.md` §0 (ethos) and the current
   phase's spec section.
3. Check for in-flight background workers (see §4 status) and collect their results
   before starting new work.
4. Re-read §1 — **you orchestrate, you do not hand-code.**

---

## 0c. WORKER ROTATION HYGIENE (operator directive, 2026-07-24)

The §0 rotation rule applies to **workers too, not just the Lead.** Watch each long-lived
worker's context window and **compaction-cycle count**, and rotate it out for a fresh agent
before it degrades.

**Why it matters:** every compaction loses fidelity, and a worker can look perfectly healthy —
reporting precisely, catching real spec bugs — while its early context is heavily summarized.
The failure mode is handing the *most detail-dense* work to the *most degraded* context.

**Measure, do not guess.** For a Codex worker the transcript is
`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` (the swarm task record prints the sessions
dir). Find the live one by grepping for the current task slug, then check size, line count, and
`grep -ci compacted`.

**Observed datum:** Mason was rotated at **14 compactions / 11 MB / 5,416 events / ~24 h
continuous** — while still performing well. Treat roughly **≥10 compactions or ≥12 h
continuous** as due.

**Rotate at a task boundary, or at the very start of a slice.** Cost is near-zero before
implementation begins and climbs steeply once the worker is mid-file.

**Capture the outgoing worker's non-obvious knowledge first** — architectural seam analysis,
traps found while mapping the code — as a durable on-disk handoff note for its successor, then
stand it down. Do not discard mapping work merely because the agent is rotating. Frame it to the
worker as hygiene, not judgement, and record what it contributed.

## 0i. ROTATION 2026-07-25 ~22:15 (Lead6 -> Lead7). READ THIS FIRST — §0h IS SUPERSEDED.

★ **§0h was written at 08:40 and is a photograph of a program that no longer exists.** Read this
instead; §0h below is history. **Re-derive `origin/main` yourself and gate the fetch** — `git fetch
origin && git rev-parse origin/main`. A failed fetch still lets rev-parse answer (§0e.10a).

### ★ DELTA SINCE §0i WAS WRITTEN — read this before the rest, it is two hours newer

**`origin/main` has moved past the SHA in this section several times. Fetch.**

### ★★★ WHAT EXISTS NOW — READ THIS BEFORE YOU BUILD ANYTHING, IT IS ALL NEW TODAY

**Four executable checks landed 2026-07-25. None existed this morning. Each states in its OWN OUTPUT
what it does NOT answer, because that is where every caveat went missing.** Run them; **do not quote
their output into a message** — see face 19.
```
  scripts/envelope-check.sh   before spawning. Is each trip INSIDE its metric's attainable range?
                              Prints UNREACHABLE instead of GREEN when not. NOT: is the metric right.
  scripts/probe-check.sh      before trusting a probe. Can its positive control produce a hit?
                              exit 2 VACUOUS is distinct from exit 1 CLEAN. NOT: did it hit the
                              right object. Header carries the `ls -lO` SIP tell.
  scripts/path-check.sh       before trusting a shimmed measurement. Was the instrument actually in
                              the subject's PATH? NOT: does shimming it cover everything you varied.
  scripts/branch-audit.sh     before pruning or landing a branch. Four questions, four instruments,
                              and it MARKS WHICH ANSWERS DECAY (per-commit STABLE vs tip-relative).
```
★ **PRUNE and LAND are different questions and the tool answers both separately.** `0 unabsorbed` =
debris that reads like an open item · `N unabsorbed` = a record that reads like debris.

★★★ **AND READ THIS BEFORE YOU REACH FOR THE SCRIPTS ABOVE — IT IS ATLAS'S, IT IS AGAINST THE
INTEREST OF EVERYTHING IN THIS SECTION, AND IT IS TRUE: EVERY DEFENCE THAT WORKED ON 2026-07-25
CHANGED *WHAT WAS LOOKED AT*, NOT *HOW HARD*.**
```
  removing 2>/dev/null                 caught 5 separate false results, across 3 seats
  reading the artifact, not the render  caught the vacuous grep, the stale dist, the wrong branch
  querying the store for what recipients HOLD, not what you composed   caught a lost payload
  braced ${B}:path                      caught a silent wrong-object read
  grep docs/ BEFORE investigating       would have saved an hour on the last question of the day
```
**Not one is a rule anyone has to remember at 3am, and between them they caught MORE THAN THE FOUR
SCRIPTS DID.**
★★ **THE LAST ONE IS THE CHEAPEST AND IT WAS LEARNED THE HARD WAY AT THE END OF THE DAY.** Four seats
spent an hour on the cmux banner question. **The fact that closed it was already on `main`, greppable,
in `docs/swarm-cli/2026-07-25-silent-message-drop.md:21`:** *"`getInbox()` calls `ensureDeliveryRows`
on every read — reading CREATES the row."* That single line retires the delivery-row evidence the whole
investigation rested on. **It was written that morning, by a participant in the discussion, corrected
three times, and landed on `main` — and nobody grepped it.** ★ Sable's *"survive is not the same as be
found"* was about a directory nothing pointed at; **this is worse and cheaper to fix — a tracked file,
on `main`, one `git grep` away, unread by the people who wrote it.** **BEFORE MEASURING A SUBSYSTEM,
GREP `docs/` FOR ITS NAME.** The scripts are worth having and they close specific, named, recurring failures — **but
the cheap habit that changes the object beat the expensive mechanism that checks the reasoning, every
time it was tried.** ★ **Effort applied to the wrong axis is confidence with no coverage** (Atlas, who
hardened one control three times without ever leaving the defect). **If you are choosing between
building a check and changing what you look at, change what you look at.**

**★★★ AND THERE IS A DIRECTORY OF HANDOFFS AND OPEN LEADS THAT NO FILE IN THIS REPO POINTS AT:**
```
  ~/.swarm/notes/     14 entries, machine-local, OUTSIDE every repo and every git history
```
**`git grep -i 'swarm/notes'` on `main` returned ZERO before this line existed.** It holds lane handoffs
(`pitch-marketing-lane-handoff.md`, `ledger-handoff.md`, `foreman-*`), probe receipts, and **at least one
LIVE OPEN LEAD** — `swarm-banner-vs-store-one-open-half.md`, the swarm-CLI notification question, which
has **three seats' data, ten samples, one unexplained outlier, and NOBODY HAS READ THE CLI SOURCE**
(30 files, one repo over, at `Ridge.io/swarm`). Deliberately parked, not abandoned.
★ **SURVIVE IS NOT THE SAME AS BE FOUND** (Sable). These files persist perfectly and were invisible to
anyone who did not already know the path — **the same defect this section was written to fix, missed in
this section, by the seat that wrote it, an hour after fixing it for the tools and branches.** ★ **It is
machine-local: it does NOT rsync with the repo and does NOT exist on the other two machines.**

**SURVIVING BRANCHES — resolve these by NAME, never by a SHA quoted anywhere (they moved constantly):**
```
  origin/ferry/r1-go-runbook   R1 runbook, findings, and the persona-surface env capture.
                               ONLY COPY. Cherry-pick the uxtest/findings files; NEVER squash;
                               DO NOT PRUNE. Reader hazard, known: its own findings cite tools that
                               do not exist in that tree — read them from main.
  origin/vane/launch-audit     The launchable audit and §6 scoring, with item 1(a)'s closure and
                               its attribution. ONLY COPY. Cherry-pick or merge; NEVER squash;
                               DO NOT PRUNE. Vane's condition: RE-RUN THE AUDIT AT LAND TIME —
                               it was not re-run before this handoff, so do not land it as verified.
```
★ **Both are pushed, so both are durable. Neither is on `main` and neither is debris.** `branch-audit.sh`
will tell you their current state; **this paragraph will not, and is not trying to.**

### ★★ LAST DELTA BEFORE ROTATION

**-1. ★★★ THE `private: true` PUBLISH GUARD IS VERIFIED AND GREEN — CLOSED, NOT OPEN.** An earlier
version of this entry said UNVERIFIED and sent the reader to verdaccio plus a real `adduser`.
**That was wrong and it over-costed the task.** Closed by Quill (authenticated localhost pair) and
independently by Atlas (dummy token); re-derived here before this edit.
```
  ARM A  private:true + ANY token  ->  EPRIVATE · "This package has been marked as private" · rc=1
  ARM B  identical, no private     ->  no EPRIVATE; proceeds to the NETWORK and retries
```
**The guard fires AFTER packing and BEFORE any network I/O — a client-side, fail-closed mechanism**,
which is exactly the property the operator ruling needs. Arm B's network attempt IS arm A's control:
with the flag npm stops locally, without it npm leaves the machine.

★★★ **THE ONE STEP THAT MAKES IT WORK, AND IT IS WHY THREE EARLIER ATTEMPTS FAILED: AUTH IS NOT
*CHECKED* BEFORE `private` — IT IS *RESOLVED* BEFORE IT, AND RESOLUTION IS SATISFIABLE LOCALLY.**
A **fake** token in `.npmrc` is sufficient; the registry never has to exist or be reachable.
```
  no token   ->  ENEEDAUTH, guard never reached   ← the trap: reads as if the guard fired
  any token  ->  the guard discriminates
```
**Neither verdaccio nor a real account is needed.** ★ **DO NOT** settle it against the public registry.

★ **THE HISTORY IS WORTH KEEPING BECAUSE THE TRAP IS STILL LIVE FOR ANYONE WHO IMPROVISES:** four
attempts across three seats were vacuous first — two `--dry-run`s that ignore the flag entirely, and
two unauthenticated publishes that stop before reaching it. **And a discriminator that lied:** diffing
the two arms reported DIFFER on `57B` vs `42B package.json` — **the tarball is bigger because the word
`private` is in the file. The input differed, not the behaviour.**

### ★★ EARLIER DELTA — newest first, these are hours newer than the numbered list below

**0. ★★★ READ THIS BEFORE YOU SCOPE THE ISOLATION FIX. IT IS NOT THE JOB THE REST OF THIS DOCUMENT
DESCRIBES.** Everything below calls the blocker an *isolation LEAK* and assumes the persona's `coswarm`
resolves through a symlink into the live repo because **homebrew wins a PATH race**. **Ferry identified
the persona surfaces positively — by `CMUX_AGENT_LAUNCH_CWD`, not by guessing which of five they were —
and measured their actual environment:**
```
persona surfaces (pids identified):  /opt/homebrew/bin  PRESENT
                                     CLAUDE_CONFIG_DIR  ABSENT
                                     UXTEST_*           ABSENT
                                     persona bin in PATH  ABSENT ENTIRELY
                                     `uxtest` appears ONLY as PWD and CMUX_AGENT_LAUNCH_CWD
```
★★★ **THERE IS NO RACE. The persona has a working directory and nothing else.** Everything except cwd
is inherited from the cmux app — §7.2.2 channel 2, confirmed by direct observation rather than inferred
from symptoms. **So the blocker is "isolation was NEVER APPLIED", not "isolation leaks".**
  - **A day spent making the persona's `bin` win a PATH race would have been a day aimed at a race that
    does not exist.** The one-day estimate in §0i predates this and should be re-derived, not inherited.
  - **The finding was nearly lost.** It lived in two copies that both expired the same night — live
    processes, and a session scratchpad that dies with Ferry's seat — and **the seat ending was the more
    likely of the two.** A second copy that expires sooner than the first is not redundancy. Landed to
    `uxtest/findings/` on `ferry/r1-go-runbook` under explicit Lead authorisation.
  - ★ **HOW IT WAS FOUND, because six prior attempts failed and the seventh did not, and it was not
    effort:** Pitch supplied a control for *"is there any env here at all"* — **one level beneath the
    level Ferry was controlling at.** Ferry's control tested its PARSER; Pitch's tested its ACCESS.
    **From inside, every failure looked like a parsing failure, and three of them agreed with each
    other.** Ferry's own defect 7 was the cause of three: a `grep -E "^(PATH|CLAUDE_CONFIG_DIR|UXTEST_)"`
    filter dropped the PATH continuation fragment containing `/opt/homebrew/bin`, **and Ferry then
    searched the filtered file for homebrew.** ★★ **A FILTER APPLIED BEFORE A SEARCH IS A HYPOTHESIS YOU
    CAN NO LONGER FALSIFY — and it leaves no trace, because the pipeline succeeds.**

**A. THE MACHINE'S `coswarm` SERVES A BUILD THAT CORRESPONDS TO NO REF. Measured:**
`src/cloud/config.ts` carries the ship-3 string (**1 occurrence**); `dist/cli.js`, which is what bare
`coswarm` executes, carries **0**. `/opt/homebrew/lib/node_modules/cloud-swarm` is a **symlink into the
live shared checkout**, and that checkout sits on `quill/cli-first-errors`, which **does not contain
`origin/main`**. So bare `coswarm` is not main and not Quill's branch — **it is a stale `dist` matching
neither.** The complete mechanism: `dist/` is gitignored → no ref carries a built artifact; no `prepare`
script → `npm install`/`npm link` never build; the global link points at a working tree → the binary
tracks whoever last checked out. **Nothing announces the drift.** No error, no conflict, no diff.
  - ★★ **THIS GATES DOGFOOD VALIDITY. USE THE TREE GREP — THE OBVIOUS ONE-FILE VERSION IS VACUOUS:**
    ```
    grep -rl "use the Supabase project base URL" "$(dirname "$(readlink -f "$(which coswarm)")")/"
    ```
    **A path printed = the fix is in the binary. Empty = stale.**
    ★ **DO NOT grep `dist/cli.js` — `build` is plain `tsc`, not a bundler**, so `src/cloud/config.ts`
    compiles to `dist/cloud/config.js` and is **never inlined into `cli.js`.** A `grep -c` on `cli.js`
    returns **0 for a current build and 0 for a stale one** — measured against both. **Lead6 broadcast
    exactly that vacuous form, five agents ran it, and every reported 0 was manufactured by the
    instrument.** The conclusion happened to be right, which is why nobody caught it: **a wrong probe
    that agrees with the truth is invisible to anyone checking the truth.** See §3 face 15.
    This is also R1's persona-isolation problem in a second costume: the validity blocker is not in the
    test, it is in **what the test was pointed at.**
  - **Part 1 (Vane, Sable reviews):** add `"prepare": "npm run build"` and `"files": ["dist"]`. This is
    the *mechanism*; "remember to rebuild" is the *rule*, and the rule lost tonight with four agents
    watching. **It does not fix a `git checkout` moving a tree under an existing link — nothing in npm
    does.** Do not let it be reported as closing the class.
  - **Part 2 (Lead7, with the isolation fix):** unlink the global `coswarm` from the shared tree. Machine
    state, touches what Dana tests against, **not a 6pm change under a rotating Lead.**

**B. THE ENVELOPE GATE IS ON ITS FOURTH VERSION AND IS NOW TRACKED.** `scripts/envelope-check.sh` and
`docs/perf/2026-07-25-infra-baseline.md` landed at `c216050` — both were in a gitignored scratchpad,
**invisible to every successor and both other machines.** An artifact one seat can see is testimony, not
evidence. **Verified by running it, not by reading it.** Version history is the lesson: v1 could not fire
(absolute 12 GB against a dynamic swap total) · v2 had a moving denominator (swapfile count on a shared
disk) · v3 flapped RED→GREEN in **eight seconds with nothing freed** · v4 is worst-of-3 with the trip at
30%. **Swap used has since moved 5122 → 7052 MB against an 8192 trip — the condition closest to firing.**

**C. WORKTREE-PER-AGENT IS CONFIRMED BY FOUR INDEPENDENT LIVE INSTANCES, NOT BY ARGUMENT.** Atlas wrote a
brief into the shared tree while the branch moved under it; Ferry nearly committed to Quill's branch and
**was saved only by running `git branch --show-current` for an unrelated reason**; Pitch read `src/cli.ts`
with plain `sed`/`grep` before a 17:56 switch and **got away with it by timing rather than by method**;
Vane found the binary problem in A. **Cost: ~12 MB bare, but Ledger's correction is the one to carry —
a worktree costs 12 MB *plus that repo's `node_modules`*, so ~65 MB here and 0.73 GB in PromptEden next
door.** A successor applying "12 MB" to a heavy repo under-budgets by two orders of magnitude.
  - ★ **Pitch's addition, which widens the hazard:** it is not only *committing*. **It is reading.** A rule
    phrased around commits never fires for an agent that only reads, and **a read from a shared tree is a
    read with no timestamp on it** — no conflict, no error, no trace. Read-side fix: `git show <ref>:<path>`
    instead of opening the file. Same shape as "grep for the defect, not the fix" — **name the object
    instead of trusting the ambient one.**

**1. THE CHARTER'S RESOURCE GATE WAS VACUOUS AND IS FIXED.** It said *reclaim if swap used > 12 GB.*
**macOS resizes swap dynamically** — 15.4 → 8.2 → 9.2 GB total measured within one hour — so an
absolute threshold against a moving denominator **cannot fire**. Replaced with a ratio plus a pressure
reading. **Both are RED as of writing: 86% swap utilisation, 30% system free.** The machine is at the
edge of its envelope with ten resident seats. **Reclaim before spawning anything.**

**2. SHIP 3 IS MID-BUILD and its contract lives in messages, not in a file.** Scope: *"strings that
fail to say what is now true"* — deliberately widened from *"misleading first-contact errors"* by
definition rather than by exception. Three items: **C11** (four verbs, one dead end, `--url is
required`, never says a URL of what or where) · **C12** (`working-on` with no argument reports
*"unexpected positional argument"*; `assertShape` at `cli.ts:181` throws one string for both
directions) · **C0** (the *"immutable, tenancy-scoped"* sentence ships only to `--json`).
  ★ **C0's pinned shape, which took four corrections to reach:**
  - **Prose carries past+present; the ROW carries future.** F1/F2 already renders `expires in 30d`,
    so prose restating the horizon is duplication, not emphasis.
  - ★ **A directed signal is NOT workspace-visible.** `README:155`. **Verified live by the Lead: the
    post response populates `to`** — directed returns a uuid, broadcast returns `null` — so
    `signal.to === null` branches with no new lookup. **"Only visible to this workspace" would have
    shipped FALSE inside a fix for false strings.**
  - Gates: **G-C0-JSON `--json` byte-identical** (agents poll it) · **G-C0-NO-DUP** (do not restate
    the horizon) · **G-C0-DIRECTED** (a directed post must not claim workspace-wide visibility).
  - **C4 is queued, NOT in this ship** — the human post path reuses the feed renderer *including its
    header*, so posting one signal answers *"Recent signals:"*. One string, same call site,
    deliberately held: widening twice on "it's cheap" is how a tight ship stops being tight.

**3. THE SHIP QUEUE, RE-ORDERED TWICE AND NOW CORRECT:**
  1. **Silent message drop** — `docs/swarm-cli/…`. RED fails today.
  2. **Hook-gate** — an agent mid-turn is unreachable, queue unbounded. **And the mitigation does not
     exist: `--now`/`--interject` is a documented no-op on Claude and Codex — 1 seat of 10.**
  3. **C4**, then **edge/DB region split** (`us-east-2` functions, `us-east-1` database, ~68ms per
     round trip over ~13 sequential statements — **config, not code, and a Lead deploy call. Do not
     rewrite the transaction until placement is fixed and re-measured**).
  ★ **"Routing" was dropped entirely** — `to_agent` is the recipient column and cannot express a hop.
  ★ **"Transport latency" was dropped entirely** — it was a recipient turn boundary, and a RED for it
    could not fail.

**4. `message_deliveries` MEANS "A RECIPIENT READ THE STORE."** Not agent class, not an era. `getInbox`
calls `ensureDeliveryRows` on every read; `agent_type` appears **zero** times in the writer; a2a seats
are pushed over HTTP and never poll. Confirmed in **source and in the built artifact**. **Absence of a
row says nothing about delivery** — three wrong explanations preceded this one and they are all
recorded in the doc, because the progression is the lesson: *the first two were built from counts and
the third from the writer.*

**5. THE `swarm update available` BANNER HAS AN UNKNOWN REFERENT.** That repo has **no `origin`** —
remote is `fork`, `origin/main` is an unknown revision, the branch **tracks nothing**. *"Behind
origin/main"* is not a question it can answer. Two agents independently inferred a comparison the repo
cannot perform; the Lead treated it as background noise all day. **Do not cite it as staleness
evidence.**

**6. LEAD PROBE RESIDUE, DISCLOSED:** four signals in the Dogfood Workspace
(`g5:…`, `c0:scope:probe`, `c0:json:probe`, `c0:directed:probe`, `c0:broadcast:probe`). **Immutable by
design; they cannot be deleted and will expire on their horizons.** Flagged rather than left to be
found — the rule the Lead failed on the cmux surfaces.

### THE ORG NOW EXISTS — read `docs/org/CHARTER.md` before anything else
Operator directive: a standing organisation driving coswarm to launchable continuously, hunting
defects and debt of every kind, **with the Lead as sole production-deploy authority and an
instruction to ship frequently.**

**Resident core:** Sable `[grok]` architecture + adversarial review · Quill `[codex]` development ·
Ferry uxtest/QA · Atlas research · **Vane** product & launch · **Pitch** marketing & narrative ·
**Ledger** infra, cost & performance · Dana `[laptop]` cross-device · Anvil `[a2a]` provisioning
(**registry entry misrouted — fix before use**).

★ **The org is a SMALL RESIDENT CORE PLUS EPHEMERAL FAN-OUT, and that is the constraint speaking, not
a preference.** One 16 GB machine. It was at **14.2 GB swap of 15.4, 0.02 GB free** when the org was
authorised; reclaiming a local Supabase stack nothing was using and ten stale language-server sets
took it to 4.7 GB, and that reclaim is the only reason three lanes exist. **Check swap before
spawning. Never spawn into pressure.** Workflow subagents cost tokens and vanish; residency costs a
tab forever.

### WHAT SHIPPED (three ships, each Lead-verified before landing)
1. **`Ridgeio/swarm` `ef91f8f`** — bounded the unbounded `which` probe that cost a full day. I built
   my own self-exec'ing shim: pre-fix hung indefinitely, post-fix fails loudly in 5s. **Verified on
   the deployed artifact, not the commit** — the fleet that found the bug now runs the fix.
2. **F1/F2 `71bcad6`** — the signal feed shows name, id, you-marker, relative age and horizon;
   `--json` byte-identical, verified against live hosted.
3. **Pre-auth audit amplification `ae4924f`** — unauthenticated requests could drive unbounded writes
   into an append-only authority table, through **four** paths, and the rate limiter could gate none
   of them because it keys on the identified principal.

### ★ WHAT IS BLOCKED, AND IT IS NOT CODE
**LAUNCHABLE IS 0 OF 5** and item 1 fails at the first command — **measured, not argued**: a fresh
clone at `75dc05e`, the README's exact steps, both commands exit 0, and then **no `coswarm` anywhere
on PATH.** It resolves on this machine only via a global npm link the README never mentions. The repo
is also **private** and `npm view` 404s both names. **A stranger cannot obtain the artifact by any
route.** Items 2-5 sit downstream of it.

**R1 CANNOT PRODUCE A SCORED ROUND.** Three validity blockers in
`uxtest/findings/2026-07-25-r1-validity-blockers.md`; the isolation one is designed and costed at a
day (`…-persona-isolation-recommendation.md`) and its acceptance criterion is the best line in it:
**build the gate first, run it against today's unconfined setup, and require it to go RED
immediately.**

### ★★ WHAT I GOT WRONG — READ THIS PART, IT IS THE MOST USEFUL THING HERE
**I published FOUR wrong mechanisms in one evening. Every disproof was one command away from me.**
`"the transport is slow"` (a 3.7s row in my own query output) · `"a single relay hop"` (`.schema
messages` — no such column) · `"no specific message failed"` · `"delivery rows are an a2a artifact"`
(the same agent has 4-of-4 in one swarm and 0-of-3 in another). That is now **§0e.14**, filed as a
fleet property because *a rule filed as one person's failing does not fire for anyone else.*

★ **AND THE SHARPER, MORE SPECIFIC ONE: I WAS THE LOSSY HOP BETWEEN CAREFUL FINDINGS AND THE FLEET.**
Vane filed batching as *"MEASURED / readability UNKNOWN"* and offered to withdraw — I republished it
as an unbounded mechanism. Atlas filed a relay claim with *"I cannot tell, and I have not tried"* — I
republished it as *"verified."* **Both originals carried correct caveats. Neither survived being
quoted by me, and my confidence replaced them.** The word "verified" is why nobody downstream
re-checked it. **Do not write "verified" over a claim when what you verified was the counts
underneath it.**

★ **AND I SAT ON A LANE'S WORK FOR AN HOUR.** Pitch's second-pass marketing report — 5,247 characters,
the launchable-blocker proof — went unread while I answered the message directly above it four times.
The first-pass report I saw only as a 2 KB preview and treated as complete. **Long reports arrive
truncated in the hook context; read the body from `~/.swarm/swarm.db` before ruling on it.**

### WHERE TO READ, AND WHAT NOT TO TRUST
★ **THE SWARM LOG IS NOT A FAITHFUL RECORD OF WHO CONTRIBUTED WHAT.** All 1,724 of Dana's messages
address one seat, so nobody else's inbox ever contained one. A successor reconstructing today from
`swarm inbox --recent` sees Ferry and Lead6 *quoting* Dana and never sees Dana — under-representing
the agent behind the Anvil routing finding, the trust measurement, and its own retracted A/B.
**Ferry's `origin/ferry/r1-go-runbook` is the faithful uxtest artifact. The message log is not.**

★ **`--now` / `--interject` IS A DOCUMENTED NO-OP ON CLAUDE AND CODEX** — 1 seat of 10 honours it. I
used it all day for urgent messages believing it did something. There is no urgent path for most of
this fleet.

### THE SHIP QUEUE
1. **Silent message drop** (`docs/swarm-cli/…-silent-message-drop.md`) — after 20:39:54, fifteen
   consecutive failures, zero successes; `delivered` conflates *stored* with *received*. **RED fails
   today.**
2. **Hook-gate** (Vane) — an agent mid-turn is unreachable and its queue is unbounded; *the harder an
   agent works, the later it hears.* RED: send mid-turn, assert visibility before the next prompt.
3. **C11/C12 CLI copy** (Pitch, ship 3, in flight) — four intents, one dead end; and
   `working-on` with no argument reports *"unexpected positional argument."*
4. **Edge/DB region split** (`docs/perf/…`) — functions in `us-east-2`, database in `us-east-1`,
   ~68ms per round trip across ~13 sequential statements. **Config, not code, and it is the Lead's
   deploy call. Do not rewrite the transaction until placement is fixed and re-measured.**

### ★ THE ONE THING I WOULD KEEP
**Six agents corrected me on substance today and four corrected themselves unprompted, most within
their first two tasks.** Pitch caught me twice and then made the same error itself, on the same table,
twenty minutes later, and said so. Vane found a symlink I had committed. Atlas tried to absorb a
retraction that was half mine. Ledger read a schema instead of accepting my summary.

**None of it cost more than ninety seconds to find.** Ask for that explicitly, on day one, before
anyone has earned it — and then visibly take it. **A fleet learns what you reward within one
exchange.**

## 0h. ROTATION 2026-07-25 ~08:40 (Lead6 -> Lead7). Read this after §0i — superseded.

**Everything below §0h is still true and still yours; read §0g next, then §0e.** This baton is
short on purpose. §0g and §0e already carry the practice; this carries only what changed in one
morning and what is waiting for you.

### ★ RE-DERIVE THE STATE, AND KNOW THAT RE-DERIVING IS NOT ENOUGH
`git fetch && git rev-parse origin/main`. **Fetch first.** §0g told the successor to re-derive and
the successor did — and was stale **twice in twenty minutes**, because `rev-parse` answers what the
local ref cache believes. Both times a worker had fetched and was right while the Lead was wrong.
See §3, *a cached artifact is testimony with a timestamp*. When this was written `origin/main` was
`b58fec6`; **that number is already a photograph.**

### WHAT MOVED UNDER LEAD6
- **★ P3-1 PHASE M IS DEPLOYED TO HOSTED AND VERIFIED.** Migration `20260724000003_signals`
  recorded (local=remote), `read` v1 and `command` v6 ACTIVE, `verify_jwt=false` on both. The anon
  probe on `swarm_read.signals` flipped `404/PGRST205` → `401/42501`, re-run independently by the
  Lead with a live negative control (a nonexistent view still returns 404, proving the instrument
  separates *absent* from *denied*). Artifacts: `/tmp/quill-p3m-20260725-JORNap`.
- **★★ THE CLAIM IS NARROWER THAN IT SOUNDS AND YOU MUST NOT WIDEN IT.** Proven: **the view exists
  and anon is denied.** NOT proven: **that `authenticated` can read it.** The `42501` fires at the
  **schema** level, before any per-view grant is consulted, so *granted-to-authenticated* and
  *granted-to-nobody* are the same response to an anon caller. The Lead broadcast the wider version
  and Lead5 caught it. **G5 is the gate that settles it. Do not say "P3-1 is live on hosted."**
- **`operatorAllowed` is `() => false` in production** (`command/index.ts:1634`), unconditional,
  actor ignored. **No identity can create a workspace on hosted today.** Contract for the fix is
  pinned (Option A, below); no code written.
- **§5.2 of `docs/research/ACP-AND-BUZZ.md` is OVERTURNED** — the subscription-auth barrier is
  **configuration, not policy**: `shouldHideClaudeAuth()` gates the throw and Buzz passes no such
  flag. Technical barrier gone; **licensing question open and unsettleable from source.** Atlas has
  the replacement text; **`db62856`'s "API-key BY POLICY" claim is wrong as recorded and still
  needs correcting.** This is a live change to §1c's differentiator and it is the operator's call.
- **§3 gained four faces + the cite-by-name rule** (this commit's parent).

### ★ WHAT IS WAITING, AND ON WHOM
1. **PHASE G — G5 post-then-read, and G10 if reachable. WAITS ON THE OPERATOR** to log in; G5 needs
   a real human identity and the dogfood immediately follows. This is not friction being offloaded:
   **§1c exists because the operator drove something and told us it was confusing.** Two load-bearing
   instructions for whoever runs it: (a) **rebuild/install `coswarm` from `origin/main` FIRST** — the
   PATH binary's dist mtime is `01:25` against a `01:36` land and may be a pre-squash partial, and
   the danger is diagnosing a stale local binary as a hosted failure; (b) **★ READ THE HTTP STATUS
   BEFORE THE ROW COUNT** — an empty array from a 200 and an empty array from a swallowed 401 are
   the same JSON, and if the `authenticated` GRANT is wrong this fails looking like *no signals*
   rather than *permission denied*, which is exactly the costume that hid the last GRANT bug.
2. **★★ uxtest R1 — THE TRUST IS *MEASURED ABSENT*, AND THE AGENT SENT TO GRANT IT WAS NEVER
   REACHED.** Two findings from Dana, both verified independently by the Lead before landing:
   **(a) ANVIL'S REGISTRY ENTRY IS MISROUTED.** `swarm members` lists Anvil at
   `http://127.0.0.1:18790/`, and that endpoint serves an agent card named **`Yulan`**. Control:
   `:18792` serves `UxDriver`, so the probe discriminates. **Every message dispatched to Anvil for
   three hours landed in another agent's inbox. Anvil never received the trust task** — it was not
   silent, it was unreachable, and *those look identical from the sender's side*.
   **★ THE FACE: A CARD THAT RESOLVES IS NOT PROOF IT RESOLVES TO WHO YOU MEANT.** Same family as
   *an endpoint that answers is not an endpoint that delivers*, one turn further out — the endpoint
   answered, delivered, and was **the wrong recipient**. §1.2's failure mode caught in the field for
   the second time in two days.
   **(b) THE TRUST KEY IS ABSENT, not merely unconfirmed.** Dana read the mini's config back:
   47 project entries, **no entry** for `/Users/yulanbot/uxtest/human1/workspace`,
   `hasTrustDialogAccepted` **KEY ABSENT**, and the workspace itself `entry_count=0`. That converts
   *"Anvil never reported"* — a state nobody could act on — into a value.
   **★ AND THE PRISTINE BASELINE IS AN OPPORTUNITY, per Dana:** because the persona dir is currently
   **empty**, no before/after diff is needed. After whoever grants the trust, **one command decides
   whether the session method is clean**: `ls -A /Users/yulanbot/uxtest/human1/workspace`. Empty
   proves the dialog-acceptance method leaves no residue and is worth recording permanently, since
   §7.9b prefers it over a config write. Non-empty means sweep before gate 5 —
   `_lib.sh:110-116 assert_round_brief_only` requires **exactly one** entry and
   `launch-human1.sh:28` writes `BRIEF.md` there later.
   **★ DANA DECLINED TO GRANT IT, CORRECTLY, AND THE REASONING SHOULD BE HONOURED:** it could do it
   in seconds and holds the exact procedure, but the operator's loosening was scoped to **Dana, on
   the laptop**, and the mini is a different machine and user. OPEN OPERATOR ASK 1 —
   *agent-scoped vs target-scoped* — **is still unresolved**, and acting would have been Dana
   deciding its own scope. **The measurement was Dana's to make; the write is not.** If it is ever
   done by config write rather than dialog, **back up first and add only the new key** — that was
   the operator's own condition and it travels with the action, not with the agent.
   (Superseded text, kept for provenance:) Anvil was dispatched to grant
   the mini trust (`/Users/yulanbot/uxtest/human1/workspace`, real dialog acceptance, **never** a
   programmatic `hasTrustDialogAccepted` write — §7.9b stands); **no report received before rotation
   — verify it yourself.** Even if it cleared, **do not run gate 5**: the runbook has failed two
   adversarial passes and **failed a third**. See the next section — T1 and T2 are open, and the
   verbatim-execution transcript that is now the acceptance gate does not exist yet.
3. **`create_workspace`** — contract pinned, brief unwritten. Nothing blocked but a brief.
4. **Atlas's remaining research**, all held: two desk-checkable ACP items, plus Lead5's question —
   *does the Agent SDK policy statement still exist unchanged in the vendor docs?* If yes,
   "configuration not policy" describes the **mechanism** and not the **permission**, and both are
   true at once.

### ★★ THE R1 RUNBOOK IS THE MOST INSTRUCTIVE ARTIFACT IN THE PROGRAM RIGHT NOW
`uxtest/findings/R1-GO-RUNBOOK.md`, branch `ferry/r1-go-runbook`, **local only, unpushed.**
**Three review passes, EACH of which found defects of the class the previous revision was
fixing.** The third is what turns the pattern from a coincidence into **a property of this
document**, and it is the reason the acceptance gate changed (§3, *a copy of a command is not the
command*):
- Pass 1 killed the discriminator the **Lead** had called load-bearing: `spawn-state/` carries the
  round number in the **filename**, `reset-round.sh` never removes the directory, and the reviewer
  **SSHed to the laptop** and found it already exists and is already empty. *Missing = never-started*
  was unreachable; *empty = killed mid-flight* was already true before the event.
- Pass 1 also found §5 **impossible and data-destroying** — it said write `REPORT.md` after running
  the collector, but `collect-round.mjs:462` writes that file and `collect-round.sh:46-47` dies if
  it is missing.
- Pass 2 found the **fix** reintroduced the same shape: the new probe prints identical bytes whether
  the file is absent or the laptop is unreachable (proven by running it against an unreachable host),
  and `observed:false` was mapped to FAIL when **two of its three writes are timeouts** — against a
  ~90s window and a measured 3m38s latency, so **the likely outcome of a working spawn was a recorded
  FAIL.**
**★ The rule this earned: A FIX WRITTEN BY SOMEONE WHO HAS JUST INTERNALISED A FAILURE MODE IS NOT
IMMUNE TO IT.** The fix site is the highest-risk site — written under time pressure by someone
holding a fresh model. **Weight the diff, not the document.**
**★ AND THE STOPPING-RULE DEFECT, which is the part worth carrying beyond uxtest:** "review until a
pass comes back clean" silently assumes the passes are **independent**, and after pass two by the
same reviewer they are not. The reviewer said so about itself, unprompted, and asked to be
supplemented rather than trusted: *both defects I found are the same shape, that is the lens I now
have, and lenses hide what they are not shaped for.* **That is §0e.3's convergence-is-not-
corroboration rule applied to one agent at two points in time** — the version nobody guards against,
because it does not look like two reviewers. A cold second reader was dispatched, deliberately told
**not** to read the first reviewer's findings first.

### FLEET — what each proved this morning, not what they are for
- **Sable [grok]** — pinned the `operatorAllowed` constant-false, and **overturned the Lead's P2-2
  collision framing** with a one-line reductio (that reading would also outlaw `accept_invitation`,
  which the system already does). Reviews state their own boundary: it said explicitly which claims
  it had *not* re-verified. **Signals is home base but it is NOT signals-only** — it also reviewed
  the hosted deploy plan, audited the Phase M artifacts, and ran the R1 cold pass (finding T2
  independently, and reporting that it had MISSED T1 because it reasoned about the snippet instead
  of executing it under a seeded value). Do not read §0f as leaving it idle while its lane blocks.
- **Quill [codex]** — executed Phase M cleanly: captured every probe **before** inspecting it,
  reported literal status codes rather than "passed", deployed `read` before `command` to avoid a
  post-capable/read-missing window, and **blocked rather than manufacturing a credential.**
- **Ferry [claude]** — found its own three wrong citations before the reviewer could, and found the
  three-outcome gate-5 confound that would have let a false `carryover=true` disqualify R1's central
  finding under §7.7. **Its errors have one shape: reasoning from code-as-written to machine-as-is.**
  Distrust *that class* of claim, not the agent.
- **Atlas [claude]** — R1 runbook review, **three passes delivered, stood down by ruling**; it
  recommends a **cold reviewer over a fourth pass from itself**, because all three defect classes it
  found are *two worlds, one output* and a lens hides what it is not shaped for. Also overturned
  **its own shipped finding** and declined credit twice. **Its own correction to how this entry read
  first, and it is the better version:** declining to produce two findings a Lead asked for by name
  was **not** courage under pressure — there were only four, so it was *reporting a count*. The part
  that was a choice: it could not distinguish "the Lead misread my header" from "the channel cut my
  message" — identical observable — so it **named both worlds and asked the one party who could run
  the discriminating test to run it.** That is the half worth teaching. Its method generally: **the
  source tells you what the code does; only the machine tells you what state it is in.**
- **Lead5** — **ADVISORY ONLY, and this is a scope not a compliment: §1d rulings, P3-1 pins, and why
  a past decision was made. NOT current on the code — do not ask it to judge live work.** Its own
  framing, offered after it instructed an agent to do something that agent had already done. It did
  narrow two of Lead6's claims usefully, but it named that as the least repeatable thing it did.
- **Anvil [a2a, mini]** — provisioning. **★ ITS REGISTRY ENTRY IS MISROUTED TO `Yulan` (see item 2);
  fix or re-verify the entry before dispatching anything to it.**
- **Dana [cmux/claude-code] on the laptop — NOT `[a2a]`, and this is not cosmetic.** Its own
  correction: `swarm whoami` reports **Type cmux, Host claude-code**; the `:18791` bridge is a
  *served endpoint*, not its agent type. **cmux receives mid-turn push; a2a surfaces only at a turn
  boundary** — a successor reading it as a2a will mis-model its response latency. It also produced
  both findings in item 2 and, separately, found that `_lib.sh wait_for_agent_local` pipes
  `swarm members` into `grep` with `2>/dev/null`, discarding stderr **and** the exit status, so a
  **failed query and a genuine absence are identical** — and `uxtest-r1` does not exist yet, so the
  error case is the **current** state, not a hypothetical. Query-failure belongs in UNDETERMINED,
  not FAIL, and must not burn a retry.
  **★ AND A BATON-LEVEL TRAP DANA HIT: THE LAPTOP CLONE CANNOT VERIFY SHAs.**
  `/Users/tom/Developer/Ridge.io/cloud-swarm` fails `fetch` with *Repository not found* while
  `rev-parse` cheerfully returns a stale `cbb9c89`. Dana nearly reported a correct Lead SHA as
  wrong. **Derive SHAs on the mini only** — this is the cached-artifact face with a broken remote
  underneath it.

### ★ WHAT I GOT WRONG, ALL THREE THE SAME FAMILY
1. **Published a stale `origin/main`. Twice.** Caught by Sable, then Ferry.
2. **★ Read my inbox through `head -N` for three hours** and silently truncated every long message —
   including 120 lines of a contract containing **the direct answer to a question I had just asked.**
   This is Lead5's `tail -1` send-side truncation **received**. Read bodies at full length from
   `~/.swarm/swarm.db`; the CLI's paging is not the message.
   **★ ONE TWO-SIDED RULE, NOT TWO ANECDOTES (Lead5's framing, adopted): A PIPE ADDED FOR TIDINESS
   IS A SILENT FILTER, AND THE END THAT ADDED IT IS THE END THAT CANNOT SEE IT.** One Lead's `tail`
   cut the SENDER's content; the next Lead's `head` cut the RECEIVER's intake. Both were added for
   neatness rather than for a result, and neither was visible from the side that added it — one saw
   *"Message sent"*, the other saw a message that read as complete.
3. **Overclaimed the GRANT** (above) — built a negative control for one arm and then made a claim
   about a second arm I never controlled for, which is worse than no control, because the real
   control made the wider sentence feel earned.
**All three were caught by workers, none by me.** That is the system working, and the density is the
signal to rotate.
**★ AND THE CALIBRATION, from the only agent who has watched two Leads (Lead5): THE ERROR DENSITY
DID NOT RISE.** Four citation errors, a session-long send-side truncation and a spawn-path overclaim
from one Lead; three of one family from the next. **THE CONSTANT IS NOT THE LEAD.** Expect roughly
this many, and **measure yourself by how fast the fleet catches them, not by whether they occur** —
a Lead optimising for zero errors will stop publishing checkable facts, which is the one change that
would actually make this worse. **Tell your fleet a SHA from you is context, never authority** — they will check,
and they will be right.

### ★ THE ONE THING I WOULD KEEP
**Every correction that mattered today came from the person with the least authority to make it, and
every one of them was delivered with the command attached.** A reviewer corrected the Lead in its
introduction message. Two workers corrected the Lead's published SHA. A researcher refused to
produce findings the Lead asked for by name. **Ask for that explicitly and then visibly take it,
because a fleet learns what you reward within one exchange.**

## 0g. ROTATION 2026-07-25 ~01:45 (Lead5 -> Lead6). Read this after §0h.

Rotating at a clean boundary: **P3-1 landed and pushed**, `origin/main` = **`67d527b`**,
linear history intact (0 merge commits), primary worktree clean. **Verified by execution at
write time — but per §3 instance 5, RE-DERIVE IT YOURSELF: `git rev-parse origin/main`. This
document cannot contain the SHA of the commit that adds it.**

### What shipped under Lead5
- **P3-1 THE SIGNAL PLANE** (`67d527b`) — the coordination primitive. Five plain verbs over a
  three-value enum the user never types; `until` as the lifecycle instead of a state machine;
  agents as first-class posters **and** pollers via a read proxy running the same `is_member`
  predicate. **NOT DEPLOYED TO HOSTED** — deliberate, see residuals.
- **§1d, the communication-first re-scope** — advisory reservations PARKED after the operator's
  steer. Leases prevent double-writes to shared mutable state; cross-swarm has none, because each
  swarm holds its own clone and the only shared state is GitHub. *GitHub holds the artifacts;
  coswarm holds the intentions.*
- **uxtest harness hardening** — four defects fixed including the idempotence short-circuit, and
  the R1 sequence corrected (the baton's own sequence would have died on its first command).
- **§0e practices 4/5/6, §0f, and eight faces of one error class in §3.**

### THE STATE OF uxtest R1 — READ BEFORE TOUCHING IT
`carryover=true`, `human2_spawn_probe=failed`, `reset_complete=true`, `oauth_consent=returning`.
**There is no round.** Gate 5 failed and Ferry correctly STOPPED rather than proceeding.
**Gate 5 is unblocked** (the operator ratified the laptop trust entry). **Gate 7 is not** — the
mini's `/Users/yulanbot/uxtest/human1/workspace` has no trust entry, and only a human can grant
it. Ferry recommends running 5->6->7 contiguously rather than firing 5 alone and stranding a
persona overnight. Full write-up: `uxtest/findings/2026-07-24-r1-attempt-1.md`.
**★ Do NOT write `rounds/1/REPORT.md` before a round runs** — `reset-round.sh:28` refuses to reset
a round whose directory holds it. The report file is a LOCK, not just a document.

### FLEET
- **Sable [grok]** — adversarial reviewer, and the deepest signal-plane context in the fleet. It
  caught the vacuous-gate class, the rate-ordering blocker, and a live mint break. **Route every
  brief through it. Keep it on signals** (§0f).
- **Quill [codex]** — implementation. Strong: it discarded an over-strict gate that returned the
  wrong count rather than papering over it, and inspected real row shapes before scoping a query.
- **Ferry [claude]** — uxtest harness lane. Found the idempotence short-circuit and the zsh `path`
  bug; gave us the "identical answers where the arms should have differed" detector.
- **Atlas [claude]** — research, idle. Delivered the ACP clean negative and later corrected two
  things of mine, including the rule I wrote *about* citation errors.
  **★ AND ITS OWN CORRECTION TO HOW I FRAMED THAT, which is the better version:** it did NOT catch
  either by deciding to audit the Lead. One fell out of opening surrounding lines to quote them
  accurately; the other out of reading a line closely enough to restate it. **"Check upward" reads
  as requiring nerve — and a successor who thinks it takes nerve will do it rarely, and only when
  already suspicious, which is exactly when it is least needed.** The version that scales is
  cheaper and mechanical: **quote nothing you have not read in context, and restate anything you
  are about to build on. The upward check falls out of that for free.**
  Same shape as the other two defences that worked tonight — the identical-answers detector and
  read-the-signature-first. **Every practice here that survived contact was mechanical; every one
  that required vigilance failed at least once.**
- **Dana [a2a, laptop]** — GUI launcher, constraint loosened by the operator (may write trust
  entries for uxtest persona dirs with backup + narrow diff + disclosure).
- **Anvil [a2a]** — provisioning. Note its registry entry points at *Yulan's* bridge on 18790.

### OPEN OPERATOR ASKS
1. **The mini trust action** — one Claude session opened in `/Users/yulanbot/uxtest/human1/workspace`,
   accepted, exited. Or a ruling on whether the trust loosening is **agent-scoped** (Dana only) or
   **target-scoped** (any uxtest persona dir, so Ferry may seed it). This is the ONLY thing between
   us and R1.
2. **Hosted deploy of P3-1** — G5 is unclaimed; nobody has run a positive post-then-read against
   hosted. That decision is the operator's; the code is landed and revert-able.
3. Still open from Lead4: drive `coswarm accept --link-stdin` personally as the felt test.

### ★ WHAT I THINK IS NEXT (Lead5's recommendation, operator-agreed framing)

1. **uxtest R1** — one operator trust action away, cheapest, pays the measurement debt.
2. **★ DOGFOOD P3-1 — the one I would argue for hardest.** We built a communication primitive and
   **have never sent a signal.** §0b's instinct is *build to the first real use, stop, let it be
   used, plan from what it teaches* — and every genuinely useful steer this project has had came
   from the operator DRIVING something, not from us reasoning about it (§1c exists because of
   exactly that). The signal plane will be subtly wrong in ways no review catches: is `working-on`
   the right verb, does a 24h horizon feel right or absurd, is `--about <pr-url>` natural or
   ceremony? **Reviewers cannot answer those. Ten minutes of real use can.** This requires the
   hosted deploy — so that decision is not "should we ship it", it is **"do we want to learn
   whether it is right."**
3. **Governed workspace creation** — the structural hole. `create_workspace` exists in the protocol
   with **no CLI path**; every workspace to date was conjured with a privileged `DATABASE_URL`, and
   the CLI's own help admits the fixture bridge is "not a governed product workspace-creation path".
   Until it exists, nobody can start using this without the operator personally seeding their
   workspace. **It is the last thing between "demo" and "product."**
4. Then P2-3's agent-skill layer (hold lifts on `r1_complete`) and the hosted invite page for
   felt-dogfood feedback #2.

### ★ WHAT I WOULD TELL MY SUCCESSOR IF I COULD ONLY SAY THREE THINGS
1. **STOP ARGUING ABOUT WHAT THE CODE IMPLIES AND GO READ WHAT IT DOES.** Three design disputes
   tonight — the seam, the include-stale claim, the option-2-vs-3 fight — were each settled in
   under two minutes by one `grep`, one `curl`, one `stat`. None was settled by authority or
   argument. When two capable reviewers disagree, the disagreement is almost always about a fact
   one of them can check.
2. **A GATE THAT CANNOT FAIL IS WORSE THAN NO GATE**, and its inverse — a gate that reddens for
   unrelated reasons — is nearly as bad, because it trains people to ignore reds. Demand a
   RED-then-GREEN proof for every gate. Both blocking defects tonight were gates that could not
   fail, and one of them was mine.
3. **THE CITATION IS WHERE YOU WILL BE WRONG, NOT THE REASONING.** Four of my errors tonight were
   the same motion: grep up a line containing the right identifier and promote it to proof without
   reading what the enclosing function does. Read the signature first. Ten seconds. I skipped it
   four times while actively cataloguing the error, which is why the fix is a habit and not
   vigilance.

## 0e. STANDING PRACTICE — how this program works, not one Lead's advice

Written down 2026-07-24 at the Lead4→Lead5 rotation, because the prior handoff put *state* in
this file and the *practice* only over the wire — exactly backwards. State decays; practice
doesn't. These are not any Lead's opinions; they are what the work taught, and each has a paid
cost behind it. Every Lead and every worker inherits them.

**1. VERIFY BY YOUR OWN EXECUTION, ALWAYS.** Re-run every gate a worker reports green. This is
not distrust — the workers here are good, and it still catches things. Observed cost of skipping
it: three missing mechanical guards sitting behind an accurate-sounding "applied all findings",
and a *second* root cause of bug #3 (hosted PostgREST never exposed `swarm_read`) that would have
shipped a still-broken hosted experience whose symptom looked identical to the one we'd fixed.
A report is a claim; an artifact is evidence.

**2. BEFORE BELIEVING A NEGATIVE RESULT, CONFIRM THE PROBE COULD HAVE PRODUCED A POSITIVE ONE.**
The full error class and its five instances live in §3 (★ ERROR CLASS). The compressed form:
*a grep that can match your own commentary is not a test*, and *a document cannot testify to the
state after itself*. Absence of signal is not signal of absence until the instrument is proven
able to detect presence.

**3. ROUTE EVERY BRIEF THROUGH THE ADVERSARIAL REVIEWER BEFORE IMPLEMENTATION.** Pin the
contracts *before* writing the brief — that costs far less than the review rounds it prevents
(P2-1 needed three). What this has caught that a Lead did not: an OAuth-phishing vector
introduced by a Lead, a false-success path introduced while fixing the reviewer's own earlier
finding, a Lead-authored rule that made the deliverable unbuildable, and a wall-clock cheat
neither Lead nor worker saw. Related operator directive: **reviewers run in visible tabs, never
as headless one-shots** (a headless reviewer run hung ~2h with zero output).

**4. ★ AUDIT YOUR VERIFIER, NOT JUST THE THING IT VERIFIES (2026-07-25, paid for in full).**
A fan-out audit of the P3-1 brief raised **33 findings**; the adversarial verification stage
refuted **66 of 66 verdicts with zero dissent** and the run returned `{confirmed: []}`. Read as
"the document is clean", that is a **false all-clear on a document with eight real defects** —
including a gate demanding two mutually exclusive behaviours, and the highest-risk deliverable
shipping with no acceptance gate at all.

**The instrument was broken, and the bug was in the prompt I wrote:** both verifier arms were told
*"default to refuted=true when uncertain"*, and the keep-rule required **both** to say
`refuted=false`. That gate can essentially only emit zeros. **A verification stage that cannot
return a positive is not a verifier — it is a rubber stamp with extra steps and a large bill.**

**The tell was the one already written down:** *identical answers where the arms should have
differed* — 66/66, no split, across 33 heterogeneous findings from four different lenses. Two arms
prompted to measure different things (a skeptic and an implementer) should disagree *sometimes*.
Perfect unanimity is a property of the harness, not of the evidence.

**Rules that follow:**
- When a verification stage returns **nothing**, read the journal **before** believing it. The
  raw findings are the positive control for the verifier.
- Do not put *"default to refuted when uncertain"* in **every** arm and then **AND** them; that
  compounds a bias into a certainty. Bias at most one arm, or require a **majority**, not unanimity.
- **Report the raise count alongside the confirm count.** "0 confirmed" is meaningless; "0 confirmed
  of 33 raised, 66/66 refuted" is self-evidently an instrument failure.
- **★ And note where the defects came from: EVERY ONE WAS INTRODUCED BY REVISION.** Each section
  was correct when written and made wrong by a later fold elsewhere — including one inconsistency
  the Lead had reported as *fixed* after fixing two of its three sites. **A document under
  revision needs a whole-document consistency pass, not just review of the diff.**

**5. ★ A FACT IS STATED NORMATIVELY IN EXACTLY ONE PLACE (operator-adopted, 2026-07-25).**
Everywhere else it appears, it is a **reference or a verbatim quote — never a paraphrase.**

**Why, from the evidence:** all eight defects the P3-1 audit found were in **restatements, not
statements**. No section was wrong about the thing it was the authority on. `--include-stale` was
right in the prose and missing from the CLI grammar; the rate limit was right in §4.5 and stale in
§7; the gates restated requirements the deliverables already owned. **Paraphrase is a copy that
looks like prose**, and copies drift. A reference cannot fall out of sync — there is nothing to
fall.

**★ The generalisation — the eighth face of §3's error class: A RESTATEMENT IS NOT THE THING. A
PARAPHRASE OF A RULE IS NOT THE RULE.** Same shape as a registry entry not being the server, a
process name not being the work, an answering endpoint not being a delivering one, a backup not
being a safe destination. **The moment you write a fact for the second time, you have created
something capable of disagreeing with itself.** Redundancy is where truth decays — in documents,
in caches, in registries, in status reports.

Cost: slightly worse readability, since a reader follows references. Worth it for any document an
agent will build from **literally**.

**6. ★ THE CONSISTENCY AUDIT IS A GATE, NOT AN EVENT (operator-adopted, 2026-07-25).**
Run the fan-out consistency audit before **every** "cleared for implementation" transition — not
once, and not only when something feels wrong. Human-style review catches whether an *edit* is
right; it structurally cannot catch that the edit invalidated something 200 lines away. Two review
rounds missed all eight defects for exactly that reason. **Wire the verifier per practice 4**:
majority not unanimity, bias at most one arm, and always report **raised alongside confirmed**.

*(Deliberately NOT adopted yet: a mechanical consistency lint — flags↔grammar, deliverables↔gates
bijection, constants-defined-once, pin coverage, vocabulary. It is the strongest of the three and
it is real work; it queues behind P3-1. Revisit if drift recurs after 5 and 6.)*

**7. ★★ EVERY VERIFICATION INSTRUMENT ENCODES A HYPOTHESIS ABOUT HOW THINGS GO WRONG, AND IS BLIND
TO EVERY OTHER ONE (Atlas, 2026-07-25 — the most transferable thing the day produced).**
Especially the hypotheses nobody has had yet. **So a clean run of a good instrument is not a clean
bill of health.**

*The evidence, and it is a convergence rather than an anecdote:* after a session-long send-side
truncation failure, **two agents independently built the same defence and it had the same blind
spot.** Ferry counted backticks and bytes on *inbound* messages; the Lead queried stored bodies in
`~/.swarm/swarm.db` on *outbound* ones. Both ran faithfully, every message, all session. **Both were
blind to RECIPIENT IDENTITY by construction** — and the actual next failure was that every message
dispatched to `Anvil` for three hours landed in `Yulan`'s inbox, because the registry entry pointed
at an endpoint serving a different agent's card. Content verified. Recipient never checked. **A
DEFENCE BUILT FOR THE LAST FAILURE IS AIMED AT THE LAST FAILURE.**

**★ THE RULE: WHEN YOU BUILD A DEFENCE FOR A NEW FAILURE CLASS, WRITE DOWN WHAT THE NEW DEFENCE WILL
BE BLIND TO, NEXT TO IT.** Both agents could state their own lens once asked — *"mine are all two
worlds, one output"*, *"mine was content survived, recipient unchecked"* — and **neither could find
the other's.** Naming the blind spot is cheap at the moment you build the instrument and impossible
afterwards, because from then on the instrument is what you look through.

**8. ★ AN UNRULED FINDING IS THE LEAD'S DEBT, NOT THE FINDER'S — AND THE DEBT COMPOUNDS WITH TIME,
NOT WITH SEVERITY (2026-07-25, two instances, one priced).**
Same rule, two instances in one program:
- A three-outcome gate confound was raised, not ruled on, and **re-raised hours later while still
  cheap. Cost: nothing.**
- The `Anvil`/`Yulan` endpoint-identity mismatch was flagged at 22:26, correctly, with the
  reasoning attached — and **never ruled on. Ten hours later it cost three hours of messages
  dispatched into a dead inbox**, including the trust task that was the program's single blocker,
  and left that blocker *unassigned while everyone believed it was in flight.*
**The price is set by how long a finding sits, not by how serious it looked when raised** — and how
serious it looks when raised is exactly the judgement that defers it. **Rule on findings you cannot
act on, even if the ruling is only "noted, not now, here is who owns it."** An unruled finding
becomes invisible; a deferred one stays on a list.

**9. ★ A PARTIAL FIX IS MORE DANGEROUS THAN NO FIX, BECAUSE THE CORRECTED NEIGHBOURS ARE EVIDENCE OF
THOROUGHNESS (Atlas, 2026-07-25).** A citation repair matched two literal forms and missed a third
variant one line away — leaving the single wrong pointer **sitting between two corrected
neighbours**, in a file whose commit message claimed the class was fixed. Nobody re-reads a
repaired section. **A FIX SCOPED TO THE INSTANCES YOU ALREADY FOUND CANNOT DISCOVER THE INSTANCE YOU
DID NOT** — grep the whole artifact for the *pattern*, then **verify by searching for what should be
ABSENT**, not by re-reading what you changed.

**10. ★ A SHA IS CONTEXT WITH A TIMESTAMP — YOURS, MINE, ANYONE'S. QUOTE THE SHA NEXT TO THE CLAIM.**
`git fetch` is necessary and **not sufficient**: the ref moves between the fetch and the report. In
one morning a Lead published a stale `origin/main` twice and was corrected by two workers, and then
**three agents — all of whom fetched, re-derived, and cited their command — independently converged
on a superseded commit** and reported a defect that had been fixed fifteen minutes earlier. Nobody
was careless in either direction. **The defence is not fetching more carefully; it is stating the SHA
you read alongside the claim**, so a reader can tell in one glance whether you are describing the
same world they are. Costs six characters. Closes the whole class in one command instead of an
argument.

**★★ 10a. AND PRACTICE 10 HAS ITS OWN BLIND SPOT — IT PRESUMES THE FETCH RAN (Dana, 2026-07-25).**
Practice 10 says *fetch is necessary and not sufficient, because the ref moves between the fetch and
the report.* **That describes a race. The failure actually observed on this fleet is worse and
different: THE FETCH NEVER EXECUTES AT ALL, and `rev-parse` then serves the cache with total
confidence.**
  mini, over ssh:  `git fetch origin` → *fatal: could not read Username for 'https://github.com'*
                   `git rev-parse origin/main` → **answers anyway**
  laptop clone:    `git fetch` → *Repository not found* (recorded above), `rev-parse` → stale SHA
**An agent following practice 10 over ssh believes it DERIVED a SHA it merely RECALLED** — and it
will say "re-derived" in good faith, because it ran the command practice 10 told it to run.
*Verified generically by the Lead:* a failed fetch followed by `rev-parse` on the same line prints a
clean SHA **with no indication the fetch died** — `git fetch bad-remote 2>/dev/null; git rev-parse
origin/main` emits only the SHA. *(Honest limit: the Lead could NOT reproduce Dana's specific ssh
auth case — ssh-to-self failed on host-key verification. Dana measured that; the Lead confirmed the
general mechanism only.)*
**★ THREE GRADES, NOT TWO (Lead5, having tested its own form rather than assuming it):**
**(1) FAILURE INVISIBLE** — `2>/dev/null`, `2>&1 | tail -1`. The probe *cannot* report failure.
**(2) FAILURE VISIBLE, UNGATED** — `git fetch -q origin ;` then read the ref. **The error DOES
print** (`-q` is not `2>/dev/null`; the fatal still appears, exit 128) — **and nothing stops the
stale SHA being printed directly underneath it.** **(3) FAILURE GATED** — `&&`, stderr intact.
**★ GRADE 2 IS THE DANGEROUS ONE BECAUSE IT FEELS SAFE.** Grade 1 fails silently; grade 3 cannot
fail; **grade 2 is right by ATTENTION rather than by CONSTRUCTION** — it depends on a human noticing
stderr scroll past above the answer they were looking for, which is exactly the attention that is
gone at 3am or when the answer matches expectation. **It is also the grade that SURVIVES REVIEW,
because the transcript contains the evidence and reads as having been checked.**
**★ THE GENERAL FORM: when you audit an instrument, do not only ask "COULD THIS REPORT FAILURE" —
ask "AND IF IT DID, WOULD ANYTHING STOP?"**
**THE FIX: CHECK THE FETCH'S EXIT STATUS, DO NOT JUST RUN IT.** `git fetch origin || echo "FETCH
FAILED — the SHA below is CACHED, not derived"`. Never `2>/dev/null` a fetch, and never chain it with
`;` to the command that consumes it — **`&&`, so a dead fetch cannot be followed by a confident
answer.** Interactive shells on the mini fetch fine; **ssh and cron are where this bites.**
**★ AND NOTE HOW THIS WAS FOUND — it is practice 7 executed against practice 10, one turn after
practice 10 landed.** The new defence was asked what it would be blind to, and it had an answer.
That is the practice working, and it is the reason 7 is worth more than any rule it protects.

**11. ★★ A HANDOFF IS WRITTEN *ABOUT* STATE, NOT *FROM* STATE — RE-DERIVE EVERY FACTUAL CLAIM IN THE
SAME TURN YOU WRITE IT (Ferry, 2026-07-25, after doing it twice in twenty minutes).**
Ferry's own diagnosis, and it explains why this lands on handoffs specifically rather than at random:
**"WHEN I AM DOING THE WORK I TOUCH THE MACHINE. WHEN I AM SUMMARISING THE WORK I RECALL IT."**
Every factual claim in a summary is *a memory of a check, not a check* — and **memory is testimony**,
the one instrument this program has established cannot answer *is this true now*. Both of Ferry's
stale claims were facts it had personally verified **by execution, hours earlier**, and then quoted
from itself; one went out **two minutes after** the thing it described had been fixed. It became the
unreliable agent-report it had spent the day warning others about.
**The rule is not "verify carefully" — it is that the checks go in the SAME TURN as the summary**,
because a handoff written from notes is written from testimony no matter how good the notes were.
Cost of the two misses: one `grep -c` and one `git log`. **Handoffs are the longest-lived thing we
write and the most expensive place to carry a stale fact** (Lead5) — a successor inherits them as a
to-do list. This applies to *this section and every §0<n> baton in this file.*

**★★ 11a. AND FRESHNESS CANNOT CLOSE THE WINDOW — MARK WHICH FACTS ARE VOLATILE (Ferry, correcting
its own rule one hour later, after Sable found a drift in the handoff Ferry wrote *under* the rule).**
Ferry's lane close quoted `origin/main = c43e12e`; Sable read `2b0d5db`; Ferry then read `dce46ae`.
**Three SHAs, three readings, ten minutes — and Ferry HAD re-derived in the turn it wrote.** Practice
11 was followed and the fact was stale anyway. **A FRESHLY TAKEN PHOTOGRAPH IS STILL A PHOTOGRAPH.**
Re-deriving narrows the interval in which you were right; it does not confer durability.
**So a handoff must MARK ITS VOLATILE FACTS AND INSTRUCT THE READER TO RE-DERIVE THEM. Freshness is a
courtesy on top of that, not a substitute for it.**
**★ AND THE USEFUL AXIS IS NOT FRESH-VERSUS-STALE. IT IS: WHAT CAN CHANGE THIS FACT, AND WOULD I HEAR
ABOUT IT?** A ref nobody writes is durable at any age; a ref five agents push is stale on arrival
however recently you read it. Sort a handoff by volatility, not by importance:
  · `origin/main` — **VOLATILE**, moved three times in ten minutes. Never authority (§0e.10).
  · a trust flag / any human-flippable state — **VOLATILE**, and nobody announces the flip.
  · a branch ref **no process advances** — **STABLE at any age**, and stable *for a reason you can
    state*, not because you checked recently.
  · a defect count after a fix — **stable by direction of travel** (monotonic once closed).
  · a hold-dependent fact — stable *only while the hold is*; name the hold as the thing holding it.
*Ferry had already applied the right treatment to the one fact it felt uneasy about — writing "do not
take this line, re-derive it" about the trust state — and applied none of it to the SHA, which was the
more volatile of the two.* **Instinct picked the right mechanism and the wrong target.**

**12. ★★ CONVERGENCE COUNTS ONLY IF THE METHODS COULD HAVE DISAGREED, AND IN DIFFERENT WAYS
(2026-07-25 — the POSITIVE half of §0e.3's rule). *Two clauses, two authors:* the CONVERGENCE half is
Atlas's and Ferry's, who together with Lead5 hit one answer by three probes that fail differently;
the OPERATIONAL half below — grep for the defect, not the fix — is **LEAD5'S**, stated as a general
rule before either had generalised it, and arrived at independently by **Sable**. Recorded at Atlas's
insistence after the Lead misattributed both clauses to Atlas and Ferry — Lead5 is the one seat with
no lane of its own to be credited from.**
"Convergence is not corroboration when reviewers share a blind spot" is the negative half and it is
all this program had. The positive case, with evidence: **three methods that fail differently agreed
on one residual citation** — a positional `sed`, an exhaustive token count, and a defect-grep. That
is corroboration, and it is distinguishable from the bad kind **by construction rather than by
confidence.** A fourth probe agreed too and carried **zero information**: `grep ':109'` asks whether
the *repair* landed and **structurally cannot return the stale `:37`**, so its clean result was
vacuous — the vacuous-gate class inside a verification of a fix.
**★ THE OPERATIONAL FORM, and it is the sharpest statement of "confirm the probe could produce the
opposite": GREP FOR THE DEFECT, NOT FOR THE FIX.** `grep :109` asks whether the repair landed;
`grep :37` asks whether **the wound closed.** Only the second can come back dirty, and **a clean
report ends the check while a dirty one gets investigated** — so a probe that can only return clean
is worse than no probe at that step.
★ And the tell that exposed it is the detector one turn further out: two agents cited the *same*
defect at **line 134 and line 135**. The stale pair straddled two lines. **NEARLY identical answers
concealing that the arms were pointed at different things** — not identical answers where they
should have differed, but a one-line drift that reads as agreement.

**13. ★★ A DETECTOR THAT WORKS ON ITS OWN OUTPUT WILL NEVER RUN OUT, AND THAT IS NOT A HEALTH
SIGNAL (Atlas, 2026-07-25, calling a stop on this very section).**
In one hour §0e gained 10a, 11a, an attribution correction, and a correction to that correction.
**Every one was individually right.** But the object under review had become *the fleet's
documentation of the fleet's own verification*, and **the things being corrected got smaller each
round while the cost of a round did not.**
**Practices 7 and 12 in particular will ALWAYS find something**, because every new rule is a new
instrument with a new blind spot, and a fresh blind spot is always findable by the rule that says
blind spots exist. **Self-sustaining is not the same as healthy.**
**★ THE MEASURABLE FORM, which is what makes this a finding and not a mood: six defects came out of
the runbook review and every one would have corrupted a real measurement round. Everything after it
was line numbers in a practice list. Same method, same rigour, TWO VERY DIFFERENT DENOMINATORS.
A METHOD'S VALUE IS SET BY WHAT IT IS POINTED AT.**
**★ AND THE TEST TO APPLY: WHAT IS ACTUALLY BLOCKED, AND HAS IT MOVED?** On the day this was
written, R1 needed **one operator ruling** and Phase G needed **one login** — and *neither moved
while this section grew by six entries.* **When the practice list is growing faster than the
product, the fleet has run out of things to point the instrument at and should say so out loud
rather than keep finding.** Point it at an external object or stop.

**14. ★★ THE OBSERVATION IS CHEAP AND CHECKABLE; THE MECHANISM IS EXPENSIVE AND FEELS FREE
(Atlas's formulation, 2026-07-25 — four instances, four agents, one day).**
Landed under §0e.13's stop-rule with that rule's own author arguing for it, on the grounds that this
is a **measured failure mode with a cost**, not the practice-list self-reference 13 was written to
stop.

**The shape:** take a real observation, attach a mechanism that feels right, publish. The observation
was measured; **the mechanism was invented and cost nothing to invent.**

| observation (real) | mechanism (invented) | what killed it |
|---|---|---|
| spawn hangs on the laptop, `members` answers in 84ms | "origin outside the GUI session" | one marker test, ten seconds |
| messages arrive in clumps | "the transport is slow" | a 3.7s row **in the same query output** |
| an agent missed a finding | "probably that latency" | its `to_agent` column, **one field away** |
| a PATH A/B result | a mechanism its own author retracted | re-measurement |

★ **In every case the disproof was already in reach of the person making the claim** — same query,
adjacent column, one command. The cost is not in checking; it is that **nobody feels the need to.**

★★ **AND THE WORST OUTCOME IS NOT THE WRONG MECHANISM — IT IS THE FIX QUEUED AGAINST IT.** A "transport
latency fix" was queued and would have been built. **A RED for a latency that is not latency cannot
fail — and it would have PASSED.** Someone would have measured a change, called it an improvement,
consumed a ship slot, and produced *evidence*. **That is worse than no fix**, because the artifact
would have argued for itself afterwards.

★ **File it as a fleet property, not as one agent's weakness.** It was first written as a Lead's
self-diagnosis and corrected on exactly that ground: *a rule filed as one person's failing will not
fire for anyone else.* Same correction class as filing a fan-out error under "citations" — **a rule
in the wrong category does not fire, however true it is.**

**The habit, and it is one question:** before publishing a mechanism, ask **what else would produce
this same data** — then check whether the answer is already in the output you have open.

**Corollary for rotation (§0):** when you rotate, put durable practice HERE and ephemeral state
in your §0<n> baton. If a lesson would still be true after every current SHA is ancient, it
belongs in this section, not in a handoff note — and not only in a message, which dies with the
session that sent it.

## 0f. SPAWN FOR PARALLELISM AND EXPERTISE — not only for degradation (operator, 2026-07-24)

**§0c and this rule are different tools and get confused.** §0c *rotates a worker out* because its
context has **degraded**. This rule *spawns a worker in* because a **new subsystem has started**.
One is triage; the other is capacity.

> Operator: *"Your swarmmates are getting some fairly full context windows… you should consider
> spinning up new swarmmates for new projects, or especially when work begins on new subsystems or
> components. This allows you to use multiple context windows, and create tiers of expertise."*

**Two things this buys, both of which the Lead tends to under-use:**
1. **Multiple context windows.** A single worker serialises everything through one window; N
   workers on N subsystems genuinely run in parallel and none of them pays to carry the others'
   history.
2. **★ Tiers of expertise — the part worth protecting.** A worker that has followed one subsystem
   through scoping → review → revision holds context that is *expensive to rebuild and cheap to
   keep*. **Deep context on a live subsystem is an asset, not a liability** — do not rotate it away
   on a schedule, and do not dilute it by handing that worker an unrelated lane.

**The practical rule:**
- **New subsystem or component → new agent**, briefed narrowly, reading only what its lane needs.
- **Keep a specialist ON its specialty.** (Live example: the reviewer that carried P2-3 scoping →
  the P3-1 reservations cut → the §1d re-scope → the signals brief now holds the deepest
  signal-plane context in the fleet. That agent stays on signals.)
- **Rotate on §0c's evidence** (≥10 compactions / ≥12h), **not** because a window looks busy.
  Measure first: `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, then size / lines /
  `grep -ci compacted`.
- Spawning is **cheap and reversible**; a blocked lane with no owner is not. Prefer spawning
  slightly early — a warm agent that has already read its lane's docs is worth more than a fast
  one briefed under pressure.

## 1. Model & delegation policy (operator directive)

- **THE LEAD DOES NOT HAND-CODE.** Fable credits are **dangerously low** and the Lead
  session burns them. Your job is orchestration: decompose, delegate, review,
  commit, coordinate — **never write/verify implementation code yourself.** Assign
  ALL coding to a **Codex CLI** worker or a **Kimi K3** agent and review their output.
  (A prior Lead violated this by hand-editing the core; do not repeat it.)
- **Lead role = Fable-class** (scarce; **reserved for Leads only**). You are the Lead.
- **Workhorse implementation → Codex CLI** (edits + runs tests):
  `codex exec -C <git-dir> -s workspace-write --skip-git-repo-check -m gpt-5.6-sol
  -c model_reasoning_effort=xhigh "<prompt>"`. For review-only use `-s read-only`.
  Always prepend the "do NOT invoke any skill/SKILL.md" override, or Codex gets
  hijacked by gstack skills. Give a precise spec + "get to green (tsc + tests)".
- **Fable-class *reasoning/review* work → Kimi K3** (fable-adjacent), NOT Fable:
  spec/design authoring, adversarial correctness/security review, hard reasoning —
  `opencode run --pure -m openrouter/moonshotai/kimi-k3 --dir <repo> "<prompt>"`.
- **Coordinate via the swarm** (stable `~/Developer/Ridge.io/swarm` CLI): track work
  as swarm tasks, spawn/assign workers, review with evidence. The Lead reviews and
  integrates; workers implement.
- **Provisioning / anything you'd ask the operator to do** (create Supabase project,
  GitHub App, OAuth grants, DNS, deploys, entering credentials) → **delegate to the
  OpenClaw and Hermes A2A agents** (they act with the operator's authority; they are
  registered A2A agents reachable via the swarm). Do NOT enter credentials yourself.
- **Dispatch hygiene:** never `nohup ... &` inside a `run_in_background` Bash call —
  it orphans the child. Let the tool own backgrounding. Codex needs a git-repo
  workdir (`--skip-git-repo-check` if not). Strip ANSI from opencode logs
  (`sed 's/\x1b\[[0-9;]*m//g'`). **`swarm send` to Mason[codex] MUST use `--now`** —
  the default single-Enter queue leaves the message unsubmitted in his composer
  (observed 2026-07-24: two briefs sat undelivered ~2h; `--now` landed instantly).
  Verify delivery with `swarm read Mason` (composer shows "Working…"), not just "Message sent".
- **★★ ONE WORKING DIRECTORY, TWO ACTORS: BRANCH STATE IS SHARED (2026-07-25).** When a worker
  commits WIP to a feature branch in the repo the Lead is also using, **the Lead's next commit lands
  on the worker's branch**, and switching back mid-work would yank the tree out from under them.
  **Fix: the Lead keeps a separate `git worktree` on `main` for documentation commits.**
  `git worktree add <path outside the repo> main` — the worker keeps the primary checkout, the Lead
  writes docs on main, neither can disturb the other. Put it **outside the repo tree** so the
  janitor's debris counter does not adopt it.
  **Cleanup:** a Lead's worktree under a session scratchpad dies with the session, leaving a stale
  entry in `git worktree list` pointing at a path that no longer exists. If you see one, it is not
  a mystery — run `git worktree prune`.
  Same instinct as committing WIP to a branch in the first place: **remove the class rather than
  ask two actors to remember a rule about a shared mutable resource.**
- **★★ A REVIEW FAN-OUT MUST BE TOLD IT IS READ-ONLY — IN WORDS (2026-07-25, near-miss).**
  A verifier agent in a pre-ship review ran **`git checkout -- supabase/functions/command/index.ts`**
  during cleanup, on a file holding **~300 lines of uncommitted implementation**. It recovered from
  a backup and disclosed immediately and unprompted; the Lead verified the recovery independently
  (line count, five landmark functions at expected offsets, `tsc` clean, core suite green, and
  **md5-identical to the backup**). Nothing was lost — **by luck, not by design.**
  - **The prompt said "Inspect it with `git diff` / `git status`". It never said DO NOT MUTATE.**
    An agent told to investigate a working tree will tidy up after itself, and `git checkout --`
    is a normal tidying reflex that happens to be destructive exactly when the tree is dirty.
  - **RULE 1 — say it explicitly in every review/audit prompt:** *read-only; do not run any
    mutating git command (`checkout`, `restore`, `stash`, `clean`, `reset`), do not edit, move or
    delete files; if you need a scratch file, write it outside the repo and remove it.*
  - **★ RULE 2 — the structural fix, which does not depend on prompt discipline: DO NOT LEAVE
    HOURS OF WORK UNCOMMITTED WHILE FANNING OUT AGENTS OVER IT.** Have the worker commit to a
    branch first. A committed tree makes `git checkout --` a no-op instead of a catastrophe, and it
    removes the whole class rather than asking N agents to each remember a rule. The Lead held this
    slice uncommitted for hours specifically so a review could see the diff — which is precisely
    the state in which reviewing it is most dangerous.
  - **Worth noting what worked:** the agent backed up before acting and disclosed without being
    asked, which is the difference between a near-miss and a loss. Same pattern as the laptop
    config edit earlier the same night — **the disclosure is what made it recoverable, and it
    should be praised even while the action is ruled against.**
- **★★ NEVER PUT A SWARM MESSAGE IN A DOUBLE-QUOTED SHELL STRING (2026-07-25, Lead5, cost: every
  message of an entire session).** Anything in backticks — file paths, line refs, identifiers,
  flags — is **executed by the shell and DELETED from the message body** before it is sent.
  Measured, not suspected: of **39** messages Lead5 sent in one session, **ZERO contained a
  backtick**; Sable's contained 28, Ferry's 5. Not intermittent — every single one.
  - **★ The deletion leaves grammatical English, which is what makes it lethal.** A real example
    that shipped: *"the check is scoped to , so it only ever reveals membership in a workspace the
    caller is ALREADY a member of"* — predicate gone, comma intact, sentence still parses. The
    recipient reads past it or silently fills the gap from context and is usually right, which is
    precisely why the failure survives.
  - **★ How it stayed invisible for a whole session: `... | tail -1`.** Piping every send through
    `tail` scrolled the shell's `command not found` errors past and left only *"Message sent to
    X"*. **The Lead truncated the output of the Lead's own probe until it could report nothing but
    success** — §3's error class, self-inflicted, while actively naming it in other agents' work.
    **A PROBE THAT CAN ONLY REPORT SUCCESS IS NOT A PROBE.**
  - **THE FIX:** write the message to a file, then `swarm send <agent> "$(cat <file>)" --now`.
    Command-substitution output is **not** re-scanned for substitutions, so backticks survive.
    **Verify it worked by querying the stored body**, not by trusting the fix:
    `sqlite3 ~/.swarm/swarm.db "SELECT body FROM messages WHERE from_agent='<you>' ORDER BY id DESC LIMIT 1;"`
  - **General form, worth more than the bash tip: an outbound channel can be LOSSY IN A WAY THE
    SENDER NEVER SEES.** "Message sent" describes the *call*, not the *content*. Same family as an
    endpoint that answers but does not deliver — one layer further out, on the wire you yourself
    are writing to.

## 0b. CURRENT TARGET (operator, 2026-07-23): drive to the FIRST REAL DOGFOOD

**The near-term goal is not "finish P1" — it is the first moment the operator can
drive a fleet through the cloud-authoritative command path end to end.** Build to that,
stop, let it be used, then plan P2+ from what it teaches. The operator has authorized
**rotating to a fresh Lead whenever context gets tight** — do it at a clean green
boundary, update this file first, `swarm spawn -s cloud-swarm --agent claude --name Lead`.

**Dogfood = ALL of these exist and are proven working together:**
1. schema APPLIES on hosted Supabase (see build-state below — currently FAILING)
2. `handle_command()` Edge Function wrapping the pure `decide()` — DOES NOT EXIST
3. PKCE login + a CLI client that sends real commands — DOES NOT EXIST
4. the §9 launch-gate tests proven GREEN against the real database — NOT RUN
Until all four, there is nothing to dogfood; do not stage a fake one (hand-poking the
DB with psql is theater, not a dogfood — it teaches nothing about whether the feel is right).

### P1 BUILD STATE (update this every slice)
- **RUNTIME NOW AVAILABLE:** OrbStack/Docker 29.4.0 installed + running; local Supabase
  stack works (`supabase start` / `supabase db reset` apply cleanly). The §9 suite is
  unblocked. Apply migrations via the normal CLI — the earlier "CLI can't apply" theory
  was WRONG; it was the segfault (below) all along.
- **SLICE 1 — schema: DONE + VERIFIED ON REAL POSTGRES (commit 30538b9).** Applies
  from-scratch + idempotent; 24 tables / 9 read views / 24 RLS / 24 swarm_command
  policies / owner=swarm_admin / 0 anon-auth policies / events+audit_log append-only /
  2 cron. Evidence: `docs/evidence/p1-schema-apply.md`. **Landmine learned:** NEVER
  `GRANT <role> TO current_user` — it SIGSEGVs PG16 (crash presents as a dropped
  connection on every transport; only the local runtime surfaced it). Use
  `DO $$ BEGIN EXECUTE format('GRANT <role> TO %I', current_user); END $$;`.
- **SLICE 2 — command API: DONE + VERIFIED (commit `d825fb2` on main; Mason[codex]
  built, Lead2 verified by re-execution 2026-07-23).** The `command` Deno Edge Function
  (`supabase/functions/command/index.ts`, 1582 lines) holds ONE Postgres tx as
  `swarm_command`, runs the §3.2 15-step order, and calls the UNMODIFIED
  `applyCommand()`/`decide()`/`reduceTask()` for the 8 P0 task commands. The core is
  consumed as `supabase/functions/_shared/protocol.js` — an **esbuild bundle generated
  from `src/protocol/index.ts`** (`npm run build:command-core`; regenerated by
  `pretest:p1-server`). Independent verification (evidence: `docs/evidence/p1-command-api.md`):
  src/protocol UNTOUCHED (empty diff); bundle byte-identical to fresh regen = **zero
  drift**; `tsc` clean; P0 `npm test` 38/38; `test:p1-server` **7/7 GREEN on the live
  local stack** (T-01/02/03/05/06/10/11 + unknown-task pin; T-10 = 50 race iters, one
  winner); I1–I5 asserted via frozen-core fold. Scope per decisions #62–#65.
  **DEFERRED to slice 2b:** T-04 grant double-spend + T-07 revoke-mid-flight tests;
  §3.4 workspace-authority commands (currently seeded via service_role fixtures); rate
  limiting (§6). **Slice 3:** real PKCE login + CLI client. **Still open for dogfood:**
  hosted-Supabase apply of the command fn (item #1 — local-stack verified only).
  Build-order that produced this: `docs/design/P1-SLICE2-BRIEF.md`.
- **SLICE 3 — login + CLI (IN FLIGHT; operator-chosen next, 2026-07-23; Mason[codex]
  holds `p1-login-cli` lease).** `swarm login` = PKCE + GitHub OAuth via GoTrue, loopback
  `127.0.0.1:<random port>/callback`, `state` verified both paths; refresh token in OS
  keychain (headless fallback 0600-in-0700 + loud warning, hard refusal below); a THIN
  CLI sending the 8 P0 commands to `POST /commands` (slice-2 wire + decision #64 response),
  accepting a login JWT OR a seeded `swm_agt_` token; logout/devices → `revoke_device`.
  **DEFERRED:** all §8 local-first cache/outbox/replay (thin client only for first
  dogfood); §3.4 workspace commands (fixture-seeded — see the "fixture bridge" in the
  brief). Env-parametrized `--url`/anon-key: develop on LOCAL, dogfood on HOSTED.
  Build-order: `docs/design/P1-SLICE3-BRIEF.md`.
- **TRACK B — hosted provisioning (operator-chosen dogfood target = HOSTED
  `ukezjcnxjvkpkeezxaew`; Lead-driven via Anvil/Forge, NOT Mason).** Needed for the real
  dogfood, runs parallel to slice 3. Steps, each **independently verified** (landmine §3):
  (1) apply the P1 schema migration to hosted (Anvil: `supabase link` + `db push`; verify
  via `gh`/`psql`/REST that 24 tables exist); (2) deploy the `command` Edge Function to
  hosted (`supabase functions deploy command`); (3) ADD redirect allowlist entry
  `http://127.0.0.1:*/callback` (currently EMPTY — gap #6; path segment mandatory, `*`
  won't cross `/`); (4) stand up the **GitHub OAuth provider** in hosted Auth (create a
  GitHub OAuth app; client id/secret → Supabase Auth; secrets → 1Password only). Then
  hand Mason the hosted URL + anon key. **NOT STARTED as of this checkpoint.**

### (historical build state below)
- **Slice 1 — schema.** Migration `supabase/migrations/20260723000001_p1_schema.sql`
  (751 lines) written + committed (`e3b0ccd`), independently audited (24 tables, 24
  swarm_command-only policies, append-only triggers, no anon/authenticated grant on
  authority tables). **FIRST REAL APPLY FAILED** at statement 2:
  `must be able to SET ROLE "swarm_admin"` — hosted Supabase runs migrations as
  non-superuser `postgres`, which cannot `SET ROLE`/`OWNER TO`/`AUTHORIZATION` a role
  it isn't a member of. Fix in flight (Codex): `GRANT <role> TO current_user` after
  each `CREATE ROLE`, full idempotency, and — importantly — a ONE-PASS enumeration of
  ALL other hosted-Supabase incompatibilities (pg_cron/`CREATE EXTENSION`, event
  triggers, `ALTER SYSTEM`, `auth.*` ownership) so we don't burn one apply-cycle per
  failure. **The design must NOT be weakened to pass** — owner-pinned views (§2.3) need
  owner-evaluated predicates; do not let everything fall to `postgres` ownership.
  Apply route: **Anvil** runs `npx supabase link --project-ref ukezjcnxjvkpkeezxaew`
  (password from 1Password) then `npx supabase db push`; on failure capture the exact
  error and STOP, do not let the agent self-fix. `supabase/.temp/` holds link state
  (gitignored, no secret) — verified.
- **Slice 2 — command API.** `handle_command()` per §3: TS orchestrator in a `command`
  Edge Function, one Postgres transaction, calls unmodified `decide()`. NOT STARTED.
- **Slice 3 — login + CLI.** PKCE loopback (`http://127.0.0.1:*/callback`; the
  allowlist entry must be ADDED to the project — currently empty), keychain refresh,
  a CLI that sends commands. NOT STARTED.
- **Gate — §9 tests** green against the real DB. NOT RUN. Needs a container runtime
  eventually (`supabase start` + Edge Functions) — not available on this machine yet;
  operator will need OrbStack/Docker or we run the suite against the remote dev project.

### ★ 2026-07-23 LATE: THE §0b DOGFOOD IS ACHIEVED + VERIFIED (commit `ca836f6`)
All four dogfood items are DONE — see `docs/evidence/p1-first-dogfood.md` (read it; it
also records the fabricated-Anvil-readback catch and the Track B landmines: aws-0 pooler
host from the Management API, 6543-needs-prepare:false, transient op-session drops, where
every credential lives in 1Password). Real human GitHub PKCE login (gap#6 wildcard proven
at port 53493), seeded workspace, agent-token cradle-to-grave vs hosted with replay +
domain pin, verified at the event_id level via canary re-query. **Slice-3 final acceptance LANDED** (keychain fix `7736258` verified: tsc clean, P0 38/38,
CLI 13/13, clean hosted login/refresh/logout re-proof; task `p1-login-cli` closed merged,
decision #76).

### ROTATION 2026-07-24 (Lead2 → successor). OPERATOR DIRECTIVE: "rotate and continue."
State at handoff: HEAD `7736258` on main, tree clean, everything pushed; all tasks closed;
Mason [codex] idle+warm with full slice 1–3 context. **YOUR TASK: SLICE 2b** — make the
authority real by replacing the fixture bridge:
1. **§3.4 workspace-authority commands** via `decideWorkspace` (new pure module, same
   wrap-don't-fork pattern as `decide()`): priority order = `create_workspace` (operator-
   allowlisted), `create_agent_principal`, `mint_agent_token` (§2.3 denylist + TTL caps —
   this retires the seed script's token minting), `invite_member`/`accept_invitation`
   (atomic consumption), `revoke_agent_token`/`revoke_agent_principal`. Repo
   mapping/landing authority can trail (P2-adjacent).
2. **Remaining launch-gate tests**: T-04 (grant double-spend), T-07 (revoke-mid-flight,
   needs the test hooks), T-08/09/12; then T-13–T-25 as capacity allows. The §9.0
   invariants harness already exists in `tests/p1-server/`.
3. **Rate limiting** (§6, step 4½) + `rate_buckets`; **gap#15 auth-admin module** +
   device endpoints (retires decision #69's deferral).
Start a fresh swarm task per sub-slice; Mason implements, you orchestrate + verify.
(c) operator personally driving the CLI (the felt dogfood) remains QUEUED — solicit their
impressions when they do and fold into P2/P3 scoping; (d) plan P2+ from what the dogfood
teaches (§0b).

### ROTATION 2026-07-24 ~10:45 (Lead3 → Lead4). Goal achieved; operator: "move on to next stage."
Lead3 rotating at the achieved-goal boundary (context deep in the rotation zone). State:
HEAD is the evidence commit + this baton, tree clean, all pushed. **IN FLIGHT: Mason holds
`ux-connect-polish`** (bugs #1–#6 + Kimi 2b-2 FIX-1/3/4/5 + decision #81 pending-command_id,
scope fully pinned in swarm messages + this file) — collect his checkpoint, verify by
execution (tsc + 66/66 + 14/14 + 10/10), review diff, land, then **redeploy hosted**
(`npx supabase functions deploy command` from this machine — linked + authed). **YOUR MAIN
TASK: P2-connect-UX** (previous section) — one-command join, agent-skill layer, read
surface, narrated output. Read §1c feedback FIRST; it governs everything. Then 2b
remainder per §1b. Kimi review logs: scratchpad/kimi-2b1-review.log (FIX(7), folded),
kimi-2b2-review.log (FIX(5) minor: 1/3/4/5 in Mason's task, FIX-2 = rate-limit slice).
Landmines all in §1/§3 + evidence docs; the new one from today: Anvil free-text readbacks
misalign columns — demand strict single-JSON output with exact fields.

### LEAD4 ACTIVE (2026-07-24 ~10:50, baton accepted at HEAD b7a222c).
Lead2 + Lead3 both stood down; Lead4 is sole current Lead. **FIRST ACTION DONE:** collected
Mason's `ux-connect-polish` checkpoint (#001) and **LANDED it** — commit `87e41cf` on main
(+evidence `c662200`, `docs/evidence/ux-connect-polish.md`), task closed merged.
- **Independent verify (Lead4's own execution):** tsc clean; core 66/66; CLI 16/16; server
  11/11 on live local stack; `git diff --check` clean; core-bundle regen = **zero drift**.
- **Hosted redeployed:** `command` Edge fn now **version 4** (ACTIVE 15:53:04 UTC); endpoint
  canary returns the function's own structured JSON (register_device path executes). Deploy
  done BEFORE any new login (register_device moved server-side — Mason's landmine, honored).
- Shipped: bugs #1–#6 + Kimi FIX-1 (device revoked_at + register_device), FIX-3 (invite
  stdin), FIX-4/decision #81 (client pending command_id sidecar), FIX-5 (display_name strip).
- **Residual:** `coswarm --version` standalone flag not wired (version shows in --help header) —
  minor, folded into P2 CLI UX.
- **OPEN FIRST-ACTION (operator):** `/remote-control` — I cannot self-invoke the slash
  command; surfaced to operator to enable remote supervision.
- **★ P2-1 DONE + LANDED + HOSTED (`a823ab3`, evidence `80a1095`,
  `docs/evidence/p2-connect-accept-link.md`, task `p2-connect-accept-link` closed merged).**
  `coswarm accept <invite-link>` collapses the invitee's 4 commands into ONE with
  plain-language narration per step. Hosted `command` fn at **v5** (ACTIVE 18:17:10 UTC),
  deployed BEFORE relinking the CLI (old invite responses lack the label adjunct). Lead4
  independent verify at both checkpoints: tsc, core 66/66, CLI 37/37, server 11/11, zero
  drift, diff-check clean. **Live hosted proof the phishing gate works in the shipped
  binary:** a link with `url=https://evil.example.com` piped to `accept --link-stdin --json`
  → *"unrecognized Cloud host evil.example.com; non-interactive mode refuses before login"*.
  - **Decision #82 — the verb is `accept`, NOT `join`.** `SWARM-CLOUD.md:696` locks "members
    accept invites; agents join swarms"; §7 hardened that split. The baton's colloquial
    "`coswarm join`" was unavailable — this WIDENS `coswarm accept`. Legacy bare `swm_inv_`
    and `--invitation-token-stdin` unchanged + principal-free. **Future Leads: do not
    reintroduce a human `join` verb.**
  - **Decision #83 — optional `--name`, link mode only.** Own live principal → reuse; held by
    another member's live principal OR any revoked row → ONE uniform "already taken", never
    silently renamed (`UNIQUE (workspace_id, name)` is per-WORKSPACE not per-owner,
    `migration:181`). Auto-names may be suffixed (cap 5); user-chosen never. Rejected
    redirect-to-`principal create` (reintroduces friction AFTER membership commits).
  - **METHOD NOTE — the review loop paid for itself four times.** Sable[grok] as a *visible
    swarm tab* (operator directive: reviewers are cmux tabs, never headless one-shots) ran
    brief v1 → **NO-GO** (3 BLOCKING/5 MAJOR incl. the OAuth-phishing vector), v2 →
    **CONDITIONAL GO** (4 MAJOR incl. R1, a false-success path introduced *while fixing*
    round 1), v2.1 → **GO**, implementation → **GO**, fix pass → **GO** (M1, a violation of
    our own §2.4 convergence promise). Every finding was verified against live code before
    folding. Design brief `docs/design/P2-CONNECT-UX-BRIEF.md` v2.1 is the durable artifact.
  - **LANDMINE:** headless `opencode run` for Kimi **hung silently ~2h** with zero output and
    zero credit burn (stream stalled, no timeout). The operator caught it, not us. Reviewers
    must be visible tabs so progress is observable.
- **★ PRODUCT BUG FOUND BY THE HARNESS BEFORE IT EVER RAN (2026-07-24) — MAJOR, user-facing.**
  `src/cloud/auth.ts:410` — `discoverSoleWorkspace` persists a default workspace **only when the
  identity has EXACTLY ONE live membership** (`body.length !== 1 → return null`). Therefore **any
  human who belongs to two or more workspaces cannot invite anyone after a logout**, because
  `invite` needs `--workspace-id` and that flag is the one the operator's felt-dogfood already
  called undiscoverable (**bug #3**). The sole-membership auto-default was a reasonable v1
  heuristic; with additive invites and real multi-tenancy it is now a **trap**. This is not a
  test-harness artifact — a second *real* collaboration triggers it identically.
  - Found by Mason while on read-only stand-down; severity confirmed by Sable.
  - **It currently BLOCKS the uxtest harness at round 1**, not just R2+: identity A already holds
    a live membership from the morning dogfood, and the additive per-round reset adds another, so
    the preflight projected-count gate (current + 1 when unreset) correctly refuses to run.
  - **Rejected fix (do not resurrect):** injecting `SWARM_CLOUD_WORKSPACE_ID` invisibly for test
    rounds. It buys passing rounds on a faked premise and makes the harness lie in the flattering
    direction — secretly supplying the very thing the user could not discover. A visible
    "colleague pastes the project id" variant is allowed **only** as an explicitly labeled
    secondary scenario, never R1's main path.
  - **Report rule:** a round that dies at invite with a null default and count > 1 is classified
    **product: multi-workspace selection**, NOT connect-link UX.
- **NEXT: P2-2 — `coswarm status` read surface + WORKSPACE LIST/SELECT** (members + agents +
  tasks + leases, one screen, plain words). The finding above **expands this slice**: workspace
  visibility and selection are now **load-bearing, not nice-to-have**, because listing is the only
  way a multi-workspace human discovers what to pass. Sable's minimal options — **(A)**
  `coswarm workspaces` / `status --workspaces` plus `coswarm use <id|name>`; **(B)** on invite with
  a null default and n>1, interactive select on a TTY and a JSON list under `--json` for agents;
  **(C)** login re-writes the last-used default when it is still live (partial comfort only, does
  not help a cold multi-member after a credential wipe). **A+B together are what §1c asks for.**
  Doing P2-2 also unblocks the harness as a side effect, so there is no real sequencing conflict.
  This is the other half of the felt feedback ("I flew blind").
  - **NON-INTERACTIVE CONTRACT for option B (pinned before the brief is written — Sable).** B puts
    a prompt in the invite path, and P2-1 just hardened agent mode to never hang, so the same
    discipline is mandatory. **Hard rule: never block on a TTY prompt when stdin is non-TTY,
    `--json` is set, or the process is otherwise non-interactive.**
    1. **Resolution order** for `invite` and every workspace-scoped command: explicit
       `--workspace-id` → profile default (if still a live membership) → exactly one live
       membership → if n>1 **and** interactive TTY, optional picker → if n>1 **and**
       non-interactive, **fail closed** with a structured error.
    2. **Non-interactive failure body** (and `--json` stdout): a deterministic machine-readable
       list of `{workspace_id, name, role}` plus one plain-language line pointing at
       `coswarm workspaces` / `coswarm use <id|name>`. No hang, no half-rendered prompt.
    3. **Agents select out-of-band:** list → `coswarm use …` → invite. Do **not** invent a second
       silent env default; `use` is the explicit, inspectable selector.
    4. The interactive picker is a **human convenience only**; tests must cover both the TTY pick
       and the non-interactive fail+list.
    5. Mirror the origin-pin discipline — an unknown multi-member state must never wait forever in
       agent mode.
  - **`coswarm use <id|name>` SELECTION CONTRACT (pinned — Sable).** Workspace names are
    attacker-influencable display strings (we already sanitize them on the accept path, FIX-5
    class), so name-based selection is only safe under strict rules:
    - **Never** slug aliases, prefix matching, or "closest name" resolution. Those are
      confusable-name attacks whose failure mode is **silent wrong-tenant selection** — the worst
      class of multi-workspace bug.
    - An **ambiguous name fails** and lists the collisions; the stored default is left unchanged.
      Selection by **id always works**, including when names collide.
    - `coswarm workspaces` (and any `status` section) shows **name AND full id on every row** —
      never name-only — so a user always has an unambiguous copy-paste target.
    - Required tests: use-by-id; use-by-unique-name; ambiguous name → fail + list, default
      unchanged; id works when names collide; foreign/unknown id → fail with **no profile write**;
      confusable names that sanitize to the same string → treated as ambiguous when both are live;
      `--json` shapes for list and for use-errors (deterministic, no prompt); non-TTY never blocks.
  Then P2-3 agent-skill layer (the §1c endgame: the user's own agent drives coswarm), P2-4 invite
  page + `https://` link form. Same loop: brief → Sable adversarial review → Mason implements
  → Lead verifies by own execution → land → redeploy. Mason + Sable both warm.
- **★ DECISION #84 (operator, 2026-07-24): OPTION A — fix the product, do NOT revoke.** Faced with
  (A) do the expanded P2-2 multi-workspace fix now vs (B) authorize a narrow destructive revoke of
  today's test memberships to get a uxtest pilot round sooner, the operator chose **A**. So: the
  `auth.ts:410` multi-workspace bug is fixed as a real product change, no destructive hosted write
  is authorized, additive-only reset stands, and **the uxtest harness stays blocked until the fix
  lands** — at which point it unblocks as a side effect. Rationale worth preserving: the bug is
  user-facing (any second real collaboration hits it), so fixing it serves users rather than
  merely serving our test rig.
- **OPERATOR ACTION OUTSTANDING:** drive `coswarm accept --link-stdin` as a second human with
  a **distinct verified email** (lesson #5) — the real test of whether P2-1 *feels* simpler.
  Solicit impressions and fold into P2-2+ scoping (§1c is a living calibration datum).

### LEAD3 ACTIVE (2026-07-24, baton accepted at HEAD 7bf5f6f). Slice-2b decomposition:
Lead2 stood down; Lead3 is current Lead. Sub-slices (each: build→green→Kimi K3 review→commit):
- **2b-1 (IN FLIGHT — Mason holds `p1-slice2b-core`):** pure `decideWorkspace` core. Three new
  sibling modules `src/protocol/workspace-{events,commands,reducer}.ts` + index export, mirroring
  the P0 pure pattern. Commands: create_workspace, invite_member, revoke_invitation,
  accept_invitation, remove_member, change_role, create_agent_principal, revoke_agent_principal,
  mint_agent_token, revoke_agent_token (§3.4 table, P1-COMMAND-API.md:399). Unit tests in
  `tests/protocol-workspace.test.ts`. Pure/no-I/O; token material+hashing + atomic invite
  consumption are 2b-2's job. Deferred here: renew_worker_token, repo mapping, landing authority,
  issue/revoke_grant, register/revoke_device.
- **2b-2 (NEXT):** wire decideWorkspace into the `command` Edge Function (projection loader,
  routing, atomic invite consumption under head lock, token material/hash on I/O side); **retire
  `src/cloud/seed.ts` fixture minting**; local integration tests.
- **2b-3:** launch-gate tests T-04 (adds issue_grant/revoke_grant + grant-consumption), T-07
  (needs test hooks), T-08, T-09, T-12.
- **2b-4:** rate limiting §6 + `rate_buckets`; gap#15 auth-admin module + device endpoints.
OPEN FIRST-ACTION: `/remote-control` (operator-supervised remote drive) — I cannot self-invoke
the slash command; surfaced to operator to enable.
- **RENAME (operator-ordered, landed `981db90`):** CLI is now **`coswarm`** (single bin;
  `swarm`/`swarm-cloud` bins killed; keychain `io.ridge.coswarm`, storage key `coswarm-<profile>-auth`,
  headless dir `~/.coswarm/credentials.d` — did NOT touch swarm.* schema, swarm_command/swarm_admin,
  swm_agt_, or spec branding). npm-linked globally. Renamed inside the zero-credential window.
- **TODAY'S GOAL (operator, 2026-07-24 AM): two humans connect their agents cross-internet
  via hosted coswarm, ASAP.** 2b-2 re-scoped to the CONNECT LOOP only: Edge-fn wiring +
  CLI verbs for invite_member / accept_invitation / create_agent_principal /
  mint_agent_token; deploy hosted; live 2-human E2E. Deferred to after: remove/change_role
  + revoke wiring, rate limiting, devices, T-04..12, create_workspace wiring.
- **★ 2026-07-24 ~10:31: TODAY'S GOAL ACHIEVED — TWO HUMANS' AGENTS CONNECTED ACROSS
  THE INTERNET VIA HOSTED COSWARM.** Full governed chain, operator-driven, verified at
  the event level: see `docs/evidence/p1-two-human-connect.md` (uids, seqs, event ids,
  7 field lessons, residual notes). Human A `d37e2ff2` (mini) invited; human B
  `919ce195` (M1 Max, distinct-email GitHub) accepted invitation `345ad183` (seq 7/8);
  B's principal `laptop-agent` `5103ae10` minted the FIRST governed agent token on
  hosted and ACQUIRED A's task `first-connect` (seq 12 `LeaseAcquired`, triple-stamped).
  E2E gate LIFTED post-achievement → Mason begins ux-connect-polish (bugs #1–#6 +
  Kimi 2b-2 FIX-1/3/4/5, decisions #81). Then 2b remainder: revoke wiring (+ fixture
  token cleanup #79d, epoch-binding enforcement), rate limiting §6 (Kimi FIX-2),
  T-04..12, auth-admin/devices.
- **STATE 2026-07-24 ~10:00: CONNECT LOOP LIVE ON HOSTED.** 2b-1 landed `10d6d0a`
  (Kimi FIX(7) all folded + pinned, 66/66); 2b-2 wiring landed `8b4bc1a` (Lead-verified
  66/66 + CLI 14/14 + server 10/10 on live local stack); migration
  `20260724000001_connect_loop.sql` APPLIED to hosted; Edge fn DEPLOYED to hosted
  (canary good). Tasks p1-slice2b-core + p1-slice2b-connect closed merged. **Method
  deviation, recorded:** 2b-2 committed+deployed on Lead review + test pinning BEFORE the
  Kimi verdict (operator ASAP directive); Kimi fast-follow review in flight
  (`scratchpad/kimi-2b2-review.log`) — findings = immediate fix pass + redeploy.
  **AWAITING:** operator leg-1 (coswarm login + invite), human-#2 designation, Kimi
  verdict. **QUEUED after E2E:** revoke fixture-era seeded null-bound agent tokens (#79d);
  fold operator CLI-feel impressions into P2/P3 scoping (§1c).
- **Decision #78:** invitationMatchesIdentity oracle DELETED (contradicted decision #13 —
  acceptance ignores email; forwarded capability links valid for any verified holder BY
  DESIGN). consumed_by binds from ctx actor only. Forwarded-invite is a positive test.
- **Decision #79:** projection WorkspaceAgentToken.task_id/epoch loosened to nullable
  (must represent legacy null-bound seed rows); mint command/event stays required (#77).
  Fixture-era seeded tokens get revoked once connect-loop is proven on hosted.
- **Decision #80 (connect-loop wiring, a–f):** invites hardwired role=member, TTL default
  24h cap 7d; normalized email stored on swarm.users at login bootstrap (best-effort
  invite-time check; real guard = accept-time user_id); agent_runs row created at MINT
  time server-side (same tx, bound to principal + authenticated device from stored login
  profile) — principal create returns principal_id only; default mint scopes = the 8 P0
  task commands, no --scope flag; raw token/invite material is a fresh-response-only
  adjunct (never StoredResponse/ledger/audit/events; replay omits it; lost delivery →
  mint anew); accept failures are outwardly UNIFORM (unknown-hash = audit-only 403;
  valid-hash expired/consumed/revoked commit internal domain rejection but return
  identical status+body — no-enumeration).
- **Decision #77 (2b-1 interfaces):** accept_invitation carries `{token_hash}` ONLY (no
  invitation_id — client must not steer row selection); remove/change_role take optional
  `landing_authority_successor_user_id` + injected `landingAuthorityChangeResolved` oracle
  (unresolved → domain 'landing_authority_unresolved'); mint_agent_token REQUIRES
  run_id/task_id/epoch (no broader binding offered in P1), ttl_ms default 1h / hard cap 8h;
  §2.3 denylist is INTRINSIC (hardcoded in pure module), humanRights(actor) is injected.

## 0d. ROTATION 2026-07-24 ~20:00 (Lead4 -> Lead5). READ THIS FIRST.

Lead4 rotating at a clean boundary: everything landed and pushed, tree clean, HEAD `a62823a`,
round 1 blocked only on a **human action on the laptop** (below). Nothing is mid-file.

### What shipped under Lead4
- **ux-connect-polish** (`87e41cf`) + hosted fn **v4** — felt-dogfood bugs #1-6 + Kimi minors.
- **P2-1 `coswarm accept <invite-link>`** (`a823ab3`, evidence `80a1095`) + hosted **v5**. One command
  collapses login->accept->principal. Decision **#82**: the verb is `accept`, NOT `join` —
  `SWARM-CLOUD.md:696` locks "members accept invites; agents join swarms". Decision **#83**: optional
  `--name`, link-mode only. Live proof the origin pin works in the shipped binary: a link with
  `url=https://evil.example.com` is refused **before login**.
- **P2-2 `coswarm status` / `workspaces` / `use`** (`053e972`, evidence `10bf782`) + hosted migration
  `20260724000002`. Fixes the **MAJOR** multi-workspace bug (`auth.ts:410`) the harness found before
  it ever ran a round.
- **★ Second root cause of bug #3, found at deploy time:** hosted PostgREST never exposed
  `swarm_read`, so every CLI read returned 406 and `discoverSoleWorkspace` swallowed it — workspace
  discovery had been failing **invisibly on hosted since slice 3**. Fixed by
  `PATCH /v1/projects/{ref}/postgrest`. **Never `supabase config push`** — see §3 landmine.
- **uxtest cross-machine UX harness** (`9d4fde0` + 6 hardening commits through `a62823a`).

### The harness: ONE human action away from round 1
State: preflight passes all gates; fresh hosted workspace **`uxtest-r1-92cb361a`** seeded (additive);
both machines on identical bundle `f12b47b8...`; Human1 logged out; **Dana** (launcher) live on the
laptop in cmux. Blocked on the **GUI-ORIGIN RULE** — run this **inside Dana's laptop cmux tab**:

```bash
UXTEST_HOME_ROOT=/Users/tom/uxtest \
  /Users/tom/Developer/Ridge.io/cloud-swarm/uxtest/scripts/serve-human2-gui.sh launcher
```

**★ CORRECTED 2026-07-24 (Ferry, verified by Lead5 against the files) — THE SEQUENCE BELOW WAS
WRONG AND WOULD HAVE DIED ON ITS FIRST COMMAND.** `preflight.sh 1` cannot run first for round 1.
`uxtest/rounds/1/setup.json` already exists from a **half-finished pre-`502b103` reset**
(`reset_started_at` set, `reset_complete: false`) and is missing the three keys that commit added.
`preflight.sh:196` gates its cold-state block on `[ -f "$setup" ]` — the file exists, so the block
**runs** and dies at `:206` on `human2_reset_via != dana-a2a-gui`. Those fields are written **only**
by `reset-round.sh:210-225`, *after* Dana's GUI reset returns its artifact — so that block is a
**post-reset assertion** that only passes pre-reset on a virgin round. Round 1 is not virgin. It was
never caught because preflight dies earlier at `:119` on the launcher gate. Also missing below:
`launcher-channel-up.sh` stands up the mini UxDriver on 18792, which `reset-round.sh:31` requires.
**CORRECT ORDER:** `launcher-channel-up.sh` → `reset-round.sh 1` → `preflight.sh 1` (now as
post-reset verification: version skew, cold keychain, cold sidecars, membership snapshot) →
`launch-human2.sh 1` → `channel-up.sh 1` → `launch-human1.sh 1` → round → `collect-round.sh 1`.
**Do NOT delete `setup.json` to make preflight pass first** — `reset-round.sh:33-41` reuses
`workspace_id`/`workspace_name` from it, so deleting abandons the seeded `uxtest-r1-92cb361a` and
seeds a second workspace. Additive-safe, but it discards state for cosmetics.

*(superseded original:)* rerun `preflight.sh 1` -> Dana drains its queued inbox instruction and does the Human2 logout
(`coswarm logout`, local scope only — **never `--all-devices`**, it would revoke identity A) ->
`launch-human2.sh 1` (spawns virgin `Dana-r1`) -> `channel-up.sh 1` -> `launch-human1.sh 1` ->
round runs -> `collect-round.sh 1` -> write `rounds/1/REPORT.md` with the **mandatory §7.7 validity
header**.

### Credentials + identities (already in place, verified)
- `~/.config/uxtest/cloud.env` — `DATABASE_URL` (0600 in 0700). Provided by **Anvil** (the Hermes
  A2A agent on the mini, registered in cloud-swarm). **Lead4 verified it three ways** — file shape,
  URI parse (session-mode pooler on **5432**; the landmine warns 6543 needs `prepare:false`), and a
  live connection. **Never print the value; source the file.**
- `~/.config/uxtest/round.env` — `UXTEST_HUMAN1_UID`, `UXTEST_HUMAN2_EMAIL`, `UXTEST_OAUTH_CONSENT`.
- Identity **A** (mini, owner): `d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc` / `tom@ridge.io`.
  Identity **B** (laptop, member): `919ce195-4e19-4c89-852b-8f09a4b556d9` /
  `tom.langridge@mediafire.com`. Distinct verified emails — field lesson #5.

### Fleet
- **Quill [codex]** — implementation worker, fresh (replaced Mason at 14 compactions / ~24h; see
  **§0c worker rotation hygiene**, which applies to workers too, not just the Lead). Warm, idle.
- **Sable [grok]** — adversarial reviewer, in a **visible cmux tab** (operator directive: reviewers
  are tabs, never headless one-shots — a headless Kimi run hung ~2h with zero output). Warm. It has
  caught a phishing vector, a false-success path, an unbuildable rule of mine, and a wall-clock
  cheat. **Route every brief through it before implementation.**
- **Atlas [claude]** — research. Delivered `docs/research/AGENT-ORCHESTRATION-UX.md`. **IN FLIGHT:**
  `docs/research/ACP-AND-BUZZ.md` (operator asked "can we do ACP how Buzz does it?"). Collect it.
- **Dana [cmux/claude-code, laptop]** — Human2 launcher, spawns virgin `Dana-r<n>` per round and
  stays out of rounds. Reachable **only** via A2A (18791), never SSH.
- **Anvil [a2a]** — Hermes provisioning agent, holds 1Password. Demand **strict single-JSON**
  replies and verify independently in both directions.

### Operator asks still open
1. The GUI command above (only a human/GUI agent can run it).
2. Drive `coswarm accept --link-stdin` personally as a second human — the felt test of whether P2-1
   is actually simpler (§1c is a living calibration datum, not a one-time note).
3. Read `docs/research/AGENT-ORCHESTRATION-UX.md`; Atlas's sharpest finding is that **nothing** in
   ~100 orchestrators scores well on multi-human AND visibility simultaneously — that intersection
   is our gap, and it is not a UI gap.

## 1b. Governing steer (operator, 2026-07-23) — READ THIS BEFORE SCOPING ANYTHING

**Swarm is primarily about coordination — keep it that way** (the Workbench.md
posture). P1/P2 authority machinery is **scaffolding for** the coordination payoff at
P3 (advisory reservations, messages, board), **not the product**. Build each phase to
the *minimum that unblocks coordination*, not the maximum the spec permits. When a
choice is genuinely ambiguous, prefer the smaller thing that reaches dogfooded
coordination sooner. Resist the pull toward building a general-purpose authority
platform — that is how this drifts into infrastructure nobody asked for. (Applied
already: SPEC GAPS #18 defers snapshot bootstrap to P3, #3 defers claim kinds to P2 —
both real, neither is coordination.)

## 1c. Product vision steer (operator, 2026-07-24, verbatim-adjacent) — governs P2+ scoping

The operator articulated WHY they want this product. Record kept here so every future
Lead scopes against it (it strengthens and extends §1b):

**Why (differentiators):** multiple subscriptions, not API fees (each human brings their
own agents/subscriptions — matches §2.10 per-human-coordinator topology); model inversion
(cross-model adversarial review) + model fusion (cross-model planning/consensus) as a
product capability, not just our build method; frontier harnesses; visibility of each
agent's work; full-swarm on-the-fly tuning/steering while the operator is looking.

**Wants:** human vibing (agents handle tasks/tracking); coordination with project
collaborators; agent-to-agent messaging; org-structure understanding / communications
routing; work visibility (tasks/goals/areas of focus); shared knowledge; "run the
business together"; **map the surface areas and work areas (related repos, related
infrastructure)** — the infrastructure-surface mapping is genuinely NEW vs the spec
(repo mapping §2.11 covers repos only); park as a P3+ design question.

**Interface ruling:** CLI is the NOW interface, not the endgame (Devin-Desktop-like app
or web UI later — collaborators are CLI-native today, so CLI first). **Near-term north
star: nail HUMAN-DRIVEN swarm-to-swarm project coordination with exceptionally great
onboarding + CLI UX.** Appendix C (operator UX spec) is elevated accordingly.

**★ FELT-DOGFOOD FEEDBACK (operator, 2026-07-24, immediately after driving the two-human
connect — THE §1c calibration datum; every P2+ scope decision answers to this):**
1. "**A lot of steps** — I'd like it much simpler. Driving this process **via an agent**
   would help a lot, via skills or something — I don't really want the end user to need
   to do much via terminal."
2. "I **didn't really know what I was doing or why** — I don't understand why there were
   multiple steps; it all felt very technical."
Lead3 reading: (1) = Appendix C §1.c ("connect your agents — the crux") + §2.10
coordinator-as-driving-interface, now operator-confirmed: the END USER's own agent should
drive login/accept/principal/mint; the human states intent ("join Tom's swarm"). (2) =
comprehension-before-commitment (Appendix C invite-page principle) must extend to EVERY
command's output: say what just happened and why in plain language, or collapse the step
entirely. Steps that can't explain themselves shouldn't exist as user-facing steps.

**NEXT PHASE (P2-connect-UX, scoped from the feedback — successor Lead executes):**
1. **`coswarm join <invite-link>` — ONE command** collapsing login→accept→principal
   (auto-named from hostname/user)→ready; each internal step narrates itself in one
   plain-language line. Mint stays automatic at first agent work (already server-side).
2. **Agent-skill layer:** a distributable skill (SKILL.md pattern) so the user's OWN
   coding agent (Claude Code/Codex/any) drives coswarm — the human says "join <link>" /
   "what's happening in the workspace" in their agent chat; the agent runs the CLI.
   This is the §1c "multiple subscriptions" model made real and the endgame for
   "end user shouldn't need the terminal."
3. **Read surface:** `coswarm status` (members+agents+tasks+leases, one screen, plain
   words) — comprehension requires visibility; the operator flew blind today.
4. Invite link carries the workspace context (no --workspace-id anywhere user-facing);
   invite PAGE (even a minimal hosted one) tells the invitee what/who/why in 30s.
DEFER still: rate limiting (before any external collaborator), revoke wiring, T-sweep —
sequence per successor's judgment against §1b (smallest thing that reaches coordination).

**Sequencing implication (Lead3 reading):** slice 2b stays (invite/accept/principals/
tokens ARE the swarm-to-swarm onboarding substrate). After 2b, P2 scoping should target
the minimum two-human coordination loop E2E — second human onboards via invite page →
accept → both see membership/tasks/messages — ahead of deeper authority machinery
(remaining T-13–T-25 sweep, artifact plane, knowledge plane trail behind that loop).

## 1d. ★★ COMMUNICATION-FIRST STEER (operator, 2026-07-24 late) — RE-WEIGHTS P3, OVERRIDES THE RESERVATION CUT

**The most consequential steer since §1c. Read it before scoping any P3 work.** It arrived while
the Lead was about to ask which *grain* advisory reservations should use — and it moots the
question, because reservations at any grain double down on the structure the operator is
questioning.

### What the operator said (transcribed, lightly de-garbled)

- **"I'm honestly concerned that we're still imposing too much structure on this. The majority of
  what we should be doing is facilitating communication."**
- **"Tasks are in themselves a type of communication"** — of the things to be done and the steps;
  who is working on what; where it came from; what it relates to; who owns it, who created it,
  who is responsible, who will test it.
- **"The more structure we impose in the system, the more rigid it is, and the less simple it is
  to navigate and utilize."**
- **"What does that mean for tasks and leases? I don't know. Maybe they're entirely unnecessary in
  actuality, because the code lives in Git."**
- **Topology, stated plainly:** swarms coordinating *across the internet* — one swarm on one
  machine (or several), another swarm on a different machine, therefore **operating in different
  local git repositories**. Built for software development and operating internet businesses.
- **What agents actually do all day:** interact with APIs, CLIs, and local git repos; create PRs;
  review others' PRs; work with GitHub and GitHub issues.
- **The real need:** *"there needs to be some communication of order of operations as agentic
  engineering swarms are hopping and dancing around a codebase, but each in their own local
  environments… they need to be communicating what they're changing so that **if necessary — and
  in many cases it won't be necessary** — they'll know to maybe review or merge or hold a PR, or
  wait for something on the other end of the swarm to be completed before they move on."*
- **Cross-pollination:** *"they might suggest something to work on that's related to what they're
  working on that they maybe don't have time to get to."*
- **Scale picture:** PromptEden is on **train S of Q5** today — five things queued, S trains of PR
  merging and releases. *"And that's just my swarm. So what happens when I have Calvin doing the
  same thing on his side and Charlie doing the same thing on his side?"*
- **★ The thesis:** *"The whole point of coswarm is to let agents communicate with each other what
  they're doing and share context, share plans, and to facilitate that level of communication to
  the benefit of the other swarms — but also occasionally communicating human to human."*
- **Human-to-human examples:** *"I might want to let Calvin know I'm working on this, or shifting
  my attention to something that came up in [Sentry]"*; *"I might want to let Calvin know I think
  we should focus on marketing, or Calvin might let me know he thinks we should focus on the
  reliability of the monitors extraction system, and that he'll move on to onboarding next."*
- **Persistence:** *"All of this team coordination and tracking can happen in coswarm and be stored
  in the cloud so that between swarm sessions there can be some persistence across time and space."*
- **The delegated question:** *"How important are leases and tasks? I guess it might be important
  to lease a subsystem or something. I don't know. **Maybe you can figure out what the shape is of
  the tools that are actually useful here.**"*

### Lead5's reading — five rulings

**R1. The authority machinery was built for a different topology than the one we are selling into.**
A lease prevents double-writes to **shared mutable state**. The *local* swarm genuinely has that:
one machine, one worktree, N agents. **Cross-swarm does not.** Each swarm holds its own clone; the
only genuinely shared state is **GitHub**, which already has concurrency control — branches, merge
conflicts, PR review, rulesets. A lease held across two clones protects nothing that git does not
already protect at merge time.

**R2. §0's own ethos already draws the correct line, and the reservation slice was on the wrong
side of it.** *Friction is justified only by irreversibility.* Code work is **reversible** (revert,
PR review, branch protection) → awareness, never locks. **Deploy / release / prod migration is
irreversible** → that is where hard authority belongs (§2.10 mediated apply). P3-1 proposed adding
soft-state machinery to the *reversible* side. That is backwards by our own stated rule.

**R3. An advisory reservation is a message with machinery bolted on.** Strip TTL, epoch binding,
holder derivation, fencing and auto-clear-on-lease-release, and what remains is: *"I'm working on
X until roughly Y."* That is a **signal**. Even the operator's own "maybe lease a subsystem" case
resolves to advisory: the right response to *"Calvin is refactoring extraction"* is **judgement,
not refusal** — the other party may hold an urgent Sentry fix in that subsystem. **A loud,
well-addressed notification beats a lock**, because the correct action is context-dependent and
only a human or a well-informed agent can pick it.

**R4. GitHub holds the artifacts; coswarm holds the intentions.** For anything GitHub already
models — issues, PRs, reviews, releases — coswarm **references, never replicates**. Coswarm's
unique job is the layer GitHub lacks: **real-time cross-swarm awareness of intent and attention,
between agents that do not share a repo.** This is §1b's "don't drift into infrastructure nobody
asked for" given a concrete, testable edge.

**R5. What survives from P0/P1 — nothing is thrown away, the priority order changes.**
*Load-bearing for **any** cross-swarm product, including a pure message plane:* identity, tenancy,
memberships, invitations, principals, agent tokens, audit, revocation. Keep all of it.
*Over-built for cross-swarm:* the task/lease command state machine (acquire / renew / handoff /
takeover / fence). It is **not wasted** — it is the *local* swarm's proven model and may still
serve **within** a swarm — but it is **not the cross-swarm coordination primitive**, and it should
stop being treated as the thing P3 extends.

### RULING

**P3-1 (advisory reservations) is PARKED, not cancelled** — see §4. **The message/signal plane
becomes the head of P3.** Note this does **not** contradict §1b, which already names *"advisory
reservations, messages, board"* as the P3 payoff; it **re-weights which of the three comes first**,
on the operator's explicit instruction.

**★ And note the irony worth remembering:** we found `swarm.inbox_deliveries` as an empty shell and
concluded messages were *expensive*, so we deferred them and prioritised reservations. The shell
was a **signpost**, not a warning. We deferred the only thing that mattered.

### ★ R1 NIT THAT BELONGS IN THE PITCH (reviewer, accepted)

*"Git already handles concurrency"* is true for **code** and false for **attention**. Two swarms
can waste a full day on the same PR **without ever colliding in git**. Merge conflicts are not the
waste signals prevent — **duplicated and misdirected effort is.** Do not let R1 be heard as "git
makes coordination unnecessary."

### ★★ P3-1 = THE SIGNAL PLANE — SHAPE PINNED (adversarially reviewed 2026-07-24)

**v1 schema. Anything not listed is OUT.**

```
{ id, from, to?, about?, kind, body, until?, created_at }

kind ∈ { working-on, note, ask }     // exactly three; see below
from    server-bound from the credential — a client can NEVER set or spoof it
to      null = workspace broadcast; else member user_id / principal_id
about   OPAQUE string, capped. URLs are a CONVENTION, not a parsed type. No GitHub sync.
body    untrusted data, capped, control/bidi/ANSI stripped, never model instruction
until   ★ SUPERSEDED — see `docs/design/P3-1-SIGNALS-BRIEF.md` §1.2, which is NORMATIVE.
        This line said "`working-on` ONLY"; the brief revised it to EVERY KIND HAS ONE
        ("`until` IS the lifecycle — this is why there is no close verb"), with per-kind
        defaults, and the shipped code matches the BRIEF, not this line. Do not build from
        the text above. Staleness stays a read-time predicate; stale renders as "expired",
        never deleted, never enforced.
```

- **★ `kind` is a THREE-value enum — the central design tension, resolved.** Free tags lose:
  unqueryable, unrenderable, and agents invent private dialects until the product dissolves into
  chat. A fat enum also loses: it is the structure tax §1d warns about, and it bikesheds forever.
  **`working-on`** = active intent · **`note`** = heads-up / fyi / steer / plan, one bucket ·
  **`ask`** = needs a response. **`heads-up`, `steer` and `fyi` are TONES, not TYPES** — the human
  writes tone in the body. Add a fourth kind only when a **read path requires the distinction**.
- **★ NO `state` FIELD DAY ONE.** Posts are immutable with `created_at`. No `open|acked|resolved`
  machine. Requiring acks on `working-on`/`note` is notification spam plus structure tax. An
  `acked_at` for **`ask` only** may come at v1.1 if a needs-you loop earns it. **§2.13's Buzz acks
  are DELIVERY transport, not social "resolved"** — do not conflate the two.
- **★ NO THREADS OR REPLIES.** The operator's examples are short intention signals with optional
  subjects, not conversations. Threading is structure; one-shot posts plus a feed is the shape.
- **Two reads, not three:** `coswarm feed` (what's happening — non-stale) and `coswarm inbox`
  (`to` = me / my principals). The subject query is **`feed --about <url>`, a filter, not a third
  verb.**

**★ THE FLOOR — below any of these it is not a product, it is Slack with an extra login:**
1. Tenant-scoped post + read (membership gate), never a public channel
2. An **agent** can post and poll **without a human terminal ritual** (CLI + `--json`)
3. Persistence across session death
4. Addressing: workspace-broadcast + optional human target
5. Subject hook: optional opaque `about`
6. Untrusted body (pin 5) + rate/fairness (pin 13)
7. Two reads: feed + inbox

**★ THE COLLAPSE TEST — the four differentiators are sacred; drop ONE and "just use Slack" wins:**
**agent-addressable · machine-queryable · tenancy-scoped · survives session death.** Plus one the
reviewer added: signals ride the **same identity/principal model as the agents themselves** — "who
said it" is an **auditable principal**, not a Slack display name. Compete with GitHub on nothing
(R4), and with Slack on human banter never.

**Pins transferred (11 of 14):** 1 tenancy (critical) · 2 read-time horizon (`until` only) ·
5 untrusted body (**most important — bodies ARE the product**) · 6 rendering · 7 no-prompt/`--json` ·
8 audit on post · 9 idempotency via pending `command_id` · 11 hosted read canary before believing
an empty feed · 12 narration (post echoes what was recorded) · 13 rate/fairness
(**launch-gate level** — multi-org spam) · 14 no pub/sub, poll.
**Dropped:** 3 holder/epoch binding · 4 advisory-never-blocks (vacuous once nothing blocks) · 10.
**Added by review:** **15 — no GitHub replication** (`about` stores a string; never sync issue
state) · **16 — server-bound `from`** (authorship unspoofable) · **17 — the collapse test is an
ACCEPTANCE criterion**: a feature serving none of the four differentiators gets cut.

**OUT of v1, explicitly:** state/ack machine · kind explosion · typed GitHub refs · threads ·
pub/sub · agent-to-agent fine addressing · board UI · **the local-swarm auto-bridge**.

**★ LOCAL `swarm task` → auto `working-on` BRIDGE: HELD for v1 (opt-in at v1.1).** Tempting —
free awareness from a model PromptEden already runs daily — and rejected day one for five reasons:
local task churn becomes a cross-org feed firehose (a pin-13 crisis); local task titles are often
low-signal (*"fix tests"*, *"wip"*); auto-emit couples two planes, so local flakiness looks like
coswarm being broken; silent auto-posts recreate §1c's "didn't know what or why" **for the
recipients**; and it reimports the task model into the plane we just simplified. **v1 = a human or
agent explicitly posts.** v1.1 may add an opt-in bridge with allowlist, rate limit and
draft-then-confirm — **never default-on.**

## 2. Method

Build **phase by phase**, each phase: **build → test (green) → model-inversion
review (Kimi K3) → integrate findings → commit** (evidence-gated completion; a
"done" claim needs the artifact — passing tests, a commit SHA). Use **ultracode /
the Workflow tool** for larger phases (fan-out implementers + adversarial
verifiers) — the operator has opted in for this project. Externalize state
continuously (this file + commits) — assume your session can die at any moment.

## 3. Ground facts

- **Repo:** `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` → **remote is
  `Ridge-io/cloud-swarm` (private)**. Note the hyphen: `Ridge-io` is the **org** (team
  plan, where the PromptEden repos live); `Ridgeio` is a free **user** account where
  private-repo rulesets are impossible (403 "Upgrade to GitHub Pro"). The repo was
  created under `Ridgeio` by mistake and transferred; **never target `Ridgeio`.**
- **Ruleset (active):** `swarm-1human-main` (id 19616931) on `refs/heads/main` —
  `deletion`, `non_fast_forward`, `required_linear_history`. `bypass_actors: []`.
- **LANDING POLICY — operator directive, 2026-07-23 (overrides the spec's stricter
  reading):** **the Lead MAY merge PRs and MAY push directly to `main`.** A
  `pull_request` rule was briefly applied and has been **removed**: requiring a PR to
  land your own reviewed work is friction on a *reversible* act (a squash merge is
  `git revert`-able), and §0 says user-facing friction on a reversible act is a bug.
  Do **not** re-impose human-only landing, PR-required, or similar ceremony on the
  Lead. What stays hard is what is genuinely irreversible: **force-push, branch
  deletion, and non-linear history remain blocked** — that is the §0 line, correctly
  drawn. Treat this as standing policy, not a one-off exception.
  (§3's required pre-landing check is a P2 deliverable and does not exist yet.)
- **GitHub App (P0-github, done):** `Swarm Coordination` / slug `swarm-coordination`,
  owned by `Ridge-io`. App ID **4375227**, Client ID `Iv23liD2OXYNeF59mab1`,
  Installation ID **148509807**. Permissions are **read-only** on exactly five scopes
  (checks, statuses, contents, metadata, pull_requests); 0 write. Webhook **disabled**
  (no endpoint until P1). Installed on **`cloud-swarm` only** — not on any PromptEden
  repo. **No private key has been generated yet** — generate it at P1 when the webhook
  needs to authenticate, and have Anvil store it in 1Password (never on disk).
- **Supabase (P1 provisioning):** project `cloud-swarm-dev`, ref
  **`ukezjcnxjvkpkeezxaew`**, region `us-east-1`, org **`ChartingAlpha`** (the paid org —
  the `*-Free*` orgs are junk parking orgs, per operator; do not use them). Costs
  ~$10/mo per-project compute (Micro rate), operator-approved. Secrets live in the
  1Password item **`Supabase — cloud-swarm-dev`** — never in the repo, never in a
  model-visible file. (An earlier ref `pgbblnyljguyfckhdnid` was created in the junk
  `ChartingAlpha-Free2` org and has been **deleted**; it was empty. Ignore it if you
  see it referenced anywhere.)
- **★ ERROR CLASS: testing output that contains more than the thing you meant to test
  (2026-07-24).** Five observed instances, all the same shape — a probe whose output
  carried extra material, read as if it carried only the signal:
  1. `git show --name-only <sha> | grep docs/research` → matched the **commit message**, which said
     "docs/research/ deliberately excluded". Read as a file-path violation. Use
     `git show --name-only --format=""` when you want paths only.
  2. `command -v cmux` under **non-interactive SSH** → "not found" on a machine where the binary
     exists at `/Applications/cmux.app/Contents/Resources/bin/cmux`. Both Lead and a laptop agent
     made this call in opposite directions. A non-login PATH is not evidence of absence.
  3. A hosted REST read returning **`406` (schema not exposed)** was swallowed by
     `if (!response.ok) return null` and surfaced as *"no workspaces"* — an infrastructure fault
     wearing the costume of empty data.
  4. `grep "not a version signal"` missed the doc line because **markdown bold** (`**not**`) broke
     the literal match — concluding a fix was missing when it was present.
  5. **The self-describing artifact (2026-07-24, at the Lead4→Lead5 rotation).** §0d states
     "HEAD `a62823a`, tree clean". Lead5 restated that to the fleet as current state. It was
     false the instant §0d was committed as `a8e2e66` — **a baton commit can never contain its
     own SHA.** The trap is invisible precisely because the artifact was accurate when written;
     staleness is created by the act of recording, not by later drift. Same family as instance 1
     (a commit message describing its own diff). **Read a self-describing artifact as evidence
     about the moment before itself, never about the state after it.** Any state a document
     asserts about its own repo — SHA, tree cleanliness, "nothing in flight" — must be
     re-verified by execution (`git rev-parse HEAD`, `git status`), not quoted.
  **★★ SIX FACES OF THIS ONE ERROR, ALL OBSERVED IN A SINGLE EVENING (2026-07-24/25), by five
  different agents — including four instances AFTER the rule was written down.** Keep the concrete
  faces, not just the principle: the principle is easy to agree with and evidently hard to apply.
  1. **An endpoint that ANSWERS is not an endpoint that DELIVERS.** Lead4's SSH-origin A2A bridge
     served a valid agent-card for ~6h while structurally unable to push into the cmux tab.
  2. **A process with the RIGHT NAME is not the WORK.** `launch-human{1,2}.sh` exited 0 because an
     agent by that name existed, skipping the spawn probe and the `carryover` flip.
  3. **A REGISTRY ENTRY naming an address is not an observation of WHAT SERVES that address.**
     `Anvil [a2a] @ 127.0.0.1:18790` is a pointer at *Yulan's* bridge; reading it as the server
     produced a false "the doc is stale" report that corrupted a correct doc.
  4. **The absence of a LATE artifact is not evidence of NON-EXECUTION.** A missing spawn-state
     *file* was read as "never ran"; the state *directory* (created 71 lines earlier) proved it had
     run and reached line 38.
  5. **A SURFACE THAT EXISTS is not a surface that ACCEPTS.** The spawn retry re-sends keystrokes
     to a surface it never verified is input-ready, so a modal swallows all three attempts.
  6. **★ AN AGENT'S REPORT THAT SOMETHING DID NOT RUN IS EVIDENCE ABOUT ITS TOOL LAYER, NOT ABOUT
     THE FILESYSTEM.** An interrupt landing *after* `exec` is reported to the agent as though it
     landed *before*, and the agent **cannot distinguish those two from inside**. Dana asserted
     "never executed, zero side effects" about a process that had created a directory two minutes
     earlier. **The false negative was unreliable BY CONSTRUCTION, not by carelessness** — which
     matters, because carelessness is fixable by trying harder and this is not. **For any "did X
     run?", go to the filesystem.**
  7. **★ A PARSER THAT CAN READ A FIELD IS NOT A PRODUCER THAT WRITES IT.** The Lead cited
     `storedResponse()`'s conditional `principal_id` handling as evidence that `mint` *returns*
     `principal_id`. That function is a **parser** — it carries the field through *if the stored
     value happens to have one*. It proves only that something downstream would not choke. The
     real mint response omitted it, and a live `coswarm token mint` would have thrown on
     `uuid(response.principal_id)` and never emitted the artifact a whole design rested on.
     Caught in review, before anyone ran it.
  **★★ CITE THESE BY NAME, NEVER BY NUMBER (Ferry, 2026-07-25 — adopted as a rule).**
  The numbers above and below are **LOCAL TO THIS LIST AND ARE NOT CITABLE.** This section and
  `uxtest/findings/2026-07-24-r1-attempt-1.md` already number the *same* faces in *different*
  orders — four of seven collide, so "face 3" today means the registry face in one landed document
  and the process-name face in the other. This section also already contains an unrelated 1-5
  (ERROR CLASS instances) and an unrelated 8. **A FACE NUMBER IS ITSELF A CITATION: it has the
  visual grammar of a reference, it looks checked, and nobody re-derives it** — which is the
  citation face applied to the numbering of the citation face. Use the phrase instead. The phrases
  are self-describing, survive reordering, and cannot silently mean something else in another file;
  nobody has ever misremembered what *"an endpoint that answers is not an endpoint that delivers"*
  meant. **This numbering hazard was caught by the reviewer BEFORE the numbered version reached
  `main`**, on a Lead commit that had already been written.
  8. **A RESTATEMENT IS NOT THE THING; A PARAPHRASE OF A RULE IS NOT THE RULE.** Stated
     normatively in **§0e.5** — see there, not here. (Deliberately a reference and not a summary,
     because summarising it would instantiate it.)
  9. **★ A CACHED ARTIFACT IS TESTIMONY WITH A TIMESTAMP. FETCH BEFORE YOU REV-PARSE.**
     (Lead6, 2026-07-25.) §0g warns that a baton cannot contain the SHA of the commit adding it and
     instructs the successor to re-derive. Lead6 did exactly that — and got a stale answer **twice
     in twenty minutes**, because `git rev-parse origin/main` is an artifact query that faithfully
     answers a question nobody meant to ask: **what does my local ref cache believe**, not what
     origin holds. Both times a worker (Sable, then Ferry) had fetched and was right while the Lead
     was wrong. **The instrument was correct, the reading was wrong, and the successor was following
     instructions** — an instruction defect is worse than an ordinary error because it punishes
     compliance. Fifth independent confirmation in one session that artifacts-beat-testimony is
     incomplete without face-refinement below.
     **★ THE STRUCTURAL RULE THAT OUTRANKS THE TIP — ONE AUTHOR PER DOCUMENT AT A TIME.** The
     rotating-out Lead landed three commits on this file while the incoming Lead was reading it.
     Each was an improvement; together they meant the baton changed three times underneath someone
     with no way to perceive it. Had they touched FLEET or OPEN OPERATOR ASKS rather than a phrasing
     detail, the successor would have run the swarm off a superseded baton having done the careful
     thing. **A document with two writers can disagree with itself and neither writer can see it.**
     Hand content to the current author; do not edit behind them. Same shape as §0e.5 one level up:
     one normative statement per fact, one author per artifact.
  10. **★ A HEADING IS A PARAPHRASE THE AUTHOR DID NOT INTEND AS ONE.** (Lead6, 2026-07-25.)
     The Lead read P2-2's rule title — *"NO NEW AUTHORIZATION PREDICATE"* — and promoted it to a
     universal constraint, then built a whole slice framing on a collision with it. The **body**
     scopes it to membership-gated **read projections**; it never governed founding writes. Sable's
     reductio settled it in one line: the Lead's reading would also outlaw `accept_invitation`,
     **which the system already does**. Face 7 in a fresh costume — right identifier, never read the
     enclosing scope — except the "enclosing scope" was the section the heading sat on top of.
     **Test a rule-reading against an existing counterexample before building on it.**
  11. **★ A CITATION NOT RE-DERIVED IS TESTIMONY WEARING AN ARTIFACT'S CLOTHES — IT READS AS RIGOUR
     BECAUSE IT HAS A COLON AND A NUMBER IN IT.** (Ferry, 2026-07-25, on its own published
     numbers.) Ferry cited `spawn-observed.sh:37/:73/:108`; the true lines are **:38 / :74 / :109**,
     every one low by one. **The mechanism was verified by reading the file; the citation was
     propagated from a message and never re-derived** — so the verification confirmed the *claim*
     while never testing the *pointer that supports it*. Those are two separate acts and this
     program had been treating them as one. **The claim is usually checked; the pointer to it
     usually is not.** Third citation-bite in two days (Lead5's four die-message greps, Atlas
     catching Lead5's spawn-path cite, now Ferry catching Ferry) — which is the fourth confirmation
     of Lead5's own third lesson, *the citation is where you will be wrong, not the reasoning*.
     ★★ **AND THE RESOLUTION, AFTER THIS CLASS BIT FIVE TIMES IN TWO DAYS: STATE THE FACT IN
     GREP-RECOVERABLE FORM RATHER THAN PINNING A LINE NUMBER.** Write *"`operatorAllowed` is
     constructed `() => false` in the production Edge wiring"* — a reader greps the identifier and
     finds it wherever it now lives. A line number is a **coordinate into a moving file**; the
     identifier is the fact. ★ Proven in the smallest possible way: one agent corrected another's
     `cli.ts:1389` to `:1120`, and by the time a third checked, it was **`:1127`** — the corrected
     number had drifted between the correction and its verification. **Nobody was careless three
     times; the coordinate was the wrong thing to record.**
     **Substance survived intact:** preconditions `:36-37`, state dir `:38`, `write_state` `:74`,
     earliest write `:109` — the directory is still created strictly before the file, so a MISSING
     directory means never-started and an EMPTY one means killed-mid-flight.
  12. **★★ A COPY OF A COMMAND IS NOT THE COMMAND. VERIFY THE EXACT TEXT THAT WILL BE EXECUTED.**
     (Atlas, 2026-07-25, after three consecutive revisions of one document each introduced a defect
     of the class the previous one fixed.) C1 fixed → introduced S2. S1+S2 fixed → introduced T1+T2.
     **Every one was verified by its author before shipping**, and one author *reproduced* the bug
     before fixing it. Not carelessness, and not competence.
     **The common factor: VERIFICATION WAS PERFORMED ON THE REASONING, OR ON A STAND-IN, RATHER
     THAN ON THE EXACT TEXT THAT WOULD RUN.** A retyped snippet is a paraphrase. A truth table
     driving `node file.js` is a stand-in for a pipeline that sets the variable as a command prefix.
     Both pass while the artifact fails, because **the defect is in the transcription, not the
     logic** — and every instrument aimed at it was aimed at the logic.
     **T1 lived in the whitespace:** `PRESENT=$(...) \` on a line-continuation prefix scopes the
     variable to the *next* command, so `node` received nothing and the AMBIGUOUS arm could never
     fire — silently restoring the exact defect the revision existed to fix. **The repair was a
     newline.** No amount of reading finds that; it was found by seeding a **non-zero sentinel** so
     a broken construct could not silently agree with a working one.
     **THE GATE THAT FOLLOWS, and it replaces "a reviewer read it and found nothing": RUN THE BLOCK
     VERBATIM — COPY-PASTED, NOT RETYPED — AGAINST EVERY STATE IT CLAIMS TO DISCRIMINATE, AND SHOW
     THE VERDICTS IT ACTUALLY PRINTS.** If a verdict cannot be produced by feeding the literal
     snippet, it cannot be produced in production either.
     This is §0e.5 reaching code — *a restatement is not the thing* — and the citation face one
     turn further: **we kept checking the claim and never the exact bytes that carry it.**
     ★ Companion finding, same review: a snippet querying per-machine state (`swarm members`) ran on
     the wrong machine, while the harness already had both `wait_for_agent_local` (`_lib.sh:276`)
     and `wait_for_agent_remote` (`:293`). **When a helper exists in both local and remote form,
     which one a document reaches for is a correctness property, not a style choice.**
  13. **★★ A RULE WHERE A MECHANISM WOULD DO.** (Atlas, 2026-07-25 — named as the *third costume*
     alongside *a gate that cannot fail* and *a check pointed at the wrong object*.) The first two are
     about **instruments that report wrongly**; this one is about **choosing an instrument that requires
     a human to fire it.** The worktree rule had lived in §1 since before Lead6 arrived and **was broken
     twice in one day by agents who had read it** — while the mechanism that makes it unnecessary costs
     **~126 ms and ~12 MB**. A rule with a 100% compliance requirement and a demonstrated sub-100%
     compliance rate **is not a control.** There was no trade-off to weigh, only a decision nobody had
     made. **The honest counterweight, and it is Ledger's:** the rule *did* fire that day — two agents
     coordinated and a collision did not happen — **it worked because two agents happened to be careful,
     and it bought the time to find the mechanism.** Both are true.
     **THE QUESTION TO ASK OF EVERY RULE THIS PROGRAM WRITES: is there a mechanism that would make this
     unnecessary?** It applies far past worktrees. Ferry's instance is the one to remember: it avoided
     committing to another agent's branch **only because it ran `git branch --show-current` for an
     unrelated reason.** That is the true shape of every rule-based control — **it works until the day
     nobody is idly curious.**
     ★ The costume it wore here: **`dist/` gitignored + no `prepare` script + a global npm link pointing
     into a live checkout** = an installed binary that drifts from source forever with **no error, no
     conflict, and no diff.** "Remember to rebuild after switching branches" is the rule; `prepare` is
     the mechanism. See §0i delta A.
  14. **★★ A THRESHOLD PLACED INSIDE THE INSTRUMENT'S QUANTISATION IS A COIN, AND IT LOOKS EXACTLY LIKE
     A NOISY SIGNAL.** (Ledger, 2026-07-25, on the fourth defect in one gate.) The gate read RED at 33%
     and GREEN at 37% **eight seconds later with nothing freed.** 25 rapid samples of `memory_pressure`
     free% returned **34 or 35 — a spread of one point — against a 35% trip**: 10 RED, 15 GREEN, on a
     machine whose state never changed. **The signal is a quantised integer and the threshold was sitting
     on the value the machine idles at.** No amount of smoothing fixes that; it only changes which side
     the coin favours.
     **THE TELL: if min and max differ by a single quantisation step, the defect is the threshold's
     PLACEMENT, not the instrument's noise.** Fixed by worst-of-3 (fails safe toward do-not-spawn, and a
     genuine dip inside the window still trips) **and** moving the trip 35 → 30 so it separates states
     actually observed — 28-29% under real pressure, 34-37% marginal-but-working for hours, 64% recovered.
     **The trade-off is a real loss, stated plainly: a sustained 32% is now GREEN.** Accepted because a
     gate that reads RED during normal operation gets ignored, **which ends with nobody reading it at all.**
     ★ **The Lead's error here is worth more than the fix:** it handed Ledger a dichotomy — *noise to
     smooth, or signal to keep* — and **both options presupposed the threshold was correctly placed.**
     Ledger checked the thing neither option contained. **A dichotomy from a Lead is still a leading
     question.** Fourth defect in this gate found by measuring rather than designing; fourth the Lead
     did not find.
  15. **★★★ A CHECK WITH NO TRUE-NEGATIVE, PUBLISHED TO A FLEET, AND THE FLEET'S AGREEMENT WAS
     MANUFACTURED BY THE INSTRUMENT.** (Lead6, 2026-07-25 — the last finding of the session and the
     worst one, because the Lead built it while holding the catalogue of this exact class.)
     Lead6 broadcast a one-command dogfood-validity check: `grep -c "use the Supabase project base URL"
     <resolved coswarm path>` — **1 = fix present, 0 = stale.** Measured afterwards against two builds
     of known opposite status:
     ```
     KNOWN-CURRENT build (prepare-built, fix provably present)  ->  0
     KNOWN-STALE build   (the live machine binary)              ->  0
     ```
     **The mechanism: `build` is plain `tsc`, not a bundler.** `src/cloud/config.ts` compiles to
     `dist/cloud/config.js` and is **never inlined into `dist/cli.js`.** The string could not appear in
     the file the check read, under any build. **Correct fix: `grep -rl` over the `dist/` TREE.**
     ★ **FIVE AGENTS RAN IT AND ALL FIVE REPORTED 0** — two machines, three re-derivations, one ACK.
     **Every one was unsupported, and the conclusion was nonetheless correct**, because the binary
     genuinely was stale. **THAT IS WHY IT SURVIVED: a wrong instrument that happens to agree with the
     truth is undetectable by checking the truth.** It is detectable only by running it against a case
     where it MUST answer differently.
     **★★ THE RULE: NEVER PUBLISH A CHECK WHOSE GREEN ARM YOU HAVE NOT RUN.** Lead6 had run only the
     RED arm — every invocation was against a stale build — and published on a perfect record of
     confirmations. **RED-then-GREEN is not a thoroughness preference; a probe validated on one arm is
     not validated.**
     ★ **AND THE SOCIAL FAILURE IS THE EXPENSIVE HALF.** Sable's rule — *convergence is not
     corroboration when reviewers share a blind spot* — applies one level lower than anyone had
     applied it: **these reviewers did not share a blind spot, they shared a broken probe.** Five
     independent seats agreeing looked like the strongest evidence produced all night and carried
     **no information at all.** When a fleet converges, ask what instrument they converged through.
     ★★ **REFINED BY THREE SEATS AFTERWARDS, AND THE REFINEMENTS ARE SHARPER THAN THE ORIGINAL:**
     - **KIND-VALID BUT FACT-BLIND (Vane).** The probe was not wrong in general. **`npm run build` is
       plain `tsc`, so `dist/` mirrors `src/` FILE-FOR-FILE**, and a grep of `dist/cli.js` sees exactly
       those strings that were literally in `src/cli.ts`. **C12's and C0's strings WOULD have been
       visible there; C11's — living in `src/cloud/config.ts` — never could.** So the three ship-3
       fixes are **not equally checkable by the same command**, and the probe was *kind*-valid while
       *fact*-blind. **The RED arm must be run at the level of the specific fact, not the class of
       check.** "I have used this kind of probe successfully" is not evidence it can see *this* fact.
     - **FIVE SEATS, NOT FOUR (Pitch).** Pitch published a `0` from it too, inside the message arguing
       its own findings were validity-immune. **That argument stood on a git diff and needed no grep at
       all** — but the worthless line was published as supporting evidence, **and a prop is what a
       hurried reader quotes.** A sound argument with one fabricated-looking prop still needs correcting.
     - **RE-RUN CORRECTLY AND THE CONCLUSION HOLDS (Ferry).** Tree-wide, both machines, both harness
       copies, **with a source positive control proving the probe CAN return a hit**: source 1, every
       built tree 0. **Same answer, and only the second version is evidence.** The item is CLOSED, not
       pending.
     ★★★ **AND THE MOST DISTURBING DATUM IN THIS ENTIRE SECTION, WHICH IS FERRY'S:** ninety minutes
     before running the broken probe, **Ferry had discovered and written down the exact fact that makes
     it broken** — *"`dist/` is PER-FILE, not a bundle — a count taken from the wrong file in a
     directory of the right name"* — caught in the swarm repo, reported, and then **committed the
     identical error against a different `dist/` an hour later.** Pitch has the mirror instance: it had
     just authored the rule *"an unexpected pass is evidence about the instrument"*, and that rule has
     **no coverage for a broken instrument whose answer is correct.**
     **CONCLUSION, AND IT IS UNCOMFORTABLE: NAMING A FAILURE MODE DOES NOT IMMUNISE ANYONE AGAINST IT,
     AND HAVING RECENTLY PAID FOR IT APPEARS TO PROVIDE NO PROTECTION AT ALL.** This section is
     therefore **not a defence** — it is a catalogue for recognising the damage afterwards.
     ★★★ **AND THE CLOSING LINE, CORRECTED BY FERRY INTO SOMETHING BETTER THAN THE LEAD WROTE.** Lead6
     wrote: *"the only thing that has worked all session is a second seat running the discriminating
     case."* Ferry: **"it is not that a second seat is RELIABLE — it is that two seats fail DIFFERENTLY,
     and THE DISAGREEMENT IS THE INSTRUMENT."** Atlas's clean zeros came from an empty process table;
     Ferry's came from a filtered file. **Identical signature, different cause, and either agent alone
     would have believed them.** That version is strictly better because it **explains why the second
     seat helps and predicts when it will not: two seats sharing a probe fail IDENTICALLY** — which is
     this face. **Redundancy is worthless; divergence is the whole mechanism.**
  16. **★★ A FILTER APPLIED BEFORE A SEARCH IS A HYPOTHESIS YOU CAN NO LONGER FALSIFY.** (Ferry,
     2026-07-25 — the cause of three of its own six failed isolation measurements.) Ferry captured
     process environments through `grep -E "^(PATH|CLAUDE_CONFIG_DIR|UXTEST_)"` **and then searched the
     filtered file for homebrew.** The Figma space splits `PATH` into two tokens; the filter dropped the
     continuation fragment — **the exact fragment containing `/opt/homebrew/bin`.** Every run reported
     `homebrew: 0`. Re-run against the full token stream: **`homebrew=1` on all three.**
     **THE SIGNATURE IS THE PROBLEM: an empty measurement and a real negative are identical at the
     output, and the pipeline SUCCEEDS**, so there is no stderr to read and no exit code to check. The
     filter encodes what you already believe is relevant, and anything it drops becomes unfindable
     **without ever being reported as missing.**
     ★ **THE DEFENCE THAT WORKED, and it was not more care — it was a SECOND SEAT CONTROLLING ONE LEVEL
     LOWER.** Six attempts failed. Ferry's own positive controls all tested its PARSER. Pitch supplied a
     control for **"is there any env here at all"** — testing ACCESS — and it came back `HOME=1 USER=1,
     70 tokens`, which made the absence of `CLAUDE_CONFIG_DIR` a **real negative** rather than an empty
     extraction. **From inside, all six failures looked like parsing failures and three agreed with each
     other.** Companion to face 15: **capture wide, filter at read time.**
  17. **★★★ A CONTROL IS ONLY VALID FOR THE CLASS OF SUBJECT IT WAS RUN AGAINST — AND A CONTROL CAN BE
     VACUOUS EXACTLY THE WAY A GATE CAN.** (Ferry, 2026-07-25; verified independently by Lead6 on the
     mini, same host, same minute, both arms.)
     ```
     ps -Ewwp <claude pid>   ->  66 env tokens, HOME=1    <- env IS readable
     ps -Ewwp <sleep pid>    ->  0 env tokens             <- env NOT readable
     ```
     **One host. Opposite answers. macOS withholds the environment of SIP-protected platform binaries**
     — `/bin/sleep` is one; `claude`, a node binary under `~/.local/bin`, is not. **Every readability
     probe built on `sleep`, `env`, or any `/bin` or `/usr/bin` tool returns a STRUCTURAL zero and has
     no way to know it.**
     ★★ **THIS MAKES THE ACCESS CONTROL OF FACE 16 ITSELF VACUOUS WHEN MISAIMED.** *"Is there any env
     here at all"* is the right question, and **asked of the wrong process class it answers NO on a host
     where the answer is YES.** Apply the gate test to the control: **is there any state under which
     this returns a hit?** Against a platform binary — **no.** A control that cannot come back positive
     is not a control, and it is **indistinguishable from a rigorous one** in the write-up.
     ★★★ **AND THE TRAP INSIDE THE TRAP: FERRY RAN A TWO-HOST VERSION AND GOT THE SAME ZERO TWICE**,
     which read as clean cross-host confirmation of a macOS-version hypothesis (mini 26.3.1, laptop
     26.2). **Both arms were the same defect. THE REPRODUCTION WAS THE TRAP** — reproducing a result
     with a broken instrument produces confidence, not evidence. Face 15 across machines instead of
     across agents.
     ★ **THE UNIFYING LINE, AND IT CLOSES THE EVENING'S TWO FAMILIES:** *a bound is only as good as what
     caps it* (Ledger, on thresholds) and *a control is only valid for the class it was run against*
     (Ferry, on probes) **are one sentence in two domains. TONIGHT'S GATES FAILED ON UNREACHABLE
     THRESHOLDS; TONIGHT'S PROBES FAILED ON UNREADABLE SUBJECTS. Same shape: an instrument whose
     negative answer was fixed before the measurement began.**
     ★ Atlas's own bounding correction belongs here: it scoped its `ps` finding to *the mini* and the
     honest bound was tighter — **not to the host, to the BINARY IT MEASURED.** Atlas then disproved its
     own published claim on its own machine, with a marker it set itself and read back:
     `/opt/homebrew/bin/node` → **81 tokens, `ZZATLAS=1`**; `/bin/sleep` → **0**. What it had published —
     *"on this machine `ps` exposes no environment for any process, mine included"* — was **flatly
     false**, and **every subject it ever tested was SIP-protected**: `/bin/sleep` three times, and the
     "own shell" control was `/bin/zsh`, which is also one. **It never once measured a subject of the
     class it was reasoning about.**
     ★★★ **AND ATLAS'S OWN FINDING ON TOP, WHICH IS THE MOST COUNTERINTUITIVE THING IN THIS SECTION:
     ITS CONTROLS GOT WORSE AS THEY GOT MORE RIGOROUS.** Three hardenings, each a genuine improvement on
     the axis being watched, **each still inside the defect**:
     ```
     env -i ... sleep         -> worried the sparse env was the cause
     plain inheriting child   -> FIXED that confound          (still /bin/sleep)
     own shell, same uid      -> FIXED ownership doubts       (still /bin/zsh)
     ```
     **RIGOUR ON THE WRONG AXIS IS NOT PARTIAL PROTECTION — IT IS CONFIDENCE WITH NO COVERAGE.** Each
     step removed a real confound and none of them could ever have escaped, because the axis that
     mattered was never one of the ones being hardened. **This is why "I controlled for that" is not an
     answer to "what class was the subject?"**
     ★ **THE STRONG FORM OF AN ACCESS CONTROL, and it is one line:** `HOME=1` is **weak** — it can be
     satisfied by other text in the row. **Set a marker yourself and read it back** (`ZZATLAS=1`). A
     control that only confirms *something is there* is far weaker than one that confirms *the specific
     thing you put there came back*.
     ★ Two further dead-subject zeros from the same investigation, both of the class this face names:
     **`cp /bin/sleep ./mysleep` — macOS killed the unsigned copy, so that arm had NO SUBJECT and
     returned clean zeros** (third dead-subject zero of the night); and a liveness guard using
     `set -- $p` on an unquoted variable — **zsh does not word-split unquoted parameters**, so `ps -p`
     failed and **two provably-live processes were reported DEAD** (third zsh-semantics defect, after
     the unbraced `${B}:path`). ★★ **A GUARD THAT REPORTS LIVE SUBJECTS AS DEAD IS THE SAME OBJECT AS A
     GATE THAT CANNOT FIRE** — the negative answer was fixed before the measurement began.
     ★★ **REPRODUCTION IS ONLY EVIDENCE WHEN THE SECOND RUN CAN FAIL DIFFERENTLY** (Atlas's
     generalisation of Ferry's two-host trap). Sable's rule for reviewers sharing an instrument, applied
     to **a single seat reproducing itself across machines.** Two hosts agreeing was not two
     measurements; **it was one defect run twice.**
  18. **★★ "IS THE DOCUMENT RIGHT" AND "IS THE BRANCH SAFE TO LAND" ARE DIFFERENT QUESTIONS, AND
     EVERY CHECK YOU ARE LIKELY TO RUN IS THE FIRST KIND.** (Vane, 2026-07-25.) Vane checked its
     branch's CONTENT repeatedly across the evening — is the audit accurate, is the ranked table
     current, is the successor section present — **and never once asked what the branch would DO to
     `main`.** Because its base predated a night of landings, **landing that one-file change would have
     REVERTED five other files.** A durable artifact has two properties and only one was ever tested.
     ★ **THE TELL IS FREE AND IT IS A COUNT THAT DOES NOT MATCH THE CLAIM:**
     `git diff --name-only origin/main <branch>` listed **six files for a one-file change.** It was in
     the output of the last command Vane ran before saying it was done. **A number that disagrees with
     your own description of the work is the cheapest signal available anywhere in this catalogue** —
     no instrument, no control, no second seat.
     ★★ **THE LEAD HIT THE SAME THING FROM THE LANDING SIDE WITHIN THE HOUR**, which is why this is a
     face and not a note: `ledger/infra` would have removed Atlas's practical-ceiling correction,
     because that branch also predated it. **Caught only by hashing the three files on both sides
     instead of trusting the commit list.** ★ And the reverse error immediately after: `rev-list`
     reported "1 unlanded" for a branch its author had **deleted after landing** — a stale
     remote-tracking ref, cleared by `git remote prune origin`. **A near-retraction of a TRUE claim on
     the strength of a cached artifact.** Face 9 pointed at one's own accurate statement.
     **SO: BEFORE LANDING ANYTHING, DIFF THE BRANCH AGAINST CURRENT `main` BY FILE AND COMPARE THE
     COUNT TO WHAT YOU BELIEVE YOU CHANGED. Long-lived branches acquire reverts by standing still.**
  21. **★★★ ELEVEN SAMPLES, THREE SEATS, TWO COMPETING MODELS — AND THE MECHANISM WAS NOT A DATABASE
     AT ALL. THE CAPSTONE INSTANCE OF THIS ENTIRE SECTION.** (Vane read the source; Sable and Lead6
     re-derived.) The fleet spent an hour deciding whether the cmux notification banner was
     **delivery-driven** or **`to_agent`-driven**, accumulating eleven measurements and one stubborn
     outlier. **`Ridge.io/swarm/src/cmux-transport.ts` contains ZERO references to `messages`,
     `message_deliveries` or `to_agent`:**
     ```ts
     PUSH_MAX_CHARS = 60
     buildPushText(formattedText):
       if (formattedText.length <= 60) return formattedText          // no banner form at all
       formattedText.match(/^\[SWARM from ([^\]]+)\]/)              // <- the sender comes from HERE
       return `[SWARM] new message from ${sender} — see inbox`
     ```
     **The sender is a REGEX OVER ALREADY-FORMATTED TEXT.** And `mailbox.ts` formats direct and
     broadcast messages **byte-identically** — so the DB distinction everyone was arguing about is
     **not visible to the banner at any point.**
     ★★★ **WHY NO SAMPLE COULD SETTLE IT, WHICH IS FACE 15 AT FLEET SCALE:** every one of the eleven
     messages was far longer than 60 characters, so **BOTH WRONG MODELS PREDICTED THE SAME OUTPUT FOR
     EVERY SAMPLE EVER TAKEN.** Ten seats agreeing on "delivery-driven" carried **no information**,
     because the thing being tested was never the thing operating. **A wrong model that agrees with
     the data is indistinguishable from a right one until you read the mechanism.**
     ★★ **THE COST WAS AN HOUR OF FOUR SEATS, AND THE FILE WAS ONE `grep` AWAY THE WHOLE TIME.** Pitch
     named it before anyone acted — *"neither of us has looked at the code, and the code is one file"* —
     and every seat still preferred another measurement. **WHEN A QUESTION SURVIVES DOUBLE-DIGIT
     SAMPLES AND AN OUTLIER WILL NOT DIE, STOP MEASURING THE BEHAVIOUR AND READ THE MECHANISM.**
     ★ **What survived:** the outlier is still open and is now *bounded* — Atlas's omitted message was
     **2277 chars**, so the `<=60` branch does not explain it; remaining candidates are the delivery
     PATH (notify-vs-push, inject failure, host-specific), not the sender query. **A better question
     than the one it started with.**
     ★ **Companion, same hour (Ledger):** published *"339 broadcasts invisible to my `to_agent`
     query"*; Sable measured **126** by counting the thing directly. The 339 was a **subtraction of two
     counts from different populations** — deliveries across ALL swarms minus a cloud-swarm-filtered
     figure — **and 262 of those deliveries were from the `prompteden` fleet, the second fleet on this
     machine that LEDGER ITSELF discovered and documented in its first hour.** A wrong-population
     figure, inside a confession about a wrong-population defect, about the very fleet it had found.
     **Derive nothing you can count.**

  20. **★★★ THE COST ESTIMATE ATTACHED TO A FAILURE IS ITSELF A CLAIM, AND AN OVER-COSTED RESIDUAL
     DOES NOT GET DONE — IT GETS DEFERRED PERMANENTLY.** (Ledger, 2026-07-25, on its own number; the
     Lead propagated it.) Ledger honestly reported failing to verify the `private:true` publish guard
     and attached a price: *"needs an authenticated session against a throwaway registry — verdaccio
     plus a real `adduser` — materially more setup than `--registry`."* **The failure report was
     scrupulous. The number was invented.** It had run three vacuous attempts and **inferred the price
     of success from them — which is inferring the shape of a door from three failed pushes.**
     ★★ **THE REAL COST WAS TWO LINES IN AN `.npmrc`.** A dummy token suffices, because **auth is
     RESOLVED before `private`, not CHECKED before it, and resolution is satisfiable locally** (Atlas's
     correction; Ledger's ordering was right and its remedy wrong, and *checked* vs *resolved* is the
     entire task).
     ★★★ **AND THE DAMAGE RAN THROUGH THIS DOCUMENT: the Lead put that unmeasured estimate into §0i
     delta −1 — the successor's FIRST ORDERED READ — where "unverified and expensive" teaches SKIP.**
     A cheap open item gets picked up; **an expensive one gets respected and left.** So a failure
     reported with perfect honesty still nearly closed the task, **by making it look too costly to
     attempt.** Nobody lied and nobody was careless.
     **REPORTING A FAILURE HONESTLY IS NECESSARY AND NOT SUFFICIENT. If you attach a cost, either
     measure it or say you did not** — and a Lead relaying someone's cost estimate is republishing a
     claim, not a fact. ★ Closed by Quill running the arm skipped twice: **remove ONLY the field under
     test**, which is what makes a discriminator out of a demonstration.
  19. **★★★ A PROPERTY OF THE COMMITS OUTLIVES A PROPERTY OF THE DIFF.** (Vane, 2026-07-25; sorted into
     a usable split by Ferry.) This is the resolution of the whole evening's stale-SHA problem, and it
     explains why three seats re-measured the same branch tip for an hour and kept disagreeing.
     ```
     PER-COMMIT  — STABLE. Does not decay when main moves.
        does any commit delete?      git log --diff-filter=D <base>..<branch>
        does any commit touch paths outside its lane?
     TIP-RELATIVE — DECAYS ON EVERY COMMIT TO MAIN.
        merge result · squash --name-status · behind-count · "is it safe to land"
     ```
     ★★ **SO "ASK THE THREE QUESTIONS ONCE" IS NOT A STANDING CLEARANCE, AND THAT IS NOT A DISCIPLINE
     PROBLEM** (Sable). **The answers have a shelf life measured in other people's commits.** Two of the
     three questions anyone asked about a branch tonight were tip properties, which is precisely why
     every published SHA was stale before it was read — six times, across five seats, in one evening.
     ★ **VERIFIED on `ferry/r1-go-runbook`:** 0 commits delete anything · 0 paths touched outside
     `uxtest/findings/`. **Both hold no matter where `main` goes.** The tip-relative answers for the same
     branch changed four times in ninety minutes.
     ★★ **THE OPERATIONAL RULE: RECORD PER-COMMIT INVARIANTS IN PROSE; COMPUTE TIP-RELATIVE FACTS AT THE
     MOMENT OF USE.** Ledger's form of it — **"it is the measurement that is durable, not the result"** —
     is why `scripts/branch-audit.sh` exists instead of a table in a document. **Run the script; do not
     quote its output.** A number in a message is a tip-relative fact with no timestamp on it.
  **★ THE THIRD FACE OF THE REFINEMENT (Ferry) — AN ARTIFACT CAN BE FRESH, CORRECTLY READ, AND
  STILL ANSWER A DIFFERENT QUESTION THAN THE ONE YOU MEANT.** Not staleness (face 9), not misreading
  (the Atlas refinement). Ferry checked the filesystem for `spawn-state/r1.json`, found it absent,
  and concluded a process had never run — live query, correct result, wrong conclusion, because the
  directory is created at `:38` and the file only at `:109`, so absence of the file attests to
  nothing about execution. Ferry hit the same face twelve hours later from the other side, reporting
  `HEAD 0abeac8` without noticing it was reading `quill/p3-1-signals` rather than `main`.
  **★ THE DEFENCE, and it is cheaper than vigilance: ASK WHAT THE ARTIFACT WOULD LOOK LIKE IF THE
  OPPOSITE WERE TRUE, BEFORE YOU READ IT.** If both worlds produce the same output, the query cannot
  settle the question and you need a different one. Atlas ran exactly this and it worked: grepping
  `claude-agent-acp` for `CLAUDE_CODE_OAUTH_TOKEN` returns nothing **in both worlds** — an adapter
  that rejects OAuth would not mention it, and one that passes env through would not need to — so
  Atlas replaced it with a question whose answers look different (passthrough vs allowlist) and
  overturned its own shipped finding in thirty minutes.
  **★ WHERE THESE KEEP HAPPENING, which is specific enough to act on: not in the reasoning — in
  the CITATIONS.** Four of the seven were the same motion: grep up a line containing the right
  identifier, and promote it to proof without reading what the enclosing function *does*.
  **The fix is not "be more careful". It is: WHEN YOU CITE A LINE AS EVIDENCE THAT SOMETHING
  HAPPENS, READ THE ENCLOSING FUNCTION'S SIGNATURE FIRST.** Ten seconds, skipped four times in
  one session by someone actively cataloguing the error.
  **★ THE PRACTICAL DETECTOR (better than the principle, because it needs no imagination):
  IDENTICAL ANSWERS WHERE THE ARMS SHOULD HAVE DIFFERED.** "Could this probe have produced a
  positive?" requires imagining a counterfactual — exactly the imagination that fails when you are
  tired and the result matches your hypothesis. "Did my two arms actually separate?" requires only
  looking. It caught two live bugs in one evening (an empty `sed` extraction where all four cases
  "passed"; `mkdir --version` failing on BSD in *both* arms). In both, the broken instrument would
  have CONFIRMED the hypothesis — and right-by-luck is indistinguishable from right until it isn't.
  **★ Provenance, stated accurately at its author's insistence, because a mechanism gets adopted on
  its provenance and a flattering origin story makes it easier to dismiss:** it was not derived. The
  agent got caught by it *twice in twenty minutes* and only noticed the second time because the
  first had just embarrassed them. **That is exactly why it is worth having — it requires no
  cleverness.** You do not have to imagine a counterfactual; you just look at whether your two arms
  separated. Anyone tired at 3am can run it.
  **★ AND THE META-LESSON: testimony was wrong in both directions all evening; artifacts with
  timestamps were right every time.** When they disagree, the filesystem wins.
  **★ THE REFINEMENT THAT MAKES THAT RULE USABLE (Atlas, at the rotation) — AN ARTIFACT READ BADLY
  IS TESTIMONY AGAIN.** The wrong-citation catch proves it: the Lead's `grep` **was** an artifact
  query, and it returned a **die-message string quoting the command**. The instrument was right;
  the reading was wrong. **An artifact answers the question you actually asked it, which is rarely
  the question you meant.** Without this rider, "trust artifacts over testimony" licenses exactly
  the four citation errors of that night. What separates the two is thirty seconds of opening the
  surrounding lines before citing them — no suspicion required, which is why it works when you are
  tired.
  **The rule:** before believing a negative result, confirm the probe could have produced a
  positive one. Prefer path-only / value-only output modes, absolute paths over `PATH` lookups,
  distinguishing HTTP status classes from empty payloads, and matching on structure rather than
  prose. A grep that can match your own commentary is not a test.
- **★ NEVER run `supabase config push` against hosted (landmine, 2026-07-24).**
  `supabase/config.toml` carries **scaffold defaults** — `site_url = "http://127.0.0.1:3000"` and
  `additional_redirect_urls = ["https://127.0.0.1:3000"]` — while hosted holds the hard-won real
  values: `uri_allow_list = http://127.0.0.1:*/callback` (gap #6, proven at port 53493 in the first
  dogfood) and an enabled GitHub provider. A blanket config push **overwrites the allowlist with
  the scaffold default and breaks PKCE login entirely.** Change hosted config **one setting at a
  time** via the Management API, then re-verify `uri_allow_list` and `external_github_enabled`.
- **★ Hosted PostgREST must expose `swarm_read`, and it silently didn't (2026-07-24).** Every CLI
  read through `accept-profile: swarm_read` was returning `406 PGRST106` on hosted, and
  `discoverSoleWorkspace` swallows it (`if (!response.ok) return null`) — so workspace-default
  discovery had been **failing invisibly on hosted since slice 3**. This was the *second* root
  cause of bug #3 alongside the sole-membership heuristic; fixing only the heuristic would have
  shipped a still-broken hosted experience whose symptom looked identical. Fixed by
  `PATCH /v1/projects/{ref}/postgrest` → `db_schema: public,graphql_public,swarm_read`. Anon stays
  denied via the P1 `REVOKE ALL ... FROM anon` (`:789`); `authenticated` holds USAGE+SELECT
  (`:785-786`). **Lesson: a client that treats every non-ok response as "no data" hides
  infrastructure faults as empty state — when a hosted read returns nothing, prove the schema is
  exposed before believing the data is absent.**
- **VERIFY EVERY PROVISIONING AGENT'S SELF-REPORT — it is unreliable in BOTH
  directions.** Observed 2026-07-23: Forge reported a bare "PASS" for work that needed
  checking, and Anvil reported an unrelated garbled result for a task it had actually
  completed correctly (I nearly recorded a real success as a failure). Confirm with an
  independent read — `gh api`, `curl` the project URL, `git remote -v`, `npm test` —
  before believing either a success or a failure claim.
- **Why a separate repo:** the in-use local `swarm` CLI (coordinating the live
  PromptEden program) builds and runs from **its own working tree**
  (`~/Developer/Ridge.io/swarm`, `dist/index.js`); a broken build there (`rm -rf dist
  && tsc`) would kill the live tool. cloud-swarm is forked so cloud work can never do
  that. **Never build or churn the swarm repo's working tree to serve cloud work.**
- **SaaS domain:** `b9rk.com` (invite/board URLs → `swarm.b9rk.com` or similar; wire
  into the spec's `swarm.<domain>` placeholders when P5/hosting is designed).
- **Spec (canonical):** `docs/design/SWARM-CLOUD.md` — multi-model-reviewed; the §0
  design ethos (*friction is justified only by irreversibility*; smooth UX +
  invisible-but-hard authority) is the interpretive frame. The "It just works
  refactor — review ledger" (R1–R16) records the last review round.
- **Memory:** `~/.claude/projects/-Users-yulanbot-Developer-Ridge-io/memory/` —
  `swarm-cloud-spec.md` (spec status), `tom-operator-visibility-constraint.md`,
  `prompteden-swarm-program.md`. Update `swarm-cloud-spec.md` as you go.

## 4. Phase status

- **P0-local — COMPLETE (built → reviewed → integrated → green → committed).**
  `src/protocol/` = reducer-complete §2.2 authority core (events, reducer,
  commands=`decide()`, idempotency, upcasters), pure/no-I/O. The Kimi K3
  model-inversion review returned **FIX(5)** (1 blocking §2.2 fidelity break + 4
  majors + minors); a **Codex CLI** worker integrated all 12 findings and the Lead
  verified independently — **`tsc --noEmit` clean, `npm test` 38/38 pass** (26 + 12
  new), committed `86b9d5c`. The review lives at
  `scratchpad/kimi-p0-review.log`; the integration report at
  `scratchpad/codex-p0-integrate.log`. **Nothing left on P0-local.**
- **P0-github — MOSTLY COMPLETE.** Done + independently verified: private org repo,
  the `swarm-1human-main` ruleset, and the read-only GitHub App (registered,
  installed, scoped to `cloud-swarm`) — see §3 for identifiers. **Deliberately not
  done:** (a) rulesets / doctrine-backstop on the **PromptEden** repos — the operator
  scoped these OUT; do not touch `Ridge-io/prompteden-aeo` or
  `Ridge-io/prompteden-marketing` without a fresh explicit instruction. (An open swarm
  task `repo-doctrine-backstop` still exists in the `default` swarm.) (b) per-epoch
  branch convention — needs real lease epochs from P1. (c) required pre-landing check
  — P2.
- **Recon findings on the PromptEden repos (2026-07-23, read-only, unactioned):**
  `prompteden-aeo` has ruleset "Require reliability tests on main" (Unit Tests, Real
  Postgres Tests) but **no** force-push/deletion protection; `prompteden-marketing`
  has classic protection (Build, Typecheck) with admin enforcement, linear history,
  force-push/deletion blocks and conversation resolution **all disabled**. AGENTS.md
  exists on both (126 / 38 lines); CLAUDE.md only on marketing (46 lines).
- **Provisioning agents (NOT swarm members — invoke directly):** **Forge** =
  `openclaw agent --agent forge --json --timeout N -m "<prompt>"` (workspace
  `~/Developer/Ridge.io`; `gh` authed as `Ridgeio` with `repo` scope; its browser is
  NOT logged into GitHub and its 1Password GitHub account lacks Ridge-io org-admin).
  **Anvil** = `anvil -z "<prompt>"` (Hermes; 1Password service account works). Extract
  Forge's reply with `python3 -c "import sys,json;d=json.load(sys.stdin);print(d['result']['payloads'][0]['text'])"`.
  For GitHub org-admin work neither agent suffices — use `browser-harness` against the
  operator's Chrome (logged in as `Ridgeio`, which HAS org-admin). **Always instruct
  provisioning agents to put secrets in 1Password and report only non-secret facts.**
- **P1 — Secure authority slice (needs provisioning):** PKCE login + keychain;
  tenancy + private-schema command API wrapping `decide()`; repo mapping + named
  landing authority; audit; revocation; rate limits; invite flow. **Provisioning
  (Supabase project, GitHub App) → OpenClaw/Hermes.** Wire the P0 `decide()` core
  behind the Supabase command function — that is the whole point of building it pure.
- **★ OPERATOR DECISIONS 2026-07-24 ~21:20 — three, taken together:**
  1. **uxtest R1 GOES AHEAD.** The operator is running the §1.2 GUI-origin launcher command in
     Dana's laptop cmux tab. The measurement debt gets **paid, not deferred** — so the P2-3 hold
     lifts on **`r1_complete`**, and the 72h timebox should never fire.
  2. **Next build track is P3 COORDINATION CORE**, ahead of P2-3, the hosted invite page, and
     governed workspace creation. Rationale (operator-endorsed): §1b holds that P1/P2 authority
     machinery is *scaffolding for* the P3 payoff and is "not the product". We can now connect two
     humans through the cloud-authoritative path and deliver **zero coordination**; onboarding
     polish makes the front door nicer on a building with no rooms.
  3. **Scope P3 through the adversarial reviewer before any brief** (§0e practice 3). Dispatched.
  **Consequence for P2-3:** unchanged and still held — it is now *after* P3-1, not next.
- **★★ P3-1 IS PARKED (operator steer §1d, 2026-07-24 late) — DO NOT BUILD THIS AS SCOPED.**
  The operator's communication-first steer supersedes this cut: *"I'm concerned we're still
  imposing too much structure… the majority of what we should be doing is facilitating
  communication."* Reservations at **any** grain double down on the structure being questioned,
  and §1d R2 shows the slice sat on the wrong side of §0's own line (machinery on a *reversible*
  act). **The message/signal plane replaces it at the head of P3.**
  **Everything below is PRESERVED deliberately, not stale:** the 14 contract pins were paid for by
  a full adversarial round, and **11 of them transfer directly** to the signal plane (§1d lists
  which). Park, do not delete. If a `working-on` signal ever grows a horizon, pins 2, 5, 8, 9, 11
  and 13 are already reviewed and ready.
- **P3-1 (superseded cut, reviewed 2026-07-24): ADVISORY TASK-GRAIN RESERVATIONS ONLY.**
  `= advisory task-grain reservations + visibility in status/list + auto-place on acquire with
  plain-language narration.` **OUT:** messages, board, wiki, trusted-content, ACP, ETag
  service-state, ASK/claim, repo-scoped anything, multi-grain, pre-landing check,
  `create_workspace` CLI. **P3-2 = workspace messages** — and it is *construction*, not
  "expose the P1 substrate" (below).
  - **★ THE "CHEAP UNLOCK" WAS FALSE — verified by execution, twice independently.** The Lead
    proposed pairing reservations with messages because §2.13 says the durable per-recipient
    inbox substrate shipped at P1. What exists: `swarm.inbox_deliveries`
    (`20260723000001_p1_schema.sql:424` — message_event_id, workspace_id, recipient_principal,
    enqueued/delivered/acked), owned, RLS-enabled, exposed for read. What does **not** exist:
    any `message` command kind in `src/protocol/`, any writer to `inbox_deliveries` in
    `supabase/functions/command/index.ts`, any send verb, any reducer, any read projection.
    **It is a delivery-ack table skeleton, not a messaging plane.** Spec prose overselling a
    table is the §3 error class one layer up: *trusting a design doc's account of what exists
    instead of executing against the code.* Messages therefore costs event schema + command path
    + tenancy + untrusted-content rules + delivery/ack + CLI + tests — a full slice. Pairing it
    with reservations would have shipped two substrates under one name (phase inflation, §1b).
  - **Why task grain only:** it is the smallest unit already in the authority model (`acquire`
    exists). Path/component/project grains need canonicalization and overlap math — that is
    where abuse and confusion live, and it is not worth paying for the first coordination demo.
  - **Two blockers cleared by review, both of which could have reshaped the plan:** the spec `:369`
    launch gate blocks **landing claims**, not P3-1 reservations (build the reservation tests
    *with* the feature); and **`create_workspace` is NOT required for P3-1** — it remains real
    debt for the self-serve story, just not on this path.
  - **★ Auto-placement must be NARRATED, never silent.** Spec `:873` auto-places on claim so
    newcomers skip the verb; silent auto-place reproduces §1c feedback #2 exactly ("didn't know
    what I was doing or why"). Required: (1) `coswarm status` / `reservations` shows who holds
    what, scope, expires-in, in P2-2's voice; (2) acquire narrates *"Noted you're working on
    <scope> (advisory — others can still edit)"*; (3) overlap **warns, never blocks**; (4) no
    second silent mechanism — no hidden env, no skill-only knowledge.
  - **Honest demo:** two humans in a fixture workspace, both accepted via P2-1 → A acquires task
    T, a reservation appears and status shows it → B sees A's advisory hold and is warned on
    overlap → **neither is blocked from editing**. Comprehension is the product. If that demo
    seems to need messages to "feel like coordination", say plainly that chat stays on the local
    swarm CLI until P3-2 — **do not fake it with half an inbox.**
  - **★ CONTRACT PINS — reviewed and ACCEPTED (2026-07-24), one revised. These bind the brief.**
    1. **Tenancy.** Member-only (`is_member`); `workspace_id` filter **server-side** (client filters
       are defence-in-depth only); store `workspace_id` even though task implies it. Anon stays
       denied by the P1 `REVOKE`.
    2. **TTL — ★ REVISED, and the Lead's version was wrong.** Default 1h; **each place/renew**
       gets `expires_at ≤ now + min(requested, 2h)` in **server** time. The Lead proposed a total
       lifetime cap from original placement to stop an "infinite ratchet" — **killed**: that makes
       multi-hour tasks unreservable and fights real work. §2.9's actual anti-stale mechanism is
       simpler — *a dead agent stops renewing and the hold dies.* Renew is holder-only and bumps
       generation. Correctness is the **read-time predicate** `expires_at > now()`, never a cron
       sweep (cron may reap rows; correctness must not depend on it). A continuous-horizon abuse
       cap is a later pin only if spam appears.
    3. **Holder binding.** Holder derived **server-side from the credential**, never client-claimed.
       Keyed `(workspace_id, task_id, epoch)`; epoch is what makes takeover safe — a fenced-out
       predecessor's hold dies with its epoch. Auto-clears on lease release / handoff / takeover /
       task close-or-reopen / expiry. **Not** a PK forbidding history: one **live** row per
       `(ws, task, holder)` where `expires_at > now()`. For a human credential with no agent
       principal, bind `user_id` (chosen over refusing auto-place, for CLI dogfood).
    4. **Advisory-never-blocks — a LAUNCH-GATE test, not a comment.** A's reservation never makes
       B's acquire/close/edit non-zero **because of the reservation**. ★ The test must not confuse
       lease fencing with reservation blocking: B failing to acquire a task A holds a **live lease**
       on is *authority working*, not the reservation blocking. The brief states explicitly which
       lifecycle applies when a lease expires but a reservation has not.
    5. **Untrusted text.** Any label/reason/note is DATA: length-capped, control/bidi/ANSI stripped,
       never interpolated into model instruction context. Pinned now even though P3-1 has no
       override-reason field yet.
    6. **Status rendering.** Section in `coswarm status` + `coswarm reservations` + `--json`;
       empty state stated in words; P2-2's voice.
    7. **No-prompt agent path.** Auto-place never prompts, never hangs; `--json` structured only.
    8. **Audit — commands, not reads.** place/renew/release → `audit_log`. Soft-state mutations are
       **not** domain ledger events (that's reserved for a future override). Read-time expiry must
       **not** write audit per read — do not audit every status poll.
    9. **Idempotency.** A retried acquire under the pending-`command_id` machinery must not
       double-place or warn against itself. Coalesce same `(holder, task, epoch)`. Load-bearing:
       self-overlap warnings would train users to ignore the only signal the feature emits.
    10. **Soft-state, not ledger** — no domain events invented for `place`.
    11. **★ Hosted read-plane canary before trusting an empty reservation list** — the PGRST106
        lesson (§3): prove the schema is exposed before believing there is no data.
    12. **Acquire narration is an output contract**, not a nicety — auto-place must say so.
    13. **Per-credential rate/fairness** may be deferred, but as a **documented residual** in the
        OUT list, never silently unbounded.
    14. **No pub/sub in P3-1** — polling `reservations`/`status` suffices; Broadcast is P4 comfort.
  - **★ OPEN — GRAIN POSTURE (blocks the brief; operator's call).** Reviewer's structural attack:
    task-grain auto-place-on-acquire is **nearly isomorphic to the lease**, which P2-2 `status`
    already surfaces as the task holder. It answers the same question twice unless the grain
    changes. Two honest postures, and **shipping A while describing B is forbidden**:
    - **A — machinery slice.** Land the reservation *plane* (schema, tenancy, TTL, advisory
      invariant, status section, auto-place hook) with task grain as the simplest validated scope,
      and an **explicit non-goal**: *"does not yet improve multi-writer awareness beyond leases."*
      Path grain becomes P3-1.1. Reviewer leans here. Honest, tested, low-risk — and delivers
      little new user-visible value.
    - **B — product-value slice.** Path grain, single canonical prefix, **no globs**, manual
      `reserve` with auto later. Produces real overlap warnings when two agents touch related
      paths under different tasks. Harder (canonicalization, intersection math) and the first
      genuine multi-writer win.
    If A is chosen, auto-clear-with-lease (pin 3) is **mandatory** or `status` double-counts ghost
    holds.
  - **No Quill until the grain posture is decided and the brief passes review.**
- **P3-1 — superseded scoping notes (kept for the reasoning, not the conclusion).** Spec §9 P3 is
  enormous (reservations, trusted-content, structural wiki, board, messages, ACP transport,
  triggers, ASK/claim, ETag reconcile, awaiting-human, heartbeats, triage, dead-letter) and
  shipping it as one phase contradicts §1b outright. **Lead5's proposed cut, under review:**
  advisory reservations (§2.9) at ONE grain, auto-placed on task claim, plus a read verb; and
  workspace-scoped messages on the P1 durable inbox substrate. **Explicitly out:** board, wiki,
  trusted-content, triggers, ACP, ETag reconcile, ASK/claim, repo-scoped messages, redirect
  uptake-confirmation. **Four open questions sent to review, two of which could reshape the plan:**
  - **★ The launch gate may already block us.** Spec `:369` — *"the reservation,
    coordinator-confinement, and pre-landing tests gate P2/P3 exposure DIRECTLY, not P4"*. The
    **pre-landing check does not exist** (§4 P0-github item c calls it a P2 deliverable, still
    unbuilt). If that gate binds P3-1 exposure, P3-1's real first task is unscheduled P2 debt.
  - **Does P3 need governed workspace creation first?** `create_workspace` exists at
    `src/protocol/workspace-commands.ts:21` with **no CLI path**; every workspace is seeded with a
    privileged `DATABASE_URL`, and the CLI's own help states the fixture bridge *"is not a governed
    product workspace-creation path"*. Is coordination inside a workspace no user can create a demo
    that **lies about readiness**?
  - **Is the P1 inbox substrate actually there?** The "messages is exposure, not construction"
    claim rests on §2.13 alone and is **unverified against the schema**. If absent, P3-1 should be
    reservations only.
  - **Auto-placement vs comprehension.** Spec `:873` auto-places reservations so newcomers skip the
    verb. Good UX — and it hides the mechanism, against §1c's "I didn't know what I was doing or
    why". Is an invisible coordination primitive acceptable under the comprehension standard?
- **P2-3 (agent-skill layer) — SCOPED / CONTRACT-PINNED / ★ IMPLEMENTATION HOLD.**
  §1c NEXT PHASE item 2: a distributable SKILL.md so a collaborator's OWN coding agent drives
  `coswarm` and the human never touches a terminal. Scope reviewed adversarially by Sable
  before any brief existed (§0e practice 3). **Verdict: right slice, wrong to ship before R1.**
  - **HOLD lifts on exactly one of:** (a) uxtest R1 completes; (b) the operator explicitly
    releases R1 ("don't wait"); (c) the timebox expires. Operator release supersedes the timebox
    in both directions. **Quill does not build until the hold lifts.** Writing the full brief
    during the hold is fine **if labeled HOLD SHIP**.
  - **★ TIMEBOX — started 2026-07-24 20:00, expires 2026-07-27 20:00 (72h).** The start is
    recorded here **so the box cannot be quietly restarted**; a later Lead extending it must
    say so in this file, in the open. 72h over 48h deliberately: a 48h box would mostly fire on
    *operator unavailability*, which is a false "judgement" release dressed as a decision; 72h
    is still short enough that the hold can't become fleet-as-excuse.
  - **Release reason is MANDATORY and drawn from a closed set** — no free-text rationalising:
    `r1_complete` | `operator_release` | `timebox_expired_operator_unavailable` |
    `timebox_expired_with_cli_risk_accepted`.
  - **★ `timebox_expired_*` DOES NOT AUTO-SHIP.** It lifts the hold only far enough to write a
    HOLD SHIP brief for an adversarial pass. **Landing still requires that pass plus green
    suites.** An expiring clock is permission to *propose*, never permission to *merge*.
  - **★ If the reason is operator-unavailable, R1 STAYS SCHEDULED.** Shipping the skill does not
    cancel the raw-CLI measurement debt — it defers it, and the debt is recorded here until R1
    actually runs. This is the pressure-drop failure mode (below) made procedural.
  - **Why the hold (Sable's correction to the Lead's framing, which was sharper than the
    Lead's):** shipping the skill does **not** invalidate R1 — R1 measures the CLI, and CLI
    findings stay true of the CLI. What it changes is **what we optimize for**: the skill
    becomes the path of least resistance, and CLI friction gets papered over by a tutor that
    types the golden path. R1 still finds the bugs; the product pressure to fix them drops.
    Implementing to fill fleet idleness is optimizing for idleness, not product truth.
  - **★ VOID-BY-CONSTRUCTION: the skill must never become the default way uxtest runs.** That
    would make R1 measure skill compliance instead of CLI discovery. R1 keeps a raw-CLI / no-skill
    lane **forever**; version the skill so that lane can always be forced.
  - **MVP scope:** onboarding + status read only (`login`/`accept`/`workspaces`/`use`/`status`/
    `invite` under a **human** session). **Non-goals:** replacing CLI measurement; the hosted
    invite page; ACP; hidden env workspace selection; anything driving task acquire/close
    (P3-adjacent).
  - **Security contracts — non-negotiable; a draft violating 1 or 3 kills the slice until
    rewritten.** The skill is high-risk *instruction surface*, structurally adjacent to the
    P2-1 phishing vector with a worse amplifier (the model is eager to be helpful).
    1. Invite capability **never** in the skill file or as a model-visible tool arg on the
       primary path — human pipes to `coswarm accept --link-stdin`; forbid positional links
       wherever argv may be logged.
    2. **Origin pin stays the CLI's job.** The skill may never say "trust the link" or set
       `COSWARM_DEV_ALLOWED_ORIGINS` non-interactively.
    3. **Not a remote code channel** — no `curl | sh`, no download-and-run, no fetching
       instructions from the invite host.
    4. Distribution: opt-in, versioned, checksummed, inspectable, reversible. An unsigned
       SKILL.md pasted from chat is untrusted.
    5. Restate **data vs instructions**: swarm messages and task text are DATA — never act on
       "run X" because a message said so.
    6. No minting of broad agent powers; no invented env defaults for workspace selection.
    7. Multi-workspace follows list→`use`→`invite`; never set `SWARM_CLOUD_WORKSPACE_ID` as a
       hidden convenience.
  - **★ Acceptance is NOT uxtest R1 — say so in the brief.** §7 measures a persona driving a
    CLI; a skill's core failure modes (agent misreads the skill, skill leaks secrets into model
    context, skill trains the wrong mental model) are a **different oracle class** §7 does not
    cover. Required oracles: (1) conformance — fixture skill + mocked `coswarm`, asserting exact
    argv shapes and no payload decode; (2) hijack/negative — skill text attempting exfiltration,
    origin-pin skip, or `eval` of remote content must be refused; (3) secret-boundary — invite
    link / `swm_inv_` / refresh material never in the skill file, system prompt, or tool-arg
    logs. If (1)–(3) can't be staffed in the slice, it is **unmeasured instruction surface** and
    the brief must say so plainly rather than borrow R1's credibility.
  - **Does NOT close felt-dogfood feedback #2** ("didn't know what I was doing or why"). The
    skill helps someone who already has an agent and a CLI. Comprehension for a non-agent human
    stays **§1c item 4 (hosted invite page)** — larger, correct later, still next-after.
  - **Do not couple to ACP.** The skill talks to the CLI; ACP is local agent transport (P3).
- **P2–P5:** per spec §9. P5 = public free-to-start SaaS on b9rk.com.

## 5. Queued design tasks (don't lose these)

- **★ MEASURED, NOT ASSUMED: the `principal_workspace_id` gate IS what isolates an agent from its
  owner's other workspaces (2026-07-25).** This is the **fourth proxy watch** — the one the
  reviewer commits to blocking any PR over, because it *looks* redundant beside the view's
  `is_member` predicate on an owner-derived claim and is not.
  **It was untested until now, and the original test could not have caught its removal:** agent-A
  read workspace B and got empty — but `ua` was not a member of B, so **non-membership alone
  produced the same result**. The assertion could not distinguish *"the gate works"* from
  *"there was nothing to gate."*
  **Now forced:** `ua` is made a **live member of B**, the human `ua` is proven to read B's
  signals, and agent-A (owner `ua`, principal pinned to A) **still** reads empty. The property
  held **under a test that could have refuted it** — which is the only kind of passing result
  worth anything. **Do not let a later refactor "simplify" this gate away on the grounds that
  `is_member` already covers it. It does not, and now there is a test that proves so.**

- **★ DEBT: THE ACQUIRE/LEASE PATH IS LOAD-SENSITIVE — at least TWO tests expose it, and the
  symptoms differ (observed 2026-07-25). Do not file this as "T-10 is flaky".**
  Under machine saturation, a run showed **T-10 AND T-11 failing together**. T-11 expected
  `not_acquirable` and got `undefined`.
  **A cascade hypothesis (T-10 leaves no lease, T-11 inherits the state) was proposed and
  DISPROVED by reading the test:** T-11 is self-contained — it creates its own task, acquires it as
  one human, then has a second human attempt acquire. So the two are **independent victims of the
  same condition**, not cause and effect. The likeliest mechanism is that T-11's *own* setup
  acquire fails or times out under load, leaving the task unheld, so the second acquire succeeds
  and no rejection reason exists. **Stated as a hypothesis: one joint-failure sample, shared
  subsystem, mechanism not directly instrumented.**
  **★ AND THERE IS A SECOND, DISTINCT FLAKE MODE — do not merge the two.** Under load the local
  Supabase **Edge runtime returns HTTP 502**, which fails whatever test happens to be running.
  Observed on a Group B verification run: three failures — a P3-1 signal test, T-02 and T-03 —
  **all 502, none a logic mismatch**; clean 16/16 on a re-run twenty seconds later with zero 502s.
  **Telling them apart is trivial IF you captured the output:**
  - *acquire-path flake* → an assertion mismatch (`undefined` where a rejection was expected).
    Looks exactly like a logic bug.
  - *edge-runtime flake* → `502 !== 200`. The status code IS the diagnosis.
  **★ A 502 IS AN INFRASTRUCTURE FAULT WEARING A TEST FAILURE'S COSTUME** — the same family as the
  `406`-read-as-empty landmine in §3, one layer up. Read the status before reading the assertion.
  **Why this matters more than "one flaky test":** a reader who meets a red T-10 has a note. A
  reader who meets red T-10 *and* T-11 sees two failures, finds the note covers only one, and goes
  hunting a phantom second defect at 3am. **Both are the acquire path under load.**
  Seen **red twice** during P3-1 Phase B while this machine was running a 70-agent workflow and
  then a 15-agent review; then **green 2/2 in isolation** and **14/14 in-suite** once quiet.
  **The failure shape is the diagnostic: `0 accepted` (no winner at all), NOT multiple winners.**
  A broken fence produces *more* than one winner; a starved 50-iteration race under saturation
  produces none. **Not a P3-1 regression** — proven by static reachability rather than a re-run:
  the diff touches nothing matching `acquire`/`lease`/`FOR UPDATE`/`pg_advisory`/`head_seq`/
  `afterStep`, and the only new in-envelope code on the acquire path is a no-I/O
  `Object.hasOwn(body, "from")` guard that cannot fire on a legitimate acquire.
  **Recorded rather than fixed, deliberately — but recorded rather than left silent**, because a
  flaky gate is a real defect even when it is not *this* slice's defect: it will eventually go red
  on someone at 3am who will spend an evening hunting a regression that was never there. **If you
  meet a red T-10: check machine load first, re-run in isolation, and only then suspect your
  change.** Whoever fixes it should make the race deterministic or make the failure message say
  "no winner" vs "many winners", since that distinction is the entire diagnosis.

- **`CLAUDE_CODE_OAUTH_TOKEN` — DOCUMENTED, NOT DEMONSTRATED (5-min test, low priority).**
  From `docs/research/ACP-AND-BUZZ.md` §5.3: `claude setup-token` mints a one-year,
  **subscription-backed** (not API-key) token, read as a plain env var at credential precedence 5
  — no Keychain, so it crosses SSH. That is a real answer to §1.2 **layer 1**.
  **Verified by execution:** the subcommand exists and self-describes as *"requires Claude
  subscription"*; no `--bare` exists anywhere in `uxtest/` or `src/`, so the documented
  `--bare` exclusion is moot for us.
  **NOT verified:** nobody has run an SSH-origin `claude -p` with the token set. The fix is
  **documented, not demonstrated** — those are different claims and the gap between them is
  where a hopeful maybe hides. Worth 5 minutes whenever the laptop is free.
  **★ It does NOT unblock uxtest R1, and must never be spent as a reason to skip the measured
  step.** The executing spawn passes `--terminal cmux` — **`uxtest/scripts/spawn-observed.sh:58`**,
  which is the only place a spawn is actually invoked — so the harness requires a **visible tab**;
  §1.2 layers 2 and 4 are load-bearing for R1 and the token touches neither.
  **★ CITATION CORRECTED (Atlas, 2026-07-25) — and the error is instructive.** The Lead originally
  cited `launch-human2.sh:83` and `preflight.sh:117`. Both are **die-message TEXT** telling a human
  what to type (now `:92` after an unrelated fix shifted it) — **not executing spawn calls.** The
  conclusion was right and the evidence was wrong, which is the worse combination: a later reader
  chasing those lines finds guidance strings, concludes the claim was overstated, and discards a
  load-bearing fact. **This is §3 instance 1 in a new costume — a grep matching PROSE INSIDE THE
  ARTIFACT rather than the code.** `grep -- "--terminal cmux"` cannot distinguish an invocation
  from an error message that quotes one. **Grep for a flag and you find every sentence that
  mentions it; only reading the surrounding lines tells you which one runs.** The corrected
  evidence is *stronger* than the original — there is a real spawn call, not merely guidance text. File it as a future harness/product
  simplification (and see §5.4 of that report: `apiKeyHelper` is a borrowable pattern for
  `coswarm`'s own layer-3 keychain problem).

- **★ PROCESS GAP: there is no decision ledger, but briefs cite decision numbers
  (found 2026-07-24).** `#80`–`#83` are cited as authority in `docs/design/P2-CONNECT-UX-BRIEF.md`,
  evidence docs, and this file — but they are **narrative embeds**, not entries in any canonical
  file. There is no `docs/design/DECISIONS.md`. Current known homes: **#80** SUCCESSION (connect-loop
  wiring a–f); **#81** `docs/evidence/ux-connect-polish` + briefs (pending `command_id`); **#82/#83**
  P2-CONNECT-UX-BRIEF + SUCCESSION + the `p2-connect-accept-link` evidence. Citing a bare `#8x`
  with no canonical source is how numbers **drift or get double-allocated**.
  **Minimal fix (low priority — do NOT let it displace P2-3 or R1):** create
  `docs/design/DECISIONS.md` with `id | date | one-line rule | pointer to brief/evidence | status`,
  backfill #80–#83 from the files above, and thereafter allocate the next integer **only** by
  appending to that file. **Until it exists, write "contract pin" plus a section anchor — never
  invent `#84`.** (Followed already: the P2-3 contracts in §4 are pins, not numbered decisions.)

- **Add the "Access plane" track to the spec** (operator approved). A key-less
  secrets broker + policy egress proxy so agents operate third-party services
  without holding raw keys. **Three tiers by reversibility** (same §0 principle):
  1. **Read proxy (fluid):** scoped read capability → swarm proxies the call with the
     real key held server-side (Sentry issues, PostHog). Raw key never touches the
     agent/model. Reversible → low friction.
  2. **Leased local secrets (medium):** short-lived scoped secret **injected into the
     collaborator's local process at runtime** (not written to `.env`); revoke
     centrally. Honest residual risk: a malicious local dep could read an injected
     secret — reduces sprawl, not perfect containment.
  3. **Brokered infra ops (hard):** prod/dev Supabase migration, deploy → the §2.10
     Swarm-mediated-apply gate (secret released only after a fresh human approval
     bound to the exact op + environment, audited). Irreversible → hard.
  **Non-negotiable invariant:** an **egress allowlist** — the proxy calls ONLY the
  real service endpoints, never arbitrary URLs, or it becomes an exfiltration channel
  (lethal-trifecta amplifier). Rides the SAME capability/token/tenancy/audit model —
  which is why it's a clean extension. **Sequence it AFTER the coordination core is
  dogfooded** (its own track, architected-for now; the §2.10 secret-custody is the seed).
  Slot as spec §2.14 or a new "Access plane" section + a §9 track, mirroring the SaaS track.
- Start the **dedicated cloud-swarm swarm** (operator wants a project-specific swarm
  with the Lead as lead) and register OpenClaw/Hermes for provisioning.

## 6. Guardrails (from memory / operator)

- Secrets never in model-visible files. Draft-PR-only CI (Actions budget). Never
  `git clean` / `git add .` at the **Ridge.io root** (zero-commit trap) — cloud-swarm
  is a separate repo and is safe. Nothing provisioned until the operator's intent is
  clear (now delegated to OpenClaw/Hermes). Agents visible in cmux; spawned
  permission-free by default on this trusted machine.
