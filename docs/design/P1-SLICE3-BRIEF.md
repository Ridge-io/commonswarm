# Slice 3 build brief — `swarm login` (PKCE) + CLI command client

**From:** Lead (cloud-swarm) → **Mason [codex]**
**Operator steer (Tom, 2026-07-23):** build slice 3 next; first dogfood runs against **hosted** Supabase (`ukezjcnxjvkpkeezxaew`). Workspace + agent tokens are **seeded via service_role fixtures** for the first taste — §3.4 workspace-authority commands stay deferred (slice 2b).
**Authoritative spec:** `docs/design/P1-COMMAND-API.md` §4 (auth/tenancy — human login v1), §8 (local-first — but see SCOPE below; most of §8 is deferred). Honor OPERATOR DECISIONS #6, #7, #11, #12.
**Goal:** the first real dogfood — a human logs in and a CLI drives real commands through `POST /commands` end-to-end. Dogfood item #3.

---

## Scope — minimum that unblocks coordination

**IN:**
1. **`swarm login`** — Authorization-code + **PKCE** via Supabase Auth (GoTrue), **GitHub OAuth** as the v1 provider, external browser, **loopback callback on `http://127.0.0.1:<random high port>/callback`** (retry on port collision), copy/paste fallback. CLI-generated `state` **verified on callback in both paths** (Kimi #5). Redirect allowlist entry is `http://127.0.0.1:*/callback` (gap #6 — the `*` does NOT cross `/`, so the `/callback` path is mandatory in the pattern; this entry must be ADDED to the project — Track B provisioning). **Prove the wildcard match with a real login before declaring done** (gap #6 caveat 2 — documented, not yet write-tested).
2. **Token storage** (§4): access token in memory; **rotating refresh credential in the OS keychain** (macOS Keychain via `security`, or a keychain lib). **Headless fallback = `0600` file in a `0700` dir with a loud warning; hard refusal below that** — never unspecified plaintext. Per-device refresh serialization: keychain-held generation number + lockfile; concurrent refresh loses a CAS and retries. (Refresh-reuse detection is already server-side per gap #7 — do NOT implement Kimi #7's fallback; it's dead code.)
3. **The CLI command client** — send the 8 P0 commands (`create/acquire/renew/handoff/takeover/submit/close/reopen`) to `POST /commands` with the bearer credential, using the exact slice-2 wire contract (`{command_id, client_version, workspace_id, stream, command}`; response = StoredResponse fields + `status`, plus `events`/`min_client_version` on fresh — see decision #64). Accept EITHER a human JWT (from `swarm login`) OR a seeded `swm_agt_…` agent token (so you can drive a simulated fleet). Print the outcome; on `accepted`, fold the returned `events` for display. `command_id` is a fresh CSPRNG id per send (`^[A-Za-z0-9_-]{8,72}$`).
4. **`swarm logout [--device]` / `swarm devices`** → hit `revoke_device` (audit-only per gap #5; `my_devices` is the read surface).
5. **Env-parametrized target**: `--url` + anon key (or a config/profile) so the same client drives **local** (dev/iterate) and **hosted** (dogfood) without code change. Develop against the **local** stack first; the hosted run is Track B-gated.

**OUT (deferred — do NOT build now):**
- The §8 **local SQLite derived cache / intent queue / outbox / replay-of-record** machinery. For the first dogfood the CLI is a **thin authenticated client** that POSTs and prints; offline/local-first resilience is a later slice. (If you want a trivial in-memory fold of the returned events for pretty output, fine — but no persistent cache, no outbox, no unknown-type halt plumbing yet.)
- §3.4 workspace-authority commands (create_workspace/invite/accept/map_repository/mint_token) — seeded via fixtures. Slice 2b.
- Snapshot bootstrap (gap #18, P3).

---

## The fixture bridge (important integration detail)
A real GitHub login creates a NEW `auth.users` row for the operator. For that human to be a workspace member, seed — via **service_role**, fixture-only — a `swarm.users` row + a workspace + an owner `memberships` row for that uid, plus an `agent_principal` + run + `swm_agt_` token for the simulated fleet. Provide a small idempotent seed script (`tests/p1-server/` helpers already do most of this — factor the reusable bit) that takes a uid and stamps the membership. Document the one manual step: "log in once, copy your uid from the token, run the seed." This bridge is what §3.4 will later replace.

## Definition of done (evidence-gated — Lead verifies independently)
- `tsc` clean; P0 `npm test` still 38/38; slice-2 `test:p1-server` still 7/7.
- A **real `swarm login`** completes the PKCE loopback flow end-to-end and caches a refresh token in the keychain (demonstrate against local GoTrue configured with a GitHub OAuth app; the hosted proof is Track B-gated but design for it).
- The CLI sends a real `create` + `acquire` + `submit` + `close` sequence through `POST /commands` and shows the accepted events / domain rejections — a task driven cradle-to-grave over the wire.
- `state`-mismatch on callback is rejected (test it); keychain-miss headless fallback warns loudly.
- Report commit SHA + a transcript of the login + the command round-trip.

## Coordination
- Swarm-native; no background `codex exec`. Take the `p1-login-cli` task lease (I'll create it) and checkpoint as you go.
- **Track B (hosted provisioning) runs in parallel** — I'm driving Anvil/Forge to apply schema + deploy the command fn to hosted, add the redirect allowlist, and stand up the GitHub OAuth provider. You do NOT do provisioning or touch secrets. When Track B lands I'll give you the hosted URL/anon key to point the client at for the real dogfood.
- Authority-boundary or auth-flow ambiguity → message me, don't guess (esp. anything touching token custody or the `state`/PKCE verifier).
