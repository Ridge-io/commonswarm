# Switching the web on-ramp on

Written 2026-07-28. The web UI is the primary onboarding path: a person signs in in a
browser, gets a workspace, and hands their agent a credential. The CLI is what the agent
runs. This document is the **order of operations** for turning that on, what breaks if the
order is wrong, and which steps are done today.

★ SUPERSEDED, kept because it describes the preflight posture:
~~It is a runbook, not a claim that the product is open. Nothing in the sequence below has
been executed by the author of this document.~~ **That present-tense status is dead.** The
sequence remains the deployment runbook, but the current-state table below records the
completed rollout.

---

## The one-paragraph version

The site and the backend deploy **independently** and there is no CI (AGENTS.md, "Deploying
the marketing site"). So the switch is six steps across three systems, and three of them can
publish a false claim if run early. In order: **(1)** apply the spend-breaker migration,
**(2)** deploy the edge functions, **(3)** configure hosted auth, **(4)** build and deploy
the site pointed at the backend, **(5)** set `SWARM_SELF_SERVE=1`, **(6)** only then change
copy that says signup is open. Steps 1–2 are the launch-blocking part: §9 P5 requires the
spend circuit breaker to be **in place**, not merely written.

---

## Current state, re-measured 2026-07-29

| Thing | Current state | How that was established |
|---|---|---|
| Browser client code | **Committed and deployed** | `site/src/lib/` is tracked on `main`; the live `/app` carries the public backend config and client surface |
| `<meta>` config tags in the shell | **Deployed** | live `/app` contains a non-empty `commonswarm:url` tag |
| `command`, `read`, and `capability` edge functions | **Deployed (operator-confirmed)** | the rollout record says all three were redeployed after all 10 migrations were pushed; anonymous probes only establish that an endpoint answers |
| Spend circuit breaker | **Applied and deployed (operator-confirmed)** | the repo enumerates exactly 10 SQL migrations (excluding `.gitkeep`), including `20260728000001_spend_circuit_breaker.sql`; the rollout record says all 10 were pushed. This is exhaustive-set evidence, not an anonymous production probe |
| `SWARM_SELF_SERVE` in production | **`1` since 2026-07-28** | production configuration, operator-confirmed; anonymous probes alone cannot reveal the flag |
| Signed-in web app | **Deployed** | `/app` returns 200 with backend configuration; `/start` is the live signup route |
| CLI install (`curl \| sh`) | **Working** | `/install.sh` returns 200, `/nope.sh` returns 404, and the published script installs checksummed `cswarm 0.1.2` from public `Ridge-io/cloud-swarm` |
| Public web front door | **Serving on Cloudflare** | `/`, `/start`, `/app`, and `/download` return 200; a nonexistent route returns 404 |
| Auth email templates | **13 branded templates in production (operator-confirmed)** | the local template manifest independently enumerates 13 bodies; the production application is the operator's measured state |

Signup is open and free: a verified identity may hold three live workspaces and no card is
required. This table records deployment state, not a claim that every human journey has
been exercised. In particular, the first dogfood run used CLI GitHub OAuth rather than a
cold browser signup.

<details>
<summary>★ SUPERSEDED 2026-07-28 current-state table — DEAD as current status</summary>

| Thing | State | How that was established |
|---|---|---|
| Browser client code | **Written, UNCOMMITTED** — it exists only in this working tree | `git ls-files site/src/lib/` returns **0** and `git log -- site/src/lib/` is empty; the file is 289 lines on disk. A `git clean` would delete it |
| `<meta>` config tags in the shell | **Written**, not deployed | `site/src/layouts/Base.astro:208-209`; the live page has none (below) |
| `command` edge function | **Deployed** to the production project | `POST /functions/v1/command` → `400 {"error":"invalid_request"}` — the *function's* body shape, so the request reached it |
| `read` edge function | **Deployed** | `POST /functions/v1/read` → `401 {"error":"unauthenticated"}` |
| `capability` edge function (§7) | **NOT deployed** | `POST /functions/v1/capability` → `404 {"code":"NOT_FOUND",...}`, byte-identical to a control POST at `/functions/v1/nonexistent-function-control` |
| Spend circuit breaker | Code + migration **written** and on `main`; **applied/deployed state unknown** | `supabase/functions/command/index.ts:398-452`, `supabase/migrations/20260728000001_spend_circuit_breaker.sql`; no database access from this seat |
| `SWARM_SELF_SERVE` in production | **Unknown from outside, assumed unset** | Deliberately unprobeable — see "What cannot be measured from outside" |
| Signed-in web app | **Not deployed** | Live `/app` returns 200 but contains no client code: `grep -c signInWith` = **0** against a positive control `grep -c og:title` = **1** on the same fetched body |
| CLI install (`curl \| sh`) | **Broken** | `install.sh:12` defaults to `Ridge-io/coswarm-dist`; `https://github.com/Ridge-io/coswarm-dist` → **404**, with controls `Ridge-io/cloud-swarm` → 200 and an unrelated public repo → 200 |
| `commonswarm.com` | **Serving** | `/` → 200, `/app` → 200, `/definitely-not-a-page` → 404 (control proves the 200s are not a catch-all) |

These probes ran 2026-07-28 against the production project in `.env.cloud` (gitignored;
`.gitignore:11`). They are unauthenticated and read-only. None of them can create anything.

</details>

**On the line numbers in this document.** They were read off the working tree on 2026-07-28,
and `supabase/functions/command/index.ts` had **uncommitted edits from another seat** at that
moment. Every citation also names the symbol it points at; if a number does not land, trust
the symbol and re-derive the number rather than assuming the behaviour moved.

---

## Step 0 — the precondition that is not a step

**§9 P5 makes the global spend circuit breaker launch-blocking**, in the exact sense of
"bounded, not merely alerted": *"Free-tier abuse is bounded, not merely alerted (P5 gate,
§8/§9): … global spend circuit breaker trips to signup-paused before runaway cost"*
(`docs/design/SWARM-CLOUD.md:426`; the taxonomy is at `:368`). Opening signup without it is
the failure that gate exists to prevent, so it is not a step you can reorder — it is the
condition on doing step 5 at all.

