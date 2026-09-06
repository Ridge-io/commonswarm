### INVERSION Review (D-036): CommonSwarm Lane L1 (`lane/notify-full-body`, SHA `727f4c44`)

**Review Scope:** Spec Section C1 & Lane Row L1  
**Target Files Inspected:** `src/cloud/arrival-watch.ts`, `src/cli.ts:4048-4058`, `tests/support/arrival-watch.test.ts`

---

### Detailed Findings by Check Item

1. **Does `--json` now carry the whole body, up to 8,000 chars?**
   - **Status:** PASS
   - **Citations:** [src/cloud/arrival-watch.ts:152](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/src/cloud/arrival-watch.ts#L152), [src/cloud/arrival-watch.ts:421](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/src/cloud/arrival-watch.ts#L421), [src/cli.ts:4056](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/src/cli.ts#L4056), [tests/support/arrival-watch.test.ts:243-255](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/tests/support/arrival-watch.test.ts#L243-L255)
   - **Analysis:** `ArrivalNotification` interface now includes `body: string`, populated directly from `signal.body` in `arrivalNotification()`. `runInboxNotifyCommand` serializes `notification` via `JSON.stringify(notification)` when `--json` is set, emitting the complete body alongside `snippet`. The test explicitly validates that an 8,000-character string is preserved without truncation.

2. **Is the readable-line suffix generated from `ARRIVAL_SNIPPET_MAX` and run-time lengths, never typed?**
   - **Status:** PASS
   - **Citations:** [src/cloud/arrival-watch.ts:35](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/src/cloud/arrival-watch.ts#L35), [src/cloud/arrival-watch.ts:360-362](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/src/cloud/arrival-watch.ts#L360-L362), [src/cloud/arrival-watch.ts:365](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/src/cloud/arrival-watch.ts#L365), [src/cloud/arrival-watch.ts:370-377](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/src/cloud/arrival-watch.ts#L370-L377)
   - **Analysis:** `arrivalSnippetWasCut` checks runtime collapsed length against `ARRIVAL_SNIPPET_MAX`. `arrivalSnippetSuffix` dynamically formats string lengths via `notification.snippet.length.toLocaleString("en-US")` and `notification.body.length.toLocaleString("en-US")`, referencing `ARRIVAL_FULL_TEXT_COMMAND`. No hardcoded copy or typed character counts exist in the production logic.

3. **Does the test fail if the constant and the phrase differ?**
   - **Status:** PASS
   - **Citations:** [tests/support/arrival-watch.test.ts:265-266](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/tests/support/arrival-watch.test.ts#L265-L266), [tests/support/arrival-watch.test.ts:277-299](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/tests/support/arrival-watch.test.ts#L277-L299)
   - **Analysis:** The boundary tests construct inputs using `ARRIVAL_SNIPPET_MAX` (`"z".repeat(ARRIVAL_SNIPPET_MAX)` vs `"z".repeat(ARRIVAL_SNIPPET_MAX + 1)`) and assert the suffix against ` (${ARRIVAL_SNIPPET_MAX} of ${ARRIVAL_SNIPPET_MAX + 1} chars; full text: ${ARRIVAL_FULL_TEXT_COMMAND})`. If `arrivalSnippetSuffix` emitted a hardcoded string or if the exported constant moved without updating the phrase generator, the assertions would fail.

4. **Any regression for readers of the readable line or JSON?**
   - **Status:** PASS
   - **Citations:** [src/cloud/arrival-watch.ts:142-155](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/src/cloud/arrival-watch.ts#L142-L155), [src/cloud/arrival-watch.ts:428-435](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/src/cloud/arrival-watch.ts#L428-L435), [tests/support/arrival-watch.test.ts:228-237](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/tests/support/arrival-watch.test.ts#L228-L237)
   - **Analysis:** Existing keys in `--json` output are preserved without schema changes or renames. For readable lines under `ARRIVAL_SNIPPET_MAX`, `arrivalSnippetSuffix` returns `""`, rendering identical output to pre-diff behavior. Single-line terminal output constraints (`output.split("\n").length === 1`) are maintained.

5. **Any claim in a comment or test name that the code does not enforce?**
   - **Status:** PASS
   - **Citations:** [src/cloud/arrival-watch.ts:34](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/src/cloud/arrival-watch.ts#L34), [src/cloud/arrival-watch.ts:359](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/src/cloud/arrival-watch.ts#L359), [src/cloud/arrival-watch.ts:367-369](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/src/cloud/arrival-watch.ts#L367-L369), [tests/support/arrival-watch.test.ts:239-242](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/tests/support/arrival-watch.test.ts#L239-L242), [tests/support/arrival-watch.test.ts:273-276](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/tests/support/arrival-watch.test.ts#L273-L276), [tests/support/arrival-watch.test.ts:301-303](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm-agy/tests/support/arrival-watch.test.ts#L301-L303)
   - **Analysis:** Every assertion, comment, and test description accurately reflects the executable behavior of `arrivalSnippetWasCut`, `arrivalSnippetSuffix`, `arrivalSnippet`, `arrivalNotification`, and `formatArrivalNotification`. All claims are strictly enforced by runtime logic and verified by the test suite.

---

### Summary & Verdict
The diff satisfies all acceptance criteria for Spec C1 and CommonSwarm Lane L1. `--json` carries the full signal body up to 8,000 characters, readable line path phrases are constructed strictly from runtime lengths and constants without typed numbers, and boundary behavior is fully verified by unit tests without regressions.

VERDICT: PASS
