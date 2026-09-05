# Google sign-in

Status: **written and dark.** A build renders the providers that are BOTH named in
`site/src/lib/auth-providers.ts` and reported as enabled by the deployment it points at.
Google is **off** in the Supabase dashboard, so no build can show a Google button today. Turning it on is the operator checklist at the end: one dashboard change,
then a rebuild and deploy. There is no second switch in the repo.

**Retired during review (2026-09-04), kept because the first commit message names it.** An
earlier draft chose the rendered set from a `PUBLIC_SWARM_AUTH_PROVIDERS` build variable, and
this document said "the button does not render in any build that does not set
`PUBLIC_SWARM_AUTH_PROVIDERS`". That variable no longer exists and nothing reads it. It was a
hand-set flag: it let a build publish a Google button while the dashboard still had Google off,
and the reader who pressed that button got raw JSON. The rendered set is now read from GoTrue
itself, so that state is unreachable.

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
| Enabled providers: `github: true`, `google: false`, `email: true`; every other flag `false` | `GET https://api.commonswarm.com/auth/v1/settings` — GoTrue enumerates every flag it knows, 26 keys under `external` on 2026-09-04, so this is a count, not a grep |
| GoTrue's callback is `https://api.commonswarm.com/auth/v1/callback` | The `redirect_uri` inside the 302 from `GET /auth/v1/authorize?provider=github` |
| The `*.supabase.co` host emits the **same** custom-domain callback | Same probe against `https://ukezjcnxjvkpkeezxaew.supabase.co` — the `redirect_uri` is still `api.commonswarm.com` |
| A disabled provider returns `400 {"msg":"Unsupported provider: provider is not enabled"}` | `GET /auth/v1/authorize?provider=google` today |

---

## The flows

### A new user

1. On `/invite`, presses **Sign in with Google**. Not on the SIGNED-OUT panel of `/app`: that
   one control is still hand-written, so a Google door reaches it only when the lane that owns
   `LiveDashboard.astro` swaps in `ProviderButtons`. Step 6 of the checklist says so too.
   `/app`'s re-authentication buttons are a separate control and are already generated
   (2026-09-05), so they follow the deployment with no further change.
2. `signInWithProvider("google", <return URL>)` navigates the browser to
   `https://api.commonswarm.com/auth/v1/authorize?provider=google&redirect_to=<return URL>`.
3. GoTrue redirects to Google. Google asks for consent to share name, email, and profile
   picture. Nothing else is requested.
4. Google returns to `https://api.commonswarm.com/auth/v1/callback`. GoTrue creates the user
   and redirects to the return URL with the session in the URL fragment.
5. `detectSessionInUrl: true` on the browser client picks the session up, and the page boots
   signed in. From here Google users are indistinguishable from GitHub users.

The return URL is `<origin>/invite?resume=<id>` from an invitation, and would be
`<origin>/app` from the workspace when that page offers the door. Both are the URLs GitHub
sign-in already uses, unchanged.

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
from the buttons that are on the page. With Google off it reads exactly as before; with Google
on it reads "Sign in with GitHub or Google". No third list exists to drift.

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

### Where the rendered set comes from

**The deployment's own answer, read at build time.** `ProviderButtons.astro` runs in Node
during `astro build` (`astro.config.mjs` sets `output: "static"`), asks the very GoTrue the
buttons will point at:

```
GET ${PUBLIC_SUPABASE_URL}/auth/v1/settings     apikey: ${PUBLIC_SUPABASE_ANON_KEY}
→ 200 {"external":{"github":true,"google":false,"email":true, … }, … }
```

and renders the providers whose flag is exactly `true`. Nothing in the repo selects providers.
There is no build variable, so there is no way to publish a button for a provider the dashboard
still has off.

The rendered set is the **intersection** of two lists, not GoTrue's list: `AUTH_PROVIDERS` is
what this code can render, and the settings body says which of those the deployment enabled.
Enabling GitLab in the dashboard puts no GitLab button on the site — it would need a label and
a name here first. The direction that matters is the other one, and it is closed: nothing the
deployment reports as off can get a button. A body that does not answer about **every** id in
`AUTH_PROVIDERS`, with a real boolean, is not an answer about this site and fails the build.

