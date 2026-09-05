# Review brief — lane/site-chips @ 826bce531e576fd98d1df7a2cb54fbd4270f47ad

Repo: CommonSwarm (`cswarm` CLI + Astro marketing/app site + Supabase edge functions).
Base: `origin/main` @ `e3e77223c8dfd697906ba329f18c02ccaca41ec6`. SIX commits: three items and
THREE review rounds. Round 3 split — one arm PASS, one FAIL — and both named the SAME residual:
`<button data-login="github">` wired with `signInWithProvider(button.dataset.login, …)` passed
every control, and the call-site comment claimed a wider bound than its assertions had. The sixth
commit closes that at the markup with a VALUE branch on the source sweep only, and rewrites the
claim. Read that commit message; it states the reasoning and the residual it does not reach.

**Read the diff at the absolute path you were given.** Before any finding, quote back the FIRST
`diff --git` line of that patch verbatim.

Attack the round-4 fix hardest: is the value branch safe on SOURCE given the built page is
excluded from it, does it over- or under-match, and is the rewritten comment now exactly true?
Then re-attack everything else. Say which claims you tried to refute and could not.

## What the lane claims

1. **`/app` had a second hand-written OAuth control that the provider sweep could not see.**
   `site/src/components/app/LiveDashboard.astro` carried
   `<button ... data-member-reauth-github>Sign in again with GitHub</button>` wired straight to
   `signInWithGitHub`. The sweep in `site/src/components/auth/provider-buttons.observer.test.ts`
   (test: "only ProviderButtons renders a sign-in button, apart from named debt") counts
   hand-written controls per file and allows `components/app/LiveDashboard.astro` exactly ONE.
   It read one, not two, because its marker required the provider id IMMEDIATELY after `data-`.
   The lane renders that block with `ProviderButtons` instead, binds one
   `[data-member-reauth] [data-signin-provider]` handler that reads the id off the element and
   calls `signInWithProvider`, widens the sweep's marker so a provider name anywhere inside a
   `data-*` attribute NAME is matched, and adds a control over the BUILT `dist/app/index.html`.
2. **`site/src/components/landing/Hero.astro` and `Invite.astro` were dead** and are deleted.
3. **A comment in `site/src/lib/brain-links.ts` typed the slug separators** instead of naming the
   exported `BRAIN_SLUG_SEPARATORS`; it now names the constant, with a control in
   `site/src/lib/brain-links.test.mjs`.

House rules the lane is held to (from `AGENTS.md`): an enumeration inside a user-facing message
must be GENERATED from the constant the enforcement reads, never typed; a negative result must
reach the path it claims to test; corrections go in the artifact, not in a message; measure the
artifact, not its name.

## Checks — attack these

1. **Did the reauth swap actually remove the typed enumeration, or move it?** Read the new
   markup and the new handler in `LiveDashboard.astro`. Is any provider name, id, or label still
   typed on that path? Does `signInWithProvider` reject an id `AUTH_PROVIDERS` does not name?
   Is the label a reader now sees on `/app` correct copy, given the sentence above the buttons?
2. **Is the widened marker right, and does it over- or under-match?** The new
   `PROVIDER_IN_ATTRIBUTE_NAME` in `provider-buttons.observer.test.ts` is
   `<[a-zA-Z][^>]*\bdata-[a-z-]*(?:github|google)\b`. Construct a hand-written sign-in control
   under `site/src` that this still misses. Construct a benign attribute that it now falsely
   flags. Check the `setAttribute(...)` branch that was also widened.
3. **Is the new built-page control a real control or a green-by-default one?** Test:
   "CONTROL: /app's built page hand-writes exactly one provider control, and it is the
   signed-out one". Would it pass if the feature were absent? What does it do when
   `dist/app/index.html` is missing, stale, or built against a deployment with no providers?
   Does it have a positive control that proves it read the real page?
4. **Does the exception accounting still add up?** `UNGENERATED_SIGNIN_SURFACES` maps
   `components/app/LiveDashboard.astro` to 1 and asserts equality, not just an upper bound.
   After this change is the source count still exactly 1, and is the built count still exactly 1?
   Are those two counting the same thing? Could a THIRD hand-written control now appear
   somewhere neither counts?
5. **Are the doc edits true?** `docs/design/2026-09-04-GOOGLE-SIGNIN.md` step 6, its "flows"
   section and its closing paragraph. Did the lane leave any sentence in that file, or in the
   test comments it touched, still claiming `/app` has two hand-written provider buttons or
   that one component swap fixes both? The "eight sentences" snapshot now carries a correction
   that says the total was NOT re-derived — is that correction accurate and is it honest about
   what it did not establish?
6. **Is the deletion of `Hero.astro` and `Invite.astro` safe?** Find anything under `site/`, the
   repo root, or `site/astro.config.mjs` that still resolves to either file: an import, a dynamic
   import, a glob, a path string in a test, a CSS file that only exists for them, a doc that
   tells a reader to edit them. If either file was reachable, this is a FAIL. Note any comment
   left pointing at a deleted file.
7. **Does the brain-links control discriminate?** `brain-links.test.mjs`, test "the prose that
   describes the slug gate names the constant instead of listing it". Both halves claim to be
   built from `BRAIN_SLUG_SEPARATORS`. Verify that. Name a way the comment could go back to
   typing the set without this test failing, and say whether the test admits that gap.
8. **Anything the lane broke in passing.** `signInWithGitHub` is still used by the signed-out
   button; `signInWithProvider` is newly imported into `LiveDashboard.astro`. Is the reauth
   error path still correct (`[data-member-error]`, re-enabling the button)? Does the reauth
   block behave when the deployment reports ZERO OAuth providers?

## Output

Numbered findings, each with file:line, severity (BLOCKER / MAJOR / MINOR), and the reasoning
that got you there. Say which claims you tried to refute and could not. An empty PASS with no
reasoning is not a review.

The LAST line of your output must be exactly one of:

VERDICT: PASS
VERDICT: FAIL
