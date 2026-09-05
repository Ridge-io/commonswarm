# lane/wake-all-recipients — review rounds

Two D-036 arms per SHA: Grok and Gemini (`agy`), the two cross-family arms. The
author family is Claude, so it is excluded from both.

## Round one, 3547d82 — FAIL / FAIL

Grok raised two findings. Both were verified at the cited lines and both were real.

1. **BLOCKER: the predicate refused a self-addressed signal, and a self-note is a
   supported first-party path.** `runListenerAttendanceCanary`
   (`src/listener/attendance-canary.ts`, the `post_signal` at the top of the
   function) sends `to_agent_principal_id: options.principalId` with the agent's
   own credential, and `cswarm listen canary` is that path. With the clause, the
   canary's note wrote no delivery row, so the canary would stall before
   `claimed` and report a running listener as absent.

   FIXED by removing the clause. Applying it to the recipient rows only was
   rejected: the scalar shape and a one-entry `to` list must write the same
   ledger, which both suites measure. The accidental shape the clause was aimed
   at, an agent waking itself on every turn in a group it belongs to, is now
   recorded as OPEN in the migration header and in the build plan.

2. **The channel column list was a third typed copy, under a comment that named a
   control that does not exist.** The comment said
   `tests/chat-signal-wire-compat.test.ts` fails when the lists drift; that file
   never mentions `CHANNEL_COLUMNS`, and the constant in the read edge was not
   even read by the query.

   FIXED. The list is `CHANNEL_READ_COLUMNS` in
   `supabase/functions/_shared/channels.ts` — the one module both sides can
   import. The read edge interpolates it into its SELECT,
   `tests/chat-channel-constants.test.ts` imports BOTH arrays and compares them,
   and the p1-server assertion is generated from it. M12 is its control.

Gemini also returned FAIL, on one finding, and that finding is REFUTED: it said
the claim "the `signals_check` CHECK on swarm.signals" is false because the
constraint in `20260724000003_signals.sql` is unnamed. Postgres auto-names an
unnamed table CHECK `<table>_check`, and the local database reports exactly
`signals_check => CHECK ((until > created_at))`. Grok checked the same clause
independently and called it accurate. Nothing was changed for it.

Both arms also noted that the wakeable-kinds test would pass with the fan-out
removed, because the trigger on `swarm.signals` enforces the same kind list.
Correct at that SHA. The test now also asserts that a delivered kind wakes BOTH
recipients; M6b is the re-measurement that turns it red.

## Round two, a1bc2f8 — PASS / PASS

Both arms quoted back the diff's first `diff --git` line and reasoned section by
section. See `arms/a1bc2f8-grok-ARM.txt` and `arms/a1bc2f8-gemini-ARM.txt`.

Two things the arms named and this lane did NOT change, recorded so the next
editor meets them:

- **Grok:** the p1-local self-note case uses a ONE-ENTRY recipient list. It does
  not also place the sender at position 1 of a group, which is the accidental
  shape the removed clause was aimed at. Grok called it a coverage gap and not a
  missing refusal; the shape is recorded as open in the migration header.
- **Grok:** the sentence in `hydrateDeliveryRefs` calling the recipient set "the
  same set the read view's own predicate uses" is loose. The view also admits the
  OWNER of an addressed agent through `auth.uid()`; hydrate admits only the
  principal. That is narrower, so the clause that follows it — nothing readable
  here that is not readable there — still holds. Both arms passed the prose
  section with that note.

## A residual this lane did NOT fix

Both rounds surfaced it and Gemini confirmed the reading: `src/cloud/arrival-watch.ts:396`
and `src/listener/hook.ts:700` re-check the SCALAR `to_agent` on FEED rows. L2
(merged 060ff67) already widened the read edge to return a signal to every agent
in its recipient set, so a signal naming an agent at position 1 is dropped by the
session hook and makes `arrival-watch` THROW. That is reachable on production
today, without this lane. It is not fixed here: both files are outside this lane's
ownership, and closing it needs a decision about how the client learns the
recipient set, since `parseSignalRecord` does not parse `recipients`.

## A wire shape this lane creates, measured

A hydrated delivery could never carry both `to` and `to_agent` before. The old
filter required `s.to_agent_principal_id = <claimer>`, and `signals_one_recipient`
(`num_nonnulls(to_user_id, to_agent_principal_id) <= 1`) then forced `to` to null.
With a PERSON at position 0 and an AGENT at position 1, both are now set. Measured
against the served command edge on the local stack, at a1bc2f8, with a temporary
probe in a detached worktree (not committed):

```
PROBE hydrated: {"to":"ceea62bb-...","to_agent":"d9a0838f-...",
                 "recipient_position":1,"recipient_count":2}
```

Both values are true: `to` is the person the sender named first, `to_agent` is the
recipient this delivery is for. Nothing in `src/` treats the pair as exclusive.
The three places that test both columns —
`src/cloud/arrival-watch.ts:396`, `src/cloud/agent-signal-receipts.ts:34` and
`src/cli.ts:5634` — ask `to === null && to_agent === null`, which is the broadcast
question, and a both-set row correctly answers "not a broadcast". None of the
three reads a hydrated delivery in any case; they read feed pages.

