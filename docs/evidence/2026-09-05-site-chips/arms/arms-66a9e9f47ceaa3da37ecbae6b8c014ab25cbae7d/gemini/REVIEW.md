# Review brief — lane/site-chips @ 66a9e9f47ceaa3da37ecbae6b8c014ab25cbae7d

Repo: CommonSwarm (`cswarm` CLI + Astro marketing/app site + Supabase edge functions).
Base: `origin/main` @ `e3e77223c8dfd697906ba329f18c02ccaca41ec6`. Nine commits.

**Read the diff at the absolute path you were given.** Before any finding, quote back the FIRST
`diff --git` line of that patch verbatim. `ROUND7-ONLY.patch` beside it is the LAST commit alone
(715fb05..66a9e9f), which is what this round is about. You may read any file in the checkout.

## Scope: the last commit, then everything else

The previous round on 715fb05 was Grok PASS, Gemini FAIL. This commit fixes both findings.

**Gemini's BLOCKER.** `SWEEP_CATCHES` in
`site/src/components/auth/provider-buttons.observer.test.ts` states what the hand-written-control
sweep catches. Two of its lines interpolated the call NAMES (`OAUTH_CALL`,
`NAMED_PROVIDER_WRAPPER`) while the constraints AROUND those names — "outside
lib/commonswarm.ts", "more than one call" — were typed prose, and the assertions that enforce
them carried the same two constraints as their own typed literals. Widening an assertion would
have left the sentence stating the old rule. Fixed by `OAUTH_CALL_SITE`,
`NAMED_WRAPPER_CALL_SITES` and `NAMED_WRAPPER_CALLS_ALLOWED`, which the claims and the
assertions both read, plus the regenerated line in the design doc.

**Grok's MINOR.** The source-sweep comment said "Three ways" over a list of four. Now "Four".

## Background you need — do NOT re-litigate this

The sweep does NOT try to catch every way to write a sign-in button under `site/src`. It cannot,
and four earlier rounds of widening bought one shape each and invited the next. The operator
ruled that completeness is the wrong question. The sweep STATES ITS BOUND: `SWEEP_CATCHES` and
`SWEEP_DOES_NOT_CATCH`, carried word for word in step 6 of
`docs/design/2026-09-04-GOOGLE-SIGNIN.md`, pinned by a control.

**Do not report that the regex is incomplete, or that `<button data-login="github">` with a
DOM read is missed. That is the stated bound. A finding that only restates it is not a finding.**

## Checks — attempt to refute each, and say so when you cannot

1. **Are the three new constants really read by both sides?** `OAUTH_CALL_SITE`,
   `NAMED_WRAPPER_CALL_SITES`, `NAMED_WRAPPER_CALLS_ALLOWED`. Trace each to the claim line it
   builds AND to the assertion that enforces it. Change one and say which tests go red. Is any
   constraint still typed twice anywhere in this file?
2. **Is the derivation control real, or a tautology?** The test
   "the sweep's stated bound is derived from its own assertions, and the doc carries it".
   Each `SIGNIN_MARKER` record pairs a pattern, a claim and a probe. Try to change the stated
   bound without the control noticing: delete a claim, empty one, stub one, reword one, add an
   untethered line, or narrow a pattern. Say exactly which of those it catches and which it does
   not — the lane already admits one (a narrowing that still matches its own probe).
3. **Do the file and `docs/design/2026-09-04-GOOGLE-SIGNIN.md` carry the same bound?** All eight
   catch lines and the bound sentence, word for word. Check the regenerated `signInWithGitHub(`
   line especially.
4. **Does the sweep actually do what `SWEEP_CATCHES` says?** Run each claimed shape against the
   marker the assertions build. A claim the marker does not honour is a real finding.
5. **Did the last commit break anything?** It touches only the test and the doc. Are the
   `signInWithOAuth` and `signInWithGitHub` call-site assertions still enforcing the same rule
   they enforced before, or did routing them through constants weaken either one?
6. **Everything else in the lane, briefly.** The `/app` reauth swap (no typed provider on that
   path, copy still reads, zero-provider behaviour); the deletion of `Hero.astro` and
   `Invite.astro` (nothing resolves to them, no false comment about them); the `brain-links`
   comment control and whether it admits its gaps honestly.

## Output

Numbered findings, each with file:line, severity (BLOCKER / MAJOR / MINOR), and the reasoning
that got you there. State plainly which claims you tried to refute and could not. An empty PASS
with no reasoning is not a review.

The LAST line of your output must be exactly one of:

VERDICT: PASS
VERDICT: FAIL
