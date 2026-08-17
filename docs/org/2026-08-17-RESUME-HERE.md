# RESUME HERE — 2026-08-17

Supersedes `docs/org/2026-08-12-RESUME-HERE.md`. Written for someone reading the repo cold.

## SECOND SESSION, same day — the sandbox-distribution lane (read this block first)

Everything below it still stands; this block is newer. Full record:
`docs/evidence/2026-08-17-sandbox-distribution/README.md`.

- **v0.1.17 is RELEASED and LIVE**: Node floor is 22 (measured), GitHub release has both assets,
  the live installer serves it, and `npm install -g commonswarm` is a second, verified door
  (package `commonswarm`; npm refused `cswarm` as too similar to `charm`; the command is still
  `cswarm`).
- **`api.commonswarm.com` is the ACTIVE API host** ($10/mo Supabase add-on). The site meta and
  cold CLI discovery now hand it out; the supabase.co URL still serves, and the GitHub OAuth app
  carries both callbacks. A sandboxed agent now needs one allowlist entry: `commonswarm.com`.
- **`Ridge-io/cloud-swarm` is DELETED** (forks were 0 — the clean purge happened).
- **The old-repo decision and the deletion blocker in the earlier block below are RESOLVED** —
  read them as history.
- D-036 ran with codex (exact) + grok (inversion) **at operator direction — Grok is a usable arm
  again by operator ruling this session**; findings all fixed pre-release.
- Ops loose ends for the operator: npm credentials file on the Desktop → move to 1Password and
  delete; npm publish token `~/.config/cswarm-npm-token.txt` expires 2026-08-24 — mint a fresh
  one (npmjs.com → Access Tokens → granular, bypass-2FA) for the next release, or enroll a
  security key.
- **Next release procedure gains one step**: after `gh release create`, run
  `bash scripts/build-npm.sh && cd dist-npm && npm publish` with a valid token.

## What happened today (first session)

1. **The two-agent dogfood against shipped 0.1.16 RAN.** It was the only open engineering item.
   Evidence: `docs/evidence/2026-08-17-two-agent-dogfood/README.md`. Headline results:
   - the D-084 default is live in the shipped binary (`permissionMode: "allow"` with the flag
     omitted);
   - **steady-state `allow` is now MEASURED**: a worker (claude provider) executed a file-write
     tool call under the default mode and the file landed on disk, verified against an
     empty-before control. The register's "never been measured" line is closed for this
     provider;
   - the worker **declines side-effecting asks it reads as injection** even under `allow`
     ("routing metadata isn't authorization") — loudly, with a next step, so not the D-084
     silent shape, but the friction question is open;
   - opencode failed the deny canary **twice at load ~2.5** — evidence against the 08-10 lead
     that D-081 failures are load-driven;
   - two undiagnosed observations: a mid-session model fallback (fable-5 → opus-4-8) surfaced
     in a reply body, and `sender_owner_relation: "unknown"` on a same-owner reply.
2. **The operator's brief update landed** as `8f99429` (AGENTS.md, CLAUDE.md, site/AGENTS.md).
3. **`Ridge-io/cloud-swarm` deletion was attempted and is blocked on one thing:** the active
   `gh` account on this machine is `Ridgeio`, which HAS admin on the repo, but the token lacks
   the `delete_repo` scope. `forks_count` was re-verified **0** today, so the clean-purge window
   is still open. The operator authorised deletion this session.

## Refs, by hash

| ref | what it carries | state |
|---|---|---|
| `8f99429` | operator brief sync across the three agent files | landed on `main`, pushed |
| next commit | this file + the dogfood evidence | landed on `main` |

## What is LIVE vs merely written

- v0.1.16 remains the released, verified binary; the site remains deployed (unchanged since
  08-12, re-exercised today via a real cold install through the live installer).
- Nothing new was released or deployed today. Docs only.

## The next concrete action

1. **Operator, one command:** `gh auth refresh -h github.com -s delete_repo` (device-code flow,
   needs a browser), then anyone can run `gh repo delete Ridge-io/cloud-swarm --yes`. Verify the
   account is `Ridgeio` first (`gh auth status`) — it is the one with admin. Re-check
   `forks_count == 0` immediately before deleting; a fork closes the purge window.
2. **Diagnose the opencode canary failure** (see evidence M-4): it now fails at low load, so the
   load lead does not carry it. First question: does `big-pickle` ever issue a permission
   request for the sentinel prompt? A direct `runPermissionBoundaryCanary` harness against
   opencode 1.18.10 answers it.
3. **Check `sender_owner_relation: "unknown"`** on same-owner replies (evidence, Observation
   section). Find where the relation is computed for reply reads and whether "unknown" is a
   defect or an honest gap.

## Deliberately DEFERRED

- Everything the 2026-08-12 file deferred still stands: D-085 (~25 docs describing the retired
  sandbox), D-087, per-relation permissions, the six round-3 CLI items.
- The M-3 decline-boundary question (how much legitimate same-owner work the worker refuses
  under `allow`) — recorded, not chased; it needs a designed probe set, not one more ask.
- The mid-session model fallback — recorded in the evidence, not chased.

## What was NOT established

- The ACP permission-request shape behind the successful write (file proves the tool call, not
  the permission path; the event log has no labeled permission events).
- `codex` and `grok` providers under the new default — still never exercised.
- The opencode canary failure cause; the `sender_owner_relation` cause.

## Corrections to claims already published

- The 08-10 round-2 evidence offered machine load as the lead for D-081 canary failures. Not a
  correction — it was stated as a lead, not a cause — but today's two failures at load ~2.5 are
  counter-evidence, recorded in today's evidence M-4.
