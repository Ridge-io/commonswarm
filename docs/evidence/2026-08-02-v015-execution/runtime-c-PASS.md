# Runtime C result — Bastion

Date: 2026-08-03 CDT  
Branch: `lead7/mvp-release-0.1.5`  
Frozen base: `b7a086630e5056d5ba3e015d7bf9a1e31aecbee4`  
Pushed candidate: `f30974a3c972e116e4b15ac705a70df3b47a33e0`

## Preflight and scope

- Before reading or changing task artifacts, HEAD, local tracking ref, and the live remote all
  equalled the frozen base.
- Read root `AGENTS.md`, `RUNTIME-C-GOAL.md`, the binding
  `RUNTIME-C-D-PREFLIGHT-CORRECTIONS.md`, the A2 goal, the v0.1.5 evidence index, the full
  simplification doctrine, and both historical runtime packets from this handoff directory.
- The package root test command enumerates exactly 27 literal paths and 27 unique paths. It reaches
  the delivery transport, effect store, delivery journal, listener runtime, and claim-ledger parser
  tests.
- Changed exactly:
  - `src/listener/runtime.ts`
  - `src/listener/supervisor.ts`
  - `tests/listener-runtime.test.ts`
- Did not change package, CLI, server, migrations, edge functions, site, version, or release files.

## Work item 1 — wedging fixture

The trusted-injected-poster fixture now counts scans and aborts after the first scan. This is an
injected stop condition, not `Promise.race`, `--test-timeout`, or any timer in the starved process.

With the temporary A2 mutant `this.isCredentialFailure = undefined` in `engine.ts`, the isolated
runtime test terminated without its external watchdog firing and printed this named failure:

```text
exit=1 watchdog=not-fired
✖ a trusted injected poster receives the same closed runtime credential classification
actual: 'cancelled'
expected: 'credential'
duration_ms 119.01825
```

After restoring `engine.ts`, the same named test passed (`exit=0`, watchdog not fired). The restore
proof against the frozen base was byte-identical, and the untracked backup count was zero.

## Checkpoint 1 — configuration, modes, events

Implemented closed pre-credential validation for the listener UUID/journal pair and injected client,
durable versus cursor-fallback mode classification, claim-without-ACK refusal, all-kind fallback
reads, durable observed-note effects, durable probe-row suppression, and the metadata-only supervisor
event reducer.

RED before implementation: 5 named failures, 14 existing passes, watchdog not fired.  
GREEN after implementation: 19/19, watchdog not fired.

The supervisor persists only B's closed delivery fields. A claim updates claim time and exact pending
count without calling the signal handled; ACK sets pending to null and updates last handled signal.

## Checkpoint 2 — journal, claim, retry, budget

Implemented one persisted claim reservation, explicit attempt timestamps, stable claim ID/body across
transport/429/5xx ambiguity, fresh bearer acquisition before every attempt, exact claim counts,
per-command poison-warning suppression, zero-result clearing, claim-pending/leased replay checks, and
lease persistence before effect work.

Budget constants compose the existing host, reply, and delivery transport deadlines:

- maximum lease: 900,000 ms;
- safety margin: 30,000 ms;
- prompt start: 210,000 ms;
- reply only: 90,000 ms;
- ACK only: 60,000 ms;
- retry: 500 ms full-jitter exponential, capped at 30,000 ms, honoring typed 429 Retry-After.

RED before implementation: 3 named failures, 19 prior passes, watchdog not fired.  
GREEN after implementation: 22/22, watchdog not fired.

## Checkpoint 3 — effects, ACK, cancel, rollback, crash

Implemented outer-relation authority, pre-engine effect-integrity comparison, direct-note persistence
and exact reread, ask processing within lease budgets, closed terminal outcome mapping, persisted ACK
preparation, deterministic ACK replay, typed ambiguity retry, caller-abort checks after retry sleeps,
ACK-only/neither-marker rollback, and the three-condition stale-403 rule bound to the exact startup
ACK command.

The load-bearing order is:

1. persist terminal effect;
2. reread and verify exact signal content/relation plus terminal state;
3. persist `prepareAck` with deterministic `ackCommandId(leaseId)`;
4. only then issue the ACK request.

ACK-before-persist is forbidden and was not implemented.

Core RED before implementation: 6 named failures, 22 prior passes, watchdog not fired.  
Core GREEN after implementation: 28/28, watchdog not fired.  
Additional retry/stale/lease audit RED: 0/4, all four named failures, watchdog not fired.  
Additional audit GREEN: 4/4, watchdog not fired.  
Final isolated runtime file: 32/32, watchdog not fired.

