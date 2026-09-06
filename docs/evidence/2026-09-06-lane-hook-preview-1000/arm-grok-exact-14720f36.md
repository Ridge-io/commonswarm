I'll read the spec, `hook.ts`, the tests, and the lane row, then check the six review items against the diff.I have the renderer. Next I will read the tests, the other call sites, and how the hook joins blocks.C2 and L2 match this tree. Deviations (a)–(d) are true. I did not run the test suite.

**(a)** `MAX_HOOK_SURFACE_BYTES` is only the `hook-surface.json` read cap (`hook.ts:46`, `:302`, `:317`, `:332`, `:365`). Rendered text had no cap. `HOOK_RENDER_BUDGET_BYTES` (`:78`) is the new stdout cap. Same 128 KiB. Separate meaning.

**(b)** `preview()` (`:645-650`) keeps a body at or under `cap` whole. A longer body shows the first `cap` chars, then `…` inside the JSON, then N = `length - cap`. That N is exact.

**(c)** `renderHookSignals` (`:695-731`) keeps the two-line floor of every later item. Without that, a 100-item 4-byte page goes over the cap. The cap holds when the floors fit.

**(d)** On the default 100-item page I measured 56 at 1,000, **0 at 240**, 44 at 0. The 240 tier cannot show there. The small-budget test (`hook-routing.test.ts:1918-1957`) pins all three tiers.

**(1)** Suffix math: `hidden = text.length - cap` (`hook.ts:648-649`). `hookPreviewSuffix` (`:653-655`) fills N and `HOOK_FULL_TEXT_COMMAND` (`:80`). Tests use `body.length - cap` (`:1897`, `:1952`, `:1997`). `:1898` types the format string `"[… 1000 more chars — cswarm inbox]"` instead of building it from those constants.

**(2)** No suffix at or under the cap: `:647`. Tests: `:1900-1905`.

**(3)** Sender and body go through `JSON.stringify`. The suffix sits after the closing quote (`:649`). Cut case: `:1910-1916`. Uncut case: `:1875-1885`.

**(4)** Every item is pushed (`:727`). The walk stops at the last tier (`:720-726`). If floors alone exceed the budget, the overflow is the floors. That path is in the comment (`:690-692`) and in the code. No test gives a budget below the floor sum.

**(5)** The hook call is `hook.ts:987`. The join at `:1027` uses the same `"\n\n"`. No other `src/` caller renders these previews.

**(6)** Nits, not defects:
- Commit says `hook-routing.test.ts` is in the `npm test` list. `package.json:23` does not name it. The gate is the `test:p1-cli` glob. Spec L2 already said that.
- Test name `:1974` says “every tier”. The 240 tier is not on that page.
- Attachment line `:678` still types `cswarm inbox` next to `HOOK_FULL_TEXT_COMMAND`.

VERDICT: PASS
