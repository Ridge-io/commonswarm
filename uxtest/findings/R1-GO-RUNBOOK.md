# R1 GO-RUNBOOK — gates 5→6→7, contiguous

**Purpose:** when the mini's trust clears, R1 fires with nobody thinking, deciding, or re-reading.
Every command is here in order, with what PASS looks like, what FAIL looks like, and what to do
about each.

**Constraints on this document:** it is a *document*. It changes no script. Do not create
`rounds/1/REPORT.md` or `rounds/1/transcript.md` until a round has actually produced them —
`reset-round.sh:28` refuses to reset a round whose directory holds either, so those filenames are
**locks**, not just documents.

**Environment prefix** — every harness command below assumes this wrapper (values are never
printed; the files are `0600` in a `0700` dir):

```bash
cd /Users/yulanbot/Developer/Ridge.io/cloud-swarm
( set -a; . ~/.config/uxtest/cloud.env; . ~/.config/uxtest/round.env; set +a
  uxtest/scripts/<script> <args> )
```

> **CHECK THE BRANCH FIRST. That path is whatever the last checkout left behind.**
>
> The shared tree is routinely parked on someone else's branch — it was on
> `quill/cli-first-errors` throughout 2026-07-25. A relative script path resolves against
> *that* branch, not `main`.
>
> ```bash
> git rev-parse --abbrev-ref HEAD    # expect main, or know why not
> git diff --stat origin/main -- uxtest/scripts/   # expect empty
> ```
>
> **On 2026-07-25 these were byte-identical to `main`, so the runbook worked — by coincidence
> of the branches agreeing, not by construction.** Ledger was bitten by exactly this on
> `scripts/envelope-check.sh` the same night: it published "gate GREEN" ~10 times from a
> superseded copy carrying an arm that could not fire. **The verdict was right every time and
> none of it came from the instrument it claimed.**
>
> **NAME WHICH REF. Do not pick a favourite one.** A gate or harness script has to be the same
> test every run, so running it off whatever branch a shared tree happens to carry is an
> unstated ref — that is the defect. **It does not follow that `main` is always correct:** if you
> are developing a harness change, your branch *is* the right ref and reading from the tip would
> discard the thing you are testing.
>
> So: confirm the tree with the commands above, or state the ref explicitly —
> `git show origin/main:uxtest/scripts/<script> | bash -s -- <args>`
>
> (An earlier revision of this block said a harness script *"must never be read from an arbitrary
> branch"*, which is categorical and wrong in that second case. Ledger published the same
> over-general form about gates the same night and corrected it within the hour: **the rule is
> true of durable project facts and false of running systems**, and a seat that generalised it
> would have checked `origin/main` for a function that only exists in the deployed tree and
> concluded a correct mechanism trace was fiction.)

---

## 0. PRE-FLIGHT — five assertions, at least three of which can genuinely fail

A pre-flight where every assertion is already known to hold is a ritual, not a gate. These are
ordered cheapest-first. Each terminates in a printed `PASS` or `FAIL` — a check that prints raw
output for the reader to compare against prose is a check that gets skimmed.

### P1. Mini trust — the gate-7 blocker

```bash
node -e 'const p=require("/Users/yulanbot/.claude.json").projects||{};
const t="/Users/yulanbot/uxtest/human1/workspace";
console.log(p[t]?.hasTrustDialogAccepted===true?"PASS":"FAIL — mini persona cwd untrusted");'
```
- **PASS:** `PASS`. **FAIL:** anything else.
- **On FAIL: STOP.** This is the operator's action — open a Claude session in that directory once,
  accept, exit. **Do not write the flag programmatically** (§7.9b; see
  `2026-07-24-r1-attempt-1.md` §8 for why that ruling has history).
- *Why it can fail:* `hasTrustDialogAccepted` is **per-directory**, is written only by an
  interactive GUI acceptance, and is **absent by default on any directory nobody has opened**. It is
  therefore missing until someone deliberately makes it present — no temporal claim required.

