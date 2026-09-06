You are a D-036 independent inversion arm for CommonSwarm lane L3 (wake in responses and rotation). Author family is Grok. You are Gemini. Read-only. Do not edit files. Do not run supabase db push. Do not touch production.

SHA (must bind the verdict to this exact SHA): 7c9a4589b7c62151d2bf087f0417d969fea516a4
Worktree: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-command
Diff: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-command/arms-7c9a4589b7c62151d2bf087f0417d969fea516a4/DIFF.patch
Review notes: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-command/arms-7c9a4589b7c62151d2bf087f0417d969fea516a4/REVIEW.md
Spec: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-command/docs/design/2026-09-06-PUSH-DELIVERY.md (W3, W6, §6 L3 row)
Read edge: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-command/supabase/functions/read/index.ts
Command edge: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-command/supabase/functions/command/index.ts
Wake helper: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-command/supabase/functions/_shared/wake.ts
Tests: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-command/tests/p1-server/wake-topic-in-responses.test.ts and /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-command/tests/p1-server/wake-rotation.test.ts

REQUIRED: quote back the first `diff --git` line from DIFF.patch verbatim. If you cannot, verdict FAIL.

You may answer "cannot determine" on a question. Guessing is a defect.

Failure-by-default questions. Each needs file:line and a concrete counterexample if FAIL:

1. Quote the first `diff --git` line from DIFF.patch.
2. Does the own-workspace inbox return (the one that already carries capabilities) add optional `wake` only when the caller is an agent and `inbox` is true? Confirm the foreign-workspace empty branch does not.
3. Is `wake_id` selected as the eleventh column of `agent_delivery_read_context` in the read edge SELECT list?
4. Do mint, renew, and claim HTTP responses carry the same optional `wake` object, and is mint/renew added where `agent_token` is returned (freshOnly), not stored in the idempotency ledger?
5. Are the topic prefix and event name generated from `_shared/wake.ts` constants rather than typed separately in read and command?
6. Re-derive every statement in `command/index.ts` that writes `agent_tokens.revoked_at` or `agent_principals.revoked_at`. Are they still four (stranded successor, principal revoke, principal-revoke token cascade, token revoke)? Does rotate run only at principal revoke and token revoke, not at stranded-successor discard, and is there no second rotate on the cascade?
7. Does the rotation test assert token revoke rotates, principal revoke rotates, stranded-successor discard does not, and that after token revoke with a remaining live token `wake_topic_authorized` refuses the old topic and admits the new one?
8. Does production TypeScript classify rotation/revocation by named command/event type rather than `error.message` (D-053)?
9. Is there a client or site change in this diff? There must not be (`src/` except protocol if shared; no site).
10. Did the tests get `wake` from the same helper the edges use, so a prefix drift would fail them?

End the reply with exactly one line:
VERDICT: PASS
or
VERDICT: FAIL
