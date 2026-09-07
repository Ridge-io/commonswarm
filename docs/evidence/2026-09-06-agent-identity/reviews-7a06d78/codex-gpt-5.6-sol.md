Reviewed exact SHA `7a06d78df7e33087f3d39c0ac37243bd246ed3ad`.

Findings:

1. **DEFECT — busy receivers can lose their session.**  
   `session-manager.ts:76-80` treats any successful write as lease renewal and restarts the 40-second timer. Claims call it at `session-receiver.ts:180-182`, but claims do not extend the server lease. Frequent claims can postpone `renew_agent_session` past the 120-second expiry.

2. **DEFECT — session metadata leaks across workspaces.**  
   `20260906000030_managed_delivery_session.sql:70-91` grants authenticated users a view of every execution-session row. The view has no `swarm.is_member(...)` filter and is owned by the table owner. `security_barrier` does not add access control. `key_hash` is hidden, but workspace, principal, host, provider, session UUID, and timing data leak.

3. **DEFECT — identity conflicts are checked after a possible mutation.**  
   `cli.ts:2567-2578` opens the credential session and can renew the token. Only afterward do `cli.ts:2589-2606` reject context, target, principal, workspace, or token-file conflicts. This breaks the required “reject before ANY mutation” rule.

4. **DEFECT — acquire retry silently ignores binding flags.**  
   `session-cli.ts:130-154` replaces the requested draft with an existing unacquired context. `assertSameIdentity` at `session-cli.ts:155-162` does not compare provider, mode, host label, or token file. A retry can accept different CLI flags, then acquire using the old values.

5. **DEFECT — `session status` reports local belief as server truth.**  
   `session-cli.ts:215-226` reads only the context file. `session-context.ts:422-456` reports `running` whenever private proof remains. After expiry or human recovery, status can still say running and enabled.

6. **DEFECT — custom contexts are invisible to the listener.**  
   `cli.ts:6661-6705` accepts `session start --session-context`. The listener searches only the default root at `cli.ts:5712-5713` and rebuilds a default path at `cli.ts:5735-5739`. A managed session stored elsewhere cannot bind listener writes.

7. **DEFECT — malformed success responses become generation 1.**  
   `session-client.ts:122-130` defaults a missing or invalid `generation` to `1`. It must reject the malformed response before writing an active context.

8. **GAP — one receiver is not enforced.**  
   `session start --foreground` can run a claim loop while `listen start` reads and uses the same proof. The listener counts context files, not active receiver processes. Two receivers can therefore compete under one execution session.

9. **GAP — the strict no-ACP-import contract is not met.**  
   The operational resolver defect is fixed for normal interactive start. However, `cli.ts:259-265` still imports ACP host modules, and `listener/index.ts:4-7` re-exports every model module into the CLI import graph. There is no model invocation, but the specified import-path separation is absent.

Prior six findings:

- Fence race: fixed at `agent-auth.ts:223-251`.
- Immutable acquire binding: fixed at `command/index.ts:10060-10110`.
- ACP resolution: operational failure fixed; strict import-path requirement remains.
- Generated label collision: fixed at `identity-label.ts:65-103`.
- Null session marked live: fixed at `read/index.ts:626-648`.
- Route inventory: fixed at `protocol-workspace.test.ts:1590-1755`; its mutation control now detects a new direct handler.

Other checks:

- All current agent command mutations use the common fence at `command/index.ts:7338-7365`. Acquire is the sole exemption.
- Activity uses the same fence at `activity/index.ts:127-138`.
- Delivery claim, ACK, token renewal, and agent capability commands reach the command fence.
- The capability edge is anonymous read/accounting and cannot claim, ACK, or change a session.
- Stale hooks and replaced sessions cannot ACK: the hook binds proof and host identity at `hook.ts:897-920`; the server checks current proof.
- Duplicate-name routing is UUID-backed and ambiguous name lookup refuses.
- Runtime constructs only `NullListenerModel` at `cli.ts:5927-5930`. I found no prompt/start call and no idle model turns.
- `swarm_read.agent_principals` enumerates columns, omits `wake_id`, applies membership, and has its grant at migration lines 300-318.
- Pure mutation-inventory gate: 62/62 passed.
- Session tests: 19 passed; 25 could not run because this read-only environment refused `mkdtemp`. No database or live control was established.
- No files changed.

QUOTE-BACK: # Agent UUIDs and one active execution session
VERDICT: FAIL
REASON: The candidate can expire an active receiver, leaks session metadata, mutates before identity checks, reports stale status, loses custom bindings, and does not enforce one receiver or the no-ACP-import contract.
