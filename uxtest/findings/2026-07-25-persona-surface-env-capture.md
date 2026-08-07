# Persona surface environment — captured 2026-07-25, laptop (`MacBookPro`, macOS 26.2)

Direct observation of what a spawn-created persona surface actually inherits.
This is the **negative-control fixture** for any future isolation gate: a known-leaky
environment that a correct check must **reject**.

---

## 0. READ THIS BEFORE RE-RUNNING — the probe lies against the wrong subject

**macOS withholds the environment of SIP-protected platform binaries.**

| subject | `ps -Ewwp <pid> -o command=` | |
|---|---|---|
| `claude` (node, `~/.local/bin`) | **66–70 env tokens**, `HOME=1` | readable |
| `/bin/sleep`, `/bin/zsh`, any `/bin` or `/usr/bin` tool | **0 env tokens**, `HOME=0` | **structurally unreadable** |

Verified same-host/same-minute on **both** machines, and independently by three other
seats. **The zero is a property of the subject, not of the host and not of the OS version**
(mini 26.3.1, laptop 26.2 — the version gap is real and is *not* the cause).

So: **a readability probe built on `sleep`, `env`, or any system tool returns a structural
zero and cannot know it.** A successor re-running the capture below against a platform
binary will see "no environment at all" and conclude the persona is clean. It is not.

**The subject here was a `claude` process. Use the same class, or the result is worthless.**

### Do not rely on knowing which binaries are SIP — check the subject (Pitch)

```sh
ls -lO <path-to-subject-binary>     # look at the flags column
```

A binary flagged **`restricted`** is SIP-protected and will yield **no environment** to `ps`.
An unflagged one will. Verified paired on this machine:

| subject | flags | env tokens |
|---|---|---|
| `/bin/sleep`, `/bin/zsh`, `/usr/bin/env` | `restricted,compressed` | **0** |
| `node`, `claude` (homebrew / `~/.local/bin`) | *(none)* | **66** |

**This runs before the measurement, on either machine, against whatever subject you actually
picked.** It replaces "remember which binaries are platform tools" — a rule you must recall —
with an observation you cannot skip. Prefer it to the rule above; the rule is the explanation.

**Hardened runtime is not a second withholding mechanism** (Atlas): `ChatGPT.app` is
unrestricted but hardened (`codesign flags=0x10000(runtime)`) and its env reads fine.
`restricted` is doing all the work.

### The token COUNT is not a readability signal — only zero-versus-nonzero is

A **launchd**-spawned GUI app inherits a small environment; a **shell**-spawned process
inherits a large one. Measured: `ChatGPT.app` **20 tokens — complete, not truncated** ·
`claude` 66 · `node` 82.

**A cmux surface is launchd-spawned.** So a successor who measures one, sees a low count, and
reads it as stripped or unreadable **is wrong** — and that is a plausible mistake to make
against exactly the subject this fixture is about. **`ls -lO` predicts readability; the
magnitude predicts nothing.**

Corollary on the marker rule: **a marker you set yourself is the strong hit-test and is only
available for a process you launched.** For a process you did not launch — every real fixture
subject here — the sound pair is **`ls -lO` beforehand plus a variable known to be present**,
and nothing at all about the count.

Stronger still (Atlas): `HOME=1` is a weak check — other text in the row can satisfy it.
**Set a marker yourself and read it back** (`ZZMARK=1`), which is the only form that proves
the probe can return a true positive.

---

> **§§1–3 have a second seat.** Re-derived independently from the laptop by Atlas on
> 2026-07-26 ~02:32Z — not re-read, re-measured. All three reproduce. **§3 came back stronger
> than it was written:** the full `PATH` extracted to the next `VARNAME=` boundary is **31
> entries, zero of them persona/uxtest, with `/opt/homebrew/bin` at position 17.** That is the
> clean extraction the original author never achieved — three separate parsing defects landed in
> exactly this measurement (see §5) — so the conclusion in §3 now rests on someone else's
> instrument as well as the argument.
>
> Worth knowing why it needed one: §0 and §4 took seven corrections from five seats, and §§1–3
> took none until this. **Attention density ran inverse to consequence** — the method was
> reviewed to death and the finding was not reviewed at all.

## 1. Surfaces, identified positively

Identified by **cwd**, not by count. An earlier attempt counted `claude` processes (28) and
nearly read the count as identification; a count is not an identity.

| pid | `CMUX_AGENT_LAUNCH_CWD` | |
|---|---|---|
| 20852 | `/Users/tom/uxtest/human2/launcher` | persona surface |
| 74981 | `/Users/tom/uxtest/human2/launcher` | persona surface |
| 44509 | *(no uxtest)* | **internal negative control — genuinely differs** |

The third row is what makes the other two evidence. The arms separate 2 / 0 / 2.

---

## 2. What the persona surfaces actually carry

| | present? |
|---|---|
| `/opt/homebrew/bin` in `PATH` | **yes** |
| `/usr/bin` in `PATH` | yes |
| persona `bin` directory in `PATH` | **no — none at any position** |
| `CLAUDE_CONFIG_DIR` | **no** |
| `UXTEST_*` variables | **no** |
| `uxtest` anywhere in env | only as `PWD` and `CMUX_AGENT_LAUNCH_CWD` |

