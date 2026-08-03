# /goal — put the QA-010 regression tests where a gate can reach them

Worker: **Mullion** (Codex). Lane: make an existing, hand-proven verification durable.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE`, asserted in preflight.**
Owned: `site/src/components/app/` only.

## The situation — this is not a new fix, it is an ungated one

The QA-010 dead-session fix is committed and correct (`site/src/lib/commonswarm.ts`,
`site/src/components/app/LiveDashboard.astro`). Its five regression tests were genuinely proven RED
then GREEN **by hand** — but they live at
`scratchpad/2026-07-31-common-swarm-handoff/QA-010-regression.test.ts`, which is **gitignored and
matched by no test script**. Site tests stayed at **89/89** across the fix, because the site glob is:

```
'src/components/**/*.observer.test.ts'
```

and that harness is both misnamed and misplaced. So a real verification exists and **nothing re-runs
it**. This is the third time this release a test has proven something while being unreachable by any
gate; the repo already has D-030 for exactly this shape.

**My goal wrote the deliverable path into `scratchpad/` and never said where tests must live. That is
the cause, and it is mine, not the previous worker's.**

## The work

Move those five tests into the gated suite as
`site/src/components/app/dead-session.observer.test.ts` (or a name matching
`src/components/**/*.observer.test.ts` that fits the existing convention — look at the siblings, e.g.
`access-lifecycle.observer.test.ts`, and match their style).

The five behaviours to preserve, verbatim in intent:

1. load rejects a locally persisted session that is missing on the server;
2. a command `401 unauthenticated` clears the session and requests re-authentication;
3. invite email validation is distinguishable from an auth failure;
4. the dashboard renders an expired session as signed out with a re-auth prompt;
5. the invite form routes empty and malformed input through the validator.

Adapt them to the observer-test conventions the siblings use. Do not weaken an assertion to make it
fit the harness — if a behaviour genuinely cannot be expressed in that style, say which and why
rather than dropping it quietly.

## Acceptance — the count must move

- `npm --prefix site test` goes from **89** to **94** (or state the exact number and why it differs).
  A run that still reports 89 means the tests are still not reached, which is the entire defect.
- **Each of the five must be proven RED before GREEN in its new home**, against the pre-fix source
  behaviour. Reverting the fix in `commonswarm.ts` and watching them fail is the cleanest proof.
  A test that passes with the fix reverted does not discriminate and must be reported as such.
- Delete nothing from `scratchpad/` — it is gitignored and irrelevant either way.

## Gates

`npm --prefix site test`; clean site build (`cd site && rm -r -- dist && npm run build`);
`npm --prefix site test` again on fresh output; root `npm test` (expect 365/365). **Do not deploy.**

## Deliverable

Commit once, push, record the new SHA. Write
`/Users/yulanbot/Developer/Ridge.io/cloud-swarm/docs/evidence/2026-08-02-v015-execution/qa-010-test-gating.md`
— note this is `docs/evidence/`, **committed**, not `scratchpad/` — with the before/after site test
counts, the five red-then-green proofs, and the new SHA.

## Non-goals

Do not change `site/src/lib/commonswarm.ts` or `LiveDashboard.astro` — the fix is accepted; you are
gating it, not revising it (reverting temporarily to prove RED is expected, restore exactly). Nothing
outside `site/src/components/app/`. No `src/`, `supabase/`, version bump, deploy, tag, or release. Do
not join the swarm or set swarm status. No broadcast, no `AdvisorClaude2`.

## Stop conditions

Preflight fails · the site test count does not increase · any test cannot be made red with the fix
reverted · a sibling test regresses · the fix files end up modified in your commit.

State what you did **not** establish.
