# L4 round 2 — verified findings on 6c4e219 (fold all; separate commits)

Arm texts: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-client/arms-6c4e219a4d59a9a006c3da64a22ba732043ba959/ARM-opus.txt (DEFECT + six nits, read it whole) and /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-client/arms-6c4e219a4d59a9a006c3da64a22ba732043ba959/gemini/ARM.txt (checks 5, 6).

DEFECT (Opus, measured with a probe test on the real WakeSubscriber + runtime under a frozen clock: 70
claims and 20 extra read POSTs in one clock minute; spec ceiling 51): the 50/min wake-claim budget is
inert. `src/listener/runtime.ts:1170-1188` — when the budget is hit the code only clears `skipRead` and
falls through to the ordinary read+claim; `:1556` calls `noteClaim` instead of `noteWakeClaim`, so the
state never recovers. Required behaviour (spec §2.3/§2.4): when the budget is hit the listener DEGRADES TO
POLL at the idle cadence for the rest of that minute (no claim on wake; wakes are latched, the reconcile
covers them), status `mode: poll` with `rateLimited: true`, and it returns to push when the window
clears. Add a test that reproduces the arm's probe (frozen clock, 70 wakes in a minute → at most 51
claims, no extra reads) and fails on the old code.

Opus nits (fold each with a test where one is named): no test for the §2.4 topic-rotation row (server
rotates → CLOSED/refused → poll → next read learns the new topic → push again); the detach/connect race
in `setTopic` (a subscribe in flight while the topic changes); and the other four in the file.

Gemini: (5) `control.ts:1081` and `:402` type "push"/"poll" literals; derive from `LISTENER_WAKE_MODES`
(the enumeration rule in AGENTS.md); (6) add a test that `parseOptionalWakeHint` accepts and drops
unknown keys (its documented behaviour). Gemini's checks 3 and 9 were refuted by the lead
(`control.ts:510` rejects a topic in lastErrorDetail; the claim branch is inside the durable_claim guard
at `runtime.ts:1486`); do not change those.

Gates as in the lane brief (build, tsc, npm test, p1-cli, check:tests, identity). Mutation rows for the
budget test and the rotation test. Rebase onto origin/main first (L8 landed docs; no code conflict).
Freeze the new SHA (REVIEW.md, DIFF.patch), ONE Gemini arm detached, overwrite
/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-client-REPORT.md with the new SHA. Stop. Never db:reset, never production.
