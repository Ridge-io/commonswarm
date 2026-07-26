@AGENTS.md

## Claude Code

The instructions above are the whole brief — `AGENTS.md` is the canonical copy so that
every agent CLI reads the same thing. Keep edits there, not here.

- Before committing, confirm which branch the working tree is on. This checkout is shared
  with other agents and is frequently not `main`.
- Prefer `npm run test:p1-cli` for a fast, service-free signal while iterating. Run
  `npm test` too — it covers different files and is cheap.
- `docs/design/SWARM-CLOUD.md` (~1000 lines) is the canonical spec. Read the relevant
  section rather than the whole file, and prefer it over the component briefs beside it.
- `SUCCESSION-PLAN.md` is a 3000-line historical log, not current instructions. Don't load
  it to answer a question about how the code works today.
