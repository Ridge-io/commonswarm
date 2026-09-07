I'll review the agent-identity candidate against the spec contract, starting with the spec, lanes, and the checkout itself.SHA matches. Next I’ll read the spec contract, lane docs, and evidence claims, then check the code against them.I'll join the swarm under a unique review-arm name, then split the spec attacks across the server, client, and UI code.Evidence is claims, not proof. I'll inventory the migrations and fence code, then attack each spec question in parallel.I'll spawn parallel read-only probes on the fence, stale-ACK, interactive ACP, names, idle turns, and migration, while I read the core sources.I'll read the identity spec and hunt the acquire/recoverI'll start/hook with/ACK paths for the spec and the stale- commandsession/ theftedge. mutation paths, then inventory every kind that can change agent session state.I'll inventory name-based lookups, idle timers, and the two migrations in parallel, then check whether interactive mode can still reach ACP/model factories.I'll read the command fence, acquire/enable, delivery ACK, and hook paths myself while the probes run.Next I’ll open the session SQL, proof fence, and hook observe paths.Next I’ll read the exemption constant, command-edge fence, and every dispatcher that can mutate agent state.Next I’ll read the recipient resolvers, identity labels, and both session migrations, plus every name-based lookup path.I’ll read the server acquire/recover/ACK fence and the hook observe gate next.The fence’s live/expiry check looks inverted; I’ll read the migration and the command-edge apply order next.Attack: every agent mutation path when `managed_at` is set. SHA `1895889b`. Read-only.

## 1. Exemption set

**SAFE.** `AGENT_SESSION_PROOF_EXEMPT_KINDS` is only `acquire_agent_session`.

```104:116:src/cloud/session-wire.ts
export const AGENT_SESSION_PROOF_EXEMPT_KINDS = [
  "acquire_agent_session",
] as const;
...
export function isAgentSessionProofExempt(kind: string): boolean {
  return EXEMPT_KIND_SET.has(kind);
}
```

Membership test pins that list and names the usual suspects as not exempt:

```1579:1586:tests/protocol-workspace.test.ts
    assert.deepEqual([...AGENT_SESSION_PROOF_EXEMPT_KINDS], [
      'acquire_agent_session',
    ]);
    assert.equal(isAgentSessionProofExempt('acquire_agent_session'), true);
    assert.equal(isAgentSessionProofExempt('post_signal'), false);
    assert.equal(isAgentSessionProofExempt('renew_agent_session'), false);
    assert.equal(isAgentSessionProofExempt('claim_agent_inbox'), false);
```

`renew_agent_session`, `release_agent_session`, `claim_agent_inbox`, `ack_agent_delivery`, `signals_seen`, `renew_agent_token` are not in the set.

## 2. Command fence vs side effects and replay

**SAFE.** Fence runs after agent auth, before route, handlers, rate limits, and idempotency replay.

```7338:7364:supabase/functions/command/index.ts
    if (
      auth.credentialKind === "agent" &&
      !isAgentSessionProofExempt(kind)
    ) {
      ...
      const sessionResult = await enforceAgentSessionProof(tx, {
        principalId,
        workspaceId: agent.principal_workspace_id,
        proofParse: sessionProofParse,
        managedAt: agent.managed_at ?? null,
      });
      if (!sessionResult.ok) {
        ...
        return {
          status: sessionResult.status,
          body: { error: sessionResult.error },
        };
      }
    }
```

Replay is later (`existingRows` at 7717, `replayResult` at 7815). Old proof never reaches the stored body. Current holder can retry the same `command_id` (`tests/p1-server/agent-execution-sessions.test.ts:430-478`).

`acquire_agent_session` skips this fence and does its own lock (`9982-10164`).

**NIT.** `loadAgentCredential` stamps `first_used_at` during auth, before the fence (`agent-auth.ts:52-129`, `command/index.ts:7323-7324`). That is credential bookkeeping, not command replay. A rejected write still counts as token first use.

## 3. Command kinds and fail-closed

Dispatched agent mutations (not human-only / human pre-route):

`create`, `acquire` (task), `renew` (task), `handoff`, `takeover`, `submit`, `close`, `reopen`, `declare_agent_model`, `submit_feedback`, `revoke_agent_token`, `renew_agent_token`, `post_signal`, `channel_create|rename|archive`, `signals_seen`, `claim_agent_inbox`, `ack_agent_delivery`, `file_version_create|commit`, `file_download_url`, `file_tombstone`, `file_restore`, `acquire_agent_session`, `renew_agent_session`, `release_agent_session`.

