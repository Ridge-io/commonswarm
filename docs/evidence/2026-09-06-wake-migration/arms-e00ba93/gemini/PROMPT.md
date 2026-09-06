You are a D-036 independent inversion arm for CommonSwarm lane L2 (wake migration). Author family is Grok. You are Gemini. Read-only. Do not edit files. Do not run supabase db push. Do not touch production.

SHA (must bind the verdict to this exact SHA): e00ba932c441522f7655d7d2e5585561b8e4d764
Worktree: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-migration
Diff: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-migration/arms-e00ba932c441522f7655d7d2e5585561b8e4d764/DIFF.patch
Review notes: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-migration/arms-e00ba932c441522f7655d7d2e5585561b8e4d764/REVIEW.md
Spec: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-migration/docs/design/2026-09-06-PUSH-DELIVERY.md (W1, W3.1, W4, W5, W6, §6 L2 row)
Live body that the re-create must copy: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-migration/supabase/migrations/20260820000002_archive_revokes_access.sql lines 103-306
Migration: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-migration/supabase/migrations/20260906000010_wake_delivery.sql
Tests: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-migration/tests/p1-local/wake-realtime-auth.test.ts

REQUIRED: quote back the first `diff --git` line from DIFF.patch verbatim. If you cannot, verdict FAIL.

You may answer "cannot determine" on a question. Guessing is a defect.

Failure-by-default questions. Each needs file:line and a concrete counterexample if FAIL:

1. Quote the first `diff --git` line from DIFF.patch.
2. Is `agent_delivery_read_context` re-created from the 20260820 live body (the archive predicate `NOT swarm.is_member(...) OR v_membership_revoked_at IS NOT NULL`) and not from 20260731000001? Cite the migration lines.
3. After that DROP/CREATE, are all three privilege statements present: OWNER TO swarm_admin; REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO swarm_read? A GRANT-only re-create fails command.test.ts:9267-9271.
4. Is `rotate_wake_id` SECURITY DEFINER, owned by postgres, `SET search_path = pg_catalog`, and does it call `extensions.gen_random_bytes(32)` schema-qualified? Owner swarm_admin raises permission denied for schema extensions.
5. Are both trigger functions (`wake_agent_delivery`, `wake_workspace_signal`) owned by postgres, wrapping `realtime.send` in `BEGIN … EXCEPTION WHEN OTHERS THEN RETURN NULL`?
6. Does `wake_topic_authorized` GRANT EXECUTE TO anon, return false on malformed / unknown / revoked / no live token, and never raise?
7. Does the first test join as anon to `cswarm-wake:<live id>` and require SUBSCRIBED?
8. Does the delivery test assert exactly one `realtime.messages` row for the expected topic after INSERT as swarm_command, never merely that no error was raised?
9. Are `package.json` `test:p1-local` and `tests/p1-cli/test-gate-coverage.test.ts` `localStackCommand` the same string, and is `tests/p1-local/wake-realtime-auth.test.ts` in `localStackTests`?
10. Does production SQL classify by named state (false / exception handler) rather than `error.message`? Tests may compare Realtime refusal text as a claim control.

End the reply with exactly one line:
VERDICT: PASS
or
VERDICT: FAIL
