# Pause handoff — v0.1.5, 2026-08-03

Lead: ClaudeCswarm. Paused at operator request with no worker in flight and the tree clean.
Branch `lead7/mvp-release-0.1.5`. **Nothing has been deployed. Production is still v0.1.4.**

Read first: `docs/design/2026-08-02-V015-MASTER-PLAN.md` (rev 2, plan of record),
`docs/evidence/2026-08-02-v015-execution/README.md` (index), `docs/design/contracts/` (every
contract each verdict cites), `docs/org/DEFECT-REGISTER.md` (D-036 is the live review gate).

## Where the release actually is

**All build work is complete and accepted**, each under D-036's two arms with both arms written down:

| Lane | Accepted SHA |
|---|---|
| Runtime A2 (credential escape) | `ab1b240` |
| Server Phase B (control repair) | `5f5018a` |
| Server Phase C (recharge proof) | `e3dc295` |
| Runtime C (durable runtime) | `f30974a` |
| Runtime D (CLI surface) | `0f5bbcf` |

Gates on the integrated tree: **root 365/365**, **site 94/94**, p1-cli 137/137, p1-local 4/4,
p1-server 69/69, typecheck, build, all three edge functions, generated bundle undirtied.

Version is still `0.1.4` — **the freeze has not happened**, which is the point of pausing here: it is
the last fully reversible moment.

## The verdict to act on

M5 (independent review, 2026-08-03): **FREEZE-WITH-CONDITIONS.** Its conditions, in the order the
plan's own discriminator implies — *anything whose failure would require a code change goes first,
because only those restart the review chain*:

1. ~~QA-010 tests gated, 89 → 94~~ **DONE** (`09e046a`, verified independently).
2. **QA-011 host matrix + honest copy.** Measure the identical onboarding path with **Grok CLI** and
   **Claude Code** on the second machine, then make
   `site/src/components/app/LiveDashboard.astro:354` — *"Send one link. They connect their agent."* —
   true or narrow. Add a `DEFECT-REGISTER` entry; QA-011 currently lives only inside the stage-q
   evidence file. **This is the single most important item**, because this repo's most damaging prior
   incident (D-023) was exactly copy in git asserting a state reality did not deliver.
3. **Magic-link cold sign-in** — run it, or record an explicit operator acceptance that it ships
   unproven. It is offered *first* on `/start`.
4. **Remaining Stage Q**: pending-access clearing after invite consumption, remove/revoke with
   attributable history, live feed ≤ 5 s.
5. **Lane R** (ledger/docs reconciliation) and keeping the evidence index current.
6. Then Stage 6 freeze → Stage 7 gate → **Stage 7b two-arm review scoped to the full
   `origin/main..freeze` delta** (`src/cloud/command-client.ts` has an exact arm but **no inversion at
   delta scope** — hold 7b to that).

Also recommended by M5 and not yet done: a **site-suite gate-coverage observer**
(`site/scripts/test-gate-coverage.test.mjs`, self-gating because it matches `scripts/*.test.mjs`).
The root suite has one (D-030); the site suite does not, which is why an ungated test could hide there.

## Open findings

| # | What | Severity | State |
|---|---|---|---|
| QA-008/009 | Roster action geometry — button rendered 21×171px, letters stacked | MINOR | **Fixed** (`160386e`, `9b516a7`), verified by injecting the CSS into the live page |
| QA-010 | A dead session is invisible and permanent: reads succeed, all writes 401, UI insists you are signed in, reload does not clear it | MAJOR | **Fixed** (`f713d47`) and now **gated** (`09e046a`) |
| QA-011 | A Codex-hosted agent cannot complete onboarding; `--agent-token-stdin` is the only credential input the CLI accepts | MAJOR | **Open — needs an operator decision**, see condition 2 |

QA-011 is not a code defect. `src/cli.ts:558` correctly refuses a TTY so a credential can never reach
argv, and `agent-prompt.ts:87-88` tells the agent to stop rather than improvise. The agent obeyed.
The gap is that no supported path exists for a host that cannot pipe stdin, and the site advertises
the outcome anyway. **Do not add a new credential channel under freeze pressure** — that is a new
secret-handling surface and would reopen the credential-escape review that just closed. Defer a real
design (e.g. a short-lived pairing code exchanged over HTTPS) to 0.1.6.

## What needs the operator, and only the operator

1. **QA-011 matrix on the second machine** — Grok CLI and Claude Code, same onboarding path. One
   hour converts "one host fails, support set unknown" into a measured supported-hosts list, which
   *dictates* the shipping copy.
2. **Stage 9 deploy call** (approved in principle; the staged order and rollback boundaries are in
   `V015-RELEASE-CHECKLIST.md`).
3. **Stage 11 cross-owner canary**, `tlangridge` ↔ `Ridgeio`, two machines, two accounts.
4. Magic-link sign-in, if it needs their inbox.

## Method notes worth inheriting

- **Three times this release a test proved something while no gate could re-run it.** Two shapes:
  in-tree but unmatched by a glob (D-030 guards the root suite; the site suite is unguarded), and
  never committed at all because a goal contract sent the deliverable to gitignored `scratchpad/`.
  The acceptance that catches both is **"the counted total must move N→M"**.
- **Twice I claimed more than the repo showed** — "both arms passed" with one on disk, and a
  sign-in headline covering an arm I never ran. Both corrected in place with the wrong line kept and
  marked dead. Writing the lesson down did not prevent the repeat; only the count-must-move and
  write-it-down-now habits did.
- **A worker's honest "not established" is worth more than a confident pass.** Quarry2 said it had
  not established a visually correct control; testing showed its fix changed the failure mode without
  fixing it. Lantern refused to commit when the branch moved under it. Both were right.
- **Run the discriminating control before naming a finding.** "The invite flow is broken" became
  "dead sessions are unrecoverable" only after trying the same flow on a healthy session.

## What this handoff does not establish

Deployment, production behaviour under the new code, real-load capacity, the cross-owner canary, the
longevity canaries, whether Grok or Claude Code can onboard, and whether the v0.1.4 deployed edge
source matches the tree the QA-010 root cause was diagnosed against.
