# lane/wake-client-fix — listener never wakes (cswarm 0.1.58)

Branch `lane/wake-client-fix`, commit `f5c7c31`, worktree
`$SP/lane-wake-client-fix`. Base `origin/main` = `6ea3863`.

## Cause

`src/listener/wake.ts:424-433` (`WakeSubscriber.finishWait`) sets `this.waiter = null`
and then calls `waiter.resolve(reason)`. `waiter.resolve` is the `finish` closure built
inside `next()` at `src/listener/wake.ts:363-372`, whose first statement is
`if (this.waiter === null) return;`. `finishWait` has already nulled that field, so
`finish` returns before it calls the promise's `resolve`.

Two teardowns, each guarding on the same field. Every settle that goes through
`finishWait` — a wake (`emitPending` -> `finishWait`, `:412-420`), a subscribe-state
change, `markRateLimited`, and `close()` — clears the deadline timer, removes the abort
listener, and never resolves the promise. `next()` then never settles again, and the
runtime loop (`src/listener/runtime.ts:1162`) is parked on that `await` for the life of
the process.

The deadline path was the only one that worked, because `setTimeout` calls `finish`
directly while `this.waiter` is still set. That is why some seats reconciled at 5 minutes
and others did not: a seat that got a wake first had its timer cleared by the failed
`finishWait` and wedged permanently; a seat with no wake still reached its deadline.

This explains every measured symptom in one mechanism:
- wakes never produce a `listener_wake` / `listener_delivery_claim` event;
- `status.json` keeps `mode: push`, `subscribedAt` set, `reconnects 0`, `errorCode null`,
  `lastWakeAt null` — the socket is genuinely healthy, only the loop is dead;
- the 5-minute reconcile never fires after the first wake;
- the sibling seat 2121f81d, which had not yet taken a wake, did reconcile.

## Fix

`finishWait` is now the single teardown; the waiter holds the raw promise `resolve`, and
the `setTimeout` and abort listener call `finishWait` as well. One path, one guard.

```
-      const finish = (reason: WakeWaitReason) => {
-        if (this.waiter === null) return;
-        ... resolve(reason);
-      };
-      const timer = setTimeout(() => finish("deadline"), delay);
-      const onAbort = () => finish("deadline");
-      this.waiter = { resolve: finish, timer, onAbort, signal: options.signal };
+      const timer = setTimeout(() => this.finishWait("deadline"), delay);
+      const onAbort = () => this.finishWait("deadline");
+      this.waiter = { resolve, timer, onAbort, signal: options.signal };
```

No behaviour outside `next()` changed. `defaultRealtime`, `setTopic`, `detachChannel` and
the `until` arithmetic were all cleared as suspects by the live run below: the socket
subscribes, `setTopic` correctly no-ops on the repeated identical topic, and the real
broadcast is received and dispatched.

## Test

`tests/listener-wake.test.ts`: *"next() settles on a wake and on a state change that
arrive while it waits"*. It drains the latched join transition first — that is the whole
point — then installs a real waiter and races each settle against a 1 s timer.

Why no existing test caught this: every neighbouring test emits the wake or the status
change **before** calling `next()`, so `next()` returns the latched `pending` value
synchronously and never installs a waiter. `"CHANNEL_ERROR flips snapshot to poll"`
asserts `"state"` and passes on the broken code for that reason — a green control pinned
to the right value through the wrong path.

Mutation control, same invocation:
- old `src/listener/wake.ts`: `✖ ... AssertionError: 'hung' !== 'wake'` (1005 ms), fail 1.
- fixed: `✔ ... (1.5 ms)`, pass 1.

## Gates (in the worktree, `f5c7c31`)

