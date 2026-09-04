# Google sign-in

Status: **written and merged dark.** The code is on `main`'s lane `lane/google-signin`; the
button does not render in any build that does not set `PUBLIC_SWARM_AUTH_PROVIDERS`, and Google
is **off** in the Supabase dashboard. Turning it on is the operator checklist at the end.

`docs/design/SWARM-CLOUD.md` remains canonical for anything this file does not cover.

---

## Why

GitHub sign-in and an email link are the two doors today. GitHub asks for a developer account,
and the email link is rate limited to **2 emails per hour for the whole project** while the
built-in sender is in use (`site/src/lib/commonswarm.ts`, `EmailRateLimited`) — so a first-time
visitor can be blocked by a stranger's signup. Google is the door that is neither: no developer
account, no email delivery, one press.

## Measured starting state (2026-09-04)

Everything below was read off the live deployment, not assumed.

| Fact | How it was measured |
|---|---|
| The site publishes `https://api.commonswarm.com` | `curl -s https://commonswarm.com/app \| grep 'commonswarm:url'` |
| Project ref `ukezjcnxjvkpkeezxaew` | `sb-project-ref` response header on the API host |
| Enabled providers: `github: true`, `google: false`, `email: true`; every other provider `false` | `GET https://api.commonswarm.com/auth/v1/settings` — GoTrue enumerates all 25 providers it knows, so this is a count, not a grep |
| GoTrue's callback is `https://api.commonswarm.com/auth/v1/callback` | The `redirect_uri` inside the 302 from `GET /auth/v1/authorize?provider=github` |
| The `*.supabase.co` host emits the **same** custom-domain callback | Same probe against `https://ukezjcnxjvkpkeezxaew.supabase.co` — the `redirect_uri` is still `api.commonswarm.com` |
| A disabled provider returns `400 {"msg":"Unsupported provider: provider is not enabled"}` | `GET /auth/v1/authorize?provider=google` today |

---

## The flows

### A new user

1. On `/app` or `/invite`, presses **Sign in with Google**.
2. `signInWithProvider("google", <return URL>)` navigates the browser to
   `https://api.commonswarm.com/auth/v1/authorize?provider=google&redirect_to=<return URL>`.
3. GoTrue redirects to Google. Google asks for consent to share name, email, and profile
   picture. Nothing else is requested.
4. Google returns to `https://api.commonswarm.com/auth/v1/callback`. GoTrue creates the user
   and redirects to the return URL with the session in the URL fragment.
5. `detectSessionInUrl: true` on the browser client picks the session up, and the page boots
   signed in. From here Google users are indistinguishable from GitHub users.

The return URL is `<origin>/app` from the workspace and `<origin>/invite?resume=<id>` from an
invitation. Both are the URLs GitHub sign-in already uses, unchanged.

### An existing user whose Google address matches a GitHub account

**Ruling: one account per verified email address, and the linking is Supabase's, not ours.**

Supabase Auth links a new OAuth identity to the existing user with the same email address.
Signing in with Google on an address that already has a CommonSwarm account therefore returns
**the same `user_id`**, and every workspace membership — which hangs off `user_id` — is still
there. There is nothing to migrate and nothing to undo.

Why this rule and not a merge prompt:

1. **A merge prompt would be an account-enumeration oracle.** To offer "you already have an
   account with this email" the page must first learn that the email has an account. Row-level
   security correctly refuses that from the browser, and the email door is deliberately built
   so it cannot answer the question either — `signInWithEmail` returns the same response for a
   known and an unknown address, and its comment says so in capitals. A Google button that
   leaked the answer would take that property away from the whole product to serve one screen.
2. **A second linking mechanism is a second enforcement, and two enforcements drift.** GoTrue
   already decides identity. Anything we wrote would be a copy of that decision with its own
   version of "verified", living in a browser where it can be skipped.
3. **It is the cheapest correct thing.** No schema change, no migration, no new failure mode on
   a path that carries every user.

We do **not** enable manual linking (`linkIdentity()` /
`GOTRUE_SECURITY_MANUAL_LINKING_ENABLED`). "Connect a second Google address to my account" is a
settings feature, not a sign-in feature, and it is not needed for anyone to get in.

**What this ruling costs, stated plainly.** If Google returns the address as *not verified*, no
link happens and the person gets a **second, empty account on the same email address** — signed
in, no workspaces, no explanation. See the next section. This is accepted, not solved.

