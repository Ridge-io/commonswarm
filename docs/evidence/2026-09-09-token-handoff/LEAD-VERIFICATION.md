# Lead verification — token hand-off (2026-09-09)

## The failure this fixes
The operator reproduced it WITHOUT CommonSwarm: he copied `{"test_key":"alpha_beta","url":"https://example.com"}`
and pasted it back into Codex. The saved message had two literal backslash-underscore sequences and a
Markdown link, and JSON parsing failed at column 7. Whatever performs that conversion sits between
CommonSwarm and the agent and cannot be fixed from here, so the payload must survive it.

## Design, proved before the code was written
`design-proof.mjs` applies exactly that transformation. Raw JSON fails to parse at position 7, matching the
report. A base32 token (alphabet `A-Z` and `2-7`, dot separator) comes through **byte-identical**, because
it contains no character a Markdown converter escapes and no `://` to linkify.

Two design bugs the proof caught before implementation:
- A version marker of `CSWARM1` is silently eaten, because `1` is not in the base32 alphabet and the
  cleaning step drops it. The marker must use only alphabet characters, hence `CSWARMA`.
- Cleaning keeps letters, so a fence label such as ```` ```json ```` leaves `JSON` glued to the front. The
  decoder must FIND its marker rather than trust the whole string.

## D-036
Author family Gemini (agy). Arms on the final SHA `77fe6df`: **Grok PASS** and **Codex PASS**.
An earlier SHA `99fc790` was FAILED by Codex with four findings; all four were fixed and Codex re-reviewed
its own findings on the fix. Arm files are beside this note.

## A correction the lead owes
Ruling on Codex's headline finding, the lead first reported it as "not reproduced" after sweeping twelve
payload lengths. **That sweep was wrong.** It mutated the final symbol with `String.replace(lastChar, c)`,
which replaces the FIRST occurrence, so it corrupted an early data byte that the CRC always caught. Codex
was right: base32 leaves spare bits unless the payload length is a multiple of five, so several spellings
decode to identical bytes and passed the checksum — 59 accepted of 372 on the old code.

Re-measured on `77fe6df` with a correct mutation (`slice(0, -1) + c`) across body and checksum, lengths
1..12, all 31 alternate symbols: **0 accepted of 744**, every one rejected `token_checksum_invalid`.

## Lead's own controls on 77fe6df
- Structure fails at the TOKEN layer, not later in credential validation: an extra character on the
  checksum gives `token_checksum_invalid`; an extra `.EXTRA` part and a trailing dot give
  `token_shape_invalid`. On the old code these reached the credential validator.
- Detection and decoding now agree on formatting injected inside the marker itself: `CSWA**RMA.`,
  `CSWA\nRMA.` and `CSWA\tRMA.` are all both detected and decoded.
- Recoverable damage still decodes: the operator's exact mangling, wrapping with tabs, lowercase, a broken
  fence, a labelled fence, the token buried in prose, and a `**` injected mid-body.
- `lead-hostile-suite.mjs` runs against the REAL decoder, not a copy of it.

## NOT established
The component performing the conversion in the operator's Codex environment is still unknown and was not
inspected. No live agent connected through the new prompt at the time of writing; that is the next step.

## Filed, not fixed here
The credential validator's remedy says "send that line to stdin" even when the input came from a file. It
is the wrong instruction for this path and should name the file the reader actually used.
