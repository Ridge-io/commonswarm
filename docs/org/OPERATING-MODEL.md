# Advisor → Operator → Executor

Adopted 2026-07-29. How work is split across model families on this repo, and why.

The load-bearing rule is §2. If only one thing here survives, it should be that one.

---

## 1. Why, in one paragraph

Over a week-long sprint on this codebase, **every real defect was caught by a reviewer of a
different model family than the author.** Not one by self-review. One agent logged eighteen of
its own errors and caught four. Another wrote a test that could not fail for its own property
*while warning about that exact failure mode in the test's opening comment*. Different families
miss different things; a family shares blind spots with itself.

This session added two more, both found only by leaving the model and touching the artefact:
the published binary contained no renewal code at all (D-001), and the CLI told every operator
renewal was unavailable while it was working (D-002). Neither is visible in source. Both are in
`DEFECT-REGISTER.md`.

---

## 2. Model-inversion review — the control that pays for everything

**A reviewer of a change must be a different model family than its author. Self-family
review does not count as review** — a codex subagent reviewing codex work satisfies nothing,
whatever the prompt, session or persona. That is the necessary baseline, not the current
passing gate. Under D-033 the operative gate requires **both Grok and AGY/Gemini**; one
different-family verdict is not sufficient.

Corollaries that have each already cost something here:

- **A verdict binds to a SHA.** Adding "just a docs commit" on top silently moves the approval
  past what the reviewer saw. A new commit voids the verdict; rebinding is mandatory.
- **An attestation is about WHO checked, not what the message says.** Relaying a reviewer's
  text under another agent's name produces a correctly-worded record with the wrong signature.
- **Verdicts are prescriptions, not vetoes.** The reviewer states the defect AND the required
  shape of the fix. A prescription is binding unless disproven *with evidence*, and the way to
  reject one is to report the disproof and stop on that item — never to quietly do something
  else.

### What is actually available on this machine

Measured, not assumed (`alloy doctor`, and `command -v`):

| Family | CLI | Role here |
|---|---|---|
| Claude | `claude` | Not a required reviewer under D-033. Headless/shared-account review is spend-limited; the interactive Quarry seat remains live. |
| OpenAI | `codex` | **Operator/author**, not a substitute for either required review arm. |
| xAI | `grok` | Required adversarial reviewer for every swarm mate's change. |
| Google | `agy` → Gemini | Required adversarial reviewer for every swarm mate's change. |

**Operator ruling, 2026-07-29:** every swarm mate must obtain exact-SHA verdicts from
**both Grok and AGY/Gemini instead of Claude**. A different-family verdict remains
necessary but is **not sufficient**: Grok alone, Gemini alone, and Codex review do not
pass this gate; an optional Claude read does not replace either arm. Each arm must return
substantive findings or reasoning — an empty PASS is not a review. A changed SHA voids
both verdicts and requires both reviews to rerun.

~~Google | `gemini` | Not installed. Do not plan work that assumes it.~~ **Dead as of
2026-07-29:** `/Users/yulanbot/.local/bin/agy` is installed, supports non-interactive
`--print`, and enumerates Google Gemini models including `gemini-3.1-pro-high`.

`opencode`, `cursor-agent` and `antigravity` remain excluded from this review path. `agy`
is the measured Google-family path; do not substitute an unmeasured CLI or enable
`ALLOY_ALLOW_UNSANDBOXED`.

~~The local swarm's `members` output says *"cross-family review is NOT available in this
swarm"*, and all swarm seats are Claude or UNKNOWN.~~ **Dead:** the current roster includes
OpenAI, Claude, and UNKNOWN seats, while reviewer CLIs are a separate machine capability.
`command -v` plus substantive probe output established `grok` and `agy`; roster family labels
do not establish or negate those CLI paths.

---

## 3. The three roles

**Advisor** — one agent, frontier reasoning model. Owns judgement, not throughput: strategy,
architecture, acceptance criteria, scope rulings. Writes the charter, which is the only
interface to the operator. Holds everything irreversible — merging, promoting to production,
applying migrations, talking to the human. Independently verifies operator claims *before
acting on them*: re-runs at least one claimed mutation proof, re-checks pushed SHAs with
`git ls-remote`, never relays an unverified claim upward.

**Operator** — one session, strongest available non-advisor family at max reasoning. Owns
execution: decomposes the assignment, spawns executors, enforces gates, assembles
review-ready branches, reports with exact SHAs and verbatim gate output. **Never merges, never
promotes, never touches production, never applies schema changes.**

