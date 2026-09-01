# L29 report — copy claims

## Result

- Branch: `lane/l29-copy-claims`
- Commit: `82b70047ab18653d10515e0558d34600b61da633`
- Worktree was clean after the commit.
- No push, release, deploy, site change, Supabase change, or migration change.

## Mechanism

### File reads

`getObject`, `listFilesAsAgent`, and `listFilesAsHuman` now use cause-neutral copy:

- `the download did not complete`
- `the file list did not complete`

These statements are true when fetch fails before a response, when no response arrives, when the
caller aborts, and when response headers arrive but the body stalls. The first committed form said
`within the deadline`. Grok refuted that on `5fc4a47`: an immediate fetch failure can occur before
the timer expires. The replacement commit removes the false cause.

`FileTransportError.noResponse`, error classes, codes, and `onceRetried` control flow did not
change. Its JSDoc now says the flag also covers an idempotent read whose body stalls. The retry
JSDoc separates reads from same-ID write replay.

### Claude `--user` warning

The warning is now built from the selected settings path:

`Warning: --user scope writes settings to <resolved-directory> and applies to every Claude Code session that reads that directory.`

It is one sentence. It runs for user-scope install and uninstall. It names the resolved nonempty
`CLAUDE_CONFIG_DIR`, or the default `<HOME>/.claude` directory. The help text states the same
claim. Project-local scope does not print the user-scope warning.

The two prior evidence files that endorsed the OS-user-wide sentence now keep that sentence
struck through and mark it dead as a product claim.

## Claim-family enumeration

### File-read completion claim

Changed:

- `src/cloud/files.ts`
  - `FileTransportError.noResponse` JSDoc
  - `onceRetried` JSDoc
  - `getObject` catch
  - `listFilesAsAgent` catch
  - `listFilesAsHuman` catch
- `tests/p1-cli/file-verbs.test.ts`
  - incomplete-request test name
  - all three body-stall rows
  - exact new messages
  - negative assertion for `before a response` and `could not reach`

Enumerated and kept:

- `src/cli.ts` remains the user-facing consumer of `error.message`; no copy is duplicated there.
- `docs/evidence/2026-09-01-v044/grok-exact-3295f57-PASS.md` records the defect on the old SHA.
- `docs/org/2026-08-29-RESUME-HERE.md` records that the defect shipped in v0.1.44 and queued L29.
- `docs/evidence/2026-08-18-file-artifacts-s3/README.md` uses “no HTTP response arrived” only for
  same-ID write replay. That claim remains correct.
- `docs/release/0.1.11.md` quotes `could not reach the cloud service` for older signal/member read
  behavior. It is release history for another path, not file-list copy.
- No active matching claim was found in `docs/design/` or the other release notes.

### Claude user-scope claim

Changed:

- `src/cli.ts`
  - help text
  - dynamic `claudeUserScopeWarning(settingsPath)`
  - user-scope install/uninstall emission
- `tests/p1-cli/hook-routing.test.ts`
  - project-local negative control
  - configured-directory install assertion
  - configured-directory uninstall assertion
  - default `<HOME>/.claude` assertion
  - full help claim and old-help negative assertion
- `docs/evidence/2026-09-01-v044/l26-hook-scope-lane-note.md`
  - old sentence preserved, struck, and corrected
- `docs/evidence/2026-09-01-v044/gemini-inversion-3295f57-PASS.md`
  - old sentence and the missed-P3 verdict preserved, struck, and corrected

Enumerated and kept:

- `userClaudeSettingsTarget` already resolves nonempty `CLAUDE_CONFIG_DIR` and falls back only
  when it is absent or empty.
- `docs/evidence/2026-09-01-v044/grok-exact-3295f57-PASS.md` and the current resume keep the old
  sentence only as defect history for `3295f57` / v0.1.44.
- No active matching claim was found in `docs/design/` or `docs/release/`.

## OBSERVED mutation firings

### Old file-read strings

Mutation: restored all three old strings in `src/cloud/files.ts`.

Command:

`node --import tsx --test --test-name-pattern='every file read deadline stays armed through a stalled response body' tests/p1-cli/file-verbs.test.ts`

Observed RED: exit 1, 0 pass / 1 fail. The assertion reported:

```text
actual:   file list could not reach the cloud service
expected: the file list did not complete
```

The same test first established `bodyUsed === true`, so the negative result reached body
consumption. Restore: 1 pass / 0 fail.

### Generic OS-user warning

Mutation: replaced the dynamic warning with the old generic sentence, then rebuilt.

Observed RED: build exit 0; focused hook test exit 1, 0 pass / 1 fail. The assertion reported the
generic OS-user sentence as actual and the resolved temporary `CLAUDE_CONFIG_DIR` sentence as
expected. Restore: build exit 0; focused test 1 pass / 0 fail.

## Review gate

- Grok exact on `5fc4a47`: **FAIL**. It found the `within the deadline` overclaim for immediate
  failures. Fixed before the final SHA.
- Grok exact on `82b7004`: **PASS**. It probed four failure modes across all three readers
  (12 cases) and ran four focused tests.
- Gemini inversion on `82b7004`: its first tool-using run completed 23 focused tests but timed
  out with no verdict, so it was not counted. A bounded no-tool rerun returned substantive
  `VERDICT: PASS`; a correction rerun fixed its whitespace and local-path descriptions and kept
  `VERDICT: PASS`.

## Required gate tails

Final replacement tree:

```text
npm run build
> tsc
> chmod 755 dist/cli.js
exit 0

npm test
tests 680
pass 680
fail 0
exit 0

npm run test:p1-cli
tests 381
pass 381
fail 0
exit 0

npm run check:tests
> tsc -p tsconfig.tests.json
exit 0
```

Before the review fix, two unchanged `npm test` retries hit the documented OpenCode timing family:
679/680 with one held-close bound, then 678/680 with two different OpenCode races. A third unchanged
run passed 680/680. The final replacement tree then passed 680/680 on its first full run.

Both changed test files are reached by `npm run test:p1-cli`, which globs `tests/p1-cli/**/*.test.ts`.

## NOT established

- The commit is not pushed, released, deployed, or installed. Live v0.1.44 still has the old copy.
- Real Claude Code loading from the selected directory was not run.
- Tilde expansion inside a literal `CLAUDE_CONFIG_DIR` value was not established.
- `npm run test:p1-local` and `npm run test:p1-server` were not run. This change has no database
  or edge-function behavior.
- No production service, site, listener, user settings, Supabase file, or migration was changed.
