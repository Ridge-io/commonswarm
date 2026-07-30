# D-034 — bounded signal reads and a settling status fallback

**Date:** 2026-07-29

**Base audited:** exact main `c152c2cd78194007be57fb8671ae6820699f0ee1`

**Branch:** `swarm/Tundra/d034-signal-fetch-deadline`

**Task:** `d034-signal-fetch-deadline`

**Database/network used:** no

## Observation

A source audit counted 14 default-native `fetch`/injected-fetcher call sites in the requested
auth/workspace/dashboard paths. Six had application deadlines; eight did not. Three of the
unbounded sites were the signal reads in `src/cloud/signals.ts`:

1. human signal feed/inbox read;
2. agent signal feed/inbox read;
3. agent member read used to resolve recipients.

The status supplement passed two `readSignals()` promises to `Promise.allSettled()`. That
contained rejections but not permanently pending promises, so a provider that never answered
prevented the documented warning fallback from settling.

## Implemented mechanism

All three signal/member reads now share a 30-second `AbortController` deadline. The abort
signal is passed at the production `fetcher(...)` invocation, its timer is cleared in `finally`,
and the existing null/error handling remains the only outward failure mapping. Consequently:

- ordinary success and HTTP response handling are unchanged;
- a transport rejection still uses the existing error text;
- a request that remains pending is aborted and reaches that same existing error path;
- the real `settleSignalStatus()` call can observe both rejections and return the existing
  `SIGNAL_STATUS_UNAVAILABLE_MESSAGE`.

The observer at `tests/support/signal-fetch-deadline.test.ts` is pure and is named literally in
the root `npm test` script. It does not inherit credibility from a provider responding quickly:
its fetch double never settles unless the production abort signal fires.

## Positive observation

All commands below were captured by the fenced task ledger under evidence directory
`9a518dee-016e-48bb-ac28-4d29ea2f826c/d034-signal-fetch-deadline/`.

| Run | Command | Observed result |
| --- | --- | --- |
| 002 | `node --import tsx --test tests/support/signal-fetch-deadline.test.ts` | 2 tests, 2 pass, 0 fail |
| 004 | same command after restoring the mutation | 2 tests, 2 pass, 0 fail |
| 008 | final `npm test` | 81 tests, 81 pass, 0 fail |
| 009 | final `npm run build` | exit 0 |
| 010 | final `npm run check:tests` | exit 0 |

The first observer reaches all three production fetch sites, checks that none abort at
29,999 ms, then checks that all abort at 30,000 ms while preserving the three existing error
messages. The second passes two real pending `readSignals()` calls into `settleSignalStatus()`
and observes the nullable values plus the existing warning after 30,000 ms.

## Mutation discrimination

For ledger run 003, production signal propagation was deliberately removed from the shared
fetch invocation:

```diff
-      signal: controller.signal,
```

No test code changed. The same two-test command exited 1 with 0 pass / 2 fail: the production
sites recorded zero propagated signals instead of three and two respectively. The line was
restored before run 004 and before the branch diff was committed. This establishes that the
observer discriminates the production mechanism rather than merely accepting the unchanged
error wording.

## Scope and NOT ESTABLISHED

This evidence establishes deterministic timer behavior, production abort-signal propagation
at the three signal read sites, preservation of their existing outward error messages, and
settlement of the signal-status fallback under a never-answering fetch double.

It does **not** establish:

- live Supabase or other provider timing and cancellation behavior;
- end-to-end deployed CLI behavior;
- any database, Edge Function, browser, or deployment behavior;
- deadlines for CLI auth/login, accept-link, workspace-list, or browser create-workspace
  fetches identified by the wider audit;
- universal coverage of direct native `fetch` outside the audited paths.

No database command or DB-owning suite was run for this signals-only change.