**One consequence worth knowing before it surprises somebody.** Supabase removes other
*unconfirmed* identities from a user when a new identity links to it. A CommonSwarm account
whose GitHub email was never confirmed can therefore come out of a Google sign-in with the
GitHub identity gone. The account, the workspaces, and the agents are untouched; the GitHub
button would start a fresh identity next time. Nobody loses access.

### A Google account with no verified email

Two different states, and they fail differently.

**No email at all.** GoTrue's external-provider handling has `email_optional = false` by default
(`supabase/config.toml`, the `[auth.external.*]` template). Sign-in is refused. The reader is
returned to CommonSwarm with an error in the URL. This is correct: CommonSwarm keys identity on
email, so an account without one has nothing to key.

**An email Google reports as unverified.** Google returns `email_verified: false` for some
Workspace-domain accounts. The user is signed in, but the identity does **not** link to any
existing account. They land in a fresh, empty account.

We do not try to detect or repair this. The recovery is: sign out, sign in with the door you
used the first time. Support's diagnostic is two accounts sharing one email in
`auth.identities` with `identity_data->>'email_verified' = 'false'` on the Google row.

**This is the single claim in this document that rests on reading Supabase's documentation
rather than on observed behaviour** — see "Not established" below.

### Sign-out

Unchanged, and deliberately so. `signOut()` calls `supabase.auth.signOut()` exactly as it does
for GitHub and email users. Google adds no second session to end.

Copy rules that follow, and that a reviewer should hold the line on:

- Signing out of CommonSwarm does **not** sign the reader out of Google, and must never say or
  imply it does.
- It does **not** revoke the Google grant. Removing that is done at
  `https://myaccount.google.com/permissions`, by the user, not by us.
- AGENTS.md records a sign-out claim that said it ended *every session* while the endpoint
  could not revoke issued access JWTs, with a green test defending the false sentence. Do not
  add a Google clause to that family.

### Invitations and joining

**No change is required, and that is a result rather than an omission.** The invite rail keeps
the invitation in `localStorage` under a `resume` id and asks the provider to return to
`<origin>/invite?resume=<id>` (`site/src/components/invite/InviteOnramp.astro`). Google gets the
identical return URL that GitHub gets, so:

- The saved invitation survives the round trip the same way.
- **The Supabase redirect allow-list needs no new entry.** The allow-list matches the
  `redirect_to` value, and the value is byte-identical to the one GitHub already uses. A new
  provider does not add a new return URL.
- `acceptWorkspaceInvitation` takes a session, not an identity, so it cannot tell which button
  produced it.

The one invite-page sentence that named a provider — the email rate-limit fallback, previously
the literal *"Email delivery is busy. Sign in with GitHub, or try again later."* — is now built
from the buttons that are on the page. With the flag off it reads exactly as before; with the
flag on it reads "Sign in with GitHub or Google". No third list exists to drift.

---

## How it is built

### One list, and the enforcement reads it

`site/src/lib/auth-providers.ts` exports `AUTH_PROVIDERS`. It carries the GoTrue `provider`
string, the whole button label, and the bare provider name for prose.

- **Enforcement** — `signInWithProvider` in `site/src/lib/commonswarm.ts` resolves the id
  through `authProvider()` and throws `UnknownAuthProvider` before any request. It is the only
  `signInWithOAuth` call in the codebase, and the provider it passes is `entry.id`, never a
  literal.
- **Buttons** — `site/src/components/auth/ProviderButtons.astro` renders one button per enabled
  provider, `data-signin-provider="<id>"`, label straight from the constant.
- **Prose** — `InviteOnramp.astro` reads the provider names off the rendered buttons and joins
  them with `listSentence()`. Deriving the sentence from the buttons rather than from a second
  import makes them the same set by construction; there is no third place to drift.

This shape is not decoration. AGENTS.md records four releases in a row (v0.1.48-v0.1.50) where a
user-facing enumeration drifted from the enforcement **after two review arms passed**, because
reading such a sentence means re-deriving the enforcement by hand. The tests do that
re-derivation mechanically, against the built HTML rather than the template.

### The flag

`PUBLIC_SWARM_AUTH_PROVIDERS`, a comma-separated list of ids. Unset means `github`, which is the
measured live state, so a build with no configuration cannot offer a door that is shut. An
unknown id is dropped; a value with no known id falls back to the default, because an operator
typo must not blank the sign-in page.