## 3. The conclusion, which is stronger than the leak that was argued for

**It is not that homebrew wins the `coswarm` race. There is no race.**

The persona has a **working directory and nothing else**. Every other environment variable
is inherited wholesale from the cmux application. This is §7.2.2 leakage channel 2 confirmed
by direct observation rather than inferred from symptoms.

Consequence for R1: a persona resolves `coswarm` to `/opt/homebrew/bin/coswarm` → symlink →
the live product repo, and **`preflight.sh:126` cannot detect this**, because it builds the
PATH and then resolves inside its own construction (see `2026-07-25-r1-gate5-hang.md` §7).

## 4. Using this as a negative control

Any replacement isolation gate must be run against an environment of this shape and must
**FAIL**. A gate that passes here is vacuous — the same defect class as a threshold set
above the maximum attainable value.

Numeric gate → assert the trip is inside the attainable range.
Non-numeric gate → ship a known-bad input the check must reject.
**Either way: a control is only valid for the object it was run against** — and *object* means
**the ref, the file, the branch, the machine, the swarm and the binary class**, not just the
subject. **A control run against a different object than the measurement proves nothing about
the measurement.**

> **Why the wider wording.** This rule was written here as *"the class of subject"* and it did not
> fire when the object turned out to be a **git ref**. On 2026-07-26, four seats read
> `git show origin/main:<path>` on a repo whose default branch is `master`, got empty output, and
> published *"these citations resolve to nothing"*. **`git show <missing-ref>:<path>` prints empty
> and does not error.** A negative control was run — against `origin/master`, a ref that exists —
> so it proved the probe worked *there* and said nothing about the ref being measured. **The
> author of this line was one of the four and did not recognise it as an instance.**
>
> Cheapest guard, and it names the failure directly rather than implying it:
> ```sh
> git rev-parse --verify <ref>   # before reading anything from <ref>
> ```

Mechanism form (Ledger), which needs no foresight: **make the control fail loudly and confirm
the subject notices.** Silence where the failure should have surfaced *is* the finding.

**But this proves the control is REACHED, not that it measures the right thing** — a reached
control can still cover the wrong subset. Ledger's own is the worked example: the shim emitted
its marker four times, and still intercepted only `sysctl` while `memory_pressure` and `df` ran
live, so one arm varied and two were merely observed. **Reachability and coverage are separate
questions and the loud-fail test answers only the first.** Do not read a marker as validation.

**These are two different mechanisms and the second is the one usually skipped (Ledger).**

Both now exist as tools — **on `main`, under `scripts/`, and NOT on this branch.** This branch
is well behind `main` and carries only `uxtest/findings/`, so if you have checked it out, the
scripts named below are **not in your tree**: read them from `main`, or you will conclude they
were never written. (This file has now made the same mistake it warns about — describing an
object correctly while the reader stands in a different one.)

`probe-check.sh` implements the positive control; `path-check.sh`
(written by Ledger after this section first claimed only one was built) implements fail-loudly
— it puts a deliberately-erroring tool first on `PATH`, runs the subject, and looks for the
tool's marker on stderr. **Nothing is inferred from the subject's exit status or output**,
because a subject that swallows errors and one that never needed the tool look identical from
outside. Only the marker proves the shim was entered.

| test | what it proves |
|---|---|
| **positive control** — feed a case constructed to contain the thing you seek | the probe **can** produce a hit |
| **fail-loudly** — substitute a deliberately-erroring instrument, confirm the subject reacts | the probe **is what produced** the hit |

The second is not implied by the first. If your instrument was never in the path at all — a
`PATH` shim bypassed by an absolute-path call, say — **a positive control routed "through" it
returns the real system's values, which look exactly like a legitimate hit.** The control
passes, you conclude the instrument works, and it was never invoked.

Tonight produced one of each: a SIP-protected `/bin/sleep` is the first class (probe cannot
hit); an unreached shim is the second (something else produced the hit). **If a tool claims to
cover "the control question", check which of these two it actually runs.**

### How to build both (Atlas): two markers, opposite ends of the measurement

- **Mark the subject** — put a unique value *in the thing being measured* and read it back
  (`ZZMARK=1`). **Proves you read the right subject.**
- **Mark the instrument** — make the instrument emit something only it can emit, and confirm
  the subject noticed (a shim that exits 7 to stderr). **Proves your instrument was the one in
  the path.**

**Same technique, opposite ends, and each is blind to the failure the other catches.** This is
the constructive form — the table above says what each proves; this says what to write.

## 5. Provenance and decay

Captured 2026-07-25 from live processes on `100.95.177.37`. **Those processes are volatile**
— a reboot or a closed tab destroys them, and the pids above will not be valid again. This
file is the durable copy; the live surfaces are not.

Read via `ssh` from the mini. Getting here took seven attempts; six failed, all in one class
(measuring an object adjacent to the question). The attempt that worked used an access
control supplied by a second seat — testing *whether the environment was readable at all*,
one level beneath the parser-level control the first six assumed was enough.