### P2. Laptop trust — can regress

```bash
ssh -o BatchMode=yes tom@100.95.177.37 "zsh -lic 'node -e \"
const p=require(\\\"/Users/tom/.claude.json\\\").projects||{};
const t=\\\"/Users/tom/uxtest/human2/workspace\\\";
console.log(p[t]?.hasTrustDialogAccepted===true?\\\"PASS\\\":\\\"FAIL\\\");\"'"
```
- Ratified by Tom on 2026-07-24. *Why it can fail:* `~/.claude.json` is a live file written by the
  operator's other sessions; a restore-from-backup would silently drop this entry.
- **On FAIL: STOP**, and do not re-add it yourself — same ruling as P1.

### P3. Per-round swarm is empty — can fail, and silently

```bash
m=$(swarm members --swarm uxtest-r1 2>&1 | grep -c 'No agents in swarm')
l=$(ssh -o BatchMode=yes tom@100.95.177.37 "zsh -lic '/opt/homebrew/bin/swarm members --swarm uxtest-r1'" 2>&1 | grep -c 'No agents in swarm')
[ "$m" = 1 ] && [ "$l" = 1 ] && echo PASS || echo "FAIL — agents present or swarm missing (mini=$m laptop=$l)"
```
- **PASS:** the literal word `PASS`. ~~Falsification checked: a typo'd swarm name, an empty swarm and
  a populated swarm produce three distinct outputs, so this check genuinely discriminates.~~
  **CORRECTED 2026-07-26 — I RAN IT, AND "THREE DISTINCT OUTPUTS" IS TRUE OF THE RAW TEXT AND FALSE
  OF THE VALUE THIS CHECK ACTUALLY COMPUTES.** Demonstrated against known-positives rather than
  asserted (local arm; `grep -c 'No agents in swarm'`):

  ```
  uxtest-r1   (empty)                 -> 1     PASS arm
  cloud-swarm (populated, 10 agents)  -> 0     FAIL arm   <- the check DOES fire
  zzz-no-such-swarm (typo'd)          -> 0     FAIL arm   <- SAME VALUE as populated
  ```
  The three *messages* differ (`No agents in swarm "x".` · a member list · `Error: Swarm "x" not
  found.`), but `grep -c` collapses the last two to `0`. **So this check discriminates PASS from
  FAIL and does NOT discriminate "a persona survived" from "the swarm does not exist"** — two
  failures with different fixes. The `FAIL` string already says *"agents present or swarm missing"*,
  so **the gate is sound and only this justification was overstated**; a reader who trusted the
  prose over the code would have gone looking for a stray persona when the swarm was simply absent.
  **A check that CAN fail is not automatically a check that tells you WHY** — that is a separate
  property and it needs its own demonstration.
- **On FAIL:** a persona survived a prior attempt. `swarm create` is *create-or-update* and does not
  clear agents. Do **not** proceed — re-run `reset-round.sh 1`, which now asserts zero agents as
  well as zero messages.
- *Why it can fail:* a late-registering spawn from a previous attempt can land after the harness
  gave up. Exactly what attempt 1 risked.

### P4. Round-1 directory holds no lock files

```bash
{ [ -e uxtest/rounds/1/REPORT.md ] || [ -e uxtest/rounds/1/transcript.md ]; } \
  && echo "FAIL — a lock file is present; reset-round.sh:28 will refuse round 1" \
  || echo PASS
```
- **PASS:** the literal word `PASS`.
- **On FAIL:** stop and move the offending file out before touching `reset-round.sh`.

### P5. Reset still cold, and the round has not silently advanced

