# Evidence — the FIRST REAL DOGFOOD (§0b target: ACHIEVED)

**Date:** 2026-07-23 · **Task:** `p1-login-cli` · **Implementer:** Mason [codex] (checkpoint `2f709d6`)
**Verified by:** Lead (Lead2) — two-channel verification, event_id-level match.

## What happened, end to end, against HOSTED (`ukezjcnxjvkpkeezxaew`)

1. **Human login:** GitHub OAuth (`cloud-swarm-dev` app) → GoTrue → **PKCE loopback on random port 53493** → refresh credential in **macOS Keychain**. Empirically proves gap#6's `http://127.0.0.1:*/callback` wildcard. uid `d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc`.
2. **Fixture seed** (service_role, Anvil-injected `DATABASE_URL`, §3.4 stand-in): workspace `3ab184b3…`, stream `8efd3a39…`, principal `06241027…`, owner membership; one-time `swm_agt_` token delivered via 0600 file sink (never in any transcript), consumed and deleted after use.
3. **Task driven cradle-to-grave with the agent token** through `POST /functions/v1/command`:
   - `create` → `TaskCreated` seq 1 → open
   - `acquire` → `LeaseAcquired` seq 2, epoch 1 → active
   - `submit` → `TaskSubmitted` seq 3 → awaiting_review
   - `close` → `TaskClosed` seq 4, disposition archive → done
   - **replay** (exact `close` resend) → HTTP 200, same stored response/event_id `cde5daed…`, **no new event**
   - **domain pin**: `acquire` on never-created task → 200 `{rejected, class:domain, reason:unknown_task}`, `CommandRejected` seq 5, **no tasks row** (decision #65 rule live in prod)
4. **No 5xx anywhere** — the post-`SWARM_DATABASE_URL`-fix probe rode the first command.

## Independent verification (Lead)

Direct read-only SQL against hosted (aws-0 session pooler), with server-identity canaries
(`version()` = PostgreSQL 17.6, `inet_server_addr()` real, `current_database()`):

- `swarm.events` for stream `8efd3a39…`: exactly seqs **1–5**, PascalCase types, event_ids **matching Mason's transcript** incl. `cde5daed…` (replayed close) and `b50482c8…` (rejection) — replay added nothing; `total_events = 5` project-wide (no strays).
- `swarm.tasks`: single row, `lifecycle=done, epoch=1, closed_disposition=archive`, slug `hosted-dogfood-0e28313d`.

**Fabrication caught:** the FIRST verification read-back (Anvil dispatch `b95vllmdm`) returned
plausible-looking but impossible data (snake_case types, `grid:root` actors, `allow` audit
outcomes — vocabulary that exists nowhere in this codebase). A re-query with raw-stdout +
server-identity canaries returned the true rows. **Successor rule: never accept a
provisioning-agent read-back without canaries (version/addr/db) or a second channel.**

## §0b dogfood checklist — ALL FOUR DONE
1. ✅ Schema applies on hosted (`docs/evidence/p1-schema-apply.md`, + hosted re-verify 24/9/24/2)
2. ✅ `handle_command()` wrapping unmodified `decide()` (`docs/evidence/p1-command-api.md`)
3. ✅ PKCE login + CLI sending real commands (this document)
4. ✅ Launch-gate core green vs real DBs: local suite T-01/02/03/05/06/10/11 + I1–I5 (7/7) + this hosted cradle-to-grave with replay + domain pin. (Remaining §9 dozen: T-04/07/08/09/12 — slice 2b.)

## Custody incident (post-dogfood, contained; slice-3 acceptance held on the fix)
During a later refresh, a **second real macOS Keychain bug** (`security` prompt truncating
the stored JSON at ~128 bytes) caused the short-lived refresh token to be echoed to the
terminal. Mason treated it as compromised: **global signOut, all sessions/families revoked
(including the earlier aborted login's), keychain item deleted and absence verified.** The
dogfood facts above are unaffected (verified directly in the DB). Slice-3 FINAL acceptance
is held until Mason lands the compact (<128B) serialization + regressions and repeats a
clean login → refresh → logout cycle. Also confirmed: PostgREST correctly refuses the
`swarm` / `swarm_read` schemas (`PGRST106`) — the private-schema posture is live in prod.

## Provisioning landmines learned (Track B)
- Real pooler host comes from the Management API (`aws-0-us-east-1`, NOT guessed `aws-1`); direct `db.<ref>` host is IPv6-only from this network.
- Transaction pooler (6543) needs `prepare:false` with the `postgres` pkg; session pooler (5432) doesn't — `SWARM_DATABASE_URL` uses session mode.
- The `op` service-account session can drop transiently → spurious 28P01s from an empty password; re-establish and retry before diagnosing credentials.
- 1Password: vault `OpenClaw (Yulanbot Full Access)`; the `sbp_` token lives in item `Supabase tom@ridge.io Access Token` (the `cloud-swarm-dev` item's `credential` field is empty); GitHub OAuth creds in `GitHub OAuth — cloud-swarm-dev`.
