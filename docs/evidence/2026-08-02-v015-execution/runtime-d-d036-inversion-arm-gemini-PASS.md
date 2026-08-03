# Independent Cross-Family Review: Runtime D (SHA `0f5bbcff03e3839340c1fa99dbd979fe62380bb3`)

**Target Diff:** `git diff b7cdb5b..0f5bbcf` (5 files)  
**Specification:** [`RUNTIME-D-GOAL.md`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/docs/design/contracts/RUNTIME-D-GOAL.md) & [`RUNTIME-C-D-PREFLIGHT-CORRECTIONS.md`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/docs/design/contracts/RUNTIME-C-D-PREFLIGHT-CORRECTIONS.md)  
**Methodology:** Pure static analysis, schema inspection, call-tree tracing, and diff verification.

---

## Detailed Analysis by Review Directive

### 1. The Reducer Hardening (`src/listener/supervisor.ts`)
* **Previous behavior ([`src/listener/supervisor.ts:244-259`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/supervisor.ts#L244-L259)):** `onEvent` evaluated `ready`, `effect`, `read_retry`, `malformed_row`, `delivery_mode`, `delivery_claim`, and `delivery_terminal_failures`. Any event falling through the bottom of `onEvent` was treated as `delivery_ack`, mutating `status.lastAckAt` and logging `listener_delivery_ack`.
* **New check ([`src/listener/supervisor.ts:244-267`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/supervisor.ts#L244-L267)):**
  ```typescript
  if (event.type === "delivery_ack") { ... return; }
  const unknown = event as unknown as { ts?: unknown };
  log({
    ts: typeof unknown.ts === "string" && Number.isFinite(Date.parse(unknown.ts)) ? unknown.ts : iso(now),
    event: "listener_malformed_event",
  });
  ```
* **Exhaustiveness & Regression Evaluation:**
  - **Supported types in `ListenerRuntimeEvent`:** `ready`, `effect`, `read_retry`, `malformed_row`, `delivery_mode`, `delivery_claim`, `delivery_terminal_failures`, `delivery_ack`.
  - Every valid type in `ListenerRuntimeEvent` has a dedicated `if (event.type === ...)` block that returns.
  - An unknown event type now falls past line 260 and logs `listener_malformed_event` without mutating state (`lastAckAt`, `lastSignalId`, etc.).
  - No valid event variant is dropped; `delivery_ack` is explicitly captured.
* **Proof test:** Covered in [`tests/support/agent-receive-cli.test.ts:1190-1226`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/tests/support/agent-receive-cli.test.ts#L1190-L1226).

### 2. CLI Correctness & Leak Prevention
* **Credential / Token / Body Leak Check:**
  - [`listenerStatusJson()`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cli.ts#L2633-L2643) normalizes delivery fields (`deliveryMode`, `pendingDeliveryCount`, `lastTerminalDeliveryFailureCount`, `lastTerminalDeliveryFailureAt`, `lastClaimAt`, `lastAckAt`) to `null` if missing. No bearer tokens, credentials, or signal bodies are contained in these fields.
  - [`renderListenerStatus()`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cli.ts#L2656-L2690) renders process state, provider, start time, error code, delivery mode, pending count, and failure count. No sensitive headers or bodies are included.
  - Process stdout/stderr sentinel check is explicitly verified in [`tests/listener-cli-process.test.ts:700`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/tests/listener-cli-process.test.ts#L700) (`assert.doesNotMatch(started.stdout + started.stderr, /swm_agt_/);`).
* **Unescaped Parameter Handling:**
  - Parameter values are passed directly as typed arguments into filesystem and network APIs (`listenerPaths`, `openListenerDeliveryJournal`, `FileListenerEffectStore`). No string concatenation into subshells (`child_process.exec`) occurs.

### 3. Frozen Files & Scope Boundary Verification
* **Frozen Files Check:**
  ```bash
  git diff b7cdb5b..0f5bbcf --stat -- src/listener/engine.ts src/listener/runtime.ts src/cloud/command-client.ts src/listener/delivery-journal.ts
  ```
  **Result:** `0 files changed` (100% clean, empty diff).
* **Non-functional Comment-Only Check for `src/cloud/delivery.ts`:**
  - Diff shows only a 3-line JSDoc comment clarification on `DeliveryRow.leaseId` ([`src/cloud/delivery.ts:93-96`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cloud/delivery.ts#L93-L96)). No functional code, logic, or types were altered.

### 4. Composition Against Runtime C (`src/listener/runtime.ts`)
* **Execution Flow in [`runConfiguredListener()`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cli.ts#L2829-L2885):**
  1. `prepare` hook executes under `runListenerSupervisor` start-lock.
  2. Calls `openListenerDeliveryJournal(...)` with `proposedInstanceId`.
  3. Returns `{ instanceId: selected.listenerInstanceId }`.
  4. In `run(...)`, asserts `selectedJournal !== undefined` and `listenerInstanceId === selectedListenerInstanceId`.
  5. Invokes `runListenerRuntime` passing `target`, `workspaceId`, `principalId`, `credentialSession`, `store`, `model`, `signal`, `onEvent`, `listenerInstanceId`, and `deliveryJournal`.
* **Contract Integrity:**
  - Matches `ListenerRuntimeOptions` interface in [`src/listener/runtime.ts:135-161`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L135-L161).
  - Supplies the required matching `(listenerInstanceId, deliveryJournal)` pair.
  - Omits `deliveryClient` to allow `runListenerRuntime` to instantiate the standard `DeliveryCommandClient`.

### 5. Resource & Signal Handling
* **Process Listeners:** In [`src/cli.ts:2834-2884`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cli.ts#L2834-L2884), `SIGINT` and `SIGTERM` handlers are registered prior to calling `runListenerSupervisor` and removed in the `finally` block via `process.off("SIGINT", ...)` and `process.off("SIGTERM", ...)`.
* **Child Processes / File Handles:** Test helpers and CLI routines manage resource cleanup using `try ... finally` blocks (`rm`, `server.close()`).

### 6. Scope Boundary Audit
* **Allowed Paths Modified in Delta:**
  - `src/cli.ts` (+69)
  - `src/cloud/delivery.ts` (+7, JSDoc comment only)
  - `src/listener/supervisor.ts` (+16, -10)
  - `tests/listener-cli-process.test.ts` (+359)
  - `tests/support/agent-receive-cli.test.ts` (+85)
* No unauthorized files were edited.

---

## Prioritized Findings

* **CRITICAL:** None.
* **MAJOR:** None.
* **MINOR:** None.

---

## Verdict

**VERDICT: PASS**

---

## What Was NOT Verified
1. Live network communication against real Supabase/cloud endpoints.
2. Runtime database execution (PostgreSQL schema / state transitions).
3. Production server deployment and multi-tenant high-concurrency load capacity.