What exists today, on `main` at `f467d4e`:

- Four authenticated spend proxies with hourly ceilings —
  `supabase/functions/command/index.ts:441-452` (`workspace_create` 100, `invite_send` 400,
  `signal_post` 20000, `agent_token_mint` 1000). They are counted in sharded rate buckets
  (`:454-479`) and charged at `:2642`, `:4149` and `:4401`.
- A latched trip that pauses **signup only** — `enforceSpendBreaker` at `:2893-2924` returns
  `503 {"error":"signup_paused"}` and nothing else stops. Existing workspaces keep posting
  signals, minting tokens and reading.
- The storage it needs — `swarm.spend_breaker` and its grants and functions in
  `supabase/migrations/20260728000001_spend_circuit_breaker.sql:43,112-113,147,175`.

**What is deliberately absent, and must not be invented:** there is no dollar figure and no
billing telemetry anywhere in this system. The ceilings are counts of the operations that
spend money, chosen from the per-tenant limits and a single-digit tenant count — an
order-of-magnitude guess, not a measured budget (`:398-440`). A trip means "cost is being
generated at a rate nobody planned for". It does **not** mean "the bill reached $N", and no
report may say so.

**Not established here:** whether migration `20260728000001` has been applied to the
production database, and whether the deployed `command` function is a build that contains
the breaker. Both require access this seat does not have. Treat the breaker as **written,
not verified in place** until someone reads it off the production database.

---

## Step 1 — apply the spend-breaker migration

Apply `supabase/migrations/20260728000001_spend_circuit_breaker.sql` to the production
database **before** deploying the function that reads it.

**What breaks if this is out of order.** The dependency is not cosmetic and it fails in two
different ways:

- `enforceSpendBreaker` runs `SELECT … FROM swarm.spend_breaker`
  (`supabase/functions/command/index.ts:2833-2845`) on **every** `create_workspace`. With the
  table absent, the query throws and the request is caught by the generic handler at
  `:4580-4604`, which answers `500 {"error":"internal_error"}`. A user trying to sign up sees
  a crash, not a state. This is latent while self-serve is off — the call site at `:2529`
  sits *after* the `selfServeEnabled` gate at `:2424` — which means an unapplied migration
  stays invisible until the moment you flip step 5, and then breaks the only thing you just
  turned on.
