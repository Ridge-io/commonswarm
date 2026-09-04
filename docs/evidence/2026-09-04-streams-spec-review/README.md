# Review arms for the streams/DMs/threads spec

Evidence for §13 of `docs/design/2026-09-04-streams-dms-threads.md`.

Reviewed tree: `c252da5` (the spec's first commit, on top of `origin/main` at `e3df06b`).
Both arms had shell access to a worktree of that tree and were asked to verify every `file:line`
citation, break the migration/RLS design, and answer whether Phase 1 would leave old clients working.

| File | Arm | Family | Verdict |
|---|---|---|---|
| `ARM-GROK.txt` | 1 | Grok (`grok -p`) | `VERDICT: FAIL` |
| `ARM-GEMINI.txt` | 2 | Gemini (`agy --model gemini-3.1-pro-high`) | `VERDICT: FAIL` |
| `ARM-PROMPT.txt` | — | the prompt both were given | — |

Both FAILs were correct. What changed in response is recorded in §13 of the spec, including the one
arm finding that was **rejected** with a measurement (`src/cli.ts:504-505`).

Note on running these arms on this host: the first two attempts passed the whole 65 KB spec inline as
an argv prompt and both died silently, producing a zero-byte file and no `VERDICT` line, under a load
average of ~14. A zero-byte arm output is not a passing arm — per AGENTS.md the lane still owes that
arm. Re-running with a short prompt that points at the file on disk succeeded for both.
