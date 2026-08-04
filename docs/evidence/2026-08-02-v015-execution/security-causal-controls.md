# Security-critical causal controls

> **Current-state note, 2026-08-04 (D-044):** the cross-owner zero-tool control below is historical.
> The operator retired that local boundary; its current regression proves shared worker delivery and
> provenance. Server-side authority controls remain in force.

Date: 2026-08-03. Worker: Kerb. Frozen base:
`23f341211e38972d4f1280492aa3be664cc8a4c0`.

## Preflight and instrument

Before any edit, all three required refs resolved to the frozen base:

```text
HEAD                                      23f341211e38972d4f1280492aa3be664cc8a4c0
origin/lead7/mvp-release-0.1.5            23f341211e38972d4f1280492aa3be664cc8a4c0
live refs/heads/lead7/mvp-release-0.1.5    23f341211e38972d4f1280492aa3be664cc8a4c0
```

The worktree was clean. Every run used the `run_one_control` wrapper printed in
`docs/design/2026-08-03-STAGE7-CAUSAL-CONTROL-REGISTER.md`: an anchored exact
`--test-name-pattern`, `--test-concurrency=1`, and a separate background 30-second wall-clock
watchdog. In every control below the inner test process exited 1, the wrapper found the exact named
test in its captured output, and no `WATCHDOG FIRED` marker was produced. A hang was not accepted.

All three guards and observers existed before this lane. No guard or observer was invented here.
All three observer files are named literally by the root `npm test` script.

## Final repository gates

- `npm test`: final rerun PASS — 370 tests, 370 pass, 0 fail.
- `npm run check:tests`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS.

The first root run reported one pre-existing cursor-fallback teardown failure (`ENOTEMPTY` while
removing its temporary directory); both security observers passed in that run. The exact existing
cursor-fallback test repeated the cleanup failure once, then passed unchanged in isolation. A full
`npm test` rerun then passed 370/370. No source or test was changed in response.

## 1. Cross-owner zero-tool isolation

Existing guard: `src/listener/engine.ts` selects `worker` only when the persisted sender relation is
exactly `same_owner`; every other relation selects `isolated`.

Existing observer: `tests/listener-engine.test.ts` —
`sender relation selects worker only for exact same_owner`.

Exact mutant:

```diff
-    const mode: ListenerPromptMode = record.senderOwnerRelation === "same_owner"
+    const mode: ListenerPromptMode = record.senderOwnerRelation !== "unknown"
```

This makes `cross_owner` select the tool-capable worker while leaving `unknown` isolated.

Exact invocation:

```sh
run_one_control 30 'tests/listener-engine.test.ts' \
  'sender relation selects worker only for exact same_owner'
```

Printed named failure:

```text
✖ sender relation selects worker only for exact same_owner (4.326667ms)
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    [
      'worker',
  +   'worker',
      'isolated',
  -   'isolated'
    ]
actual: [ 'worker', 'worker', 'isolated' ]
expected: [ 'worker', 'isolated', 'isolated' ]
control_output=/var/folders/.../tmp.IPr6xnpOTq exit=1
```

Restore proof: `git diff --exit-code -- src/listener/engine.ts` exited 0. The restored file and the
frozen-base blob both hashed to
`41ffde86ee68a6876ef45676ae811ab376ffce6b94f1d75a01c0980a0ff214b9` (SHA-256).

## 2. Privacy / no-body

Existing guard: `src/listener/delivery-journal.ts` validates a closed delivery-journal record before
writing the same serialized bytes to disk.

Existing observer: `tests/listener-delivery-journal.test.ts` —
`10. Serialized positive metadata exists, while known bearer/body/owner/prompt/reply sentinels are
absent`.

Exact mutant:

```diff
-    await writeSecureJsonFile(this.journalPath, serialized);
+    await writeSecureJsonFile(this.journalPath, record.active?.phase === "ack_pending" ? JSON.stringify({ ...record, signal_body: "PRIVATE_BODY_SENTINEL" }) : serialized);
```

This leaves earlier journal phases valid, then replaces the final ACK-prepared write with bytes that
contain a private body sentinel after validation.

Exact invocation:

```sh
run_one_control 30 'tests/listener-delivery-journal.test.ts' \
  '10. Serialized positive metadata exists, while known bearer/body/owner/prompt/reply sentinels are absent'
```

Printed named failure:

```text
✖ 10. Serialized positive metadata exists, while known bearer/body/owner/prompt/reply sentinels are absent (26.620292ms)
AssertionError [ERR_ASSERTION]: Sentinel key "signal_body" must be absent

true !== false

actual: true
expected: false
operator: 'strictEqual'
control_output=/var/folders/.../tmp.6Sh3acG17Q exit=1
```

Restore proof: `git diff --exit-code -- src/listener/delivery-journal.ts` exited 0. The restored file and the
frozen-base blob both hashed to
`9ab7ad0502cd66774a3917ae4128ae078818994c6b7c7879251cc415f2f40b6b` (SHA-256).

## 3. Credential absence

Existing guard: `src/listener/control.ts` validates and serializes only closed, metadata-only event
fields; credential-shaped strings are also rejected before serialization.

Existing observer: `tests/listener-control.test.ts` —
`supervisor becomes ready, stops through the socket, and logs metadata only`.

Exact mutant:

```diff
-  const serialized = `${JSON.stringify(event)}\n`;
+  const serialized = `${JSON.stringify({ ...event, credential: "swm_agt_" + "A".repeat(43) })}\n`;
```

This inserts a credential-shaped value after validation, directly into the persisted event-log
surface.

Exact invocation:

```sh
run_one_control 30 'tests/listener-control.test.ts' \
  'supervisor becomes ready, stops through the socket, and logs metadata only'
```

Printed named failure:

```text
✖ supervisor becomes ready, stops through the socket, and logs metadata only (53.877625ms)
AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression
/prompt|body|swm_agt_/i. Input:
'{"ts":"2026-08-03T20:13:56.770Z","event":"listener_starting",...,"credential":"swm_agt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}\n' +
'{"ts":"2026-08-03T20:13:56.770Z","event":"listener_ready","credential":"swm_agt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}\n' +
'{"ts":"2026-08-03T20:13:56.770Z","event":"listener_effect",...,"credential":"swm_agt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}\n' +
'{"ts":"2026-08-03T20:13:56.776Z","event":"listener_stopped","credential":"swm_agt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}\n'
control_output=/var/folders/.../tmp.LMW72eZPb3 exit=1
```

Restore proof: `git diff --exit-code -- src/listener/control.ts` exited 0. The restored file and the
frozen-base blob both hashed to
`eebe21525e2f3e5f7588b689ecb5f74868208d3fae719309cff6fb604d50636c` (SHA-256).

## What this establishes

The three exact local observers discriminate these three exact regressions: cross-owner selection
of the worker prompt mode, a body/private sentinel reaching delivery-journal metadata, and a
credential-shaped value reaching listener event logs. All mutants printed the named assertion
failure and were restored byte-identically.

## What this does not establish

- The real two-human cross-owner canary remains operator-blocked and was not run.
- The privacy control covers the delivery-journal metadata surface, not audit rows, alert JSON, or
  error-response surfaces.
- The credential control covers the listener event-log surface. It does not independently prove
  causal discrimination for argv, environment, status output, or host frames.
- The other seven Stage 7 domains remain blind.
- No database, local Supabase, edge-function, hosted-service, production, load, or deployment
  behavior was established. Nothing was deployed.
