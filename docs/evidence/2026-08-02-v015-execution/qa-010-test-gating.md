# QA-010 dead-session test gating

Date: 2026-08-03
Worker: Mullion
Branch: `lead7/mvp-release-0.1.5`
Frozen base: `5197e1428f1ab4e5c944829802247a887ad5b665`

The preflight resolved local `HEAD`, `@{upstream}`, and the live
`origin/lead7/mvp-release-0.1.5` head to the frozen base above. The worktree was clean.

## Change

The five existing QA-010 regression tests were adapted from the ignored
`scratchpad/2026-07-31-common-swarm-handoff/QA-010-regression.test.ts` harness into the
site observer convention at
`site/src/components/app/dead-session.observer.test.ts`. That path is matched by the
site test script's `src/components/**/*.observer.test.ts` glob.

No accepted fix file was changed by the result. After the temporary RED control, the
working blobs were checked against `HEAD`:

| Fix file | Restored `git hash-object` and `HEAD` blob |
|---|---|
| `site/src/lib/commonswarm.ts` | `56e0e03b2990b32285de4d5729567ec78a90f2c8` |
| `site/src/components/app/LiveDashboard.astro` | `1f2da169d48fbcb92d6c3322b25556bb70e3975f` |

## Gate reachability: 89 to 94

Before adding the observer, `npm --prefix site test` reported:

```text
tests 89
pass 89
fail 0
```

After adding it, both the pre-build run and the run against freshly built output reported:

```text
tests 94
pass 94
fail 0
```

The count therefore increased by exactly five. All five `QA-010` names appeared in the
ordinary site-gate output.

## RED then GREEN discrimination

For the RED arm, both accepted fix files were temporarily restored to their exact
pre-`f713d47` blobs:

| Pre-fix file | Working blob | `f713d47^` blob |
|---|---|---|
| `site/src/lib/commonswarm.ts` | `4531f5e6c90b7c4e020ade61201288344e46ddbd` | `4531f5e6c90b7c4e020ade61201288344e46ddbd` |
| `site/src/components/app/LiveDashboard.astro` | `07f896a5ea998ddc243843e0a7f40df752503cf8` | `07f896a5ea998ddc243843e0a7f40df752503cf8` |

Running
`node --import tsx --test site/src/components/app/dead-session.observer.test.ts`
then exited 1 with exactly five failures and no passes:

```text
tests 5
pass 0
fail 5
RED_EXIT=1
```

Each required behavior discriminated:

1. The missing server session stayed present locally instead of being cleared and raising
   `SessionExpired`.
2. The command `401 unauthenticated` left the local session present instead of clearing it
   and requesting re-authentication.
3. `inviteEmailValidationMessage` was absent (`typeof` was `undefined`).
4. The dashboard lacked the `SessionExpired` signed-out/re-authentication branch.
5. The invite form lacked `novalidate` and the validator-routing block.

After restoring the accepted fix exactly, the same command exited 0:

```text
tests 5
pass 5
fail 0
```

No test passed against the reverted fix; all five discriminate.

## Required gates

| Gate | Result |
|---|---|
| Initial `npm --prefix site test` | 94/94 |
| `cd site && rm -r -- dist && npm run build` | exit 0; clean static build produced 8 pages |
| Fresh-output `npm --prefix site test` | 94/94 |
| Final `npm test` | 365/365 |

The first two full root attempts exposed an unrelated teardown race in
`detached CLI cursor fallback still receives and replies`: both reached 365 tests but
reported 364 passes and one `ENOTEMPTY` from recursive removal of a unique temporary
directory. The exact owning test file passed 4/4 in isolation, and a subsequent unmodified
`npm test` invocation passed 365/365. No out-of-scope test or runtime file was changed.

## Result commit

This evidence is part of the single result commit. Its exact SHA is resolved without a
self-referential literal by:

```sh
git log -1 --format=%H -- docs/evidence/2026-08-02-v015-execution/qa-010-test-gating.md
```

The pushed SHA is also recorded in the completion handoff.

## Not established

This work did not deploy or test production, exercise a real hosted Supabase session,
validate browser rendering or accessibility, change the accepted QA-010 fix, fix or explain
the unrelated root-suite teardown race, run database/edge integration suites, tag a release,
or establish that this commit is landed on another branch. It establishes only that the five
QA-010 observers are now reached by the ordinary site gate, discriminate against the exact
pre-fix behavior, pass with the accepted fix, and coexist with the green build/site/root gates
recorded above.
