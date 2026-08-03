# /goal — Runtime C: durable listener runtime

Worker: **Bastion** (Codex). Lane: listener Runtime C.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: `0988697fd399f9f9da811f9d5e4e4710e842045b`** — by SHA, not "the integrated base".

Read completely before starting: root `AGENTS.md`,
`docs/design/contracts/RUNTIME-A2-CREDENTIAL-ESCAPE-GOAL.md`,
`docs/design/contracts/RUNTIME-C-D-PREFLIGHT-CORRECTIONS.md` (binding alongside the older spec,
which carries superseded assumptions), and
`docs/evidence/2026-08-02-v015-execution/README.md`.

## Owned paths — nothing else

- `src/listener/runtime.ts` (396 lines at base)
- `src/listener/durable-runtime.ts` — optional, private, create only if genuinely needed
- `src/listener/supervisor.ts` — **narrow event-reducer changes only** (338 lines at base)
- `tests/listener-runtime.test.ts` (761 lines at base)

## Frozen — do not touch, and do not regress

- **`src/listener/engine.ts`, `src/cloud/command-client.ts`, `src/cloud/delivery.ts`, and
  `src/listener/delivery-journal.ts` are FROZEN.** The last two are what C composes against most
  directly (`DeliveryCommandClient` lives in `delivery.ts`, not `command-client.ts`), which is exactly
  why they are the temptation. Runtime A2 landed
  there and its five invariants are must-preserve: typed-HTTP precedence, classifier-throw
  restoration, explicit caller-abort precedence, name-only `AbortError`, and exact caller-signal
  forwarding. If your change appears to require editing either file, **stop and report** — that is a
  scope finding, not a licence.
- **`supervisor.ts` is not what the older spec describes.** Runtime B (`82473de`) added
  startup-locked instance identity there. Specify your reducer changes against the **current** file
  and do not regress B. `tests/listener-control.test.ts` joins your must-stay-green set even though
  you do not own it.
- The delivery migration, edge functions, site, and version are out of scope.
- `package.json` is **verify, do not edit**: the preflight requires proving the 27-file literal union
  still reaches your runtime tests. Check it; do not change it.

## Work item 1 — repair the wedging fixture (do this FIRST)

`tests/listener-runtime.test.ts:540`, *"a trusted injected poster receives the same closed runtime
credential classification"*, is an unbounded microtask-only spin under the A2 classifier mutant: its
`readPage` always returns the same ask, its injected sleep resolves instantly, and with the classifier
disabled the engine terminalizes instead of escaping, so the runtime never stops and the loop never
yields to the timers phase. `--test-timeout` **structurally cannot** bound it — Node enforces that
timeout with a timer in the same starved process.

You own this file. Bound the fixture with a **scan-count cap or an injected stop condition** so that
under the classifier mutant it produces a **printed named failure** instead of a hang.

**Do NOT use the `Promise.race` watchdog pattern from line ~674 here.** That is a `setTimeout` in the
same process — the identical mechanism this goal just ruled out for `--test-timeout`. It works at 674
only because that runtime is idle-blocked on a never-settling fetch, so the timers phase still runs.
Under the 540 mutant the loop never yields to timers, so a race watchdog would hang too.

The working repair: count `readPage` calls and abort after N, keeping
`assert.equal(stop.reason, "credential")`. Under the mutant the runtime stops `"cancelled"` and that
assertion prints a named red; the existing `record.state === "reply_ready"` assertion discriminates on
a second axis, since the mutant persists `failed`.

Why this is first: Stage 7 re-proves the causal controls on the release candidate. Today that control's
"red" is a watchdog kill, which is the weakest evidence in the release. Converting it to printed red
is the single highest-value thing in this lane.

Prove it: apply the A2 classifier mutant (`this.isCredentialFailure = undefined` in `engine.ts`),
show the runtime file now prints a **named** failure and terminates, then restore `engine.ts`.

Prove the restore with `git diff --exit-code 0988697 -- src/listener/engine.ts` and confirm no
untracked backup files. Do **not** assert `git status` is clean — your own legitimate edits to
`tests/listener-runtime.test.ts` are present at that moment, so a clean status is unsatisfiable and
asserting it would send you chasing a phantom.

