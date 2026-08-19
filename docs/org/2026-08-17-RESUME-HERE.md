# RESUME HERE — 2026-08-17

Supersedes `docs/org/2026-08-12-RESUME-HERE.md`. Written for someone reading the repo cold.

## 2026-08-18, second lane — 24h bootstrap credentials (v0.1.19) and the file-artifacts spec

- **v0.1.19 is RELEASED and LIVE** (GitHub + npm + site + edge). Bootstrap agent credentials
  may last 24h (operator ruling after a measured sandbox onboarding failure); rotation
  successors deliberately stay 8h. The web connect flow now mints at the 24h max, and the
  onboarding prompt tells sandboxed agents that allowlist changes need a FRESH session.
- **The edge `command` function carries a hand-written duplicate of AGENT_TOKEN_MAX_TTL_MS
  (index.ts:386) outside the generated bundle** — it drifted on the first deploy and the
  server refused what the reducer allowed. It now carries a warning comment; treat any
  future protocol-constant change as a two-file change.
- Both D-036 arms then found the CLAIM family unmoved (reducer message, SWARM-CLOUD.md,
  api.md, acceptable-use, llms.txt) — fixed in `f27bdf8`, swept with a control that excludes
  the still-true successor-8h claims.
- **`docs/design/2026-08-18-FILE-ARTIFACTS.md`** (workspace file storage spec) is drafted and
  under amendment for 16 confirmed review findings from codex (4 P1: DDL cannot apply,
  composite FK, pending-cleanup vs 2h upload-URL race, no concurrency rule on caps) and grok
  (command-layer IDOR via bare file_id, commit replay, upload-URL-after-commit overwrite,
  version-spam, purge/restore race, AUP clash, inverted friction placement). Implementation
  is NOT started — the amended spec is the queue head for the next engineering lane.
- **CSwarmDev is a live agent in the Science Swarm workspace** (principal 297b8698, listener
  on yulanbots-mac-mini, provider claude, allow). An ask about file-exchange needs is out to
  the resident Claude agent; reply may arrive via the listener.
- The Cowork 403 saga root cause: the sandbox proxy answers 403 for non-allowlisted hosts and
  a RUNNING session keeps its startup network policy — the backend had authorized the token
  all along (verified by replaying the exact request: 200). CLI defect recorded: bare
  "HTTP 403" hides the response body, making proxy and authorization refusals
  indistinguishable.

## 2026-08-18 — v0.1.18 shipped from the fan-out sweep (newest; read first)

An operator-directed fan-out (codex arm: repo; grok arm: site) swept for surfaces still
asserting the pre-0.1.17 state and found ~30, including **one real bug**: the invite-link
origin pin only recognized the supabase.co host, so links minted under `api.commonswarm.com`
were refused in agent mode. Fixed, reviewed two-arm (grok's inversion refuted the first
version of the fix's copy — the hosted reader had a URL but no key source — and that is also
fixed), released as **v0.1.18**: GitHub release with both assets, `commonswarm@0.1.18` on
npm, site deployed showing 0.1.18, both cold install doors verified. The onboarding prompt
now names the npm fallback for sandboxed hosts, and the no-target errors name discovery and
the anon key's public source. Commits `e298b25` (code+sweep) and this one.

Still open from the Cowork dogfood: the agent's 403 was a principal/workspace mismatch —
the fix is minting principal AND token against the same workspace id; not a product defect
on current evidence.

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

## 2026-08-18, evening — the owner-grouped roster shipped everywhere, built by codex+grok lanes

The landing hero's owner-grouped design (humans head their own agents; agents carry their own
names with model-family glyphs; real vendor marks) is LIVE on both surfaces: the marketing hero
(`6964607` and prior) and the /app dashboard rail (`b3002da`, verified by signed-in screenshot
of the DEPLOYED app). Division of labor on operator direction: grok built the shared
closed-default `model-glyph` module (`2400dc3`); codex built the rail restructure and rewrote
the observers; grok's inversion refuted two claims (silent orphan drop; observers hand-writing
the markup they measured) and both fixes are mutation-verified. Also landed earlier the same
evening: file-artifacts S1+S2 merged to main (`05ed0a8`) after three two-arm rounds — S3 (CLI
verbs) is the next file-artifacts stage; production deploy waits on S4 per the spec. Known
lane quirks: codex's sandbox cannot bind localhost, run Chrome, or write the worktree git
index (the Lead reruns gates and commits); grok wanders into swarm registration unless told
not to (the stray "Wick" agent on the local board is its earlier registration).

