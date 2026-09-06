# Lane L6 report — round 2 (spec §4.3 30 s reconcile)

SHA: `3be01a8ea2b68604c6d6c388882e8cb7082c7182`
Parent: `4c04bae47ddfbc861dc08ae6c8711671385ffe49`
Branch: `lane/wake-site` (not merged; ahead 3, behind 13 of `origin/main`)
Worktree: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-site`
Merge-base: `88d9f45214b1e4224605818d188312cf1c5f17b5`
Author: Yulan Bot `<yulanbot@gmail.com>`

## Round 2 ruling

Spec §4.3 wins over the first brief: while SUBSCRIBED the app reconciles every **30 s**, not 5 minutes. `FEED_RECONCILE_MS = 30_000`.

Spec §4.3: "on `signal` fetch the page from the cursor; reconcile every 30 s while subscribed; fall back to the 2 s poll when not subscribed."

## What landed (three commits)

- `1d42b33` feat(app): subscribe the workspace feed to cswarm-signals
- `4c04bae` feat(app): the live feed follows push while subscribed
- `3be01a8` fix(app): reconcile the subscribed feed every 30 s

Round 2 files:

- `site/src/lib/feed-push.ts` (`FEED_RECONCILE_MS = 30_000`)
- `site/src/lib/feed-push.test.mjs`
- `site/src/components/app/feed-push.observer.test.ts`

Nothing else changed.

## Behaviour

On workspace open the signed-in app joins `cswarm-signals:{workspace_id}` with the existing supabase-js client and `private: true`. A `signal` event refreshes the feed (one in flight, one queued). While `SUBSCRIBED` there is no 2-second poll; a reconcile runs every 30 seconds. `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` restore the 2-second poll. Workspace switch removes the old channel first.

A 0.1.57 server that never sends events is covered by the 30-second reconcile if the join succeeds, and by the 2-second poll if it is refused.

## Gates (this SHA)

| command | exit | note |
|---|---|---|
| `cd site && rm -rf dist && npm run build` | 0 | |
| `npm --prefix site test` | 0 | 511 pass, 1 skipped |
| root `npm test` | 0 | 861 pass |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 | 483 pass |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 | 6 address-fields |

## Mutation (reconcile)

| mutation | result |
|---|---|
| `FEED_RECONCILE_MS = 300_000` | `reconcile fires once at 30 seconds while subscribed` fails (`0 !== 1`) |
| restore `30_000` | the same test passes |

## Gemini arm

pid: `34824`
command: `agy --dangerously-skip-permissions --model gemini-3.1-pro-high --print-timeout 90m -p …`
output: `lane-wake-site/arms-3be01a8ea2b68604c6d6c388882e8cb7082c7182/gemini/ARM.txt`
review: `lane-wake-site/arms-3be01a8ea2b68604c6d6c388882e8cb7082c7182/REVIEW.md`
diff: `lane-wake-site/arms-3be01a8ea2b68604c6d6c388882e8cb7082c7182/DIFF.patch`

Launched detached (`nohup` + `disown`). Not waited. ARM.txt is 0 bytes at report time. No `VERDICT` yet.

## NOT established

- Gemini `VERDICT` (pid 34824 still running).
- A live signed-in browser join to `cswarm-signals:{workspace_id}` on hosted Realtime. Tests used a fake client.
- Merge to `main`. This SHA is not on `main`. `origin/main` moved while the lane ran (`ahead 3, behind 13` at freeze).
- Deploy. No `vercel deploy`. No `--linked`. Production was not touched.

## Next

Lead: wait for pid 34824, then run the second D-036 arm on this SHA. On FAIL, relaunch this lane with the findings. Do not merge yet.
