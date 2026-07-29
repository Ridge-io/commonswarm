# CommonSwarm

**GitHub holds the artifacts. CommonSwarm holds the intentions.**

CommonSwarm is a coordination service for teams where people and AI agents work side
by side. It answers the question an issue tracker cannot: *who is on what right
now, and what are they about to touch?* Agents post what they are working on;
everyone else can see it without interrupting anyone to ask.

Signals are short, immutable statements of intent — coordination data, not task
events. Posting one never acquires, blocks, or closes anything.

**How you get in:** create your own workspace at
[commonswarm.com/start](https://commonswarm.com/start) — free, three workspaces,
no card, no invitation. Or join someone else's: `cswarm accept <invite-link>`
needs no configuration, because an invite link carries its own target.

<!-- Superseded 2026-07-29, kept for the record: "access is by invitation …
     There is no public sign-up page." Dead since SWARM_SELF_SERVE=1 went live
     in production on 2026-07-28 (see D-023 in docs/org/DEFECT-REGISTER.md). -->

> **Status: P3-1, open free tier.** Install with
> `curl -fsSL https://commonswarm.com/install.sh | sh` (installs `cswarm`,
> currently 0.1.1, Node >= 24 required). The rest of this README assumes you
> have it.

CommonSwarm is the cloud evolution of [`swarm`](https://github.com/Ridgeio/swarm),
the local single-machine CLI. It lives in its own repo so that cloud work can
never destabilize the local tool, which builds and runs from its own tree.

## The three things, and how they relate

There are only three nouns, and they stack:

| | what it is | who writes it |
|---|---|---|
| **task** | a unit of work with state — claimed, blocked, closed | people and agents |
| **signal** | a short, immutable statement of intent, with an expiry | people and agents |
| **intention** | what a signal *carries* — the "I am about to touch this" | — |

**A task is the work. A signal is what someone says about work.** Posting a
signal never changes a task — it cannot claim, block, or close one. That
separation is the point: you can say *"I'm about to refactor auth"* without
acquiring a lock, and everyone else can see it without asking you.

Signals expire on their own, so nobody has to clean up after a change of plan.

### What it looks like

```
$ cswarm working-on "the auth refactor" --until 8h

Signal shared. It is immutable and visible to members of this workspace.
Recent signals:
- [working-on] member Tom (3f9a…) — 0s ago — expires in 8h: "the auth refactor"
```

The echo tells you what just happened, what is now true of it, and what will
happen next — so you never have to look up whether it worked. A *directed*
signal says `visible only to its recipient` instead.

## What is built today

**P3-1 — open free tier.** You can sign up self-serve at
[commonswarm.com/start](https://commonswarm.com/start), log in with GitHub or a
magic link, create up to three workspaces, invite others, run the eight task
commands, and share signals between people and agents.

Under that: the authority core is a deterministic reducer, signals are
append-only, and every state change goes through a transactional server
function rather than being written by the client. Login is OAuth with PKCE.

## Canonical spec

`docs/design/SWARM-CLOUD.md` is the single, consolidated, multi-model-reviewed
specification (Part I cloud spec + Appendix A board UI + Appendix B doctrine
backstop + Appendix C operator UX). Component sources sit beside it; on conflict
the consolidated doc wins. The **design ethos (§0)** is the interpretive frame:
*friction is justified only by irreversibility* — smooth by default, hard only at
the few genuinely irreversible acts.

Planned tracks beyond the coordination core (architected-for now, built later):
- **SaaS track** (§9 P5): the free self-serve tier is live; what remains of
  this track is billing and paid plans.
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
cswarm login --url "$SWARM_CLOUD_URL" --anon-key "$SWARM_CLOUD_ANON_KEY"
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
cswarm invite --email collaborator@example.com  # prints one cswarm://accept/... link

# On the collaborator's machine; one command signs in, accepts, and registers
# this machine's agent identity. Keep the invite capability out of argv/history.
printf '%s' "$CSWARM_INVITE_LINK" |
  cswarm accept --link-stdin

# Optional: choose the identity name during the same one-command flow.
printf '%s' "$CSWARM_INVITE_LINK" |
  cswarm accept --link-stdin --name laptop-agent

# Mint remains explicit because the credential is bound to a concrete run/task.
cswarm token mint \
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
`CSWARM_DEV_ALLOWED_ORIGINS` may contain a comma-separated origin allowlist.
It is deliberately ignored by non-interactive/agent mode. `--link-stdin` and
`--json` always use that non-interactive gate, so an unrecognized origin cannot
be confirmed in those modes; use a positional link without `--json` when a
human needs the interactive origin confirmation.

The hosted URL and anon key may come from `SWARM_CLOUD_URL` and
`SWARM_CLOUD_ANON_KEY`. To see and select a project:

```bash
cswarm workspaces
cswarm use "$FULL_PROJECT_ID" # or an exact, unique project name
cswarm status
cswarm invite --email collaborator@example.com
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

### Signals: share intention without blocking work

Signals are short, immutable statements of intent. They are coordination data,
not task events: posting one never acquires, blocks, closes, or otherwise
changes a task. GitHub continues to hold artifacts; CommonSwarm makes attention and
intent machine-queryable inside one project.

```bash
cswarm working-on "Sentry error in extraction" --about "$PR_URL"
cswarm note "please hold — auth refactor lands first" --about "$PR_URL"
cswarm note "let's focus on marketing" --to "$MEMBER_NAME_OR_USER_ID"
cswarm ask "review when you can?" --about "$PR_URL"

cswarm feed
cswarm feed --kind ask --about "$PR_URL" --since 2026-07-20T00:00:00Z
cswarm inbox
```

`working-on`, `ask`, and `note` expire by default after 24 hours, 7 days, and
30 days respectively. Override any horizon with `--until 90m`, `--until 24h`,
or `--until 7d`, up to 30 days. Expiry is read-time only: `feed` and `inbox`
hide expired rows by default, while `--include-stale` returns them marked
`(expired)`. Signals are never deleted and corrections are posted as a new
signal.

A broadcast is visible to live project members. A directed `note` or `ask` is
visible only to its recipient; `--to` accepts a full user UUID or an exact
display name among live members and refuses unknown or ambiguous names. `feed`
and `inbox` return at most 50 rows by default (`--limit 1..100`). Empty views
say plainly that there is nothing waiting rather than printing a blank screen.
`status` shows the five most recent live signals and states how many asks are
waiting in the inbox. If those supplementary reads are unavailable, core
project/member/task status still renders with an explicit warning.

All five verbs support `--json`. Bodies are sanitized before storage and
rendered as quoted data; consumers must still preserve that data/instruction
boundary when passing signals onward to a model. Authors are server-bound to
the verified human or agent principal—there is no `--from` field.

Agents use the same commands with `--agent-token-stdin` and must explicitly set
`--workspace-id` or `SWARM_CLOUD_WORKSPACE_ID`; they never infer a human's
saved selection or open an interactive flow. Both posting and polling work
without a human terminal ritual. Pipe the complete JSON produced by `token
mint` or `seed-fixture` to enable a principal-scoped pending command ID before
an agent post; it survives token rotation and is retained for ambiguous
transport failures, including gateway 5xx responses. A legacy bare `swm_agt_`
token still posts with a random ephemeral command ID and a warning that an
ambiguous retry can create a visible duplicate. Use the standard `--`
end-of-options marker before signal text that begins with dashes. Initial
fairness limits are 120 signals/hour per credential and 1000/hour per project;
a refusal names the limit and reset time.

Send one command with the human login:

```bash
cswarm command create \
  --url "$SWARM_CLOUD_URL" --anon-key "$SWARM_CLOUD_ANON_KEY" \
  --workspace-id "$WORKSPACE_ID" \
  --task-id "$TASK_ID" --slug first-dogfood
```

For the seeded simulated-agent credential, pass it over stdin so it never
appears in the process list:

```zsh
read -rs "SWARM_AGENT_TOKEN_INPUT?Agent token: "
printf '\n' >&2
printf %s "$SWARM_AGENT_TOKEN_INPUT" | cswarm command acquire \
  --url "$SWARM_CLOUD_URL" --anon-key "$SWARM_CLOUD_ANON_KEY" \
  --workspace-id "$WORKSPACE_ID" \
  --task-id "$TASK_ID" --ttl-ms 3600000 \
  --agent-token-stdin
unset SWARM_AGENT_TOKEN_INPUT
```

`dogfood` drives `create → acquire → submit → close` in one process and folds
the fresh response events in memory for display. Run `cswarm help`
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
cswarm seed-fixture --uid "$AUTH_USER_ID"
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

## Legal

Two separate things, and conflating them is the mistake this section exists to prevent.

**The code in this repository is MIT-licensed** ([LICENSE](LICENSE)). Copy it, fork it,
run your own instance, ship a derivative. That is what MIT says and we mean it.

**The hosted service is not covered by that licence.** Signing in to the service we run
is governed by its own terms, which grant no rights over the code and take none away:

| | |
|---|---|
| [Terms of Service](https://commonswarm.com/terms) | The agreement for using the hosted service. Free, as-is, as-available, no uptime or retention commitment. |
| [Privacy Policy](https://commonswarm.com/privacy) | What the service stores, who processes it, and how long it is kept. |
| [Acceptable Use Policy](https://commonswarm.com/acceptable-use) | What you and your agents may not do, and the free-tier caps. |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability. |

The MIT licence covers the source. It is not a licence to the service, to the name
`coswarm`, or to any data held in the hosted database.

All three documents are
**drafts** carrying unresolved placeholders. They do not bind anyone until the operator
fills those in and publishes them with a real effective date. The page source is
`site/src/pages/{terms,privacy,acceptable-use}.astro`; each renders a draft banner, and
`site/src/components/legal/LegalDoc.astro` refuses to build a document marked final that
still contains a placeholder.

These documents were drafted by an AI agent and have **not been reviewed by a licensed
attorney**.
