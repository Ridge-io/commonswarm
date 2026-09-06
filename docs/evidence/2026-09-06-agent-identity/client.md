# Lane C: managed client (identity)

Branch: `lane/identity-client` (based on `lane/identity-server`).
Builder: Grok. Wire contract: `src/cloud/session-wire.ts` (not edited).

HEAD: `cb00d6435ef7b32109533821ff396179416cc8a1` on `lane/identity-client`.

## Gates

| Command | Exit | Counts |
|---|---|---|
| `npm run build` | 0 | `tsc` + `chmod 755 dist/cli.js` |
| `npm run check:tests` | 0 | `tsc -p tsconfig.tests.json` |
| `NODE_NO_WARNINGS=1 npm test` | 0 | 893 pass / 0 fail |
| `NODE_NO_WARNINGS=1 npm run test:p1-cli` | 0 | 528 pass / 0 fail |

`NODE_NO_WARNINGS=1` only hides the Node `NO_COLOR`/`FORCE_COLOR` diagnostic that this host prints on every child; without it, several CLI tests that require empty stderr fail on that warning. It does not skip tests.

New tests live under `tests/p1-cli/session-*.test.ts` (globbed by `test:p1-cli`). Citation line pins in `tests/p1-cli/citation-drift.test.ts` were updated to the Lane A command-function line numbers already on this branch.

Not run: `test:p1-local`, `test:p1-server`, `db:*`, `check:edge`, live listener, live Codex wake. No Supabase slot here.

## Files

Owned and changed:

- `src/cli.ts` — `session start|status|stop|enable|disable|recover`, `--session-context`, `--allow-duplicate-name`, listen binding
- `src/cloud/command-client.ts` — `allow_duplicate_name` type, `createAgentPrincipalCommand`, `CommandHttpError.code`
- `src/cloud/delivery.ts` — managed ACK/observe local gate
- `src/cloud/session-contract.ts` — re-exports wire names; client timings, modes, error-code list
- `src/cloud/session-errors.ts` — typed `AgentSessionError` (branch on `code`)
- `src/cloud/session-proof.ts` — key, headers, redaction, `bindSessionProof`
- `src/cloud/session-context.ts` — 0700/0600 context file, no token copy
- `src/cloud/session-client.ts` — acquire/renew/release/enable/disable/recover
- `src/cloud/session-ack.ts` — ACK requires current proof + host injection
- `src/cloud/session-manager.ts` — one deterministic renew timer
- `src/cloud/session-receiver.ts` — interactive claim/surface/ack; no ACP imports
- `src/cloud/session-cli.ts` — start/status/stop/lifecycle orchestration
- `src/listener/session-binding.ts` — worker prompt identity, review-child env strip
- `src/listener/engine.ts`, `types.ts`, `runtime.ts`, `detach.ts`, `index.ts`
- `tests/p1-cli/session-*.test.ts`, `tests/p1-cli/citation-drift.test.ts`

Not edited: `src/cloud/session-wire.ts`, `src/cloud/accept-link.ts`, `src/listener/hook.ts`, `tests/p1-cli/hook-routing.test.ts`, `src/cloud/arrival-watch.ts`, migrations, supabase/functions, `src/protocol`, `site`.

## Numbered items

1. **session start|status|stop; human enable/disable/recover.** Met. Status is read-only and does not enable enforcement.
2. **`--session-context` secure file.** Met. Absolute path, owned 0600 file in owned 0700 dir, symlink/world-writable parent/corrupt/in-repo rejected; token path is a reference, never a copy.
3. **whoami before acquire / token replace.** Met. Mismatched principal/workspace/target/token file refuses before command POST. Same identity acquire succeeds.
4. **UUID + 32-byte key before acquire; retry same UUID/key/command id.** Met. Retired UUID is a typed `session_retired` from the server; client does not reuse a live generation>=1 file.
5. **Proof on agent writes; stable command ids; typed errors; redaction.** Met for clients that take the bound fetcher (`ThinCommandClient`, delivery, files/channels/feedback/listen). Proof is headers only. Status omits `session_key`. Unknown capability stays `enforcement: unknown` / `session_not_managed`.
6. **`allow_duplicate_name` CLI.** Met. Flag off by default; field omitted unless `--allow-duplicate-name`; never sent as `false`. Built from `createAgentPrincipalCommand`. Accept-link CLI flag not added (`accept-link.ts` is not owned and has no `allowDuplicateName` in this worktree).

