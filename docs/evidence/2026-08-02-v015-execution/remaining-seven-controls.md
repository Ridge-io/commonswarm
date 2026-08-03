# Remaining seven Stage 7 causal controls

Date: 2026-08-03. Worker: Purlin. Frozen base:
`0b4e6185daac4432b606bf1874fe4619d6ffdc5a`.

## Preflight and instrument

Before any edit, all three required refs resolved to the frozen base:

```text
HEAD                                      0b4e6185daac4432b606bf1874fe4619d6ffdc5a
origin/lead7/mvp-release-0.1.5            0b4e6185daac4432b606bf1874fe4619d6ffdc5a
live refs/heads/lead7/mvp-release-0.1.5    0b4e6185daac4432b606bf1874fe4619d6ffdc5a
```

The worktree was clean. Every focused run used the exact `run_one_control` wrapper printed in
`docs/design/2026-08-03-STAGE7-CAUSAL-CONTROL-REGISTER.md`: an anchored exact
`--test-name-pattern`, `--test-concurrency=1`, and a separate background wall-clock watchdog. The
slot-free controls used 30 seconds; the server controls used 90 seconds. Every credited control
exited 1, printed the exact named test, and produced no `WATCHDOG FIRED` marker. Hangs and failures
before the mutated domain were not credited.

The exclusive DB lane began only after:

```text
pgrep -f 'test:p1-server|test:p1-local|supabase functions serve' | wc -l
0
```

The already-running local stack was reset, the generated command core was rebuilt, and the process
count was re-proved as zero before the server mutations. No swarm join, status, broadcast, or
AdvisorClaude2 contact occurred.

## Outcome

| Domain | Disposition |
|---|---|
| Response-loss replay | **Closed** — named red, exact restore |
| Persist-before-ACK | **Closed** — named red, exact restore |
| Note with zero prompts | **Closed** — named red, exact restore |
| Enqueue/backfill | **Closed** — trigger and backfill each named red, exact restore |
| Claim one-winner | **Not closed** — exact two-lock mutant stayed green; mandatory stop |
| Stale-lease requeue | **Closed** — named red, exact restore |
| Poison ceiling | **Closed** — coherent two-guard mutant named red, exact restore |

Result: **6 of the 7 domains closed; 0 were classified as having no production guard; 1 remains
blind after a green-mutant mandatory stop.** Together with the earlier three security controls, the
Stage 7 register now credits **9 of 10** domains.

## 1. Response-loss replay

Existing guard: `ListenerEngine.process()` resumes directly into `post()` when the stored effect
already has `replyBody`; the exact persisted body and deterministic command ID are reused.

Existing observer: `tests/listener-engine.test.ts` —
`lost response replays the persisted body/id without prompting again`.

Exact mutant:

```diff
-    if (record.replyBody !== null) {
-      return await this.post(signal, record);
-    }
```

This removes only the replay branch. After the first post loses its response, the second engine
prompts again; the injected second model call rejects.

Printed named failure:

```text
✖ lost response replays the persisted body/id without prompting again
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
'failed' !== 'done'
actual: 'failed'
expected: 'done'
control_output=/var/folders/.../tmp.LOW9VEyxeA exit=1
```

Restore: `git diff --exit-code -- src/listener/engine.ts` exited 0. Restored and frozen-base
SHA-256 were both `41ffde86ee68a6876ef45676ae811ab376ffce6b94f1d75a01c0980a0ff214b9`.

## 2. Persist-before-ACK

Existing guard: the durable runtime persists and rereads the terminal effect, persists the
`prepareAck` journal state, rereads it, and only then calls the delivery ACK network path.

Existing observer: `tests/listener-runtime.test.ts` —
`a durable note is persisted and reread before prepareAck and network ACK`.

Exact mutant: immediately after authoritative lease recovery, apply this literal insertion. It
issues the network ACK before any effect-store read/write and before `prepareAck`; the normal code
below was unchanged.

```diff
         const signal = authoritativeSignal(claimed);
+        await deliveryClient!.ackAgentDelivery({
+          workspaceId: options.workspaceId,
+          credential: await options.credentialSession.bearer(),
+          commandId: `ack_${claimed.leaseId.replaceAll("-", "")}`,
+          signalId: signal.id,
+          leaseId: claimed.leaseId,
+          listenerInstanceId: options.listenerInstanceId!,
+          outcome: signal.kind === "note" ? "observed" : "replied",
+          lastErrorCode: null,
+        });
         let terminal: ListenerEffectRecord | null = null;
```