```bash
node -e 'const v=require("./uxtest/rounds/1/setup.json");
for (const k of ["reset_complete","human2_reset_via","human2_spawn_probe","fresh_human2_name","carryover"])
  console.log(" ",k,"=",JSON.stringify(v[k]));'
```
```bash
node -e 'const v=require("./uxtest/rounds/1/setup.json");
console.log(v.reset_complete===true && v.human2_reset_via==="dana-a2a-gui"
  ? "PASS" : "FAIL — reset is not complete; run reset-round.sh 1 before preflight");'
```
- **PASS:** the literal word `PASS`.
- ★ **`human2_spawn_probe="failed"` and `carryover=true` are EXPECTED here and are not the failure.**
  They are attempt 1's residue and are overwritten by gate 5. Do not read them as red flags — the
  only assertion P5 makes is that the *reset* completed.
- If `reset_complete` is **false**, run `reset-round.sh 1` first — and note that `preflight.sh 1`
  will fail at `:206` until it completes, because that cold-state block is a *post*-reset assertion.

**If P1–P5 all pass, and only then, run `preflight.sh 1` and expect it fully green** (it was green
at 03:20Z on attempt 1). Any death is a real problem: report and stop.

---

## 1. ★ THE KNOWN CONFOUND — read before gate 5, it decides how you interpret the result

**Hypothesis A is proven and has NOT been fixed** (deliberately — see §4). The harness waits
`120s` (`30s × 3 + 30`) for the persona to register. A2A messages surface at Dana's **turn
boundary**, not mid-turn, so pickup latency is bounded by "however long its current turn has left" —
**unbounded from our side**. On attempt 1, dispatch was `03:21:56Z` and Dana's execution began
`03:25:34Z`: 3m38s, against a 120s budget. Even a flawless run misses that window.

**Therefore gate 5 has more outcomes than the harness can record.** `probe=failed` is written for
several of them. The probe below prints exactly one of SIX verdicts; all six appear here, and
**every one except PASS is a STOP**:

| Outcome | Harness says | Artifacts say | Meaning |
|---|---|---|---|
| **PASS** | exit 0, probe passed | — | Dana was fast enough. Proceed. |
| **AMBIGUOUS** | exit 1, `probe=failed` | *either* `observed:true`; *or* `observed:false` **and** `Dana-r1` present on the **laptop** | **The spawn worked; a timeout fired.** Two distinct causes print this — the harness's 120s budget, or `spawn-observed.sh`'s own ~90s join probe (`:122`). Both are hypothesis A, one nested. |
| **FAIL** | exit 1, `probe=failed` | `observed:false` **and** `Dana-r1` absent from `swarm members` — or `error` contains `swarm spawn exited` | The spawn genuinely failed. |
| **UNDETERMINED** | exit 1, `probe=failed` | state file **absent** | Cannot be diagnosed from artifacts alone. *Not* the same as FAIL. |
| **CORRUPT STATE FILE** | exit 1, `probe=failed` | state file present but unparseable | Treat as UNDETERMINED. A file killed mid-write is literally the killed-mid-flight case. |
| **PROBE FAILED** | anything | the *probe itself* could not reach the laptop or read its swarm | **Says nothing about the spawn.** Fix the link and re-probe. Never record this as a round result. |

★ **The state FILE is the only discriminator. Do not use the directory.** An earlier draft of this
runbook claimed a *missing* directory meant never-started and an *empty* one meant killed
mid-flight. Both arms are dead: attempt 1 already created
`/Users/tom/uxtest/human2/spawn-state/`, nothing deletes it, and `mkdir -p` is idempotent — so the
directory is therefore present and empty from the first attempt onward, independent of whether any
later gate 5 runs — so that test returns its diagnostic verdict for an event that need not have
happened at all.

