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
  fields for exactly one work item, and the role that serves it can reach no tenant row
  except through that one projection function. §3 gives the exact grant set, including the
  one non-tenant table the role can read and why that grant exists.
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
`supabase/functions/command/index.ts`). Verified against the code on 2026-07-28:
`capabilityUrl()` returns `` `${origin}${CAPABILITY_PATH}#${token}` `` with
`CAPABILITY_PATH = "/see"`, so the emitted link and this sentence agree, and the token is
in the fragment and never in the query string. It is the only composition site — nothing
else in `src/` builds a `/see` URL.

**`--site` is an allowlist, not a syntax check** (`capabilitySiteOrigin` in
`src/cloud/capability-link.ts`, `CAPABILITY_ALLOWED_HOSTS`). `--site` and
`CSWARM_SITE_ORIGIN` may name only `coswarm-site.vercel.app` (the default),
`commonswarm.com`, `www.commonswarm.com`, or a loopback host for developing the page; each
must be `https` (loopback may be `http`), a bare origin, portless, with no path, query,
fragment or userinfo, and the error names the permitted set. Validated *before* the mint
request, so a wrong origin costs a line of output rather than a credential. Every one of
those errors names **the input the operator actually supplied** — `--site` when the flag was
passed, `CSWARM_SITE_ORIGIN` otherwise. That includes the empty case: `--site ""` reaches
the same branch an empty `CSWARM_SITE_ORIGIN` does (the CLI's parser passes an empty flag
value through verbatim), and until 2026-07-28 it named the environment variable in both,
sending an operator who had just typed the flag off to inspect something that was not
involved.

★ **Changed 2026-07-28, and the reason is not tidiness.** The superseded rule — *"it must
be `https`, a bare origin, with no path, query, or fragment"* — is **dead**: it accepted
**any** https host. Since the printed string is a live credential and not an address, one
mistyped or attacker-supplied origin — and `CSWARM_SITE_ORIGIN` is invisible in the
command the operator types — sent the operator to paste a working capability token into a
stranger's host, which could then read that work item for the life of the link. Syntax
said the string was well formed; it said nothing about who received the credential.

**Who may mint.** Three checks, in order, each with its own audit reason
(`supabase/functions/command/index.ts` — `capabilityPreamble`):

1. the credential must be a human user credential — an agent token is refused here and
   never reaches the next line (`capability_mint_credential_kind_forbidden`);
2. the identity must be verified (`capability_mint_identity_not_verified`);
3. the caller's live membership role must be `owner` or `admin`
   (`capability_mint_role_forbidden`).

A non-member, and a member naming another tenant's `workspace_id`, take the same third
branch — so the response is not a cross-tenant existence oracle.

Revoke runs the same preamble with its own reasons (`capability_revoke_*`), so it is
human-only for the same reason mint is.

**Do not grep for those reason strings — none of them exists as a literal.** They are built
as `` `${scope}_role_forbidden` `` with `scope` set to `capability_mint` or
`capability_revoke`, so `grep capability_mint_role_forbidden` over
`supabase/functions/command/index.ts` returns a confident **0** while the reason is
emitted exactly as written here. Enumerate the `refuse(` call sites in `capabilityPreamble`
instead; that is how this list was checked on 2026-07-28. Only
`capability_feature_disabled` is a literal.

**The CLI now states rule 1 locally, before the round trip**
(`assertHumanCapabilityCredential` in `src/cloud/command-client.ts`, called by both
`runLinkNew` and `runLinkRevoke`). The server remains the authority and nothing about this
check is a substitute for it — but the server's 403 is deliberately uniform across "wrong
credential kind", "not verified", "not an owner" and "no such work item", so a caller
holding an agent credential otherwise learns only that something was forbidden. The local
check requires a GoTrue access token by shape, names the agent case when it sees one, and
never quotes the credential.

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
`swarm_admin`. The complete grant set of the role that serves anonymous traffic,
`swarm_capability`, enumerated 2026-07-28 across **both** migrations that touch it —
`supabase/migrations/20260727000001_capability_urls.sql` and
`…_20260727000002_capability_urls_hardening.sql`, the second of which was **untracked in
git** when this was written (`git status` reported `??`), so it is neither committed nor
applied — is:

| Grant | Where |
|---|---|
| `USAGE` on schema `swarm` | 000001 |
| `EXECUTE` on `swarm.capability_projection(bytea)` | 000001 |
| `SELECT, INSERT, UPDATE` on `swarm.rate_buckets` | 000001, table-wide; 000002 narrows the RLS policy to `bucket_key LIKE 'capability:read:%'` |
| `INSERT` on **14 named columns** of `swarm.audit_log` | 000001 granted it table-wide; 000002 revokes that and re-grants column-level, excluding `audit_id` and `occurred_at` |
| `INSERT` on `(kind, subject, detail)` of `swarm.security_alerts` | same pattern, 000001 → 000002 |
| `USAGE` on the two audit sequences | 000001 |

