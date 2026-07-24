# cloud-swarm

Multi-human, multi-agent **coordination cloud service** — the cloud evolution of
[`swarm`](https://github.com/Ridgeio/swarm) (the local, single-machine CLI).
Forked into its own repo so cloud development can never destabilize the in-use
local tool (the local swarm builds and runs from its own working tree).

## Status

**P1 — invited dogfood.** The reducer-complete authority core is wired behind
the transactional Supabase command function. The thin CLI provides GitHub OAuth
login with PKCE, governed invite/accept/principal/token commands, and the eight
task commands.

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

Only the rotating refresh credential is persisted as a secret. On macOS it
lives in the Keychain alongside the local device identifier. A non-secret
`0600` profile stores the login label, default workspace, reusable agent
identity checkpoint, and transport-ambiguous pending command IDs. A host
without a supported keychain uses a warned `0600`
credential file inside a `0700` directory; insecure permissions are refused. Set
`SWARM_ALLOW_INSECURE_STORE=0` to refuse the file fallback entirely. Access
tokens and the PKCE verifier remain process-memory-only.

The first human can invite a second, who must use a GitHub identity with a
different verified email—GoTrue deliberately links provider identities that
share a verified email:

```bash
coswarm invite --email collaborator@example.com  # prints one coswarm://accept/... link

# On the collaborator's machine; one command signs in, accepts, and registers
# this machine's agent identity. Keep the invite capability out of argv/history.
printf '%s' "$COSWARM_INVITE_LINK" |
  coswarm accept --link-stdin

# Optional: choose the identity name during the same one-command flow.
printf '%s' "$COSWARM_INVITE_LINK" |
  coswarm accept --link-stdin --name laptop-agent

# Mint remains explicit because the credential is bound to a concrete run/task.
coswarm token mint \
  --principal-id "$PRINCIPAL_ID" --run-id "$RUN_ID" \
  --task-id "$TASK_ID" --epoch 1
```

`accept` narrates why each internal step happens. `--no-browser` prints the
GitHub OAuth URL for a human to open; `--json` emits machine-readable progress
on stdout while keeping the narration on stderr. A positional invite link is
supported for convenience but warns because the one-time capability can remain
in shell history and process listings. The legacy bare `swm_inv_…` and
`--invitation-token-stdin` accept forms remain available and consume only the
invitation; they do not auto-create a principal.

Invite links pin their complete Cloud target. Production and loopback origins
are allowed by the build; an unknown origin is refused before login unless an
interactive user re-types the exact origin. For local development only,
`COSWARM_DEV_ALLOWED_ORIGINS` may contain a comma-separated origin allowlist.
It is deliberately ignored by non-interactive/agent mode. `--link-stdin` and
`--json` always use that non-interactive gate, so an unrecognized origin cannot
be confirmed in those modes; use a positional link without `--json` when a
human needs the interactive origin confirmation.

The hosted URL and anon key may come from `SWARM_CLOUD_URL` and
`SWARM_CLOUD_ANON_KEY`. To see and select a project:

```bash
coswarm workspaces
coswarm use "$FULL_PROJECT_ID" # or an exact, unique project name
coswarm status
coswarm invite --email collaborator@example.com
```

`workspaces` always shows the project name and full id. `use` saves the
selection only after confirming a live membership; it never uses prefixes,
slugs, fuzzy matching, or a hidden prompt. If safe display names collide, it
lists every collision and requires the full id. A sole project is selected
automatically. With several projects and no saved selection, scoped commands
fail promptly with the same list and point back to `workspaces` → `use`.

`--workspace-id` overrides `SWARM_CLOUD_WORKSPACE_ID`, which overrides the
saved selection. The environment variable is a power-user override, not the
normal multi-project flow. If membership in a saved project is revoked, the
next scoped command warns once, clears the stale selection, and continues with
sole-project discovery or the fail-closed list. Archived projects remain
visible and selectable while membership is live because server-side project
archive enforcement has not shipped yet.

Send one command with the human login:

```bash
coswarm command create \
  --url "$SWARM_CLOUD_URL" --anon-key "$SWARM_CLOUD_ANON_KEY" \
  --workspace-id "$WORKSPACE_ID" \
  --task-id "$TASK_ID" --slug first-dogfood
```

For the seeded simulated-agent credential, pass it over stdin so it never
appears in the process list:

```zsh
read -rs "SWARM_AGENT_TOKEN_INPUT?Agent token: "
printf '\n' >&2
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

`logout` revokes only this machine's GoTrue session, then removes the local
credential. Use `logout --all-devices` only when intentionally revoking every
session for the identity. Remote device listing/renaming/revocation remains
deferred.

### First-dogfood fixture bridge

For legacy fixture testing, after logging in once, copy the UID printed by
`login`, inject a privileged `DATABASE_URL` at runtime from the approved secret
manager, choose a new absolute path outside the repository for the one-time
agent credential, and run:

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

This bridge is fixture/test-only, not a governed product workspace-creation
path. A harness that already holds the privileged `DATABASE_URL` may request an
explicit idempotent fixture workspace with `--workspace-id <uuid>` and
`--workspace-name <name>`; the flag grants no authority beyond that existing
full-database credential. The command prints the non-secret workspace ID and
stored workspace name, but never prints or stores `DATABASE_URL`.

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