Inventory test fails on extra kinds (`protocol-workspace.test.ts:1602-1673`). New kinds are fenced unless added to the exemption set. Adding them there fails the exact-membership test.

Human-only (reducer + pre-route): `enable_agent_management`, `disable_agent_management`, `recover_agent_session` are in `HUMAN_ONLY_COMMANDS` (`workspace-commands.ts:377-392`). Edge handlers also require a human owner/admin:

```9793:9794:supabase/functions/command/index.ts
  if (auth.credentialKind !== "user" || auth.actor.user === null) {
    return { ok: false, result: { status: 403, body: { error: "forbidden" } } };
```

Human JWT + session headers does not become an agent. Fence only runs when `credentialKind === "agent"` (`command/index.ts:7338-7340`). Proof cannot impersonate.

Human pre-route (`register_device`, `create_workspace`, mint/revoke capability, `resume_renewal_grant`) still hits the fence if the caller is a managed agent, then refuses the agent credential (`4510`, `4656`, `5351`, `5988`).

**NIT.** The kind extractor’s pre-route regex is a fixed list (`protocol-workspace.test.ts:1571-1573`). A new pre-route `kind === "..."` is still fenced by default. It is not auto-inventoried until someone extends that regex.

## 4. Delivery claim / ACK

**SAFE.**

- Bound at claim from verified proof, not the body (`durable-delivery.ts:197-198, 357-358`; `command/index.ts:8524-8525`).
- Managed queued + unsurfaced stays pending (`durable-delivery.ts:235-262, 423-429`).
- Observed without `surfaced: true` → `delivery_not_surfaced` 409 (`durable-delivery.ts:699-700`; `command/index.ts:9696-9701`).
- Stale generation on a live session → fence `session_conflict` 409 (`agent-auth.ts:262-263`; `tests/p1-server/managed-delivery.test.ts:355-366`).
- ACK row bound to another session/generation → `session_conflict` 409 (`durable-delivery.ts:722-728, 759-766`).

## 5. Token renewal

**SAFE.** `renew_agent_token` is a command kind, not exempt, so the fence runs first. No other HTTP agent-token refresh exists. Clients only post `/functions/v1/command` and `/functions/v1/activity`. `resume_renewal_grant` is human-only (`command/index.ts:5988`). Read’s `record_renewal_grant_use` only updates `last_used_at` on the grant; it does not mint a token or change session state.

## 6. Activity

**SAFE.** Same fence, before `realtime.send`:

```127:138:supabase/functions/activity/index.ts
    /* Activity is an agent mutation: it broadcasts in the principal's name.
     * When the principal is managed, the same session proof the command fence
     * requires applies here. ... */
    const sessionResult = await enforceAgentSessionProof(tx, {
      principalId: agent.principal_id,
      workspaceId: agent.principal_workspace_id,
      proofParse: parseAgentSessionProofHeaders(request.headers),
      managedAt: agent.managed_at ?? null,
    });
```

## 7. Capability

**SAFE.** Only `swm_cap_` tokens. Writes are rate buckets, audit, alerts. No claim, ACK, or session mutate (`capability/index.ts:45, 427-517, 748-760`).

## 8. Read

**SAFE.** Role is `swarm_read` (`read/index.ts:420`). No `claimAgentInbox` / `ackAgentDelivery` / `SET LOCAL ROLE swarm_command` (`protocol-workspace.test.ts:1701-1708`). Members query is SELECT of session metadata, not `key_hash` (`read/index.ts:627-640`). First-use stamp and grant `last_used_at` are not claim/ACK/session writes. Spec allows reads during recovery.

## 9. `acquire_agent_session` opt-in

**SAFE.** Does not set `managed_at`. Unmanaged → `session_not_managed` 403:

```10043:10050:supabase/functions/command/index.ts
  const managed = await tx<{ managed_at: Date | null }[]>`
    SELECT managed_at
    FROM swarm.agent_principals
    WHERE principal_id = ${principalId}::uuid
  `;
  if (managed[0] === undefined || managed[0].managed_at === null) {
    return sessionError("session_not_managed");
  }
```

