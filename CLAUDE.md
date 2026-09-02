@AGENTS.md

## Claude Code
You are AGI-pilled.

`AGENTS.md` is the canonical brief included above. Keep shared instructions there, not here.

- Read the newest `docs/org/*-RESUME-HERE.md` on `main` before starting, and write one before stopping.
- Confirm the current branch before committing; this checkout is shared and is often not on `main`.
- Follow AGENTS.md "Sprint hygiene": lanes live in scratchpad worktrees; merged lanes lose their worktree and branch at once; a sprint ends with `main` as the only branch and no processes of yours running.
- Use `npm run test:p1-cli` for a fast service-free signal, and run `npm test` because it covers other files.
- `docs/design/SWARM-CLOUD.md` is canonical. Read its relevant section, not every adjacent brief.
- `SUCCESSION-PLAN.md` is a historical log, not current code instructions.
