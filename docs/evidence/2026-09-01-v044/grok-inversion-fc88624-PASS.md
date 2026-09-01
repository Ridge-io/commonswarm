# Grok inversion of fc88624 — VERDICT: PASS (2026-09-01)

I'll invert this range, not confirm it. First I'll reconstruct the 20260902000002 wire and run the pre-619ff1f parser against it, then attack the seven claims.Joining the swarm, then extracting the migration wire and the old parser so I can run them against each other.Old parser is extracted. Next I’ll join this repo’s swarm and run the wire against it.Parser and dashboard are in view. Next I’ll build the wire, run the old parser, and open the renderers and hook/file paths.Human list now uses `fetchWithDeadline`, but it never takes a caller deadline. I'll check whether a hung fetcher actually aborts, then run the wire.I have the old parser and the 0.1.43 blob. Next I’ll construct the wire and run the real parsers and renderers.No test calls `listFilesAsHuman`. I’ll run the wire, the old parser, the renderers, and a hung human-list fetch myself.Checked the 0.1.43 parser against the new wire. That is the break I missed on 619ff1f. It parses.

## D1 — 0.1.43 vs the 20260902000002 wire

I built the JSON that 20260902000002 returns for a broadcast (human rows in `receipts`, agents only under `broadcast_roster.agents.principals`). Then I ran four parsers on the same object.

| Parser | New wire | Old 00001 wire (agents in `receipts`) |
|---|---|---|
| npm **0.1.43** (from the published tarball) | PARSE_OK | THROW `malformed acked_at` |
| **619ff1f^** source | PARSE_OK | THROW same |
| HEAD | PARSE_OK | THROW `agent tracking row inside receipts` |
| **619ff1f** (unreleased) | THROW `malformed broadcast roster` | — |

0.1.43 also accepted: extra top-level keys, `display_name`, Postgres timestamps (`+00:00` and microseconds), `seen_at: null`, and a human row that also had `tracking_state`. Directed `{addressed: true, receipts: [human]}` parsed.

The in-repo test never loads the 0.1.43 blob. I did. The blob did not choke.

0.1.41 is still a one-branch parser. It will throw on every broadcast after this migration. The migration header already says that. The commit subject (“every installed client”) is wider than the header.

619ff1f itself (on main, not on npm) throws when `agents.returned > 0` because it still wants tracking rows in `receipts`. That is the apply order: do not leave a 619ff1f client against 00002.

## (1)(2) “Seen by X of Y” and 100/60

Production “Seen by X of Y” exists in two places: CLI `receipts.ts` and dashboard `browserDeliveryIndicator`. Both use `roster.members.seen` / `total`, not `receipts.length`.

I ran the real renderers via `npx tsx` on 100 members, 60 seen, cap 50:

- CLI: `Seen by 60 of 100 workspace members.` / `40 not shown (roster cut).` / `10 more not shown (roster cut).` / no `Not-seen members: none`
- Dashboard model: label `Seen by 60 of 100`; not-seen lines `['40 not shown (roster cut)']`; no `None`
- Spawned `src/cli.ts receipt` against a fake server: same strings, exit 0

I did not find a surface that prints “Seen by X of Y” from the capped array.

## (3) limit shape

HEAD parser, live calls:

- **accept:** limit 100, 7, 1
- **refuse:** 0, -1, 1.5, `"50"`, null, missing, NaN, Infinity, returned 50 > limit 49, returned 51 > limit 50

The dashboard parser is the same shape check in source. Nothing in the suite feeds those values through `browserDeliveryReceipts`.

## (4) seen-first ORDER BY

No database (as ordered). I did not run Postgres.

The 52-member fixture names put `"Seen recipient"` at rank 51 by name. A name-only top-50 drops it. A seen-first top-50 keeps it. The SQL has `ORDER BY first_seen_at IS NULL` on both the `LIMIT` subquery and `jsonb_agg`. I did not mutation-test that on real Postgres.

## (5) human file list hung fetch

`listFilesAsHuman` has **zero tests**. I ran it.

- AbortSignal is passed (1 signal, not aborted at 50ms)
- Hung fetch that **listens** to abort: settled at **30005ms**, `FileTransportError` `noResponse=true`
- Hung fetch that **ignores** abort: still pending at **35s** (`fetchWithDeadline` does not `Promise.race` the abort)
- CLI `fileRows` wraps this in `onceRetried`, so a cooperative hang is **60s**, not 30s

Cooperative hang is bounded. Abort-ignoring hang is not. `cswarm file ls` has no 3s process ceiling like the hook.

## (6) hook digest

Ran the real tests: cooldown, digest-after-message, failed brain-list. 3/3 pass.

`digestCandidate` is set only when `networkAllowed` is true, and the digest runs after `write(messages)`. A cooldown tick cannot list files. I did not find a path that prints the digest before stdout.

## (7) 0.1.43 choke list

I did not find one on the 00002 wire. Extra keys ignored. Human branch first. `broadcast_roster` dropped. 50 human rows parsed.

---

What I did **not** establish: G1 on live Postgres; abort-ignoring file-list settlement; an in-repo gate that loads the npm 0.1.43 blob.

VERDICT: PASS
