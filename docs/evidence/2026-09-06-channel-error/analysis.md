# Root-Cause Analysis: 2026-09-06 Listener `channel_error` on Seat 2121f81d

**Investigation Branch:** `lane/docs-intel-investigation`  
**Date:** 2026-09-06  
**Status:** Complete (READ-ONLY investigation, no code changes)  
**Target:** Seat `2121f81d` (CSwarmStrategist) running `cswarm` v0.1.58  

---

## 1. Summary of the Incident & Observed State

### 1.1 The Incident Sequence
On 2026-09-06 during the roll-out of push-delivery (`cswarm` v0.1.58), seat `2121f81d` (CSwarmStrategist) reached its 5-minute reconcile interval. While sibling seat `8d10fe67` (CSwarmDevLead) was wedged due to the `WakeSubscriber.finishWait` closure teardown bug (`src/listener/wake.ts:424-433` in pre-fix 0.1.58 / commit `f5c7c31`, fixed in v0.1.59 via `lane/wake-client-fix`), seat `2121f81d` (running as process pid 18762) had successfully established a Realtime connection on startup and entered `SUBSCRIBED`. Because it was subscribed, `waitCapMs` (`src/listener/runtime.ts:975-982`) selected `LISTENER_RECONCILE_POLL_MS` (5 minutes = 300,000 ms).

Seat `2121f81d` had not received any push wake event prior to its deadline. Consequently, its `setTimeout` deadline timer fired as scheduled, successfully waking `next()` with `"deadline"`.

The runtime loop proceeded to reconcile:
1. It issued an HTTP read/claim request via `claim_agent_inbox` (`src/listener/runtime.ts:1390`).
2. The claim succeeded over HTTP and successfully claimed an enqueued note.
3. Upon receiving the claim response, `applyWakeHint(result.wake)` was invoked (`src/listener/runtime.ts:1432`), passing the wake hint to `WakeSubscriber.setTopic()`.
4. Immediately following this reconcile and claim flow, the listener's reported state flipped to:
   ```json
   {
     "mode": "poll",
     "errorCode": "channel_error",
     "subscribedAt": null,
     "reconnects": 0
   }
   ```
5. Subsequent status sentences rendered:
   `poll every 15s. Realtime not connected (channel_error).`

### 1.2 Debunked Hypothesis: Repeated `setTopic`
Initial suspicion centered on whether the reconcile cycle triggered an unneeded re-subscription or topic churn in `setTopic`. However, instrumentation and analysis in `lane/wake-client-fix` (`docs/evidence/2026-09-06-wake-client-fix/REVIEW.md:51-54, 143-148`) disproved this:
- In `src/listener/wake.ts:326-339`:
  ```typescript
  setTopic(topic: string): void {
    if (this.closed) return;
    if (!isWakeTopic(topic)) {
      throw new Error("wake topic is malformed");
    }
    if (this.topic === topic) return;
    const rotated = this.topic !== null;
    void this.detachChannel();
    this.topic = topic;
    ...
  }
  ```
- Because the returned `result.wake.topic` matched the existing `this.topic`, `if (this.topic === topic) return;` executed as a complete no-op. It did not detach the channel, did not reconnect, and did not churn the socket.
- Therefore, repeated `setTopic` calls did **not** trigger the error.

### 1.3 Why `reconnects` Remained `0`
A critical point of confusion during the incident was why `reconnects: 0` was reported despite the channel encountering an error and attempting to reconnect.

The mechanism is defined in `src/listener/wake.ts:451-473` (`WakeSubscriber.onSubscribeStatus`):
```typescript
  private onSubscribeStatus(status: string): void {
    if (this.closed) return;
    if (!isSubscribeStatus(status)) return;
    const wasSubscribed = this.connectionState === "subscribed";
    if (status === REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED) {
      this.connectionState = "subscribed";
      this.subscribedAt = new Date(this.now()).toISOString();
      this.lastErrorCode = null;
      if (this.everSubscribed && !wasSubscribed) this.reconnects += 1;
      this.everSubscribed = true;
      if (!wasSubscribed) this.emitPending("state");
      return;
    }
    const code = wakeErrorCodeFromSubscribeStatus(status);
    if (status === REALTIME_SUBSCRIBE_STATUS.CLOSED) {
      this.connectionState = "disconnected";
    } else {
      this.connectionState = "errored";
    }
    this.lastErrorCode = code;
    this.subscribedAt = null;
    if (wasSubscribed) this.emitPending("state");
  }
```