- `chargeSpend` calls `swarm.trip_spend_breaker` (`:2760-2782`) only when a shard is over its
  share, so `signal_post` keeps working normally with the migration missing **and then fails
  under exactly the load the breaker exists for**. A control that only breaks during a surge
  is worse than no control.

Pushed ≠ landed ≠ applied. The migration file being on `main` is not the migration being
applied; say which one you mean.

---

## Step 2 — deploy the edge functions

```sh
supabase functions deploy command --project-ref <ref>
supabase functions deploy read    --project-ref <ref>
```

Do **not** deploy `capability` as part of switching signup on. It is the §7 anonymous
capability-URL read, it is gated off by `SWARM_CAPABILITY_URLS` in both functions
(`supabase/functions/capability/index.ts:211`, `supabase/functions/command/index.ts:339`),
and it is measurably not deployed today (the 404 above). **There is no working zero-install
read path.** Any copy implying one is false.

### `verify_jwt` — checked, and correct as it stands

Asked and answered, since the natural instinct on reading `verify_jwt = false` is to "fix"
it:

- `[functions.capability]` → `verify_jwt = false` (`supabase/config.toml:448-451`).
  **Correct and required**: the caller has no Supabase session at all, only a `swm_cap_`
  bearer.
- `[functions.command]` → `verify_jwt = false` (`supabase/config.toml:436-439`). **Correct
  and load-bearing; do not change it.** The bearer on this endpoint is frequently *not* a
  Supabase JWT: agents present `swm_agt_…` (`src/cloud/command-client.ts:16,499`), and a
  JWT-verifying gateway would 401 them before the function ran — every agent in the product,
  offline. The function authenticates itself, unconditionally and first:
  `supabase/functions/command/index.ts:4516` rejects a missing bearer with 401, `:4529`
  routes an agent token through `AGENT_TOKEN_RE` plus a hash lookup, and `:4541` requires
  `auth.getUser(credential)` to succeed for anything else. `[functions.read]` is `false` for
  the same reason (`src/cloud/signals.ts:153` sends an agent token).
- **Nothing was changed.** A comment recording the above was added above the block so the
  next reader does not "fix" it into an outage.

**Measured, and it closes an open question.** `docs/evidence/zero-install-agent-onramp.md:192-196`
recorded that whether the hosted gateway demands an `apikey` header was untested. It does
not: the same `POST /functions/v1/command` with and without `apikey` both returned
`401 {"error":"unauthenticated"}` — the *function's* body shape, not the gateway's
`{"code":…,"message":…}` shape seen on the 404. Both arms being identical is meaningful here
only because a third arm (the 404) proves the instrument distinguishes gateway rejection
from function rejection. Clients should keep sending `apikey` anyway; the CLI does.

---

## Step 3 — configure hosted auth

In the Supabase **dashboard** for the production project, not in this repo:

1. Enable the **GitHub** provider with real OAuth credentials. Both surfaces use GitHub and
   only GitHub — `src/cloud/auth.ts:213` for the CLI, `site/src/lib/commonswarm.ts:88` for
   the browser. Adding a second provider on one surface and not the other would give the two
   surfaces different identity sets for the same person.
2. Add the site's callback to the **redirect allow-list**: the browser client asks to return
   to `<origin>/app` (`site/src/components/app/LiveDashboard.astro:167`), so
   `https://commonswarm.com/app` — plus `https://coswarm-site.vercel.app/app` while that
   alias is still served. A URL that is not on the list does not error; Supabase silently
   returns the user to the project's Site URL, which reads to the user as "sign-in did
   nothing".

`supabase/config.toml` configures **local** Supabase only and cannot open or close anything
in production. Note also that it has **no `[auth.external.github]` block at all** — so GitHub
sign-in cannot be exercised against a plain `supabase start` until one is added with real
credentials. A comment stating this now sits above `[auth]` at `supabase/config.toml:150-163`.

**What breaks if this is out of order.** Deploy the app before the provider exists and the
sign-in button opens an OAuth error page on Supabase's domain — the user's first impression
of the product is a stranger's error screen.

---

## Step 4 — build the site pointed at the backend, and deploy it

