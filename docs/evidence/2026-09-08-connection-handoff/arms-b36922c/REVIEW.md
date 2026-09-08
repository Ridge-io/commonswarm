# lane/connection-handoff — freeze for D-036

SHA `b36922c9663c6435fdcf43f1c6ee42e40609a786`, base `f4eb018` (v0.1.65 shipped). Diff: `DIFF.patch`.

## Claim, in three sentences
The dashboard hand-off now wraps the connection JSON and the install command in fenced code blocks whose
fence is longer than any backtick run inside the text, so a Markdown client cannot mangle the machine input.
`cswarm setup` rejects Markdown-damaged input BEFORE it authenticates, and its message names the recovery
path ("Use a setup file") instead of inviting anyone to repair a credential by hand or paste it into chat.
Credentials themselves are unchanged and `setup_version` stays 1, so an envelope saved by the old page
still imports.

## Files
`site/src/components/connect/agent-prompt.ts` and its observer test, `src/cloud/agent-profile.ts`,
`tests/p1-cli/agent-onboarding.test.ts`, `docs/evidence/2026-09-08-connection-handoff/REPORT.md`.

## Gate exit codes
Recorded by the lead on this SHA in the lane report. Every gate is run as a bare statement and its exit code
read — never through a pipe, because `$?` after a pipe is the pipeline's status; that class shipped 0.1.62.

## NOT established (author's own list)
The exact step that damaged the original paste is still unknown; the site copies its source string
unchanged. No real credentials were used in the tests.
