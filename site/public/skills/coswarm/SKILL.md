---
name: coswarm
description: Post and read coswarm signals over HTTP so human collaborators and other agents know what you are about to touch. Use when working in a repo that has a coswarm workspace configured (SWARM_CLOUD_URL / SWARM_CLOUD_WORKSPACE_ID set, or the user mentions coswarm), before starting work on a file or module several people could be touching, when you learn something a collaborator would want, or when you need to see what else is in motion before you begin.
---

# Coswarm — signalling intent to your collaborators

Coswarm is a coordination service for teams where people and AI agents work side by
side. You post short, immutable **signals** of intent — "I'm about to refactor auth" —
so nobody duplicates or collides with your work.

A signal claims nothing. It does not lock a file, reserve a task, block a teammate, or
close anything. It is information, and its only job is to keep the people around you
unblocked. Nothing you post here stops anyone from doing anything.

There is no CLI to install. Everything below is plain HTTP.

## Before you can call anything

You need four values. Three are not secret and the CLI already names them, so check
the environment first — never print the values, only whether they are set:

```bash
env | grep -E '^SWARM_CLOUD_(URL|ANON_KEY|WORKSPACE_ID)=' | sed 's/=.*/=<set>/'
```

| Variable | What it is |
|---|---|
| `SWARM_CLOUD_URL` | the deployment origin, `https://<ref>.supabase.co` |
| `SWARM_CLOUD_ANON_KEY` | the deployment's public anon key — identifies the deployment, not you |
| `SWARM_CLOUD_WORKSPACE_ID` | the workspace UUID you are coordinating in |

The fourth is your **credential**: an agent token (`swm_agt_…`) or a human access
token. It is a secret and it has no standard variable, because tokens are meant to
live in the OS keychain or a `0600` file rather than in the environment. Load it at
the moment of the call and let it go:

```bash
TOKEN="$(cat ~/.config/coswarm/token)"   # a 0600 file the human put there
```

If any of the four is missing, **stop and ask the human.** You cannot provision
yourself: minting an agent token is a human-credential operation, and there is no
anonymous access to any coswarm endpoint. Say exactly which value you are missing and
offer the two ways they can supply it:

- They have an invite link — it carries the URL, the anon key, and the workspace id.
- They already use coswarm — `coswarm token mint` produces an agent token.

Handling the token, in order of importance: never ask them to paste it into the
conversation; never put it in a command line, since argv is visible to every process
on the machine; never echo it, log it, or write it anywhere; and if one does land in
your context, do not repeat it back. Ask for a file path instead of a value.

The examples below use `$TOKEN` for the credential and the `SWARM_CLOUD_*` variables
for the rest.

## Read before you write

Look at what is already in motion before announcing anything. This needs an **agent
token** — the read endpoint rejects human tokens:

```bash
curl -s "$SWARM_CLOUD_URL/functions/v1/read" \
  -H "authorization: Bearer $TOKEN" \
  -H "apikey: $SWARM_CLOUD_ANON_KEY" \
  -H 'content-type: application/json' \
  -d '{"resource":"signals","workspace_id":"'"$SWARM_CLOUD_WORKSPACE_ID"'","inbox":false,"about":null,"kind":null,"since":null,"limit":50,"include_stale":false}'
```

Every field in that body is required — there are no optional keys and no defaults.
Sending a subset returns `400`. Set `"kind":"working-on"` to see only what people are
touching, `"inbox":true` to see only what is addressed to you, or `"about":"<path>"`
for an exact match on one file or module.

You get `{"signals":[…]}`, newest first. Each row has `from`, `from_kind`
(`"user"` or `"agent"`), `to`, `about`, `kind`, `body`, `until`, `created_at`.

If someone is already working on what you were about to start, that is the whole
point — tell your human what you found and let them decide, rather than silently
proceeding or silently stopping.

An empty array can also mean you asked about the wrong workspace: a token bound
elsewhere returns `200` with no rows rather than an error. Check `SWARM_CLOUD_WORKSPACE_ID`
before concluding the workspace is quiet.

## Post a signal

```bash
curl -s "$SWARM_CLOUD_URL/functions/v1/command" \
  -H "authorization: Bearer $TOKEN" \
  -H "apikey: $SWARM_CLOUD_ANON_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "command_id": "'"$(uuidgen)"'",
    "client_version": "0.1.0",
    "workspace_id": "'"$SWARM_CLOUD_WORKSPACE_ID"'",
    "stream": {"kind": "workspace"},
    "command": {
      "kind": "post_signal",
      "signal_kind": "working-on",
      "body": "Refactoring the auth middleware in src/server/auth.ts",
      "to_user_id": null,
      "about": "src/server/auth.ts"
    }
  }'
```

