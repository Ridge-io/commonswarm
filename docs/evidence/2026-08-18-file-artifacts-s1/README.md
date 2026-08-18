# File artifacts S1+S2 — implementation evidence

**2026-08-18, worktree branch `worktree-agent-a213804f188e95957`.** Implements stages S1
(migration) and S2 (command/read surface) of `docs/design/2026-08-18-FILE-ARTIFACTS.md`.
Applied to the LOCAL stack only; production was not touched.

## What was run, and what passed

| gate | result |
|---|---|
| `npm run check:edge` | all three functions typecheck, exit 0 |
| `npm test` | 536/536 |
| `npm run test:p1-cli` | 255/255 |
| `npm run check:tests` | clean |
| `npm run test:p1-server` | **71/73** — the 4 new file tests pass; the 2 failures are pre-existing (below) |
| `npm run test:p1-local` | 4/4 |

**The two `test:p1-server` failures are NOT this lane's.** `self-serve is capped per
identity…` and `self-serve refuses throwaway domains…` fail identically with this lane's
functions AND with the base commit's (`git checkout 5a382af -- supabase/functions`, rerun,
still failing), on a fresh `npm run db:reset`. Both expect the fourth self-serve workspace
creation to refuse 403 and observe 200 — the cap is not enforcing on this machine's stack.
Out of scope here; needs its own investigation (suspect: local supabase CLI 2.98 stack vs
the config seed, or a recent main change — not established).

## ★R12 policy listing

`policy-listing.txt` beside this file: **zero policies exist in the `storage` schema**, the
`swarm-files` bucket is private, `swarm.files`/`file_versions` carry only the
`swarm_command` RLS policy, and the purge job is scheduled. Enumerated from the local stack
after the migration applied.

## Mutation verification of the IDOR control (★R1)

The F2 test drives a member of workspace B through B's route naming A's file for all four
compound-key commands and requires 404 on each. Mutation: the `f.workspace_id =` predicate
was removed from `fileDownloadUrl`'s query → F2 **failed**; restored → F2 passes. The
control discriminates on exactly the predicate it exists to pin.

## Deviations from the spec, with why

1. **Signed URLs are returned as RELATIVE paths** (`upload_path`, `download_path` under
   `/storage/v1/…`), not absolute URLs. Measured: under `supabase functions serve` the
   runtime's `SUPABASE_URL` is the internal Docker hostname (`http://kong:8000`), so an
   absolute URL built server-side is unreachable from any client; and in production a
   client may reach the service through `api.commonswarm.com` OR the supabase.co host —
   the server cannot know which host the caller's egress allows. The client prepends its
   own deployment URL. S3 (CLI) must compose accordingly; the spec's §7 "returns url"
   wording should be amended at S3.
2. **The purge job queues object deletions instead of deleting them.** Measured: storage
   protects its tables with a trigger — *"Direct deletion from storage tables is not
   allowed. Use the Storage API instead."* — so SQL-side object deletion is impossible,
   local and hosted alike. The claim (★R6) still happens in one transaction and flips rows
   to `purged` (restore refuses immediately); claimed and orphan paths land in the new
   durable `swarm.file_purge_queue`, and **S4 drains the queue through the Storage API**
   with the service key. Until S4, purged bytes persist in the bucket with no live row —
   bounded by S4 landing before S6 ships anything to production.
3. **`--test-concurrency=1` added to `test:p1-server`.** The suite is now two files, each
   owning the single local functions runtime; concurrent spawns collide on the port. The
   flag serializes files, which is what a single-stack suite needs.

## ★R9 classification decision

All five file kinds are agent-allowed by CLASS (exempt from the per-scope gate the way
delivery commands are), because existing minted tokens cannot carry new scopes and files
are workspace-visible like signals. Recorded in `file-artifacts.ts`'s header and at the
gate in `index.ts`. Tombstone/restore enforce the §6 own-uploads rule for agents in SQL.

## Not established

- **Hosted storage behavior**: signed-upload upsert-off refusal, HEAD content-length, and
  the sign endpoints were exercised against the LOCAL storage container only. S6 must
  re-verify against production storage before deploy.
- The 30/hour create rate limit is wired through `incrementRateBucket` but not exercised by
  a test (30 uploads is slow); the bucket key is `file:create:<kind>:<id>`.
- Per-name 20-version and 500-name caps: enforced in SQL under row locks, not exercised by
  tests (volume). The 25 MB and content-type refusals ARE tested.
- Concurrent create racing (the ★R16 lock) is enforced via `FOR UPDATE` but not exercised
  by a concurrency test.
- The pre-existing self-serve failures above.