NOT ESTABLISHED: no test asserts this shape. The probe measured it once and was
removed. A test for it belongs with whatever lane fixes the feed-side residual
above, because that lane has to decide what a client should render for a signal
addressed to a person and an agent at once.

---

# Second scope: the CLI wiring and the feed-side scalar re-check

The lead extended the lane after the a1bc2f8 PASS/PASS, adding `src/cli.ts` and
`src/cloud/arrival-watch.ts` to its ownership, because the release must not ship
false copy or a reachable throw.

## Round three, ecbb26b — FAIL / FAIL

Both arms named the same first finding, and it is a hang.

1. **Neither channel reader's deadline covered the response BODY.** Both cleared
   the timer in the fetch's own `finally`, then awaited `.json()` with nothing
   armed. A server that answered 200 and stalled the stream held
   `cswarm channel ls` for ever: no abort, and `channelRows` retries only
   `noResponse`, which a hung `json()` never becomes. `listChannelsAsAgent` was
   copied from `listChannelsAsHuman`, which had the defect first, so BOTH are
   fixed. A stalled body now takes the retryable sentence rather than one that
   blames the server for our own deadline.
2. **Grok: the ORDER paragraph was false.** It said `lower(slug)` and `slug` can
   disagree for a workspace "mixing cases". `20260905000001_channels.sql` CHECKs
   `slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`, so that workspace cannot exist.
3. **Grok: "the human path above".** `listChannelsAsHuman` is below.
4. **Gemini: the body comment claimed key ORDER is enforced.** `exactKeys`
   compares SORTED key sets. The comment says what it does; the test asserts the
   sorted key set beside the pinned bytes.

A mutation, not an arm, caught the fifth: **M15 left every channel test green.**
The offline probes stopped at the credential step, before the branch the lane
removed, so they proved nothing about it. a3a69e5 adds a probe that reaches
`channelRows` with a readable credential and a dead port; M15b turns it red.

## Round four, 4250111 — FAIL / FAIL, prose only

Both arms passed every behavioural section. Both failed section 8.

- **Grok:** round three fixed the word "above" in the JSDoc and the same commit
  wrote it again, one line later, inside the function.
- **Gemini:** the retirement note claimed `channelRows` "no longer branches on
  the credential kind". It branches, to pick the transport; what it no longer
  does is refuse. The commit message of ecbb26b carries the same false sentence
  and cannot be edited without rewriting three SHAs, so `de87327` corrects it in
  the code and in its own message.
- Gemini also observed that `signalAddressesAgent` trusts the server's
  `recipients` array. Recorded in the function's doc rather than changed: the
  same server writes `to_agent`, which the scalar check trusted for the same
  question.

## Round five, de87327

Both arms relaunched on the final SHA. See `arms/de87327-*`.

## A shared-host accident worth recording

Commit `a3a69e5` landed with another lane's subject line, "fix(app): the stored
draft is frozen for the whole post, like the pair". Its tree was always this
lane's one test file. The cause: the commit message was written to a path under
`/tmp`, which every agent on this host shares, and another lane overwrote it
between the write and the `git commit -F`. The two commits were rebuilt as
`a2c9f5d` and `4250111` with `git diff` proving the trees identical, and every
message since is written under this session's own scratchpad.

## Round six, ab03511 — PASS / PASS

Grok PASS on the first launch. Gemini's first launch produced ZERO bytes for 72
minutes, far outside its 10 to 20 minute range on the five earlier rounds, so it
was killed by its recorded pid and relaunched once; the relaunch answered PASS in
under nine minutes. The stalled attempt's empty file is kept as
`arms-ab03511/gemini/ARM-stalled-attempt1.txt` in the worktree and is not
evidence of anything except the stall.

Grok PASS. Its round-five FAIL was the same sentence a THIRD time: the build plan's
sequencing item 3 still said `channelRows` "no longer branches on the credential
kind" after round four corrected it in `src/cloud/channels.ts`. Both copies now
agree, and the retry-budget comment now names `channelRows` rather than the two
readers as the place a shared budget would change.

The pattern across rounds three to six is worth naming: four consecutive FAILs
were prose, and three of them were ONE claim that lived in more than one file.
Correcting the copy a reader is most likely to meet is not the same as sweeping
the claim family, which is what AGENTS.md already says under "Claim controls
prove stability, not truth".

## A stale claim in the site owner's file, routed rather than edited

`site/src/lib/commonswarm.ts:2252` says "The read edge exposes no channel list, so
the browser reads `swarm_read.channels` directly". The first clause is false once
the `read` edge deploys. The second clause and the code stay correct, because the
read function accepts agent credentials only and a browser has none. The
replacement sentence is in the build plan's sequencing item 3b. Not edited here:
`site/` belongs to the threads lane.
