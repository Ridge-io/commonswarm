# Evidence — ux-connect-polish (connect-loop UX polish + Kimi minors)

**Landed:** `87e41cf` on `main` (pushed to `Ridge-io/cloud-swarm`).
**Implemented by:** Mason [codex]. **Verified + landed by:** Lead4.

## Scope

Operator felt-dogfood bugs #1–#6 (from `p1-two-human-connect.md` field lessons) +
Kimi 2b-2 review minors FIX-1/3/4/5 (decision #81). FIX-2 (rate limiting) is
out of scope — it is the 2b-4 slice.

### Bugs
- **#1** `coswarm login` returns cleanly (server-close race fixed; exit 0).
- **#2** paste fallback deferred 15s on browser-launch success; immediate only on failure.
- **#3** workspace resolution: `--workspace-id` > `SWARM_CLOUD_WORKSPACE_ID` > persisted
  profile default (persisted only when exactly one live membership is discoverable).
- **#4** CLI prints `coswarm 0.0.1 (protocol 0.1.0)` at runtime (stale-dist signal).
- **#5** distinct verified-email warning surfaced in login output (GoTrue identity linking).
- **#6** logout defaults to Supabase `local` scope; `--all-devices` opts into `global`.

### Kimi minors
- **FIX-1** mint requires an existing live same-owner device (`revoked_at IS NULL`);
  lazy device creation removed from projection path; explicit authenticated
  `register_device` command at login (FOR UPDATE, ownership + revoked check, audited).
- **FIX-3** `--invitation-token-stdin` (positional retained, documented shell-history-unsafe).
- **FIX-4 / decision #81** client-side pending `command_id` — random id persisted per
  canonical intent in a 0600 sidecar profile, reused only across transport ambiguity,
  cleared on any parsed HTTP response; LRU cap 32; no deterministic derivation, no
  secret persistence.
- **FIX-5** `display_name` control/bidi/ANSI stripping before persist; fallback `"Coswarm User"`.

## Verification (Lead4, independent execution)

- `npx tsc --noEmit` — clean
- `npm test` (core) — **66/66**
- `npm run test:p1-cli` — **16/16**
- `npm run test:p1-server` — **11/11** (live local stack)
- `git diff --check` — clean
- core bundle regen (`build:command-core`) — **zero drift** (byte-identical to committed)

## Hosted redeploy

- `npx supabase functions deploy command --project-ref ukezjcnxjvkpkeezxaew`
- `functions list`: `command` ACTIVE **version 4**, updated 2026-07-24 15:53:04 UTC.
- Endpoint canary (anon-only `register_device`) → HTTP 400 `{"error":"invalid_request"}`
  — the function's OWN structured vocabulary, proving deployed v4 executes the new path
  (not a gateway 401 or a 500 crash). Deeper correctness covered by the 11/11 server
  suite against the live stack with identical code.

## Residual / follow-ups (P2-connect-UX)

- `coswarm --version` as a standalone flag is not wired (`--version requires a value`);
  the version string is present in the `--help` header. Minor — fold into P2 CLI UX.
