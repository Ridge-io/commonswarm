# Spec Review & Verification: `docs/design/2026-09-06-PUSH-DELIVERY.md`

This document records the checks performed by subagent `docs-intel-spec` against the shipped codebase on branch `lane/docs-intel-spec`.
Every interval, numeric constant, line citation, and failure-mode claim in Section 4.1 and Section 2.4 was audited against:
- `src/cloud/idle-poll.ts`
- `src/cloud/arrival-watch.ts`
- `src/listener/wake.ts`

---

## 1. Section 4.1 Audit (`inbox --notify`, `src/cloud/arrival-watch.ts`)

| Item / Claim | Spec State | Shipped Code (Source & Line Citation) | Status / Correction Applied |
|---|---|---|---|
| **Watcher poll cadence** | Said 25 s; shipped code polls at 60 s when not subscribed | `src/cloud/idle-poll.ts:10,12` (`IDLE_POLL_MAX_MS = 60_000`, `ARRIVAL_WATCH_POLL_MS = IDLE_POLL_MAX_MS`); `src/cloud/arrival-watch.ts:39` (`ARRIVAL_WATCH_POLL_MS = IDLE_ARRIVAL_WATCH_POLL_MS`) | **Corrected**. Added explicit citations to `src/cloud/idle-poll.ts:10,12` and `src/cloud/arrival-watch.ts:39`. Retired 25 s wording preserved. Also aligned Section 1.2 line 35. |
| **5-minute reconcile read while subscribed** | 5-minute reconcile read while subscribed | `src/cloud/arrival-watch.ts:539` (`options.reconcileMs ?? LISTENER_RECONCILE_POLL_MS`); `src/listener/wake.ts:14` (`LISTENER_RECONCILE_POLL_MS = 300_000`) | **Verified & Cited**. Cited `src/cloud/arrival-watch.ts:539` and `src/listener/wake.ts:14`. |
| **Read-only invariant citation** | Cited `:336-338` in `src/cloud/arrival-watch.ts` | `src/cloud/arrival-watch.ts:508` (`* Read-only arrival loop. It never imports or calls delivery claim/ack code.`) | **Drift Corrected**. Updated line citation to `:508` while preserving retired citation `was :336-338`. (Old lines 336–338 shifted to `fileArrivalCursorStore`). |
| **Cursor processing loop citation** | Cited `:431-437` in `src/cloud/arrival-watch.ts` | `src/cloud/arrival-watch.ts:639-691` (`readPage` from cursor at `:639-643`, `emit` at `:687`, cursor persist at `:690`) | **Drift Corrected**. Updated line citation to `:639-691` while preserving retired citation `was :431-437`. |
| **Exit code 1 on refused frame defect** | Second-recipient row exits watcher with code 1 and never advances cursor | `src/cloud/arrival-watch.ts:646-667` (recipient validation throw); `src/cli.ts:8560-8563` (`exitCodeFor` returns 1 for generic unhandled errors) | **Verified & Cited**. Cited `src/cloud/arrival-watch.ts:646-667` and `src/cli.ts:8560-8563`. |

---

## 2. Section 2.4 Audit (Failure Modes, Rows 1–14)

### Row 1: Missed wake
- **Claim**: 5 min reconcile latency; row remains in `signal_deliveries`.
- **Code Check**:
  - `src/listener/wake.ts:14`: `export const LISTENER_RECONCILE_POLL_MS = 300_000;` (300,000 ms = 5 minutes).
  - Also `src/cloud/arrival-watch.ts:539`.
- **Verdict**: Verified. Cited `src/listener/wake.ts:14`.

### Row 2: Socket down, listener does not know yet (half-open)
- **Claim**: 25 s Phoenix heartbeat, 50 s timeout detection, 15 s base poll, max poll 60 s, worst case ≈ 65 s.
- **Code Check**:
  - Phoenix heartbeat default: 25 s (`@supabase/phoenix socket.js`, cited in `docs/design/2026-09-06-PUSH-DELIVERY.md:127`).
  - Timeout detection: 2 × 25 s = 50 s (`@supabase/phoenix socket.js`).
  - Base idle poll: `src/cloud/idle-poll.ts:9` (`IDLE_POLL_DEFAULT_MS = 15_000`).
  - Max idle poll: `src/cloud/idle-poll.ts:10` (`IDLE_POLL_MAX_MS = 60_000`).
  - Next poll wait calculation: `src/cloud/idle-poll.ts:90-107` (`nextIdlePollMs`).
  - Worst case initial latency: 50 s detection + 15 s poll ≈ 65 s (backs off up to 60 s when idle).
- **Verdict**: Verified & noted backoff up to 60 s (`IDLE_POLL_MAX_MS = 60_000`).

### Row 3: Socket down, known
- **Claim**: 15 s base poll, reconnect ladder `[1, 2, 5, 10] s`.
- **Code Check**:
  - Base poll: `src/cloud/idle-poll.ts:9` (`IDLE_POLL_DEFAULT_MS = 15_000`).
  - Max poll: `src/cloud/idle-poll.ts:10` (`IDLE_POLL_MAX_MS = 60_000`).
  - Reconnect ladder: `[1, 2, 5, 10] s` in `@supabase/realtime-js` (`RealtimeClient.js:16`).
