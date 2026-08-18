# S4 — end-to-end storage proof against the local stack

**2026-08-18.** Stage S4 of `docs/design/2026-08-18-FILE-ARTIFACTS.md`, gated by
`npm run test:p1-local` per the plan.

## What S4 turned out to be

S1's own record deferred one piece of the system to this stage: **the purge queue had no
consumer**. SQL cannot delete storage objects (the storage schema trigger refuses — measured
in S1), so `swarm.purge_file_artifacts()` queues object paths into
`swarm.file_purge_queue`, and until this stage nothing ever drained it: purged files kept
their bytes forever. S4 therefore SHIPPED CODE, not only tests:

- `FileStorage.removeObjects(paths)` — batch deletion through the Storage API, required to
  succeed for paths that never held an object (a pending row GC'd before its PUT).
- `drainFilePurgeQueue(tx, storage, limit)` in `file-artifacts.ts` — claims up to `limit`
  undrained rows with `FOR UPDATE SKIP LOCKED`, deletes the objects, stamps `deleted_at`.
- An opportunistic best-effort drain in the command function AFTER any file command's own
  transaction commits, in a separate transaction — a storage outage can never fail the
  command that triggered the drain; the durable queue makes the drain at-least-once.

Trigger cadence is deliberate v1: the drain runs on file-command traffic only. A workspace
with no file activity retains queued rows — the bytes are already unreachable (private
bucket, service-role-only, purged DB rows), so what waits is reclamation, not exposure.

## What the suite proves against REAL storage (tests/p1-local/file-artifacts-e2e.test.ts)

| test | proof |
|---|---|
| S4-1 | an object LARGER than its declaration is refused at commit (`file_size_exceeds_declaration`) — the declaration gated the quota |
| S4-2 | the signed upload capability binds one object: a second PUT through the same capability is refused even before commit (upsert off at sign time, ★R3 — first time exercised against a real storage backend) |
| S4-3 | the whole purge pipeline: tombstone → SQL-aged 31 days → `purge_file_artifacts()` claims and queues → restore correctly answers 410 → the drain deletes the REAL object (verified gone via service download) and retires the queue row → the name frees for a fresh create (partial-index rule) |
| S4-4 | pending GC: a never-uploaded slot aged past the 3h sweep (★R15) is claimed, and its queue row — a path with NO object behind it — drains without error |

The declared-greater-than-actual half of ★R4 (measured size recorded, not the declaration)
was already pinned by p1-server F1 and is not duplicated here.

**Mutation check:** with the drain limit set to 0, S4-3 and S4-4 both FAIL on their
drain assertions; restored, both pass. The instrument discriminates.

## Gates on the committed tree

- `npm run test:p1-local` **8/8** (both files, `--test-concurrency=1` — each file owns the
  one functions runtime; the gate-coverage pin moved WITH the script change, deliberately)
- `npm test` **536/536** · `test:p1-cli` **255/255** (after a fresh `npm run build` — the
  description gates run against `dist/`, the same trap S3 recorded)
- `check:edge` exit 0 · `check:tests` exit 0
- `test:p1-server` **75/77** — the 2 failures are the pre-existing self-serve cap pair,
  proven pre-existing in the S1 evidence

## Review round (two-arm) — four items, all closed

1. **Drain isolation**: the storage DELETE now carries `AbortSignal.timeout(3s)`, and the
   drain detaches behind `EdgeRuntime.waitUntil` where the runtime offers it (feature-
   detected; the fallback await is bounded by the 3s abort). A hung storage call can no
   longer delay an already-committed command's response.
2. **Durable attempt accounting** (the D-090 family): `file_purge_queue` gained
   `attempt_count`, `last_attempt_at`, `last_error` — amended IN PLACE in the S1 migration,
   which has never been applied to production. The stamp rides the claim UPDATE so a failed
   try cannot roll back its own record; the failure branch writes bounded `last_error` and
   returns instead of throwing across the transaction.
3. **The copied-file control** is back in the D-030 gate: a stack-touching file duplicated
   into a pure-gate directory is caught by the per-basename exact-path check again.
4. **Coverage**: S4-5 pins the 10-row batch boundary (12 rows → exactly 10, held stable,
   then the rest) and success-path attempt stamping; S4-6 drives the REAL failure branch —
   the only drivable storage failure. Measured first: every malformed prefix (newline,
   empty string, 3000 chars) answers 200 from local storage, so S4-6 stops the storage
   container, asserts the failed attempt stamps durably with the row still eligible,
   restarts it, and asserts the same row drains clean with `last_error` cleared.

Two flakes found and fixed while stabilizing, both lessons worth keeping:
- A DETACHED drain from an earlier test can land mid-count (S4-5 now quiesces the queue
  first and holds the boundary assertion through a straggler window).
- S4-3's "object exists pre-drain" assertion raced a legitimately-dispatched drain — the
  drain working is not a test failure. The existence assertion moved to post-commit, where
  no queue row for the path can exist yet. Racing your own feature is not a claim.

## NOT established

- Hosted-storage behavior: signed-URL single-use semantics, `x-upsert` honor, HEAD
  content-length, and the DELETE endpoint's response shape were all measured against the
  LOCAL storage container only. S6 re-verifies every one against production before the
  feature is called live.
- Concurrent drains against one queue (SKIP LOCKED disjointness is SQL-read, not raced by
  two live runtimes) and a true storage-5xx (non-outage) response body.
- pg_cron actually firing on a schedule (the function body is driven directly here; the
  cron registration itself is applied but its firing is production-observable only).
