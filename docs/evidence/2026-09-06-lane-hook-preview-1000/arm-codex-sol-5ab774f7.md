DEFECT `tests/p1-cli/hook-routing.test.ts:1974` — C2 requires all three tiers on the 100-item four-byte page. The test permits the 240 tier to be absent. Measured result: 56 / 0 / 44. The six-item test does not satisfy this acceptance rule.

DEFECT `docs/evidence/2026-09-06-lane-hook-preview-1000/README.md:9` — it cites two gate logs that are absent from the evidence directory.

Verified:

- `MAX_HOOK_SURFACE_BYTES` only capped state-file reads before and after the lane.
- The old preview showed `cap - 1` characters. The new preview shows `cap`.
- Later-item floor reservation is implemented.
- Tier suffix arithmetic uses each item’s applied cap.
- The rendered blocks are measured with UTF-8 byte length.
- User copy gets its command from `HOOK_FULL_TEXT_COMMAND`.
- The test is reached by the `test:p1-cli` glob. The four selected tests passed.
- No D-053 `error.message` branch was added.
- The code delta is limited to `src/listener/hook.ts` and `tests/p1-cli/hook-routing.test.ts`; later commits add only evidence.

QUOTE-BACK: # Stop truncating in the human UI
VERDICT: FAIL
REASON: The lane removes the required 100-item three-tier assertion and cites gate logs that are not present.
