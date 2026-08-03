# v0.1.5 execution evidence — 2026-08-02/03

Durable evidence for the v0.1.5 release run. `scratchpad/` is gitignored, so anything here is the
re-readable copy; a completion claim whose evidence cannot be re-read later is not evidence.

Plan of record: `docs/design/2026-08-02-V015-MASTER-PLAN.md` (rev 2).
Review gate in force: **D-036** (`docs/org/DEFECT-REGISTER.md`) — Grok is credit-exhausted, so the
two arms are one exact review (Codex or Claude) plus one different-family inversion (Gemini via
`agy`, or Kimi K3 via Pi). The two-arm requirement itself is unchanged.

> **Correction, 2026-08-03.** The first version of this index said Server Phase B was *blocked* and
> Runtime A2 *incomplete*, and listed 2 of the files present. Both statements were true when written
> and **false within hours**. A fresh lead reading the index first would have reconstructed the wrong
> state. The superseded lines — *"| `server-phase-b-exact-audit-BLOCK.md` | … | **BLOCK** |"* and
> *"Phase B acceptance (blocked), Runtime A2 acceptance (controls incomplete at time of writing)"* —
> are **dead**. An index that lags its directory is worse than no index, because it is trusted.

## Contents

| File | What it records | Verdict |
|---|---|---|
| `a2-causal-controls-round1.md` | First causal-control round on Runtime A2 `ab1b240` | Incomplete — stopped at control 1 |
| `a2-causal-controls-round2-DISCRIMINATES.md` | Round 2 with per-file isolation + external watchdog | **Suite discriminates all 3 invariants** |
| `a2-d036-inversion-arm-gemini-PASS.md` | D-036 inversion arm on `ab1b240` | **PASS** |
| `server-phase-b-exact-audit-BLOCK.md` | Exact audit of Phase B at `d972c3f` | **BLOCK** (superseded by the repair below) |
| `server-phase-b-control2-repair-PASS.md` | The repair at `5f5018a` | **PASS** |
| `server-phase-b-d036-inversion-arm-gemini-PASS.md` | D-036 inversion arm on `5f5018a` | **PASS** |
| `server-phase-c-PASS.md` | Phase C at `e3dc295` | **PASS** |
| `server-phase-c-d036-inversion-arm-gemini-PASS.md` | D-036 inversion arm on `e3dc295` | **PASS** |
| `union-db-suites-PASS.md` | All DB suites on the merged union `8852ce8` | **PASS** |
| `production-delta-exact-review-PASS-1-major.md` | Exact review of the ~1,932-line production/edge/migration delta | **PASS**, 1 MAJOR + 3 MINOR |
| `delivery-review-fix-PASS.md` | All four findings corrected at `df2f4c9`, red-then-green | **PASS** |
| `delivery-review-fix-d036-inversion-arm-gemini-PASS.md` | D-036 inversion arm on `df2f4c9` | **PASS** |
| `lead-exact-arm-records.md` | The Lead's D-036 **exact arms** for ab1b240 / 5f5018a / e3dc295 / df2f4c9, written down after the fact | **PASS** ×4 |
| `runtime-c-PASS.md` | Runtime C at `f30974a` (builder report) | worker record |
| `runtime-c-fixture-repair-VERIFIED-PARTIAL.md` | Lead's independent mutant test of work item 1 | **PARTIAL** |
| `runtime-c-d036-inversion-arm-gemini-PASS.md` | D-036 inversion arm on `f30974a` | **PASS** |
| `runtime-d-PASS.md` | Runtime D at `0f5bbcf` (builder report) | worker record |
| `runtime-d-d036-inversion-arm-gemini-PASS.md` | D-036 inversion arm on `0f5bbcf` | **PASS** |
| `production-delta-d036-inversion-arm-gemini-PASS.md` | Inversion arm on the full production surface | **PASS** |
| `stage-q-authenticated-qa.md` | Stage Q production QA (in progress) | **QA-008, QA-009, QA-010 (MAJOR), QA-011 (MAJOR)**; GitHub-OAuth sign-in proven, magic link outstanding |
| `qa-010-test-gating.md` | QA-010 regressions moved into the gated site suite (89 → 94) | **PASS** |
| `production-baseline-pre-deploy.md` | Production state recorded before any mutation | baseline |

