I'll review this merge SHA as a read-only engineering check: first the design docs and exact tree, then producers, consumers, and evidence claims.The merge is at `0483eb9` on detached HEAD. Next I’ll map parents, compare product trees to `63acfdb`, and read the identity contract.Merge parents match. Next I’ll compare the product tree to `63acfdb` and check that later commits are docs-only.Product tree matches `63acfdb`. I’ll now read the session fence, migrations, and the docs that landed after that candidate.Product trees match. I’ll read the fence, migrations, and prior FAIL findings next.I’ll trace the fence, acquire path, and every mutation consumer in the command, activity, and client code.Exact SHA `0483eb997572ba42aad3ccc8474196bb745253b5` is a two-parent merge of `a6184a99a32255fe3b84aa68a555b3a3996c61dd` (main) and `dd2651b48e5304f9821e453fcf9c726a3d0225fd` (identity branch). Product trees `src`, `supabase/functions`, `supabase/migrations`, `tests`, `site/src`, and `package.json` match code candidate `63acfdb336a77fba884070849c8d83cc761855a5` bit-for-bit. Commits after `63acfdb` are `docs/` only. The merge itself added only `docs/org/2026-09-06-RESUME-HERE.md` from main.

## Defects

**1. Failed `session start` silences the hook on an unmanaged seat**

`src/cloud/session-cli.ts:212` writes the context file before acquire. On `session_not_managed`, `:227-229` rewrite `enforcement: "unmanaged"` and rethrow; the file stays. CLI `src/cli.ts:6755-6791` puts that file under the default sessions tree.

`src/listener/hook.ts:902-905` (`managedHookGate`): any readable file counts as “context on disk”. If none of those files has live proof (`generation < 1` or released), it returns `refuse` / `no_live_context`, not `legacy`.

Trigger: `cswarm session start` on a principal that is not enabled (the documented order is enable first; this is the easy wrong order). Also any acquire that fails before `generation >= 1`.

Outcome: leftover `generation: 0` JSON under `~/.config/cswarm/sessions/<workspace>/<principal>/`. The route-main listener still claims (no live proof). The hook prints nothing and does not observe (`hook.ts:1047-1050`). The local queue never drains. The unmanaged-hook test (`tests/p1-cli/hook-routing.test.ts:693-735`) never plants that leftover file, so it stays green.

Fix: delete the unacquired file on failed acquire (at least on `session_not_managed`). In `managedHookGate`, treat “no live proof” as `legacy` unless the server `managed_at` is set (or only refuse when a context has `enforcement === "enabled"`). Do not use “any file exists” as the managed bit.

**2. Members read omits `generation`; status advertises a server field that is always null**

`supabase/functions/read/index.ts:630-643` selects session columns for `resource: "members"` and never selects `s.generation`. `AGENT_EXECUTION_SESSION_READ_COLUMNS` in `src/cloud/session-wire.ts:63-77` includes `generation`. `parseServerSessionStatus` (`src/cloud/session-client.ts:355`) reads `match.generation`.

Trigger: `cswarm session status --json` against a live managed row.

Outcome: `status.server.generation` is always `null`. Committed live artifact `docs/evidence/2026-09-06-agent-identity/mini-live-control-63acfdb/step7-rerun.json:26-29` shows `"generation": null` after recover. The README next to it claims generation 3 in the server block; that number is from `db-rows.txt`, not from status. CLI tests inject `generation: 4` in a fake members body (`tests/p1-cli/session-lifecycle.test.ts:684-690`), so they do not see the missing column.

Fix: add `s.generation` to that SELECT. Pin a test on the read source (or a server test) so a missing column fails.

**3. Unmanaged claims can bind an unverified session UUID**

`supabase/functions/command/index.ts:8524-8525`:

```ts
managed: agent.managed_at != null,
session: sessionProofParse.ok ? sessionProofParse.proof : null,
```

