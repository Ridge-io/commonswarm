# Review brief — lane/site-chips @ 715fb0548a2718097b63cec313f25ab71158048a — FINAL round

Repo: CommonSwarm (`cswarm` CLI + Astro marketing/app site + Supabase edge functions).
Base: `origin/main` @ `e3e77223c8dfd697906ba329f18c02ccaca41ec6`. Eight commits: three items and
five review rounds.

**Read the diff at the absolute path you were given.** Before any finding, quote back the FIRST
`diff --git` line of that patch verbatim. You may read any file in the checkout that holds it.

## THE QUESTION THIS ROUND ASKS. Read this before anything else.

The sweep in `site/src/components/auth/provider-buttons.observer.test.ts` does NOT try to catch
every possible way to write a sign-in button under site/src. It cannot, and four earlier rounds
of widening bought one shape each and invited the next. The operator ruled that completeness is
the wrong question. The sweep therefore STATES ITS BOUND: `SWEEP_CATCHES` and
`SWEEP_DOES_NOT_CATCH`, carried word for word in step 6 of
`docs/design/2026-09-04-GOOGLE-SIGNIN.md`.

**Do not report that the regex is incomplete. That is the stated bound, and a finding that only
restates it is not a finding.** The previous round's arms found real defects in the bound
CONTROL itself and this commit fixes them: the derivation check was a tautology; the call lines
were interpolated in the sentence while the assertions typed the same names again; three
comments still described branches that had been reverted; the doc carried a paraphrase of the
catch list rather than the list.

A finding IS warranted if: the sweep fails to catch something `SWEEP_CATCHES` claims; a line in
that list is typed rather than derived; the bound sentence misdescribes the code; the file and
the doc disagree; a comment describes code that is not there; or any other claim in the lane is
false.

Attack the bound control hardest. Try to change the list without the control noticing, and try
to change the marker without the list following.

## What the lane claims

1. **`/app` had a second hand-written OAuth control the sweep could not see.**
   `LiveDashboard.astro` carried `<button ... data-member-reauth-github>Sign in again with
   GitHub</button>` wired to `signInWithGitHub`. The sweep allowed that file exactly ONE
   hand-written control and read one, not two, because its marker wanted the provider id
   immediately after `data-`. The block now renders `ProviderButtons`, binds one
   `[data-member-reauth] [data-signin-provider]` handler that reads the id off the element and
   calls `signInWithProvider`, and the marker now takes the provider as a hyphen SEGMENT of the
   attribute name. A second control reads the BUILT `dist/app/index.html`.
2. **`components/landing/Hero.astro` and `Invite.astro` were dead** and are deleted.
3. **A comment in `site/src/lib/brain-links.ts` typed the slug separators** instead of naming
   the exported `BRAIN_SLUG_SEPARATORS`; it names it now, with a control in
   `site/src/lib/brain-links.test.mjs`.

## Checks

1. **Is the stated bound accurate?** Take each line of `SWEEP_CATCHES` and test it against the
   marker the assertions actually run. Does the sweep really catch each one? Is any line derived
   in appearance but typed in substance? Is `SWEEP_DOES_NOT_CATCH` the only thing it fails to
   reach among the shapes the list implies it handles?
2. **Is the derivation control real?** The new test claims the list cannot drift from the code.
   Break that: change the marker without changing the list, or the reverse, and say whether the
   control notices.
3. **Do the file and the design doc carry the same bound?** Check word for word.
4. **The reverted widenings.** Round 4's value branches and round 3's dataset widening were
   removed. Did removing them break any other claim in the file, or leave a comment describing
   something that is no longer there?
5. **The reauth swap.** Any provider name, id, or label still typed on that path? Does the copy
   a reader sees still read correctly? What happens with zero enabled providers?
6. **The exception accounting.** `UNGENERATED_SIGNIN_SURFACES` allows `LiveDashboard.astro`
   exactly one, and asserts equality. Is the source count 1, is the built count 1, and are the
   messages about them true?
7. **The deletion.** Anything under `site/`, the repo root, or `site/astro.config.mjs` that still
   resolves to `Hero.astro` or `Invite.astro`. Any comment or doc line about them that is false
   rather than historical.
8. **brain-links.** Does that control discriminate, and does it admit its gaps honestly?

## Output

Numbered findings, each with file:line, severity (BLOCKER / MAJOR / MINOR), and the reasoning.
Say which claims you tried to refute and could not. An empty PASS with no reasoning is not a
review. The LAST line must be exactly one of:

VERDICT: PASS
VERDICT: FAIL
