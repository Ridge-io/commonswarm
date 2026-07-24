# P2-2 implementation seam notes

These notes hand off the code mapping for
`docs/design/P2-STATUS-WORKSPACES-BRIEF.md` v1.1. They contain no implementation.

## Primary change seams

### `src/cli.ts`

This is the center of the slice.

- `workspaceId()` (currently around lines 345–364) implements only:
  explicit `--workspace-id` → `SWARM_CLOUD_WORKSPACE_ID` → saved profile.
  It neither revalidates the saved default nor discovers/list live memberships
  at command time. Replace or wrap this function with the five-step resolver
  from §1.4.
- Preserve the first two short-circuits before any authenticated read. The
  existing `dogfood --agent-token-stdin` local integration deliberately works
  with `SWARM_CLOUD_WORKSPACE_ID` and an agent token, without requiring a human
  refresh credential. A resolver that refreshes the human session before
  checking flag/env silently breaks that supported path.
- `writeWorkspaceDefault()` already has the right important behavior: it writes
  under the credential-store lock and clears `principalId` / `principalName`
  when the selected project changes. Move/reuse this logic for `use`, sole-live
  resolution, and stale-default clearing rather than creating an independent
  profile writer.
- The workspace-scoped call sites are `runInvite`, `runPrincipal`, `runToken`,
  `runTaskCommand`, and `runDogfood`. The human call sites already obtain a
  `HumanSession`; pass that through so resolution does not refresh twice.
  `runTaskCommand` / `runDogfood` currently resolve the workspace before reading
  the command credential, so their agent-token behavior needs explicit care.
- Add `status`, `workspaces`, and `use` to `usage()` and `main()` dispatch.
  `Arguments` already recognizes `--json` as boolean, but each command must
  explicitly allow it in `assertShape`.
- The global `safeError()` deliberately strips control characters, including
  newlines. A genuinely useful multi-project error needs a typed/special
  renderer before that generic catch so the human list stays readable and the
  `--json` failure goes to stdout as deterministic structured data. Keep the
  generic sanitizer for all untyped failures.
- The only readline prompt in this file is `confirmationLine()` for invite-link
  origin pinning. Do not reuse it. The workspace path should have no stdin read
  or TTY branch at all; that makes the TTY/non-TTY/no-hang contract structural.
- Update login copy in `main()`: “accept an invitation to choose one” is false
  for an already-member multi-project user. Point a null selection to
  `coswarm workspaces` then `coswarm use …`.

### `src/cloud/auth.ts`

- `discoverSoleWorkspace()` (around lines 386–416, defect line 410) is the
  existing PostgREST read pattern: `/rest/v1/memberships`,
  `authorization: Bearer`, anon `apikey`, and
  `accept-profile: swarm_read`. Reuse this authority shape.
- `login()` persists the discovered project only when exactly one row is
  returned. It otherwise preserves an existing default for the same user and
  writes null on a fresh profile/new machine. Do not add a prompt here.
- A command-time resolver is still required even if login copy or discovery is
  improved: membership can be revoked after login, and §1.4 requires a live
  recheck before a scoped command uses the profile default.
- `logout()` deletes the refresh credential but intentionally leaves the
  profile sidecar. Normal same-user login may therefore retain a prior default;
  a new machine or the uxtest cold-profile reset exposes the null-default bug.

### `src/cloud/storage.ts`

- `CredentialProfile.workspaceId` already represents the selected default. No
  profile-version or shape change appears necessary.
- Use `CredentialStore.withLock()` for every default write/clear.
- On a switch or stale-default clear, also clear `principalId` and
  `principalName`; otherwise a principal checkpoint from one tenant can appear
  selected in another.
- The revoked-default “warn once” property falls out naturally if the first
  resolution clears the stale id under the lock. Later resolutions then see
  null and cannot repeat the warning.

### `README.md`

- Replace the current default-workspace paragraph with the full human flow:
  `coswarm workspaces` → `coswarm use <full-id|exact-unique-name>` →
  `coswarm invite`.
- Keep `SWARM_CLOUD_WORKSPACE_ID` documented as the existing power-user
  override, with flag > env > saved-default precedence. Do not present it as
  the normal recovery path and do not suggest the uxtest harness set it.
- Document that ambiguous names require the full id and that `use` never
  guesses. Do not imply governed project creation exists.

### Read helper placement

- `src/cloud/accept-link.ts` has a private `rows()` helper around the
  `cloudAcceptOperations()` REST reads. It already sets the correct
  `swarm_read` profile and treats non-array/malformed responses as errors.
- Either extract a small generic read helper or mirror that exact pattern in a
  focused `src/cloud/workspaces.ts`. Do not use `service_role`, direct
  `DATABASE_URL`, or the command function for these reads.
- `sanitizeDisplayLabel()` in `src/cloud/invite-link.ts` is the existing FIX-5
  class sanitizer (ANSI, controls, bidi, bounded display). Reuse it for project
  and member labels. Selection by name must compare the sanitized selector to
  sanitized returned names so two confusable raw names collapsing to one safe
  string become ambiguous.

## Migration shape

Add one new migration after `20260724000001_connect_loop.sql`; it should contain
only two additive views:

1. `swarm_read.workspaces`
   - columns: `workspace_id`, `name`, `archived_at`
   - source: `swarm.workspaces`
   - predicate:
     `swarm.is_member(workspace_id, auth.uid())`

2. `swarm_read.member_profiles`
   - join live `swarm.memberships` to `swarm.users`
   - expose at least `workspace_id`, `user_id`, `display_name`; including
     membership `role` is safe and avoids a second join client-side
   - predicates:
     `m.revoked_at IS NULL` and
     `swarm.is_member(m.workspace_id, auth.uid())`

For each view:

