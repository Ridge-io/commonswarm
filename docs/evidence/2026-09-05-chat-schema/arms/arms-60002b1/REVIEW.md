# Adversarial review — lane/chat-schema at 60002b1 (FINAL ROUND)

You are an adversarial reviewer. Break this change; do not approve it.

Repo: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-chat-schema
Diff: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-chat-schema/arms-60002b1/DIFF.patch
Design: docs/design/2026-09-04-chat-platform-reconciled.md

FIRST LINE: quote back verbatim the first `diff --git` line of DIFF.patch. If you cannot read it, say so and stop.

**A bare list of "no finding" is NOT a review and will be discarded.** For each point, either give a
concrete defect with file:line, or say what you checked and why it holds.

## Scope, which changed since the last round

This lane was CUT back to the schema and edge. It no longer touches `site/` or `src/`. Findings about
published-page comments are out of scope and are recorded in the build plan's L8 addendum. Do not
re-raise them. In scope: three migrations, `_shared/channels.ts`, the `command` and `read` edges,
their tests, and the two design docs.

## What the lane claims

1. Channels and threads are added with NO change to any authorization rule. `channel_id` is nullable
   forever; nothing is backfilled; the read view keeps every clause it had.
2. Old clients keep working, on schema AND on request-parser shape.
3. Every user-facing enumeration or bound in the code this lane owns is generated from the constant the
   enforcement reads.
4. A refusal names the FIRST rule broken, never a rule that is merely also broken.
5. A thread reply cannot outlive its root, cannot root on a directed or archived-channel message, and
   `in_reply_to` behaviour is untouched.

## Attack, in order

1. **exactKeys.** Construct a body that validated before this change and 400s after. `modernKeys` is an
   all-or-nothing pair every installed client sends; agent read bodies always send `in_reply_to`.
2. **The two view splices.** Both migrations recreate `swarm_read.signals` from `pg_get_viewdef`. Can
   either drop, widen or reorder a WHERE arm? Is `swarm.assert_view_clauses_preserved` ever vacuous in a
   way that matters?
3. **`channel_id` reachable as NOT NULL, defaulted, or backfilled by any path.**
4. **The clamp.** The stored value is computed in a CTE and the WHERE tests THAT value on both the
   explicit and the defaulted path. Can a stored row outlive its root? Can a legal reply be refused? Can
   either CHECK on `swarm.signals` fire?
5. **Refusal ordering, final pass.** For `post_signal` and all three channel commands, find any input
   where the caller is told a rule that is not the first one broken. This has been wrong four times.
6. **Generated enumerations, final pass.** Name every sentence in the files this lane owns that
   describes a set or bound the code enforces without deriving it. `MODEL_RULE_TEXT` is a documented
   hand copy of `normalizedModel`'s 120 because that function is not exported from the bundle — say if
   you disagree that this is the right call.
6b. **The feedback normalizer call.** The edge calls `normalizedFeedbackBody` / `normalizedFeedbackContext`
   from the generated bundle. Is any observable behaviour changed beyond the refusal sentences?
7. **Thread roots.** Directed, private-reply, expired, cross-workspace and archived-channel roots must
   all be refused, and the refusals must not become an oracle for which ids exist.
8. **Delivery.** Prove no channel or thread post can create a `signal_deliveries` row that would not
   have been created before.
9. **The tests.** For each new test ask: would it pass if the feature were absent or broken? Name any
   control that cannot fail. `tests/p1-local/chat-channels-postgres.test.ts` (26 pass) and
   `tests/p1-server/chat-signals.test.ts` (130 pass in its suite) were both RUN against real Postgres.

LAST LINE, exactly: `VERDICT: PASS` or `VERDICT: FAIL`.