7. **One deterministic receiver; 40s renew; stop dispatch before expiry.** Met in `AgentSessionManager`. No new model poller. Wake reuse is through existing listen runtime; interactive loop sleeps on the renew interval and does not claim from notify streams.
8. **Interactive: no ACP/model factory/session-new/child spawn.** Met. `session-receiver.ts` has no those imports. Test spies `providerFactory` and `spawn` at zero on success and failure. No callback => `receive_verification: manual`, no ACK. CLI cannot manufacture a Codex callback.
9. **Queue bound to execution UUID/generation + host conversation; ACK needs injection + current proof.** Met in `canAckManagedDelivery` and delivery observe/ack `managedAck`. Stale generation/session refuses before fetch. Cache-loss recovery through durable server is **not established** (no DB).
10. **Host-session binding at delivery; fail closed to manual.** Met for interactive. Hook.ts not edited; a hook process that does not pass `managedAck` still depends on server fencing. Documented below.
11. **Worker mode explicit; shared session manager; prompt identity; no inherited binding in review child.** Met. `listen start --session-context` binds all four adapters. `reviewChildEnv` / `sanitizeChildEnv` drop `CSWARM_SESSION_CONTEXT`. Competing acquire is typed `session_conflict`. Stop of external shell effects is **not claimed**.
12. **status/resume fields; `mode: push` only while subscribed; stop is progress.** Met for `cswarm session status/stop`. Listener `mode: push` unchanged (arrival-watch not edited). Session stop returns `stopping` plus `cswarm session status --session-context <path>`.

## Acceptance checklist

| Item | Result |
|---|---|
| Mismatched token/principal/host refuses BEFORE network write; same identity works | Met (`session-identity.test.ts`) |
| Insecure/symlink/foreign-owned/corrupt context rejected; 0600/0700 write; no token copy | Met for symlink/insecure/corrupt/in-repo/relative. Foreign-owned not driven (cannot chown in this sandbox). |
| Acquire retry same private proof; release/recovery retires old execution; delayed stale ACK fails | Retry met. Release sends proof. Recovery is the human command. Stale ACK met locally. Server retirement **not established** (no DB). |
| Current session retries original command after lost response with new proof and stable command id | Met for acquire command id + `bindSessionProof` keeps body command id. |
| Two simulated heterogeneous sessions: one winner, another principal unaffected | Met |
| Interactive spies factory/subprocess ZERO calls, including failure | Met |
| Managed workers from every adapter get the shared binding; no inherited binding in review child | Met (helper + prompt + env). Live four-adapter listener process **not established**. |
| Queue cache deletion + host loss recovered through durable server; obsolete hook cannot observe | Obsolete ACK met locally. Durable re-claim after cache loss **not established** (no DB). Hook.ts not wired to `managedAck`. |
| No callback => manual; authenticated ready never equals same-chat injection proof | Met |
| Idle receiver invokes zero models; duplicate wake/ask IDs do not duplicate reply commands | Met (no replies in interactive; duplicate asks ACK once) |
| Push subscribed/drop/reconnect and current token renewal tests remain green | Met (`npm test` 893/893 includes wake/arrival/renewal files) |

## Not established

- Live Supabase: acquire/renew/release/enable against `cloud-swarm-dev` or local DB.
- Live detached listener with `--session-context` and a real provider child.
- End-to-end Codex (or any host) callback injection.
- `cswarm hook check` passing `managedAck` (hook.ts is another lane).
- `cswarm accept --allow-duplicate-name` (`accept-link.ts` not owned).
- Foreign-uid context files.
- That a stopped managed worker has terminated every external shell/git effect.

## Integration

1. Rebase onto the server fix-up if `session-wire.ts` gains timings/states; keep importing names from that module.
2. After the hook preview lane lands, pass `managedAck` from hook observe.
3. Root runs exclusive DB + live listener controls.
4. Do not claim the feature released from this lane alone.