The browser client resolves its backend in this order
(`site/src/lib/commonswarm.ts:49-57`):

```
import.meta.env.PUBLIC_SUPABASE_URL      ?? <meta name="commonswarm:url">
import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? <meta name="commonswarm:anon-key">
```

and returns **null** when either is missing (`:55`), which `client()` turns into a null
client rather than a throw (`:62-70`). An unconfigured build is therefore a *state*, not a
crash: the page loads and the app route says it is not pointed at a deployment. That is why
`site/astro.config.mjs` deliberately declares no `env:` schema — see the comment at
`site/astro.config.mjs:12-23`.

`site/src/layouts/Base.astro:208-209` now emits both `<meta>` tags on every page, filled from
the same env vars (`:104-105`) and emitted **even when empty**, because an empty tag is the
editable slot that lets someone repoint a built bundle by editing HTML. Empty is read as
absent, never as a value: `commonswarm.ts:51` ends `?.content?.trim() || null`.

**The precedence trap.** The env var wins *and is inlined into the JS bundle at build time*.
A build made with `PUBLIC_SUPABASE_URL` set therefore **cannot** be repointed by editing the
meta tags — the bundle no longer reads them. If you want a bundle someone else can point at
their own project, build it with both variables **unset**.

**The deploy trap that makes this different from every other Vercel project.** The build runs
on the operator's machine and `vercel deploy dist` uploads a finished folder (AGENTS.md,
"Deploying the marketing site"). **Environment variables set in the Vercel dashboard have no
effect** — nothing is built there. The variables must be in the shell that runs
`npm run build`:

```sh
cd site
export PUBLIC_SUPABASE_URL='https://<ref>.supabase.co'
export PUBLIC_SUPABASE_ANON_KEY='<the project anon key>'
rm -rf dist && npm run build
cp -r .vercel dist/.vercel                       # load-bearing — AGENTS.md trap 5
vercel deploy dist --prod --yes --scope ridgedotio
```

**The anon key comes from the environment and is never committed.** It is a public
identifier, not a secret — every Supabase browser app ships one, and authorisation is the
user's JWT plus RLS plus the edge functions' own checks (`site/src/lib/commonswarm.ts:16-19`).
Public is still not the same as *checked into a repo that outlives the project*: keep it in
the deploy environment. A service-role key must never appear anywhere under `site/`.

**This step is safe before self-serve is on**, and that is the point of doing it here: a
signed-in user with no workspace sees an honest "not open on this deployment yet" state,
because `createWorkspace` maps `403` to `SignupRefused` and `503` to a paused-signup message
(`site/src/lib/commonswarm.ts:204-220`) rather than to an error the reader could think they
caused.

**What breaks if this is out of order.** Deploy the app *after* step 5 and you have opened
signup with no way for a human to reach it. Deploy it *before* step 2 and the app talks to
whatever function version happens to be live — today that means `command` answers and
`capability` returns 404, so any surface built on §7 fails while the rest looks fine.

---

## Step 5 — `SWARM_SELF_SERVE=1`

```sh
supabase secrets set SWARM_SELF_SERVE=1 --project-ref <ref>
```

This is the whole of the switch: `supabase/functions/command/index.ts:366` reads it, and
`createSelfServeWorkspace` refuses with `403` at `:2424` for any other value, including
unset. Note the gate answers **first**, ahead of the identity checks at `:2425-2469`, so
while self-serve is dark the response cannot be used to probe whether an identity is
verified.

Do not set this until steps 1–4 are actually done. It is the only step that changes what a
stranger can do.

**The value is read once, at module load, not per request.** `const selfServeEnabled =
Deno.env.get("SWARM_SELF_SERVE") === "1"` is top-level (`:366`), so an isolate that started
before the secret existed keeps `false` for as long as it stays warm. If the first attempt
after setting the secret still returns 403, that is expected and it is not a second bug:
redeploy the function to force fresh workers, then re-test. The same applies in reverse — if
you ever need to close signup in a hurry, unsetting the secret alone does not evict warm
workers.

The free tier is real and server-enforced once this is on: **3 live workspaces per verified
identity** (`FREE_TIER_WORKSPACE_LIMIT`, `:373`), counted inside the transaction so two
concurrent requests cannot both read limit−1 (`:2533-2551`), with archiving freeing a slot. A
rolling daily creation cap of 6 (`:381`) stops archive-and-recreate looping past it.

