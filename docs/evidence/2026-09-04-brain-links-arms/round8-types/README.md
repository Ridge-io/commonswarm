# Round 8 — `lane/brain-links-types` (code+tests `ac20f7b`, tip `0666a5e`, base `ae80338`)

Follow-up to the brain-links landing. Three items: the `BrainLinkOutcome` union omitted `abandoned`
while the function returned it (site `tsc` reported TS2322 and nothing gated it, because whole-site
tsc carries 68 pre-existing errors); the observer did not pin `listIsFresh` as the third argument
to `brainLinkClickOutcome`; the `1.5` dotted-name case recorded as an intended link.

Gate added: a tsconfig scoped to `brain-links.ts` alone, run by a test with its own positive
control (strip the member, assert tsc fails naming `abandoned`). Writing that control caught two
things: `npx tsc` resolving outside the workspace fetched an unrelated package that exits non-zero
with no diagnostics, so the compiler is resolved by absolute path; and a first mutation produced a
syntax error rather than the type error, so the assertion on the message had been wrong.

The lane's diff was reviewed at `70af721` (base `c27a6af`), then re-parented onto the re-authored
`main` (`ae80338`). Diff sha256 before and after: identical (`dac463c2…feb820`, 9161 bytes), so
the arm verdicts carry. Both arms PASS: Grok and Gemini, quote-backs present.

p1-cli on the same SHA gave 407/1, 408/0, 407/1 across three runs on a loaded host, a different
network-shaped test each time — a contention signature, not a regression.

Grok's two residuals, kept visible and not fixed here: the control test's title says "the same
invocation" while the control writes a duplicate tsconfig in a temp dir, so it proves the
compiler and the file, not `-p tsconfig.brain-links.json` itself (the third test pins `files` and
`strict`); and the comment's "68 pre-existing errors from `../src/protocol/*` and
`astro.config.mjs`" is incomplete — 49 protocol, 5 astro config, 14 site observer tests.
