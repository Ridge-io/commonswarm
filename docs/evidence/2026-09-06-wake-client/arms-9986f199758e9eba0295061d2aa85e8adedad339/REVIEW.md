# Lane wake-client freeze — `9986f199758e9eba0295061d2aa85e8adedad339`

Round 2. Branch `lane/wake-client`. Merge-base with `origin/main`: `012807d2588bba8683ffef4b599d076c047039a7` (L6 ledger after L8). Diff: `arms-9986f199758e9eba0295061d2aa85e8adedad339/DIFF.patch`.

First `diff --git` line: `diff --git a/package.json b/package.json`

Round 1 SHA `6c4e219` is retired. This SHA is that work plus the folds below, rebased onto current `origin/main`.

## Claims (three sentences)

1. The listener learns its wake topic from the optional `{ topic, event }` object on read, claim, and renewal; it subscribes with the anon key; a `wake` event latches so two wakes during one claim become one claim then one more; past 50 wake-claims in a clock minute it degrades to poll (`mode: poll`, `rateLimited: true`), does not claim on wake, and the reconcile covers the rest.
2. While Realtime is `SUBSCRIBED` and the budget is not exhausted, `cswarm listen status --json` reports `mode: "push"` and reconciles every 5 minutes; `CHANNEL_ERROR` / `CLOSED` / budget / server 429 report `mode: "poll"` and use lane A's idle-poll cadence; `push` is never printed unless subscribed right now and not rate-limited; a rotated wake id closes the old channel, the next read carries the new topic, and the seat returns to push.
3. The topic never appears in `status.json` or `events.ndjson`; `STATUS_SENSITIVE_KEYS` and `parseListenerWake` refuse `topic` / `wakeTopic` / `wake_topic`; skipRead is gated on `LISTENER_WAKE_MODE_PUSH`; user-facing push/poll copy is built from `LISTENER_WAKE_MODES`.

## Round 2 folds (on top of 6c4e219)

| id | fold |
|---|---|
| Opus DEFECT | Budget degrades to poll. `next()` keeps the latch and does not resolve on wake while over budget. Snapshot `mode: poll`, `rateLimited: true`. Test: 70 wakes in one frozen minute → ≤51 claims, 1 read. Mutation: consume pending wake while paused → 70 claims. |
| N1 | §2.4 rotation: CLOSED → poll → next read's new topic → push; `topicRotatedAt` set. Mutation: skip the `topicRotatedAt` write → unit test actual `null`. |
| N2 | `detachChannel` only clears subscribed state when no replacement channel is attached. Mutation: drop that guard → state `disconnected` after late unsubscribe. |
| N3 | skipRead only when `snapshot().mode === LISTENER_WAKE_MODE_PUSH`, not `hasTopic`. |
| N4 | Lapse scoring skips at most one consecutive mode-change hour (`LISTENER_MODE_CHANGE_SKIP_MAX = 1`). |
| N5 | `listenerWakePersistWorthy`: lastWakeAt-only ticks inside `WAKE_COALESCE_MS` stay in memory. |
| N6 | `next({ until })` while subscribed is `now + LISTENER_RECONCILE_POLL_MS`; deadline tick is a read plus a claim. |
| Gemini 5 | `parseListenerWake` and `listenerWakeStatusSentence` derive push/poll from `LISTENER_WAKE_MODES`. |
| Gemini 6 | `parseOptionalWakeHint` accepts unknown keys and drops them. |
| Gemini 3, 9 | Lead refuted. `control.ts` still rejects a topic-shaped `lastErrorDetail`. Claim branch stays inside `durable_claim`. Not changed. |

## Files

- `src/cloud/wake.ts` — wire hint parser
- `src/cloud/signals.ts`, `src/cloud/delivery.ts`, `src/cloud/renewal.ts` — optional `wake`
- `src/listener/wake.ts` — `WakeSubscriber`, budget pause, persist-worthy, mode constants
- `src/listener/runtime.ts` — wait contract, skipRead on push only
- `src/listener/control.ts` — `wake` status block, `parseListenerWake` from `LISTENER_WAKE_MODES`
- `src/listener/read-health.ts` — per-hour `expectedClaims`, capped mode-change skip
- `src/listener/supervisor.ts` — persist throttle
- `src/cli.ts` — render
- `tests/listener-wake.test.ts` (named in `package.json` `test`)
- `tests/listener-control.test.ts` — `topic` sensitive aliases

## Gates (this SHA)

| command | exit |
|---|---|
| `npm run build` | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 |
| `npm test` | 0 (885 pass / 0 fail) |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (483 pass / 0 fail) |
| `npm run check:tests` | 0 |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 (26 address-fields) |

## Mutation rows

| mutation | result |
|---|---|
| `lastErrorDetail` = `Unauthorized: cswarm-wake:` + 43 chars | `readListenerStatus` rejects `/malformed/` |
| status top-level `topic` | write rejected `/forbidden/` |
| `parseListenerWake({ ...good, topic })` | `null` |
| `next()` consumes a pending wake while `wakeClaimPaused` | 70 wakes in one frozen minute → `claims in one frozen minute: 70` |
| skip `topicRotatedAt` assignment in `setTopic` | rotation unit test actual `null` |
| drop `if (this.channel !== null) return` in `detachChannel` | race test actual `disconnected` |

## Live status JSON

Not re-run this round. Round 1 live control (fake HTTP edge, Realtime proxied to local `127.0.0.1:54321`, `wake_id` READ from local Postgres, `cswarm-wake:` count 0):

Push:

```json
{
  "state": "ready",
  "mode": "push",
  "wake": {
    "mode": "push",
    "subscribedAt": "2026-09-06T05:38:00.512Z",
    "reconnects": 0,
    "lastWakeAt": "2026-09-06T05:38:00.918Z",
    "lastReconcileAt": "2026-09-06T05:38:00.926Z",
    "errorCode": null,
    "topicRotatedAt": null,
    "rateLimited": false
  },
  "lastClaimAt": "2026-09-06T05:38:00.926Z",
  "pendingDeliveryCount": 0,
  "deliveryMode": "durable_claim"
}
```

Poll (after the fake edge handed a topic that Realtime closed):

```json
{
  "state": "ready",
  "mode": "poll",
  "wake": {
    "mode": "poll",
    "subscribedAt": null,
    "reconnects": 0,
    "lastWakeAt": "2026-09-06T05:38:01.023Z",
    "lastReconcileAt": "2026-09-06T05:38:00.926Z",
    "errorCode": "closed",
    "topicRotatedAt": "2026-09-06T05:38:01.947Z",
    "rateLimited": false
  },
  "lastClaimAt": "2026-09-06T05:38:01.947Z",
  "deliveryMode": "durable_claim"
}
```

## NOT established

- Live `listen start` against local edge functions (503 in round 1; not re-run in round 2).
- A note posted through the live local edge.
- Production / `--linked`. `db:reset` was not run.
- L5 watcher / L6 site / W4 trigger actually broadcasting.
- A `VERDICT` from this round's Gemini arm (launched after freeze; file may be empty until `agy` exits).
- Phoenix heartbeat timing (~50 s half-open).
