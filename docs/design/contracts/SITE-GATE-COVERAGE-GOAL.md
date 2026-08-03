# /goal — a gate-coverage observer for the site suite, and the six tests it already catches

Worker: **Transom** (Codex). Lane: structural test-reach control for `site/`.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE`, asserted in preflight.**
Owned: `site/scripts/`, `site/package.json` (the `test` script only), and `site/emails/` if wiring
requires it.

## Why this exists

Four times this release a test has proven something while **no gate could re-run it**. The root suite
is guarded — `tests/p1-cli/test-gate-coverage.test.ts` enumerates `tests/**` and asserts every file
is reached (D-030). **The site suite has no equivalent**, and its `test` script is a hand-maintained
list of globs, so a test in the wrong directory or with the wrong suffix silently never runs.

**This is not hypothetical. The gap already has victims — measured before writing this goal:**

```
site/emails/email-templates.test.mjs    2 test blocks   NOT REACHED
site/emails/push-script.test.mjs        4 test blocks   NOT REACHED
```

The site globs are `scripts/*.test.mjs`, `src/components/**/*.observer.mjs`,
`src/components/**/*.observer.test.ts`, plus two literals. None matches `emails/`. The root
`package.json` does not name them either. **Six real assertions have never run**, including
*"email body directory matches the explicit Supabase contract"* — and email delivery is on this
release's critical path, since magic-link sign-in is an open QA item.

## The work — two parts, in this order

### 1. Wire the orphaned tests in, or justify their exclusion

Make `site/emails/*.test.mjs` reachable by `npm --prefix site test`. If any of the six genuinely
should **not** run in that suite (for example if one needs live network or credentials), say which
and why, and give it an explicit, documented home rather than leaving it orphaned.

**Report whether they pass.** Six assertions that have never executed may well be stale — if they
fail, that is a finding, not a failure of this lane. Do **not** edit a test to make it pass; report
it and stop. A test that has not run since it was written is exactly where rot accumulates.

### 2. Add the structural observer

Create `site/scripts/test-gate-coverage.test.mjs`. It self-gates, because it matches the existing
`scripts/*.test.mjs` pattern — that is deliberate; the check must be inside the thing it checks.

It must:

- enumerate every test-shaped file under `site/` (`*.test.ts`, `*.test.mjs`, `*.observer.mjs`,
  `*.observer.test.ts`), excluding `node_modules` and build output;
- parse the patterns out of `site/package.json`'s `test` script rather than hard-coding them, so the
  observer keeps working when the script changes;
- assert `unreachable === []`, and on failure **name the unreached files** — a bare count would leave
  the next person guessing;
- carry at least one **printed mutation control** proving it discriminates: with a pattern removed
  from the script, the observer must go red naming the newly-orphaned files.

Mirror the root observer's structure where it makes sense (`tests/p1-cli/test-gate-coverage.test.ts`)
so the two read alike, but do not import across the repo boundary if that couples them awkwardly.

## Acceptance

- `npm --prefix site test` count **increases** from 94 by the number of newly-reachable tests plus
  the observer's own. State the exact before/after and account for the delta.
- The observer is proven RED by temporarily removing a glob from the site `test` script, printing the
  orphaned filenames; then restored exactly.
- With everything wired, `unreachable` is `[]`.
- Root `npm test` still 365/365.

## Gates

`npm --prefix site test`; clean site build (`cd site && rm -r -- dist && npm run build`);
`npm --prefix site test` again on fresh output; root `npm test`. **Do not deploy.**

## Deliverable

Commit once, push, record the new SHA. Write
`/Users/yulanbot/Developer/Ridge.io/cloud-swarm/docs/evidence/2026-08-02-v015-execution/site-gate-coverage.md`
— **`docs/evidence/`, committed, not `scratchpad/`** — with the before/after counts, the six orphaned
tests' pass/fail results, the mutation control's printed output, and the new SHA.

## Non-goals

No `src/`, `supabase/`, migration, version bump, deploy, tag, or release. Do not modify existing test
assertions. Do not join the swarm or set swarm status. No broadcast, no `AdvisorClaude2`.

## Stop conditions

Preflight fails · the observer cannot be made red by removing a glob (it does not discriminate) · any
orphaned test fails (report it — do not fix it) · the site count does not move · root tests regress.

State what you did **not** establish.