Nothing else. 000001 then names the excluded tables one by one, so a later migration
cannot add one absent-mindedly.

★ **CORRECTED 2026-07-28.** The superseded sentence — *"the role that serves anonymous
traffic, `swarm_capability`, holds `EXECUTE` on that one function and `SELECT` on no table
at all"* — is **dead, and was false when it was written**. That role holds `SELECT` on
`swarm.rate_buckets` (migration line 327), and the grant is load-bearing rather than an
oversight: the fixed-window limiter runs `INSERT … ON CONFLICT (bucket_key, window_start)
DO UPDATE SET count = LEAST(swarm.rate_buckets.count + 1, …) RETURNING count`, which both
reads the existing counter and returns it, and PostgreSQL requires `SELECT` for each.
`alertGlobalSurge` in `supabase/functions/capability/index.ts` then removes any doubt about
the reading: it runs a plain `SELECT coalesce(sum(count), 0) FROM swarm.rate_buckets WHERE
bucket_key = ANY(…)`. The document contradicted itself two sentences later: the grant list
directly above named the grant correctly while the summary sentence denied it.

What is true, written so it can be checked rather than believed: `swarm_capability` holds
`SELECT` on **exactly one** table, `swarm.rate_buckets`, whose whole column list is
`bucket_key`, `window_start`, `count` — no tenant identifier and no tenant content. It
holds `SELECT` on no table containing tenant data, so the projection's nine columns are
still the only path from this role to a tenant's rows. The residual is worth naming rather
than rounding off: a bug that let this role run arbitrary SQL could read `rate_buckets`,
disclosing client IP addresses and the SHA-256 digests of presented capability tokens, and
answering "was this exact token presented in this window" — an oracle, though not tenant
data. 000002's `USING (bucket_key LIKE 'capability:read:%')` policy confines that reach to
the keys this endpoint owns; it does not remove it, because two of those keys are
precisely the ones carrying the IPs and the digests.

★ **CORRECTED 2026-07-28: it is not "three keys".** The superseded phrasing — *"confines
that reach to the three keys this endpoint owns … because those three keys are precisely
the ones carrying the IPs and the digests"* — is **dead**. It undercounted, and the same
sentence is still in the SQL: `20260727000002_capability_urls_hardening.sql`, above the
`swarm_capability_all` policy, reads *"The capability function only ever touches three
keys … (the per-token bucket, the per-origin bucket and the global surge bucket)"*.
Enumerated against `supabase/functions/capability/index.ts` on 2026-07-28, the complete
set of `bucket_key`s this endpoint writes is:

| Key | How many | Carries |
|---|---|---|
| `capability:read:<sha256 hex of presented bearer>` | one per digest seen | the token digest |
| `capability:read:origin:<client ip hint>` | one per caller hint | the IP hint |
| `capability:read:global:0` … `:15` | `GLOBAL_SHARDS` = 16, fixed | nothing but a count |
| `capability:read:global:alerted` | 1, fixed — the surge alert latch | nothing but a count |
| `capability:read:auditbudget` | 1, fixed — the refusal audit budget | nothing but a count |

So: two unbounded per-caller families plus **eighteen** constant keys, not three. The
global surge counter became sixteen rows when it was sharded to stop a single hot row
serialising the whole anonymous surface; the latch and the audit budget were added with
the alert and the refusal-audit cap. **The policy's rule is unaffected and remains
correct** — every key above is `capability:read:`-prefixed, so `LIKE 'capability:read:%'`
still covers exactly this set and nothing else. Only the count is wrong, and only the
last three rows of the table are new information for the oracle question: they carry no
IP and no digest, so the residual described above is unchanged. The accurate enumeration
now sits beside the constants in `supabase/functions/capability/index.ts`; the SQL comment
still reads "three" and needs a **new** migration to correct, since 000001 and 000002 are
committed and are not edited in place.

★ **Where that retired claim still lives — re-enumerated 2026-07-28, and the earlier count
of five was wrong.** The superseded sentence here — *"The same retired claim is still
written into five code comments … `20260727000002` line 172, which repeats it as settled
background … and `supabase/functions/capability/index.ts` at the file header and above the
projection query"* — is **dead**. Read against the tree rather than from memory, the five
split three ways:

- **Still carrying the dead claim — two, both in `20260727000001_capability_urls.sql`:**
  line 205 (the section-D header, *"SELECT on NO table"*) and line 322 (the *"COMPLETE
  list of its privileges"* comment, *"It has SELECT on no table whatsoever"*, sitting four
  lines above `GRANT SELECT, INSERT, UPDATE ON swarm.rate_buckets`). These are the ones
  that need correcting, and correcting them takes a **new** migration.
- **Already correct — one:** `20260727000002_capability_urls_hardening.sql` line 172 does
  not repeat the claim as background. It states the opposite in full, names the grant, the
  line number and the RLS confinement, and records that *"the earlier phrasing 'SELECT on
  no table' was flatly wrong and a cross-model reviewer caught it against this very
  file"*.
