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
| `production-delta-exact-review-PASS-1-major.md` | Exact review of the ~1,932-line production/edge/migration delta | **PASS**, 1 MAJOR + 3 MINOR open |
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

Runtime C/D, the version freeze to 0.1.5, the full exact-SHA gate, the release-candidate two-arm
review, landing to `main`, deployment, production behaviour, the authenticated production QA journey,
the real two-human cross-owner canary, or the longevity canaries.

~~**Known open gap at time of writing:** every D-036 arm recorded above is scoped to a *test* delta.
The production/edge/migration code the release will deploy is under separate review; until that lands
here, it is unreviewed.~~ **Closed 2026-08-03** by
`production-delta-exact-review-PASS-1-major.md`, which reviewed the full ~1,932-insertion delta
statically and returned PASS with no CRITICAL. The migration was proven additive — no `DROP`, no
destructive `ALTER`, no type narrowing, no existing-row rewrite — with forced RLS, and `PUBLIC`,
`anon`, `authenticated`, and `swarm_read` given **no table authority**.

**Open before freeze:** that review left one MAJOR and three MINOR findings, all in new-in-0.1.5
delivery surface. The MAJOR is that a claim replay can return a **different** `sender_owner_relation`
than the original claim, because hydration recomputes the relation instead of returning the value the
ledger already stored. Since that field drives host wake and tool policy, an idempotent replay could
silently change an isolation decision. All four are being corrected before the version freeze, while
there is still no deployed client to break. The cross-family inversion arm on this delta has not yet
run.