### Crash ordering

- Before claim reservation: no request exists; next run reserves the next ordinal.
- After reservation and before send: `claim_pending` replays the same claim ID/body.
- After attempt persistence and before send: recovery waits conservatively if claim capability is
  gone; otherwise it replays the same ID/body.
- After committed/lost claim response and before `recordLease`: claim replay rehydrates the same
  lease and body.
- After `recordLease` and before effect: leased recovery replays and verifies exact signal, lease,
  and deadline before work.
- During an in-flight prompt before durable output: a crash can repeat one model turn. Exactly-once
  model execution is not claimed.
- After reply-body persistence and before post: the engine reuses the durable reply body and
  deterministic reply command ID without another prompt.
- After an ambiguous post: the same durable reply effect is retried; no new reply ID/body is minted.
- After terminal effect persistence and before `prepareAck`: recovery verifies the terminal effect,
  then prepares the ACK.
- After `prepareAck` and before ACK: restart replays the identical deterministic ACK body/ID.
- After ambiguous ACK: `ack_pending` remains and retries the identical body/ID with a fresh bearer.
- After server ACK acceptance and before journal clear: restart sends the same ACK; the accepted
  server returns idempotent for the same lease/listener/outcome, then local state clears.
- Exact `DeliveryHttpError(403, "delivery_unavailable")` clears only when the process began with
  that exact `ack_pending` command and local time is beyond its stored lease deadline. Fresh/live or
  later ACKs preserve state and stop as credential loss.

## Work item 3 — host switching

Host switching mid-session is unreachable; did nothing. One model object is bound in
`ListenerRuntimeOptions` for the listener process lifetime, and `ListenerModel` exposes only
`prompt()`. No teardown or host-switch API was added.

## Gates

Focused, externally watched:

- `tests/listener-runtime.test.ts`: 32/32, watchdog not fired;
- `tests/listener-engine.test.ts`: 24/24, watchdog not fired;
- `tests/listener-control.test.ts`: 17/17, watchdog not fired.

Required pure/static gates:

- `npm test`: 361/361, 4.244 s;
- `npm run check:tests`: exit 0;
- `npm run build`: exit 0;
- `npm run check:edge`: exit 0, all three named edge entrypoints;
- `git diff --check`: exit 0.

Exclusive DB sequence and precise process proofs:

1. initial `pgrep -f 'test:p1-server|test:p1-local|supabase functions serve' | wc -l`: 0;
2. `npm run db:reset`: exit 0, 26.98 s;
3. process proof: 0;
4. `npm run test:p1-cli`: 137/137, 7.23 s;
5. process proof: 0;
6. `npm run test:p1-local`: 4/4, 6.67 s;
7. process proof: 0;
8. `npm run test:p1-server`: 69/69, 95.32 s (explicit captured rerun);
9. final process proof: 0.

The first server invocation also completed and left zero processes, but its final shell exit/count
was not captured after the terminal session yielded; it is not used as evidence. The explicit rerun
above is the recorded gate.

## Commit, frozen proof, and push

One commit only:

```text
f30974a3c972e116e4b15ac705a70df3b47a33e0 Implement durable listener runtime
```

Required post-commit proof:

```text
frozen_stat_begin
frozen_stat_end
```

That empty range is from:

```sh
git diff b7a086630e5056d5ba3e015d7bf9a1e31aecbee4..HEAD --stat -- \
  src/listener/engine.ts src/cloud/command-client.ts src/cloud/delivery.ts \
  src/listener/delivery-journal.ts
```

The commit changes exactly the three owned paths. It was pushed to
`origin/lead7/mvp-release-0.1.5`. HEAD, local tracking, and live remote all equal
`f30974a3c972e116e4b15ac705a70df3b47a33e0`.

## Not established

This lane did not establish Runtime D or production CLI composition, landing to `main`, a release or
version freeze, deployment, production capability behavior/order, authenticated production QA,
real PostgreSQL one-winner behavior under production concurrency, real provider tail latency inside
the lease, cross-machine suppression of duplicate model turns, real-load capacity, production
revocation latency, realtime wake delivery, dashboard unread aggregation, longevity canaries, or the
required exact-SHA two-arm review. The Lead owns that review. No deploy, tag, version bump, swarm
join/status, broadcast, or AdvisorClaude2 contact occurred.