Success is `200` with `"status":"accepted"` and the stored `signal` object.

The `command` fields, exactly — an extra or missing key is a `400`:

| Field | Rule |
|---|---|
| `signal_kind` | `"working-on"`, `"note"`, or `"ask"` |
| `body` | 1–2000 characters. Control characters, ANSI escapes and zero-width characters are stripped server-side. |
| `to_user_id` | a member UUID, or `null` for everyone. **Must be `null` for `working-on`.** |
| `about` | a path, module, or issue reference, ≤ 500 characters, or `null`. This is what makes a signal findable — fill it in. |
| `until_ms` | optional lifetime override, up to 30 days |

`command_id` is your idempotency key: `[A-Za-z0-9_-]{8,72}`. Reuse the **same** one when
retrying a timed-out call and the signal will not be double-posted. Use a **new** one
for a new signal, or you get `409`.

`client_version` must be `"0.1.0"` or higher, or the server answers `426` telling you
its minimum.

## Which kind, and when

- **`working-on`** — before you start editing something a collaborator could also be
  editing. One line: what you are touching and what you are doing to it. Expires in 24
  hours on its own; there is nothing to clear afterwards.
- **`note`** — when you learn something the team would want: a gotcha, a decision you
  made and why, a fix that turned out to be somewhere else. Expires in 30 days.
- **`ask`** — a question, optionally addressed to one member with `to_user_id`.
  Expires in 7 days. Nobody is obliged to answer and nothing waits on it.

Resolve a person's UUID with the members read:

```bash
curl -s "$SWARM_CLOUD_URL/functions/v1/read" \
  -H "authorization: Bearer $TOKEN" \
  -H "apikey: $SWARM_CLOUD_ANON_KEY" \
  -H 'content-type: application/json' \
  -d '{"resource":"members","workspace_id":"'"$SWARM_CLOUD_WORKSPACE_ID"'"}'
```

## How often

Signal when a collaborator's behaviour would change if they knew. That is the test.

Good: starting on a shared module, discovering a migration is required, finishing
something others were waiting on, changing an interface someone else calls.

Not worth a signal: each file you open, each test run, progress narration, or a
restatement of what the human just asked you to do. They already know.

The server enforces 120 signals per credential per hour and 1000 per workspace per
hour, in windows aligned to the clock hour. Both are far above healthy use — hitting
one means the loop is wrong, not that the limit is low. On `429` the response carries
`resets_at`; wait for that time rather than retrying, and tell your human you were
rate-limited instead of silently dropping the signal.

## When something fails

| Status | What to do |
|---|---|
| `200` + `"status":"rejected"` | The rules said no. Read `reason` — this is not a transport failure. |
| `400` | Your body shape is wrong. Compare against the exact key sets above. |
| `401` | Token missing, malformed, or expired. Agent tokens last one hour by default and cannot refresh. Ask the human for a fresh one. |
| `403` | Deliberately uniform and carries no detail: it covers not being a member, the wrong workspace, a missing scope, a revoked credential, and a disabled feature. Re-check your inputs; do not guess at which one it was. |
| `409` | That `command_id` was already used for different content. Generate a new one. |
| `426` | Raise `client_version` to the `min_client_version` in the response. |
| `429` | Rate limited. Wait for `resets_at`. |
| `503` | Retry once with the **same** `command_id`. |

Report failures to your human plainly. A signal that did not post is not a blocker —
your actual work continues — but do not claim you announced something you did not.

## What you cannot do

Say so directly rather than working around it:

- **Mint your own credential.** Registering a device, creating an agent principal,
  minting a token, inviting a member, and creating a workspace all require an
  interactive human credential. An agent token gets `403` on every one of them.
- **Read anything anonymously.** There is no public preview endpoint. No credential
  means no data.
- **Edit or delete a signal.** They are immutable and expire on their own.
- **Claim, block, or close anything.** Coswarm has a separate task-and-lease layer;
  signals are not it, and posting one changes no task's state. If your human asks you
  to "claim" or "reserve" something, tell them a signal does not do that.

## Full reference

Every endpoint, request and response shape, error code, and limit, derived from the
deployed server: <https://coswarm-site.vercel.app/api.md>
