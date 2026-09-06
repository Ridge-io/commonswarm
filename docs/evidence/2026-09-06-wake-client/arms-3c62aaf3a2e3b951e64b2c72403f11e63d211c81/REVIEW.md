# Lane wake-client freeze — `3c62aaf3a2e3b951e64b2c72403f11e63d211c81`

Round 3. Branch `lane/wake-client`. Merge-base with `origin/main`: `012807d2588bba8683ffef4b599d076c047039a7`. Diff: `arms-3c62aaf3a2e3b951e64b2c72403f11e63d211c81/DIFF.patch`.

First `diff --git` line: `diff --git a/package.json b/package.json`

Round 2 SHA `9986f19` is retired. This SHA is that work plus one copy/code fold.

## Claims (three sentences)

1. The listener learns its wake topic from the optional `{ topic, event }` object; a `wake` event latches; past 50 wake-claims in a clock minute it stops claiming on wake, keeps the latch, and polls until the minute clears.
2. `cswarm listen status` reports `mode: "push"` only while subscribed and still claiming on wake; a client-budget pause reports `mode: "poll"` with `errorCode: "wake_budget"` (from `WAKE_ERROR_CODES`) and a sentence that says the socket is subscribed, claims are paused until the minute clears, and polling continues; a server 429 still uses `rate_limited`.
3. The topic never appears in `status.json` or `events.ndjson`; skipRead is gated on `LISTENER_WAKE_MODE_PUSH`; user-facing push/poll/`wake_budget` copy is built from the same constants the parsers read.

## Mode rule (budget pause)

Keep `mode: "poll"` while the client budget is paused. Spec §2.3: "`wake.mode` says how the listener learns there is work." During the pause the seat does not claim on wake, so it learns by polling. The sentence does not say `push` (false-success rule, same section: never say push unless subscribed *and* claiming on wake in this reading). `subscribedAt` stays non-null because the socket is still joined.

## Round 3 fold

| id | fold |
|---|---|
| Opus DEFECT | Client 50/min pause no longer prints "Realtime not connected (rate_limited)". `snapshot()` sets `errorCode` to `WAKE_ERROR_CODE_WAKE_BUDGET` (a `WAKE_ERROR_CODES` member) when `overWakeBudget()` and not a server 429. Third sentence branch. Mutation: budget path still emits `rate_limited` → pinned test actual `rate_limited`, expected `wake_budget`. |

## Files (this SHA vs 9986f19)

- `src/listener/wake.ts` — `wake_budget` on `WAKE_ERROR_CODES`; snapshot; sentence
- `tests/listener-wake.test.ts` — pinned budget snapshot + copy test enumerates `WAKE_ERROR_CODES`

## Gates (this SHA)

| command | exit |
|---|---|
| `npm run build` | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 |
| `npm test` | 0 (885 pass / 0 fail) |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (483 pass / 0 fail) |
| `npm run check:tests` | 0 |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 (28 address-fields) |

## Mutation rows

| mutation | result |
|---|---|
| budget snapshot `errorCode` stays `"rate_limited"` | `over-budget next()` actual `rate_limited`, expected `wake_budget` |
| `lastErrorDetail` = `Unauthorized: cswarm-wake:` + 43 chars | `readListenerStatus` rejects `/malformed/` |
| skip `topicRotatedAt` assignment in `setTopic` | rotation unit test actual `null` |
| `next()` consumes a pending wake while paused | 70 wakes → 70 claims |

## Live status JSON

Not re-run this round. Round 1 live control (fake HTTP edge, Realtime proxied to local `127.0.0.1:54321`, `cswarm-wake:` count 0) still stands for subscribe/poll. It did not hit the client budget, so it does not show `wake_budget`.

## NOT established

- Live `listen start` against local edge functions.
- A note posted through the live local edge.
- Production / `--linked`. `db:reset` was not run.
- L5 watcher / L6 site / W4 trigger broadcast.
- A `VERDICT` from this round's Gemini arm (launched after freeze; file may be empty until `agy` exits).
- Phoenix heartbeat timing.
