# Inversion-arm brief — D-051 branch, final SHA `e126e00`

Written so a fresh seat can start cold. **This is a correctness and robustness review of our own
repository before we merge it** — not an offensive-security exercise. That framing matters: an earlier
arm on this release refused two security-framed prompts and accepted this one, and this one is the
more accurate description of what D-036 requires.

## What to review

Branch `d051-honour-retryable`, eight commits, final **`e126e00`** (on `origin/d051-verity-latest`).
Author: Verity. Exact arm: ClaudeCswarm — 455/455 root, 152/152 p1-cli, clean tree, mutant confirms
the new control discriminates.

```
84f0882  honour the server's retryable:false instead of retrying regardless
f439393  backoff decay + bounded listener restart
5886fa4  classify on type/code, never on error.message text
6d5a478  emit the follow stream's terminal condition as an NDJSON frame
19688d5  evidence: the D-056 decision, both arguments kept
5ed1d95  first end-to-end gate on the follow loop (spawns the real CLI)
9df8905  evidence: D-056 resolved — no bounded recovery
e126e00  exit 75 (EX_TEMPFAIL) when a follow stop is restartable, 1 otherwise
```

## The highest-value target, named by the author

`e126e00` makes `runtime.ts` reach its exclusion list **through a shared predicate**
(`isRestartableReadError` in `signals.ts`) instead of inlining it. The author states *"same three
classifiers, same order, no semantic change intended."*

**Diff the old inline logic against the shared predicate directly. Do not accept "intended" as
evidence.** A refactor unifying two lists is where a dropped condition or reordering hides, and **both**
callers now depend on it — the supervisor's bounded restart and the CLI's exit status. A single-case
difference means a listener restarts when it should not, or fails to when it should.

## Also worth attacking

- Does exit `75` leak onto any path it should not? A revoked credential must stay `1`.
- The control asserts the two exit codes **differ** rather than checking each independently. Is that
  genuinely stronger, or only differently worded?
- `6d5a478` adds new server-adjacent output. Can the NDJSON frame be made injectable? A prior arm showed
  a server-supplied token containing `aborted` could reach a classifier and make the follow exit
  silently as though cancelled.
- Four MAJORs were found on `84f0882` — confirm each is fixed here: permanent listener death on refusal;
  backoff reset wiping earned pressure; the abort injection; and the provider controlling retry via
  `error.message`.

## Method rules that matter in this repo

- **Verify every line number you cite.** An earlier arm produced convincing prose with fabricated
  coordinates.
- **Positive-control any search returning zero.** A confident zero from a wrong path is this project's
  most common self-deception, and the Lead has done it three times today.
- **An empty PASS is not a review.** If you find nothing, state precisely what you checked.
- `NODE_OPTIONS` here references a deleted preload — export `NODE_OPTIONS="--max-old-space-size=4096"`
  or every node command fails. You do not need to re-run the suites.

## Frozen tree

`/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/6b2df269-2929-4781-a57f-4625e3b95172/scratchpad/d051-final-gate`
— detached at `e126e00`, deps installed, no other writer.

## Context that changes what this ship means

Do **not** describe this as a fix for the production outage. Wren's interleaved measurement shows a
single authenticated request fails ~50% of the time with no concurrency; load moves it to ~75% but does
not create it. These are correct client behaviours shipping on their own merit. The production cause is
**unknown** — three hypotheses have been refuted by measurement.
