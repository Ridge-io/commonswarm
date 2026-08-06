# Plan: get CommonSwarm to "just work" — v2, post-review

CswarmLead, 2026-08-06. v1 went to two adversarial reviewers (Fable, and Codex cross-family).
**Six BLOCKING findings between them. v1 is superseded; the corrections are the plan.**

## What v1 got wrong

### 1. It would have shipped a field regression (both reviewers, BLOCKING)

v1 proposed 0.1.7 with "the classifier **if it lands**" — making the *safety* condition optional
while the *regression* shipped unconditionally. That is backwards. Verified chain:

| link | measured |
|---|---|
| pooler exhaustion arrives as `XX000` | `RETRYABLE_CODES` has `53300`, **not** `XX000` (control: 1 vs 0) |
| so the server marks it non-retryable | `read/diagnostics.ts`, `retryable: isRetryableErrorCode(code)` |
| post-D-051 client honours that as a veto | `src/cloud/signals.ts:1566` → `return false` |
| `cswarm inbox --follow` has **no supervisor** | D-056, reopened on `main` at `19cf963` |
| the installer serves `latest` | `VERSION="${CSWARM_VERSION:-latest}"`, on the **deployed** file |

**0.1.6 retries indefinitely — ugly, amplifies load, but survives a transient fault. 0.1.7
without recovery dies at the first refusal, silently, per host, with no supervisor to restart
it.** D-056 measured 25% cold-start death. 100% of new installs get it the moment it publishes.

*"Self-clears within seven minutes is irrelevant to a dead receiver."* — Codex. And that seven
minutes was measured with probe load **ceasing**; fielded 0.1.6's retry storm is itself load
that need not cease, so the precondition is violated by the fielded client's own behaviour.

**RULE: 0.1.7 does not ship until a pooler refusal cannot permanently kill an unsupervised
receiver.** Bounded recovery is a **ship gate, not a passenger.**

### 2. The server classifier is not a substitute, and its deploy vehicle was unnamed (BLOCKING)

Classification and supervision solve **different** failures: classification controls immediate
retry amplification; supervision restores liveness after server mistakes, version skew, and
outages. v1 treated one as replacing the other.

The contract needs to be **tri-state — retryable / terminal / unknown**. Unknown must stop
request amplification *and* remain eligible for bounded restart. Defaulting unknown to either
unrestricted retry or permanent refusal is wrong in opposite directions.

And the classifier lives inside `read`. One `read` deploy also flips capability advertisement
into D-040/41/42 territory and changes relation semantics. The operator's freeze lift is not
recorded in the register, with no scope, rollback, or statement of how the coupled changes stay
disabled. **Architecturally correct, operationally unexecutable until the vehicle is named.**

### 3. The diagnosis was a hypothesis dressed as a diagnosis (both, BLOCKING)

v1: *"nothing has been run end to end."* **Falsified** by charter item 4 — the 2026-07-29
two-machine dogfood ran install → OAuth → create → post. The defensible claim is narrower:
*not run by a stranger, and not re-run since the 0.1.6-era changes.*

Worse, **the evidence and the remedy were misaligned**: the logout wedge is a *day-2,
expired-session* defect. A cold walk starts from fresh login and **would never have reached it.**

And *"without thresholds, the hypothesis cannot lose"* — any stop confirms it, a clean run gets
dismissed as one sample. **Falsification criteria are now declared before testing:** the
diagnosis is weakened if strangers complete the first-value journey unaided at ≥4/5; if failures
cluster in already-known invite/capacity defects rather than new seams; if failures correlate
with load/duration/platform rather than journey step; or if new defects would have been caught
by a correctly designed adversarial control — which would mean depth, not coverage, is the
constraint.

### 4. Wren is not a stranger (both, BLOCKING)

The charter explicitly rejects operator dogfood as evidence for items 1 and 5. Wren can find
mechanical stops; Wren **cannot** certify "without being walked through it" or comprehension.
Items 2 and 3 also require *cold-browser* creation and acceptance *without a terminal ritual* —
v1's route used the terminal for both, so it could not have closed them either way.

### 5. The artifact was never pinned (Codex, BLOCKING)

v1 mixes public 0.1.6, unversioned `main`, `lead/logout-wedge`, and deployed `read` v6.
**Fix-as-you-go across changing artifacts does not combine into an end-to-end pass.** Every run
records: installer URL, binary SHA-256, source SHA, deployed function version, config, time
window.

### 6. Phase 2 violated the repo's own control doctrine (Codex, BLOCKING)

v1 had the fix lane author its own regression test. Repo doctrine: *an adversarial control must
be written by a non-author asking what input makes this pass wrongly.* D-036 review does **not**
substitute for that control. Every fix now needs a **non-author causal control, demonstrated
RED→GREEN**.

## The corrected plan

**0. Fix the logout wedge properly.** `ff5f68b` is BLOCKED — three versions, each fixing a real
defect and each destroying state on input whose cause was not established. Required shape:
closed terminal-code allowlist, **retain by default**, explicit local-clear escape hatch,
truthful copy. Non-author control required.

**1. Cheap slice before expensive journey.** A short first-value slice with *actual strangers*:
homepage → choose an on-ramp → install/auth → first signal. Record assistance, elapsed time,
wrong turns, artifact hash, first stop. Do **not** spend the two-machine run until this supports
the hypothesis. Add a **day-2 leg** — expired session, network loss mid-follow, lapsed invite,
token expiry mid-listen — because that is where the one bug we have actually lived.

**2. Help-screen baseline, then cut.** One narrow cold comprehension observation against the
shipped help, then revise, then run the full journey on the release candidate.
**v1's six-verb set was too aggressive**: it omitted `accept`, `status`, `logout`, `workspaces`,
`use` — including **the recovery verb implicated by the wedge**. Default help gets task groups:
start, collaborate, navigate, recover. `--all` holds machine and fixture commands.

**3. Fix by harm, not by step.** "Earliest stop first" mis-ranks: a credential leak or silent
data loss at step 6 outranks copy friction at step 2. Enumerate all stops (give controlled
assistance and continue), then prioritise by user harm and reversibility.

**4. 0.1.7 = logout fix + bounded recovery + Phase 3 findings**, on one pinned release candidate,
with a rollback/yank procedure named **before** publishing, and the full release loop included
(GitHub release + checksums, root manifest + lockfile, site rebuild, Vercel deploy with trap 5,
`npm --prefix site test`) — otherwise `/download` says 0.1.6 while `latest` installs 0.1.7.

**5. Capacity is a launch risk, not just Phase 5 engineering.** The value prop *is* sustained
concurrency, and that is exactly the ~24-concurrent cliff against a ceiling of 41 on this tier.
**Our own dogfood fleet shares the production pool** — measured: the local swarm targets
`ukezjcnxjvkpkeezxaew`, 8 seats in this swarm alone, and the "resting demand of ~17" that was
being clipped at 15 is substantially *our own agents competing with users for the same slots*.
Two decisions belong to the operator: tier upgrade, and whether the fleet stays on the
production pool. Transaction-mode pooling stays a hypothesis until a before/after with a
deliberate failing control and a prepared-statement compatibility check.

## Not established

Whether the four D-047 freeze conditions have been met since 2026-07-31. Whether the operator's
freeze lift is recorded anywhere outside chat (no register entry found). Whether fielded 0.1.6's
follow retry is literally unbounded or merely long. Whether the edge driver uses prepared
statements. Neither reviewer executed a production journey, installed a release, or re-ran the
495 tests.
