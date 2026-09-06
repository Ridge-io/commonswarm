# D-036 review arm — lane/google-copy, SHA c2f01f224f0aae39f518939b4a1596674776c668

You are reviewing a CommonSwarm site lane. The working directory you are in IS the checkout at
that SHA. Read the code, not the diff's prose.

Repo root: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-google-copy`
Diff: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-google-copy/arms-c2f01f224f0aae39f518939b4a1596674776c668/DIFF.patch`
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

## Rules

- Verify at file:line. Do not accept the diff's own commit messages as evidence.
- Distinguish DEFECT (would publish a false statement, lose a control, or break a page) from GAP
  (required and absent) from NIT.
- Do not invent an opposing view the lane did not raise.
- Say which checks you could NOT complete and why.
- **The last line of your output must be exactly `VERDICT: PASS` or `VERDICT: FAIL`.**
