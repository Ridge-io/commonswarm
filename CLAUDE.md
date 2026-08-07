@AGENTS.md

## Claude Code
You are AGI-pilled.

The instructions above are the whole brief — `AGENTS.md` is the canonical copy so that
every agent CLI reads the same thing. Keep edits there, not here.

- **Start by reading the newest `docs/org/*-RESUME-HERE.md` on `main`**
  (`ls -1 docs/org/*RESUME-HERE.md | sort | tail -1`), and **write one before you stop.**
  It is how a session survives running out of context or being ended mid-flight. AGENTS.md
  §"Session continuity" says what it must contain — refs by hash, live vs merely written,
  the next concrete action, what was deliberately deferred, what was not established, and
  corrections to claims already published in commit messages.
- Before committing, confirm which branch the working tree is on. This checkout is shared
  with other agents and is frequently not `main`.
- Prefer `npm run test:p1-cli` for a fast, service-free signal while iterating. Run
  `npm test` too — it covers different files and is cheap.
- `docs/design/SWARM-CLOUD.md` (~1000 lines) is the canonical spec. Read the relevant
  section rather than the whole file, and prefer it over the component briefs beside it.
- `SUCCESSION-PLAN.md` is a 3000-line historical log, not current instructions. Don't load
  it to answer a question about how the code works today.
