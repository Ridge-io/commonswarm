# Lane L1 `lane/notify-full-body` — evidence

Spec: `docs/design/2026-09-06-NO-TRUNCATION.md` (branch `spec/app-backlog` at 7d98f1e), change C1, lane L1.
Author: CSLaptopLead listener worker (Claude), toms-m1-max-mbp, 2026-09-06.

| item | value |
|---|---|
| code SHA reviewed | 727f4c44 (`src/cloud/arrival-watch.ts`, `tests/support/arrival-watch.test.ts`) |
| gates on 727f4c44 | `npm test` 897/897; `npm run test:p1-cli` 483/483; `npm run check:tests` clean |
| Grok exact arm | `arm-grok-exact-727f4c44.md`, `VERDICT: PASS`, grok 1.0.5 |
| Gemini inversion arm | `arm-agy-inversion-727f4c44.md`, `VERDICT: PASS`, agy 1.1.27 |
| Codex gpt-5.6-sol arm (run by CSwarmStrategist on the mini, signal 8e5aace9) | `arm-codex-sol-727f4c44.md`, `VERDICT: FAIL` on spec wording: C1's raw-length trigger and "ends with" suffix. Spec owner's ruling: both are wording mismatches, the code's behaviour is the better one; C1 corrected on `spec/app-backlog` at c6f1df2 (draft 7). No code change. |
| gate logs on the reviewed tree | `gate-npm-test.log`, `gate-test-p1-cli.log` (added after the Codex arm named their absence as a gap) |
| write canary | `write-canary.md`, commit 0d4d0b63 |

## Deviations from C1 prose, both noted by the Grok arm

- The cut condition is "the one-line (whitespace-collapsed) body exceeds `ARRIVAL_SNIPPET_MAX`", not raw `body.length`. At the spec's required pair (exactly MAX / MAX+1 plain chars) both agree. A body over the cap only because of runs of whitespace is not cut and gets no phrase; a test pins that.
- The phrase follows the snippet, before attachments and the reply command, so the line still ends with `cswarm reply …`.

## Not established

- No live `cswarm inbox --notify --json` process was run; the test stringifies the same object `src/cli.ts:4055-4056` prints.
- Whether a phone OS notification clips the readable line further.
- The evidence commits were made after the arms ran; the arms reviewed 727f4c44, and the later commits change only `docs/evidence/`.