`session start` only calls `acquire`. On `session_not_managed` it writes local `enforcement: "unmanaged"` and rethrows. It does not call enable (`session-cli.ts:170-182`). Status is local file read (`session-cli.ts:215-226`). Enable is `cswarm session enable` with a human credential (`cli.ts:6580-6600`).

## 10. Enable / disable / recover

**SAFE.**

- Enable: human owner/admin, refuses live leases, sets `managed_at` (`9830-9854`).
- Disable: retires UUID, bumps generation, clears key, then `managed_at = NULL` (`9914-9932`). Warning: `legacy writes resume` (`9939`).
- Recover: requires managed, bumps generation, new UUID, clears key, expires, does **not** clear `managed_at` (`9955-9978`).
- Agent cannot disable: `lockHumanManagedPrincipal` 403 (`9793-9794`). Disable is not proof-exempt, so a managed agent without human JWT never reaches the clearer.

---

## DEFECT / GAP / NIT

**DEFECT:** none.

**GAP:** none on this fence. Every agent write on command/activity is fenced when `managed_at` is set, except `acquire_agent_session`, which does its own lock and will not opt in.

**NIT:**
1. Token first-use stamp runs before the fence (`agent-auth.ts:71-79` then `command/index.ts:7338`).
2. Kind inventory regex will not see a new pre-route `kind === "..."` until someone edits the regex (`protocol-workspace.test.ts:1571-1573`). Enforcement still fail-closes.
3. `authenticateAgentSession` is unused and ignores `_isAcquire` (`agent-auth.ts:276-294`).
4. No server test that an agent `disable_agent_management` returns 403. The handler does.

**ANY DEFECT or GAP on this attack surface?** No.

**VERDICT: PASS**Commit `1895889b`. Read-only. Inventory below.

## A) Duplicate names

Name-based lookups found:

| Surface | File | Policy |
|---|---|---|
| CLI `--to` | `src/cloud/signals.ts:1414` | UUID first; exact name only if unique across members+agents |
| Workspace member | `src/cloud/workspaces.ts:47` | exact name; refuse if >1 |
| Mentions | `site/src/lib/mention-address.ts:165` | fold; shared name-only refused; labels from combined roster |
| Drafts | `LiveDashboard.astro:2823`, `identity-label.ts:159` | stored `{kind,id}`; name-only only if unique |
| Replies | `composer-address.ts:76` | reply sends empty `to` (no name lookup) |
| Picker | `LiveDashboard.astro:3599` | click is UUID; body gets `entityName` (combined roster) |
| AgentConnect | `AgentConnect.astro:496` | `<option value>` is principal UUID |
| accept | `accept-link.ts:635` | reuse only if exactly one live owned row |
| create | `command/index.ts:6336` | refuse unless `allow_duplicate_name === true` |
| Listen contexts | `cli.ts:5712` | >1 live context refused |

**DEFECT** `site/src/lib/participant-rail.ts:90` and `:106`  
Rail builds labels from **agents only**. Members stay raw (`:150`). Spec: generated labels unique across **all** raw names and generated labels (`identity-label.ts:4`, Echo · 11111111).

Composer/mentions use the combined roster (`LiveDashboard.astro:2709`, `mention-address.ts:79`).

Attack: two agents named Echo (UUID `11111111-…`), one member named `Echo · 11111111`.

- Rail shows the agent as `Echo · 11111111` (member name not in `taken`).
- Picker/parser suffix the agent further.
- Typing the rail label `@Echo · 11111111` addresses the **member**, not the agent (`mention-address.ts:192`).

That is wrong routing, not display-only.

**GAP** `LiveDashboard.astro:4047` and `:4084`  
Dialog roster uses `identityRoster().agents` only. Same label split. Rows keep `data-agent-row` UUIDs, so this is not a send path.

**GAP** `AgentConnect.astro:496`  
Connect list is agents-only. Values are UUIDs. Duplicate-with-member labels can disagree with the dashboard.

**NIT** `src/cloud/signals.ts:1440`  
CLI `--to` is exact (`===`), not `foldIdentityName`. Spec §2 asked to keep exact CLI names. Site folds. `Echo` / `echo` can both exist without `allow_duplicate_name` (`command/index.ts:6341`) and CLI will unique-match one while `@Echo` is ambiguous.

