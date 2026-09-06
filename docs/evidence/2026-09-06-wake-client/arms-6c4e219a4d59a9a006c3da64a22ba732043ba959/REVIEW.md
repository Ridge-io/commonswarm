# Lane wake-client freeze — `6c4e219a4d59a9a006c3da64a22ba732043ba959`

Branch `lane/wake-client`. Merge-base with `origin/main`: `78b046991ae527830187d5c0934f1c41ced9a431`. Diff: `arms-6c4e219a4d59a9a006c3da64a22ba732043ba959/DIFF.patch`.

## Claims (three sentences)

1. The listener learns its wake topic from the optional `{ topic, event }` object on read, claim, and renewal (0.1.57 servers omit it); it subscribes with the anon key to that private topic, and a `wake` event latches so two wakes during one claim become one claim then one more.
2. While Realtime is `SUBSCRIBED`, `cswarm listen status --json` reports `mode: "push"` and reconciles every 5 minutes; `CHANNEL_ERROR` / `CLOSED` report `mode: "poll"` and use lane A's idle-poll cadence; `push` is never printed unless subscribed right now.
3. The topic never appears in `status.json` or `events.ndjson`; `STATUS_SENSITIVE_KEYS` and `parseListenerWake` refuse `topic` / `wakeTopic` / `wake_topic`, and a topic-shaped `lastErrorDetail` is rejected.

## Files

- `src/cloud/wake.ts` (new) — wire hint parser
- `src/cloud/signals.ts`, `src/cloud/delivery.ts`, `src/cloud/renewal.ts` — optional `wake`
- `src/listener/wake.ts` (new) — `WakeSubscriber`
- `src/listener/runtime.ts` — wait contract, wake tick vs reconcile
- `src/listener/control.ts` — `wake` status block, `parseListenerWake`
- `src/listener/read-health.ts` — per-hour `expectedClaims`, skip lapse on mode-change hours
- `src/listener/supervisor.ts`, `src/cli.ts` — persist and render
- `tests/listener-wake.test.ts` (new, named in `package.json` `test`)
- `tests/listener-control.test.ts` — `topic` sensitive aliases

## Gates (this SHA)

Recorded after rebase onto `origin/main` (L3).

| command | exit |
|---|---|
| `npm run build` | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 |
| `npm test` | 0 (875 pass on this SHA) |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (483 pass on this SHA) |
| `npm run check:tests` | 0 |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 |

## Mutation rows

| mutation | result |
|---|---|
| `lastErrorDetail` = `Unauthorized: cswarm-wake:` + 43 chars | `readListenerStatus` rejects `/malformed/` (`tests/listener-wake.test.ts`) |
| status top-level `topic` | write rejected `/forbidden/` |
| `parseListenerWake({ ...good, topic })` | `null` |
| `WAKE_CLAIMS_PER_MINUTE_BUDGET` note 50 wake claims | `overWakeBudget` true |

## Live status JSON

HTTP was a fake edge so this lane did not write the shared local database. Realtime websockets were proxied to local `127.0.0.1:54321`. `wake_id` was READ from local Postgres. `cswarm-wake:` count in the live `status.json` and `events.ndjson` was 0.

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

- A live `cswarm listen start` against local **edge functions** (`POST /functions/v1/read` was 503 when this lane began). The pasted JSON is a real detached listener with `--state-dir <temp>` whose HTTP was a fake edge and whose websocket was proxied to the local Realtime stack.
- Posting a note through the live local edge (functions were not served; this lane did not `db:reset` and did not take the exclusive DB slot).
- Production / `--linked`.
- L5 watcher, L6 site, a second D-036 family arm (brief asked for one Gemini arm).
- That `agy` has written a `VERDICT` line yet (arm launched at freeze; see `arms-…/gemini/ARM.txt`).
