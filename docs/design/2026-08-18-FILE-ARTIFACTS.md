# File artifacts — specification and implementation plan

**Status: PROPOSED (2026-08-18). Nothing here is built.** Operator directive: agents need to
review file artifacts — plan markdown, Word documents, Excel sheets — so agents must be able
to upload, store, download, and manage files in the workspace.

Written against the tree at the time of writing; section references are to
`docs/design/SWARM-CLOUD.md` (canonical; on conflict it wins).

**Rules marked ★R1–★R16 were pinned by the two-arm review (codex exact, grok inversion,
2026-08-18). Each is load-bearing: an implementation that drops one reintroduces the exact
failure the reviewer named.** Two of them (★R4, ★R7) were found independently by both arms.

## 1. What a file is here, and what it is not

A **file artifact** is a fourth primitive beside workspace, principal, and signal: a named,
workspace-scoped, versioned blob that members and agents can upload and download. It exists
so that "please review the plan" can point at the plan.

What it is not:

- **Not a transport.** Signals stay short and immutable; a signal *references* a file via its
  existing free-text `about` field (`--about file:<file-id>` — the field already accepts up
  to 500 characters, so v1 needs no signal schema change). File bytes never travel inside a
  signal body.
- **Not a git replacement.** Code and anything that lands on a branch belong in git. Files
  here are coordination artifacts: specs, spreadsheets, exports, screenshots — things a
  reviewer opens, not things a build consumes.
- **Not a sync layer.** No watching, no merging, no partial updates. Upload, list, download,
  version, tombstone.

## 2. Ethos mapping (§0): where the friction is allowed to be

- Upload, download, list: **one action, no ceremony** — reversible coordination acts.
- Overwrite: never. A `put` to an existing name creates a **new version**; old versions stay
  readable. Cheap reversibility by construction, matching signal immutability.
- Delete: a **tombstone with a 30-day restore window**, then permanent garbage collection.
  ★R7 — **the ceremony sits on the irreversible act, not the reversible one.** An earlier
  draft put `--confirm` on the tombstone; both review arms flagged that as the §0 test
  applied backwards. So: tombstone is one plain action (it is restorable for 30 days, and
  its response ANNOUNCES the purge date); the automatic purge needs no ceremony because no
  one triggers it; and if a human-triggered permanent-purge verb is ever added, THAT verb
  carries the `--confirm <same-selector>` shape — it is the only genuinely irreversible act
  here.

## 3. Verbs

CLI (matches the existing surface style; every verb takes `--json`, the standard
`--url/--anon-key/--workspace-id` selection, and agent credentials via `--agent-token-stdin`):

```
cswarm file put <local-path> [--name <name>] [--note "<text>"]
cswarm file ls [--include-tombstoned]
cswarm file get <name|file-id> [--version <n>] [--out <local-path>]
cswarm file rm <name|file-id>
cswarm file restore <name|file-id>
```

★R7: `rm` takes no `--confirm` — it is a restorable tombstone, and its output names the
restore verb and the purge date. ★R10: `put` echoes a **versioned** reference,
`file:<file-id>@v<n>`, and that is the form to paste into a signal — a bare `file:<id>` in a
"review this" ask would silently point reviewers at any later version someone uploads.
Default-latest applies only to interactive `get`/`ls`; anything referenced from a signal
should pin the version.

HTTP, for agents that cannot install the CLI (the sandbox lesson of 2026-08-17): the same
operations through the existing `command` and `read` functions — see §7. No new public
endpoint shape to learn; `site/public/api.md` gains one section.

Output copy follows the product voice: what happened, what is now true, what happens next.
`put` echoes the file id, version, size, and the exact `--about file:<id>@v<n>` string to
paste into a signal. `rm` states the restore window and its end date.

## 4. Storage layout, quotas, limits

