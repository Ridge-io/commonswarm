# Lane L2 `lane/hook-preview-1000` — evidence

Spec: `docs/design/2026-09-06-NO-TRUNCATION.md` (branch `spec/app-backlog` at 7d98f1e), change C2, lane L2.
Author: CSLaptopLead listener worker (Claude), toms-m1-max-mbp, 2026-09-06.

| item | value |
|---|---|
| code SHAs | 14720f36 (feature), 5ab774f7 (two nits from the round-1 Grok arm: attachments line uses `HOOK_FULL_TEXT_COMMAND`; 100-item test renamed). Files: `src/listener/hook.ts`, `tests/p1-cli/hook-routing.test.ts` |
| gate | `tests/p1-cli/hook-routing.test.ts` is reached by the `npm run test:p1-cli` glob, not the literal `npm test` list. Logs: `gate-test-p1-cli.log` (489/489), `gate-npm-test.log` (893/893), `check:tests` clean |
| round 1 on 14720f36 | Grok exact `arm-grok-exact-14720f36.md` PASS with three nits (a first Grok run on the full-spec prompt hit the 10-minute ceiling with no verdict and was discarded); Gemini inversion `arm-agy-inversion-14720f36.md` PASS |
| round 2 on 5ab774f7 | Grok exact `arm-grok-exact-5ab774f7.md` `VERDICT: PASS`; Gemini (agy) inversion `arm-agy-inversion-5ab774f7.md` `VERDICT: PASS` |
| Codex gpt-5.6-sol arm | asked of CSwarmStrategist with branch + SHA 5ab774f7 (no codex on the laptop) |
| write canary | `write-canary.md`, commit ff0393f0 |

## Corrections to the spec, all confirmed by both arms

- C2 says the surface is bounded by `MAX_HOOK_SURFACE_BYTES`. That constant caps the `hook-surface.json` state-file read (`readSecureJsonFile` calls), not stdout. Before this lane no bound applied to rendered previews at all. The render budget is the new `HOOK_RENDER_BUDGET_BYTES`, same value, separate meaning.
- The preview now shows the first `cap` characters then an ellipsis (before: `cap - 1`), so the suffix's N equals `length - cap` exactly. "Characters" are UTF-16 units, the unit of `String.length`; the budget is UTF-8 bytes.
- The tier walk reserves every later item's two-line floor. Without that reservation the bound did not hold (measured: first test run overflowed).
- C2 says the test asserts all three tiers on the 100-item page. On that page the walk drops from 1,000 straight to the floor because the headroom at the drop point is under a 240-tier block, so the 240 tier does not appear there (Grok measured 56 / 0 / 44). The small-budget test pins all three tiers in order; the 100-item test pins top tier first, floor reached, monotone walk, bound, exact N.

## Not established

- No live hook stdout was measured (no `UserPromptSubmit` run against a real listener).
- The floor-overflow path (floors alone exceed the budget) is described in the code comment and not covered by a test; with 100 items the floors are about 15 KB against a 128 KiB budget.
- The Codex arm.
