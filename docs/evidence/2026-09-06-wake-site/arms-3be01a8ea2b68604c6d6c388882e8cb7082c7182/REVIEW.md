# Lane wake-site freeze (round 2) — `3be01a8ea2b68604c6d6c388882e8cb7082c7182`

Branch `lane/wake-site`. Merge-base with `origin/main`: `88d9f45214b1e4224605818d188312cf1c5f17b5`.
Parent of this SHA: `4c04bae47ddfbc861dc08ae6c8711671385ffe49`.
Diff: `arms-3be01a8ea2b68604c6d6c388882e8cb7082c7182/DIFF.patch`.

Quote-back of the spec's first heading (required):

```
# Push delivery: wake listeners from Supabase Realtime instead of polling
```

First `diff --git` line of DIFF.patch:

```
diff --git a/site/src/components/app/LiveDashboard.astro b/site/src/components/app/LiveDashboard.astro
```

## Round 2 ruling

Spec §4.3 wins: while SUBSCRIBED the app reconciles every **30 s**, not 5 minutes.
`FEED_RECONCILE_MS = 30_000`. That is the only behaviour change on top of `4c04bae`.

Spec §4.3: "on `signal` fetch the page from the cursor; reconcile every 30 s while subscribed; fall back to the 2 s poll when not subscribed."

## Claims (three sentences)

1. On workspace open the app joins `cswarm-signals:{workspace_id}` with the existing supabase-js client and `private: true`; a `signal` event refreshes the feed (one in flight, one queued).
2. While `SUBSCRIBED` there is no 2-second poll — only a 30-second reconcile (`FEED_RECONCILE_MS = 30_000`, spec §4.3); `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` restore the 2-second poll and resubscribe with backoff; `SUBSCRIBED` again stops the poll.
3. Workspace switch removes the old channel before the new subscribe; the workspace id is captured before every await; the topic and channel errors never appear in the UI or in console logs.

## Files

- `site/src/lib/feed-push.ts` — `FEED_RECONCILE_MS = 30_000`
- `site/src/lib/commonswarm.ts` — `subscribeWorkspaceSignals`
- `site/src/components/app/LiveDashboard.astro` — arm/disarm/start/stop
- `site/src/lib/feed-push.test.mjs`
- `site/src/components/app/feed-push.observer.test.ts`
- `site/src/components/app/access-lifecycle.observer.test.ts`
- `site/src/components/app/header-roster.observer.test.ts`

Site only. No `src/`, no `supabase/`, no other component.

## Gates (this SHA)

| command | exit | note |
|---|---|---|
| `cd site && rm -rf dist && npm run build` | 0 | |
| `npm --prefix site test` | 0 | 511 pass, 1 skipped |
| root `npm test` | 0 | 861 pass |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 | 483 pass |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 | 6 address-fields |

## Mutation row (reconcile)

| mutation | result |
|---|---|
| `FEED_RECONCILE_MS = 300_000` | `reconcile fires once at 30 seconds while subscribed` fails (`0 !== 1`) |
| restore `30_000` | the same test passes |

## Checks (attack each; attempted refutation required)

Work from DIFF.patch and the files above. Change no files. Confirm `git rev-parse HEAD` is `3be01a8ea2b68604c6d6c388882e8cb7082c7182`. If it is not, FAIL.

Before any finding, quote back the first `diff --git` line of DIFF.patch exactly, and quote back the spec's first heading. If you cannot, stop and FAIL.

For every check: try to refute the claim at `file:line`. A PASS on a check is allowed only after you name the refutation you attempted and why it failed. "Looks fine" is not a review. You may answer "cannot determine".

1. **30 s reconcile.** `FEED_RECONCILE_MS` must be `30_000`, not `300_000`. After `SUBSCRIBED`, a 29_999 ms fake-time advance must not refresh; one more millisecond must. Spec §4.3, not the old lane brief.

2. **No 2 s poll while subscribed.** Between subscribe and 30 s, the 2 s poll must not fire.

3. **Coalesce.** Three `signal` events in 100 ms while the first refresh is in flight: at most two refreshes.

4. **CHANNEL_ERROR fallback.** Emitting the literal `"CHANNEL_ERROR"` must start the 2 s poll. Same for `TIMED_OUT` and `CLOSED`.

5. **Workspace switch.** Old `removeChannel` before the new `channel()`. Capture of workspace id before `currentSession` / `setAuth`.

6. **D-053.** No classifier in this diff branches on `error.message`.

7. **Enumerations.** Fallback statuses from `FEED_PUSH_FALLBACK_STATUSES`. Intervals from `FEED_POLL_MS` / `FEED_RECONCILE_MS`.

8. **0.1.57 silent server.** Join succeeds, no events: reconcile at 30 s. Join refused: poll at 2 s.

## Output

- Concrete `path:line` for every finding.
- DEFECT vs NIT.
- Last line exactly `VERDICT: PASS` or `VERDICT: FAIL`. FAIL on any DEFECT. Absence of a VERDICT line is not a review.
