# L5 wake-watcher report

**Stop here. Do not merge.** Production and `--linked` were not touched. `db:reset` was not run.

## SHA

`09105507cc0c299d517436762c98d641daec31f4` on `lane/wake-watcher`.

Merge-base: `origin/main` at the 0.1.59 wake-client-fix (`f5c7c31` settle of `next()`).

Freeze: `lane-wake-watcher-arms/09105507cc0c299d517436762c98d641daec31f4/REVIEW.md` and `DIFF.patch`.
First `diff --git` line: `diff --git a/src/cli.ts b/src/cli.ts`.

Commit:

```
0910550 feat(notify): subscribe inbox --notify to the wake topic
```

## What shipped

`inbox --notify` reads `wake` from the inbox page it already does. With a topic it joins through `WakeSubscriber` (anon key, private channel). A wake does one inbox read, then the same notification and cursor write as today. While subscribed there is no 60 s poll; the only timer is the 5-minute reconcile. `CHANNEL_ERROR`/`CLOSED` return the 60 s poll. No `wake` on the page → today's poll, no socket.

The watcher still does not claim or ack. The topic is not in the notify line, stderr, or the pipe payload.

`src/listener/wake.ts` is not in this commit. The hang that dropped `next()` after an async `SUBSCRIBED` is already on main. This lane adds a delayed-`SUBSCRIBED` test that times out if that settle is reverted.

## Gates on this SHA

| command | exit |
|---|---|
| `npm run build` | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 |
| `npm test` | 0 (893 pass) |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (483 pass) |
| `npm run check:tests` | 0 |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 |

## Mutations

- Remove the `pushMode()` guard in `waitCapMs` → CHANNEL_ERROR test fails (until stays 5 min). Restored.
- Revert `finishWait` to null-then-resolve → delayed-SUBSCRIBED test times out 5 s. Restored to main's settle.

## Live control

Local stack, Realtime up, local-stack seat. Posted a note through the local command edge.

Arrival in **2440 ms** (not 60 s).

```
CommonSwarm from agent cfe4d537-481f-4281-acdc-bd4d7eaf83af: l5-wake-watcher-1788679789353 — reply: cswarm reply 70865b42-eeea-49e6-9998-c1cebee32148 "<answer>" --workspace-id 06502915-358e-463d-9ddf-85c53cf57a86
```

```
grep -c cswarm-wake: notify.log  → 0
grep -c cswarm-wake: notify.err  → 0
positive control (a line that contains cswarm-wake: plus 43 A's)  → 1
```

## Gemini arm

One arm, detached:

```
agy --dangerously-skip-permissions --model gemini-3.1-pro-high --print-timeout 90m
pid 89814
stdout: lane-wake-watcher-arms/09105507cc0c299d517436762c98d641daec31f4/gemini/ARM.txt
```

`VERDICT` line: **not yet**. `agy` buffers until exit. A 0-byte file is not a review.

## NOT established

- `cswarm resume` against this live notify process.
- Production / `--linked`.
- A `VERDICT` from this Gemini arm.
- `test:p1-local` / `test:p1-server`.

## Next

Do not merge until the Gemini arm prints `VERDICT: PASS` or the defects it names are folded.
