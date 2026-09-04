You are a REVIEW ARM under D-036. Review one diff on an exact SHA. Try to REFUTE it.

REPO (read-only; do not edit): /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-standing-followup
SHA under review: 2d9fbba on branch lane/standing-default-followup.
THE DIFF: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/fu-review.diff
It is `git diff lane/standing-default..HEAD` — four commits on top of e433fd9, which is a
separate lane that makes an agent added in the web app get a standing (never-expiring)
renewal grant with a human-resumable idle pause. e433fd9 itself is NOT under review; only
these two commits are. Read the diff file first, then read the files it touches in the repo.

WHAT THE TWO COMMITS CLAIM TO DO

bdce3bc — site/src/lib/agent-connect.ts
 1. Deletes the page-owned RENEWAL_HORIZON_DEFAULT_MS and stops computing
    `times.issuedAt + RENEWAL_HORIZON_DEFAULT_MS`. The horizon is now read off
    `horizon_expires_at` in the accepted mint response for BOTH grant kinds, via a new
    `mintedHorizon(body)`. Absent/unparseable reads as null (unknown), not as a guess.
 2. Rewrites the HTTP 400 message so it names version skew in both directions.
 3. Adds site/src/components/connect/agent-connect-mint.observer.test.ts, which drives
    mintAgentCredential against a stubbed fetch and asserts on the SERIALISED command body.

7536f1c — the resume path
 A. supabase/functions/command/index.ts: the resume handler read
    `outcomeRows[0]?.resume_outcome ?? "renewal_resume_forbidden"`. NULL is the SUCCESS value
    of swarm.resume_renewal_grant, so every resume was refused — and because `refuse` returns
    inside `db.begin` rather than throwing, the UPDATE committed anyway. Now NULL is
    preserved; a missing row throws.
 B. src/protocol/workspace-commands.ts + the edge: the reducer's second test for "paused"
    (`grant.suspended_at !== null`) is replaced by `grant.suspension_active`, and the edge
    stops remapping the column through a CASE. protocol.js regenerated.
 C. tests/p1-server/standing-grant-resume.test.ts, new, drives the real command function
    against real Postgres.

016d2b0 — src/cloud/renewal-grants.ts + src/cloud/renewal.ts
 D. e433fd9 corrected `cswarm whoami`'s paused-grant remedy to name `cswarm grant resume`, but
    src/cloud/renewal.ts still threw "revoke this grant and mint a new credential" — the
    PERMANENT kill offered as the cure for the RECOVERABLE pause, on the surface the listener
    actually prints. Both now call a new standingPausedRenewalMessage().

ATTACK THESE SPECIFICALLY. For each, answer UPHELD / REFUTED / INCONCLUSIVE with file:line.

Q1. Is `mintedHorizon` correct for every response the deployed server can send? Check
    supabase/functions/command/index.ts around 7495-7510 (accepted mint) and 2165-2180
    (idempotent replay). Can a timeboxed grant now report a horizon DIFFERENT from what the
    database row holds (index.ts around 4037-4042)? If the two derive the same instant from
    different clocks, say so.
Q2. Does anything still read a horizon this page invents? Enumerate every reader of
    AgentCredential.horizonExpiresAt and of RENEWAL_HORIZON_DEFAULT_MS across site/ and
    tests/. Do not pattern-match; list them.
Q3. Fix A: is preserving NULL actually correct, and is THROWING on a missing row right? Read
    swarm.resume_renewal_grant in supabase/migrations/20260904000001_standing_grant_resume.sql.
    Does any refusal path in that function mutate BEFORE returning its code? If one does, the
    commit-on-refusal reasoning written into the new comment is wrong — say so loudly.
Q4. Fix B: after replacing suspended_at with suspension_active, can a renewal still be
    refused for a grant that a human has resumed? Can a PAUSED grant now slip through? Trace
    both the preflight code path and the facts path. Also: is the regenerated
    supabase/functions/_shared/protocol.js a true regeneration of src/protocol, or was it
    hand-edited?
Q5. The new p1-server test: does it reach the handler, or could it pass against the broken
    `??` version? The author reports that restoring the `??` turns R1 red while R2 still
    passes. Is that consistent with the code, and does R2 therefore prove the resume committed
    while the caller was refused?
Q6. The new site test: could it pass for a body the deployment would reject? Specifically,
    does asserting on the serialised string actually distinguish an absent `renewal_horizon_ms`
    from `renewal_horizon_ms: null`, given the validator at index.ts:1952-1953?
Q7a. Fix D: is standingPausedRenewalMessage() true for BOTH reasons it is called with
    (renewal_idle_suspended and renewal_grant_suspended)? The non-idle arm deliberately omits
    a day count — is that right, and can a grant reach renewal_grant_suspended for a reason a
    resume cannot fix? Check src/cli.ts and src/cloud/signals.ts for any other surface still
    carrying the retired remedy.
Q7b. Fix E (commit 4): a PREVIOUS run of this review found every
    supabase/functions/command/index.ts line number in this lane's comments was wrong — the
    claims were right, the pointers had shifted because e433fd9 inserted ~275 lines into that
    file. They were corrected, and tests/p1-cli/citation-drift.test.ts now pins each one.
    RE-CHECK THEM YOURSELF, independently: resolve every file:line the diff cites and say
    whether it now points at what the comment claims. Then judge the control: can
    citation-drift.test.ts pass while a citation is wrong? Is its (file, range, token) table
    itself a hand-typed list with the same defect it exists to catch, and if so is that
    acceptable? Does it run under both `npm test` and `npm run test:p1-cli`?
Q7. Anything in this diff that is FALSE, unsafe, or that breaks e433fd9's behaviour. Include
    copy, comments, and dated "RETIRED" notes: a comment that misstates the code is a defect.

RULES
- Verify every line number quoted in the diff's own comments. If a citation points at the
  wrong code, say so — that is a real finding.
- A negative result must reach the path it claims to test. If your probe could not have
  detected the failure, call it inconclusive rather than a pass.
- Do not approve because it looks reasonable. Read the code.

OUTPUT
One paragraph per Q1..Q7 with citations. Then the most serious defects, worst first. Then, on
the LAST line, EXACTLY one of these and nothing after it:
VERDICT: PASS
VERDICT: FAIL
You MUST print a VERDICT line.