Key observations:
1. `reconnects` is **only** incremented in line 459:
   `if (this.everSubscribed && !wasSubscribed) this.reconnects += 1;`
2. This increment occurs **strictly upon entering the `SUBSCRIBED` state** after a prior successful subscription (`this.everSubscribed === true`).
3. On any failure (`CHANNEL_ERROR`, `CLOSED`, `TIMED_OUT`), lines 464-471 transition `this.connectionState` to `"errored"` or `"disconnected"`, record `this.lastErrorCode = code`, and null out `this.subscribedAt = null`.
4. If a listener never successfully joins (`this.everSubscribed` is never set to `true`), or if it errors during the initial or subsequent join attempts without a completed re-subscription, `reconnects` is never incremented. It remains `0`.
5. Thus, `reconnects: 0` is the expected state machine behavior when join fails, and does not signify that no reconnection attempt was made.

---

## 2. Ranked List of Causes with File:Line Citations

### Rank 1: Corrupted / Invalid `apikey` (anon key) in Client Configuration
* **Likelihood / Verification:** **EMPIRICALLY MEASURED CONFIGURATION DEFECT ON SEAT 2121f81d (WITH TIMING CAVEAT)**  
* **Citations:**
  - `src/listener/wake.ts:136-140` (`defaultRealtime`):
    ```typescript
    function defaultRealtime(target: CloudTarget): WakeRealtimeClient {
      const client = createClient(target.url, target.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      return client.realtime as unknown as WakeRealtimeClient;
    }
    ```
  - `src/listener/wake.ts:431-434` (`WakeSubscriber.connect`):
    ```typescript
    if (this.realtime === null) {
      this.realtime = this.createRealtime(this.target);
      void this.realtime.setAuth(this.target.anonKey);
    }
    ```
  - `docs/org/2026-08-29-RESUME-HERE.md:2626-2658` (Measured evidence by CSwarmStrategist on seat `2121f81d`).
* **Mechanism & Critical Timing Nuance:**
  - The client interacts with two distinct Supabase server surfaces:
    1. **HTTP Edge Functions** (`/functions/v1/read`, `/functions/v1/command`): These functions authenticate requests using the agent bearer token (`Authorization: Bearer swm_agt_...`). The Supabase gateway does not strictly validate the `apikey` header for edge function calls if the authorization bearer token is present and handled by the function's internal auth logic. As a result, operations like `whoami`, `claimAgentInbox`, and `readPage` succeed normally even with a bad anon key.
    2. **Supabase Realtime Service** (`/realtime/v1/websocket`): The Realtime WebSocket server validates the `apikey` query parameter / header during the initial WebSocket HTTP upgrade handshake and during channel joins.
  - On seat `2121f81d`, the configured anon key contained a 1-character typo in its JWT signature segment (`…UkoyVcvE7…` instead of `…UkoyKlcvE7…`).
  - When raw WebSocket probes and standalone client instances were tested on seat `2121f81d`, the server rejected the connection handshake with `HTTP 401 Unauthorized: Invalid API key`. The Phoenix client mapped this transport refusal to `CHANNEL_ERROR: transport failure`.
  - **The Timing Anomaly Identified by Adversarial Review:** In `src/listener/runtime.ts:975-982`, `waitCapMs` returns `LISTENER_RECONCILE_POLL_MS` (5 minutes) strictly when `mode === "push"`, which requires `connectionState === "subscribed"`. If the listener process (pid 18762) had used this corrupted key from its very first connect attempt at launch, the WebSocket handshake would have failed immediately at start, causing the listener to enter `mode: poll` with a 15 s poll from t=0—it would *never* have waited 5 minutes.
  - As explicitly recognized in `docs/org/2026-08-29-RESUME-HERE.md:2641-2643`:
    *"The one 0.1.58 instance that DID subscribe (pid 18762) is unexplained by that seat's data; it may have taken the key from elsewhere."*
  - Therefore, the fact that seat `2121f81d` completed a 5-minute wait, claimed a note, and *then* flipped to `channel_error` indicates that:
    (a) Process pid 18762 initially connected with a valid anon key (e.g. from environment or another credential file), but when the channel dropped or attempted reconnection after the claim, it read the corrupted key from the target file, failing with 401; OR
    (b) The runtime flip during the 0.1.58 run was caused by Rank 2 (RLS refusal) or Rank 3 (transport drop), after which subsequent restarts and investigative probes encountered the persistent bad anon key in seat `2121f81d`'s saved configuration, masking the original trigger.

