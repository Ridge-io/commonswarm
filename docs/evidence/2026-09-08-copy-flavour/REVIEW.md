# lane/copy-flavour — freeze for D-036

SHA `1f460eb2a977d0c33c4534471ae73df6191b4cf5`, base `main` (v0.1.66 shipped). Site only; no CLI release needed. Diff: `DIFF.patch`.

## Claim, in three sentences
A manual selection copy of the prompt block used to put both `text/plain` and `text/html` on the
clipboard, and a Markdown-aware target converted the HTML — escaping every underscore as \_ and rewriting
a bare URL as a Markdown link, which is the damage reported from a real hand-off on 0.1.66.
The block now listens for its own `copy` event, writes `text/plain` from `promptCopyPayload()` and calls
`preventDefault()`, so no HTML flavour is produced by any copy out of the block.
A partial selection is preserved exactly; an empty selection falls back to the whole prompt.

## Lead's own controls on this SHA
Site build 0; site tests 546 passed, 1 pre-existing skip. Mutation: injecting `.replace(/_/g, "\\_")`
into `promptCopyPayload` fails the suite (545/1); restoring passes (546/0). The handler string
`text/plain` is present in the built chunk.

## NOT established
Whether a real browser writes only `text/plain` after `preventDefault()` — that is the documented
behaviour of the clipboard event, but it is not exercised by a headless test here. The exact hop that
damaged the original paste is still unknown.