- `WITH (security_barrier = true)`
- `ALTER VIEW ... OWNER TO swarm_admin`
- `GRANT SELECT ... TO authenticated, swarm_read`
- `REVOKE ALL ... FROM anon`

The original migration's `GRANT SELECT ON ALL TABLES IN SCHEMA swarm_read` was
evaluated only for objects existing then; explicitly grant the two new views.
Do not alter tables, existing views, RLS/policies, or `swarm.is_member`.

## Existing projections usable by `status`

- `swarm_read.memberships`: live/current role reads and project count.
- `swarm_read.agent_principals`: agent id/name/owner/revoked state.
- `swarm_read.agent_runs`: correlate a principal with the refreshed session's
  `deviceId` for “this machine.” This view does not expose `workspace_id`;
  first obtain the selected project's gated principal ids, then filter runs by
  those ids. Avoid inventing a looser third view.
- `swarm_read.tasks`: already carries `task_id`, `slug`, `lifecycle`, `owner`,
  and `lease_expiry`. The projection is enough for the one-screen status;
  raw epochs are unnecessary.
- `swarm_read.leases` exists if lease history is needed, but the current task
  projection already has the active holder/expiry.

Task `owner` is a canonical UUID string. Resolve it against visible member
`user_id`s or agent `principal_id`s to show a safe label plus the full id.
Unknown holders should remain the full id, never an invented label.

## Selection and resolution traps

- Exact order is flag → env → live profile default → sole live membership →
  fail closed. Do not drop the existing env override.
- The profile-default step requires a live-membership check. When stale:
  emit the exact same human message and JSON message with
  `code: default_membership_revoked`, clear the default/principal checkpoint,
  then continue from the sole/list branch.
- A sole live membership should become the saved default using the same locked
  writer, retaining today's convenience.
- Multi-project failure needs one deterministic sort (safe name, then full id),
  structured `{workspace_id, name, role}` rows, and copy that teaches:
  `coswarm workspaces` → `coswarm use <full-id|exact-name>`.
- `use` should fetch only caller-visible live projects. A syntactically valid
  foreign id and a syntactically valid unknown id are therefore both simply
  absent; route both through one constant error object/message and do not echo
  the selector. This produces the required byte-identical oracle behavior.
- Do every validation and ambiguity check before entering the profile write.
  A failed `use` must cause zero profile writes.
- UUID selection is exact. Name selection is exact after FIX-5 sanitization.
  No prefix, slug, fuzzy, or “closest” branch should exist.
- If sanitized names collide, list every collision with full id and require
  id selection. Full-id selection must still work.
- The existing profile writer must clear the saved principal when switching
  projects.

## Status/rendering traps

- `status` should count distinct live membership project ids, but only show the
  selected project's name. The full project list belongs to `workspaces`.
- Every row with a human label also needs the full corresponding id: selected
  project, member, agent, task, and named holder.
- Sanitize project/member/agent/task display strings at the render boundary
  even if some write paths already validate them.
- Map active task holder UUIDs to member or agent labels. Render remaining time
  from `lease_expiry` (for example “expires in 12m”), never expose epoch jargon.
- Empty members/agents/tasks must be explicit prose. In particular:
  `No work yet — create a task with …`; do not imply users can create a
  project, because governed project creation remains out of scope.
- “This machine” comes from an `agent_runs.device_id` match with the refreshed
  human credential's `deviceId`, not from agent name heuristics.

## Awkward edges to resolve deliberately

1. **Status with zero memberships.** §5 Q1 gives a “none selected” status form,
   while §1.4 describes failure after sole-membership resolution for scoped
   commands. A useful interpretation is identity + project count zero + clear
   accept-invitation guidance, with no project sections, but this should be
   pinned before coding rather than inferred.
2. **`--json` on existing scoped commands.** §1.4 requires the multi-project
   failure body in `--json`, while §3 explicitly requires `--json` for the three
   new commands. Existing `invite`/`principal`/`token`/`command`/`dogfood`
   shapes mostly reject `--json`. Decide whether to accept `--json` only for a
   typed resolution failure or make their success output machine-clean too;
   do not quietly accept a flag whose success output is invalid JSON.
3. **Agent-token commands without human login.** Flag/env must keep working
   before any human read. Profile/sole discovery inherently needs a human
   session; if neither override exists and no human credential is stored, fail
   as not logged in rather than weakening authority or decoding tenant state
   from an agent capability.
4. **Archived projects.** The allowed workspaces view exposes `archived_at`,
   while the selection contract speaks in terms of live memberships. Decide
   whether an archived project with a live membership remains selectable; do
   not silently reinterpret “live” as an archive predicate.

## Test landing points

- Add focused P1 CLI tests for pure listing/selection/resolution and rendering:
  id/name/collision/confusable cases, no-write failures, five-step precedence,
  stale-clear/warn-once, deterministic JSON, sanitization, empty status, and
  lease copy.
- Prove no prompt path by racing the TTY-marked invocation against a short
  timeout; correct text alone is insufficient. The workspace module should
  have no input/readline dependency, making this easy to assert structurally.
- Extend `tests/p1-cli/local-integration.test.ts` for real `swarm_read`
  projection reads and selection against the local stack. It already has user
  creation/sign-in, `LocalMemoryStore`, and fixture seeding patterns.
- Extend `tests/p1-server/command.test.ts` or add an equivalent local authority
  test to prove foreign workspace rows are invisible and inspect
  `pg_get_viewdef`, `reloptions`, and owner for both new views.
- Before/after hash the generated protocol bundle or otherwise assert
  `src/protocol` / `supabase/functions/_shared/protocol.js` is unchanged.
- Run the new migration against local Supabase before any hosted action, then
  `tsc`, `npm test`, `test:p1-cli`, and `test:p1-server`.