Not first-match: `lookupByDisplayName` (`identity-label.ts:128`), `resolveSignalRecipient` (`signals.ts:1453`), `livePrincipalByName` (`accept-link.ts:656`), drafts (`identity-label.ts:188`).

---

## B) Idle model turns

**No DEFECT.** Idle paths do not call a model.

- Listen `newModel` is `NullListenerModel` (`cli.ts:5927`). Runtime never calls `model.start` on ready (`tests/listener-main-only.test.ts:236`). Claimed mail goes to `routeSignalToMain` (`runtime.ts:1576`), not `model.prompt`.
- Empty inbox: `idle_poll` then sleep (`runtime.ts:1459-1489`). No prompt.
- Session renew: HTTP `client.renew` on a timer (`session-manager.ts:125-147`). Spec: timers do not invoke a model.
- Activity heartbeat publishes a frame (`activity.ts:285`). No prompt.
- Interactive receiver: claim / inject / ACK (`session-receiver.ts:153`). Sleep is `AGENT_SESSION_RENEW_AFTER_MS` (`:244`). No ACP import in `session-receiver.ts`, `session-cli.ts`, `session-manager.ts`.
- Codex: no `schedule` in `src/host/codex.ts` or `src/host/session.ts`. Listen never constructs `CodexListenerModel` (only tests do). No default schedule.

**GAP** `src/cli.ts:258` and `:270`  
`session start` lives in the same file that statically imports `./host/opencode.js`, `./host/claude.js`, `./host/codex.js`, and `./listener/index.js` (re-exports all four `*ListenerModel` factories). Not lazy. `session-interactive-nospawn.test.ts:36` only scans `session-receiver.ts` and `session-cli.ts`. Process load ≠ invocation. `startManagedSession` does not call a factory (`session-cli.ts:106`).

**NIT** `src/listener/engine.ts:519`  
`ListenerEngine.prompt` still exists. Runtime does not construct it.

---

## C) Migrations `20260906000020` and `20260906000030`

`000020` `agent_principals` view (`:300-318`): enumerated columns, not `SELECT p.*`, no `wake_id`, has `managed_at`. `OWNER TO swarm_admin`. `GRANT SELECT` to `authenticated, swarm_read`. DO block refuses `wake_id`.

