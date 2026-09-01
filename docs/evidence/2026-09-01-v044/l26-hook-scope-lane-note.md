# L26 — Claude hook install is project-local by default (Codex lane, commit 21c667f)

The Codex lane committed `21c667f` on `lane/l26-hook-scope`, then spawned its own Grok and Gemini
reviews of that commit and its `codex exec` process ended before writing the lane report — so
this note, written by the Lead, stands in for the report. The lane's own review arms were
orphaned (the Grok one wrote to a pipe nobody read); the release-wide arms on the merged SHA are
the reviews that count.

What the commit does (read from the diff, `src/cli.ts` +94/−53 lines, `tests/p1-cli/hook-routing.test.ts` +243):

- `cswarm hook install|uninstall claude --write` now targets `<project>/.claude/settings.local.json`
  (git worktree root of cwd; cwd outside git). Inside a repo the file must be reported ignored by
  `git check-ignore`, otherwise the command refuses and prints the exact `.gitignore` line.
- `--user` opts in to `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`. The historical output at
  `21c667f` was ~~"Warning: --user scope affects EVERY Claude Code session for this OS user and
  is wrong on a shared host."~~ **Dead as a product claim:** with `CLAUDE_CONFIG_DIR` set, only
  sessions that read that configured directory are affected. L29 replaces it with a warning
  that names the resolved directory. `--repo` keeps the repository-wide `.claude/settings.json`
  (ignore-checked).
  `--user` and `--repo` are mutually exclusive; `--user` requires `--write`.
- Success output names the full path and, for the default scope, says it applies only to Claude
  Code sessions started in that project.

Gates measured by the Lead in the lane worktree at `21c667f`: `npm run build` exit 0;
`npm test` 678/678; `npm run test:p1-cli` 379/379; `npm run check:tests` exit 0.

NOT established here: the lane's own mutation arms (its report never landed); real-Claude
behaviour with `settings.local.json` on this host (tests use temp HOME and temp git repos).

Merged as `2689c6d` (auto-merge with L25 in `src/cli.ts`, no conflicts). Gates on the merged tree:
build 0; `npm test` 679/680 on the first run, 680/680 on the immediate rerun with no change —
the failing name was not captured, and the hook/notify lane report documents the same flaky
host-timing family (held-close elapsed, OpenCode polling window, Claude version probe deadline);
`test:p1-cli` 381/381; `check:tests` 0; `check:edge` 0; site build 8 pages; site test 234/0 fail.
