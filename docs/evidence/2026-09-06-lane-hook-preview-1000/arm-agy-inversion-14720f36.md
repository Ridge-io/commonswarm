An INVERSION review (D-036) was conducted on CommonSwarm lane L2 (`lane/hook-preview-1000`, SHA `14720f363c21e71fa398031abece27b1859ca5a2`) against spec section "C2" and lane row "L2".

### Findings & Verification Summary

1. **Suffix Arithmetic & Constants**:
   - `hookPreviewSuffix(hiddenChars)` in [src/listener/hook.ts:653-655](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm2-agy/src/listener/hook.ts#L653-L655) uses runtime calculation `${hiddenChars}` (`text.length - cap`) and constant `${HOOK_FULL_TEXT_COMMAND}` (`"cswarm inbox"`). No typed copy or magic numbers exist in the rendered output string.
   - Author deviation (b) confirmed: slicing `text.slice(0, cap)` shows `cap` characters followed by `…`, so `hidden = text.length - cap` is exact.

2. **No Suffix Under Cap**:
   - In `preview()` [src/listener/hook.ts:647](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm2-agy/src/listener/hook.ts#L647), `if (text.length <= cap) return JSON.stringify(text);` guarantees no suffix is appended when the text fits.
   - Verified by tests in [tests/p1-cli/hook-routing.test.ts:1889-1907](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm2-agy/tests/p1-cli/hook-routing.test.ts#L1889-L1907) for bodies under and at `HOOK_BODY_PREVIEW_CHARS`.

3. **Hostile Text & JSON Quoting**:
   - Untrusted body text is sliced and passed to `JSON.stringify(`${text.slice(0, cap)}…`)` [src/listener/hook.ts:649](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm2-agy/src/listener/hook.ts#L649), ensuring all body characters (including control characters and newlines) stay JSON-escaped inside quotes.
   - Suffix `[… N more chars — cswarm inbox]` is placed strictly outside the JSON string literal.
   - Verified by test in [tests/p1-cli/hook-routing.test.ts:1909-1915](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm2-agy/tests/p1-cli/hook-routing.test.ts#L1909-L1915).

4. **Byte Bound & No-Drop Guarantee**:
   - Author deviation (a) confirmed: `MAX_HOOK_SURFACE_BYTES` (128 KiB) caps state file read [src/listener/hook.ts:46](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm2-agy/src/listener/hook.ts#L46), while `HOOK_RENDER_BUDGET_BYTES` (128 KiB) [src/listener/hook.ts:78](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm2-agy/src/listener/hook.ts#L78) bounds rendered text per check.
   - Author deviation (c) confirmed: `renderHookSignals` [src/listener/hook.ts:695-732](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm2-agy/src/listener/hook.ts#L695-L732) calculates `reserveAfter[index]` (sum of two-line floors for all subsequent items plus separators) to guarantee the byte bound holds as long as floors fit.
   - No item is ever omitted from `blocks` (`blocks.length === items.length`); if floors alone exceed the budget, items render at tier 0 (`HOOK_BODY_PREVIEW_CHARS_NONE`) without dropping signals.

5. **Call Site**:
   - `checkListenerHooks` in [src/listener/hook.ts:987](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm2-agy/src/listener/hook.ts#L987) calls `blocks.push(...renderHookSignals(staged.unseen).blocks);`. All signal render paths go through `renderHookSignals`.

6. **Claims & Tests Enforcement**:
   - Author deviation (d) verified: [tests/p1-cli/hook-routing.test.ts:1923-1968](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm2-agy/tests/p1-cli/hook-routing.test.ts#L1923-L1968) tests all 3 tiers explicitly under a small budget, and [lines 1970-1994](file:///Users/tom/Developer/Ridge.io/commonswarm/scratchpad/listener-65415/arm2-agy/tests/p1-cli/hook-routing.test.ts#L1970-L1994) validates monotone walk, floor fallback, and byte bound adherence for a 100-item page.
   - Full test suite execution (`npm run test:p1-cli`) passed cleanly (489 passing tests).

VERDICT: PASS
