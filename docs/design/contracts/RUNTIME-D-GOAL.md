# /goal — Runtime D: CLI surface for durable receive, plus one reducer hardening

Worker: **Lintel2** (Codex). Lane: listener Runtime D.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE` and asserted in preflight.** A SHA written
into a contract goes stale the moment the contract is committed, so it is not written here.

Read completely first: root `AGENTS.md`,
`docs/design/contracts/RUNTIME-C-D-PREFLIGHT-CORRECTIONS.md` (binding — Runtime D's section),
`docs/design/contracts/RUNTIME-C-GOAL.md` (what C just landed, which you compose against), and
`docs/evidence/2026-08-02-v015-execution/runtime-c-fixture-repair-VERIFIED-PARTIAL.md`.

## Owned paths — nothing else

- `src/cli.ts`
- `src/cloud/delivery.ts` — **the permitted comment only**, nothing functional
- `src/listener/supervisor.ts` — **one narrow hardening**, see work item 2
- `tests/listener-cli-process.test.ts`
- `tests/support/agent-receive-cli.test.ts`

## Frozen — do not touch, do not regress

`src/listener/engine.ts`, `src/listener/runtime.ts`, `src/cloud/command-client.ts`, and
`src/listener/delivery-journal.ts`. Runtime A2's five invariants (typed-HTTP precedence,
classifier-throw restoration, explicit caller-abort precedence, name-only `AbortError`, exact
caller-signal forwarding) and all of Runtime C's durable behaviour are must-preserve.

**Commit-time proof required in your result:**
`git diff "$FROZEN_BASE"..HEAD --stat -- src/listener/engine.ts src/listener/runtime.ts src/cloud/command-client.ts src/listener/delivery-journal.ts`
must be **empty**. No other gate catches an unintended edit riding into your one commit.

`package.json` is **verify, do not edit** — confirm the literal union still reaches your test files;
do not change it. Migration, edge functions, site, and version are out of scope.

## Work item 1 — the CLI surface

Implement Runtime D per the preflight corrections' Runtime-D section. The CLI is the surface a real
user touches, so the product voice applies: output says what just happened, what is now true, and
what happens next, so nobody has to check whether it worked. Plain and calm — the benefit is
**agents coordinating so collaborators are unblocked**, not control or enforcement.

Compose against Runtime C as it actually landed — read `src/listener/runtime.ts` rather than assuming
its shape.

## Work item 2 — supervisor reducer hardening (from the Runtime C inversion arm)

`src/listener/supervisor.ts:244` handles `delivery_ack` by **fallthrough**: the ACK status update is
simply the end of `onEvent` after the earlier branches return. `delivery_ack` is the only event that
reaches it today, so this is correct now and latent later — any new `ListenerRuntimeEvent` added
without its own branch would silently be logged as an ACK.

Replace the fallthrough with an explicit `if (event.type === "delivery_ack") { … }`, and make an
unrecognized event take the existing malformed/bounded-metadata path rather than the ACK path.

Prove it: add a test that feeds an unrecognized event type and asserts it does **not** produce an ACK
status update. It must be **RED before** your change and **GREEN after**.

## Tests

Every behavioural change needs a test proven **RED before and GREEN after**. If you cannot make one
fail first, say so plainly — that means it does not discriminate and the change is unproven.

**Causal controls are run per-test, never whole-file**: `--test-name-pattern="<exact name>"` +
`--test-concurrency=1` + an **external wall-clock watchdog** (no `timeout`/`gtimeout` on this machine;
use background-and-kill). `--test-timeout` alone is insufficient — Node enforces it with a timer in
the same process, and a microtask-starved loop never reaches the timers phase. **A hang is not
evidence; only a printed named failure is.**

## Gates

`npm test`, `npm run check:tests`, `npm run build`, `npm run check:edge`, `git diff --check`.
Then, holding the exclusive DB slot (prove free with
`pgrep -f 'test:p1-server|test:p1-local|supabase functions serve' | wc -l` → 0):
`npm run db:reset`, `npm run test:p1-cli`, `npm run test:p1-local`, `npm run test:p1-server`,
serially, with a zero-process proof between each.

`tests/listener-runtime.test.ts`, `tests/listener-engine.test.ts`, and `tests/listener-control.test.ts`
must stay green — they guard Runtime C, A2, and B respectively.

## Deliverable

Commit **once**, push, record the new exact SHA (it forces a two-arm review — the Lead's job).
Write `/Users/yulanbot/Developer/Ridge.io/cloud-swarm/scratchpad/2026-07-31-common-swarm-handoff/RUNTIME-D-RESULT.md`
with: the CLI surface implemented, the reducer hardening and its red-then-green proof, every other
red-then-green proof, the commit-time frozen-file proof, all gate counts and elapsed times, the
zero-process proofs, and the new SHA.

## Non-goals

No deploy, tag, release, or version bump. No migration or edge-function change. No swarm join or
status set — you share the Lead's cmux surface and would overwrite the Lead's status. No broadcast,
no `AdvisorClaude2`. Do not "improve" anything outside the owned paths.

## Stop conditions

Preflight fails · a change appears to require editing a frozen file · a test cannot be made red before
its fix · any guarded suite regresses · residual processes survive · scope grows beyond owned paths.

State what you did **not** establish: deployment, production behaviour, and real-load capacity are out
of scope.
