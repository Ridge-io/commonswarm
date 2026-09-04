# Review arms — 2026-09-04 reconciled chat-platform spec

Target: `docs/design/2026-09-04-chat-platform-reconciled.md`
Reviewed at md5 `2577df39c581e528f672adba4c506687` (commit `b2ef0d7`), base tree `d57d480`.

| File | What it is |
|---|---|
| `REVIEW.md` | The task both arms were given. |
| `ARM-PROMPT.txt` | First prompt (relative `./REVIEW.md`). **Superseded** — see the wrong-file run. |
| `ARM-PROMPT-ABS.txt` | Absolute-path prompt with a required quote-back of the target's first heading. |
| `ARM-GROK.txt` | Grok arm. **VERDICT: FAIL.** Findings G1-G5 in the spec's review record. |
| `ARM-GEMINI.txt` | Gemini arm. **VERDICT: FAIL.** Findings M1-M2. |
| `ARM-GROK-aborted-stale-file.txt` | Aborted first run: it was reading the spec while the author was still compressing it. Killed rather than accepted. |
| `ARM-GEMINI-wrong-file-run.txt` | **A verdict that is not evidence.** This run resolved `./REVIEW.md` to an unrelated lane's file (`docs/evidence/2026-09-04-mobile-arms/REVIEW.md`) and returned `VERDICT: FAIL` about `lane/mobile-fix`. Kept because it is the clearest example of the trap: a well-formed verdict about the wrong artifact. |
| `ARM-CITATION-RESOLVER.py` / `-REPORT.txt` | An arm's mechanical resolver over every `file:line` in the spec. 99 of 100 resolved; the miss is `docs/research/2026-09-01-streaming-into-the-web-ui.md:50`, which the spec already flags as absent from `origin/main`. |

Both arms returned FAIL and both were right. Every accepted finding is folded into the spec with the
measurement; nothing was rejected outright. See the spec's "Review record" section.

Process notes worth carrying forward:
- **Freeze the document before starting an arm.** The first pair reviewed a file that was still changing.
- **Pass the target by absolute path and demand a quote-back.** Relative `./REVIEW.md` silently resolved
  to another lane's file on this host.
- **Wait on the arm's output file, not its wrapper shell.** The host was at
  `kern.memorystatus_vm_pressure_level = 2`; both wrapper shells were killed (exit 144) while the arm
  processes survived and kept writing.