It is read **at build time**. `astro.config.mjs` sets `output: "static"`, so flipping it is: set
the variable, rebuild, deploy. A runtime flag was considered — the page could ask
`/auth/v1/settings` on load, which is the honest source of truth and would need no rebuild — and
rejected: it puts a blocking network request and a new failure mode on the sign-in path to save
a deploy the operator is already doing.

### Flip order, and why it is not cosmetic

**Supabase dashboard first, build flag second.**

`signInWithOAuth` builds the authorize URL in the browser and navigates to it. It asks GoTrue
nothing first. So a button for a provider that is off in the dashboard produces **no client-side
error at all** — the reader is navigated to the API host and shown raw JSON:

```
{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}
```

No `catch` block can improve that page. The order is the control.

---

## What this does NOT do

1. **No Google in the `cswarm` CLI.** `src/cloud/auth.ts` still sets `provider=github`. Adding
   Google there is a separate decision about how a terminal offers a choice, and the flag that
   gates this lives in the site build, which the CLI does not have.
2. **No Google One Tap and no `signInWithIdToken`.** That is a different OAuth client type with
   its own nonce handling.
3. **No manual identity linking and no account-merge screen.** Reasons above.
4. **No surface that reveals whether an email already has an account.**
5. **No edit to `site/src/components/app/LiveDashboard.astro`.** Another lane owns that file
   this sprint, so `/app` still shows the GitHub button only. The change is one import and one
   element swap; the patch is written out in the lane report.
6. **No `[auth.external.google]` block in `supabase/config.toml`.** It would need real
   credentials to be worth anything, and the file carries an *enumerated* note that no external
   provider block exists — adding a dead block would make that note false to save nothing.
7. **No Google Workspace domain restriction (`hd`).** CommonSwarm is an open free tier.
8. **Nothing is enabled in production.** No write of any kind was made against
   `ukezjcnxjvkpkeezxaew`.

---

## Not established

- **No real Google round trip was performed.** It needs a registered OAuth client, which is the
  operator checklist below. Every claim about what Google returns, what GoTrue does with it, and
  whether an identity links is therefore **read from Supabase's documentation and from GoTrue's
  own responses, not observed end to end.** What *was* observed: the enabled-provider set, the
  literal callback URI, and the disabled-provider error, all from the live API.
- **Automatic linking has not been exercised.** The ruling "one account per verified email"
  states the behaviour Supabase documents. The first Google sign-in on an address that already
  has a GitHub account is the test, and it must be run by hand as step 8 of the checklist.
- **The unverified-email path has not been exercised.** Producing a Google account whose
  `email_verified` is false needs a Workspace domain we do not have.
- **The Supabase redirect allow-list was not read.** The argument that it needs no new entry is
  structural — the `redirect_to` value is unchanged — not a reading of the dashboard.
- **Local Supabase cannot exercise any of this.** `supabase/config.toml` has no external
  provider block and adding one needs real credentials.

---

## Operator checklist

Only a human can do this part. Steps 1-6 are safe at any time and change nothing a visitor sees:
until step 7, the button does not exist in any deployed build.

### Google Cloud Console

1. **Pick or create the project.** <https://console.cloud.google.com/projectselector2/home/dashboard>
   — one Google Cloud project holds the OAuth client. Note its name; every link below is scoped
   to whichever project is selected in the console header.

2. **Configure the consent screen (branding).**
   <https://console.cloud.google.com/auth/branding>
   - App name: `CommonSwarm`
   - User support email: `tom@chartingalpha.com`
   - App home page: `https://commonswarm.com`
   - Privacy policy: `https://commonswarm.com/privacy`
   - Terms of service: `https://commonswarm.com/terms`
   - **Authorized domains:** add `commonswarm.com`. This one entry covers both the site and the
     API host, because `api.commonswarm.com` is a subdomain of it.

3. **Set the audience.** <https://console.cloud.google.com/auth/audience>
   - User type: **External**.
   - Publishing status: **Publish app** (that is, "In production"). While it says *Testing*,
     only email addresses you list as test users can sign in, and everyone else sees an
     unverified-app warning. Publishing with only the scopes in step 4 does **not** put the app
     into Google's verification review, because none of them are sensitive.

