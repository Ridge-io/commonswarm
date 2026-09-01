# L22 — `cswarm resume`

Commit: `ac8fcde4bbfd7839ad1850911c6d6b34ab9a3b46` (`feat: add read-only reconnect resume command`)

## Result

- Added ordered, read-only `cswarm resume` identity, listener, watcher, brain, and inbox checks.
- A live listener reports its running `cswarm` version. A mismatch prints one loud restart command.
- Watchers match only credential paths and/or principal IDs. Token text is never matched or printed.
- Darwin `lsof` distinguishes a live unix-pipe reader from `->(none)`. Unknown host shapes say `cannot determine`.
- Orphan PIDs get an exact `kill` recommendation. The command never kills them.
- Brain and hook high-water files are previewed without locks, writes, or missing-directory creation.
- `inbox --notify` maps stdout `EPIPE` to stable code `notify_stdout_closed`, exits 74, and does not advance its cursor.
- The onboarding restart text now points to `cswarm resume`.

## Output sample

```text
Identity
You are Rivet (bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb).
Next: use this principal for every listener, watcher, brain, and inbox check below.

Listener
Found under /tmp/cswarm/listeners/sample. State: ready, reported by running PID 4101.
VERSION MISMATCH: listener runs 0.1.42; installed 0.1.44 — restart it: cswarm listen stop --agent-token-file /tmp/resume-agent.json --url https://api.example.test --anon-key anon-sample --workspace-id aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa && cswarm listen start --agent-token-file /tmp/resume-agent.json --url https://api.example.test --anon-key anon-sample --workspace-id aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --provider claude --permissions allow --route main

Notify watchers
Checked process arguments for inbox --notify matching --agent-token-file /tmp/resume-agent.json or --principal-id bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.
Found: 2.
- PID 5101: stdout has a live pipe reader; matched credential path.
- PID 5102: ORPHAN: stdout pipe has no reader; matched principal id.
Next: stop only the orphan watcher; CommonSwarm did not kill anything: kill 5102

Brain digest
Checked /tmp/cswarm/listeners/sample/brain-digest.json without advancing it.
[CommonSwarm brain] 2 topics; NEW/UPDATED since your last check: restart v2. Read: cswarm brain get <topic>

Unread inbox
Unread directed asks and notes from the same read used by the hook: 2.
Next: read them without acknowledging them first: cswarm inbox --agent-token-file /tmp/resume-agent.json --url https://api.example.test --anon-key anon-sample --workspace-id aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa

Read-only check complete. No cursor, brain high-water, listener status, receipt, acknowledgement, or process was changed.
```

## EPIPE measurement

Measured on Darwin with a real OS stdout pipe, not a fake stream. The test destroyed the only reader before the read service returned the next message.

- child exit: `74`
- stderr code: `[notify_stdout_closed]`
- cursor bytes before/after: identical
- stored cursor stayed on `11111111-1111-4111-8111-111111111111`; the unread `22222222-2222-4222-8222-222222222222` was not stored
- Darwin `lsof -F` showed a live stdout unix peer as `tunix` plus `n->0x...`, and a dead reader as `tunix` plus `n->(none)`

## Mutation control

Mutation: moved `store.write(cursor)` before `emit(row)`.

Result: the focused suite exited 1. The EPIPE test showed the cursor had wrongly changed from the old signal at `11:00` to the unread signal at `12:00`. The correct write-after-output order was restored; the focused suite then passed 4/4.

## Required gate tails

```text
npm run build
> tsc
> chmod 755 dist/cli.js
exit 0

npm test
tests 684
pass 684
fail 0
duration_ms 12295.185833
exit 0

npm run test:p1-cli
tests 385
pass 385
fail 0
duration_ms 31766.075584
exit 0

npm run check:tests
> tsc -p tsconfig.tests.json
exit 0
```

Focused onboarding prompt observer: 10/10 passed.

## Not established

- The required two independent model-family review verdicts were not obtained. Gemini returned only `Error: timeout waiting for response`; two Grok attempts read the code but stalled without a verdict and were stopped. Neither counts as a review.
- Non-Darwin stdout-reader classification was not measured. Unsupported or ambiguous `lsof` shapes return `cannot determine`.
- EPIPE was measured with a real Darwin anonymous pipe, not every host Monitor implementation.
- No production API, live listener, or live watcher state was exercised. Network tests used loopback and all local state used temporary homes.
- A listener created by an older binary has no running-version field. `resume` reports `cannot determine` and recommends a restart.
- More than 100 inbox rows are not counted exactly; the output says `at least` for a full or malformed page.
- The full site build and full site test suite were not gates for this lane. The changed prompt's focused observer suite passed.
- Nothing was pushed, released, or deployed.