Printed named failure:

```text
✖ a durable note is persisted and reread before prepareAck and network ACK
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  assert.ok(prepareAt < ackAt)
actual: false
expected: true
control_output=/var/folders/.../tmp.RXg4KLzePK exit=1
```

Restore: `git diff --exit-code -- src/listener/runtime.ts` exited 0. Restored and frozen-base
SHA-256 were both `6f885dcecf2052c2ea90af5209c1ec1bb413c84e359c8f45d30b83926ae2a468`.

## 3. Note with zero prompts

Existing guard: the cursor-fallback note branch calls `observeFallbackNote()` and continues before
the ask engine.

Existing observer: `tests/listener-runtime.test.ts` —
`cursor fallback observes direct notes without model or reply effects`.

Exact mutant:

```diff
         if (signal.kind === "note") {
           try {
+            await engine.process({ ...signal, kind: "ask" });
             const record = await observeFallbackNote(options.store, signal, now);
```

This deliberately routes a note into the real model and reply-poster path. The mutant also persists
an ask-shaped effect, so the observer stops at its earlier runtime-result assertion before reaching
its later `model.prompts.length === 0` assertion.

Printed named failure:

```text
✖ cursor fallback observes direct notes without model or reply effects
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected
+ 'fatal'
- 'cancelled'
control_output=/var/folders/.../tmp.X8vt7gmDxq exit=1
```

This establishes discrimination for this exact route-into-ask regression. It does not establish
that the later prompt-count assertion is the first failing assertion.

Restore: `git diff --exit-code -- src/listener/runtime.ts` exited 0, with the same restored/frozen
SHA-256 recorded in §2.

## 4. Enqueue/backfill

The domain has two independent pre-existing guards, so both were mutated independently.

### 4a. Insert trigger

Existing observer: `durable-delivery: trigger enqueue ask/note; broadcast and direct-human do not`.

Exact mutant:

```diff
-  IF NEW.to_agent_principal_id IS NOT NULL AND NEW.kind IN ('ask', 'note') THEN
+  IF NEW.to_agent_principal_id IS NOT NULL AND NEW.kind = 'ask' THEN
```

The local database was reset so this exact trigger definition, rather than the restored file, was
the applied artifact.

Printed named failure:

```text
✖ durable-delivery: trigger enqueue ask/note; broadcast and direct-human do not
AssertionError [ERR_ASSERTION]: note enqueued
actual: false
expected: true
control_output=/var/folders/.../tmp.t4wjhRHIpK exit=1
```

### 4b. Migration backfill

Existing observer:
`durable-delivery: causal migration backfill enqueues pre-existing direct agent signals`.

Exact mutant, scoped only to Section 3:

```diff
-  AND s.kind IN ('ask', 'note')
+  AND s.kind = 'ask'
```

The observer extracts and executes Section 3 from the mutated migration file against three proven
pre-existing rows.

Printed named failure:

```text
✖ durable-delivery: causal migration backfill enqueues pre-existing direct agent signals
AssertionError [ERR_ASSERTION]: pre-existing ask and note signals enqueued by backfill; working-on excluded
1 !== 2
actual: 1
expected: 2
control_output=/var/folders/.../tmp.ZsJxVfJraO exit=1
```

After each arm, `git diff --exit-code --
supabase/migrations/20260731000001_signal_deliveries.sql` exited 0. Restored and frozen-base
SHA-256 were both `58d9409065e150870dba91e6b82eff9d519063c0c25cd55ef88f141695f69d44`.

## 5. Claim one-winner — mandatory green stop

Existing explicit production locks: recipient-principal `FOR UPDATE` serialization and candidate
`FOR UPDATE OF d SKIP LOCKED` selection.

Existing observer: `tests/p1-server/command.test.ts` —
`durable-delivery: concurrent claimers produce one lease winner`.

Exact attempted mutant removed both explicit lock clauses and changed nothing else. Removing only
one would leave the other explicit lock intact, so both removals were the smallest coherent attempt
to permit concurrent selection.

Exact result:

```text
✔ durable-delivery: concurrent claimers produce one lease winner
tests 1
pass 1
fail 0
control_output=/var/folders/.../tmp.4774EtOjme exit=0
GREEN MUTANT — mandatory stop
```

