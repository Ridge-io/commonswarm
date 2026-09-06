# D-036 review arm — lane/google-copy, SHA 22048d3245f50d5f39b195ceb4b87926991b68b1

You are reviewing a CommonSwarm site lane. The working directory you are in IS the checkout at
that SHA. Read the code, not the diff's prose.

Repo root: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-google-copy`
Diff: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-google-copy/arms-22048d3245f50d5f39b195ceb4b87926991b68b1/DIFF.patch`
Base (merge-base with origin/main): `132ac17`

**Before any finding, quote back the first `diff --git` line of DIFF.patch.** A review that does
not is not a review of this diff.

## Background you need

CommonSwarm's site renders its OAuth sign-in buttons from one array,
`site/src/lib/auth-providers.ts`, intersected with the providers the deployment's own GoTrue
reports as enabled at BUILD time (`/auth/v1/settings`). Today production reports
`github: true, google: false`. Google is landed dark and the operator will enable it.

The PREVIOUS SHA of this lane was FAILED by a Grok arm on two findings, both real:

1. No fixture rebuilt the legal pages with `google: true`, so the "passes in both states" claim
   was never measured. The copy sweep DID go red in the enabled state, on `Google LLC — sign-in.`
   at `privacy.astro:189`.
2. `/app` still said "Use GitHub" on its email rate-limit line
   (`LiveDashboard.astro`, in `readableError`).

That arm's output is archived at
`docs/evidence/2026-09-06-google-copy/arms/18ef9ca-superseded/grok/ARM.txt`. Read it. Your job is
partly to check whether this SHA actually fixes what it found, and partly to attack the fixes.

## What this lane claims

1. `/app`'s signed-out panel renders `<ProviderButtons>` instead of a hand-written
   `data-signin-github` button, so its doors come from the array and the deployment. Its
   observers were updated honestly rather than deleted, and a new one reads the BUILT page.
2. `/app`'s email rate-limit sentence is built from the page's own rendered buttons.
3. Every sentence on `/privacy`, `/terms` and `/acceptable-use` that names a sign-in door is
   generated from `AUTH_PROVIDERS`, including the processor list, which names `Google LLC` in
   the same shape as `GitHub, Inc.`
4. The copy sweep now runs against FOUR states: three real `astro build`s against a GoTrue
   fixture (`none`, `github`, `github+google`, generated from the array) plus the real
   `site/dist`. All four are green, and a sentence naming one provider only in the enabled state
   goes red.
5. The sentence splitter no longer cuts after a company abbreviation such as `Inc.`, which is
   what let the old GitHub processor bullet escape the sweep by accident.
6. Eleven mutations, each breaking one named control, all discriminate
   (`docs/evidence/2026-09-06-google-copy/mutate.mjs`).

## Checks to attack — try to REFUTE each, and say how you tried

1. **The dual-state claim.** Does `site/scripts/provider-fixtures.ts` really reach the code path
   it claims? Point `PUBLIC_SUPABASE_URL` yourself, or read the build output, and decide whether
   a fixture could be the same build three times while the controls stayed green. Is the
   positive control ("the provider fixtures are the states they claim to be") strong enough to
   catch that? Could `astro build --outDir` write somewhere the sweep does not read?

2. **The sweep in the enabled state.** Rebuild the fixtures and re-derive the offender list
   yourself. Is there ANY sentence on the built `github+google` pages that names one provider
   and mentions signing in? Check `/privacy`, `/terms`, `/acceptable-use`, `/app`, `/invite`, and
   every meta description. Then check the `none` state: is the copy TRUE there, not merely
   un-flagged?

3. **The abbreviation guard.** `sentenceEnd()` in
   `site/src/components/auth/provider-buttons.observer.test.ts`. It was first written without the
   period in its lookbehind and was inert. Is the current one correct for every abbreviation the
   array can produce? Does widening the unit boundary MERGE two claims that used to be inspected
   separately, and could that hide an offender that the old boundary caught? That is the risk
   this change takes; say whether it is paid for.

4. **The source sweep's bound.** "no sign-in surface types a provider name into its markup or its
   script" reads `.astro` files with comments stripped, and states that it does not read
   `src/lib/*.ts`. Is the comment stripper safe (does it eat real code, or miss a comment)? Is
   the surface derivation (`/ProviderButtons|auth-providers/`) able to miss a page that offers
   sign-in? Name a concrete sentence that could ship past it.

5. **The legal copy, as legal text.** `/privacy` now has ONE generated processor bullet naming
   every sign-in provider instead of one bullet per provider. Is that still a truthful and
   sufficient statement about a data processor? Does it still say what each provider receives?
   Does `signInDoors` ("GitHub or a link we email you") state something false about how a reader
   can sign in, on the hosted app OR through the CLI? Read `src/cloud/auth.ts` and the /app and
   /invite pages before answering.

6. **The signed-out panel swap.** Compare it line by line with the re-authentication swap in
   merge `03960bc`, which is the model. Is the handler bound to the right buttons? Is any
   behaviour lost with the GitHub icon SVG (accessibility, focus, disabled state)? Does
   `.dashboard__providers` render correctly with two buttons, and with zero? Is the `before`
   slot used the same way `InviteOnramp.astro` uses it?

