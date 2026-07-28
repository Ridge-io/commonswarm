# Capability URLs — the zero-install first touch

**Governing spec:** `docs/design/SWARM-CLOUD.md` §7, *Zero-install first touch — the
capability-URL on-ramp*. On any conflict the spec wins and this file is wrong.

**Authored:** 2026-07-27, branch `l6/self-serve-front-door`, base commit `483f8f7`.

**What state the code is in.** Every file cited below existed in the working tree when
each claim was checked. The server-side files (`supabase/migrations/20260727000001_capability_urls.sql`,
`supabase/functions/capability/index.ts`, and the capability handlers in
`supabase/functions/command/index.ts`) were **uncommitted** at the time of writing —
written in the same sprint by other seats. *Written is not committed, committed is not
applied.* Nothing in this document establishes that the migration has been applied to any
database or that either function has been deployed. It describes code, not a running
system.

**The feature ships dark.** Both commands and the anonymous read endpoint answer
`capability_feature_disabled` unless the deployment sets `SWARM_CAPABILITY_URLS=1`
(`supabase/functions/command/index.ts` — `capabilityUrlsEnabled`;
`supabase/functions/capability/index.ts` — same gate). The gate is evaluated **first**,
before the credential checks, so while the feature is off the response cannot be used to
probe whether an identity is verified.

---

## 1. What a capability URL is

A capability URL is a link you hand to someone who has not installed anything. They open
it in a browser and see **the one work item you are inviting them to** — its name, its
repository, who invited them — and then decide whether to install `cswarm`. Comprehension
before commitment; install is the second step, not the first.

The link is a **credential**, not an address. Three consequences follow, and each is
enforced somewhere you can read:

- It is minted only by a human. A compromised agent worker cannot mint one and walk off
  with board state (§2.3 agent-token denylist).
- It is scoped by a **positive allowlist**, not a denylist. It serves an exact set of
  fields for exactly one work item, and there is no SQL it can be made to run that
  reaches anything else.
- It expires, it is revocable, and it is stored only as a hash.

---

## 2. Using it

```sh
# create a link for one work item (owner or admin, signed in as a human)
cswarm link new --task-id <uuid> [--ttl-ms <ms>] [--site <origin>] [--json]

# withdraw it at any time
cswarm link revoke --capability-id <uuid> [--json]
```

`cswarm link new` prints the link **once**:

```
Capability link created for work item 11111111-1111-4111-8111-111111111111.

  https://coswarm-site.vercel.app/see#swm_cap_...

This is the only time the link is shown. CommonSwarm stores just a hash of it, so it
cannot be printed again — if it is lost, create another and revoke this one.
Anyone holding the link can read this one work item: its name and state, the repository
it belongs to, who invited them, and how long the project has existed. It reaches nothing
else — not the member list, not the message feed, not any other work item.
It stops working at 2026-08-03T09:14:00.000Z, or sooner if you run:
  cswarm link revoke --capability-id 0b0e0d0c-0b0a-4908-8706-050403020100
```

That is the only time the raw credential exists outside the recipient's browser. The CLI
never writes it to a file, never puts it in an error message, and never re-reads it —
`src/cli.ts` (`runLinkNew`) passes the string from the HTTP response straight into
`capabilityUrl()` and writes it out; there is no other reference. `assertCapabilityToken`
in `src/cloud/command-client.ts` deliberately reports the *shape* of a bad credential and
never quotes the value.

**The link shape is `https://<site>/see#<token>` — the token is in the URL fragment.** A
fragment is never sent to any server, so it lands in no access log, no CDN log, and no
`Referer` header. The server never composes this URL and never learns the site origin; it
returns a credential and the client decides where it is redeemed
(`src/cloud/capability-link.ts` — `capabilityUrl`; and the comment on the mint response in
`supabase/functions/command/index.ts`). `--site` (or `CSWARM_SITE_ORIGIN`) overrides the
default `https://coswarm-site.vercel.app`; it must be `https`, a bare origin, with no
path, query, or fragment — validated *before* the mint request, so a typo costs a line of
output rather than a live credential that cannot be rendered.

**Who may mint.** Three checks, in order, each with its own audit reason
(`supabase/functions/command/index.ts` — `capabilityPreamble`):

1. the credential must be a human user credential — an agent token is refused here and
   never reaches the next line (`capability_mint_credential_kind_forbidden`);
2. the identity must be verified (`capability_mint_identity_not_verified`);
3. the caller's live membership role must be `owner` or `admin`
   (`capability_mint_role_forbidden`).

A non-member, and a member naming another tenant's `workspace_id`, take the same third
branch — so the response is not a cross-tenant existence oracle.

**Ceilings** (`supabase/functions/command/index.ts`): 20 mints per identity per hour
(`CAPABILITY_MINT_CREDENTIAL_LIMIT`), 60 per workspace per hour
(`CAPABILITY_MINT_WORKSPACE_LIMIT`), and 200 live links per workspace
(`CAPABILITY_LIVE_LIMIT`, counted from the table rather than a bucket). A link holder's
reads are limited to 120/hour per token hash (`supabase/functions/capability/index.ts` —
`READ_LIMIT`).