**Commit-time proof, required in your result file:** after committing, show
`git diff 0988697..HEAD --stat -- src/listener/engine.ts src/cloud/command-client.ts src/cloud/delivery.ts src/listener/delivery-journal.ts`
is **empty**. No other gate catches an imperfect restore riding into your one commit.

## Work item 2 — the durable runtime

Implement Runtime C per `RUNTIME-C-D-PREFLIGHT-CORRECTIONS.md`. Run its checkpoints **sequentially in
one writer**, in this order, and report each:

1. config / modes / events
2. journal / claim / retry / budget
3. effects / ACK / cancel / rollback / crash

The server side this composes against is already merged and accepted: durable claim/ACK with
`FOR UPDATE SKIP LOCKED`, lease expiry, and a recharge at `resolveLedgerRace`. Read
`supabase/functions/command/durable-delivery.ts` to match its actual contract rather than assuming.

**Effect must be persisted before ACK. ACK-before-persist is forbidden outright** — do not implement
it and do not treat it as a case to handle.

Persist the terminal effect and the `prepareAck` journal entry **before** issuing the ACK request. A
crash after persist and before ACK must recover on restart into an **idempotent** ACK: a deterministic
`ackCommandId(leaseId)` with the same outcome, which the merged server returns as `idempotent` when
`last_lease_id`, `last_leased_by`, and outcome all match (`durable-delivery.ts:470-489`). If the lease
was reset or reclaimed meanwhile the server returns `unavailable`/403, and the preflight's
three-condition stale-403 clearing rule applies.

State plainly what a crash at each point does, and confirm you did not implement the forbidden order.

## Work item 3 — one small check, then stop

Our adapter boundary is `ListenerModel` (`src/listener/types.ts:71`), a single `prompt()` method with
no teardown. Determine whether **host switching mid-session is reachable at all** in this design. If
it is not — likely, since one host is bound per listener process — record "unreachable, did nothing"
and add no teardown API. Do not build for a case that cannot occur.

## Tests

Every behavioural change needs a test proven **RED before and GREEN after**. If you cannot make a
test fail first, say so — that means it does not discriminate and the change is unproven.

Run focused tests with **per-file isolation and an external wall-clock watchdog**; `--test-timeout`
alone is insufficient (see work item 1). Neither `timeout` nor `gtimeout` exists on this machine; use
a background-and-kill pattern.

## Gates

`npm test`, `npm run check:tests`, `npm run build`, `npm run check:edge`, `git diff --check`.
Then, holding the exclusive DB slot (prove free first with
`pgrep -f 'test:p1-server|test:p1-local|supabase functions serve' | wc -l` → 0):
`npm run db:reset`, `npm run test:p1-cli`, `npm run test:p1-local`, `npm run test:p1-server`,
serially, with a zero-process proof between each. Record exact counts and elapsed time.

`tests/listener-control.test.ts` and `tests/listener-engine.test.ts` must stay green — they guard
Runtime B and A2 respectively.

## Deliverable

Commit **once**, push, record the new exact SHA (it forces a two-arm review, which is the Lead's job).
Write `/Users/yulanbot/Developer/Ridge.io/cloud-swarm/scratchpad/2026-07-31-common-swarm-handoff/RUNTIME-C-RESULT.md`
with: the fixture repair and its printed-red proof, each checkpoint's outcome, the crash-ordering
statement, the host-switch reachability finding, every red-then-green proof, all gate counts, the
zero-process proofs, and the new SHA.

## Non-goals

No Runtime D (`src/cli.ts` is not yours). No deploy, tag, release, or version bump. No migration or
edge-function change. No swarm join or status set — you share the Lead's cmux surface and would
overwrite the Lead's status. No broadcast, no `AdvisorClaude2`.

## Stop conditions

Preflight fails · a change appears to require editing `engine.ts` or `command-client.ts` · a test
cannot be made red before its fix · `listener-control.test.ts` or `listener-engine.test.ts` regresses ·
residual processes survive · scope grows beyond the owned paths.

State what you did **not** establish: Runtime D, deployment, production behaviour, and real-load
capacity are out of scope.
