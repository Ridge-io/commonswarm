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
- ~~That view fix made every membership and agent read unavailable.~~
  **DEAD:** it fixed discovery only. `swarm.is_member` still accepted archived
  workspaces, and the agent read context had no archive check.
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

This round fixed the directory result only. It did not establish that closing
revoked access to the workspace's other data.

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

## Cross-family refutation and access fix

The cross-family inversion found two false claims.

1. CLI and web successor selection trusted a cached directory as live. The CLI
   could choose an `archived: true` row. The web could return early from
   `openWorkspace` while the closed workspace id remained active.
2. Membership reads were still open because `swarm.is_member` checked only the
   membership row. Agent reads used a separate definer function with the same
   gap.

The `ad5a2d8` commit prose said: ~~“The backend already treated archived
workspaces as gone — every route and read refuses `archived_at IS NOT NULL`.”~~
**DEAD:** command routes refused archived workspaces, but `swarm_read` signals,
files, members, and other membership views remained readable. Agent reads also
remained authorized. This file is the durable correction to that published
commit claim.

The `3eb680f` commit prose said: ~~“selection code no longer silently accepts
an archived workspace.”~~ **DEAD at that commit:** the integration contract was
corrected, but `selectWorkspace` still accepted an `archived: true` row and
wrote it as the saved default. The direct selection guard and its live-row
control land in the next fix commit.

### Access decision

Migration `20260820000002_archive_revokes_access.sql` puts the live-workspace
check inside `swarm.is_member`. This is the least bypassable layer for human
workspace reads: all views that call the predicate inherit the same rule.

Caller enumeration command:

```sh
rg -n 'swarm\.is_member' supabase/migrations --glob '*.sql'
```

Callers enumerated before the change:

- `tasks`, `events`, `memberships`, `repositories`, `leases`, `workspaces`,
  `member_profiles`, `agent_principals`, `agent_runs`, `audit_log`, `signals`,
  and `files` in `swarm_read`;
- `swarm.capability_projection`, where the earlier `workspace_archived` CASE
  arm remains first and therefore keeps its distinct archived status;
- `pending_invitations` and `agent_access_status`, which used hand-written
  membership checks and now also call `swarm.is_member`;
- `swarm.agent_delivery_read_context`, which does not read through a view and
  now folds `swarm.is_member` into its revocation result. The read edge returns
  403 before it queries signals, files, or members.

`swarm_read.my_devices` is user-scoped, not workspace-scoped, so it was not
changed. Command routes already join `swarm.workspaces` with
`archived_at IS NULL`. Capability reads already return `workspace_archived`.

The free-tier count still reads the durable base table with its own
`archived_at IS NULL` predicate. Support restore still clears only that base
row. Because no membership or token is destroyed, clearing `archived_at`
reopens the shared human and agent gates.

### Successor and copy corrections

- `src/cloud/workspaces.ts` now requests and retains only live rows. The CLI's
  default update is one tested operation: it selects a live successor or clears
  the saved default and says that no live workspace remains.
- The web filters archived rows at load and again at close transition. It clears
  the closed active id before a forced successor open, so the connect prompt's
  early-return paths cannot keep the dead id active. With no successor it resets
  workspace state and renders the create/empty state.
- The four warning clauses are now backed by the shared access gate, the direct
  live-count predicate, and the tested restore update.
- A close HTTP 403 no longer diagnoses ownership. It says the credential may
  not own the workspace or the workspace may no longer be available.

## Reached coverage

- `tests/protocol-workspace.test.ts` — reached by `npm test`.
- `tests/p1-cli/workspace-close.test.ts` and `tests/p1-cli/command-client.test.ts` — reached by `npm run test:p1-cli`.
- `tests/p1-server/command.test.ts` — reached by `npm run test:p1-server`; authored here but not run because the Lead owns the exclusive database slot.
- `tests/p1-cli/workspaces.test.ts` — reached by `npm run test:p1-cli`; covers
  live successor selection, archived-only default clearing, and a stale
  archived directory row.
- `site/src/components/app/workspace-settings.observer.test.ts` and `site/src/components/app/workspace-entry.observer.test.ts` — reached by `cd site && npm test` through the recursive component observer glob. The settings observer executes both web close transitions.

## Verification in this worktree

Cross-family-refutation fix results:

- Focused CLI workspace and close tests: 17 passed, 0 failed.
- Focused web settings and close-transition tests: 4 passed, 0 failed.
- `npm test`: 583 total; 557 passed and 26 failed. Every failure is in the
  existing local Unix control-socket group and reports `listen EPERM`.
- `npm run test:p1-cli`: 280 total; 254 passed and 26 failed. Every failure is
  in the existing loopback/fake-server group and reports `listen EPERM`.
- `npm run check:tests`: passed with 0 diagnostics.
- `npm run check:edge`: all 3 named edge entrypoints passed.
- `cd site && npm run build && npm test`: build passed with 8 static pages;
  171 tests ran, 166 passed, and 5 failed. Four existing email tests report
  loopback `EPERM`; the existing Chrome geometry test aborts with `SIGABRT`.
- `npm run test:p1-server` and `db:reset` were not run by instruction. The Lead
  owns the database slot and must apply the new migration before running the
  archive read/restore assertions.

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