---

## 3. Exactly what a link exposes

Six leaves. Nothing else. This is the whole list.

| Field served | Source column | Where the allowlist is enforced |
|---|---|---|
| `work_item.slug` | `swarm.tasks.slug` | `swarm.capability_projection()` `RETURNS TABLE` — `work_item_slug` |
| `work_item.lifecycle` | `swarm.tasks.lifecycle` | same signature — `work_item_lifecycle`, then re-checked against a closed set of five values and served as `"unknown"` otherwise (`LIFECYCLES` in `supabase/functions/capability/index.ts`) |
| `repo.full_name` | `swarm.repositories.full_name`, reached only via the capability row's own stream | same signature — `repo_full_name`. `null` when the work item lives on the workspace stream; that is a normal state, not an error |
| `inviter.display_name` | `swarm.users.display_name` for `capability_urls.created_by` | same signature — `inviter_display_name` |
| `workspace.age_days` | derived integer from `swarm.workspaces.created_at` | same signature — `workspace_age_days`. Present because §8's invite-phishing control asks the page to render inviter identity **and tenant age** so a recipient can judge legitimacy |
| `expires_at` | `swarm.capability_urls.expires_at` | same signature |

**The allowlist is a function signature, enforced by Postgres — not a filter in
TypeScript.** `swarm.capability_projection(bytea)` is `SECURITY DEFINER` and owned by
`swarm_admin`; the role that serves anonymous traffic, `swarm_capability`, holds
`EXECUTE` on that one function and `SELECT` on **no table at all**. Its complete grant set
in `supabase/migrations/20260727000001_capability_urls.sql` is: `USAGE` on the schema,
`EXECUTE` on the projection, `INSERT` on `swarm.audit_log`, `INSERT` on
`swarm.security_alerts`, and `SELECT/INSERT/UPDATE` on `swarm.rate_buckets`. There is
therefore no query the capability function could be tricked into running that reaches
tenant data outside those nine columns.

The response body is then built **field by field** rather than by spreading a row
(`projectionBody` in `supabase/functions/capability/index.ts`) — so a column added to
`swarm.tasks` tomorrow does not appear here by default. `display_name` and `full_name` are
run through the ANSI-escape and control/bidi strip before serving, because every
swarm-originated string is untrusted data destined for a browser.

Success body:

```json
{
  "work_item": { "slug": "add-capability-urls", "lifecycle": "active" },
  "repo":      { "full_name": "Ridge-io/cloud-swarm" },
  "inviter":   { "display_name": "Tom" },
  "workspace": { "age_days": 41 },
  "expires_at": "2026-08-03T09:14:00.000Z"
}
```

---

## 4. What it does NOT expose

Not by policy, by construction. None of these is reachable from a capability link:

- **The member board projection and the roster** — no device attribution, no human
  attribution, no member list. `swarm.memberships` is not in `swarm_capability`'s grant
  set and is not selected by the projection.
- **The message stream** — `swarm.signals`, `swarm.events`, `swarm.inbox_deliveries`:
  same.
- **Any SSE / Realtime / Broadcast channel.** The capability endpoint answers one request
  with one JSON object and closes. It is a **separate edge function**, deliberately not a
  branch inside `supabase/functions/read/index.ts` — that function authenticates an agent
  token and then widens itself to `swarm_read`, `swarm_read.signals` and
  `swarm_read.member_profiles`, which are precisely the stream and roster the envelope
  forbids. An anonymous branch in that file would be one mis-ordered early return away
  from serving them.
- **Any other work item, and any other tenant.** The capability row is FK-pinned:
  `FOREIGN KEY (stream_id, workspace_id) REFERENCES swarm.streams` in the migration means
  a row naming another tenant's stream is uninsertable, and tasks are keyed by stream. The
  read endpoint accepts **no parameters at all** — no `workspace_id`, no `task_id` — so
  there is nothing to substitute. IDOR is structurally absent rather than defended.
- **Task internals.** `owner`, `lease_expiry`, `epoch`, `version`, `submission`
  (branch / head_sha / evidence set), `closed_disposition`, `updated_at` — none is in the
  projection's `RETURNS TABLE`.
- **Identifiers.** `task_id`, `stream_id`, `workspace_id`, `capability_id`. The projection
  returns `capability_id` and `workspace_id`, but those go to the **audit row only** and
  are never copied into the response body.
- **The workspace name.** Spec line 341 enumerates the allowlist as the named work item,
  its repo, and the inviter's identity. Line 314 allows an *invite* token to reveal the
  workspace name, but that is a different credential and a different page. Excluded here.
  Consequence: the page can say "Tom invited you to `add-capability-urls` in
  `Ridge-io/cloud-swarm`" but cannot name the project. Adding it is a one-word allowlist
  amendment plus a migration to the projection signature — **not** something an
  implementer may add unilaterally.
