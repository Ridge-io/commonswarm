# /goal — turn Stage 7's causal-control *domains* into actual, runnable controls

Worker: **Corbel2** (Codex). Lane: release-gate preparation.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE`, asserted in preflight.**
Owned: `docs/design/contracts/V015-RELEASE-CHECKLIST.md` and one new file under `docs/design/`.

## The problem

`V015-RELEASE-CHECKLIST.md` §2 requires proving that the causal controls "still discriminate", and
lists ten items: enqueue/backfill, claim one-winner, stale-lease requeue, poison ceiling,
response-loss replay, persist-before-ACK, note-with-zero-prompts, cross-owner zero-tool isolation,
privacy/no-body, credential absence.

**Those are domains, not controls.** No row names a mutant, a file, a test, an invocation, or an
expected failure. Whoever runs Stage 7 has to re-derive all of it under release pressure, and the
master plan still says "~11 named causal controls" — an approximate count, which is not an
enumeration. This release has already been bitten three times by checks that could not fail; a gate
described only by topic is exactly how the fourth happens.

## The work

Build a **control register**: one row per control, each independently runnable.

Every row must carry:

| Field | Requirement |
|---|---|
| Control name | the domain it proves |
| Mutant | **exact** file and edit — the one-line change that reintroduces the defect |
| Test | the test file, and the **exact test name** to pass to `--test-name-pattern` |
| Invocation | the full command, per-test, with `--test-concurrency=1` and an external watchdog |
| Expected failure | the **named** assertion that must print red |
| Slot | whether it needs the exclusive DB lane |

**Source the rows from evidence that already exists — do not invent them.** Nearly every one has
already been run and recorded this release. Mine:

- `docs/evidence/2026-08-02-v015-execution/` — every `*-PASS.md`, `*-BLOCK.md`, and the
  `runtime-c-fixture-repair-VERIFIED-PARTIAL.md`
- `docs/design/contracts/SERVER-PHASE-B-HARNESS-FINAL-REPAIR-GOAL.md` and
  `SERVER-PHASE-C-PREFLIGHT-CORRECTIONS.md` — both specify mutants precisely
- `docs/design/contracts/RUNTIME-A2-CREDENTIAL-ESCAPE-GOAL.md` — three named controls
- `command-client-d036-inversion-arm-gemini-BLOCK.md` — the 4xx control, with its three named tests

Where a domain has **no** recorded control, say so explicitly in the row rather than inventing one.
An honest "no control exists for this" is the single most valuable output here — it tells the Stage 7
runner where the gate is blind. Do not fabricate a plausible-looking mutant.

## Two binding instrument rules to state at the top of the register

Both were learned the hard way this release; put them where the runner cannot miss them:

1. **Per-test, never whole-file.** `--test-name-pattern` + `--test-concurrency=1` + an **external
   wall-clock watchdog** (no `timeout`/`gtimeout` on this machine — background-and-kill). Node
   enforces `--test-timeout` with a timer in the same process, so a microtask-starved loop never
   reaches the timers phase and the timeout cannot fire. **A hang is not evidence.**
2. **A green mutant is a mandatory stop.** Server Phase B was blocked precisely because a control
   stayed green when the defect was reintroduced. Only a **printed named failure** counts.

## Acceptance

- Every one of the ten domains has a row, or an explicit "no control recorded — gate is blind here".
- Every cited file path and test name **exists** — verify with `grep`, do not transcribe hopefully.
  A register full of paths that do not resolve is worse than none.
- The checklist's §2 points at the register instead of listing bare topics.
- The master plan's "~11 named causal controls" is replaced by a pointer to the register and the
  actual count.

**Do not run the controls.** This lane produces the register; Stage 7 executes it. You may run
`grep`/`ls` to verify paths and names.

## Deliverable

Commit once, push, record the new SHA. The register itself is the deliverable; also note in your
commit message how many domains had recorded controls versus how many are blind.

## Non-goals

No code, no tests, no `src/`, `site/`, `supabase/`, version bump, deploy, tag, or release. Do not run
the test suites or any DB command. Do not join the swarm or set swarm status. No broadcast, no
`AdvisorClaude2`.

## Stop conditions

Preflight fails · a cited path or test name does not resolve and you cannot find the real one ·
you find yourself inventing a mutant to fill a row.

State what you did **not** establish.
