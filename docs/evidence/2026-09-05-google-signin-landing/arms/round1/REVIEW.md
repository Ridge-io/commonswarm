# Review brief — CommonSwarm lane `lane/google-signin-land` @ 5fefacc7b33d7ca63cb87f558c70a85d395c9f4e

You are one of two independent review arms (D-036). Read `DIFF.patch` in this same directory.
Repo root for reading whole files: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-google-signin-land`

**Before any findings, quote back the first `diff --git` line of DIFF.patch verbatim.** A review
that does not quote it is not counted.

## What the lane claims

CommonSwarm's web app (Astro, `output: "static"`, deployed to commonswarm.com) offers OAuth
sign-in. Before this lane there was one hand-written "Sign in with GitHub" button on the invite
page. The lane adds Google as a second door and, more importantly, makes the set of OAuth
buttons come from ONE place.

1. `site/src/lib/auth-providers.ts` is the single constant. Every surface reads it: the button
   labels, the sentence in `InviteOnramp.astro` that names the providers, and the enforcement
   `signInWithProvider` in `site/src/lib/commonswarm.ts` (the only `signInWithOAuth` call).
2. WHICH providers a build renders is read from the deployment itself: `ProviderButtons.astro`
   runs at build time in Node and does `GET ${PUBLIC_SUPABASE_URL}/auth/v1/settings` with the
   anon key, then renders providers whose flag is exactly `true`. There is NO build flag. The
   second commit in the diff removed an earlier `PUBLIC_SWARM_AUTH_PROVIDERS` variable.
3. If the backend is configured but unreachable, or answers non-200, or answers a body that is
   not a GoTrue settings body, the BUILD FAILS (`AuthSettingsUnreadable`). If no
   `PUBLIC_SUPABASE_*` variables are set at all, the build succeeds and renders no OAuth button.
4. Google is off in the live Supabase project today (`"google":false` measured on
   `https://api.commonswarm.com/auth/v1/settings`), so the built page has GitHub only and the
   word "Google" appears zero times on it. Nothing was written to the Supabase project.
5. `docs/design/2026-09-04-GOOGLE-SIGNIN.md` carries the operator checklist for enabling Google
   in production (Google Cloud Console OAuth client, Supabase dashboard toggle, redeploy).

## Project doctrine you are enforcing (from AGENTS.md)

- **An enumeration inside a user-facing message must be GENERATED, not typed.** If a string
  lists things the code enforces (providers, fields, options), that list must come from the same
  constant the enforcement reads. A typed list is a defect. This failed four times in one
  release cycle AFTER two review arms passed, so attack it directly.
- **Never branch on `error.message`** (D-053). Classify with a named error class or a code.
- **A negative result must reach the path it claims to test.** Ask what a probe would return if
  the feature worked, and whether the control could pass for the wrong reason.
- **Claim controls prove stability, not truth.** A green test can defend a false claim. Check
  each user-readable claim against what the underlying system actually does.
- **Honesty is not sufficient.** When something is still pending, the copy must say what the
  reader does next.
- Product voice is plain and calm. No em-dashes in user-facing strings.

## Checks — work through all eight, and try to REFUTE each claim

1. **Is the provider list truly single-sourced?** Find any place — template, script, test,
   comment, doc, error string — that names a provider or enumerates providers in a way that can
   drift from `AUTH_PROVIDERS`. Include the `docs/design/` file. If you find a typed
   enumeration, say exactly which line.
2. **Does the build-time settings read actually decide the output, or can something else?**
   Look for a way to render a button for a provider GoTrue reports as `false`, or to omit one it
   reports as `true`. Consider Vite/Astro env loading (`site/.env` is read regardless of the
   shell environment), caching, and multiple pages using the component.
3. **`providersFromSettings` and `fetchEnabledProviders` in `auth-providers.ts`.** Attack the
   parsing: arrays, `null`, `"true"` strings, missing keys, a proxied/HTML error page returned
   with status 200, a redirect, a body larger than expected. Is any branch decided on an error
   MESSAGE rather than a type or status? Is the `AbortSignal.timeout` correct and does its
   failure classify correctly?
4. **Failure behaviour.** The lane claims the build fails loudly when the backend is configured
   and unreachable, and succeeds with no buttons when no backend is configured. Read
   `ProviderButtons.astro` and `astro.config.mjs`. Is either claim false? Is failing the build
   the wrong call — could it break a legitimate build (CI, offline, a preview deploy) in a way
   the diff does not acknowledge? Say so if yes.
5. **The controls in `provider-buttons.observer.test.ts`.** For each test ask: could it pass
   while the thing it names is broken? Could it fail for a reason other than the claimed one?
   Does any control scan itself or otherwise match its own text? Is the "no other source
   hand-writes a sign-in button" scan complete — what file types or injection routes does it
   miss? Name any control that is decoration.
6. **The user-facing copy.** `InviteOnramp.astro` builds a sentence from the rendered buttons.
   Check the rate-limit sentence, the per-provider failure sentence, and the `NoDeployment`
   sentence. Is any of them wrong, or wrong in a state the code can actually reach (for example
   zero rendered buttons, one button, the button disabled)? Are there em-dashes in user-facing
   strings?
7. **The operator checklist in `docs/design/2026-09-04-GOOGLE-SIGNIN.md`.** This is what a human
   will follow against a LIVE production project. Verify it against what you know about Supabase
   GoTrue and Google Cloud: the redirect URI, the JavaScript origin, the scopes, the publishing
   status, the order of steps, and the "take it back down" instructions. Name anything missing,
   wrong, or dangerous. Is the claim "steps 1-6 change nothing a visitor sees" true?
8. **Anything that touches production or security.** Does anything write to the Supabase project?
   Is any service-role key, secret, or credential introduced under `site/`? Does the anon key get
   used in a new way? Does `commonswarm:url` metadata change?

## Output

Numbered findings. For each: the file and line, what breaks, and whether it blocks landing.
Say explicitly which claims you tried to refute and could not. Then, as the LAST line, exactly:

`VERDICT: PASS` or `VERDICT: FAIL`
