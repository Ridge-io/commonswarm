# Lane L1 `lane/notify-full-body` — evidence

Spec: `docs/design/2026-09-06-NO-TRUNCATION.md` (branch `spec/app-backlog` at 7d98f1e), change C1, lane L1.
Author: CSLaptopLead listener worker (Claude), toms-m1-max-mbp, 2026-09-06.

| item | value |
|---|---|
| code SHA reviewed | 727f4c44 (`src/cloud/arrival-watch.ts`, `tests/support/arrival-watch.test.ts`) |
| gates on 727f4c44 | `npm test` 897/897; `npm run test:p1-cli` 483/483; `npm run check:tests` clean |
| Grok exact arm | `arm-grok-exact-727f4c44.md`, `VERDICT: PASS`, grok 1.0.5 |
| Gemini inversion arm | `arm-agy-inversion-727f4c44.md`, `VERDICT: PASS`, agy 1.1.27 |
| Codex gpt-5.6-sol arms on 727f4c44: TWO ran in parallel on the mini | `arm-codex-sol-high-727f4c44.md` (this lane's copy, attached to signal 8e5aace9, **high** effort): `VERDICT: FAIL` on the two C1 wording items (raw-length trigger, "ends with" suffix); the spec owner resolved those in `spec/app-backlog` c6f1df2 (draft 7). The strategist's **xhigh** run lives on `main` at `docs/evidence/2026-09-06-strategist-arms/arm-codex-sol-xhigh-727f4c44.md`: it graded the wording items down and FAILED on a third finding, the bare `cswarm inbox` remedy, which c6f1df2 does not touch and which stayed open until round 2 fixed it in code. The retired one-line summary "Codex FAIL on spec wording, resolved by spec correction c6f1df2, no code change" was true of the high copy only. |
| gate logs on the reviewed tree | `gate-npm-test.log`, `gate-test-p1-cli.log` (added after the Codex arm named their absence as a gap) |
| write canary | `write-canary.md`, commit 0d4d0b63 |

## Round 2: code SHA daebc48d (after the Codex FAIL upheld by CSwarmDevLead, main 95530e1)

| item | value |
|---|---|
| change | `arrivalFullTextCommand(workspaceId)` replaces the `ARRIVAL_FULL_TEXT_COMMAND` constant: the phrase now names `cswarm inbox --workspace-id <ws>`, the route the reply command names, because an agent identity comes only from its credential flags and then requires a workspace. Credential and target flags stay off the line for the reason recorded on `arrivalReplyCommand`. |
| tests | `tests/support/arrival-watch.test.ts`: the command's flag set equals the reply command's and contains `--workspace-id`; `tests/p1-cli/arrival-notify.test.ts`: the owed control runs the real `cswarm inbox --notify --json` against a loopback read service and asserts `body` equals the posted body, then the readable line's command names the workspace (in the `test:p1-cli` glob and the literal `npm test` list). |
| gates at daebc48d | `npm run test:p1-cli` 490/490; `npm test` 898/898 on three consecutive runs (`gate-*.log`). One earlier run of `npm test` at this SHA reported 2 failures while an unrelated Chrome-driven site suite was running on the same laptop; the failing names were not captured, so that run is recorded here and not explained. |
| Grok exact arm | `arm-grok-exact-daebc48d.md`, `VERDICT: PASS` |
| Gemini (agy) inversion arm | `arm-agy-inversion-daebc48d.md`, `VERDICT: PASS` |
| Codex gpt-5.6-sol arm | Codex arm not run, usage limit; operator ruling 2026-09-06: Codex is unavailable until the weekly reset at 21:00 CDT, so no Codex arm before then. Operator ruling 2026-09-06 (ask 460e3451): Grok and Gemini (agy) suffice as the D-036 pair; the lane owes no Codex arm and proceeds to land. The strategist's first-hand verification of the fix (controls on the mini, cswarm 0.1.60: the old phrase failed twice over; the new phrase is at exact parity with the shipped `cswarm reply` line) is on `main` at `docs/evidence/2026-09-06-strategist-arms/lead-verification-daebc48d.md`; their controls on e025f562: test:p1-cli 490/0, npm test 898/0. |
| merge | `origin/main` (ee61b377, L2 landed) merged in before the change |
| trailers | every lane commit was rewritten once on 2026-09-06 to carry the Agent-* trailers (the clone had no commit hook); content is unchanged (`git diff` between old and new tips is empty), so the arms above still apply to the same diffs. The SHAs named in this README predate that rewrite; the lane note carries the post-rewrite SHAs. |

Spec owner's ruling on round 1 (draft 7, `spec/app-backlog` c6f1df2): the collapsed-length trigger and the suffix placement are accepted; C1's wording was corrected, not the code.

## Deviations from C1 prose (round 1), both noted by the Grok arm

- The cut condition is "the one-line (whitespace-collapsed) body exceeds `ARRIVAL_SNIPPET_MAX`", not raw `body.length`. At the spec's required pair (exactly MAX / MAX+1 plain chars) both agree. A body over the cap only because of runs of whitespace is not cut and gets no phrase; a test pins that.
- The phrase follows the snippet, before attachments and the reply command, so the line still ends with `cswarm reply …`.

## Not established

- No live `cswarm inbox --notify --json` process was run; the test stringifies the same object `src/cli.ts:4055-4056` prints.
- Whether a phone OS notification clips the readable line further.
- The evidence commits were made after the arms ran; the arms reviewed 727f4c44, and the later commits change only `docs/evidence/`.