Binding contracts each PASS above cites now live in `docs/design/contracts/` — they were previously
gitignored, which meant every recorded verdict referenced a document a fresh lead could not read.

## Accepted SHAs and where they landed

| Artifact | Accepted SHA | Landed on Lead |
|---|---|---|
| Runtime A2 | `ab1b240` | merge `92d1c79` |
| Server Phase B | `5f5018a` | via the server merge |
| Server Phase C | `e3dc295` | merge `8852ce8` |
| Integration union | — | `8852ce8` (27 test paths, 343/343 pure) |

## The lessons worth carrying forward

**1. A green control is not evidence; only a mutant printing red is.** Phase B was blocked because
its invariant-2 control stayed green when the predecessor's exact defect was reintroduced. The
production logic was already correct — the *instrument* was broken. Its predecessor had shipped four
failure-path defects behind focused 8/8 and full 67/67.

**2. `--test-timeout` cannot bound a microtask-starved test.** Node enforces it with a timer in the
same process; under the Runtime A2 mutant the runtime loop becomes an infinite microtask-only spin,
so the timers phase never runs. Only an external wall-clock watchdog bounds it, and only per-file
isolation preserves the other file's counts.

**3. Presence is not progress.** Two review workers sat at **0.15 s of CPU** while appearing to run —
`codex exec` appends piped stdin as a `<stdin>` block and blocks until it closes. Check CPU time, not
process existence.

**4. A guard grep that is too broad blocks real work.** `pgrep -f 'supabase|postgres|deno'`
false-positives on other fleets sharing this machine. Match precisely
(`test:p1-server|test:p1-local|supabase functions serve`).

**Consequence for Stage 7,** which re-proves that the named causal controls still discriminate: run
them with per-file isolation and an external watchdog, treat a green mutant as a mandatory stop, and
enumerate the controls rather than counting them approximately.

## What this directory does not establish

~~Runtime C/D,~~ *(both accepted 2026-08-03 — dead)* the version freeze to 0.1.5, the full exact-SHA
gate, the release-candidate two-arm review, landing to `main`, deployment, production behaviour, the
**authenticated** production QA journey, the real two-human cross-owner canary, or the longevity
canaries.

**M4 verdict, 2026-08-03: DO-NOT-FREEZE yet.** Open before Stage 6: the authenticated QA session
(operator-assisted), QA-008's fix landing, Lane R reconciliation, and this index staying current.
The discriminator M4 gave for what must be pre-freeze is worth repeating: **anything whose failure
would require a code change**, because only those restart the review chain.

~~**Known open gap at time of writing:** every D-036 arm recorded above is scoped to a *test* delta.
The production/edge/migration code the release will deploy is under separate review; until that lands
here, it is unreviewed.~~ **Partially closed 2026-08-03** by
`production-delta-exact-review-PASS-1-major.md`, which reviewed the full ~1,932-insertion delta
statically and returned PASS with no CRITICAL. ~~Closed.~~ That is **one arm, not two**: no
cross-family inversion has run at that scope. The Gemini inversions on file cover the four
corrections and the per-lane test deltas only. Under D-036 one arm is never sufficient, so the
full-delta inversion must run before landing. The migration was proven additive — no `DROP`, no
destructive `ALTER`, no type narrowing, no existing-row rewrite — with forced RLS, and `PUBLIC`,
`anon`, `authenticated`, and `swarm_read` given **no table authority**.

**All four findings are now corrected at `df2f4c9`**, both D-036 arms PASS. The MAJOR was that a
claim replay could return a **different** `sender_owner_relation` than the original claim, because
hydration recomputed the relation instead of returning the value the ledger already stored — and that
field drives host wake and tool policy, so an idempotent replay could silently change an isolation
decision. Each correction was proven RED before and GREEN after (4 targeted tests, 0/4 -> 4/4). The
migration was not touched, so its additive/RLS finding still stands.

Worth keeping: finding 4 named two separate call sites, and the fix removed the delivery markers from
the shared capability constant instead of patching each site — so the foreign-workspace path stopped
advertising automatically. Solve at the layer all paths flow through.
