# Lane C: managed client (identity)

Branch: `lane/identity-client`, rebased 2026-09-06 onto `lane/agent-identity` 5380a015
(= main e6e49929, cswarm 0.1.61, + Lane A + Lane B). Owner after the rebase: CSLaptopLead.
Builder of the original lane and its fix round: Grok (on the mini). Wire contract:
`src/cloud/session-wire.ts` (not edited).

Code SHA: `2534e38ca3e86d6ccb4bdaa374e2d44121fd8c87` (the worker removal, on top of the 13
replayed lane commits). Final SHA: the docs-only commit that records this file; run
`git log -1 --format=%H -- docs/evidence/2026-09-06-agent-identity/client.md` on the branch.

Earlier pins, kept for readers who meet them: `cb00d64` (never existed), `a90d395b` (the first
implementation commit, pre-rebase), `619138d4` and `5e2bd0a3` (the pre-rebase fix round; that
history is on the mini and in `lane/identity-client-pre-rebase` on the laptop, not on origin).

## Section 10 supersession (cswarm 0.1.61): what this lane no longer contains

The listener never starts a model and `--route main` is the only route. The worker pieces were
DELETED, not reconciled, in commit `2534e38c`:

- `src/listener/session-binding.ts` (listener binding file, `boundAdapterEnv`, `workerToolEnv`,
  `reviewChildEnv`) and `tests/p1-cli/session-worker-binding.test.ts`.
- `listen start --session-context`, the runtime `sessionBinding` / `sessionDispatch` /
  `onSessionLeaseLost` options, the runtime managed ACK, and the lease-loss-stops-the-worker
  path with `tests/p1-cli/session-lease-loss.test.ts` and the two runtime ACK tests.
- `engine.ts` worker prompt identity and `ListenerSessionIdentity`.
- `SESSION_MODES` is now `["interactive"]`; `session start --mode` usage is generated from it;
  the worker start copy is gone.