Backend: **Supabase Storage** (already in the project, currently unused), one private bucket
`swarm-files`, object path `<workspace_id>/<file_id>/<version_n>`. Postgres (`swarm.` schema)
is the authority; the bucket is a blob store that nothing trusts on its own — the durable
row, not the object, decides what exists (durable-by-default doctrine).

Proposed caps, all enforced server-side at version-create time:

| cap | value | why |
|---|---|---|
| per-file (per version) | 25 MB | covers every named review target (md, docx, xlsx, pdf, images) with room; keeps a single signed upload comfortably inside one request and bounds the blast radius of a mistake |
| per-workspace total | 1 GB | ~40× the per-file cap; a coordination store, not a drive. Free-tier arithmetic: 10 workspaces per account stays bounded |
| per-workspace file count | 500 names, 20 versions each | keeps `file ls` a page, not a database |
| upload rate | 30 version-creates per principal per hour | same family as existing signal rate limits; stops a looping agent from filling the quota in a minute |

Exceeding a cap is a refusal with the number in it ("this file is 31 MB; the per-file limit
is 25 MB"), not a bare status.

★R5, amended at S2 review — **what counts toward the 20-version cap: `live` versions
plus UNEXPIRED `pending` rows, and the cap is re-checked at commit.** Counting only live
let concurrent pendings jointly pass a cap either would fill (grok). Expired pendings and
`purged` rows never count — otherwise failed uploads or a tombstone-and-purge loop still
exhaust the cap. The quota SUM for
the 1 GB cap likewise counts `live` bytes plus not-yet-expired `pending` declared bytes
(pending must count there, or concurrent pendings overshoot the workspace cap at commit).

★R16 — **caps need a concurrency rule or they are advisory.** All three checks run inside
the version-create transaction while holding a row lock (`SELECT … FOR UPDATE`) on the
`swarm.files` row for version/name checks and on the workspace row for the byte sum — two
concurrent creates under READ COMMITTED otherwise both pass a cap they jointly exceed. And
version-create is **idempotent by command id**, reusing the command function's existing
command-id replay pattern: a client that lost the response and retries gets the SAME
pending row back, not a second one.

## 5. Content types

Allowlist, checked against the declared content type and the filename extension together:
text (`text/*`, `.md`, `.txt`, `.csv`, `.json`, `.yaml`), documents (`.pdf`, `.docx`,
`.xlsx`, `.pptx`), images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`), archives
(`.zip`, `.tar.gz`). Everything else — executables, scripts, dylibs, unknown binaries — is
refused with the list.

Two supporting rules:

- Signed download URLs always serve `Content-Disposition: attachment` with the content type
  recorded at commit. Nothing is ever served inline from our domain, which is what makes
  `.svg` (scriptable) acceptable on the list.
- ★R8 — v1 does **no content sniffing**, and the honesty has to reach the right audience:
  `attachment` disposition protects a BROWSER, and the primary consumers here are AGENTS
  reading bytes, whom it protects not at all. So the spec states plainly: the recorded type
  is an unverified client declaration, archive contents are unverified (a `.zip` can be an
  unpack bomb), and any agent adapter that automatically downloads or unpacks workspace
  files must treat them as untrusted input — size-bound extraction, no execution, no
  path-traversal-tolerant unpackers. This warning belongs in the adapter implementer docs,
  not only here. §10 defers verification; it does not defer saying so.

## 6. Authorization

- **Upload, list, download: any live member or agent principal of the workspace.** Files are
  workspace-visible by definition, like signals. There are no per-file ACLs in v1; the CLI
  copy says so at upload ("visible to everyone in this workspace") so nobody learns it later.
- **Tombstone: the uploader (human or the agent principal that uploaded), or any human
  member.** An agent may clean up its own artifacts; it may not delete a colleague's. Humans
  hold janitorial authority, consistent with human-only credential operations in §2.
- **Restore: same set as tombstone.**
- **The 500-name cap counts tombstoned names** (decided at S2 review): the name stays
  reserved for restore until the purge, so releasing it early would let a new file take a
  name a restore then collides with. The refusal says what actually frees a name — the
  purge, 30 days after tombstone — never "tombstone one first".
- **GC/purge: nobody calls it.** A scheduled job (pg_cron) purges storage objects for
  tombstones older than 30 days and marks the version rows `purged`. Rows are never deleted —
  the name, hash, sizes, and audit trail outlive the bytes.
- Agent credential semantics are unchanged: same `swm_agt_` flow through
  `_shared/agent-auth.ts`, same revocation checks; a revoked principal loses upload and
  download with everything else.

## 7. Server surface

**Extend `command` and `read`; no fourth edge function.** `npm run check:edge` names its
three entrypoints literally, and a fourth function is precisely the "green check that never
saw the new file" trap AGENTS.md documents. Extending also reuses CORS, auth, rate-limit,
and audit plumbing that a new function would re-implement.

Upload is **two-phase, direct to storage**, because file bytes must not stream through the
command function (request size limits, memory, and double-handling):

1. `file_version_create` (command): validates name, type, declared size against caps
   (under the ★R16 locks); inserts a `pending` version row; asks Storage for a signed
   upload URL **bound to exactly one object path with upsert disabled** (★R1: a
   prefix-scoped or upsert-capable URL is a write capability wider than the row it was
   issued for); returns url + file/version ids. Audited like every command.
2. Client PUTs the bytes to the signed URL (CLI does this inside `file put`; an HTTP-only
   agent does the same two calls).
3. `file_version_commit` (command): server reads the object's metadata from Storage,
   verifies existence, and ★R4 **records the ACTUAL size from storage metadata**, refusing
   if it exceeds the declared size — the declared number gated the quota, the real number
   is what the row must state. The client-supplied sha256 is recorded as an **unverified
   client attestation**, labeled exactly that in the schema and in CLI output. Chosen over
   server-side hashing because hashing 25 MB inside an edge invocation buys integrity
   theater at real memory/time cost: the attestation serves client-side narration
   ("did my bytes arrive?"), while the AUTHORITY facts are path binding, upsert-off, and
   measured size. Revisit alongside §10's content verification.
   ★R2 — commit is a **one-time `pending`→`live` transition, callable only by the
   principal that created the pending row**: the UPDATE carries
   `WHERE state = 'pending' AND created_by = <caller>`; a second commit — or any commit
   against a `live` row — is refused, so a replay can never rewrite the sha256 or content
   type of a committed version.
   ★R3 — the upload capability must not outlive the commit: the object path is
   per-version, the URL is upsert-off, and storage therefore refuses a second PUT to the
   same path. A version whose bytes could change after commit would carry a hash that no
   longer describes them.
   ★R15 — **the pending-row lifetime must exceed the upload URL lifetime.** The pinned
   @supabase/storage-js issues signed upload URLs valid for TWO hours
   (StorageFileApi.ts:345), so a 1-hour pending GC would delete the row while the URL
   still works, leaving an orphan object with no durable record. And the row's clock
   starts BEFORE the URL is signed, so an exactly-2h sweep still races the signing delay:
   the URL lives 2 hours, and **the pending row is swept at 3 hours** — URL validity plus
   an hour of margin. The purge job also sweeps **orphan objects** — storage paths with
   no row, or whose row expired un-committed — on the same schedule.

Download mirrors it in one step: `file_download_url` (command) verifies membership and
liveness, then returns a signed URL good for 5 minutes. Issuing a download URL is a command,
not a read, because it grants a capability and belongs in the audit trail with an actor.

★R1 — **every file command resolves its target by the compound key
`(workspace_id, file_id)`, never by `file_id` alone.** The classic miss is
lookup-by-id-then-check-the-caller's-membership-in-the-ROUTED-workspace: the caller is a
member of workspace A, routes workspace A, and names a file_id from workspace B — every
check passes and the download URL crosses the tenant boundary. The compound key kills the
whole class. It applies to `file_download_url`, `file_version_commit`, `file_tombstone`,
and `file_restore` alike, and ★R14 backs it at the schema layer.

★R6 — **purge and restore race, so purge claims in one transaction**:
`UPDATE … SET state='purged' WHERE tombstoned_at < now() - interval '30 days' AND state !=
'purged' RETURNING …`, then deletes the claimed objects; `file_restore` refuses any row the
purge already claimed. Outstanding signed download URLs: a tombstone does NOT revoke them —
they expire naturally within 5 minutes, which the tombstone response says; at purge the
object itself is gone, so any straggler URL dies with it.

List is a read: `read` gains `resource: "files"` returning name, id, current version, size,
content type, uploader, created/tombstoned timestamps. Same shape rules as the existing
members/signals resources.

Reducer involvement: file commands are **not** routed through the pure protocol reducer.
The reducer governs the signal/authority core; files are an I/O-bound side surface with
their own tables, like durable deliveries already are (`durable-delivery.ts` is the
precedent — direct handlers beside the reducer in the same function). This keeps
`build:command-core` untouched.

★R9 — **bypassing the reducer means the handlers re-implement its protections, so here is
the exact list S2 must carry, enumerated so none can be forgotten:**

1. revocation check on EVERY command (token, principal, run, device, membership,
   tombstone ledger — the same set `agent_delivery_read_context` consults);
2. the agent-scope rule: nothing in the file surface joins `HUMAN_ONLY_COMMANDS`
   implicitly — each new kind is classified, in writing, as agent-allowed or human-only
   (v1: all five are agent-allowed except nothing; tombstone/restore carry the §6 actor
   rule instead);
3. an audit row per command, accepted or refused, with human + principal + run
   attribution (G3);
4. command-id idempotency (★R16);
5. workspace tenancy via the ★R1 compound key;
6. rate limits from §4, enforced in the same place the signal limits are.

A green S2 that lacks any line of this list is the reducer-bypass failure the review
predicted, found before it was written.

## 8. Schema sketch

```sql
CREATE TABLE swarm.files (
  file_id        uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES swarm.workspaces,
  name           text NOT NULL,            -- unique per workspace, case-insensitive
  created_by_kind text NOT NULL,           -- 'user' | 'agent'
  created_by     uuid NOT NULL,            -- user_id or principal_id
  current_version integer NOT NULL DEFAULT 0,
  tombstoned_at  timestamptz,
  tombstoned_by  uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- ★R14: the composite target for file_versions' composite FK.
  UNIQUE (file_id, workspace_id)
);

-- ★R13: expression uniqueness needs an index, not a table constraint —
-- UNIQUE (workspace_id, lower(name)) inside CREATE TABLE does not apply in PostgreSQL.
CREATE UNIQUE INDEX files_workspace_name_ci
  ON swarm.files (workspace_id, lower(name));

CREATE TABLE swarm.file_versions (
  version_id     uuid PRIMARY KEY,
  file_id        uuid NOT NULL,
  workspace_id   uuid NOT NULL,            -- denormalized for RLS and quota sums
  version_n      integer NOT NULL,
  state          text NOT NULL,            -- 'pending' | 'live' | 'purged'
  size_bytes     bigint NOT NULL,          -- ★R4: measured at commit from storage metadata
  sha256         text,                     -- ★R4: UNVERIFIED client attestation, not authority
  content_type   text NOT NULL,            -- ★R8: unverified client declaration
  storage_path   text NOT NULL,
  uploaded_by_kind text NOT NULL,
  uploaded_by    uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  committed_at   timestamptz,
  UNIQUE (file_id, version_n),
  -- ★R14: a version can never disagree with its file about the tenant. A plain FK on
  -- file_id alone lets a hand-written workspace_id diverge, and the denormalized column
  -- is what RLS and the quota SUM read — divergence there IS the tenant-isolation bug.
  FOREIGN KEY (file_id, workspace_id) REFERENCES swarm.files (file_id, workspace_id)
);
```

RLS: both tables follow the signals pattern — workspace members read; all writes go through
the command function's SECURITY DEFINER path, never direct table grants. The storage bucket
itself has **no** client policies: every object access goes through server-issued signed
URLs, so `storage.objects` stays service-role-only and the authorization logic lives in one
place.

Quota enforcement is a SQL sum over `file_versions` where `state != 'purged'` inside the
version-create transaction — no counter row to drift.

## 9. Web dashboard

v1: a **read-only file list** on the workspace view (name, size, version, uploader, age) with
a download button that calls `file_download_url` with the human session. No web upload in v1
— the uploaders are agents and CLI users today, and a dropzone is its own project. The list
exists so a human can see what their agents are passing around without opening a terminal.

## 10. Deferred from v1, deliberately

- Content-type verification / sniffing, malware scanning, secret scanning. Argued: artifacts
  are reviewed, not executed; downloads are explicit attachments; every byte is attributable
  to a principal. Revisit before any public-tenant milestone.
- Per-file ACLs and cross-workspace sharing.
- Previews, rendering, diffing, and search inside file content.
- Web upload; resumable/multipart upload (the 25 MB cap is what makes single-shot viable).
- Signal-side hydration of `about: file:<id>` into a rich link (`feed` prints the bare ref).
- Any file > 25 MB. That is a different product (or a git LFS question).

## 11. Implementation plan — landable stages, each with its gate

The gate column names the script that actually runs the stage's tests, because a test file
no script reaches is silently not run (AGENTS.md trap; the D-025 scar).

| stage | contents | gate |
|---|---|---|
| S1 | migration (tables + RLS + pg_cron purge), applied locally only. ★R12: also VERIFY that no leftover storage configuration or policy grants client access — `supabase/config.toml` carries unused storage config today, and the bucket must go live service-role-only | `npm run test:p1-local` (announced DB slot) + an enumerated policy listing in the stage's evidence |
| S2 | command kinds `file_version_create/commit`, `file_download_url`, `file_tombstone/restore`; read `resource: "files"`; caps + rate limits; audit rows | `npm run test:p1-server` (Docker + slot) — new test files under `tests/p1-server/` are reached by that glob; plus `npm run check:edge` |
| S3 | CLI verbs (`file put/ls/get/rm/restore`), copy, `--json` shapes | new files under `tests/p1-cli/` (glob-reached) + any pure helpers named in the `test` script's literal list — say in the change which script picks each file up |
| S4 | storage integration end-to-end against local Supabase: signed upload, commit verification, pending-GC | `test:p1-local` |
| S5 | web read-only list | `npm --prefix site test` |
| S5b | ★R11: amend the LIVE `/acceptable-use` page BEFORE the feature ships — its current text names "a file store" as a breach of policy, which would make this feature a policy violation on its own site. The amendment scopes it: workspace file artifacts are a product feature; the "general infrastructure" prohibition stays for non-artifact bulk storage | site deploy + a grep of the DEPLOYED page for both the new carve-out and the retained prohibition |
| S6 | migration applied to production, functions deployed, CLI released (both assets + npm), site deployed, `api.md` section added | the deploy checklist in AGENTS.md, verified against the DEPLOYED surfaces |

S1+S2 land together (a migration nothing reads is inert but a command without its tables is
red); S3 can land behind them; S4 gates S6. Two-arm review per D-036 on every SHA-changing
stage.

## 12. Open questions for review

1. Should `file_download_url` be per-version or always-current by default? (Spec says
   current unless `--version`; reviewers may prefer explicit-always.)
2. Is 30 days the right restore window, or should it match the signal `--until` cap (30d)
   by rule rather than coincidence?
3. Does the two-phase upload need an explicit abort verb, or is the 3-hour pending sweep
   (★R15: 2h URL validity plus margin) enough?
4. Case-insensitive name uniqueness: right call, or does it fight agents that generate
   `Plan.md` and `plan.md` as distinct artifacts?
