# L4 wake-client — round 3 report

**Stop here. Do not merge.** Production and `--linked` were not touched. `db:reset` was not run.

## SHA

`3c62aaf3a2e3b951e64b2c72403f11e63d211c81` on `lane/wake-client`.

Merge-base: `012807d2588bba8683ffef4b599d076c047039a7`.

Round 2 SHA `9986f19` is retired. This SHA is that work plus one fold.

Freeze: `arms-3c62aaf3a2e3b951e64b2c72403f11e63d211c81/REVIEW.md` and `DIFF.patch`.
First `diff --git` line: `diff --git a/package.json b/package.json`.

New commit:

```
3c62aaf fix(listener): name the client wake-claim pause wake_budget
```

## Round 3 fold

A subscribed seat that hit the client 50/min budget printed "poll every 15s. Realtime not connected (rate_limited)." Both clauses were false.

Now: `errorCode` is `wake_budget` from `WAKE_ERROR_CODES`. Sentence: "Subscribed; claims paused until the minute clears (wake_budget); polling every 15s meanwhile." A server 429 still uses `rate_limited`.

`mode` stays `poll` while paused. Spec §2.3: `wake.mode` is how the listener learns there is work. During the pause it learns by polling, not by claiming on wake. The sentence does not say `push`. `subscribedAt` stays set because the socket is still joined.

Mutation: budget snapshot still emits `rate_limited` → pinned test actual `rate_limited`, expected `wake_budget`.

Opus nits N-a and N-b were not folded.

## Gates on this SHA (plain, `set -e`)

| command | exit |
|---|---|
| `npm run build` | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 |
| `npm test` | 0 (885 pass) |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (483 pass) |
| `npm run check:tests` | 0 |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 |

## Live control

Not re-run this round. Round 1 live JSON still stands for subscribe/poll. It did not hit the client budget, so it does not show `wake_budget`.

## Gemini arm

One arm, detached:

```
agy --dangerously-skip-permissions --model gemini-3.1-pro-high --print-timeout 90m
pid 90337
stdout: arms-3c62aaf3a2e3b951e64b2c72403f11e63d211c81/gemini/ARM.txt
```

`VERDICT` line: **not yet**. `agy` buffers until exit. A 0-byte file is not a review.

## NOT established

- Live `listen start` against local edge functions.
- A note posted through the live local edge.
- Production / `--linked`.
- L5 watcher / L6 site / W4 trigger broadcast.
- A `VERDICT` from this Gemini arm.
- Phoenix heartbeat timing.

## Next

Do not merge until the Gemini arm prints `VERDICT: PASS` or the defects it names are folded.
