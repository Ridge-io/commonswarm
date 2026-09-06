# L5 wake-watcher freeze — `09105507cc0c299d517436762c98d641daec31f4`

**Stop. Do not merge.** Production and `--linked` were not touched. `db:reset` was not run.

## Claims

`inbox --notify` takes an optional `wake` hint from the inbox page it already reads and joins that topic with the anon key through `WakeSubscriber`. A wake does one inbox read, then the existing notification and cursor write; while subscribed the only timer is the 5-minute reconcile from `LISTENER_RECONCILE_POLL_MS`. On `CHANNEL_ERROR`/`CLOSED` the wait cap is today's `ARRIVAL_WATCH_POLL_MS` (60 s) poll; a server without `wake` never joins and keeps that poll. The watcher still does not import or call claim/ack, and the topic does not appear in the notify line, stderr, or the pipe payload.

## Files

- `src/cloud/arrival-watch.ts` — wait contract
- `src/cli.ts` — `inbox --notify` creates and closes `WakeSubscriber`
- `tests/support/arrival-watch.test.ts` — fake socket

`src/listener/wake.ts` is unchanged on this SHA. The hang `finishWait` vs `next()` was already on main as `f5c7c31` (0.1.59). This lane's delayed-`SUBSCRIBED` test stays red if that settle is reverted.

## Gates (plain, `set -e`)

| command | exit |
|---|---|
| `npm run build` | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 |
| `npm test` | 0 (893 pass) |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (483 pass) |
| `npm run check:tests` | 0 |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 |

`DIFF.patch` first `diff --git` line: `diff --git a/src/cli.ts b/src/cli.ts`.

## Mutation rows

1. `waitCapMs`: `if (pushMode())` → `if (wake !== undefined && wake.hasTopic)` (always 5 min once a topic exists). Test `CHANNEL_ERROR resumes the 60s poll and SUBSCRIBED stops it` fails (`untils` stay at reconcile, no `now+60000`). Restored.
2. Revert `finishWait` to null `this.waiter` before `resolve` (the 0.1.58 hang). Test `delayed SUBSCRIBED unblocks the wait so a later wake can emit` times out at 5 s. Restored to main's settle. This SHA does not retouch `wake.ts`.

## Live control (this SHA, local stack, Realtime up)

`cswarm inbox --notify` against `http://127.0.0.1:54321` with a local-stack seat. A note posted through the local command edge arrived in **2440 ms** (not 60 s).

Notify line:

```
CommonSwarm from agent cfe4d537-481f-4281-acdc-bd4d7eaf83af: l5-wake-watcher-1788679789353 — reply: cswarm reply 70865b42-eeea-49e6-9998-c1cebee32148 "<answer>" --workspace-id 06502915-358e-463d-9ddf-85c53cf57a86
```

```
grep -c cswarm-wake: notify.log  → 0
grep -c cswarm-wake: notify.err  → 0
printf 'cswarm-wake:%s\n' "$(python3 -c 'print("A"*43)')" | grep -c cswarm-wake:  → 1
```

## NOT established

- `cswarm resume` against this live notify process (resume tests stayed green; resume does not read the topic).
- Production / `--linked`.
- A `VERDICT` from the Gemini arm (detached; file may still be empty).
- `test:p1-local` / `test:p1-server` (this lane does not own those gates).
- Phoenix heartbeat timing.

## Next

Do not merge until the Gemini arm prints `VERDICT: PASS` or the defects it names are folded.
