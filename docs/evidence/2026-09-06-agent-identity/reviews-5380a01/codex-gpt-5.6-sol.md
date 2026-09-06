FAIL. I found six defects at `5380a0152c280c40232ec7e5748e97d3c33e324a`.

1. DEFECT — stale writes can commit after enable or recovery.

   [agent-auth.ts:221](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/b2c3f04f-2b41-48d4-b638-f1bfc65f3d08/scratchpad/arm-identity-int/supabase/functions/_shared/agent-auth.ts:221) skips unmanaged checks without a lock. Its managed-session query at line 225 also has no `FOR UPDATE`. Command and activity side effects occur later. A stale request can pass, recovery or enable can commit, and then the stale request can write. This breaks immediate invalidation.

2. DEFECT — acquire retry ignores the immutable host binding.

   [command/index.ts:9980](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/b2c3f04f-2b41-48d4-b638-f1bfc65f3d08/scratchpad/arm-identity-int/supabase/functions/command/index.ts:9980) does not load `provider`, `host_label`, or `host_session_ref`. The retry branch at line 10000 checks only UUID and key. The same session can retry with different binding data and still get success.

3. DEFECT — interactive start still depends on ACP files.

   [cli.ts:6041](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/b2c3f04f-2b41-48d4-b638-f1bfc65f3d08/scratchpad/arm-identity-int/src/cli.ts:6041) resolves OpenCode, Claude, or Codex ACP executables. Missing Claude or Codex ACP makes start fail at lines 5475–5521. [listener/index.ts:4](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/b2c3f04f-2b41-48d4-b638-f1bfc65f3d08/scratchpad/arm-identity-int/src/listener/index.ts:4) also exports every provider model through the CLI import path. The runtime uses `NullListenerModel`, so I found no idle model turns, but interactive start is not free of the ACP path.

4. DEFECT — a UUID-backed picker choice can route to another principal.

   [identity-label.ts:58](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/b2c3f04f-2b41-48d4-b638-f1bfc65f3d08/scratchpad/arm-identity-int/site/src/lib/identity-label.ts:58) checks only duplicate raw names. It does not check generated labels against other raw names. I measured two distinct records both rendering as `Echo · 11111111`. [selectMention at LiveDashboard.astro:3616](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/b2c3f04f-2b41-48d4-b638-f1bfc65f3d08/scratchpad/arm-identity-int/site/src/components/app/LiveDashboard.astro:3616) writes that label back into text. [mention-address.ts:156](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/b2c3f04f-2b41-48d4-b638-f1bfc65f3d08/scratchpad/arm-identity-int/site/src/lib/mention-address.ts:156) then takes the first label match. Selecting one UUID can address the other.

5. DEFECT — session status says an unmanaged agent is live.

   [read/index.ts:626](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/b2c3f04f-2b41-48d4-b638-f1bfc65f3d08/scratchpad/arm-identity-int/supabase/functions/read/index.ts:626) uses a `LEFT JOIN`, then line 640 treats `s.expired_at IS NULL` as live. With no session row, every `s` field is null, so `is_live` is incorrectly `true`.

6. DEFECT — the claimed fail-closed route test is not fail-closed.

   [protocol-workspace.test.ts:1565](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/b2c3f04f-2b41-48d4-b638-f1bfc65f3d08/scratchpad/arm-identity-int/tests/protocol-workspace.test.ts:1565) recognizes direct handlers through a fixed list of names. A new direct mutation outside that list is invisible. This makes the claim in `server.md:31-33` false.

Verified good:

- All current command mutations pass the common fence; only acquire is exempt.
- Activity uses the fence. Read and capability cannot claim, ACK, or change session state.
- Migration grants exist. `managed_at` is projected. `wake_id` is not in `swarm_read.agent_principals`.
- Duplicate-name SQL uses an advisory transaction lock. CLI `--to` refuses ambiguous names.
- Existing server tests that claim typed errors assert `body.error`.
- Focused tests: root 59/59 passed; site identity tests 26/26 passed.
- I did not establish the database server gate. The evidence records its full gate as 156 pass and 10 fail.
- No files changed.

QUOTE-BACK: # Agent UUIDs and one active execution session
VERDICT: FAIL
REASON: The proof fence races lifecycle changes, retries ignore host binding, interactive start still depends on ACP, labels can misroute UUID choices, read status is false, and the route control is not fail-closed.