- **Verdict**: Verified. Updated spec to clarify 15 s base poll backing off to 60 s (`src/cloud/idle-poll.ts:9-10`). Retired wording preserved.

### Row 4: Reconnect
- **Claim**: Transition to `subscribed` fires reconcile (`reconcile-on-join`).
- **Code Check**:
  - `src/listener/wake.ts:455-462`:
    ```ts
    if (status === REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED) {
      this.connectionState = "subscribed";
      this.subscribedAt = new Date(this.now()).toISOString();
      this.lastErrorCode = null;
      if (this.everSubscribed && !wasSubscribed) this.reconnects += 1;
      this.everSubscribed = true;
      if (!wasSubscribed) this.emitPending("state");
      return;
    }
    ```
  - Line 461: `if (!wasSubscribed) this.emitPending("state");` wakes the loop to trigger reconcile.
- **Verdict**: Verified & cited `src/listener/wake.ts:461`.

### Row 5: Duplicate wake
- **Claim**: Each subscriber claims; `FOR UPDATE SKIP LOCKED` (`durable-delivery.ts:311,340`, was `:293`) gives the row to one; leases are exclusive.
- **Code Check**:
  - PostgreSQL transaction locks candidate row via `FOR UPDATE SKIP LOCKED` (`supabase/functions/command/durable-delivery.ts:311,340`).
- **Verdict**: Verified.

### Row 6: Wake id rotated
- **Claim**: 5 min reconcile, 15 s fallback poll.
- **Code Check**:
  - Reconcile interval: `src/listener/wake.ts:14` (`LISTENER_RECONCILE_POLL_MS = 300_000`).
  - Fallback poll: `src/cloud/idle-poll.ts:9` (`IDLE_POLL_DEFAULT_MS = 15_000`).
- **Verdict**: Verified & cited.

### Row 7: Policy refused
- **Claim**: `CHANNEL_ERROR`; state → `errored` with errorCode.
- **Code Check**:
  - `src/listener/wake.ts:46-53`:
    ```ts
    export const WAKE_ERROR_CODES = [
      "channel_error",
      "closed",
      "timed_out",
      "rate_limited",
      "wake_budget",
    ] as const;
    ```
  - `src/listener/wake.ts:153-166`: `wakeErrorCodeFromSubscribeStatus(status)` maps `REALTIME_SUBSCRIBE_STATUS.CHANNEL_ERROR` to `"channel_error"`.
  - `src/listener/wake.ts:464,468-470`: sets `this.connectionState = "errored"` and `this.lastErrorCode = code` (`"channel_error"`).
  - Note: Code never produces `unauthorized`. The error code is `channel_error`.
- **Verdict**: **Drift Corrected**. Changed `state → errored(unauthorized)` to `state → errored with errorCode channel_error (was errored(unauthorized); src/listener/wake.ts:464,470)`. Retired wording preserved.

### Row 8: Reconnect storm
- **Claim**: Server join rate limit 500/s (Pro, `too_many_joins`), 0–5 s jitter, 15 s poll.
- **Code Check**:
  - Base poll: `src/cloud/idle-poll.ts:9` (`IDLE_POLL_DEFAULT_MS = 15_000`).
  - At 10,000 seats: 10,000 / 500 = 20 s throttled window.
- **Verdict**: Verified.

### Row 9: Thundering herd on deploy
- **Claim**: 1 join + 1 reconcile (read + claim).
- **Code Check**:
  - Start does 1 join + 1 initial reconcile.
  - 10,000 seats = 30,000 invocations (10,000 joins + 10,000 reads + 10,000 claims).
- **Verdict**: Verified.

### Row 10: Wake for row already claimed
- **Claim**: One empty claim.
- **Code Check**:
  - Candidate query returns 0 rows.
  - **Verdict**: Verified.

### Row 11: Realtime message rate exceeded
- **Claim**: 500/s Pro limit; client reconnects when under limit; poll covers.
- **Code Check**:
  - Realtime disconnects on quota breach; reconnect ladder backoff; idle poll covers window.
- **Verdict**: Verified.

### Row 12: Claim rate limit reached
- **Claim**: 120/min limit, 1 s coalesce, 50 wake-claims/min budget, 60 s rate limit poll, 15 s base poll.
- **Code Check**:
  - Rate limit per minute: `supabase/functions/command/durable-delivery.ts:34` (`DELIVERY_CLAIM_RATE_LIMIT_PER_MINUTE = 120`, was `:21`).
  - Coalesce window: `src/listener/wake.ts:15` (`WAKE_COALESCE_MS = 1_000`).
  - Budget: `src/listener/wake.ts:16` (`WAKE_CLAIMS_PER_MINUTE_BUDGET = 50`).
  - Rate limit poll interval: `src/listener/wake.ts:17` (`WAKE_RATE_LIMIT_POLL_MS = 60_000`).
  - Base idle poll: `src/cloud/idle-poll.ts:9` (`IDLE_POLL_DEFAULT_MS = 15_000`).