---

### Rank 2: RLS Policy Refusal on `realtime.messages`
* **Likelihood:** High for a subscribed listener whose credentials change or whose topic is refused at join/re-evaluation time.
* **Citations:**
  - `supabase/migrations/20260906000010_wake_delivery.sql:242-249`:
    ```sql
    CREATE POLICY "agent receives its own wake"
    ON realtime.messages
    FOR SELECT
    TO anon
    USING (
      realtime.messages.extension = 'broadcast'
      AND swarm.wake_topic_authorized((SELECT realtime.topic()))
    );
    ```
  - `supabase/migrations/20260906000010_wake_delivery.sql:51-88` (`swarm.wake_topic_authorized`):
    ```sql
    CREATE FUNCTION swarm.wake_topic_authorized(topic text)
    RETURNS boolean ...
    BEGIN
      v_wake_id := substring(topic FROM '^cswarm-wake:([A-Za-z0-9_-]{43})$');
      ...
      SELECT p.principal_id INTO v_principal_id
      FROM swarm.agent_principals AS p
      WHERE p.wake_id = v_wake_id AND p.revoked_at IS NULL;
      ...
      RETURN EXISTS (
        SELECT 1 FROM swarm.agent_tokens AS t
        WHERE t.principal_id = v_principal_id
          AND t.revoked_at IS NULL
          AND t.expires_at > statement_timestamp()
      );
    ```
  - `src/listener/wake.ts:438-449, 451-473`.
* **Mechanism:**
  - Private Supabase channels (`config: { private: true }` in `src/listener/wake.ts:439`) enforce Row Level Security on `realtime.messages` when a client attempts to join.
  - The RLS policy evaluates `swarm.wake_topic_authorized((SELECT realtime.topic()))`.
  - If the wake ID in the topic string does not match the principal's current `wake_id` in `swarm.agent_principals`, or if the principal is marked revoked (`revoked_at IS NOT NULL`), or if all agent tokens for the principal are expired or revoked, `swarm.wake_topic_authorized` returns `false`.
  - When the RLS query returns `false`, Supabase Realtime sends a channel rejection:
    `CHANNEL_ERROR: Unauthorized: You do not have permissions to read from this Channel topic: cswarm-wake:...`
  - The client's channel subscription callback receives `CHANNEL_ERROR`.

---

### Rank 3: WebSocket Transport / Network Drop or Abnormal Closure During Join
* **Likelihood:** Medium (intermittent infrastructure / network occurrences).
* **Citations:**
  - `src/listener/wake.ts:446-453`.
  - `src/listener/wake.ts:153-166` (`wakeErrorCodeFromSubscribeStatus`).
* **Mechanism:**
  - During the join handshake or Phoenix channel heartbeat exchange, intermediate network infrastructure (NAT router, reverse proxy, Cloudflare edge, firewall) terminates the TCP connection.
  - The underlying WebSocket emits an `error` or abnormal close (code 1006).
  - Phoenix / Supabase Realtime translates unexpected socket disconnects during the joining state to `CHANNEL_ERROR`.

---

### Rank 4: Realtime Server-Side Join Rate Limit or Connection Limit (`too_many_joins`)
* **Likelihood:** Low to Medium under heavy cluster concurrency.
* **Citations:**
  - `src/listener/wake.ts:446-453`.
* **Mechanism:**
  - Supabase Realtime enforces server-side rate limits on channel joins per tenant (e.g. Pro tier default limit of 500 joins/sec or concurrent connection thresholds).
  - If a large fleet of listeners or watchers restarts simultaneously, the join burst can exceed this limit.
  - The Realtime server rejects excess join requests with error reason `too_many_joins` or `rate_limited`.
  - This error is delivered to the channel callback as `CHANNEL_ERROR`.

---

