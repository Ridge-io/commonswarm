# cloud-swarm

Multi-human, multi-agent **coordination cloud service** — the cloud evolution of
[`swarm`](https://github.com/Ridgeio/swarm) (the local, single-machine CLI).
Forked into its own repo so cloud development can never destabilize the in-use
local tool (the local swarm builds and runs from its own working tree).

## Status

**P1 — invited dogfood.** The reducer-complete authority core is wired behind
the transactional Supabase command function. The thin CLI adds GitHub OAuth
login with PKCE and the eight task commands; persistent local cache, replay, and
workspace-authority commands remain deliberately deferred.

## Canonical spec

`docs/design/SWARM-CLOUD.md` is the single, consolidated, multi-model-reviewed
specification (Part I cloud spec + Appendix A board UI + Appendix B doctrine
backstop + Appendix C operator UX). Component sources sit beside it; on conflict
the consolidated doc wins. The **design ethos (§0)** is the interpretive frame:
*friction is justified only by irreversibility* — smooth by default, hard only at
the few genuinely irreversible acts.

Planned tracks beyond the coordination core (architected-for now, built later):
- **SaaS track** (§9 P5): public, free-to-start self-serve.
- **Access plane**: a key-less secrets broker + policy egress proxy so agents
  operate third-party services (Sentry, PostHog, Supabase, env-file leasing)
  without holding raw keys — tiered by reversibility, gated by the same
  capability/audit model.

## Dev

```bash
npm install
npm test      # node --test via tsx
npm run build # tsc → dist/
npm run test:p1-server
npm run test:p1-cli
```

## Thin cloud CLI

Build once, then target either local or hosted Supabase with the same flags:

```bash
npm run build
coswarm login --url "$SWARM_CLOUD_URL" --anon-key "$SWARM_CLOUD_ANON_KEY"
```

Login opens GitHub OAuth in the system browser using a CLI-generated PKCE
verifier and a random high-port `127.0.0.1` callback. If the browser cannot
reach the loopback listener, paste the complete callback URL into the waiting
terminal; the same CLI-generated `state` is verified before either path
exchanges the code.

Only the rotating refresh credential is persisted. On macOS it lives in the
Keychain. A host without a supported keychain uses a warned `0600` file inside
a `0700` directory; insecure permissions are refused. Set
`SWARM_ALLOW_INSECURE_STORE=0` to refuse the file fallback entirely. Access
tokens and the PKCE verifier remain process-memory-only.

Send one command with the human login:

```bash
coswarm command create \
  --url "$SWARM_CLOUD_URL" --anon-key "$SWARM_CLOUD_ANON_KEY" \
  --workspace-id "$WORKSPACE_ID" \
  --task-id "$TASK_ID" --slug first-dogfood
```

For the seeded simulated-agent credential, pass it over stdin so it never
appears in the process list:

```bash
read -rsp "Agent token: " SWARM_AGENT_TOKEN_INPUT
printf %s "$SWARM_AGENT_TOKEN_INPUT" | coswarm command acquire \
  --url "$SWARM_CLOUD_URL" --anon-key "$SWARM_CLOUD_ANON_KEY" \
  --workspace-id "$WORKSPACE_ID" \
  --task-id "$TASK_ID" --ttl-ms 3600000 \
  --agent-token-stdin
unset SWARM_AGENT_TOKEN_INPUT
```

`dogfood` drives `create → acquire → submit → close` in one process and folds
the fresh response events in memory for display. Run `coswarm help`
for its required flags.

`logout` calls GoTrue `signOut()` to revoke the refresh session, then removes
the local credential. Remote device listing/revocation is deferred with the
server-side device authority endpoint.

### First-dogfood fixture bridge

Workspace-authority commands are not exposed yet. After logging in once, copy
the UID printed by `login`, inject a privileged `DATABASE_URL` at runtime from
the approved secret manager, choose a new absolute path outside the repository
for the one-time agent credential, and run:

```bash
DATABASE_URL="$INJECTED_DATABASE_URL" \
SEED_TOKEN_OUT="$ONE_TIME_TOKEN_PATH" \
coswarm seed-fixture --uid "$AUTH_USER_ID"
```

The bridge writes directly to the private `swarm` schema; it never exposes that
schema through PostgREST, prints the database URL, or stores it. It idempotently
stamps the user, owner workspace membership, workspace stream, device,
principal, and run. A new one-hour `swm_agt_` token is written only to the
create-new `0600` path named by `SEED_TOKEN_OUT`; stdout contains non-secret
fixture IDs and never the token or output path. If that path already exists the
command refuses to run. Read and delete the file promptly. Rerunning while a
token remains live retains the existing row because plaintext tokens are
intentionally unrecoverable.

## Relationship to `swarm`

The local `swarm` CLI remains supported indefinitely for solo/offline use;
migration into a cloud workspace is `swarm cloud attach` (spec §6). Shared code
(transports, board UI) is copied here on demand as the build reaches it and may
later be extracted into a shared package if divergence warrants.

## Local Supabase development

Requires Docker and the Supabase CLI.

- `npm run db:start` starts local services.
- `npm run db:stop` stops local services.
- `npm run db:reset` resets the local database from migrations and seed.
- `npm run db:status` reports local service status.
- `npm run db:diff` prints local schema changes.
- `npm run db:migrate` applies pending migrations locally.