`agent_delivery_read_context` (`000020:91-298`): dropped and recreated with `wake_id` + `managed_at`. `OWNER swarm_admin`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO swarm_read`. `000030` does not recreate it.

`000030` does **not** recreate `swarm_read.agent_principals` with `p.*`. It `REVOKE ALL … FROM anon` (`:99`). No later migration.

`swarm_read.agent_execution_sessions` (`000030:70-88`): no `key_hash`. DO block refuses `swarm_read` SELECT on `key_hash` (`:130`). Anon SELECT on `agent_principals` revoked (`:160`).

**DEFECT** `supabase/migrations/20260906000030_managed_delivery_session.sql:71`  
View is `SELECT … FROM swarm.agent_execution_sessions` with **no** `swarm.is_member(...)`. Sibling `agent_principals` has that gate (`000020:315`).

`GRANT SELECT … TO authenticated, swarm_read` (`:91`). PostgREST exposes `swarm_read` (`supabase/config.toml:13`). View owner is `swarm_admin`; RLS on the table is `USING (true)` for `swarm_admin` (`000020:51`). Any signed-in user can read every workspace’s `session_id`, `generation`, `host_session_ref`, `provider`. `key_hash` is omitted; host conversation ids are not.

**NIT** `000020:318`  
Skipped `REVOKE ALL FROM anon` on `agent_principals`. Sibling views revoke in the same file. `000030:99` closed it. Final state: anon cannot SELECT.

---

## Interactive ACP / factory

| Module | Host / model import? |
|---|---|
| `session-receiver.ts` | no |
| `session-cli.ts` | no |
| `session-manager.ts` | no |
| `cli.ts` listen `newModel` | `NullListenerModel` only |
| `cli.ts` session start | no call; **does** evaluate host modules at load |

`registerHostInjection` is a callback the host registers; CLI`sessionManager.start()` is at line 5783 — I’ll read that block before judging item 9. does not build an ACP child (`session-receiver.ts:45`).

---

## Verdict

**ANY DEFECT or GAP: YES.**

**VERDICT: FAIL**

Two defects:

1. Rail labels use an agents-only roster, so an Echo · 11111111 rail label can address a member in the composer.
2. `swarm_read.agent_execution_sessions` is granted to `authenticated` with no membership gate.D-036 arm, SHA `1895889b`. Attack: can a resumed old process or a stale hook steal a session or ACK a delivery?

## 1. Acquire
No steal on the next acquire.

- Retired UUID: `retired_agent_sessions` is checked first (`supabase/functions/command/index.ts:10051-10057`). Test: `tests/p1-server/agent-execution-sessions.test.ts:380`.
- Same UUID+key retry: only if `live` and same binding (`10086-10130`). Else `session_proof_invalid` / `session_conflict`.
- Different live UUID: `session_conflict` (`10132-10133`).
- Same UUID after expiry, not yet retired: `session_expired` (`10135-10136`), not a silent reacquire.

**NIT** `10088-10092`: acquire retry uses `Array.every` for the key digest. The fence uses constant-time `bytesEqual` (`supabase/functions/_shared/agent-auth.ts:181-187`).

## 2. After recover / release / expiry
Next request is fenced. Overlapping in-flight request is not.

Fence checks live + UUID + generation + key (`agent-auth.ts:255-273`). Sequential stale write after recover is `session_expired` (`tests/p1-server/agent-execution-sessions.test.ts:420-424`). Old-proof command replay is `session_conflict` (`430-468`).

**DEFECT** `agent-auth.ts:231-241`: `enforceAgentSessionProof` is a plain `SELECT`. No `FOR UPDATE`. Isolation is `READ COMMITTED` (`command/index.ts:1397`). Acquire/recover/release do lock the session row (`10080`, `9962`, `10243`). A mutation that already passed the fence can finish after recover has bumped generation.

Claim then stamps the in-memory proof onto the row and does not re-check liveness (`durable-delivery.ts:357-358`). ACK of `observed` can commit while recover is waiting on the delivery row, then reclaim skips `ack_outcome = 'observed'` (`command/index.ts:9760-9765`). That is a stale ACK across recover.

Release/expiry on the *next* call: `live` is false → `session_expired`; `key_hash` is NULL; UUID is retired on release.

## 3. Hook observe (`src/listener/hook.ts`)
Stale hook cannot ACK after recover on the next call. Several local gates are real.

- Two live contexts: refuse (`908-909`).
- No live context: no observe write (`907-909`). Zero files: legacy path, no proof; server fence rejects a managed principal (`7338-7364`).
- Host id is not invented. Stdin only (`cli.ts:7097-7130`, `7160-7165`). Missing/TTY/bad JSON → `null`. `hostIdentityTrusted` is `options.hostSessionId !== undefined` (`hook.ts:917`).
- Bound conversation is required (`session-ack.ts:63-68` vs `context.host_session_id`).

**GAP** `hook.ts:912-915` and `1080-1098`: `injectionSucceeded: true` is hardcoded after stdout. High-water `commit` runs for every unseen id *before* observe, and is not keyed by `host_session_id` or execution UUID (`hook.ts:305-313`, `375+`). A hook in the wrong chat can print, advance `hook-surface.json`, fail ACK on host mismatch, and the bound chat will not print again.

After recover, a leftover context file still looks live (`sessionProofOf` only dies on `released_at` / bad key, `session-context.ts:409-419`). Two files → hook ACKs nothing. Availability hole, not ACK theft.

## 4. Lost ACK after injection
At-least-once ACK retry is honest for the *matching* host: reprint is suppressed, observe is retried (`hook.ts:1090-1103`). Do not claim exactly-once.

Bare queued-to-observed is refused when managed and `surfaced !== true` (`durable-delivery.ts:699-700`; test `managed-delivery.test.ts:368`).

**GAP** same high-water as §3: lost ACK after injection into the *wrong* chat is not re-delivered into the bound chat.

**GAP** `durable-delivery.ts:699-728`: server trusts client `surfaced`. It does not check `host_session_ref`. Current proof + `surfaced: true` ACKs without proving injection. Stale proof still dies at the fence.

## 5. Recovery reclaim
Same transaction as acquire/recover/release (`10156`, `9978`, `10263`). `attempt_count` is not touched (`9728-9734`). Reclaim of queued unsurfaced rows is tested (`managed-delivery.test.ts:509-570`).

Next-request old hook ACK of a reclaimed row: `session_id` is NULL → `session_conflict` (`durable-delivery.ts:722-728`), and the fence already failed.

**DEFECT** same as §2: in-flight observed ACK can win the delivery-row lock before reclaim.

## 6. Local session file
Release writes `released_at`, `session_key: ""` (`session-context.ts:397-406`). `sessionProofOf` is then null (`409-412`). Status omits the key (`session-cli.ts:223`).

A restarted process cannot use that file as live proof. `session start` on a released path writes a *new* UUID and must acquire again (`session-cli.ts:145-154`). Old UUID is retired on the server.

Crash without `session stop`: file still has the key. If the server session is still live, that *is* the holder. After recover/expiry/release, writes fail. Not a reuse of a retired UUID.

**NIT** `session-cli.ts:263-268`: lost release response leaves the local key in place (`state: "stopping"`). Server already retired → no steal; `listen start` can see a fake “live” file.

## 7. `listen start` with two live contexts
Refused (`cli.ts:5712-5718`). Does not pick the first file.

## 8. Proof headers
Key is headers only, not URL/body (`session-client.ts:67-90`, `142-156`; `session-proof.ts:113-125`). Logs redact (`session-proof.ts:70-107`, `session-client.ts:94-101`). Conflict body is `{ error }` only (`command/index.ts:9671-9672`). Status has public UUID+generation, not the key (`session-cli.ts:223`, `session-context.ts:435-457`).

Public UUID+generation cannot write: parse requires the key (`session-wire.ts:164-185`). Wrong/missing key → `session_proof_invalid`.

## 9. Network failure vs local expiry
`sessionManager.start()` runs (`cli.ts:5783`). Renew fail or local age ≥ 120s calls `stopDispatch` (`session-manager.ts:138-153`), which aborts the claim loop (`cli.ts:5741-5743`, `6050`).

That is before the 120s safety TTL (timer is 40s).

**NIT** listener never calls `noteSuccessfulWrite` (only `session-receiver.ts:182`). Claim transport fail does not stop dispatch until the next renew. Still before 120s. Not a steal.

## 10. Listener starting a model
No. `newModel` is `NullListenerModel` (`cli.ts:5927-5930`). `start()`/`prompt()` throw (`runtime.ts:165-177`). Runtime never calls `.prompt`. Live route is only `main` (`main-routing.ts:36`, `cli.ts:2731-2733`). Worker/split refused.

Attendance is required unless `--allow-unattended` (`cli.ts:6133-6144`). That flag is an operator bypass; the listener still does not start a model. It can still *claim* and ACK `queued`.

## 11. Interactive vs listener
`SESSION_MODES` is only `interactive` (`session-contract.ts:28-29`). `session-receiver.ts` has no ACP/host import. Default `session start` only acquires (`session-cli.ts:190-191`, `329-333`). `--foreground` claims only with a registered callback; CLI does not set `hostIdentityTrusted` (`session-cli.ts:208`, `session-receiver.ts:174-178`). Listener uses `NullListenerModel`, not ACP.

## 12. Notify / follow
`inbox --notify` reads pages and prints. Comment and code: no claim/ACK (`cli.ts:4060-4063`, `4108-1141`). `arrival-watch.ts` has no `claimAgentInbox`.

`signals_seen` from notify has no session proof. On a managed seat the fence rejects it. Fail-closed, not a parallel claim loop.

---

## Steal, in one line

| Path | Steal session? | Steal ACK? |
|---|---|---|
| Next request after recover/release/expiry | No | No |
| Stale hook after recover (next observe) | No | No |
| Two live context files | No (refused) | No |
| Public UUID+generation | No | No |
| In-flight mutation/ACK overlapping recover | Yes (race) | Yes (race) |
| Wrong-host hook | No | No (ACK refused); can hide the ask locally |

**ANY DEFECT:** yes (`agent-auth.ts:231-241` missing session row lock; in-flight ACK/write after recover).  
**ANY GAP:** yes (hook high-water not bound to host/execution UUID, `hook.ts:1080-1098`; server ACK trusts `surfaced`, `durable-delivery.ts:699-728`).

Sequential resume of an old process or stale hook cannot take the session or ACK a delivery. The fence is not serialized, so an in-flight request can.