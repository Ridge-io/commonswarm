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

All three signal/member reads now share a 30-second deadline covering both the initial fetch
and successful-response JSON consumption. The deadline signal is composed with any signal
already present on `RequestInit`, passed at the production `fetcher(...)` invocation, and raced
against the complete read. The race makes the caller settle even if an injected fetcher ignores
the signal; native fetch additionally receives the abort so it can cancel underlying I/O. The
timer and abort listener are cleared on every settled caller path, and the existing null/error
handling remains the only outward failure mapping. Consequently:

- ordinary success and HTTP response handling are unchanged;
- a transport rejection still uses the existing error text;
- a fetch or successful-response body that remains pending reaches that same error path at
  30 seconds;
- the real `settleSignalStatus()` call can observe both rejections and return the existing
  `SIGNAL_STATUS_UNAVAILABLE_MESSAGE`.

The observer at `tests/support/signal-fetch-deadline.test.ts` is pure and is named literally in
the root `npm test` script. It does not inherit credibility from a provider responding quickly:
one fetch double never returns headers, a second ignores abort entirely, and a third returns
headers before its JSON body hangs.

## Positive observation

All commands below were captured by the fenced task ledger under evidence directory
`9a518dee-016e-48bb-ac28-4d29ea2f826c/d034-signal-fetch-deadline/`.

| Run | Command | Observed result |
| --- | --- | --- |
| 036 | final `node --import tsx --test tests/support/signal-fetch-deadline.test.ts` | 3 tests, 3 pass, 0 fail |
| 037 | final `npm test` | 82 tests, 82 pass, 0 fail |
| 038 | final `npm run build` | exit 0 |
| 039 | final `npm run check:tests` | exit 0 |

The first observer reaches all three production fetch sites, checks that none abort at
29,999 ms, then checks that all abort at 30,000 ms while preserving the three existing error
messages. The second lets the helper receive successful response headers, then proves a pending
JSON body is still bounded. The third passes two real pending `readSignals()` calls into
`settleSignalStatus()` through a fetcher that records but deliberately ignores both abort
signals; it observes the nullable values plus the existing warning after 30,000 ms. That third
observer distinguishes bounded caller settlement from cancellation of underlying I/O.

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

Gemini's review of the first pushed SHA found that its timer ended when response headers
arrived, leaving `response.json()` unbounded. After extending the deadline across body parsing,
the production helper was deliberately changed back to clear its timer immediately after
headers. Run 022 initially (and incorrectly) passed because the observer advanced mock time
before the helper's fetch continuation had processed those headers. That result is discarded.
The observer was corrected to yield through that continuation first. With the same production
mutation still present, run 023 then timed out at 250 ms: 1 selected, 0 pass, 1 cancelled.
Restoring the production lifecycle passed all 3 observers in the final run 036.

This second discrimination matters independently of signal propagation: it proves response
headers cannot silently end the application deadline before the body settles.

## Reviewer rejection and response

The first pushed SHA was `47ebead7edb54427a4b5065cca8df07db859187b`. Grok approved it
while correctly naming post-header body stalls as residual risk. AGY/Gemini rejected it because
that risk contradicted the task's bounded-read outcome. The rejection was accepted:

- the deadline now covers successful-response JSON parsing;
- an existing caller signal is composed rather than overwritten;
- the caller races the full read against abort, so a non-cooperative injected fetcher cannot
  keep `readSignals()` pending, although its ignored underlying I/O may continue;
- the body-stall observer and its corrected scheduling discrimination are on root `npm test`.

Grok then approved replacement SHA `7613165aa3c0927a16a751c52ac286af4daaf915`
but found that a header-level fetcher which ignored abort was proven by code and an external
probe rather than the committed root observer. That evidence-completeness finding was accepted:
the real status-fallback observer now deliberately uses two fetch calls that never settle and
ignore their propagated abort signals. Its settlement therefore discriminates the abort race,
not cooperative transport cancellation.

Gemini also noted that `settleSignalStatus()` accepts arbitrary promises. That is retained as
a non-claim: the product path is bounded because it passes the deadline-backed `readSignals()`
promises, not because `Promise.allSettled()` independently times out every possible input.
Both required reviewers must bind again to the final SHA; the task ledger and Lead
handoff carry those final exact-SHA verdicts because a commit cannot contain its own hash.

## Scope and NOT ESTABLISHED

This evidence establishes deterministic timer behavior, production abort-signal propagation
at the three signal read sites, deadline coverage through successful-response JSON parsing,
preservation of existing outward error messages, and settlement of the signal-status fallback
under never-answering fetch and body doubles.

It does **not** establish:

- live Supabase or other provider timing and cancellation behavior;
- cancellation of underlying I/O for an injected fetcher that ignores `AbortSignal` (only the
  caller's bounded settlement is established);
- bounded settlement for arbitrary promises passed directly to `settleSignalStatus()`;
- end-to-end deployed CLI behavior;
- any database, Edge Function, browser, or deployment behavior;
- deadlines for CLI auth/login, accept-link, workspace-list, or browser create-workspace
  fetches identified by the wider audit;
- universal coverage of direct native `fetch` outside the audited paths.

No database command or DB-owning suite was run for this signals-only change.
