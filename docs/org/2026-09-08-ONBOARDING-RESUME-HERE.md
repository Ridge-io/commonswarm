# Resume here — agent onboarding, 2026-09-08

Base main: `042afa63b965f43637561277090c02a921c3a1a7`, version 0.1.64. The onboarding implementation is an **uncommitted working diff on main**, not a landed commit or release. No subagents or D-036 model arms were run because the user explicitly prohibited subagents. Do not claim this patch is approved for landing.

Read `docs/evidence/2026-09-08-agent-onboarding/RESULTS.md` and `benchmark.json` first. The implementation adds setup/profile/check/receive commands, compact web handoff, and a Claude preview channel. It removes the retired “local Claude worker” and blanket “note … does NOT wake anyone” claims from the entry guides.

LIVE: this task made no deployment, database, brain, or global CLI changes. Existing production remains as before. WRITTEN AND TESTED LOCALLY: the working diff, standalone release artifact, and local fixture evidence. The generated local artifact still reports 0.1.64; this is not a new published version.

Next command: `git diff --stat`, then read the results. Before release, read the live brain topics `brain-how-to`, `listener-attended`, `agent-restart`, and `releases` with a valid agent credential. The default login could not refresh in this task. Run a real Claude idle canary in the same session, then measure live host setup; the current MCP fixture is not that proof. Obtain the required two cross-family reviews before committing/landing under D-036. Release the CLI before the site starts distributing prompts for the new commands.

DEFERRED / NOT ESTABLISHED: live host trust behavior and idle wake, ten model trials per host/mode, 10× end-to-end gains, production identity/renewal controls, web roster display of per-session receive proof, cross-machine receive preferences, and Codex idle wake. Hook status stays pending until matching host input. Wake status stays false until a same-session idle receipt, and resets on restart.

Cleanup: only this task's lane and processes are eligible for removal. Protect pre-existing `spec/app-backlog`, `lane/identity-handoff-astra-20260907`, and `lane/agent-identity` worktrees and all other pre-existing branches. See the cleanup note in the evidence report.