| gate | result |
|---|---|
| `npm run build` | ok, `dist/cli.js` written |
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npm run check:tests` | clean |
| `npm test` | 886 pass, 0 fail |
| `env -u FORCE_COLOR npm run test:p1-cli` | 483 pass, 0 fail |
| `scripts/check-commit-identity.sh origin/main..HEAD` | `commit identity OK: 2 address-fields checked` |

## Live evidence — production, seat 8d10fe67 only

Instrumented build (stderr only, never committed; `src/listener/wake.ts` restored from
`origin/main` before the fix was written).

### BEFORE — 0.1.58 code, state dir `$SP/wakedbg-state`

Wake is received by the client and dispatched, and the loop dies on it:

```
[wakedbg] 07:00:35.676Z subscribe status SUBSCRIBED
[wakedbg] 07:00:50.082Z next() waiting delay=298583 until=1788678348665 state=subscribed
[wakedbg] 07:01:17.698Z BROADCAST {"type":"broadcast","event":"wake","payload":{"v":1,
          "id":"70844573-...","signal_id":"f9ed05ff-...","enqueued_at":"...07:01:17.545722+00:00"}
[wakedbg] 07:01:17.699Z emitPending wake waiter=true
```

`events.ndjson` last line `07:00:50.081Z listener_delivery_ack`. No `listener_wake` for
the 07:01:17 note. The reconcile due `07:05:48Z` had still not fired at `07:06:44Z`
(5.5 min late, and it never will — its timer was cleared). `status.json`:

```json
{"state":"ready","updatedAt":"2026-09-06T07:00:50.081Z",
 "wake":{"mode":"push","subscribedAt":"2026-09-06T07:00:35.676Z","reconnects":0,
         "lastWakeAt":null,"lastReconcileAt":"2026-09-06T07:00:48.665Z",
         "errorCode":null,"topicRotatedAt":null,"rateLimited":false}}
```

A bare supabase-js client (`scratchpad/rx-test.mjs`) on the **same topic at the same
time** printed `WAKE received ["v","id","signal_id","enqueued_at"]`. Delivery was never
the problem, and neither was the bundled client's socket.

### AFTER — fixed build, state dir `$SP/wakefix-state`

Note posted `07:09:04`:

```
{"ts":"2026-09-06T07:09:05.688Z","event":"listener_wake","wake_mode":"push","wake_error_code":null,"wake_reconnects":0,"rate_limited":false}
{"ts":"2026-09-06T07:09:06.904Z","event":"listener_delivery_claim","signal_id":"3315fbd5-709e-4f6a-8686-1b482fc69ac4","pending_delivery_count":1,...}
{"ts":"2026-09-06T07:09:08.169Z","event":"listener_delivery_ack","signal_id":"3315fbd5-...","outcome":"observed"}
```

Note -> wake 1.4 s, note -> claim 2.6 s (of which 1 s is `WAKE_COALESCE_MS`), ack 4 s.
Four consecutive wake -> claim pairs in the run (07:07:11, 07:07:38, 07:08:09, 07:09:05),
so the loop does not wedge after the first one.

Reconcile at 5 minutes, `status.json` at `07:13:01Z`:

```json
{"state":"ready",
 "wake":{"mode":"push","subscribedAt":"2026-09-06T07:07:00.881Z","reconnects":0,
         "lastWakeAt":"2026-09-06T07:09:05.688Z","lastReconcileAt":"2026-09-06T07:12:40.287Z",
         "errorCode":null,"topicRotatedAt":null,"rateLimited":false}}
```

`07:12:40.287` is 5 min 1.5 s after the previous read-reconcile at `07:07:38.798`. The
intervening wake ticks did not move the reconcile clock, as §2.3 requires.

## Not established

- **Fact 3's `channel_error` on seat 2121f81d is NOT explained by this fix.** That seat
  flipped to `mode: poll, errorCode: channel_error, subscribedAt: null` right after its
  reconcile. My run never produced a `CHANNEL_ERROR`, so I could not reproduce it and did
  not diagnose it. `setTopic` was measured to no-op on an unchanged topic (three
  `same=true` lines, no re-join), so a repeated `setTopic` is not the trigger; a genuine
  rotation, or the server, remains open. Worth a separate lane.
- Not measured: topic rotation against the real server, socket drop / reconnect against
  the real server, the rate-limit and wake-budget paths, and behaviour with two listeners
  on one credential.
- Only `npm test` and `test:p1-cli` were run. `test:p1-local` and `test:p1-server` were
  not (another lane owns the local stack).
- Not released. The fix is on the branch only; no npm publish, no deploy, no version bump.
- Test seat cleanup: both test listeners stopped, no `__listen-supervisor.*8d10fe67`
  process left.
