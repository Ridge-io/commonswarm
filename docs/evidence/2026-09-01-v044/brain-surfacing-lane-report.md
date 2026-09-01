# Brain surfacing report

Status: DONE in the requested worktree. The work started from `dc9df04`, after the L20 report was present and the baseline `npm test` passed 672/672. No commit, push, deploy, database change, or server-payload change was made.

## What changed

- `cswarm hook check` makes one bounded brain-list operation on its normal single-principal invocation. It uses the same agent `brain ls` list/filter/retry path. It fetches file rows only. It does not fetch topic bodies.
- A Node-only `brain-agent.ts` owns the retrying agent list path. The pure `brain.ts` stays safe for the site browser bundle.
- Hook and listener worker prompts consume the same local per-listener, per-principal state file: `brain-digest.json` in the listener instance directory.
- The state schema is exactly `version`, `principalId`, and `topicVersions`. It contains no body, content, credential, signal, or server field.
- State reads and atomic replaces use the existing secure storage helpers. The directory is 0700 and the state file is verified as 0600. A local file lock makes concurrent hook/worker consumers use one high-water.
- The first successful list stores all current versions but prints only the full count and two newest topics. Later calls print every new or changed topic once. No change prints nothing. A removal updates state without a digest.
- Brain list and state failures are caught at the hook/worker boundary. They print nothing and do not fail the hook or worker prompt.
- The text `Durable finding? cswarm brain put <topic> — see brain get brain-how-to` is appended exactly once by the human receipt CLI when any delivery receipt has outcome `replied`. It is absent for JSON and for all other outcomes. This is print-only and adds no state or network call.
- The onboarding brain section now contains this exact question: `before every status update ask: did I derive anything the next agent would re-derive?`

The digest state is capped at 2,048 topics and 128 KiB. The hook keeps its existing three-second process ceiling. One logical brain-list operation can make the existing single no-response retry; both attempts share the same absolute hook deadline.

## Emit policy

| Condition | State action | Hook / worker output |
|---|---|---|
| First successful list, no topics | Store empty version map | Silent |
| First successful list, topics exist | Store every version | Count plus newest two topics |
| Same names and versions | No material state change | Silent |
| New topic | Store new map | Topic and version, once |
| Version changes | Store new map | Topic and new version, once |
| New topic and version change together | Store new map | Both changes in one line |
| Topic removed | Store map without it | Silent |
| File-list read fails or times out | Do not consume state | Silent; other hook output is byte-identical |
| State read, lock, validation, or write fails | Do not return a digest | Silent; hook/worker continues |
| Listener is not live, credential is missing, or inbox got HTTP 401 | Do not read brain list | Silent |
| Explicit multi-context hook check | Do not spend multiple list reads | Silent digest; signal behavior stays unchanged |
| Receipt outcome is `replied` | No state | One fixed nudge line |
| Receipt outcome is not `replied`, or output is JSON | No state | No nudge |

## Test ownership

- `npm test` literal list reaches the digest state and nudge unit tests in `tests/brain-namespace.test.ts` and the worker-prompt test in `tests/listener-engine.test.ts`.
- `npm run test:p1-cli` reaches the hook round-trip and failure injection through its `tests/p1-cli/**` glob, the real receipt CLI observer, and the onboarding prompt observer.
- No test was placed in an unowned directory.

The tests prove:

- first run shows the newest two and records all versions;
- repeat is silent;
- a new topic emits once;
- a version bump emits once;
- state is 0600 and stores no body/content key;
- worker prompts share the same changed-only store;
- an injected brain-list error leaves hook output byte-identical to an empty successful brain list;
- one normal hook invocation makes one logical brain-list call;
- the fixed nudge appears exactly once for `replied` and zero times for `observed`, `queued`, `expired`, and `failed_terminal`;
- the checkpoint question is present verbatim.

## Mutation result

Mutation: changed the established-state branch in `FileBrainDigestStore.consume` from filtering changed versions to always selecting the newest two.

Command:

```text
node --import tsx --test --test-name-pattern='brain digest state emits' tests/brain-namespace.test.ts
```

RED: exit 1. The second identical check returned a brain digest where the test required `null` (`tests/brain-namespace.test.ts:63`).

The mutation was restored with `apply_patch`. The same command then passed 1/1. The restored code is the code covered by the final gates.

## Final serial gate tails

These six gates passed in this exact order in one uninterrupted run after the browser-safe module split:

```text
$ npm run build
> tsc
> chmod 755 dist/cli.js
exit 0

$ npm test
tests 675
suites 25
pass 675
fail 0
skipped 0
duration_ms 9734.843708

$ npm run test:p1-cli
tests 375
suites 0
pass 375
fail 0
skipped 0
duration_ms 31349.685125

$ npm run check:tests
> tsc -p tsconfig.tests.json
exit 0

$ npm --prefix site run build
8 page(s) built in 388ms
Complete!
exit 0

$ npm --prefix site test
tests 233
suites 0
pass 232
fail 0
skipped 1
duration_ms 8745.805125
```

Earlier gate attempts found three conditions before the final green chain:

1. One `write-retry` timing assertion saw one call instead of two. Its focused two-test run passed, and the full CLI gate later passed 375/375 without a code or test-threshold change.
2. One commit-identity allowlist control returned exit 1. Its focused control passed, and the full CLI gate later passed 375/375 without weakening the guard.
3. The site test found a real browser boundary defect: `brain.ts` had a runtime import of Node-only file code and esbuild could not resolve `node:crypto`. The agent list helper was split into Node-only `brain-agent.ts`; the focused site test and the final site gates then passed.

`git diff --check` passed. A direct protected-path diff check found no changes in `supabase/migrations`, `supabase/functions/read`, `src/cloud/receipts.ts`, or `site/src/lib/signal-feed.ts`.

## NOT established

- No live CommonSwarm service, real agent credential, installed Claude hook, or real listener model was used. Network behavior is established with injected fetchers and the existing CLI fake server.
- No production latency measurement was made. The code shares the existing absolute hook deadline and hard process ceiling, but this lane did not measure a real remote file-list response.
- Digest delivery is noise-safe and at-most-once. State advances before stdout/model consumption completes. A process crash in that small window can suppress one digest; the next call will not repeat it.
- The 2,048-topic and 128-KiB limits were validated in code, not load-tested at the limit.
- No local Supabase, migration, edge-function check, deployment, release, commit, push, or production state change was run.
- No Windows permission behavior was established. The 0600 assertion passed on this macOS worktree.
- No D-036 exact-SHA review arms were run because this lane was explicitly forbidden to create a commit, so there is no new exact SHA to review.
