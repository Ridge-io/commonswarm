# Review arms — lane/google-copy

Five rounds. Each directory is named for the SHA that round reviewed. `REVIEW.md` is the brief
the arms were given; `ARM.txt` is what each arm returned.

**The two arms that count are in `22048d3/`.** That is the lane's final SHA, and both returned
`VERDICT: PASS` with the diff's first `diff --git` line quoted back and their reasoning shown.

| round | SHA | grok | gemini | what happened |
|---|---|---|---|---|
| 0 | `18ef9ca-superseded` | **FAIL** | not run | The previous author's SHA, before this lane's work. Two real findings: no fixture built the legal pages with `google: true`, so "passes in both states" was never measured and the sweep DID go red on `Google LLC — sign-in.`; and `/app` still said "Use GitHub" on its email rate-limit line. The commit that rewrote this history is `4b94008`, so the SHA in that file no longer resolves. |
| 1 | `38fb846` | interrupted | PASS | Both arms were killed part-way when the lane found a defect by reading the rendered output rather than by testing: the generated entity list ended the sentence, so the privacy policy published `You sign in through GitHub, Inc..`. `grok/ARM.txt` in that directory is a partial stream with no verdict. **It is not a review.** |
| 2 | `fa077d3` | PASS | PASS | Both passed. Grok also listed GAPs the lane then acted on: the runbook still told the operator that `/app` hand-writes a button and still says "Use GitHub", the sweep's own comments were stale, and `signInWithGitHub` was dead code. |
| 3 | `c2f01f2` | PASS | **FAIL** | Split. Gemini found two DEFECTs, both verified and both real: the named-wrapper ban was the single literal `signInWithGitHub(` while its comment claimed it banned the shape, so a `signInWithGoogle` would have passed in silence; and the door sentences claimed service-wide what is only true of the sign-in page, since `cswarm login` sets `provider=github` and has no emailed link. |
| 4 | `f11d445` | PASS | **FAIL** | Split. Gemini raised three points. Two were right and were fixed: the wrapper ban's SHAPE was an unstated bound, and a provider name with a space would generate a ban no file can match. The third, "the bound-length check is now a tautology", was refuted — it still catches a line typed into `SWEEP_CATCHES` beside the generated ones, and a mutation now proves that. Grok, reviewing the same SHA independently, reached the same refutation. |
| 5 | `22048d3` | **PASS** | **PASS** | Final. The tree was left untouched for this round, after a round-3 arm reported it could not get a clean suite run because the mutation harness was writing the checkout underneath it. |

## Reading a split

On rounds 3 and 4 the arms disagreed. Each time the FAIL was verified at the cited lines before
anything was changed, and the verdict count was not treated as the ruling. Two of Gemini's four
findings across those rounds were correct and are fixed; one was correct as a bound and is now
stated in `SWEEP_DOES_NOT_CATCH` and in the checklist pinned to it; one was wrong and is
answered by a mutation rather than by an argument.

## What no arm established

- No arm opened the Google Cloud or Supabase consoles. The runbook corrections in
  `docs/design/2026-09-04-GOOGLE-SIGNIN.md` were measured by the operator's own browser agent
  and read, not re-walked, by the arms.
- No arm rendered `/app` in a browser. `.dashboard__providers` was read as CSS and as built
  HTML, not seen with two buttons on screen.
- The final round's arms did not run `mutate.mjs`, because it edits source files in place. Its
  run is recorded in `../mutation-table.txt`.