Per the binding rule, no alternate query shape, delay, iteration count, fixture, or stronger mutant
was attempted. This domain receives **no causal-control credit**. The result does not establish that
the explicit locks are unnecessary: PostgreSQL update serialization or this single test topology
may still prevent the two-winner state. It establishes only that this exact observer did not
discriminate this exact two-lock removal.

Restore: `git diff --exit-code -- supabase/functions/command/durable-delivery.ts` exited 0. Restored
and frozen-base SHA-256 were both
`d40f0acb0c221bccebfb3c6ca52fbfbcedae54a2ceef289890f3565221acf037`.

## 6. Stale-lease requeue

Existing guard: Step 2 of `claimAgentInbox()` clears stale lease identity, increments expiry
metadata, and makes the row eligible for candidate selection without acknowledging it.

Existing observer: `durable-delivery: stale lease requeues; signal TTL expires once; tenth claim poisons`.

Exact mutant:

```diff
       AND lease_id IS NOT NULL
       AND leased_until <= statement_timestamp()
+      AND false
```

The first run failed before the domain at the fixture's initial `post_signal` with an unrelated
upstream 502. It is explicitly **non-evidence**. There were zero residual processes and the local
stack remained healthy, so the exact unchanged mutant and invocation were repeated once.

Printed named causal failure on that unchanged run:

```text
✖ durable-delivery: stale lease requeues; signal TTL expires once; tenth claim poisons
AssertionError [ERR_ASSERTION]: stale lease requeues for redelivery
actual: false
expected: true
control_output=/var/folders/.../tmp.gndrSfgnY8 exit=1
```

Restore: the `durable-delivery.ts` diff exited 0 and its hash matched §5.

## 7. Poison ceiling

Existing guard set: `DELIVERY_MAX_ATTEMPTS = 10` controls both terminalization and candidate
selection, while the table independently constrains `attempt_count` to 10.

A TypeScript-only shift to 11 was **non-evidence**: the unchanged database constraint rejected the
attempt-11 update, returning `500 internal_error` before the boundary assertion. That result exposed
the second production guard. The smallest coherent invariant-breaking mutant therefore changed both
guards:

```diff
-export const DELIVERY_MAX_ATTEMPTS = 10;
+export const DELIVERY_MAX_ATTEMPTS = 11;

-  CHECK (attempt_count BETWEEN 0 AND 10),
+  CHECK (attempt_count BETWEEN 0 AND 11),
```

The local database was reset with both exact changes before the per-test invocation.

Printed named failure:

```text
✖ durable-delivery: stale lease requeues; signal TTL expires once; tenth claim poisons
AssertionError [ERR_ASSERTION]: terminal_delivery_failure_count is 1 on terminalizing claim
0 !== 1
actual: 0
expected: 1
control_output=/var/folders/.../tmp.vCn5By6OR9 exit=1
```

Both files were restored. Each `git diff --exit-code` exited 0, and both restored/frozen hashes
matched the values in §§4–5.

## Final repository gates

- `npm test`: **PASS — 370 tests, 370 pass, 0 fail**.
- `npm run check:tests`: **PASS**.
- `npm run build`: **PASS**.
- `npm run check:edge`: **PASS** over the command, read, and capability entrypoints.
- `git diff --check`: **PASS**.
- Restored-tree `npm run db:reset`: **PASS**.
- Pre-full-server process proof: **0**.
- Exactly one final `npm run test:p1-server`: **PASS — 69 tests, 69 pass, 0 fail**, duration
  91.630 seconds.
- Post-full-server process proof: **0**.
- Final `git diff --exit-code` passed for every mutated production/migration path:
  `src/listener/engine.ts`, `src/listener/runtime.ts`,
  `supabase/functions/command/durable-delivery.ts`, and
  `supabase/migrations/20260731000001_signal_deliveries.sql`.

## What this establishes

Six of the seven previously blind domains discriminate the exact regressions recorded above. Every
credited mutant produced a finite printed named failure and every production/migration mutant was
restored byte-identically. Claim one-winner honestly remains blind after its mandatory green stop.

## What this does not establish

- Claim one-winner has no causal control from this lane. No alternate mutant or race amplification
  was attempted after the green result.
- The note control does not make its prompt-count assertion the first red; its earlier fatal-stop
  assertion catches the route-into-ask mutant.
- The controls cover these exact local and local-Supabase topologies, not every possible mutation of
  the same product properties.
- No hosted-service, production, deployment, real-load, longevity, or two-human canary behavior was
  established. Nothing was deployed, tagged, released, or version-bumped.
