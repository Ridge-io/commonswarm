# Evidence — Slice 2: `command` Edge Function (handle_command)

**Task:** `p1-command-api` · **Commit:** `d825fb2` (on `main`) · **Implementer:** Mason [codex]
**Independently verified by:** Lead (Lead2), 2026-07-23 — by execution, not self-report (§3 landmine: verify every worker claim).

## What was built
`supabase/functions/command/index.ts` (1582 lines) — a Deno Edge Function holding one
Postgres transaction as role `swarm_command`, executing the §3.2 15-step check order and
calling the **unmodified** `applyCommand()`/`decide()`/`reduceTask()` from `src/protocol`
for the 8 P0 task commands (create/acquire/renew/handoff/takeover/submit/close/reopen).

The core is consumed via `supabase/functions/_shared/protocol.js`, an **esbuild bundle
generated from `src/protocol/index.ts`** (`npm run build:command-core`; `pretest:p1-server`
regenerates it before every integration run). No hand-written second implementation — the
§3.1 "one `decide()`" invariant is preserved by generation, not discipline.

## Independent verification (Lead re-ran everything)

| Check | Command | Result |
|---|---|---|
| Frozen core untouched | `git diff --stat e8056ed..d825fb2 -- src/protocol/` | **empty** ✓ |
| Bundle = zero drift | `npm run build:command-core` then `git diff protocol.js` | **byte-identical to committed** ✓ |
| Types | `npx tsc --noEmit` | **clean** ✓ |
| P0 core suite | `npm test` | **38/38 pass** ✓ |
| Integration (live local stack) | `npm run test:p1-server` | **7/7 pass** ✓ |

Integration scenarios (all green against the running local Supabase stack):
- **T-01** cross-tenant + nonexistent workspace → byte-identical uniform 403, zero B-rows
- **T-02** forged `actor_*`/`device` fields ignored at the envelope boundary
- **T-03** stale-epoch close → exactly one ledgered domain `CommandRejected`
- **T-05/T-06** accepted replay verbatim + `command_id` reuse with different hash → 409
- **T-10** concurrent acquire, **50 race iterations**, exactly one winner every time
- **T-11** domain-rejection replay preserves the original StoredResponse
- **unknown-task** command (never-created task_id) → history-only + replayable (pins decision #65)

Invariants **I1–I5** asserted after scenarios via `assertInvariants()`, which folds raw
`swarm.events` through the frozen `reduceTask`/`requestHash` and compares to the DB
projection/ledger (the §10 R1 drift tripwire): I1 projection≡fold, I2 gapless seqs =
head_seq, I3 tenant-column pinning, I4 ledger holds only accepted/domain with recomputed
request_hash, I5 attribution (actor_user non-null, agent stamps join to run/principal).

## Scope boundaries (decision #62/#63/#64/#65)
- Minimum task-authority path only; auth = real-but-minimal (JWT verify + `swm_agt_` hash).
- **Deferred to slice 2b:** T-04 grant double-spend + T-07 revoke-mid-flight tests; §3.4
  workspace-authority commands (seeded via service_role fixtures for now); rate limiting.
- **Deferred to slice 3:** real PKCE login + CLI client.
- **Not yet done:** apply of the command function against **hosted** Supabase (dogfood
  item #1) — local-stack verified only.

## Dogfood tracker (§0b — 4 things needed together)
1. schema applies on hosted Supabase — *slice 1 verified on real PG; hosted apply pending*
2. `handle_command()` wrapping `decide()` — **DONE + VERIFIED (this slice)**
3. PKCE login + CLI sending real commands — *slice 3, not started*
4. §9 launch-gate green against real DB — *7 of the launch-blocking dozen + I1–I5 green on local; T-04/07/08/09/12 + remainder pending*
