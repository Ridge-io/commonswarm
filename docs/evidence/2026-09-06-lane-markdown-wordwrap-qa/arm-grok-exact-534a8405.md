I'll read the full review brief, then the spec-named files in this tree.The observer is in. Next I’ll read the CSS blocks, RESULTS, and spec sections the review is against.I have the CSS and RESULTS head. Next I’ll pull spec §2.1–2.4 and the remaining claims.The six checks hold. 36 FAIL rows were heading and list-item gaps. The CSS fix is in `.dashboard__message-markdown`. Wrap, self-scroll, and last-line were already PASS.

**(1) §2.3 targets have assertions; numbers come from tokens.**  
`GAP_PX` / `LH_BASE` pin `--s-1/2/3/6` and `--lh-base` (`markdown-wordwrap-qa.observer.test.ts:57-62,606-616`). Row targets use `m.tokens`, not typed px (`:487-517`). Required pairs are pinned (`:618-635`). Line-height, code padding, overflow, table scroller, long-token wrap, self-scroll, colour/opacity/mask all have rows (`:512-548`). Corpus matches §2.1: fixture 5 is 300 chars, the table cell is 60, the fenced command is 140.

**(2) Every FAIL has a fix; every fix has a permanent assertion.**  
Before-fix: 36 FAIL, all gap (`RESULTS-before-fix.md:8,17-18,119-120,179-180,276`). After: 352/352 PASS. Fix: `li + li` → `--s-1`; headings in the sibling lists; `block + heading` → `--s-6`; `heading + block` → `--s-2` (`LiveDashboard.astro:12926-12948`). Same rows live in `block gaps:…` (`observer.test.ts:637-640`). Revert that CSS and those rows fail.

**(3) Mutation controls reach the claimed path.**  
Gap: `p + p` → 40px, row fails; `paragraph→list` still passes (`:153-156,642-651`; RESULTS `:372`). Wrap: `p { overflow-wrap: normal }` overflows (`:157-160,668-677`; RESULTS `:373-375`). Fade: mask + `opacity: 0.4` (`:161-164,689-696`; RESULTS `:376-377`). Spec asked one control per family. Heading/item are not in the gap override; revert of those rules still fails `block gaps:`.

**(4) CSS scope.**  
Only the message-markdown rhythm block plus retirement of the brain duplicate pair. `global.css` and the renderer are unchanged. Brain node still has both classes (`LiveDashboard.astro:725`; harness `:177`). Brain heading sizes stay (`:11986-12000`). Shared-class rules now set both surfaces’ gaps.

**(5) Last-line check matches §2.2.**  
Last non-blank text node → `Range` → lowest rect; colour of the parent vs the container (`color: var(--text)` at `:12894`); opacity product up to the host; `mask-image` / `-webkit-mask-image` (`observer.test.ts:259-280,544-548`). Fade control fails opacity and mask.

**(6) Claims vs code.**  
README `gap` control “proving it can fail” is the family test, not heading/item. Fixture 6 is a header note, not per-row `not supplied` (§4). Assertions sit in the new file, not `message-blocks-layout.observer.test.ts`; the same glob reaches them (`site/package.json:11`). `list→paragraph` is in §2.3 but not in the §2.1 corpus; `paragraph→list` uses the same rule.

Nits only. No missing assertion, no unfixed FAIL, no extra CSS.

VERDICT: PASS