---

## Step 6 — verify against production, then change the copy

Verify the deployed artifact, never the source you edited. Each check needs a positive
control on the same invocation, or a silent zero reads as a pass:

```sh
U=https://commonswarm.com
curl -s -o /dev/null -w '%{http_code}\n' "$U/app"                 # 200, not 302/404
curl -s "$U/app" | grep -c 'commonswarm:url'                      # 1 — the config tag shipped
curl -s "$U/app" | grep -c 'og:title'                             # 1 — positive control
curl -s "$U/definitely-not-a-page" -o /dev/null -w '%{http_code}\n'  # 404 — proves 200 is real
```

★ **COMPLETED 2026-07-28:** ~~Then, and only then, revisit the copy that says signup is not
open.~~ The availability-copy sweep covered `SiteFooter.astro`,
`download/AfterInstall.astro`, `landing/Invite.astro`, and `install.sh`'s closing text.
Repeat that sweep whenever the deployment gate changes.

~~**The CLI hand-off is still broken at this point** and copy must not pretend otherwise:
`install.sh:12` points at `Ridge-io/coswarm-dist`, which returns **404**.~~ ★
**SUPERSEDED — DEAD.** The public installer now defaults to `Ridge-io/cloud-swarm`,
downloads the checksummed `v0.1.2` release, and installs `cswarm 0.1.2`. A web signup may
hand off to `curl -fsSL https://commonswarm.com/install.sh | sh`; the live installer returns
200 and a nonexistent `/nope.sh` control returns 404.

---

## What cannot be measured from outside, and must not be guessed

- **Whether `SWARM_SELF_SERVE` is set cannot be inferred from an anonymous probe alone.**
  That measurement limit remains true: the bearer check refuses before the gate is reached.
  It is nevertheless known from production configuration that the value has been `1` since
  2026-07-28. Do not turn “anonymous probes cannot distinguish the state” back into “the
  state is unknown.”

  ★ SUPERSEDED: ~~The typed refusal change is in-flight and uncommitted, self-serve is dark,
  and the app maps every 403 to one `SignupRefused`.~~ **Dead.** The server now returns
  distinct `email_not_verified`, `email_domain_not_accepted`, and
  `self_serve_disabled` bodies; the deployed client maps the first two to their own fixable
  states. A verified signed-in caller can distinguish a disabled deployment gate, which is
  an intentional disclosure about deployment state, not another person.
- **Whether the spend-breaker migration is applied**, and **which build of `command` is
  deployed, cannot be established by an anonymous probe.** The operator's rollout record
  says all 10 migrations were pushed and all three functions redeployed; the repo contains
  exactly 10 SQL migration files, one of which is the spend breaker. This seat did not
  independently authenticate production state: an endpoint answering only proves that some
  build exists.

---

## What this document's author did NOT do

- Ran no build. `npm run build` in `site/` wipes a `dist/` shared with concurrent agents, so
  the `<meta>` tags were **not** observed in deployed or built HTML.

  What was done instead, because "it looks fine" is not a check: `Base.astro` was compiled
  in memory with the already-installed `@astrojs/compiler-rs` — **0 diagnostics**, and the
  emitted code contains both `commonswarm:url` and `commonswarm:anon-key` and does **not**
  contain the frontmatter note (confirming it is stripped rather than shipped as an HTML
  comment, which is the trap this repo has been bitten by). The instrument discriminates: a
  deliberately malformed template through the same call returns `severity: "error"`
  diagnostics. `astro.config.mjs` was imported and evaluated — `output: "static"`,
  `site: "https://commonswarm.com"`, no `env` key.

  Still **not** measured: Vite's behaviour for an *unset* `PUBLIC_*` variable (yielding
  `undefined`, so `??` falls through to the meta). That is read from the client type
  declarations and `commonswarm.ts`'s contract, and it needs a real build to confirm.
- Deployed nothing, committed nothing, and touched no file outside
  `site/astro.config.mjs`, `site/src/layouts/Base.astro`, `supabase/config.toml` and `docs/`.
- Made no authenticated request to production. Every probe above was anonymous and read-only.