Three states, and what each one does:

| At build time | What ships |
|---|---|
| Neither `PUBLIC_SUPABASE_` variable is set | No OAuth buttons. `astro.config.mjs` requires that build to succeed: it is the honest "not pointed at a backend" build, and there is nothing to sign in to. |
| Exactly one of them is set | **The build fails.** Half a backend is a typo, not a state. Treating it like the row above would publish an email-only sign-in page that looks finished. |
| The settings read succeeds | The providers named here that GoTrue reported as enabled. GoTrue reports 26 flags, including `email` and 23 providers this code has no label for; none of those become buttons. |
| The settings read fails — no network, HTTP error, a body that is not JSON, or a JSON body whose `external` map carries no provider flag | **The build fails**, with the endpoint, the reason, and the curl to run (`AuthSettingsUnreadable`). |

Every row was measured on 2026-09-04 by building this tree against a fake GoTrue on
`127.0.0.1`, and against no `site/.env` at all. The zero-provider and no-backend rows are
**measured, not unit-tested**: the suite pins the source shape, and the built HTML for those
two states was produced by hand, because a test cannot run `astro build` against a fake host.

Two things this table does **not** cover, both measured:

- **A bundle repointed after the build.** `deployment()` in `commonswarm.ts` falls back to the
  `commonswarm:url` and `commonswarm:anon-key` meta tags, which `WEB-ONBOARDING.md` documents as
  a way to aim a built site at a backend without rebuilding. The buttons were decided at build
  time and do not follow. Such a site gets email sign-in and no OAuth doors. It fails closed,
  and a rebuild fixes it.
- **`astro dev` needs the deployment too.** The frontmatter runs on every request in dev, so a
  developer with `site/.env` filled in and no network gets an error page instead of the invite
  page. Working offline means emptying both `PUBLIC_SUPABASE_` values, which is the
  no-backend build in the table above: the whole site renders, with no OAuth buttons.
- **Nothing in CI builds this site.** `.github/workflows/` holds `commit-identity.yml` and
  nothing else, and the deploy in AGENTS.md uploads a `dist/` built on the operator's machine
  (`vercel deploy dist`). So "the build fails when the backend is unreachable" costs a person a
  clear error and a retry; it does not break a pipeline, because there is no pipeline.

The third row is the deliberate one. The alternative is to guess a provider list and publish
it, which is the failure this whole design exists to prevent. A sign-in page whose doors cannot
be confirmed does not get published, and the operator sees why on the same line.

A **runtime** read was considered — the page asks `/auth/v1/settings` on load, so a dashboard
toggle needs no deploy — and rejected: it puts a blocking network request and a new failure
mode on the sign-in path, to save a deploy the operator is already doing.

### Why the order still matters

**Supabase dashboard first, then rebuild and deploy.** This is now enforced by the code rather
than by the operator remembering it, but the reason is worth keeping.

`signInWithOAuth` builds the authorize URL in the browser and navigates to it. It asks GoTrue
nothing first. So a button for a provider that is off in the dashboard produces **no client-side
error at all** — the reader is navigated to the API host and shown raw JSON:

```
{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}
```

No `catch` block can improve that page. Because the button list is read from the dashboard's own
answer, a build cannot produce that page: press-and-get-JSON needs a button for a disabled
provider, and no such button can be built. Turning Google **off** again is the same one toggle;
the button disappears from the next build.

---

## What this does NOT do

1. **No Google in the `cswarm` CLI.** `src/cloud/auth.ts` still sets `provider=github`. Adding
   Google there is a separate decision about how a terminal offers a choice, and it would need
   its own reading of `/auth/v1/settings` — the CLI does not share the site's build step.
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
  has a GitHub account is the test, and it must be run by hand as step 9 of the checklist.
