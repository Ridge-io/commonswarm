I'll review this SHA against C2 and L2: read the spec, hook renderer, and tests, then check the author's deviations rather than accept them.I'll check the spec, the prior arm nits, attachment rendering, and whether any remaining typed copy or call sites still miss the new bound.Exact review of `5ab774f7` against C2 / L2. I read `hook.ts` and the new tests. I did not run the suite.

Deviations **(a)–(d)** are true.

**(a)** `MAX_HOOK_SURFACE_BYTES` (`hook.ts:46`, used `:302`, `:317`, `:332`, `:365`) only caps the `hook-surface.json` read. Rendered text had no cap. `HOOK_RENDER_BUDGET_BYTES` (`:78`) is the same `128 * 1024` with a new meaning. The split is right.

**(b)** `preview()` (`:647-649`) keeps a body at or under `cap` whole. Over the cap it shows `slice(0, cap)` plus `…` inside JSON. `N = text.length - cap`. That `N` is exact.

**(c)** `renderHookSignals` (`:700-706`) reserves each later item's two-line floor. Without that, a 100-item 4-byte page would overflow. The bound holds when the floors fit. If they do not, `:720-727` still pushes at the last tier (`:690-692`).

**(d)** The 240 tier cannot appear on the default 100-item 4-byte page (the drop skips it). The small-budget test (`hook-routing.test.ts:1918-1957`) pins 1,000 then 240 then 0. The 100-item test (`:1974-1998`) pins top tier first, floor reached, monotone walk, bound, exact `N`.

**(1)** Suffix math: `hidden = text.length - cap` (`hook.ts:648`). `hookPreviewSuffix` (`:653-655`) fills `N` and `HOOK_FULL_TEXT_COMMAND` (`:80`). Tests use `body.length - cap` (`:1897`, `:1952`, `:1997`). `:1898` snapshots the format with typed `1000` and `cswarm inbox`. That pins the words. Product copy is generated.

**(2)** No suffix at or under the cap: `:647`. Tests: `:1900-1905`.

**(3)** Body goes through `JSON.stringify`. The suffix sits after the closing quote (`:649`). Cut hostile text: `:1910-1916`. Uncut: `:1875-1885`. Attachments line uses `HOOK_FULL_TEXT_COMMAND` (`:678`).

**(4)** Every item is pushed (`:727`). The walk stops at the last tier (`:722`). The 100-item page stays under `HOOK_RENDER_BUDGET_BYTES` (`:1984`). The floor-overflow path is in the comment, not in a test.

**(5)** Hook call: `:987` `renderHookSignals(staged.unseen).blocks`. Join at `:1027` is `"\n\n"`, same as `HOOK_BLOCK_SEPARATOR` (`:683`). No other `src/` preview renderer. Inbox page is still `limit: 100` (`:780`).

**(6)** Round-2 nits are fixed (attachments constant; test name `:1974` no longer says every tier). Commit message matches. Gate is the `test:p1-cli` glob, as L2 said.

I did not measure live hook stdout.

VERDICT: PASS
