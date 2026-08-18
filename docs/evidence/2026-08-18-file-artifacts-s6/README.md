# S6 — file artifacts SHIPPED to production, and what the ship itself caught

**2026-08-18/19.** The final stage of docs/design/2026-08-18-FILE-ARTIFACTS.md. Everything below
was verified against the DEPLOYED surfaces, per the repo rule.

## The ship

- Migration `20260818000001` applied to production (`supabase migration list` shows both columns).
- `command` (v23) and `read` (v7) deployed. ★R12 verified ON PRODUCTION: bucket `swarm-files`
  exists with `public=false`, **zero** policies on storage.objects, and the purge cron
  `swarm_purge_file_artifacts` scheduled hourly.
- **v0.1.20 released**: GitHub (both assets), `commonswarm@0.1.20` on npm, site deployed —
  `/download` shows 0.1.20, the AUP carve-out is live with the old blanket ban gone (grep
  controls both ways), and a cold install through the live installer produced `cswarm 0.1.20`
  with the `file` verb family present.

## The proof

With the cold-installed binary against production (Dogfood Workspace):
`file put` → `file get` to a different path → **sha256 byte-identical** → `file rm` announcing
the 30-day restore window and the purge consequence → `file restore`. The web Files panel
renders the same rows live: the file downloadable, tombstoned probes struck through with
restore dates, the content warning above the list.

## The defect only production could show — and S6's verification caught it

The FIRST production put failed at commit: "no object was uploaded" — while the bytes were
verifiably in the bucket. Deterministic by size: 12 B passed, 103 B markdown failed. Root
cause, measured against the exact failed object: `objectSize` read a HEAD's `content-length`;
Deno's fetch always negotiates compression; hosted storage answers compressible objects with
`content-encoding: br` and NO content-length (confirmed: the same HEAD with identity encoding
carries `content-length: 103`, with `gzip, br` it carries only `content-encoding: br`); the
runtime strips the header after transparent decompression, so the server honestly reported an
absent object. The local storage container never compresses, which is why S4's e2e was green —
S4's evidence had explicitly named hosted HEAD semantics as NOT ESTABLISHED, and this was that
exact gap arriving on schedule. Fixed in `14a1409` (`objectSize` reads the `info` endpoint's
metadata JSON, transport-independent), local suite 10/10, redeployed (command v23), and the
round trip passed.

The lesson, stated once: **a not-established list is a forecast.** The gap it names is where
the production failure will be, and the S6 stage exists to walk that list against the real
backend before any user does.

## Residue

Six probe/failed-attempt files remain in Dogfood Workspace: two tombstoned (purge frees them
after the window), four v0 pending slots whose rows self-expire at 3h and whose queued paths
the drain retires. One unreproduced p1-local failure occurred on the first post-reset run of
the merged tree (10/10 on both immediate reruns and both branch runs; the failing test's name
was not captured) — recorded here rather than called transient.

## Not established

- Concurrent purge drains and a non-outage storage-5xx body (carried from S4).
- The web download path exercised only to URL issuance in automation; the click-through was
  manual-visual. pg_cron's first real firing lands at the next :17 and was not awaited.
