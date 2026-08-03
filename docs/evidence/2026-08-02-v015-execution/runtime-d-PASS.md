# Runtime D result — Lintel2

Frozen base: `b7cdb5b50968f5ae0f2ca9453a3a858277a1e9b2`  
Committed and pushed candidate: `0f5bbcff03e3839340c1fa99dbd979fe62380bb3`  
Branch: `lead7/mvp-release-0.1.5`

## Preflight and scope

- Before any edit, `HEAD`, `origin/lead7/mvp-release-0.1.5`, and the live remote head all resolved
  to the frozen base.
- Read completely: root `AGENTS.md`, Runtime D goal, Runtime C/D preflight corrections, Runtime C
  goal, the verified-partial Runtime C fixture evidence, and the simplification doctrine required by
  `AGENTS.md`.
- `package.json` remained unchanged. Its root test script contains 27 literal paths and 27 unique
  paths. It reaches both Runtime D test files and the Runtime C/A2/B guard files:
  `listener-runtime`, `listener-engine`, and `listener-control`.
- The frozen-base range contains exactly one commit and these five paths only:
  `src/cli.ts`, the permitted comment in `src/cloud/delivery.ts`, the narrow reducer hardening in
  `src/listener/supervisor.ts`, and the two owned test files.

## CLI surface implemented

- `runConfiguredListener` now retains an initially unset journal and selected listener ID.
- Supervisor `prepare(proposedInstanceId)` opens the journal under the startup lock with the exact
  profile/workspace/principal/state-directory/proposed UUID, retains the selected journal and UUID,
  and returns that UUID.
- Supervisor `run` fails closed if preparation did not retain a journal or if its listener UUID
  differs. Runtime receives the same UUID and retained journal plus the existing effect store,
  model, credential session, signal, and event callback. No delivery client is injected, so Runtime
  C constructs the accepted default. No second UUID or delivery retry/claim/ACK policy was added.
- Status JSON explicitly normalizes all six omitted legacy delivery fields to `null` and adds no
  duplicate delivery snake-case aliases.
- Human status distinguishes durable claim/ACK from cursor fallback, prints a pending count only
  when non-null, preserves zero as zero, and prints one bounded terminal-failure sentence only for a
  positive count.
- The delivery transport comment now says transport never logs or persists the lease while the
  secure listener journal intentionally may persist it for exact ACK recovery.

## Supervisor hardening

- `delivery_ack` has an explicit branch.
- A future/unrecognized runtime event no longer updates ACK status. It emits only the bounded
  `listener_malformed_event` metadata marker; no fields from the unknown event are copied into the
  log.

## Per-test causal controls

Every causal control used an exact `--test-name-pattern`, `--test-concurrency=1`, and an external
wall-clock watchdog. All watchdogs remained clear; no hang was counted as evidence.

| Named test | RED before implementation | GREEN after implementation |
|---|---:|---:|
| legacy listener status JSON normalizes exactly six delivery fields to null | exit 1, named `undefined` vs `null` assertion, 1 s | 1/1, 1 s |
| unrecognized supervisor runtime events never become delivery ACKs | exit 1, named `lastAckAt` assertion, <1 s | 1/1, <1 s |
| listen status distinguishes delivery modes and null zero positive counts | exit 1, named missing durable-mode copy assertion, <1 s | 1/1, <1 s |
| detached CLI completes durable claim reply ACK with one startup UUID and no secret leakage | exit 1, named `delivery_configuration_missing` startup assertion, 1 s | 1/1, 1 s |

The durable process control completed read-capability → claim → model reply → post → ACK for two
direct asks, proved one UUID across journal/supervisor/runtime and every observed claim/ACK envelope,
proved one concurrent starter won while the loser did not rotate the journal, and checked sender,
body, lease, command, bearer, prompt, reply, and explicit secret sentinels were absent from
stdout/stderr/status/events. A separate cursor-fallback process regression passed 1/1 in 1 s.

## Gates

Final pure gates after the fallback regression was added:

| Gate | Result | Elapsed |
|---|---:|---:|
| `npm test` | 365/365, 21 suites | 4 s |
| `npm run check:tests` | exit 0 | 2 s |
| `npm run build` | exit 0 | 1 s |
| `npm run check:edge` | exit 0, all three named entrypoints | <1 s |
| `git diff --check` | exit 0 | <1 s |

Exclusive database sequence (no product code changed after it; the later change only added the
cursor-fallback process test, which these gates do not reach):

| Gate | Result | Elapsed | Process proof |
|---|---:|---:|---:|
| `npm run db:reset` | exit 0 | 27 s | 0 before / 0 after |
| `npm run test:p1-cli` | 137/137 | 8 s | 0 before / 0 after |
| `npm run test:p1-local` | 4/4 | 7 s | 0 before / 0 after |
| `npm run test:p1-server` controlled rerun | 69/69 | 98 s | 0 before / 0 after |

The first `test:p1-server` observation printed 20 named passes but still had its npm/function-serve
processes alive. It was not counted as green. The processes settled naturally to zero, then the
complete controlled rerun above produced the summary, exit code, elapsed time, and zero-process
footer.

The root `npm test` result includes green Runtime C/A2/B guard files:
`tests/listener-runtime.test.ts`, `tests/listener-engine.test.ts`, and
`tests/listener-control.test.ts`.

## Commit-time proofs and push

Required frozen-file command after the commit:

```text
git diff b7cdb5b50968f5ae0f2ca9453a3a858277a1e9b2..HEAD --stat -- \
  src/listener/engine.ts src/listener/runtime.ts \
  src/cloud/command-client.ts src/listener/delivery-journal.ts
```

Output: empty. The four frozen files changed none.

`git rev-list --count b7cdb5b50968f5ae0f2ca9453a3a858277a1e9b2..HEAD` returned `1`.
After push, local `HEAD`, the tracking ref, and the live remote all resolved to
`0f5bbcff03e3839340c1fa99dbd979fe62380bb3`.

## Not established

This work did not establish deployment, production behavior, or real-load capacity. It did not
deploy, tag, release, bump a version, apply a migration, change an edge function, join or update the
swarm, broadcast, or contact AdvisorClaude2. The required D-036 exact review and independent
cross-family inversion on the pushed SHA are the Lead's next step and were not performed here.