7. **The mutations.** Read `docs/evidence/2026-09-06-google-copy/mutate.mjs`. Is any mutation a
   mutation of the TEST rather than of the thing the test defends, in a way that makes its red
   meaningless? Is any control red for a reason other than the one claimed? Run it if you want;
   it restores every file it touches.

8. **Anything the lane broke in passing.** Stale comments, a claim in a test name that its
   assertion does not make, a doc sentence that is now false, an em-dash in user-facing copy, a
   typed enumeration that should be generated. The lane also edited
   `docs/design/2026-09-04-GOOGLE-SIGNIN.md` with four runbook corrections measured against the
   real Google and Supabase consoles; check those read plainly and preserve the retired wording.

9. **A defect this lane found by reading, not by testing.** The previous draft of the privacy
   policy rendered "You sign in through GitHub, Inc.." and the terms rendered "today,
   GitHub, Inc..", because the generated entity list already ends in a period. Both are fixed
   and a control now reads every built page in every state for doubled punctuation. Attack that
   control: is its pattern right, does it have false positives it silences, and is there another
   shape of generated-punctuation defect it does not see?

10. **Round two.** Both arms PASSED the previous SHA `fa077d3`, and both outputs are in
   `arms-fa077d3e53977081c210a5b0bd9617ae908a28c7/`. Read them. This SHA adds one commit that
   acts on the GAPs the Grok arm listed: the runbook's three claims that /app still hand-writes
   a button, still says "Use GitHub", and still has one allowed hand-written surface; the
   sweep's own header and META_COPY comments; and the dead `signInWithGitHub` wrapper in
   `site/src/lib/commonswarm.ts`, now deleted along with its `GITHUB` id constant. Attack that
   commit specifically: is any retired claim now stated wrongly, does any "Was:" note misquote
   the text it retires, and did deleting the wrapper leave a control describing a function that
   no longer exists in a way that makes the control meaningless rather than a forbid?

11. **Round three, and the two findings that failed round two.** A Gemini arm FAILED
   `c2f01f2` on two DEFECTs; a Grok arm PASSED the same SHA. Both outputs are in
   `arms-c2f01f224f0aae39f518939b4a1596674776c668/`. Both findings were verified and acted on
   in the single commit this SHA adds:

   - `NAMED_PROVIDER_WRAPPER` was the literal `"signInWithGitHub("` while its comment claimed a
     new named per-provider wrapper goes red. It is now `NAMED_PROVIDER_WRAPPERS`, generated
     from AUTH_PROVIDERS. Attack it: does the generated regex still exclude a DEFINITION, does
     the bound-length assertion still measure something, and can a wrapper shape still slip
     past (`signIn_With_Google`, `signInWithGoogleOAuth`, a provider whose `name` has a space)?
   - The door sentences said "You sign in with GitHub or a link we email you" while the policy
     covers the `cswarm` CLI, which sets `provider=github` and has no emailed link. They now
     say "The sign-in page offers ...", plus one sentence about the CLI. Attack that: is the
     new wording TRUE on both surfaces, does the added CLI sentence itself state anything the
     code does not do, and is it a typed claim that will drift?

12. **GOOGLE IS NOW ENABLED IN PRODUCTION.** `api.commonswarm.com/auth/v1/settings` answers
   `google: true`. So `site/dist` in this checkout renders BOTH providers, and the sweep's
   fourth state is a real two-provider build rather than a fixture. Check that yourself. Then
   check the claim recorded at step 7 of the runbook: that the deployed site is an older
   GitHub-only build, so nothing published is inconsistent yet, and that the next deploy must
   carry this copy. Is that claim true right now?

13. **Round four. Do not write to this checkout.** A previous arm reported it could not get a
   clean suite run because a mutation harness was writing the tree underneath it. Nothing is
   writing it now. Read, build into your own temporary directory if you must, and run the test
   suites, but do not run `docs/evidence/2026-09-06-google-copy/mutate.mjs`: it edits source
   files in place.

   The previous round split: a Grok arm PASSED `f11d445` and a Gemini arm FAILED it on three
   points (`arms-f11d4459adb02b905c4d33a0f44ad6a3b2f75023/`). Two were acted on in the single
   commit this SHA adds: the wrapper ban now STATES its shape bound in SWEEP_DOES_NOT_CATCH and
   in the checklist that is pinned to it, every generated wrapper name is asserted to be a real
   identifier, and the doubled-punctuation pattern now catches `. .` as well as `..` (measured:
   zero false hits across all four builds). The third, "the bound-length check is now a
   tautology", was refuted: it still catches a line TYPED into SWEEP_CATCHES beside the
   generated ones, and there is now a mutation that proves it. Attack that refutation: run the
   two new mutations' logic by hand if you want, and say whether the length check measures
   anything a reader should rely on.

## Rules

- Verify at file:line. Do not accept the diff's own commit messages as evidence.
- Distinguish DEFECT (would publish a false statement, lose a control, or break a page) from GAP
  (required and absent) from NIT.
- Do not invent an opposing view the lane did not raise.
- Say which checks you could NOT complete and why.
- **The last line of your output must be exactly `VERDICT: PASS` or `VERDICT: FAIL`.**
