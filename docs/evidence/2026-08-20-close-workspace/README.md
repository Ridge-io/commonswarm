# Close workspace — 2026-08-20

## What `archive_workspace` does

- It resolves a live workspace route from the presenting credential first.
- It accepts an interactive human credential only.
- It accepts only when that human's current membership role is `owner`.
- It emits `WorkspaceArchived` with the server decision timestamp.
- It sets only `swarm.workspaces.archived_at` to that event timestamp.
- It writes the normal accepted or refused command audit row.
- ~~The existing read and route filters then hide the workspace from everyone.~~
  **DEAD:** the route filter existed, but the applied `swarm_read.workspaces`
  view still returned archived rows. Migration
  `20260820000001_hide_archived_workspaces.sql` adds the missing view filter.
- Because the free-tier count includes only rows with `archived_at IS NULL`, closing frees one live-workspace slot.

## What it does not do

- It does not delete the workspace or any event, signal, file, member, agent, task, or audit row.
- It does not revoke each membership or agent credential separately.
- It does not transfer repository landing authority.
- It does not let an admin, member, or agent credential close a workspace.
- It does not add a self-service restore command. Support can restore the workspace by clearing `archived_at` through the existing operator path.

The reducer refuses a second archive as `workspace_already_archived`. In normal HTTP use, the archived workspace fails route resolution first and returns the same unavailable response as any workspace the caller cannot address.

## 2026-08-20 fix round

Root cause: `20260724000002_status_workspaces.sql` gated the workspace view by
membership only. It selected `archived_at` but did not filter it, so PostgREST
still listed closed workspaces.

The new migration replaces `swarm_read.workspaces` with the same membership
gate plus `w.archived_at IS NULL`. It keeps `archived_at` in the projection for
released CLI and web clients that still select and null-filter that column.

Consumers checked:

- `src/cloud/workspaces.ts`: the `cswarm workspaces`, `use`, and status
  selection path now lets the filtered workspace view drive the join. An
  archived membership left in `swarm_read.memberships` is ignored instead of
  causing a malformed-read error.
- `site/src/lib/commonswarm.ts` and
  `site/src/components/app/LiveDashboard.astro`: both already add
  `archived_at IS NULL`; the view filter makes that redundant but does not
  change the result.
- `supabase/functions/command/index.ts`: route resolution already rejects
  archived workspaces. Support restore reads and updates the durable
  `swarm.workspaces` row directly; no restore path uses the filtered view.
- The free-tier live count reads `swarm.workspaces` directly and keeps its own
  `archived_at IS NULL` predicate. The view migration does not affect or
  double-apply that count.

## Reached coverage

- `tests/protocol-workspace.test.ts` — reached by `npm test`.
- `tests/p1-cli/workspace-close.test.ts` and `tests/p1-cli/command-client.test.ts` — reached by `npm run test:p1-cli`.
- `tests/p1-server/command.test.ts` — reached by `npm run test:p1-server`; authored here but not run because the Lead owns the exclusive database slot.
- `site/src/components/app/workspace-settings.observer.test.ts` and `site/src/components/app/workspace-entry.observer.test.ts` — reached by `cd site && npm test` through the recursive component observer glob.

## Verification in this worktree

Fix-round results:

- Focused `tests/p1-cli/workspaces.test.ts`: 13 passed, 0 failed.
- `npm test`: 557 passed, 26 failed; all 26 are the existing local-socket
  `EPERM` sandbox failures.
- `npm run test:p1-cli`: 252 passed, 26 failed; the same existing local-socket
  `EPERM` group failed.
- `npm run check:tests`: passed with 0 diagnostics.
- `npm run check:edge`: all 3 named edge entrypoints passed.
- `cd site && npm run build`: passed; 8 static pages built.
- `cd site && npm test`: 164 passed, 5 failed; 4 are the existing local-socket
  `EPERM` failures and 1 is the existing headless Chrome `SIGABRT` failure.
- `npm run test:p1-server`: not run by instruction; the Lead owns the database
  slot and will verify the migration-backed PostgREST assertion.

Original lane results:

- `npm run build:command-core` — passed; regenerated `supabase/functions/_shared/protocol.js`.
- `npm run build` — passed.
- `npm run check:tests` — passed.
- `npm run check:edge` — passed for all 3 named edge functions.
- Feature-focused protocol, mutation, CLI wire, CLI parsing, and stale-claim tests — 75 passed, 0 failed.
- Feature-focused site settings and entry observers — 6 passed, 0 failed. This includes the real renderer in headless Chrome.
- `cd site && npm run build` — passed; 8 static pages built.
- Full `npm test` — 557 passed, 26 failed. All remaining failures require a local Unix control socket; this sandbox rejects `listen()` with `EPERM`.
- Full `npm run test:p1-cli` — 252 passed, 26 failed. The remaining OAuth/file/signal fake-server tests require a local listener; this sandbox rejects it with `EPERM`.
- Full `cd site && npm test` — 164 passed, 5 failed. Four email push-script tests cannot bind `127.0.0.1` (`EPERM`); one unrelated geometry observer's Chrome process aborts in this sandbox. The new settings Chrome observer passes.
- `npm run test:p1-server` was not run, by instruction. The Lead owns the exclusive database slot.
