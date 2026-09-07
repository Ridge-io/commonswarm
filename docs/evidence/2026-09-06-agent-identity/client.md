# Lane C: managed client (identity)

Branch: `lane/identity-client`, rebased 2026-09-06 onto `lane/agent-identity` 5380a015
(= main e6e49929, cswarm 0.1.61, + Lane A + Lane B). Owner after the rebase: CSLaptopLead.
Builder of the original lane and its fix round: Grok (on the mini). Wire contract:
`src/cloud/session-wire.ts` (not edited).

Code SHA (round 4): `53371e8f` (ACK carries `surfaced` per the pending-surface contract), on top
of the round-3 commit (skew allowance, detached start resolves no bridge, renewal bound on
`--session-context`, dead proof retired on stop), the round-2 commit (acquire on the wire, hook
and listener carry the live proof, manual claims nothing), the worker removal, and the 13 replayed
lane commits; all rebased onto `lane/agent-identity` d141c1e6 (main e6e49929 + Lane A round 2 +
Lane B). Earlier code SHAs `2534e38c`, `b0902f68`, `c895ba49` were rewritten by that rebase and
survive only in this file and in the arm records that name them. Final SHA: the docs-only commit that records this file; run
`git log -1 --format=%H -- docs/evidence/2026-09-06-agent-identity/client.md` on the branch.

Earlier pins, kept for readers who meet them: `cb00d64` (never existed), `a90d395b` (the first
implementation commit, pre-rebase), `619138d4` and `5e2bd0a3` (the pre-rebase fix round; that
history is on the mini and in `lane/identity-client-pre-rebase` on the laptop, not on origin).

## Integration arms (CSLaptopLead)

- `1895889b` (= 33d52c34 + Lane C 9c6011bd): Gemini inversion PASS twice (`arm-agy-inversion-1895889b.SUMMARY-ONLY-run1.md`
  was a four-bullet summary and was rerun with per-item evidence, `arm-agy-inversion-1895889b.md`);
  Grok exact was killed by the host for memory before its VERDICT line
  (`arm-grok-exact-1895889b.KILLED-NO-VERDICT.md`); its partial text had found the hook high-water
  gap fixed in 1023f70f. Superseded by the next head.
- `b7fcd581` (= 7a06d78d Lane A round 3 + Lane C 1023f70f): Grok exact VERDICT: FAIL on one server
  DEFECT, `swarm_read.agent_execution_sessions` granted to `authenticated` with no membership
  predicate (the same finding as Codex on 7a06d78; Lane A owns the fix); no GAP; NITs recorded.
  Gemini inversion VERDICT: PASS with per-item file:line evidence; it read that view and passed it,
  so it missed the DEFECT. Gates on b7fcd581 (laptop): build 0, check:tests 0, npm test 924/0,
  p1-cli 542/0, site 547/0 (one skipped).
- Codex on 7a06d78 (strategist): FAIL, nine findings; eight client items go to a Grok lane on the
  mini cut from b7fcd581 (`lane/identity-client-r6`), reviewed by this seat.
- The live control for the final head runs on the mini with
  `laptop-live-control-b0902f68/run-control.sh <worktree> <host-session-id>` (self-locating helpers
  `env.py` and `enable.ts` beside it; expected outcomes in its header; `README.md` there).

## Round 4 arms on 27769ea4: Grok exact PASS, Gemini inversion PASS

Both arms ran on the final SHA `27769ea4` (`laptop-arms/arm-grok-exact-27769ea4.md`,
`laptop-arms/arm-agy-inversion-27769ea4.md`), each with a VERDICT line and file:line reasoning;
Gemini was pinned to the worktree with `--add-dir` after its round-3 timeout. This docs-only commit
files them; the code SHA stays `53371e8f`.

## Rounds 3 and 4 (53371e8f): Grok exact FAIL on 0e3b6dfb folded; Gemini timed out; base moved to d141c1e

Arms on `0e3b6dfb` (`laptop-arms/`): Grok exact VERDICT: FAIL with no DEFECT; GAP 1 was the
server's missing pending-surface state (Lane A, shipped by the strategist in d141c1e6), GAP 2 was
this lane's `--session-context` not binding the silent token renewal on ordinary commands (fixed).
Gemini inversion: NO VERDICT, the 30-minute print timeout expired after the run wandered off the
checkout (`arm-agy-inversion-0e3b6dfb.TIMEOUT-NO-VERDICT.md` keeps its last lines); that arm is
owed again on the final SHA and is run with the worktree passed explicitly.

Strategist ruling (signal 34f6f031): the route-main listener binding is RIGHT and stays; spec
section 10 now says so. Two main-0.1.61 items became this lane's: the lease-deadline check gained
`LISTENER_LEASE_CLOCK_SKEW_ALLOWANCE_MS` (60 s; the control had shown a VM clock 0.1 s ahead making
the first claim fatal; test added), and detached `listen start` no longer resolves or requires an
ACP bridge it never starts (explicit paths are still validated as absolute; the detach tests were
updated). Also folded from Grok's NITs: `session stop` that meets `session_expired`,
`session_retired`, or `session_proof_invalid` retires the local context and reports
`status.server_refusal` (test added); the roster comment no longer claims unique names.