★ **`observed:false` IS NOT FAIL ON ITS OWN — it has three causes and only one is failure.**
`spawn-observed.sh` writes it at `:109` (`swarm spawn exited N` — a real failure), at `:122`
(`membership was not observed after bounded join attempts`) and at `:126` (`spawn output did not
identify a cmux surface`). **`:122` is hypothesis A one level down**: the *local* join probe waits
`UXTEST_JOIN_TIMEOUT_SECONDS × UXTEST_JOIN_ATTEMPTS` ≈ 30s × 3 = **90s**, against a measured
turnaround of 3m38s on attempt 1 — the same order of magnitude. So a spawn that works can be
recorded `observed:false` **while the agent is present**. Refusing to let the *harness* timeout
masquerade as failure and then letting the *artifact's own* timeout do it would be the same defect
nested one level deeper. **Always combine `observed` with `swarm members`.**

★ **UNDETERMINED is genuinely undetermined**, because between `mkdir` at `:38` and the first
`write_state` at `:109` there are several exits that leave no state file: `chmod` at `:39`, the two
`node` calls at `:41` and `:42-45` (note `require_command` guards only `UXTEST_CMUX_BIN`, never
`node`), the pipes at `:63-72` under `set -euo pipefail`, and any external SIGTERM/SIGKILL — which
is exactly the harness-timeout case. Treat UNDETERMINED as a STOP and diagnose from the laptop
directly; do not infer.

**★ This means `probe=failed` in `setup.json` may be a FALSE NEGATIVE in our own metrics** — and
under §7.7 a false `carryover=true` forbids exactly the discovery-UX claims R1 exists to produce.
Do not let a stale failure record stand as the round's truth. Resolve it per §2.3 below.

---

## 2. GATE 5 — `launch-human2.sh 1` (Dana spawns virgin `Dana-r1` on the laptop)

```bash
( set -a; . ~/.config/uxtest/cloud.env; . ~/.config/uxtest/round.env; set +a
  uxtest/scripts/launch-human2.sh 1 )
```

### 2.1 Then — ALWAYS — read the artifacts, regardless of exit code

Do not trust exit 0 and do not trust exit 1 (§7.9b). **Wait at least 5 minutes past dispatch**
before concluding anything negative, because the harness gives up at 2 minutes and Dana's turn
boundary is unbounded.

```bash
# Fetch and parse are SEPARATE so an ssh failure cannot masquerade as "no state file".
# `|| true` on the remote side means a missing file exits 0; only a broken link exits non-zero.
if ! out="$(ssh -o BatchMode=yes -o ConnectTimeout=10 tom@100.95.177.37 \
     'cat /Users/tom/uxtest/human2/spawn-state/r1.json 2>/dev/null || true')"; then
  echo "PROBE FAILED — laptop unreachable. This is NOT undetermined-spawn; fix the link and re-probe."
elif ! members="$(ssh -o BatchMode=yes -o ConnectTimeout=10 tom@100.95.177.37 \
     "zsh -lic '/opt/homebrew/bin/swarm members --swarm uxtest-r1'" 2>/dev/null)"; then
  echo "PROBE FAILED — cannot read the LAPTOP's uxtest-r1. Registration UNKNOWN; this is not a verdict."
else
  # ★ Dana-r1 registers on the LAPTOP. Swarm state is PER-MACHINE and the mini does not see it
  # until channel-up (gate 6) register-a2a's it — which runs only after gate 5 passes. Asking the
  # mini here would report every successful spawn as "not registered". `|| true` because grep -c
  # exits 1 on zero matches, which would abort under set -e.
  PRESENT=$(printf '%s\n' "$members" | grep -c 'Dana-r1 \[' || true)
  # ★ assignment on its OWN line: `VAR=x cmd` scopes VAR to that command only, so folding it into
  # the pipeline prefix would silently deliver an empty value and make the AMBIGUOUS arm unreachable.
  printf '%s' "$out" | PRESENT="$PRESENT" node -e '
    let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{
      const present = Number(process.env.PRESENT||0) > 0;
      if(!r.trim()){console.log("UNDETERMINED — no state file. Dana-r1 "+(present?"IS":"is NOT")+" registered");return;}
      let v; try { v = JSON.parse(r); } catch { console.log("CORRUPT STATE FILE — treat as UNDETERMINED"); return; }
      if(v.observed===true){console.log("AMBIGUOUS if the harness said failed — spawn observed, join_latency_ms="+v.join_latency_ms);return;}
      const e=String(v.error||"");
      if(e.includes("swarm spawn exited")){console.log("FAIL — the spawn command itself failed: "+e);return;}
      console.log(present
        ? "AMBIGUOUS — observed:false BUT Dana-r1 IS registered; the local join probe timed out. error: "+e
        : "FAIL — observed:false and Dana-r1 not registered. error: "+e);});'
fi
```

