- DEFECT — `src/cloud/arrival-watch.ts:361`: C1 requires `body.length > ARRIVAL_SNIPPET_MAX`. The code checks collapsed length. A 350-character body can produce no suffix. `tests/support/arrival-watch.test.ts:301` locks this mismatch.
- DEFECT — `src/cloud/arrival-watch.ts:434`: C1 requires the readable line to end with the full-text phrase. It ends with the reply command. `tests/support/arrival-watch.test.ts:269` locks this mismatch.
- GAP — `docs/evidence/2026-09-06-lane-notify-full-body/README.md:9`: no saved logs support the historical gate counts. I confirmed 897 tests are reachable and `check:tests` passes. This sandbox blocked the full gate from creating temporary folders.

The JSON body, generated lengths, MAX/MAX+1 boundary, file scope, and D-053 check pass.

QUOTE-BACK: # Stop truncating in the human UI
VERDICT: FAIL
REASON: C1’s raw-length trigger and end-of-line suffix requirements are both contradicted by the implementation and its tests.
