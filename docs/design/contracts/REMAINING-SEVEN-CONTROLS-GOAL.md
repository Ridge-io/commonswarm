# /goal — close the seven remaining blind Stage 7 domains

Worker: **Purlin** (Codex). Lane: finishing the Stage 7 control coverage.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE`, asserted in preflight.**
**The Lead will not commit to this branch while you hold it.** Push when done; you own the lane.

## Where this stands

`docs/design/2026-08-03-STAGE7-CAUSAL-CONTROL-REGISTER.md` found **0 of 10** Stage 7 domains had a
causal control. A prior lane closed three (cross-owner zero-tool isolation, privacy/no-body,
credential absence) and set the precedent for method and honesty — read
`docs/evidence/2026-08-02-v015-execution/security-causal-controls.md` before starting; match its
standard.

**Seven remain blind.** Each has an **observer** — a test asserting correct behaviour — but nothing
proves the observer would *catch* the defect returning. That is the gap.

| Domain | Where it lives | Slot |
|---|---|---|
| Enqueue/backfill | `tests/p1-server/command.test.ts` | DB |
| Claim one-winner | `tests/p1-server/command.test.ts` | DB |
| Stale-lease requeue | `tests/p1-server/command.test.ts` | DB |
| Poison ceiling | `tests/p1-server/command.test.ts` | DB |
| Response-loss replay | `tests/listener-engine.test.ts` | no |
| Persist-before-ACK | `tests/listener-runtime.test.ts` (observers at `:727`, `:785`) | no |
| Note with zero prompts | `tests/listener-runtime.test.ts` | no |

**Do the three non-DB domains first.** They need no slot, so they bank progress before any
contention. Then take the exclusive lane for the four server domains.

## Method — identical to the lane that closed the first three

For each domain:

1. Identify the **observer** already present (the register names it; verify the name resolves).
2. Apply the **mutant**: the smallest production edit that genuinely reintroduces the defect. For
   persist-before-ACK that means **reversing the order** so the ACK is issued before the effect is
   persisted. For claim one-winner, an edit that permits two live winners. And so on — the mutant
   must break the *invariant*, not merely make a test unhappy.
3. Run **per-test**: `--test-name-pattern="<exact name>"` + `--test-concurrency=1` + an **external
   wall-clock watchdog** (no `timeout`/`gtimeout` here — background-and-kill).
4. Capture the **printed named failure**. **A hang is not evidence.**
5. **A green mutant is a mandatory stop for that domain** — record it and move on. Do not adjust the
   mutant until it goes red; that is fitting the control to the answer.
6. Restore byte-identically and prove it: `git diff --exit-code -- <file>` must exit 0.

## The honesty requirement, which outranks coverage

If a domain's guard **does not exist**, or the observer does not actually assert the invariant, say
so and stop for that domain. **Do not invent a guard and its control together and present that as
coverage** — that is precisely the failure this whole effort exists to correct, and a truthful "this
domain has no guard" is worth more than a fabricated green row.

Partial coverage reported honestly beats seven rows of manufactured confidence. If you close four of
seven and three have no real guard, that is a **good** outcome and I want it stated plainly.

## Acceptance

- Each of the seven is either **closed** (mutant → printed named red → byte-identical restore) or
  **explicitly recorded as having no real guard**, with the reason.
- The register's coverage count is updated to the true number.
- `npm test` green; if you touch the server domains, exactly one full `npm run test:p1-server` at the
  end, with a zero-process proof before it
  (`pgrep -f 'test:p1-server|test:p1-local|supabase functions serve' | wc -l` → 0).
- Every mutated file restored, proven by `git diff --exit-code`.

## Deliverable

Commit once, push, record the new SHA. Update the register, and write proofs to
`docs/evidence/2026-08-02-v015-execution/remaining-seven-controls.md` — **committed, not scratchpad**.
State in your commit message how many of the seven closed and how many have no guard.

## Non-goals

Do not fix any product defect you find — record it and stop; a fix moves the release SHA and restarts
review. No version bump, deploy, tag, or release. No `site/`. Do not join the swarm or set swarm
status. No broadcast, no `AdvisorClaude2`.

## Stop conditions

Preflight fails · a mutant stays green (record, move on) · a restore is not byte-identical · residual
processes survive a DB step · you find yourself weakening a mutant or inventing a guard to fill a row.

State what you did **not** establish.