4. **Confirm the scopes.** <https://console.cloud.google.com/auth/scopes> — exactly these three,
   which are the ones Supabase requests:
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`

   Add nothing else. Any extra scope can pull the app into verification review.

5. **Create the OAuth client.** <https://console.cloud.google.com/auth/clients> → **Create
   client**.
   - **Application type: `Web application`.** Not "Desktop app", not "Android/iOS" — the flow
     is a server-side redirect through Supabase.
   - Name: `CommonSwarm web`
   - **Authorized JavaScript origins** — one entry:

     ```
     https://commonswarm.com
     ```

     The app is served from `https://commonswarm.com/app`, so the origin is the bare host. This
     field is not what makes the flow work (the redirect URI is); the Supabase guide instructs
     adding it, it costs nothing, and it is required if Google One Tap is ever added.

   - **Authorized redirect URIs** — one entry, exactly:

     ```
     https://api.commonswarm.com/auth/v1/callback
     ```

     **How that URI was derived, since it must not be guessed.** On 2026-09-04 the live GoTrue
     was asked for a real GitHub authorization and its own 302 was read:

     ```sh
     curl -s -i "https://api.commonswarm.com/auth/v1/authorize?provider=github" | grep -i '^location:'
     # → https://github.com/login/oauth/authorize?client_id=...
     #     &redirect_uri=https%3A%2F%2Fapi.commonswarm.com%2Fauth%2Fv1%2Fcallback&...
     ```

     URL-decoded, `redirect_uri` is `https://api.commonswarm.com/auth/v1/callback`. That is the
     value GoTrue hands the provider, so it is the value Google must accept.

     **Do not add `https://ukezjcnxjvkpkeezxaew.supabase.co/auth/v1/callback`.** The same probe
     run against the `supabase.co` host returns the **`api.commonswarm.com`** callback too, so
     the `supabase.co` form is never sent to Google. It would also force `supabase.co` into the
     authorized-domain list in step 2, which is a domain we cannot verify.

   - Press **Create** and copy the **Client ID** and **Client secret** before closing the
     dialog. The secret is shown once.

### Supabase dashboard

6. **Enable the provider.**
   <https://supabase.com/dashboard/project/ukezjcnxjvkpkeezxaew/auth/providers?provider=Google>
   - Toggle **Enable Sign in with Google** on.
   - Paste the **Client ID** into *Client IDs*.
   - Paste the **Client secret** into *Client Secret (for OAuth)*.
   - Leave *Skip nonce check* **off**. It is only for native One Tap, which we do not use.
   - Save.
   - **Confirm it took, from outside the dashboard:**

     ```sh
     curl -s https://api.commonswarm.com/auth/v1/settings \
       -H "apikey: <the anon key>" | grep -o '"google":[a-z]*'
     # want: "google":true      (it reads "google":false today)
     ```

     Reading `"github":true` in the same output is the positive control that the probe works.

   ⚠️ `ukezjcnxjvkpkeezxaew` **is production.** There is no separate CommonSwarm production
   project. This step is live for every user the moment it is saved — but no button points at
   it until step 7, which is the whole point of the order.

### The site

7. **Flip the flag and deploy.** In `site/.env`, beside the two `PUBLIC_SUPABASE_*` values that
   must already be there:

   ```
   PUBLIC_SWARM_AUTH_PROVIDERS=github,google
   ```

   Then the standard deploy from AGENTS.md:

   ```sh
   cd site && rm -rf dist && npm run build
   cp -r .vercel dist/.vercel
   vercel deploy dist --prod --yes --scope ridgedotio
   ```

   Verify the live page, with a positive control on the same fetch:

   ```sh
   curl -s https://commonswarm.com/invite | grep -c 'data-signin-provider="google"'   # 1
   curl -s https://commonswarm.com/invite | grep -c 'data-signin-provider="github"'   # 1 (control)
   ```

   To take it back down: remove the line, rebuild, redeploy. The button disappears and the
   Supabase provider can stay on — an enabled provider with no button is invisible.

### The part no test covers

8. **Sign in with Google once, in a real browser, on an address that already has a CommonSwarm
   account through GitHub.** Then check that the workspaces from the GitHub account are there.
   This is the account-linking ruling, and it is the one claim in this document that no
   automated control can reach — the section above says so. If the workspaces are missing, the
   identity did not link: stop, and read the two-accounts-one-email diagnostic in "A Google
   account with no verified email".
