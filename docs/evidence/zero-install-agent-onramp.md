# Zero-install agent on-ramp — llms.txt, agent skill, HTTP API reference

**Authored:** 2026-07-27, branch `l6/self-serve-front-door`
**Operator ask:** "maybe even make it work without the cli, just expose the APIs and
include instructions in the link/prompt/llms.txt/skill file"
**Governing spec:** `docs/design/SWARM-CLOUD.md` §7, *Zero-install first touch — the
capability-URL on-ramp*

> **Amended 2026-07-27 (rename).** The product is now **CommonSwarm** and the binary is
> **`cswarm`**; the skill directory moved `site/public/skills/coswarm/` →
> `site/public/skills/cswarm/`. The **forward-looking instructions** below — the install
> one-liner and the post-deploy verification block — have been updated to the new names,
> because a stale command there produces a copied 404 and a grep that manufactures a
> confident zero. The **past measurements** are left exactly as taken: the npm probe row
> below still reads `npm view coswarm version → E404, 2026-07-27`, which is what was run.

> **Amended 2026-07-27 (capability URLs were built).** Every "not applicable — no
> capability URL was built" row in the §7 table below, and the surrounding paragraph
> stating "there is no capability-URL endpoint, no capability principal, no
> token-exchange path", were **true when written and are now superseded**. A capability
> URL, its anonymous read endpoint, its mint/revoke commands, and the CLI verbs
> `cswarm link new` / `cswarm link revoke` were built later the same day; see
> `docs/design/CAPABILITY-URL-ONRAMP.md`. The superseded lines are left in place, marked
> dead by this banner, because they are the record of what was measured then. The
> token-exchange rung and the `/see` page are still not built.
>
> **This makes the three shipped `site/public/` assets stale**, and this seat could not
> fix them (the sprint's lane excluded `site/`). Concretely: `site/public/api.md` still
> says "There is no anonymous access to any endpoint", its Endpoints table omits
> `POST /functions/v1/capability`, and its Limits section still says the capability-URL
> preview "is specified but **not implemented** — there is no endpoint that serves it
> today". `site/public/llms.txt` and `site/public/skills/cswarm/SKILL.md` do not mention
> capability URLs at all. All three need updating before the next site deploy.

Three files ship. All three are static assets under `site/public/`, so they are
committed to the repo *and* fetchable at a stable URL after the next site deploy —
which is the whole point: an agent with no repo access and no CLI can `curl` them.

| Artifact | Path | URL after deploy |
|---|---|---|
| llms.txt | `site/public/llms.txt` | `https://coswarm-site.vercel.app/llms.txt` |
| Agent skill | `site/public/skills/cswarm/SKILL.md` | `.../skills/cswarm/SKILL.md` |
| HTTP API reference | `site/public/api.md` | `.../api.md` |

Nothing under `site/src/` was touched, so no page renders these; they are addressable
by URL only. Linking to them from the site is a separate, deliberate decision.

## Why the skill lives where it does

The skill convention on this machine (verified by enumerating `~/.claude/skills/`, 70
directories) is a **directory named for the skill containing `SKILL.md`**, with YAML
frontmatter carrying exactly `name` and `description` — see `~/.claude/skills/swarm/`
and `~/.claude/skills/leave-swarm/` for the minimal form. `name` must match the
directory.

So the published path mirrors the install path one-for-one:

```
site/public/skills/cswarm/SKILL.md   ->   ~/.claude/skills/cswarm/SKILL.md
```

which makes the install a single command with no rename step:

```sh
mkdir -p ~/.claude/skills/cswarm && \
  curl -fsSL https://coswarm-site.vercel.app/skills/cswarm/SKILL.md \
    -o ~/.claude/skills/cswarm/SKILL.md
```

Note that `~/.claude/skills/swarm` is the **local** `swarm` CLI's skill — a different,
older product. The new skill is named `cswarm`, matching the `bin` entry in
`package.json`, so the two coexist without shadowing.

## §7 conformance

§7 specifies the capability-URL on-ramp. The relevant constraints and how the shipped
artifacts stand against each:

| §7 constraint | Status |
|---|---|
| Positive, minimized per-URL field allowlist | **Not applicable — no capability URL was built.** Nothing new serves tenant data. |
| Anonymous access is read-only | **Honoured by exceeding it.** There is no anonymous access at all; every documented endpoint requires a credential. |
| Writes need a verified identity | **Honoured.** Documented as such throughout; the credential chain is human-minted. |
| Minting a capability URL is human-interactive-credential-only | **Not applicable**, and the human-only boundary that *does* exist (`HUMAN_ONLY_COMMANDS`) is documented as a hard limit in all three files. |
| Never handed to a model as a raw secret | **Honoured.** Both the skill and the API reference instruct the agent to read the token from the environment and never place it in a prompt, transcript, tool argument, or URL. The skill additionally tells the agent to refuse a token pasted into the conversation. |
| Progressive graduation (read → suggest → member → agent) | **Partially served.** The documents provide the "read what is in motion, then post" rung. The suggest tier (§2.12 pending suggestions) does not exist in code. |

**The honest summary: this is not the §7 on-ramp.** §7's first rung is *anonymous
browser read of a scoped projection*, and that rung does not exist in the codebase —
there is no capability-URL endpoint, no capability principal, no token-exchange path,
no allowlisted projection. What shipped is the rung *above* it: once a human has given
you a credential, you need nothing else — no CLI, no npm, no build step.

"Zero-install" here means **no binary to install**. It does not mean **no account**.
That distinction is stated plainly in all three artifacts rather than papered over,
because an agent that believes it can read anonymously will burn a turn discovering it
cannot.

## Where the operator's ask exceeds the spec

The ask was "make it work without the CLI, just expose the APIs". Taken literally and
completely, that would mean an unauthenticated read endpoint. §7 forbids it:
anonymous access may only serve an **exact per-URL field allowlist** behind a
human-minted, TTL-bounded, revocable capability, with a defined capability principal
and a two-tenant IDOR test — none of which exists. Publishing an open read endpoint
to satisfy the ask would reopen exactly the finding (`R4`, Codex + Kimi, BLOCK) that
the capability-URL design was rebuilt to close.

So the scope was **not** widened. The documents expose the API surface that already
exists and is already authenticated. If the operator wants the genuine zero-account
first touch, that is a server change — a capability-URL endpoint built to §7 — and
should be specified and reviewed as one, not implied by a docs page.

## Sourcing — every factual claim, and where it came from

The API reference was written by reading the deployed edge functions, not the
marketing site. Spot-check anchors:

| Claim | Source |
|---|---|
| Endpoint paths `/functions/v1/command`, `/functions/v1/read` | `src/cloud/config.ts`, `commandEndpoint` / `readEndpoint` |
| `authorization` + `apikey` + `content-type` headers | `src/cloud/command-client.ts`, `src/cloud/signals.ts` (every call site sends all three) |
| Both functions are POST-only, else `405` | `command/index.ts` `handleRequest`; `read/index.ts` `handle` |
| Agent token regex `^swm_agt_[A-Za-z0-9_-]{43}$` | `AGENT_TOKEN_RE`, both functions |
| Human credential is a GoTrue JWT; `identityVerified` derives from `email_confirmed_at` | `command/index.ts` `handleRequest` |
| Login is PKCE + GitHub against `/auth/v1/authorize` | `src/cloud/auth.ts`, `oauthUrl` |
| `command_id` regex `^[A-Za-z0-9_-]{8,72}$` | `COMMAND_ID_RE` |
| Idempotency key is `(principal_kind, principal_id, command_id)`; mismatch is `409` | `handleTransaction`, the `swarm.idempotency_keys` SELECT |
| Body cap 128 KiB → `413` | `MAX_BODY_BYTES`, `readBody` |
| `client_version` below `min_client_version` → `426` with the minimum | `handleTransaction`; also `registerLoginDevice` and `createSelfServeWorkspace` |
| Domain rejection is HTTP `200` with `"status":"rejected"` | `handleTransaction`, final `HttpResult` |
| Top-level `from` → `400`; `actor_*`/`device*` ignored and audited | `handleTransaction`; `forgedActorDetail` |
| `post_signal` exact key set, 1–2000 body, `working-on` forbids `to_user_id` | `validateCommand` |
| Signal defaults 24h / 7d / 30d, max 30d | `SIGNAL_DEFAULT_UNTIL_MS`, `SIGNAL_MAX_UNTIL_MS` |
| Body/about sanitising (ANSI, whitespace collapse, control/bidi/zero-width strip) | `sanitizeSignalText` |
| Directed signal target must be a live member, else `403` | `signalTargetIsLive` |
| Signals emit no events (`event_ids` always `[]`) | the `post_signal` branch of `handleTransaction` |
| Rate limits 120/credential/hour and 1000/workspace/hour, hour-aligned windows | `SIGNAL_CREDENTIAL_LIMIT`, `SIGNAL_WORKSPACE_LIMIT`, `enforceSignalRate`, `incrementSignalBucket` (`date_trunc('hour', …)`) |
| `429` body carries `limit` and `resets_at`; a security alert row is written | the rate-limit branch of `handleTransaction` |
| `/read` is not rate-limited | `read/index.ts` contains no `rate` occurrence, against 5 for `signals` as a positive control |
| Free-tier ceilings: 10 invites/identity/day, 25 seats/workspace, 50 principals/workspace, 6 workspace creations/identity/day | `INVITE_IDENTITY_DAILY_LIMIT`, `FREE_TIER_MEMBER_LIMIT`, `FREE_TIER_PRINCIPAL_LIMIT`, `SELF_SERVE_CREATE_DAILY_LIMIT`; `enforceFreeTierBudget` |
| Ceilings are charged only against a command that would otherwise be accepted, and ledger nothing | the `outcome.decision.ok` guard around the `enforceFreeTierBudget` call |
| Disposable-email domains refused on `create_workspace` with a plain `403` | `disposableEmailDomain`, `DISPOSABLE_EMAIL_DOMAINS` |
| `/read` rejects human tokens with `401` | `read/index.ts` `handle`, the `AGENT_TOKEN_RE` test |
| `/read` exact key sets for `signals` and `members` | `read/index.ts` `parseBody`, via `exactKeys` |
| Wrong-workspace read returns `200` with an empty array | `read/index.ts` `handle`, the `principal_workspace_id` comparison |
| Humans read via PostgREST with `accept-profile: swarm_read` | `src/cloud/signals.ts` `humanSignals`; `src/cloud/workspaces.ts` `rows` |
| `503` on lock timeout (`55P03`) | `handleRequest` catch block |
| `403` is uniform and detail-free | every `forbid`/authz return path in `command/index.ts` |
| Connect commands are human-credential-only | `src/protocol/workspace-commands.ts`, `HUMAN_ONLY_COMMANDS`; plus the agent short-circuit in `handleTransaction` |
| Agent token TTL default 1h, max 8h | `AGENT_TOKEN_DEFAULT_TTL_MS`, `AGENT_TOKEN_MAX_TTL_MS` |
| Default scopes = `P0_AGENT_SCOPES`; scopes cannot exceed `humanRights()` | `prepareWorkspaceCommand`; `decideWorkspace` case `mint_agent_token` |
| `agent_token` and `invitation_token` appear only in the fresh response | `handleTransaction`, the `freshOnly` block |
| `mint_agent_token` requires a registered, unrevoked, owned device | `mintBindingsValid` |
| `register_device` requires a verified identity, no `workspace_id`/`stream` | `registerLoginDevice` |
| Invitations: default 24h, max 7 days, Owner/Admin only, single-use | `INVITATION_TTL_MS`, `INVITATION_MAX_TTL_MS`; `decideWorkspace` case `invite_member` |
| `create_workspace`: `SWARM_SELF_SERVE=1`, verified human, < 3 live, no `workspace_id`/`stream` | `selfServeEnabled`, `FREE_TIER_WORKSPACE_LIMIT`, `createSelfServeWorkspace` |
| Task command field lists and `ttl_ms` ≤ 4h, slug/SHA regexes | `validateCommand`; `MAX_TTL_MS`, `SLUG_RE`, `SHA_RE` |
| Env var names `SWARM_CLOUD_URL`, `SWARM_CLOUD_ANON_KEY`, `SWARM_CLOUD_WORKSPACE_ID` | enumerated from `src/cli.ts` and `src/cloud/*.ts`; those three are the complete set, and there is deliberately **no** env var for the token (§2.3 keeps it in the keychain or a `0600` file) |
| No `coswarm` package on npm | `npm view coswarm version` → `E404`, 2026-07-27 |
| No `cswarm` package on npm either | `npm view cswarm version` → `E404`, 2026-07-27, re-run after the rename so `api.md`'s "no `cswarm` package on npm" line is measured and not inherited |
| `install.sh` still names `<host>` as a placeholder | `install.sh`; `site/src/pages/download.astro` frontmatter comment |

## The source moved while this was being written

`supabase/functions/command/index.ts` was edited by a concurrent lane mid-task. The
first read had `enforceSignalRate` at line 2357; the second had it at 2477, with a new
`enforceFreeTierBudget` and four new constants between. The API reference was revised
against the newer state and **cites symbols, never line numbers**, precisely so this
kind of drift cannot silently invalidate it.

The state the shipped documents describe:

```
branch  l6/self-serve-front-door
HEAD    9d24041 (the file is modified in the working tree, not committed)
blob    05b2289b35edea34864a1b0e27d2b99e00b44b24   supabase/functions/command/index.ts
```

Re-check with `git hash-object supabase/functions/command/index.ts`. A different hash
means that lane moved again after this was written, and the rate-limit and ceiling
numbers in `api.md` are the first thing to re-read — they are the part that changed.

## What was NOT verified

Stated so a later reader does not mistake this for a tested claim:

- **No request was ever executed against a live deployment.** Every request and
  response shape here is read off the source. Local Supabase was not started (the
  Lead runs services centrally), so no example curl in `api.md` has been observed
  returning a real `200`.
- **The `apikey` header requirement is asserted from client behaviour, not measured.**
  Both edge functions read only `authorization`; `supabase/config.toml` sets
  `verify_jwt = false` for both. Every CLI call site sends `apikey` anyway, so the
  documents tell callers to send it. Whether the hosted gateway would route a request
  *without* it was not tested.

  ★ **MEASURED 2026-07-28 — the last sentence above is now answered, and the answer is that
  the gateway DOES route it.** The same `POST /functions/v1/command` against the production
  project, once with `apikey` and once without, both returned `401 {"error":"unauthenticated"}`
  — the *function's* body shape. The discriminating control on the same invocation was a POST
  to `/functions/v1/capability` and to a deliberately nonexistent function name, both of which
  returned the *gateway's* shape, `404 {"code":"NOT_FOUND","message":…}`; so the instrument
  separates "gateway refused" from "function refused", and neither `command` arm was refused by
  the gateway. Still unchanged: clients should keep sending `apikey`, and this says nothing
  about a browser holding no Supabase JWT calling `capability`, which is not deployed.
  Recorded in `docs/design/WEB-ONBOARDING.md`.
- **The published URLs do not exist yet.** `https://coswarm-site.vercel.app/llms.txt`
  returned `404` when checked on 2026-07-27, as expected — nothing has been deployed.
  The three cross-links inside these files are therefore *predicted*, not verified,
  and must be re-checked after the deploy that lands them. `/`, `/start`, `/download`
  and `/app` were each confirmed `200` on the live alias at the same time.
- **No Astro build was run** (builds `rm -rf dist` and would race concurrent agents).
  Files in `site/public/` are copied verbatim by Astro, but that this specific tree
  survives the build was not observed.
- **Whether the operator wants these linked from the site** was not decided here. They
  are reachable only by exact URL until someone links them.

## Post-deploy verification

Run these after the site deploys. Each has a positive control, so a silent zero
cannot pass as a result:

```sh
U=https://coswarm-site.vercel.app
curl -s -o /dev/null -w '%{http_code}\n' "$U/llms.txt"                 # 200, not 302/404
curl -s "$U/llms.txt"          | grep -c 'never claims'                # positive control, >0
curl -s "$U/api.md"            | grep -c 'swm_agt_'                    # positive control, >0
curl -s "$U/skills/cswarm/SKILL.md"  | grep -c '^name: cswarm$'        # exactly 1
curl -s "$U/api.md"            | grep -c 'npm install -g cswarm'       # must be 0 outside the "do not" line
curl -s "$U/api.md"            | grep -c 'coswarm'                     # 0 — the old name must be gone
```

The last one is a trap check, not a pass: the phrase appears once inside a *"do not
tell a user to"* sentence. Read the match before judging it — this is precisely the
kind of grep that manufactures a confident wrong answer.

## Known staleness this surfaced (not fixed here — outside the lane)

- `AGENTS.md` line 4 says "**there is no web UI**". Four Astro routes are now live,
  including `/app`. The statement is stale; correcting it belongs to whoever owns
  `AGENTS.md`.
- `AGENTS.md` and `docs/design/SWARM-CLOUD.md` §9 describe distribution "via
  checksummed npm package". There is no npm package; there is an `install.sh` with an
  undecided host. Both documents still read as though npm is the plan.