★ **Ask what each artifact would look like if the opposite were true, before reading it.** Applied
here, that question kills the obvious test: the spawn-state **directory** is created at
`spawn-observed.sh:38` and never removed, so it already exists and is already empty — it would look
identical whether or not gate 5 ever runs. **A test whose output is the same under both hypotheses
is not evidence.** Read the **file** at `:109` and its `observed` flag instead; that is the only
artifact whose two states correspond to two different worlds.

### 2.2 (b) discipline — still in force even with the guard fixed

**Do not proceed to gate 6 unless `human2_spawn_probe == "passed-distinct-cmux-surface"` and
`fresh_human2_name == "Dana-r1"`.** A failed or absent probe means `carryover` stays `true`, and we
do not have a round — we have an expensive no-op. Stop and report.

### 2.2b ★ One harness exit string that is NOT in the table

`launch-human2.sh:133` throws **"Human2 helper did not observe registration"** when the remote wait
*succeeded* but the state file says `observed:false` — i.e. the agent IS present and the local join
probe timed out. That die path does **not** write `human2_spawn_probe=failed` (that write happens
only on the wait-timeout path at `:115-116`), so `setup.json` may retain stale probe state from a
previous attempt.

**If you see that string: go to §2.1, do not re-launch.** It is an AMBIGUOUS signal wearing an
error message.

### 2.3 If the result is AMBIGUOUS (harness red, artifacts green)

The spawn succeeded and the harness timed out. **Do not re-run `launch-human2.sh` to "fix" the
record** — the guard will correctly fall through (probe is `failed`), dispatch a *second* spawn, and
you risk a duplicate `Dana-r1`. Instead **stop, report it as a confirmed instance of hypothesis A,
and get a ruling**. The clean resolutions are (a) reconcile `setup.json` from the observed
artifacts, or (b) reset to a fresh round number — additive reset makes the latter cheap and it is
the safer of the two.

---

## 3. GATES 6 AND 7 — only after gate 5 is unambiguously PASS

### Gate 6 — `channel-up.sh 1`

```bash
( set -a; . ~/.config/uxtest/cloud.env; . ~/.config/uxtest/round.env; set +a
  uxtest/scripts/channel-up.sh 1 )
```
- **PASS:** `Round 1 chat channel verified: Avery-r1 ⇄ Dana-r1; mini port 18790 untouched.`
- **Verify independently** rather than trusting the line: agent-card at `100.127.131.115:18791`
  must be `Avery-r1`, at `100.95.177.37:18790` must be `Dana-r1`, and `127.0.0.1:18790` must still
  be `Yulan` (not ours — never touch it).

### Gate 7 — `launch-human1.sh 1`

```bash
( set -a; . ~/.config/uxtest/cloud.env; . ~/.config/uxtest/round.env; set +a
  uxtest/scripts/launch-human1.sh 1 )
```
- **This is the gate P1 protects.** It spawns Claude in the mini's persona cwd; without trust the
  modal eats the join keystrokes and the tab looks healthy while no agent registers (§7.9b).