`enforceAgentSessionProof` (`supabase/functions/_shared/agent-auth.ts:233-235`) returns ok for `managed_at === null` without checking headers. `claimAgentInbox` then writes `session_id` / `session_generation` (`durable-delivery.ts:357-358`) and later only reclaims rows whose session matches (`:330-337`).

Trigger: `claim_agent_inbox` for an unmanaged principal with well-formed `x-cswarm-session-*` headers (stolen/raw token, not the stock CLI).

Outcome: those delivery rows get a fake session bind. The real listener, which sends no proof, cannot reclaim after lease expiry. The ask sits until TTL, enable+acquire (which does reclaim), or a matching header set. ACK is safer: it only uses proof when `managed` is true (`index.ts:8648-8650`).

Fix: pass `session` only when `managed` is true. Ignore proof headers on the unmanaged path.

## Docs after `63acfdb`

Safe: `run-control.sh` now passes credential flags into `session status` (matches round-6 client). `env.py` only prints keys from stdin JSON; no secret is in git.

Not accurate: mini-control README says the server status block reported generation 3. `step7-rerun.json` shows `server.generation: null`. That is defect 2, not a docs-only product change.

## Checked and holding

- Fence runs for every agent command kind except `acquire_agent_session`, before side effects and before idempotent replay (`command/index.ts:7338-7365`, replay `:7733`).
- Acquire is the only exemption (`session-wire.ts:132-134`); inventory is derived from the dispatcher (`tests/protocol-workspace.test.ts:1708-1756`).
- Enable/disable/recover are human owner/admin, row-locked; acquire on unmanaged does not set `managed_at`; live leases block enable.
- Fence takes `FOR SHARE` on principal then session; recover/enable take `FOR UPDATE` in the same order.
- Acquire retry checks UUID, key digest, and `AGENT_SESSION_BINDING_FIELDS`.
- Retired UUIDs cannot acquire; expiry of the same UUID is `session_expired`.
- Activity uses the same fence. Read never claims/ACKs. Capability stays `swm_cap_` and does not claim/ACK.
- Managed ACK without `surfaced: true` is `delivery_not_surfaced`. Reclaim on acquire/release/recover/disable reopens queued-unsurfaced rows and does not bump `attempt_count`.
- Duplicate names: SQL unique name constraint dropped; default create still refuses under an advisory xact lock; `allow_duplicate_name: true` is explicit. CLI `--to` is UUID-first and refuses ambiguous names. Site labels are unique across raw names (`identity-label.ts:90-103`). Drafts use `resolveStoredIdentityRefs` and do not take the first match.
- Identity checks run before `openSession` / token renew (`session-cli.ts:117-141`). Custom context outside the default tree is refused before network (`cli.ts:6755-6766`).
- Receiver lock is beside the context; listen and `--foreground` take it. Detached parent records the child pid so the child can re-enter the same lock.
- Session import graph has no ACP/model modules; listen constructs `NullListenerModel`. `SESSION_MODES` is `["interactive"]` only.
- `swarm_read.agent_execution_sessions` is membership-gated and principal-scoped for role `swarm_read`; `key_hash` is not projected. `swarm_read.agent_principals` lists columns and omits `wake_id`.
- New tests sit in real gates: `test:p1-cli` glob, `test:p1-server` glob, `npm test` (`protocol-workspace.test.ts`), site `src/lib/*.test.mjs` and observer tests.
- `hook.ts` vs main is additive identity gating; `arrival-watch.ts` is unchanged.
- Proof headers are outside the command body/hash. Key is hashed server-side; conflict/status/read paths do not return it.

Not established here: `npm test` / `test:p1-server` on this SHA, production apply of `20260906000020`/`000030`/`000040`, renewal under load, Codex same-chat injection.

VERDICT: FAIL — leftover unacquired session files make the hook refuse unmanaged asks; members read drops `generation` so status.server.generation is always null; unmanaged claims can bind unverified session headers.