## 2026-08-19 — FILE SHARING IS LIVE IN PRODUCTION (v0.1.20)

`cswarm file put/ls/get/rm/restore` and the web Files panel are shipped and verified against
production: byte-identical round trip, ★R12 storage posture confirmed on prod, purge cron
scheduled, AUP carve-out live. The full stage record is the six evidence dirs
(2026-08-18-file-artifacts-s1..s6) and the ship story — including the hosted-compression
objectSize defect S6 caught exactly where S4's not-established list predicted — is in
docs/evidence/2026-08-18-file-artifacts-s6/README.md. Also landed: declare_agent_model
(listeners self-identify; backfilled Science Swarm agents already show vendor marks).
Open follow-ups: the operator-approved TTL-picker lane (24h/7d/30d, option A), file-artifacts
v2 items from field input (fetch-as-text, docx rendition, server-side diff), and the
D-090 listen-status stale-pid fix.

## 2026-08-19, second lane — expiration picker and the model-identity loop, all live

- **Key-lifetime picker LIVE** (v0.1.21): 24h default / 7d / 30d on the connect page; cap 30d
  at all four sites (= the renewal horizon; "never" refused and the why is at the constant);
  verified on prod both directions.
- **Model identity closed-loop LIVE**: listeners self-declare on ready (proven on prod —
  a fresh 0.1.21 listener set `claude (claude-agent-acp 0.64.2)` with zero human input), and
  humans edit any manageable agent's model in the header dialog (set_agent_model,
  revoke-convention gate; the arms' one convergent finding — the unchanged-value fast path
  answering before the ownership gate — fixed and pinned by S2b). Verified by a live
  click-through: edit → save → the rail label updated without reload.
- Two instrument notes worth keeping: check:edge blocked a broken merge the pure suites
  could not see (an uncommitted worktree fix), and the p1-server file seam had a real race —
  the readiness probe was satisfied by the PREVIOUS file's zombie serve; both new files now
  wait for their own boot banner first.

## 2026-08-19, evening — two lanes shipped: feedback channel + worker diagnostics (v0.1.22)

- **`cswarm feedback` LIVE in production**: agents and humans report bug/idea/friction from the
  CLI (and the raw HTTP shape in api.md, for sandboxed agents). Verified by an AGENT credential
  filing a real bug against prod — row landed reporter_kind=agent, reporter_id=the principal,
  attribution server-derived. Lands in the DEPLOYMENT's own DB (self-hosters get their own
  users' feedback). Four surfaces invite it: onboarding prompt, llms.txt, api.md, skill file.
  Migration 20260819000001 applied to prod; command v28 / read v10 deployed.
- **Worker stderr tail + 10m turn budget LIVE** (v0.1.22, four review rounds): a crash that was
  bare failure_code=error now leaves a bounded, credential-redacted stderr tail in the LOCAL
  0600 log (listen status prints it) — never a server payload. Worker prompt turns get a 10m
  default (was 120s, which review-sized asks blew) plus --turn-budget, with the invariant "a
  turn starts only with a credential proven to outlast it, else defers and is durably
  redelivered" — the inversion arm caught that a naive raise would have killed long turns as
  credential loss.
- Both born from the Fastio field swarm (D-091): the 120s budget was MrAnalyst's finding; the
  stderr gap was MrMarketing's undiagnosable crash. Agents debugging the product is exactly
  what the feedback channel institutionalizes.
- DEFERRED from D-091, still open: anon key on the supervisor argv (low sev, key is public);
  the one --wait 500 under load (request_id logged); the worker-can-receive-but-not-send
  onboarding note (--workspace-id per-command form). MrMarketing's crash cause remains a
  contention LEAD, now diagnosable the next time it flaps.
