# Gemini inversion arm — lane/wake-client at 6c4e219a4d59a9a006c3da64a22ba732043ba959

You are an independent Gemini arm. You did not write this lane. Do not praise it.
Work from the files named below. Change no files.

- Checkout: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-client`
- SHA: `6c4e219a4d59a9a006c3da64a22ba732043ba959` (branch `lane/wake-client`)
- Base: `78b046991ae527830187d5c0934f1c41ced9a431` (`git merge-base origin/main HEAD`)
- Diff: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-client/arms-6c4e219a4d59a9a006c3da64a22ba732043ba959/DIFF.patch`
- Spec: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-client/docs/design/2026-09-06-PUSH-DELIVERY.md` §2.3, §2.4, W3.4, L4 in §6

Before any finding, quote back the first `diff --git` line of DIFF.patch exactly. If you cannot, stop and FAIL.

Confirm `git rev-parse HEAD` is `6c4e219a4d59a9a006c3da64a22ba732043ba959`. If it is not, FAIL.

## What the lane claims

1. Parsers in `src/cloud/signals.ts`, `src/cloud/delivery.ts`, and `src/cloud/renewal.ts` carry optional `wake: { topic, event }`. 0.1.57 servers may omit it. A present malformed value fails closed.
2. `WakeSubscriber` (`src/listener/wake.ts`) subscribes with the anon key to the private topic. On `wake` it latches. `next({ until })` resolves on a latched/new wake, a transition into or out of `subscribed`, or the deadline. Realtime status strings are mapped at the boundary by code (`SUBSCRIBED`, `CHANNEL_ERROR`, `CLOSED`, `TIMED_OUT`), never `error.message` (D-053).
3. While subscribed, reconcile is every `LISTENER_RECONCILE_POLL_MS` (5 min) and is not restarted by a wake. While not subscribed, poll uses lane A's idle cadence (`src/cloud/idle-poll.ts`). `cursor_fallback` is unchanged. The claim path is the only truth.
4. Status has a nested `wake` object (`parseListenerWake`) with closed keys `mode`, `subscribedAt`, `reconnects`, `lastWakeAt`, `lastReconcileAt`, `errorCode`, `topicRotatedAt`, `rateLimited`. `mode` is `"push"` only when subscribed right now. `topic`, `wakeTopic`, `wake_topic` are in `STATUS_SENSITIVE_KEYS` at top level and inside the sub-parser. The topic never appears in status or `events.ndjson`.
5. Read-health stores `expectedClaims` per hour from lane A's slowest-cadence rule and excludes mode-change hours from lapse scoring.
6. Client budget: `WAKE_COALESCE_MS = 1000`, `WAKE_CLAIMS_PER_MINUTE_BUDGET = 50`. A `rate_limited` claim code flips poll for 60 s.

## Checks (attack each; attempted refutation required)

For every check: try to refute the claim at `file:line`. A PASS on a check is allowed only after you name the refutation you attempted and why it failed. "Looks fine" is not a review. You may answer "cannot determine" if the files do not settle it.

1. **Wait contract.** Attack `runListenerRuntime`. Can a wake restart `reconcileDueAt`? Can a socket drop during a five-minute wait leave the loop asleep until the old deadline? Is `next()` raced against a separate timer (losing promise)? Two wakes during one claim: is the second dropped?

2. **False push.** Find a path where status or the human sentence says `push` while `state !== subscribed`. Rate-limited while still subscribed: what does `mode` say?

3. **Topic leak.** Enumerate every writer of `status.json` and `events.ndjson` in this diff. Can the topic land in `lastErrorDetail`, `lastWorkerStderrTail`, a wake event field, or a log line? Mutation: if `lastErrorDetail` contains `cswarm-wake:` + 43 chars, does the existing guard reject?

4. **D-053.** Does any classifier in this diff branch on `error.message`? Realtime `Unauthorized: … topic: cswarm-wake:…` prose must not decide `unauthorized` vs `channel_error`.

5. **Enumerations.** `mode: push|poll` in user-facing copy and parsers must come from `LISTENER_WAKE_MODES` / `LISTENER_WAKE_MODE_SET`. The 5 min / 15 s labels must come from `LISTENER_RECONCILE_POLL_MS` and idle-poll constants, not typed strings.

6. **Parsers.** A 0.1.57 response without `wake` still parses. A present `wake` with a bad topic fails closed on claim/read/renewal. Extra unknown keys on the wire hint: accept or reject, and is that tested?

7. **Read-health.** Lane A's slowest-cadence rule must still hold (`15s` then `60s` mid-hour scores at 60s). A mode-change hour must not become a lapse. `expectedClaims` stored when the hour closes: prove it is written, not only computed at summarize time.

8. **npm test list.** `tests/listener-wake.test.ts` must be in the literal `package.json` `test` script. A file only on disk is not in the gate.

9. **cursor_fallback.** Prove the new wait does not skip the inbox read on every tick when `deliveryMode === "cursor_fallback"`.

## Output

- Concrete `path:line` for every finding.
- DEFECT vs NIT.
- Last line exactly `VERDICT: PASS` or `VERDICT: FAIL`. FAIL on any DEFECT. Absence of a VERDICT line is not a review.