- **Already correct — two:** `supabase/functions/capability/index.ts` says *"SELECT on no
  table carrying tenant data"* in the file header and *"holds SELECT on no TENANT table"*
  above the projection query. Both are true as written; neither is the dead sentence.

The lesson this file keeps re-learning is in the counting, not the claim: a list of
locations written once and never re-run goes stale the moment somebody fixes one of them,
and then the document is wrong in the *other* direction — asserting a defect that is no
longer there.

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

**Anonymous cannot change anything any tenant can see — but it does write.**

★ **CORRECTED 2026-07-28.** The superseded sentences — *"The capability endpoint has no
mutation path of any kind; any write requires a verified identity through the command
function. Anonymous mutation is impossible, not merely unauthorised."* — are **dead and
were false**. Measured against `supabase/functions/capability/index.ts`, re-checked
2026-07-28: an anonymous request that gets past the feature gate performs **one to three**
`swarm.rate_buckets` upserts — caller-IP bucket first (a request refused there returns 429
having done exactly one), then the presented-token-hash bucket, then one randomly chosen
shard of the global surge counter — and may write **up to two more** `rate_buckets` rows on
top: the surge alert latch, and the refusal-audit budget counter, which is itself an upsert
performed before any refusal audit row. It may then write one `swarm.audit_log` row and one
`swarm.security_alerts` row (at most one of each: every branch that writes an alert returns
immediately after). Those are writes, driven by an unauthenticated caller, on the only
internet-reachable surface in the product. The function's own star comment above `deny()`
describes exactly these writes and calls the audit growth a denial-of-service vector it had
to throttle — so this document asserted a property that the implementation it cites had
already documented lacking.

★ **The governing spec still states the retired claim, and this file does not get to
overrule it.** `docs/design/SWARM-CLOUD.md` §7 (line 342) ends its *"Anonymous = read-only;
writes need a verified identity"* bullet with the words *"anonymous mutation is
impossible"*, unqualified — as does the archived `SWARM-CLOUD-V1.md` line 314. This
document opens by saying the spec wins on conflict, so a reader who checks will find the
correction above apparently overruled by the spec. It is not a conflict about the design,
only about scope of wording: the spec bullet is about **tenant** state, and on tenant state
it is exactly right — no anonymous request can create, alter, revoke or delete a work item,
a membership, a signal, an event or a link, and `swarm_capability` holds no write privilege
on any table carrying tenant state. What it is not is a statement about the endpoint's
counters and ledgers, which do take anonymous writes by design. **Amending the spec line to
say so is a spec edit and is not made here**; until it is made, read §7 line 342 as scoped
to tenant state.

The property that actually holds, which is the one the envelope needs:

- The three writable tables are `swarm.rate_buckets`, `swarm.audit_log` and
  `swarm.security_alerts`: one counter and two append-only ledgers. `swarm_capability`
  holds no `INSERT`, `UPDATE` or `DELETE` on any table carrying tenant state — including
  `swarm.capability_urls` itself, on which it holds nothing at all. No anonymous request
  can create, alter, revoke or delete a work item, a membership, a signal, an event, or a
  link. Minting and revoking remain a verified human identity through the command
  function.
- None of the three is readable back through this endpoint. Its only read is the
  projection, so a write is not a channel: an anonymous caller cannot observe what it
  wrote, and cannot use one to make the projection say something different.
- What this costs is capacity, not confidentiality or integrity, and it is deliberately
  bounded: refusals audit once per caller per window rather than once per request, and the
  number of rate-bucket rows a caller can create per hour is fixed.

**Not established:** that `swarm.audit_log` growth on the *accepted* path is bounded. Every
successful read still writes one row, `audit_log` has no purge schedule, and nothing here
measures the resulting volume or tests the throttle.

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
- **No test covers the client-side capability code.** Enumerated 2026-07-28:
  `grep -rn "capabilitySiteOrigin\|capabilityUrl\|renderCapabilityMint" tests/` returns
  **zero** lines, and no file under `tests/` references `src/cloud/capability-link.ts`.
  The origin allowlist, the fragment composition, the once-only rendering and the
  human-credential check are therefore asserted by reading, not by execution. The three
  pure functions are the cheapest tests in this feature; they are simply absent.
- **Not verified from this seat:** that the migration applies; that either edge function
  compiles under a Deno version other than the one checked here; that any of it behaves as
  described against a live database. No Supabase instance was started and the p1-server
  suite was not run.

## 8. Related

- `docs/design/SWARM-CLOUD.md` §7 (the spec), §4 (uniform response / no enumeration),
  §5 (rate posture), §10 (the launch-blocking tests).
- `docs/evidence/zero-install-agent-onramp.md` — the earlier llms.txt / agent-skill
  on-ramp, written when no capability URL existed. See its amendment banner.
