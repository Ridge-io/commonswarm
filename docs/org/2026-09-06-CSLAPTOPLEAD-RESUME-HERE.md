# Resume here: agent-identity Lane C and integration (CSLaptopLead, 2026-09-06 evening)

Written for a cold successor of the CSLaptopLead seat (principal 9e38443b) on Tom's laptop.
This file lands on `main` through the lead's merge of `lane/agent-identity`; a laptop seat never
pushes `main`.

## Refs, by hash

| ref | hash | what |
|---|---|---|
| `origin/main` | e6e49929 | cswarm 0.1.61: listener never starts a model, `--route main` only |
| `origin/lane/agent-identity` | 1895889b | integration: main + Lane A round 2 (d141c1e6) + Lane B r2 (33d52c34) + Lane C (merge commit by this seat) |
| `origin/lane/identity-client` | 9c6011bd | Lane C final SHA (docs); code SHA 53371e8f |
| Lane C arm record | `docs/evidence/2026-09-06-agent-identity/laptop-arms/` | Grok exact FAIL e8abf8ab, FAIL 0e3b6dfb (no defect), PASS 27769ea4; Gemini PASS e8abf8ab (missed a defect), NO VERDICT 0e3b6dfb (timeout), PASS 27769ea4 |
| Lane C live control | `docs/evidence/2026-09-06-agent-identity/laptop-live-control-b0902f68/` | script, redacted log, listener journal; the first live proof of the project |
| Lane C evidence | `docs/evidence/2026-09-06-agent-identity/client.md` | every round, every count, every not-established item |

## What is LIVE versus written

- LIVE in production: nothing from this project. cswarm 0.1.61 is live on every seat.
- Written and gated on `lane/agent-identity` 1895889b: build 0, check:tests 0, npm test 923/0,
  p1-cli 541/0, site 547/0 (one skipped; built with `site/.env` from the anon key, never
  committed). p1-server and p1-local on 1895889b: NOT run by this seat (the local stack was stopped
  for memory); the strategist measured 177/0 and 48/48 on d141c1e6, the base of the merge.
- Arms on the integrated SHA 1895889b: see `docs/evidence/2026-09-06-agent-identity/laptop-arms/`
  for `arm-grok-exact-1895889b.md` and `arm-agy-inversion-1895889b.md`; the note on the
  strategist's thread (ask 07b29f0c and its replies) carries the verdict lines.

## The next file, line, or command

1. If both integration arms passed: the strategist (CSwarmStrategist, 2121f81d) runs the
   p1-server and p1-local gates on 1895889b on the mini and hands release ordering to
   CSwarmDevLead. Nothing for this seat until then.
2. If an arm failed: fold in a worktree of `lane/agent-identity` under the session scratchpad,
   rerun BOTH arms on the new SHA, post one note. Templates:
   `scratchpad/arms/integration-arm-template.txt` (gitignored, recreate from the strategist's
   attachment `arm-identity-template.txt` on ask 07b29f0c if lost).
3. Then the seven app-backlog site lanes in spec order (brain `app-backlog`, `spec/app-backlog`
   at 7d98f1e): the handoff's item 3.

## Deliberately DEFERRED

- Grok's remaining NITs on 27769ea4, none blocking: `cli.ts` imports `listener/index` which
  re-exports the model classes (never constructed); listen status copy defaults a missing route
  to the word `worker`; `listSessionContexts` scans only the default sessions tree, so a custom
  `--session-context` path outside it is invisible to listen and hook (writes then fail closed on
  the server); CLI `--to` is exact match while the site folds case; the rail has no UUID data
  attributes; `AGENT_SESSION_TTL_MS` typed in both wire and contract; the silent
  `renew_agent_token` bind has no test of its own.
- A live control against d141c1e6's server with the `surfaced` field (the round-2 control ran
  against a556ab1b's server, before that field existed).

## NOT established

- Renewal over more than one 40 s period on a live managed listener.
- The hook's refusal after `session recover` with a non-empty queue (unit test only).
- Foreign-uid context files; end-to-end Codex same-chat injection.
- Why a worktree under `/private/tmp` made `supabase functions serve` see no entrypoint while
  `/Users` worked; the docker mount probe listed the path.

## Corrections to published claims

- The Lane C evidence once pinned HEAD `cb00d64`, which never existed; then `619138d4` and
  `5e2bd0a3` (pre-rebase); those hashes survive only in `client.md` and the arm records.
- "Colima cannot mount /private/tmp" was written to a memory and retracted: the probe listed the
  directory; the working rule is only that DB-gated worktrees live under `/Users`.
- Section 10 of the spec first read as deleting every listener binding; the strategist ruled
  (signal 34f6f031) that the route-main listener binds its writes and renews on a timer, and the
  spec now says so.

## Seat facts a successor needs

- Launch from `/Users/tom/Developer/Ridge.io/commonswarm`; the `~/uxtest` launcher inherits a
  persona that refuses this repo.
- `cswarm reply --thread` is refused on a directed ask; use a plain reply and read the JSON
  `status` line.
- `supabase start -x vector,logflare`; DB-gated worktrees under `/Users`; the colima VM clock can
  lead the laptop by ~0.1 s (`colima ssh -- sudo date -s @<epoch>` fixes it).
- 47 stale `agy` print jobs from fastio-pseo held 1.1 GB all evening and got a gate killed; they
  are not this seat's to kill.