**Executors** — many, disposable. Scoped mechanical work from self-contained briefs. One
worktree per task, one branch per task, gates inside the task, mutation proof attached. Cheap
models take mechanical work; max-effort models take anything with judgement in it.

---

## 4. Evidence discipline — what "done" means

- **Mutation proof per fix:** revert the fix → observe the verbatim red → restore exactly →
  observe green. A test never seen red proves nothing.
- ★ **The mutation must be applied at the PRODUCTION CALL SITE**, not to a constant and not to
  the test's own fixture. Four tests in one day passed full suites while checking nothing they
  were named for (D-018), and every one of them *had* a mutation proof — applied where the test
  was already looking. If the only mutation that reddens a test is one its author chose, the
  test observes the author's model of the system, and a model agrees with itself.
- **"What test fails if someone deletes this call?"** must have a named answer.
- **Every sentence in a commit message is a measurement that was run**, or is explicitly marked
  as an assumption. Corrections go in the tree, not only in the message.
- **Gates report real counts, not colours.** A job that passed in 0 seconds did not run;
  `skipped` is not green; a pending gate is not a gate.
- **Report failures verbatim.** "Stopped, blocked" is an acceptable terminal state.
  Falsely-marked-complete is not.

This repo's own verification doctrine (`AGENTS.md`) is the same rule from a different angle:
measure the artefact, not its name; run a positive control on the same invocation; enumerate,
don't pattern-match; pushed ≠ landed ≠ applied.

---

## 5. Failure modes already hit here

| Failure | Countermeasure |
|---|---|
| Release built from a commit predating the feature; everything green, feature unreachable (D-001) | Grep the **built artefact** for a symbol the feature must contain, with a control against a fresh build |
| CLI reported a feature unavailable while it worked (D-002) | Exercise the real path end to end; never trust a code comment asserting a field exists |
| Executor CLI exits 0 having produced only narration | Wait for process **exit**; treat narration-only output as FAILED and reroute to another family |
| Sandboxed "push" landed on a local clone, not GitHub | Advisor verifies with unpiped `git ls-remote` against the real remote |
| Credentials copied into a sandbox "temporarily" to unblock a tool | Never copy credentials. Report and stop. Auth-blocked is a valid terminal state |
| Literal instruction unsatisfiable; agent invented a workaround that looked like control evasion | Charters specify **outcomes with fallbacks**, never bare mechanisms |
| A SHA written from memory into a durable document | Verify against `git log`/`ls-remote` before it lands. This happened while writing the register |

---

## 6. Charters — the advisor→operator interface

Everything the operator does comes from a written assignment containing, in order:

1. **Role restatement + reporting protocol.** Outcomes with fallbacks, never bare mechanisms:
   "deliver the report by running exactly this command" is unsatisfiable the moment the command
   fails for an environmental reason, and an agent escalating around it is indistinguishable
   from a control bypass. Name the record that must exist, attributed to whom, plus a fallback
   channel.
2. **Hard rules** — the invariants that cost hours when relearned.
3. **Tasks** — each with the reviewer's verdict quoted *verbatim*, the required fix shape, the
   required **observer** (a test that can see the defect *class*, not just the instance), and
   the required mutation proof.
4. **Gates** — exact commands; exit codes read unpiped; problem *counts* read, not colours;
   a control run against the base branch for pre-existing noise.
5. **Report format** — per task: final SHA, `ls-remote` push evidence, gate counts, mutation
   observations verbatim, review status, anything REJECTED with its evidence. Then stop.

Multiple operator sessions may run concurrently **only on disjoint branches and worktrees**,
and each charter names what the others are touching. This repo is worked by several agents at
once and the shared checkout is frequently not on `main` — see `AGENTS.md`.

---

## 7. Cadence

1. Advisor maintains `DEFECT-REGISTER.md` on `main` as the single source of truth.
2. Advisor writes a charter per wave; operator executes; executors fan out.
3. Every branch gets a cross-family review bound to its exact SHA. REQUEST CHANGES verdicts
   come back as prescriptions; the advisor turns them into the next charter, quoted verbatim —
   paraphrase loses the constraint that mattered.
4. Advisor merges **only at approved heads with executed, non-zero-duration gates**, promotes
   at milestones, and verifies each promotion independently.
5. Expect 2–3 review rounds on anything hard. A deeper defect surfacing in round 2 is the
   system working, not failing.
