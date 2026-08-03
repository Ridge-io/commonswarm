# INDEPENDENT CROSS-FAMILY INVERSION ARM (Ruling D-036)

**Target SHA:** `f30974a3c972e116e4b15ac705a70df3b47a33e0`  
**Delta Reviewed:** `b7a086630e5056d5ba3e015d7bf9a1e31aecbee4..f30974a3c972e116e4b15ac705a70df3b47a33e0`  
**Files Modified (3):** [`src/listener/runtime.ts`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts) (+768), [`src/listener/supervisor.ts`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/supervisor.ts) (+72), [`tests/listener-runtime.test.ts`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/tests/listener-runtime.test.ts) (+1179).

---

## Attack Surface Analysis & Findings

### 1. PERSIST BEFORE ACK
* **Ordering Verification:** Verified in [`src/listener/runtime.ts:1046-1065`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L1046-L1065). Effect persistence (`options.store.write` or `observeFallbackNote` or `engine.process`) and terminal record reread occur strictly **before** `deliveryJournal.prepareAck`. Subsequently, `prepareAck` persists the `ack_pending` journal record **before** issuing `deliveryClient.ackAgentDelivery`. Inside `sendPreparedAck` ([`runtime.ts:578-583`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L578-L583)), `verifyPreparedAckEffect` performs a secondary read and assertion against `options.store` before making the network request.
* **Paths & Exceptions:** On error, early return, or cancellation before terminal effect persistence or journal `prepareAck`, execution terminates without calling `ackAgentDelivery`. If the lease budget expires prior to completing processing ([`runtime.ts:984`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L984)), the runtime skips the ACK, sleeps through the safety margin, and clears the active lease journal record.

### 2. CRASH RECOVERY
* **Idempotent ACK:** On restart following a crash between persist and ACK, the journal active state is `ack_pending`. `sendPreparedAck` ([`runtime.ts:588`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L588)) re-issues the ACK request using the deterministic `commandId` stored in `active.ack.commandId` alongside the recorded `leaseId` and `outcome`. The server matches these fields (`durable-delivery.ts:470-489`) and returns HTTP 200 `idempotent`.
* **Stale 403 Clearing:** Verified at [`src/listener/runtime.ts:608-614`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L608-L614). All three preflight conditions are strictly enforced for clearing a 403 `delivery_unavailable`:
  1. `startupAckPending && active.ack.commandId === startupAckCommandId` (process started in `ack_pending` with that exact command ID).
  2. `now() > Date.parse(active.leasedUntil)` (local time is beyond stored lease deadline).
  3. `error instanceof DeliveryHttpError && error.status === 403 && error.code === "delivery_unavailable"`.
  Any newly prepared ACK during a live run has a different `commandId`, preventing false-positive clearing of stale 403 errors on active leases.

### 3. FROZEN FILES & RUNTIME A2 INVARIANTS
* **Frozen Files Check:** `git diff b7a0866..f30974a --stat -- src/listener/engine.ts src/cloud/command-client.ts src/cloud/delivery.ts src/listener/delivery-journal.ts` is **completely empty**.
* **A2 Invariants:**
  - *Typed-HTTP precedence:* Enforced in [`runtime.ts:185`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L185) via `isCredentialLoss` which checks HTTP status 401/403 before string error inspection.
  - *Classifier-throw restoration:* Injected via `isCredentialFailure: isCredentialLoss` at [`runtime.ts:517`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L517).
  - *Explicit caller-abort precedence:* Checked at the top of error catch blocks ([`runtime.ts:679`, `848`, `1031`, `1100`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L679)) prior to credential/generic error handling.
  - *Name-only AbortError:* `isAbort` in [`runtime.ts:174`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L174) checks `error.name === "AbortError"`.
  - *Exact caller-signal forwarding:* Signal passed directly into `ListenerEngine` ([`runtime.ts:516`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L516)) and `poster` ([`runtime.ts:494`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L494)).

### 4. SUPERVISOR REDUCER
* **Startup Identity:** The `prepare` hook under `starting.lock` in [`src/listener/supervisor.ts:128-141`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/supervisor.ts#L128-L141) is untouched and preserved.
* **Event Handling:** The reducer handles `delivery_mode`, `delivery_claim`, `delivery_terminal_failures`, and `delivery_ack` without falling through to `malformed_row`.

### 5. LEASE AND BUDGET
* **Lease Limits:** Server lease limit `LISTENER_DELIVERY_MAX_LEASE_MS` (900,000 ms) is asserted at [`runtime.ts:914`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L914).
* **Phase Budgets:** `effectPhaseBudget` ([`runtime.ts:286-294`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L286-L294)) requires 210s minimum for prompt start, 90s for reply-only, and 60s for ACK-only. If remaining lease duration is beneath the required threshold ([`runtime.ts:984`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L984)), execution refrains from calling the model/poster, waits out the lease horizon, and clears active state.
* **Retry Jitter:** Exponential backoff with full jitter capped at 30,000 ms is applied to claims and ACKs ([`runtime.ts:210-225`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L210-L225)).

### 6. LEAKS
* **Timers & Listeners:** `defaultSleep` ([`runtime.ts:321-333`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L321-L333)) cleans up both `setTimeout` timers and `AbortSignal` event listeners upon completion or cancellation. The main runtime `finally` block ([`runtime.ts:1147-1156`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts#L1147-L1156)) guarantees `options.model.cancel()`, `options.model.close()`, and `removeEventListener` execution.
* **Control Server:** `supervisor.ts` closes the control server in a `finally` block ([`supervisor.ts:300`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/supervisor.ts#L300)).

### 7. SCOPE CREEP
* The delta is strictly constrained to the three spec-owned files: [`src/listener/runtime.ts`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/runtime.ts), [`src/listener/supervisor.ts`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/supervisor.ts), and [`tests/listener-runtime.test.ts`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/tests/listener-runtime.test.ts).

---

## Prioritized Findings

### CRITICAL
*None.*

### MAJOR
*None.*

### MINOR
1. [`src/listener/supervisor.ts:245`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/supervisor.ts#L245)
   * **Triggering Sequence:** An event reaches the end of the `onEvent` reducer function.
   * **Production Consequence:** Currently, `delivery_ack` is the only event type reaching this point. However, because it relies on fallthrough rather than an explicit `if (event.type === "delivery_ack")` check, any newly added event type in `ListenerRuntimeEvent` without an explicit handler would fall through to the ACK logging path.
   * **Narrowest Correction:** Replace the fallthrough block at line 245 with an explicit `if (event.type === "delivery_ack") { ... }` check.

---

## Verdict

**VERDICT: PASS**

*NOT VERIFIED:* Live database execution, Supabase Edge Functions, Docker/container environments, live network calls, and Runtime D CLI integrations were not executed or verified (strictly static analysis as commanded).