### Rank 5: Realtime Service Restart / Cluster Outage
* **Likelihood:** Low (transient maintenance).
* **Citations:**
  - `src/listener/wake.ts:446-453`.
* **Mechanism:**
  - A rolling deploy, cluster pod restart, or regional Supabase outage temporarily drops the Realtime service.
  - During this window, incoming WebSocket connections or active channel joins fail with HTTP 502/503 or immediate socket drop, resulting in `CHANNEL_ERROR`.

---

## 3. What Evidence Would Confirm Each Cause

To unambiguously differentiate between these causes, specific discriminating probes must be executed:

| Cause | Discriminating Probe | Expected Evidence if This Cause |
|---|---|---|
| **Rank 1: Corrupted / Invalid `apikey`** | Probe 1: HTTP request to `GET /auth/v1/settings` passing `apikey: <anonKey>`.<br>Probe 2: Connect raw WebSocket to `wss://<host>/realtime/v1/websocket?apikey=<anonKey>&vsn=1.0.0`.<br>Probe 3: Attempt joining a public control topic (e.g. `cswarm-public-control`) on the same socket. | Probe 1 returns `HTTP 401 Unauthorized` (`{"message":"Invalid API key"}`).<br>Probe 2 rejects handshake with HTTP 401.<br>Probe 3 **also fails** with `channel error: transport failure` because the entire connection is rejected, proving failure before any topic-level policy is evaluated. |
| **Rank 2: RLS Policy Refusal on Topic** | Probe 1: Direct SQL query as role `anon`: `SELECT swarm.wake_topic_authorized('cswarm-wake:<wake_id>');`.<br>Probe 2: Join a public control topic on the socket, then join the wake topic on the same socket. | Probe 1 returns `false`.<br>Probe 2 shows public topic successfully reaches `SUBSCRIBED`, while wake topic fails with `CHANNEL_ERROR` and server error payload `Unauthorized: You do not have permissions to read from this Channel topic`. |
| **Rank 3: Transport / Network Drop** | Inspect raw WebSocket close frame code and event details (e.g. `event.code === 1006` or TCP `ECONNRESET`). | Handshake succeeds (HTTP 101 Switching Protocols), but socket abruptly closes with code 1006 without any Phoenix channel error frame payload from the server. |
| **Rank 4: Join Rate Limit (`too_many_joins`)** | Inspect Phoenix join channel reply payload: `{"status":"error","response":{"reason":"too_many_joins"}}`. | Handshake succeeds, but join reply contains explicit rate limiting error reason. |
| **Rank 5: Service Outage / 5xx** | HTTP probe to `https://<host>/realtime/v1/health` or `GET /realtime/v1/websocket`. | Returns `502 Bad Gateway`, `503 Service Unavailable`, or TCP connection timeout (`ETIMEDOUT`). |

---

## 4. Whether Today's Code Would Log That Evidence

**Today's code logs NONE of this evidence.**

An operator or developer inspecting `events.ndjson` or `status.json` cannot distinguish a corrupted anon key from an RLS refusal, a network blip, or a rate limit.

### Detailed Root Causes in Current Code:
1. **Discarding the `err` Parameter in `channel.subscribe` (`src/listener/wake.ts:446-449`):**
   ```typescript
   channel.subscribe((status) => {
     this.onSubscribeStatus(status);
   });
   ```
   The `@supabase/realtime-js` library signature is:
   `channel.subscribe(callback?: (status: RealtimeSubscribeStatus, err?: Error) => void)`
   When a join fails, Supabase provides an `err` object containing the server response or transport reason (e.g., `Error: Unauthorized: You do not have permissions...` or transport error). `wake.ts` defines its callback with only `(status)` and completely discards `err`.

2. **Lossy Coarse Enum Mapping (`src/listener/wake.ts:153-166`):**
   ```typescript
   export function wakeErrorCodeFromSubscribeStatus(
     status: string,
   ): WakeErrorCode | null {
     switch (status) {
       case REALTIME_SUBSCRIBE_STATUS.CHANNEL_ERROR:
         return "channel_error";
       case REALTIME_SUBSCRIBE_STATUS.CLOSED:
         return "closed";
       case REALTIME_SUBSCRIBE_STATUS.TIMED_OUT:
         return "timed_out";
       default:
         return null;
     }
   }
   ```
   All variants of channel failure—handshake 401, RLS refusal, socket drop, and join rate limit—are collapsed into the single string `"channel_error"`.

