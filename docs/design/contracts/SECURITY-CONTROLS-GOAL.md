# /goal — build real causal controls for the three security-critical blind domains

Worker: **Kerb** (Codex). Lane: closing the worst of the Stage 7 control gap.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE`, asserted in preflight.**

## The finding you are acting on

`docs/design/2026-08-03-STAGE7-CAUSAL-CONTROL-REGISTER.md` enumerated Stage 7's ten required domains
and found **0 of 10 have a causal control**. Every domain has an **observer** — a test asserting the
correct behaviour — but nothing proves the observer would *catch* the defect if it returned.

The Lead spot-checked and confirmed: persist-before-ACK has two ordering observers
(`tests/listener-runtime.test.ts:727` and `:785`) and **no reversal mutant**. The distinction the
register draws is exact and worth internalising: Runtime A2's controls discriminate credential
**classification**, not credential **absence**; Phase B mutates the test harness, not production
one-winner behaviour; the 4xx controls discriminate HTTP taxonomy, not response-loss replay.

An observer that has never been shown to fail is a test whose power is unmeasured. This release has
already been bitten three times by exactly that.

## Scope — three domains, chosen because a silent regression is worst here

Build a genuine causal control for each. **These three, not all ten** — the other seven are
correctness rather than safety, and the Lead is treating them separately.

### 1. Cross-owner zero-tool isolation
The core safety property: an agent must never receive tools or context for a turn whose sender is a
**different owner**. Mutate the authorization/relation check so a cross-owner turn is treated as
same-owner, and prove a named test goes red. Note the *real* two-human canary is operator-blocked —
that is not what this is. This is a **local** mutant proving the local guard has teeth.

### 2. Privacy / no-body
Message bodies must never reach delivery metadata, audit rows, alert JSON, or error responses.
Mutate the code so a body (or a private sentinel) leaks into one of those surfaces, and prove a named
test goes red. Phase C checks privacy while mutating recharge, so its red is **not** a privacy
discriminator — you need one that is.

### 3. Credential absence
A credential must never appear in argv, environment, status output, or logs. Mutate the code to place
a credential-shaped value into one of those, and prove a named test goes red. If **no such assertion
currently exists**, that is the finding — write the observer first, then the control that proves it
discriminates, and say plainly that the observer did not exist before.

## Method — non-negotiable

For each of the three:

1. Identify or write the **observer** (the test asserting the correct behaviour).
2. Apply the **mutant** — the smallest edit that reintroduces the defect.
3. Run **per-test**: `--test-name-pattern="<exact name>"` + `--test-concurrency=1` + an **external
   wall-clock watchdog** (no `timeout`/`gtimeout` here — background-and-kill). `--test-timeout` alone
   cannot bound a microtask-starved loop.
4. Capture the **printed named failure**. A hang is not evidence. **A green mutant is a mandatory
   stop** — report it rather than adjusting the mutant until it goes red.
5. Restore byte-identically and prove it (`git diff --exit-code` on the mutated file).

If a domain's guard turns out not to exist at all, **say so and stop for that domain**. Do not invent
a guard and a control together and present it as coverage — that is the failure mode this whole lane
exists to correct.

## Acceptance

- Three rows added to the control register, each with: mutant (file + exact edit), test name, exact
  invocation, and the **printed** expected failure.
- Each mutant proven red per-test, then restored byte-identically.
- Any domain whose guard does not exist is recorded as such, explicitly, rather than papered over.
- Root `npm test` still green (expect the count to rise if you add observers).

## Gates

`npm test`, `npm run check:tests`, `npm run build`, `git diff --check`. Use the exclusive DB lane only
if a domain genuinely requires it — prove it free first with
`pgrep -f 'test:p1-server|test:p1-local|supabase functions serve' | wc -l` → 0. **Do not deploy.**

## Deliverable

Commit once, push, record the new SHA. Update
`docs/design/2026-08-03-STAGE7-CAUSAL-CONTROL-REGISTER.md` with the three rows and the corrected
coverage count, and write the proofs to
`docs/evidence/2026-08-02-v015-execution/security-causal-controls.md` — **committed, not scratchpad**.

## Non-goals

Do not build controls for the other seven domains. No version bump, deploy, tag, or release. Do not
join the swarm or set swarm status. No broadcast, no `AdvisorClaude2`.

## Stop conditions

Preflight fails · a mutant stays green · a guard does not exist (record and stop for that domain) ·
a restore is not byte-identical · you find yourself weakening a mutant to force a red.

State what you did **not** establish.
