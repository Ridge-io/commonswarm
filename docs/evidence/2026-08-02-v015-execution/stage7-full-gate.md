# Stage 7 — full gate on the exact release SHA `175f894`

Run by ClaudeCswarm, 2026-08-03. Plan of record: `docs/design/2026-08-02-V015-MASTER-PLAN.md`.

## How the target was pinned

The gate ran in a **detached worktree checked out at `175f894` itself**, not on a branch that could
move under it while the suites ran:

```
HEAD                    175f894f7e3a3e9ec822b5a187331fee7fccd3c5
== git rev-parse 175f894   YES
symbolic-ref HEAD          none — detached
git status --porcelain     0 modified
package.json version       0.1.5
```

That is the "measure the artifact, not its name" rule applied to the gate itself. A green suite on
`lead7/mvp-release-0.1.5` would only have told us about whatever that branch pointed at when the run
finished.

## Results

| Gate | Result |
|---|---|
| `npm run build` (tsc → dist, chmod) | exit 0 |
| `npm run check:tests` (typechecks `tests/` as well as `src/`) | exit 0 |
| `npm test` | **376 / 376** |
| `npm run test:p1-cli` | **143 / 143** |
| `npm run test:p1-local` | **4 / 4** |
| `npm run test:p1-server` | **69 / 69** (see the flake section — the *first* run was 68/69) |
| `npm --prefix site test` | **113 / 113** (after `rm -rf site/dist` + rebuild) |
| `npm run check:edge` (all three Deno functions) | exit 0 — command, read, capability |
| generated `_shared/protocol.js` undirtied by the build | clean |

`db:reset` was run from the frozen worktree before the DB suites, so the schema under test is the
**frozen tree's own migrations** rather than whatever happened to be applied to the local database.
An exclusive DB slot was announced to Lead7, Anvil, Vellum and Girder before it was taken.

## The p1-server flake — characterized, not dismissed

The first `test:p1-server` run failed **68/69**:

```
[TypeError: fetch failed] { [cause]: Error [SocketError]: other side closed
```

It then passed **69/69 on four consecutive re-runs** (one immediate, then three back-to-back).

**Observed rate: 1 failure in 5 runs.** The failure is a transport-layer socket close against the
locally-served edge function, not an assertion failure — no test asserted a wrong value; a request
died in flight.

**What this does NOT establish, stated plainly:** I did not find the root cause, did not identify
which test held the socket, and did not prove the failure is confined to the harness. Four clean runs
are *consistent with* a flaky teardown and do not prove it. "It passed when I ran it again" is not
evidence of flakiness — it is the absence of a second observation.

Recorded as a **known-flaky gate**, not as a resolved issue. It is the same family as the
`listener-cli-process` teardown race fixed earlier in this release (a `finally` that removed a
directory before the child exited), which is a reason to suspect the harness rather than the product
— but suspicion is not a measurement, and this one is unresolved.

## A trap checked and found closed

`AGENTS.md` warns that a file under `tests/support/` is reached by no glob and is silently not run.
This delta lands **two** files there — `agent-receive-cli.test.ts` and
`signal-fetch-deadline.test.ts` (720 lines).

Enumerated rather than assumed: both are **named in the `test` script's literal list**, and D-030's
coverage observer passes all three of its assertions, including *"every test file is reached by an npm
execution script."* The trap is closed for this delta. This is recorded because it is exactly the
shape that produced six ungated observers earlier in this release, and a future reader should be able
to see it was checked rather than hope it was.

## Coverage this gate does not claim

Stage 7's causal-control register (`docs/design/2026-08-03-STAGE7-CAUSAL-CONTROL-REGISTER.md`) covers
**9 of 10 domains** across 22 mutant/test pairs. **Claim one-winner remains blind** — the mutant stayed
green, which by our own rule is a mandatory stop rather than a pass. The suites above being green does
not close it, and reporting these counts as closing it would be the error the plan's §7b explicitly
warns against.

Nothing here establishes deployment, production behaviour, real-load capacity, or the cross-owner
canary. Those are Stages 9-11.