Item 9 against the shipped contract (`ACK_AGENT_DELIVERY_SURFACED_FIELD`): the receiver ACKs
observed with `surfaced` = the real injection result; the hook's observe sends `surfaced: true`
only on the path that already required the host's own stdin session id and the live proof; legacy
principals omit the field; `delivery_not_surfaced` is in the client's typed codes. The hook test
asserts the field on the positive observe. Not established: a live observe against d141c1e's
server (the local stack was stopped for memory before this round; the round-2 control ran against
a556ab1b's server, which had no `surfaced` field).

Gates at `53371e8f` (`laptop-round4-53371e8f/`): build 0, check:tests 0, npm test 923/0, p1-cli 541/0.

## Round 2 (b0902f68): Grok exact FAIL on e8abf8ab, folded; live control on the local stack

Grok exact on `e8abf8ab` (`laptop-arms/arm-grok-exact-e8abf8ab.md`, VERDICT: FAIL) found, in this
lane's scope: (D1) `acquire` sent `key_hash` in the body and no proof headers, so a managed
principal could never acquire; (D2) the hook's observe sent no proof headers and fabricated the
host identity; (GAP) `--foreground` claimed without a way to ACK; (NIT) a no-op factory check and
a comment that said names are unique. All four are fixed in `b0902f68` with tests
(`session-identity`, `session-lifecycle`, `hook-routing`, `session-receiver`). Out of this lane's
scope and handed to the strategist: bare queued-to-observed when managed, no durable
pending-surface state, acquire retry not checking the host binding, `GRANT` exposing `key_hash`
(all Lane A); detached `listen start` resolving an ACP binary it never starts, and the listener's
lease-deadline check with no clock-skew allowance (both main's 0.1.61 listener).

The live control (`laptop-live-control-b0902f68/`, script `run-control.sh`, log `control.log`,
listener journal `listener-events.ndjson`) ran on the local Supabase stack at code SHA `b0902f68`
with this seat's Claude session id as the host conversation. Measured, in order:

| step | result |
|---|---|
| enable management (human owner, `enable_agent_management` via the client class) | ok |
| `session start --mode interactive` on the managed principal | acquired: generation 2, `enforcement: enabled`, `has_private_proof: true`, `state: running`; before round 2 the same call was refused `session_proof_missing` |
| `listen start --route main` with the hook installed for that principal | `ready`, `same_owner_delivery: interactive session; no ACP worker prompt`, no child process |
| directed ask from the human owner | listener journal: `listener_delivery_claim` with the proof, `routed_main`, `listener_delivery_ack outcome=queued`, `pendingForMainCount: 1`; before the listener binding the first claim was refused HTTP 401 (`credential_stopped`) |
| `hook check` with no host id on stdin | printed the ask text; nothing observed (fail closed to manual) |
| `hook check` with Claude's stdin shape `{"session_id": <this session>}` | observed: server row `ack_outcome = observed`, `acked_at` set, `attempt_count 1`; `pendingForMainCount: 0` |
| `session recover` (human) | ok |
| `session stop` with the old context | refused: `the execution session has expired; stop dispatch and recover` (typed) |
| model processes started by the listener | none |

Host artefacts that shaped the control, not the lane: `supabase start` needs `-x vector,logflare`
under colima; the worktree must live under `/Users`; the colima VM clock led the laptop by
~0.1 s, which made the listener's lease-deadline check (`leased_until > now + 15 min`) fatal on
the first claim until the VM clock was set to the laptop's (the check itself is main's, reported).

Not established by the control: the hook's stale-context refusal after recover (the queue was
already empty, so nothing could be observed either way; the unit test covers it); a second live
context refusing `listen start` (unit-level only); production behaviour.

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

Round 2 at `b0902f68` (logs in `laptop-round2-b0902f68/`): build 0, check:tests 0, npm test 920/0,
p1-cli 540/0.

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
| Queue cache deletion + host loss recovered through durable server; obsolete hook cannot observe | Obsolete hook observe met (unit test; live: hook without the bound host id observed nothing). Durable re-claim after cache loss **not established** (server has no pending-surface state; reported). |
| No callback => manual; authenticated ready never equals same-chat injection proof | Met; manual now claims nothing (round 2). |
| Idle receiver invokes zero models; duplicate wake/ask IDs do not duplicate reply commands | Met (no replies in interactive; duplicate asks ACK once) |
| Push subscribed/drop/reconnect and current token renewal tests remain green | Met (`npm test` 893/893 includes wake/arrival/renewal files) |

## Not established

- Live Supabase: acquire/renew/release/enable against `cloud-swarm-dev` or local DB.
- Renewal over time on a live managed listener (the control ran under the 40 s renew offset).
- End-to-end Codex (or any host) callback injection on a real host.
- Foreign-uid context files.
- Server-side retirement of an execution UUID (no DB in this lane).
- Durable re-claim after local queue cache deletion (no DB).

## Integration

1. Rebase onto the server fix-up if `session-wire.ts` gains timings/states; keep importing names from that module.
2. Hook observe now passes `managedAck` from the persisted listener binding.
3. Root runs exclusive DB + live listener controls.
4. Do not claim the feature released from this lane alone.