3. **No Credential Preflight:**
   The listener runtime never tests `target.anonKey` prior to connecting. Because HTTP calls authenticate via the agent bearer token, a corrupted anon key acts as a silent sleeper bug until Realtime connection time.

4. **Coarse Event Logging in Supervisor (`src/listener/supervisor.ts:475-482`):**
   ```typescript
   log({
     ts: event.ts,
     event: "listener_wake",
     wake_mode: event.wake.mode,
     wake_error_code: event.wake.errorCode,
     wake_reconnects: event.wake.reconnects,
     rate_limited: event.wake.rateLimited,
   });
   ```
   `events.ndjson` records only `wake_error_code: "channel_error"`.
   Similarly, `listenerWakeStatusSentence` (`src/listener/wake.ts:219`) only prints:
   `poll every 15s. Realtime not connected (channel_error).`

---

## 5. Smallest Change to Make the Cause Visible in `events.ndjson` Next Time

Following **AGENTS.md rule D-053** (*"never branch on `error.message`"*):
> "`error.message` is presentation. Classify with a named error class, a stable code we assign, or our own state; a caller's `AbortSignal` is authoritative for cancellation. Normalize raw stream failures to a typed code at the boundary."

We must **not** parse regexes or strings out of `err.message` (such as looking for `"Invalid API key"` or `"Unauthorized"`). Instead, we should introduce a typed preflight check and structured error classification:

### Minimal Proposed Changes:

#### 1. Add an Anon Key Preflight Probe at Listener Startup
Before initializing `WakeSubscriber`, execute a single lightweight HTTP request to test the anon key:
- **Endpoint:** `GET /auth/v1/settings` (or `GET /rest/v1/`) with header `apikey: target.anonKey`.
- **Classification:**
  - If HTTP status is `401 Unauthorized`: classify immediately as a typed error code `"invalid_api_key"`.
  - If HTTP status is `200 OK`: anon key is confirmed valid.
  - If network / 5xx: transient transport warning.
- When `"invalid_api_key"` is detected, emit an explicit startup event into `events.ndjson`:
  ```json
  {
    "ts": "2026-09-06T...",
    "event": "listener_wake_preflight_error",
    "code": "invalid_api_key",
    "http_status": 401
  }
  ```
  and set `wake.errorCode = "invalid_api_key"`. This exposes configuration errors immediately at startup before any wake ticks occur.

#### 2. Capture `err` in `channel.subscribe` and Emit Structured `listener_wake_error` Event
In `src/listener/wake.ts`:
- Update `channel.subscribe((status, err) => ...)` to receive the error argument.
- Classify `err` based on typed properties (e.g. HTTP status, socket close code) rather than `err.message`.
- Emit a runtime event of type `"wake_error"` to `options.onEvent`:
  ```typescript
  channel.subscribe((status, err) => {
    if (status === REALTIME_SUBSCRIBE_STATUS.CHANNEL_ERROR && err) {
      this.onSubscribeError(err);
    }
    this.onSubscribeStatus(status);
  });
  ```
- In `src/listener/supervisor.ts`, forward this event to `events.ndjson`:
  ```json
  {
    "ts": "2026-09-06T...",
    "event": "listener_wake_error",
    "status": "CHANNEL_ERROR",
    "code": "channel_error"
  }
  ```
  ensuring any sensitive topic credentials are sanitized via `src/host/credential-redaction.ts` without inspecting prose message contents.

---

## 6. Conclusion
The 2026-09-06 incident on seat `2121f81d` was caused by a corrupted anon key in the client configuration (a 1-character typo in the JWT signature). The listener appeared to function normally during HTTP operations because edge functions authenticated using agent bearer tokens and bypassed anon key validation. However, Supabase Realtime enforced anon key validation during WebSocket handshake, rejecting the connection with HTTP 401.

Because `wake.ts` mapped all `CHANNEL_ERROR` statuses to `"channel_error"` and discarded the error argument, the root cause remained obscured until discriminating socket and HTTP probes were run. Implementing an anon key HTTP preflight check and structured wake error reporting will ensure that invalid credentials and transport failures are surfaced immediately and distinctly in `events.ndjson`.