- **The unverified-email path has not been exercised.** Producing a Google account whose
  `email_verified` is false needs a Workspace domain we do not have.
- **The Supabase redirect allow-list was not read.** The argument that it needs no new entry is
  structural — the `redirect_to` value is unchanged — not a reading of the dashboard.
- **Local Supabase cannot exercise any of this.** `supabase/config.toml` has no external
  provider block and adding one needs real credentials.

---

## Operator checklist

Only a human can do this part.

**Read this before starting.** Steps 1-6 change nothing anywhere, and step 6 is the slow one:
it is the legal and product copy, including a privacy policy that has to name a new processor.
Do it BEFORE step 7, not after.

Step 7 is the live one. The moment it saves,
`https://api.commonswarm.com/auth/v1/authorize?provider=google` starts working for anyone who
types that URL, and the Google button is **armed for the next site deploy by anyone** — several
lanes deploy this site in a sprint, and any one of them would publish it. The deployed site does
not change on its own, because it was built before the toggle, but the next build is not yours
to schedule. So do steps 7 and 8 in one sitting, or not yet.

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

   **Google will not accept an authorized domain it cannot see you own.** The domain has to be
   verified in Google Search Console first, under the same Google account, at
   <https://search.google.com/search-console> — add `commonswarm.com` as a Domain property and
   complete the DNS TXT record it asks for. Cloudflare holds the DNS for this domain. If step 2
   rejects the domain with no explanation, this is why.

3. **Set the audience.** <https://console.cloud.google.com/auth/audience>
   - User type: **External**.
   - Publishing status: **Publish app** (that is, "In production"). Publish it because this is
     a public product, not because *Testing* would block sign-in: with only the basic identity
     scopes in step 4, Google lets any account authorize a testing app and shows it a "this app
     is being tested" screen. The test-user allowlist and the unverified-app screen bite on
     sensitive scopes, which this app does not ask for. Publishing with these scopes does
     **not** open a sensitive-scope verification review.
   - It can still queue for **brand verification** — Google checking the name, logo, and links
     from step 2. That is separate, it is not required for sign-in to work, and Google's own
     guidance says it can take several days. Do not read "no scope review" as "Google shows the
     CommonSwarm name immediately".

4. **Confirm the scopes.** <https://console.cloud.google.com/auth/scopes> — exactly these three:
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`

   These are the Cloud Console entries for the identity Supabase asks for. GoTrue itself sends
   `email` and `profile` on the authorize URL, so listing them here permits what it sends; it
   does not change it. Add nothing else. Any extra scope can pull the app into verification
   review.

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

     **And do not add `http://localhost:4321`, or any localhost entry.** Google never sees a
     localhost address here: GoTrue hands the provider its own callback, which is always
     `api.commonswarm.com`, whatever machine started the sign-in. What a local `astro dev`
     sign-in needs is the **Supabase** side, under Authentication → URL Configuration →
     Redirect URLs, because that is the list `redirect_to` is checked against. That is a
     Supabase setting, not a Google one, and this checklist does not change it.

   - Press **Create** and copy the **Client ID** and **Client secret** before closing the
     dialog. The secret is shown once.

### The copy that says GitHub