- **PASS:** `Avery-r1 joined uxtest-r1 from the swept trusted directory.`
- **Verify:** `swarm members --swarm uxtest-r1` shows **both** personas, and `setup.json` has
  `human1_joined_at` / `human1_join_latency_ms` / `human1_join_attempts` all non-null.

---

## 4. DURING THE ROUND — the objective is inverted

- **Do not nag a persona toward completion.** A persona giving up is a *successful outcome*
  (§7.3). A give-up declaration triggers collect; it is not a problem to be solved.
- **Do not answer a persona's questions about the product**, and do not let them read the repo,
  each other's terminals, or decode the invite link. Any of those → **round VOID**.
- **Do not "improve" the harness mid-round.** R1 is a measurement; you cannot upgrade the
  instrument during the run it is measuring. The queued fixes (wait-on-early-artifact, retry
  readiness, `assert_round_brief_only` vs a live session) land **after** R1 reports, where they cost
  nothing and are informed by what R1 actually hit.
- **Time-based claims come from collected timestamps, never a persona's word** (§7.10). The
  10-minute solo-struggle rule is judged from `time_to_first_coswarm`, not from a persona saying
  it tried for ten minutes.

---

## 5. COLLECT AND REPORT

```bash
( set -a; . ~/.config/uxtest/cloud.env; . ~/.config/uxtest/round.env; set +a
  uxtest/scripts/collect-round.sh 1 )
```

★ **`collect-round.mjs:462` WRITES `rounds/1/REPORT.md` ITSELF, and `collect-round.sh:46-47` DIES
if it is missing or empty.** So do **not** hand-author that file — the stated order is impossible
and writing it yourself either fights the collector or overwrites what it generated. The collector
also emits the full §7.7 Validity header at `collect-round.mjs:423-429`, **interpolated from
measured values**. Typing those numbers by hand would substitute self-report for measurement, which
is the §7.10 violation this runbook enforces four sections earlier.

**Your job is REVIEW AND AUGMENT, never author.** Read the generated header, confirm it against the
facts below, and add the findings synthesis beneath it. For reference, the header it generates is:

```markdown
## Validity
- Role-play bias: LLM ≠ non-technical human — classes we cannot claim: [§7.1 "No" rows]
- Carryover: true/false  (if true: no discovery-UX claims)
- Isolation: clean / VOID  (if VOID: stop, do not rank findings)
- Partner-rescued steps: [quotes]
- Version under test: mini <sha> / laptop <sha>  (must match)
- OAuth consent: first / returning
```

**Already established for that header, carried from attempt 1** — these are properties of the setup,
not of the attempt:
- `oauth_consent: returning` — **not** `first`. No connect-time claim may be attributed to a
  first-consent flow.
- `multi_project_path: true`, `current = projected = 2` live memberships. The round exercises
  `workspaces → use → invite`; it is **not** evidence about the sole-membership shortcut.
- Version under test `f12b47b8…`, identical on both machines (re-verify at go — it can drift).

**Findings are ranked only if isolation is clean**, and every finding must quote the exact CLI line
the persona saw. If isolation is VOID: say VOID, stop, rank nothing.

---

## 6. STOP RULES — a stop is a result, not a failure

Stop and report, do not improvise, if any of these hold:

1. Any pre-flight assertion P1–P5 fails.
2. `human2_spawn_probe` is absent or not `passed-distinct-cmux-surface` after gate 5.
3. A persona breaks isolation (reads the repo, decodes the link, reads the other's terminal).
4. Gate 5 returns **anything except PASS** — FAIL, AMBIGUOUS, UNDETERMINED, CORRUPT STATE FILE or
   PROBE FAILED. All five are stops (§2.3); only the reason to report differs. PROBE FAILED in
   particular says nothing about the spawn and must never be recorded as a round result.
5. Anything requires writing to a human's config, or any action on the laptop GUI that must
   originate inside the GUI session (§1.2). Route it to the operator; do not script around it.
   Two prior Leads lost real time rediscovering that wall.
