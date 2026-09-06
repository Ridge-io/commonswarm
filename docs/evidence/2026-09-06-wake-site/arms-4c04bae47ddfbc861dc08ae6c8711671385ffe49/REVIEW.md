# Lane wake-site freeze — `4c04bae47ddfbc861dc08ae6c8711671385ffe49`

Branch `lane/wake-site`. Merge-base with `origin/main`: `88d9f45214b1e4224605818d188312cf1c5f17b5`.
Diff: `arms-4c04bae47ddfbc861dc08ae6c8711671385ffe49/DIFF.patch`.

Quote-back of the spec's first heading (required):

```
# Push delivery: wake listeners from Supabase Realtime instead of polling
```

First `diff --git` line of DIFF.patch:

```
diff --git a/site/src/components/app/LiveDashboard.astro b/site/src/components/app/LiveDashboard.astro
```

## Claims (three sentences)

1. On workspace open the app joins `cswarm-signals:{workspace_id}` with the existing supabase-js client and `private: true`; a `signal` event refreshes the feed (one in flight, one queued).
2. While `SUBSCRIBED` there is no 2-second poll — only a 5-minute reconcile; `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` restore the 2-second poll and resubscribe with backoff; `SUBSCRIBED` again stops the poll.
3. Workspace switch removes the old channel before the new subscribe; the workspace id is captured before every await; the topic and channel errors never appear in the UI or in console logs.

## Files

- `site/src/lib/feed-push.ts` (new) — topic, fallback set, controller
- `site/src/lib/commonswarm.ts` — `subscribeWorkspaceSignals`
- `site/src/components/app/LiveDashboard.astro` — arm/disarm/start/stop
- `site/src/lib/feed-push.test.mjs` (new) — fake client + fake time
- `site/src/components/app/feed-push.observer.test.ts` (new)
- `site/src/components/app/access-lifecycle.observer.test.ts`
- `site/src/components/app/header-roster.observer.test.ts`

Site only. No `src/`, no `supabase/`, no other component. The feed still shows the same rows.

## Cadence note

Spec §4.3 types a 30 s reconcile. The lane brief requires 5 minutes while subscribed. This SHA uses `FEED_RECONCILE_MS = 300_000`. That is deliberate.

## Gates (this SHA)

| command | exit | note |
|---|---|---|
| `cd site && rm -rf dist && npm run build` | 0 | |
| `npm --prefix site test` | 0 | 511 pass, 1 skipped |
| root `npm test` | 0 | 861 pass |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 | 483 pass |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 | 4 address-fields |

## Mutation row

| mutation | result |
|---|---|
| drop `"CHANNEL_ERROR"` from `FEED_PUSH_FALLBACK_STATUSES` | `CHANNEL_ERROR resumes the two-second poll` fails (`true !== false` on `subscribed`) |
| restore the name | the same test passes |

## Checks (attack each; attempted refutation required)

Work from DIFF.patch and the files above. Change no files. Confirm `git rev-parse HEAD` is `4c04bae47ddfbc861dc08ae6c8711671385ffe49`. If it is not, FAIL.

Before any finding, quote back the first `diff --git` line of DIFF.patch exactly, and quote back the spec's first heading. If you cannot, stop and FAIL.

For every check: try to refute the claim at `file:line`. A PASS on a check is allowed only after you name the refutation you attempted and why it failed. "Looks fine" is not a review. You may answer "cannot determine".

1. **No poll while subscribed.** After `SUBSCRIBED`, a 60 s fake-time advance must not refresh. Is the 2 s timer still armed? Can `arm()` while subscribed still install `FEED_POLL_MS`?

2. **Coalesce.** Three `signal` events in 100 ms while the first refresh is in flight: at most two refreshes. Does `refreshLatestSignals`'s own `liveFeedInFlight` drop the queued one?

3. **CHANNEL_ERROR fallback.** Emitting the literal `"CHANNEL_ERROR"` (not reading the set) must start the 2 s poll. Removing that name from `FEED_PUSH_FALLBACK_STATUSES` must make that test fail. Same for `TIMED_OUT` and `CLOSED`. Does a self-`CLOSED` from `removeChannel` restart poll+backoff on a workspace we are leaving?

4. **Workspace switch.** Old `removeChannel` before the new `channel()`. Capture of workspace id before `currentSession` / `setAuth`. Can a slow join for A paint onto B?

5. **D-053.** Does any classifier in this diff branch on `error.message`? Realtime refusal prose quoting the topic must not decide poll vs push.

6. **Enumerations.** Fallback statuses must come from `FEED_PUSH_FALLBACK_STATUSES`. Poll/reconcile intervals from `FEED_POLL_MS` / `FEED_RECONCILE_MS`. No typed list in UI copy.

7. **UI honesty.** Topic name, `CHANNEL_ERROR`, and Realtime must not appear in `textContent` or console logging. The Live chip still means the feed can refresh itself.

8. **0.1.57 silent server.** Subscribe succeeds but no events: reconcile at 5 min still refreshes. Subscribe refused: poll at 2 s. The page must not depend on events arriving.

## Output

- Concrete `path:line` for every finding.
- DEFECT vs NIT.
- Last line exactly `VERDICT: PASS` or `VERDICT: FAIL`. FAIL on any DEFECT. Absence of a VERDICT line is not a review.