6. **Rewrite every sentence that names the sign-in doors. Write it now, publish it in step 8.**
    These sentences are hand-written and true only while GitHub is the only door.

    **Expect the suite to be red between this step and step 7, and do not "fix" it.** The
    control (`CONTROL: sign-in copy names the providers this build renders, or none`) requires
    the copy and the rendered buttons to name the same set. Rewriting the copy first makes them
    disagree on purpose: the copy says GitHub and Google, the build still renders GitHub,
    because the dashboard toggle is step 7. That is the handshake, not a defect. After step 7,
    `npm --prefix site test` going green is the proof that the doors and the words agree — and
    step 8 runs it before deploying, so a skipped rewrite cannot reach the site.

    Commit this work; do not deploy it on its own. The test names the sentences, it does not
    write them.

    The list below is a snapshot; **the failing test is the authority**, because it reads the
    built pages and prints every sentence with its file. First measured on 2026-09-04 by
    building the site against a GoTrue that reports `google: true`: eight sentences on three
    pages.

    **Corrected 2026-09-05.** `/app` holds ONE of these now, not two. Its re-authentication
    control was a hand-written "Sign in again with GitHub" button; it is generated by
    `ProviderButtons` from that date, so the sweep strips it with every other generated button
    and that sentence left the list. The three pages are unchanged, and the unique sentences
    are now one on `/app`, four on `/privacy` and two on `/terms` — seven, one fewer than the
    2026-09-04 eight. NOT re-derived under the original condition: that total.
    The sweep's own extraction over the 2026-09-05 build prints ten lines, three of them
    `/privacy`'s single meta description read once per description tag, so eight and ten are
    not counting the same thing. Take the count from the failing test, never from this file.

    | Page | Sentences |
    |---|---|
    | `/app` (`components/app/LiveDashboard.astro`) | ONE sentence, and it is a hand-written BUTTON label: "Sign in with GitHub" on the signed-out panel, carrying `data-signin-github`. Do not rewrite it to name both providers: that button only does GitHub. Swap the component (`<ProviderButtons buttonClass=… listClass=… />` plus one `[data-signin-provider]` handler, replacing `[data-signin-github]`), which makes the label generated and the page honest at once. |
    | `/privacy` (`pages/privacy.astro`) | four, including "You sign in with GitHub, you join a workspace…", "Sign-in is GitHub OAuth.", and "We get your user id, email address, and name from GitHub when you sign in." |
    | `/terms` (`pages/terms.astro`) | two, including "You sign in with GitHub." and the sentence naming GitHub among services we do not control |

    **Three more the sweep cannot reach.** It reads sentences that both mention signing in and
    name a provider, out of the rendered HTML, so these stay green and are yours to fix by hand:

    - `LiveDashboard.astro` — "Use GitHub, or try email again in a little while.", built in
      JavaScript rather than rendered into the page.
    - `privacy.astro` — "Three, and only three, are in the path:" and the processor list under
      it. That COUNT sentence names no provider, so nothing trips on it, and adding Google as
      a sign-in door adds a fourth party to the path and makes it false. The bullet under it,
      "GitHub, Inc. — sign-in.", does name one and the sweep will print it; the count above it
      is yours to notice. (The page's meta description, "Sign-in comes from GitHub", IS caught:
      the sweep reads `description`, `og:description` and `twitter:description` as well as the
      page body.)
    - `acceptable-use.astro` — "additional GitHub accounts", which names a provider but says
      nothing about signing in.

    `components/landing/Hero.astro` and `components/landing/Invite.astro` used to say "email
    or GitHub" as well. **Both were deleted on 2026-09-05** as dead code: nothing imported
    either one, the landing page renders `ConsumerHero.astro`, and neither file's markup
    reached the build. There is nothing left to rewrite there and nothing to spend the legal
    review on. The wording is preserved here because earlier copies of this checklist listed
    them as live surfaces.

    The privacy and terms entries are **legal copy about a data processor**, not product voice.
    Adding Google as a sign-in door adds Google as a processor of the reader's identity, and
    those two pages have to say so. That is the slowest item on this checklist, which is why it
    is step 6 and not step 8.

    `/app` (`LiveDashboard.astro`) still hand-writes its SIGNED-OUT button, so that panel will
    offer GitHub only while `/invite` offers both. Swapping it is one import and one element;
    it was left to the lane that owns that file. Its re-authentication buttons are a second,
    separate control and were swapped on 2026-09-05: they render `ProviderButtons`, bind one
    `[data-signin-provider]` handler, and need no copy work here.

    **What the failing test will and will not tell you.** The sweep in
    `components/auth/provider-buttons.observer.test.ts` catches:

    - a data-signin* attribute on any tag
    - a provider id (github or google) as a hyphen segment of any data-* attribute NAME, in any case
    - either of those two names built with setAttribute
    - a data-signin* write through dataset
    - any .signInWithOAuth( outside lib/commonswarm.ts
    - any string literal handed to signInWithProvider(
    - signInWithGitHub( anywhere but components/app/LiveDashboard.astro, or more than 1 call(s) there
    - a rendered button whose label is not exactly one of: "Sign in with GitHub", "Sign in with Google"

    It does not catch a provider hidden in an attribute VALUE under an unrelated name, and that is a bound, not a gap this test closes.

    Every line above is generated in the test from the patterns and call names its own
    assertions run, and a control there requires this file to carry each one word for word.
    A branch that catches the value shape was written during review and reverted: it caught one
    more spelling and invited the next, which is what the bound settles.

    There were two controls on that page, so there are two swaps, and one of them is done.
    `UNGENERATED_SIGNIN_SURFACES` in `components/auth/provider-buttons.observer.test.ts`
    counts the hand-written ones in that file and allows exactly one; a second control counts
    them again on the BUILT `/app` page; a third counts the OAuth call sites, which is what a
    button that types a provider into `signInWithProvider` would have to pass. A button that
    hides the provider in an attribute value and reads it back at runtime passes all three;
    that is the stated bound above.

### Supabase dashboard

7. **Enable the provider.**
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
   project. This step is live the moment it is saved: the Auth API accepts `?provider=google`
   from anyone who types it, and the next site build by anyone renders the button. Step 6 is
   above this one for that reason.

### The site

8. **Rebuild, TEST, and deploy.** Nothing to edit. `site/.env` needs only the two
   `PUBLIC_SUPABASE_*` values that must already be there; the build reads the button list from
   step 7's toggle.

   ```sh
   cd site && rm -rf dist && npm run build
   npm test                     # MUST be green: this is where step 6 and step 7 shake hands
   cp -r .vercel dist/.vercel
   vercel deploy dist --prod --yes --scope ridgedotio
   ```

   The test line is not optional. Without it, an operator who did steps 1-5 and 7 can publish a
   Google button while the privacy policy still says sign-in comes from GitHub. With it, that
   build stops and names every sentence to fix.

   Check the built output before deploying, with a positive control on the same file:

   ```sh
   grep -c 'data-signin-provider="google"' dist/invite/index.html   # 1
   grep -c 'data-signin-provider="github"' dist/invite/index.html   # 1 (control)
   ```

   A `0` for Google means step 7 did not take: the build asked GoTrue and GoTrue said no. Rerun
   the `curl` in step 7 and read `"google"` in its answer.

   If the build stops with `AuthSettingsUnreadable`, it could not reach the deployment at all.
   The message names the endpoint it tried and the reason. Fix that first; do not deploy the
   previous `dist/`, which was built against a different answer.

   Then verify the live page, with a positive control on the same fetch:

   ```sh
   curl -s https://commonswarm.com/invite | grep -c 'data-signin-provider="google"'   # 1
   curl -s https://commonswarm.com/invite | grep -c 'data-signin-provider="github"'   # 1 (control)
   ```

   **To take it back down:** turn the Supabase toggle off, then rebuild and deploy. The button
   disappears because the build asks again. Turning the toggle off alone does not remove the
   button from the site already deployed, and that button would then show a reader raw JSON, so
   the redeploy is part of the change, not a follow-up.

   Taking it down is not free once people have used it. Anyone whose **only** identity is
   Google loses their way in: the account still exists, but the door is gone and the email link
   is the only route back if the address matches. Say that to those users before removing it,
   not after.

### The part no test covers

9. **Sign in with Google once, in a real browser, on an address that already has a CommonSwarm
   account through GitHub.** Then check that the workspaces from the GitHub account are there.
   This is the account-linking ruling, and it is the one claim in this document that no
   automated control can reach — the section above says so. If the workspaces are missing, the
   identity did not link: stop, and read the two-accounts-one-email diagnostic in "A Google
   account with no verified email".
