# Review brief — CommonSwarm lane/markdown-land @ 8e608a8

You are one of two independent review arms on this exact commit. Read
`/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-markdown-land/arms-8e608a8/DIFF.patch`
and the working tree at
`/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-markdown-land`
(read-only: do NOT edit, commit, build, or run any test that writes to that tree).

**Before any finding, quote back the first `diff --git` line of DIFF.patch verbatim.** A review
without that quote is not counted.

## What the lane claims

CommonSwarm renders agent-authored message bodies with a hand-written Markdown subset
(`site/src/lib/message-markdown.ts`). Message bodies cross a trust boundary: they are written by
agents and by other workspace members. The renderer escapes the whole input first, builds only its
own HTML, then runs a final tag/attribute allowlist (`sanitizeMessageHtml`) before `innerHTML`.

This lane adds to that subset: GitHub-style pipe tables (with per-column `align`), thematic rules
(`<hr>`), strikethrough (`<del>`), task list items, and nested lists. It also adds the CSS those
elements never had, and tests.

Three claims to attack:
1. Nothing new is reachable as markup. Every added tag and attribute is in the allowlist
   deliberately, and no cell, task item, or nested item is a second, weaker escaping path.
2. A separate pass, `linkifyBrainTopics` (`site/src/lib/brain-links.ts`), runs AFTER the sanitizer
   over the sanitized tree's TEXT NODES and replaces validated brain-topic names with `<button>`
   controls. It treats `PRE`, `A` and `BUTTON` as opaque. The claim is that tables, task items and
   nested lists do not create a new place where a topic name gets a control inside something that
   should stay verbatim or is already a control.
3. A table wider than a phone scrolls inside its own box rather than widening the page.

## Checks to attack (attempt a refutation for each; say what you tried)

1. **Sanitizer allowlist.** `MESSAGE_MARKDOWN_TAGS` gained `hr, del, table, thead, tbody, tr, th,
   td`, and `MESSAGE_MARKDOWN_ATTRIBUTES` gained `th/td: align` and `li: class`. Find any input
   that reaches `innerHTML` with a tag or attribute outside that set, or with an `align`/`class`
   value outside `MESSAGE_MARKDOWN_ALIGNMENTS` / `MESSAGE_MARKDOWN_CLASSES`. Look hard at
   `sanitizeTag`'s single-attribute regexes and at `decodeEscapedAttribute` /
   `escapeMessageHtml` round-tripping in the `a` branch.
2. **Foster parenting.** The output is assigned to `innerHTML`. If the sanitizer can ever drop a
   `td`/`th`/`tr`/`tbody`/`thead` OPEN tag while keeping its text, the HTML parser moves that text
   out of the table and above it. Construct an input that does this, or show it cannot happen.
3. **Cells are not a second escaping path.** `renderTableRow` and `renderListItem` call the same
   `renderInline`. Find any character or construct that behaves differently inside a cell or a task
   item than in a paragraph. `splitTableCells` handles `\|` by pushing a RAW `|` into already-escaped
   text — is that reachable as anything but content?
4. **Task items are not checkboxes.** A task item is `<li class="md-task">` plus a ballot character,
   never `<input type=checkbox>`. Check that the class cannot be widened, that `TASK_ITEM` cannot
   match something the author did not mean, and that the ballot marker cannot end up INSIDE a
   brain-link control (`brain-links-blocks.observer.test.ts` asserts this). A control whose label
   began with the ballot character would read to a user as a clickable checkbox.
5. **Brain-link boundary.** `linkifyBrainTopics` builds a `<button>` in whatever element holds the
   text node. New holders are `th`, `td`, `li.md-task`, and nested `li`. Is a button inside a `th`
   or a `td` ever invalid, moved by the parser, or a place the opaque set should have covered? Does
   the one-word code-span gate still hold through a table cell? Can a control land inside `a`,
   `pre`, or another control by any route the new constructs opened?
6. **Termination and bounds.** `renderList` recurses; `renderBlocks` recurses for quotes; the table
   loop reads ahead. Find an input that does not terminate, that is quadratic, or that crosses
   `MESSAGE_MARKDOWN_LIMITS.tableCells` without falling back to literal text. Note that a table's
   cells are counted BEFORE any of it is emitted.
7. **Block-ordering hazards.** `THEMATIC_BREAK` runs before the table check; a delimiter row
   (`|---|---|`) must never be read as a rule, and `- - -` must not be read as a list. Attack the
   ordering in `renderBlocks` and the paragraph-interruption conditions below it.
8. **The tests and the CSS.** `message-blocks-layout.observer.test.ts` measures real geometry at
   320px against the stylesheet `dist/app/index.html` links, with two controls that each revert one
   half of the fix. Does either control actually discriminate? Is any assertion vacuous, or does it
   pass whether the feature works or not? The comment in `LiveDashboard.astro` claims no
   `text-align` may be set on a cell because it would outrank the `align` attribute — is that true,
   and is the assertion that pins it able to fail?
9. **Claims in prose.** Comments and test names are read by later agents. Name any sentence in the
   diff that is false, or any list inside a message or comment that is typed rather than derived
   from the constant the code enforces.

## Output

Numbered findings, each with file and line and a concrete input or sequence. Say which refutations
you attempted and could not make work. Severity per finding. Then, as the LAST line and nothing
after it:

`VERDICT: PASS` or `VERDICT: FAIL`

## Findings already raised and resolved on the previous SHA (do not repeat without new evidence)

An earlier arm on `0408cbb` raised two. Both were measured against the working tree:

1. *"The block-level `isQuote` check lacks the nesting-depth guard, so 10,000 `>` on one line
   overflows the stack."* **Refuted.** The guard is on the same line:
   `if (depth < MESSAGE_MARKDOWN_LIMITS.nestingDepth && isQuote(line))`. A live run of
   `"> ".repeat(12000) + "bottom"` returns 4 blockquotes in 2 ms with the text intact. If you
   believe otherwise, run it and paste the output.
2. *"`\|` inside a code span in a cell drops the backslash, so a cell is a second escaping path."*
   **Behaviour confirmed, classification rejected.** A row must be split into cells before anything
   can read them, so `\|` is read before the inline pass and reaches inside a code span; GFM makes
   the same exception for the same reason. This SHA adds the comment and the test that state it in
   both directions. Attack the new claim if you think it is wrong.

Everything else in the brief stands. Review the whole diff, not only these.