Kept: proof on every agent write (`session-bound-writes.test.ts`); `session start|status|stop`
interactive with zero model/ACP path (`session-interactive-nospawn.test.ts`); ACK gated on
current proof + host injection in the interactive receiver (`session-ack-gate.test.ts`,
`session-receiver.test.ts`); human enable/disable/recover; `accept` and `principal create`
`--allow-duplicate-name` (Lane B's options seam is the one that landed); redaction; the
released-context fix (`session-lifecycle.test.ts`).

Changed: the hook observe gate (G2) no longer reads a listener-written binding. It lists the
session contexts saved on disk for the stored workspace/principal (`listSessionContexts` in
`session-context.ts`): no context is the legacy path and the server fences a managed principal;
exactly one live context supplies the proof; a released-only or ambiguous (two live) set refuses
before any write. `hook-routing.test.ts` drives all three cases. Not established: a hook on a
managed principal with NO local context is refused only by the server, not locally.

`session_leases_live` (added to the wire by Lane A's fix-up) was missing from the client
message table; the table is `satisfies Record<AgentSessionErrorCode, string>` so it cannot
drift again.

## Gates

Measured by CSLaptopLead on the laptop at code SHA `2534e38c` (logs in `laptop-rebase-2534e38c/`):

| Command | Exit | Counts |
|---|---|---|
| `npm run build` | 0 | `tsc` + `chmod 755 dist/cli.js` |
| `npm run check:tests` | 0 | `tsc -p tsconfig.tests.json` |
| `NODE_NO_WARNINGS=1 npm test` | 0 | 920 pass / 0 fail |
| `NODE_NO_WARNINGS=1 npm run test:p1-cli` | 0 | 540 pass / 0 fail |

Pre-rebase, at `5e2bd0a3` on the same laptop: build 0, check:tests 0, npm test 893/0, p1-cli 542/0
(the strategist's own build on that SHA also exited 0).

`NODE_NO_WARNINGS=1` only hides the Node `NO_COLOR`/`FORCE_COLOR` diagnostic that this host prints on every child; without it, several CLI tests that require empty stderr fail on that warning. It does not skip tests.

Two later `test:p1-cli` invocations on the same tree failed on `feed accepts a body beyond the client's compiled write maximum` and once also on `the receipt CLI uses the human wording by default`, both with "could not reach" against a local test server. A third isolated invocation of the same official gate was 542/542. Those two tests are not identity tests.

New tests live under `tests/p1-cli/session-*.test.ts` and additions in `tests/p1-cli/hook-routing.test.ts` and `tests/p1-cli/accept-link.test.ts` (globbed by `test:p1-cli`).

Not run: `test:p1-local`, `test:p1-server`, `db:*`, `check:edge`, live listener, live Codex wake. No Supabase slot here.

## Files

Owned and changed in the fix round:

- `src/cli.ts` — bound fetch on listen writes, `--foreground` session copy, accept `--allow-duplicate-name`, lazy listener-model imports, lease-loss abort, hook binding write
- `src/cloud/session-context.ts` — `released_at`, cleared key, `sessionProofOf` null after release
- `src/cloud/session-cli.ts` — stop marks released; start acquires a fresh UUID; start copy; bound revoke; host callback
- `src/cloud/session-ack.ts` — `managedAckInput`
- `src/cloud/session-receiver.ts` — ACK carries `managedAck`; host injection registry; no factory/spawn spies
- `src/cloud/session-client.ts` — transport errors redact proof headers
- `src/cloud/session-manager.ts` — `stopReason()`; `onDispatchStop` records the cause
- `src/cloud/accept-link.ts` — `allowDuplicateName` caller-choice seam (default unchanged)
- `src/listener/runtime.ts` — ACK passes `managedAck` and real injection result; lease-loss stops the loop
- `src/listener/hook.ts` — observe gated by `canAckManagedDelivery`
- `src/listener/session-binding.ts` — REMOVED after the rebase (section 10)
- `src/listener/supervisor.ts` — `listenerSafeErrorDetail` redacts session proof after secret-shape
- `tests/p1-cli/session-*.test.ts`, `tests/p1-cli/hook-routing.test.ts`, `tests/p1-cli/accept-link.test.ts`

Not edited: `src/cloud/session-wire.ts`, migrations, supabase/functions, `src/protocol`, `site`.

## Fix-round findings

Each item below has a test that failed on the old behaviour and passes now, except where marked not established.

| ID | Result |
|---|---|
| D1 stop never reached `stopped` | Met. Successful release clears the key, sets `released_at`, keeps generation. Status is `stopped`. Next start acquires a new execution UUID. `tests/p1-cli/session-lifecycle.test.ts` |
| G1/GD3 ACK not gated in production | Met. Runtime and interactive ACK pass `managedAck`. Stale generation cannot ACK on the runtime path. `tests/p1-cli/session-ack-gate.test.ts` |
| G2 hook observe ungated | Met, reworked after the rebase: released-only or ambiguous on-disk contexts cannot observe; one live context gates the observe; unmanaged (no context) still can. `tests/p1-cli/hook-routing.test.ts` |
| G3 `cswarm accept --allow-duplicate-name` | Met. Flag off by default; omitted unless set; never sent as `false`. `tests/p1-cli/accept-link.test.ts` |
| GD2 proof missing on agent writes | Met for token revoke, activity publish, `signals_seen`, session renew live bearer, and token renewal fetch. `tests/p1-cli/session-bound-writes.test.ts` |
| GD4 lease loss does not stop the worker | Superseded by section 10: there is no worker. The deterministic receiver (`AgentSessionManager`) still stops dispatch on renew failure and reports the typed code; the runtime path and its test are removed. |
| GD5 false start copy | Met. Copy is generated from acquired vs `--foreground` (worker copy removed). Usage documents `--foreground`. `tests/p1-cli/session-cli.test.ts` |
| GD6 tests did not exercise the claimed path | Met for redaction on transport/status detail, acquire retry with the same proof, enable/disable/recover command posts. Adapter env at construction sites: superseded (no adapters bind a session). Foreign-owned context **not established**. |
| GG1 no host callback; tools only saw prompt text | Met for the host callback: `registerHostInjection` / `currentHostInjection`; no callback stays `manual`. The worker adapter env part is superseded by section 10 (removed). |
| NITS unused spies; lazy model imports | Met. Interactive factory/spawn spies removed. `GrokListenerModel` and siblings load only inside listen `newModel`. |

## Numbered items

1. **session start|status|stop; human enable/disable/recover.** Met. Status is read-only. Stop then status is `stopped`. Enable/disable/recover post the matching command kinds.
2. **`--session-context` secure file.** Met. Absolute path, owned 0600 file in owned 0700 dir, symlink/world-writable parent/corrupt/in-repo rejected; token path is a reference, never a copy.
3. **whoami before acquire / token replace.** Met. Mismatched principal/workspace/target/token file refuses before command POST. Same identity acquire succeeds.
4. **UUID + 32-byte key before acquire; retry same UUID/key/command id.** Met. A released context is not reused as live proof. The next start mints a fresh execution UUID and key. Retired UUID from the server is still **not established** (no DB).
5. **Proof on agent writes; stable command ids; typed errors; redaction.** Met for clients that take the bound fetcher, including listen renewal, activity, `signals_seen`, and `token revoke` when `--session-context` is present. Proof is headers only. Status omits `session_key`. Unknown capability stays `enforcement: unknown` / `session_not_managed`.
6. **`allow_duplicate_name` CLI.** Met. Flag off by default; field omitted unless `--allow-duplicate-name`; never sent as `false`. Built from `createAgentPrincipalCommand` for `principal create` and `cswarm accept`.
7. **One deterministic receiver; 40s renew; stop dispatch before expiry.** Met in `AgentSessionManager`. Lease loss stops dispatch and reports the typed error. No new model poller; no worker (section 10).
8. **Interactive: no ACP/model factory/session-new/child spawn.** Met. `session-receiver.ts` and `session-cli.ts` have no those imports. Construction sites are the four lazy adapter imports in listen start. No callback => `receive_verification: manual`. CLI does not manufacture a Codex callback; hosts may `registerHostInjection`.
9. **Queue bound to execution UUID/generation + host conversation; ACK needs injection + current proof.** Met in `canAckManagedDelivery` and delivery observe/ack `managedAck`. Runtime, receiver, and hook pass the field. Stale generation/session refuses before fetch. Cache-loss recovery through durable server is **not established** (no DB).
10. **Host-session binding at delivery; fail closed to manual.** Met for interactive with a registered callback. Hook observe uses the listener's persisted binding snapshot; stale or absent context cannot observe when managed.
11. **Worker mode.** Superseded by section 10: removed. Competing acquire is still typed `session_conflict` (`session-lifecycle.test.ts`).
12. **status/resume fields; `mode: push` only while subscribed; stop is progress.** Met for `cswarm session status/stop`. After a successful release, status is `stopped`. Interactive start copy names acquire vs `--foreground`. Listener `mode: push` unchanged (arrival-watch not edited).

## Acceptance checklist

| Item | Result |
|---|---|
| Mismatched token/principal/host refuses BEFORE network write; same identity works | Met (`session-identity.test.ts`) |
| Insecure/symlink/foreign-owned/corrupt context rejected; 0600/0700 write; no token copy | Met for symlink/insecure/corrupt/in-repo/relative. Foreign-owned **not established** (cannot chown in this sandbox). |
| Acquire retry same private proof; release/recovery retires old execution; delayed stale ACK fails | Retry met. Release clears the local key and sets `released_at`. Recovery is the human command. Stale ACK met locally. Server retirement **not established** (no DB). |
| Current session retries original command after lost response with new proof and stable command id | Met for acquire command id + `bindSessionProof` keeps body command id. |
| Two simulated heterogeneous sessions: one winner, another principal unaffected | Met |
| Interactive spies factory/subprocess ZERO calls, including failure | Not a spy test any more. Met as: receiver/session-cli sources have no ACP/model/child_process imports; listen adapters load only in `newModel`. |
| Managed workers from every adapter get the shared binding; no inherited binding in review child | Superseded by section 10: no managed worker exists. |
| Queue cache deletion + host loss recovered through durable server; obsolete hook cannot observe | Obsolete hook observe met locally. Durable re-claim after cache loss **not established** (no DB). |
| No callback => manual; authenticated ready never equals same-chat injection proof | Met |
| Idle receiver invokes zero models; duplicate wake/ask IDs do not duplicate reply commands | Met (no replies in interactive; duplicate asks ACK once) |
| Push subscribed/drop/reconnect and current token renewal tests remain green | Met (`npm test` 893/893 includes wake/arrival/renewal files) |

## Not established

- Live Supabase: acquire/renew/release/enable against `cloud-swarm-dev` or local DB.
- Live detached listener on a managed principal (its claims carry no session proof; whether the server fences them is a Lane A/integration control).
- End-to-end Codex (or any host) callback injection on a real host.
- Foreign-uid context files.
- Server-side retirement of an execution UUID (no DB in this lane).
- Durable re-claim after local queue cache deletion (no DB).

## Integration

1. Rebase onto the server fix-up if `session-wire.ts` gains timings/states; keep importing names from that module.
2. Hook observe now passes `managedAck` from the persisted listener binding.
3. Root runs exclusive DB + live listener controls.
4. Do not claim the feature released from this lane alone.