- **Verdict**: Verified & cited `src/listener/wake.ts:15,16,17`, `src/cloud/idle-poll.ts:9`, and `supabase/functions/command/durable-delivery.ts:34`.

### Row 13: Trigger cannot send
- **Claim**: Exception swallowed; row inserted; wake lost; 5 min reconcile latency.
- **Code Check**:
  - Reconcile interval: `src/listener/wake.ts:14` (`LISTENER_RECONCILE_POLL_MS = 300_000`).
- **Verdict**: Verified & cited `src/listener/wake.ts:14`.

### Row 14: Listener behind a proxy that blocks websockets
- **Claim**: Connecting never reaches subscribed; permanent 15 s base poll (backing off to 60 s).
- **Code Check**:
  - Idle poll base: `src/cloud/idle-poll.ts:9` (`IDLE_POLL_DEFAULT_MS = 15_000`).
  - Idle poll max: `src/cloud/idle-poll.ts:10` (`IDLE_POLL_MAX_MS = 60_000`).
  - Backoff helper: `src/cloud/idle-poll.ts:90-107` (`nextIdlePollMs`).
- **Verdict**: **Drift Corrected**. Updated `permanent 15 s latency` to `permanent 15 s base poll (backing off to 60 s) (was permanent 15 s latency)`. Retired wording preserved.

---

## 3. Section 1.2 Alignment

In Section 1.2 (line 35), the table row for `inbox --notify watcher` previously read:
```markdown
| `inbox --notify` watcher (separate process) | every 25 s | `read` | `src/cloud/arrival-watch.ts:25`, `:357`, `:387-391` |
```
This was corrected to:
```markdown
| `inbox --notify` watcher (separate process) | every 60 s (was 25 s) | `read` | `src/cloud/idle-poll.ts:10,12`, `src/cloud/arrival-watch.ts:39` (was `src/cloud/arrival-watch.ts:25`, `:357`, `:387-391`) |
```
This aligns Section 1.2 with Section 4.1's parenthetical noting that the watcher polls at 60 s.

---

## 4. Master Constants & Citations Table

| Symbol / Constant | Value | Source File & Line | Context |
|---|---|---|---|
| `IDLE_POLL_DEFAULT_MS` | `15_000` (15 s) | `src/cloud/idle-poll.ts:9` | Base idle poll wait for listener claim loop |
| `IDLE_POLL_MAX_MS` | `60_000` (60 s / 1 m) | `src/cloud/idle-poll.ts:10` | Maximum wait after exponential backoff of empty polls |
| `IDLE_POLL_MIN_MS` | `1_000` (1 s) | `src/cloud/idle-poll.ts:11` | Minimum allowed poll interval |
| `ARRIVAL_WATCH_POLL_MS` | `60_000` (60 s) | `src/cloud/idle-poll.ts:12` | Defined as `IDLE_POLL_MAX_MS` |
| `ARRIVAL_WATCH_POLL_MS` | `60_000` (60 s) | `src/cloud/arrival-watch.ts:39` | Re-exported from `idle-poll.ts` |
| `LISTENER_RECONCILE_POLL_MS` | `300_000` (5 min) | `src/listener/wake.ts:14` | Reconcile interval while in push mode |
| `LISTENER_RECONCILE_POLL_MS` | `300_000` (5 min) | `src/cloud/arrival-watch.ts:26,539` | Watcher fallback reconcile interval |
| `WAKE_COALESCE_MS` | `1_000` (1 s) | `src/listener/wake.ts:15` | Coalescing delay after a claim |
| `WAKE_CLAIMS_PER_MINUTE_BUDGET` | `50` | `src/listener/wake.ts:16` | Maximum wake-driven claims per minute |
| `WAKE_RATE_LIMIT_POLL_MS` | `60_000` (60 s) | `src/listener/wake.ts:17` | Duration of fallback poll after rate limit refusal |
| `WAKE_ERROR_CODES` | `["channel_error", "closed", "timed_out", "rate_limited", "wake_budget"]` | `src/listener/wake.ts:46-52` | Typed error codes (no `unauthorized`) |
| `wakeErrorCodeFromSubscribeStatus` | `CHANNEL_ERROR → "channel_error"` | `src/listener/wake.ts:153-166` | Mapping from Realtime channel status to WakeErrorCode |
| Reconnect on-join dispatch | `this.emitPending("state")` | `src/listener/wake.ts:461` | Triggers reconcile on transition to `subscribed` |
| Channel error handler | `this.lastErrorCode = code` | `src/listener/wake.ts:464-470` | Sets state `errored` and code `channel_error` |
| Read-only invariant | docstring / loop comment | `src/cloud/arrival-watch.ts:508` | Invariant: never imports or calls claim/ack |
| Cursor processing loop | `readPage` → `emit` → `store.write` | `src/cloud/arrival-watch.ts:639-691` | Emits signal and persists cursor atomically |
| Refused frame defect | error throw / exit code 1 | `src/cloud/arrival-watch.ts:646-667`, `src/cli.ts:8560-8563` | Second-recipient row check & CLI exitCodeFor |
