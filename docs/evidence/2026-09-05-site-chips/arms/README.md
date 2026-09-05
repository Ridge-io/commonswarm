# lane/site-chips — review arms, all seven rounds

Every `arms-<sha>/` directory here is a copy of the arm directory used to review that exact SHA.
Each holds `REVIEW.md` (the brief the arm was given), `DIFF.patch` (the lane diff from the
merge-base), a `PID` file, and `ARM.txt` per arm — the arm's own output, unedited.

`arms-*` is ignored by `.git/info/exclude`, so these were added with `git add -f`.

## Rounds

| # | SHA | Grok | Gemini | What the round turned on |
|---|---|---|---|---|
| 1 | `71629e6` | no verdict | FAIL | Gemini: the widened marker over- and under-matched; a value-hidden button slipped both sweeps; the deletion left pointers at `Hero.astro`. |
| 2 | `cff55f7` | FAIL | FAIL | Both: the `setAttribute` branch had no end-of-name guard; the `dataset` branch watched only `signin*`; the built-page control was case-sensitive while its sibling was not. |
| 3 | `353a135` | PASS | FAIL | Split. Both named the SAME residual: `<button data-login="github">` wired with a DOM read. The call-site comment claimed a wider bound than its assertions had. |
| 4 | `826bce5` | FAIL | FAIL | Both: widening bought one shape and invited the next (`data-login={"github"}`, unquoted attributes, `dataset.login`). Comments outran the code again. |
| 5 | `df70a0b` | FAIL | FAIL | Both, on the bound CONTROL rather than the sweep: the derivation check was a tautology; call lines were derived in look only; three comments described reverted branches; the doc carried a paraphrase. |
| 6 | `715fb05` | PASS | FAIL | Gemini: the allowed call sites were typed twice, once in the bound sentence and again in the assertions. Grok: "Three ways" over a list of four. |
| 7 | `66a9e9f` | **PASS** | **PASS** | Final. Both ran the mutations themselves and reported which ones the control catches and which one it does not. |

Round 1's Grok arm has no verdict: it was killed after Gemini returned FAIL, because a FAIL
forces a new SHA and both arms are rerun there. It is kept so the record is complete rather than
tidy.

## The argument rounds 2-5 were about, and how it ended

Rounds 2 through 5 were one argument: whether a regex over `site/src` can catch every way to
write a sign-in button. It cannot. Each widening closed one shape and the next arm constructed
another. The operator ruled that completeness was the wrong question.

The sweep now STATES ITS BOUND. `SWEEP_CATCHES` in
`site/src/components/auth/provider-buttons.observer.test.ts` is generated from the marker's own
branches and the call-name constants the assertions run; `SWEEP_DOES_NOT_CATCH` names the one
shape it does not reach; step 6 of `docs/design/2026-09-04-GOOGLE-SIGNIN.md` carries all of it
word for word, and a control keeps the two identical.

## What the final round established, and what it did not

Both arms confirmed, by running them: a deleted branch, an emptied claim, a stubbed claim, a
reworded claim and an extra untethered line all turn the control red, and the file and the doc
carry the same eight lines and the same bound sentence.

Both arms also confirmed the one thing it does NOT catch, which the lane admits in the test
itself: narrowing a pattern in a way that still matches its own probe. One positive probe per
branch is the limit of that design.

Not established anywhere in these seven rounds: any behaviour in a real browser. Every claim
about `/app` is measured against the built `dist/app/index.html` and the source.
