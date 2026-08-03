# v0.1.5 execution evidence — 2026-08-02

Durable evidence for the v0.1.5 release run. `scratchpad/` is gitignored, so anything here is the
re-readable copy; a completion claim whose evidence cannot be re-read later is not evidence.

Plan of record: `docs/design/2026-08-02-V015-MASTER-PLAN.md` (rev 2).
Review gate in force: **D-036** (`docs/org/DEFECT-REGISTER.md`) — Grok is credit-exhausted, so the
two arms are one exact review (Codex or Claude) plus one different-family inversion (Gemini via
`agy`, or Kimi K3 via Pi). The two-arm requirement itself is unchanged.

## Contents

| File | What it records | Verdict |
|---|---|---|
| `server-phase-b-exact-audit-BLOCK.md` | Independent exact audit of Server Phase B `d972c3f` by Girder (Codex), holding the exclusive DB slot | **BLOCK** |
| `a2-causal-controls-round1.md` | First causal-control round on Runtime A2 `ab1b240` by Vellum (Codex) | Incomplete — stopped at control 1 |

## The two findings worth carrying forward

**1. Server Phase B is blocked by a non-discriminating instrument, not by bad production code.**
All four invariants are satisfied in the source. But invariant 2's causal control stayed **green
(1/1)** when the predecessor's defect was reintroduced — reverting the monotonic deadline to
`Date.now()` plus an unconditional 50 ms sleep. A control that passes when the defect it exists to
catch is put back proves nothing. This is the same shape as D-025/D-030: a probe that cannot fail is
indistinguishable from one that passed. The candidate's predecessor shipped four failure-path
defects behind focused 8/8 and full 67/67 — which is exactly why source inspection was made
mandatory here rather than optional.

**2. `--test-timeout` cannot bound a microtask-starved test.** Runtime A2's control 1 printed three
named engine-side failures, then the runtime test file wedged past `--test-timeout=8000` and left two
processes to SIGTERM. Node enforces that timeout with a timer *in the same process*; under the
mutant the runtime loop becomes an infinite microtask-only spin, so the timers phase never runs and
the timeout structurally cannot fire. Only an external wall-clock watchdog bounds this.

**Consequence for Stage 7:** the release gate re-proves that ~11 named causal controls still
discriminate. Both lessons apply there. Causal controls must be run with **per-file isolation and an
external watchdog**, and "the control passed" is never evidence — only "the mutant printed red" is.

## What this directory does not establish

Phase B acceptance (blocked), Runtime A2 acceptance (controls incomplete at time of writing), Phase
C, Runtime C/D, the integrated union, v0.1.5, deployment, or any production behaviour.