- **Anything, on any failure.** Invalid, malformed, expired, revoked, never-existed,
  workspace-archived, issuer-membership-revoked, work-item-missing and feature-disabled
  all return the same status and the same body. Only the audit row distinguishes them,
  and each has a distinct reason string. Timing is *best effort*: the endpoint always
  computes one SHA-256 and always runs the same single projection query, even for a
  malformed token — but the hit path performs joins the miss path does not, and no
  measurement or test asserts the delta.

**Anonymous is read-only.** The capability endpoint has no mutation path of any kind; any
write requires a verified identity through the command function. Anonymous mutation is
impossible, not merely unauthorised.

---

## 5. Lifetime

- **Default 24 hours** (`CAPABILITY_TTL_MS`).
- **Maximum 7 days**, and this is enforced in three independent places: the CLI refuses a
  larger `--ttl-ms` before it sends anything (`CAPABILITY_MAX_TTL_MS` in
  `src/cloud/command-client.ts`); the command function refuses it; and the table carries
  `CHECK (expires_at <= created_at + interval '7 days')`, so a server bug cannot mint an
  8-day link.
- **Minimum 60 seconds** (`CAPABILITY_MIN_TTL_MS`).

An expired link and a revoked link are indistinguishable to whoever holds them.

---

## 6. Revoking

```sh
cswarm link revoke --capability-id <uuid>
```

The `capability_id` is printed when the link is created. It is an internal handle, not a
credential — it is safe to paste into a ticket or a message.

If a mint is interrupted and retried, the retry replays: the command is idempotent, so no
second credential is issued, and the replay body carries the `capability_id` but **not**
the token — the server kept only a hash. `cswarm link new` reports that case with the
exact `cswarm link revoke` command for the link you cannot see, so an unseeable link is
still withdrawable rather than stranded live until its TTL runs out.

Revocation sets `revoked_at`/`revoked_by` and writes a row to
`swarm.revocation_tombstones` with kind `capability_url`, keeping capability revocation
inside the same three-layer revocation surface every other credential uses. The database
trigger `swarm.capability_urls_revoke_only()` makes `revoked_at`/`revoked_by` the **only**
columns an `UPDATE` may change and forbids `DELETE` outright — so an already-distributed
link cannot be silently re-pointed at a different work item, and a revoked link cannot be
deleted into a "never existed" row that erases its issuance history.

Unknown id, another tenant's id, and an already-revoked id all produce the same refusal
(`capability_revoke_not_found`), because distinguishing them would be an existence oracle
across tenants.

**Three ways a link dies, and you should know all of them:**

1. you revoke it;
2. its TTL passes;
3. **the issuer's membership is revoked.** The projection returns status `issuer_revoked`
   when `swarm.is_member(workspace_id, created_by)` is false. Off-boarding a person
   therefore kills the links they issued, without anyone having to remember them.

There is no `cswarm link ls` yet — see §7.

---

## 7. What is not built, and what is not established

- **No listing command.** Nothing enumerates a workspace's live links, so a link you lose
  the `capability_id` for can only be waited out. `capability_urls_live` (the partial
  index on `workspace_id WHERE revoked_at IS NULL`) exists for it; the read path does not.
- **No token exchange.** §7 wants the URL token exchanged once for an HttpOnly session or
  an opaque local handle, and §7's graduation ladder wants a verified identity to file a
  pending suggestion. Both live in the browser page under `site/`, which this sprint did
  not touch. The API ships bearer-per-request with the fragment discipline documented for
  whoever builds the page. Adding the exchange later is a second endpoint; it changes
  neither the table nor the allowlist.
- **No page.** `https://<site>/see` does not exist yet. Until it does, the link the CLI
  prints resolves to a 404 and the credential is only usable by `POST`ing it as a bearer
  to `/functions/v1/capability`.
- **Hosted `apikey` behaviour is unverified.** `[functions.capability]` sets
  `verify_jwt = false`, which is right for local. Whether the hosted Supabase gateway
  still demands an `apikey` header from a browser holding no Supabase JWT was not tested —
  nothing was deployed and no hosted request was made. If it does, the page must send the
  public anon key as `apikey` alongside the `swm_cap_` bearer, and the function must never
  treat `apikey` as authorization.
- **Not verified from this seat:** that the migration applies; that either edge function
  compiles under a Deno version other than the one checked here; that any of it behaves as
  described against a live database. No Supabase instance was started and the p1-server
  suite was not run.

## 8. Related

- `docs/design/SWARM-CLOUD.md` §7 (the spec), §4 (uniform response / no enumeration),
  §5 (rate posture), §10 (the launch-blocking tests).
- `docs/evidence/zero-install-agent-onramp.md` — the earlier llms.txt / agent-skill
  on-ramp, written when no capability URL existed. See its amendment banner.
