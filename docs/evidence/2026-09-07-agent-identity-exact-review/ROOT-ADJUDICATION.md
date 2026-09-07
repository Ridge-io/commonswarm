# Root adjudication of identity merge `0483eb9`

Verified as of: 2026-09-07 02:20 UTC.
Reviewer/adjudicator: CswarmAstra.

## Outcome

`0483eb997572ba42aad3ccc8474196bb745253b5` should not have been approved.
Its product tree is byte-identical to code candidate
`63acfdb336a77fba884070849c8d83cc761855a5`, but the exact-SHA Grok and
Gemini reviews found four reachable defects. I checked each finding against
the source and accept all four.

The merge landed before this adjudication completed. It is an ancestor of
current remote `main` `042afa63b965f43637561277090c02a921c3a1a7`
(CommonSwarm 0.1.64). The five affected source files are unchanged from
`0483eb9` on that main. The migrations, command/read/activity edges, client,
and site were deployed during the 0.1.62 release. A production members read on
2026-09-07 found 13 agent principals and zero with `managed_at`, so no seat
has been cut over to managed sessions. Fix these defects before any cutover.

## Accepted blockers

1. **Revoked agent credentials can acquire or renew a managed session.**
   `handleTransaction` dispatches `acquire_agent_session`,
   `renew_agent_session`, and `release_agent_session` at
   `supabase/functions/command/index.ts:7411-7419`, before route resolution
   and the call to `revoked()` at line 7454. `loadAgentCredential` identifies
   a row but does not reject every revocation tombstone or a revoked owner
   membership. A revoked credential can therefore keep a session live until
   that credential expires and exclude a replacement. Gemini called this
   “perpetual”; that word is too broad because the credential still has an
   expiry, but the bypass is a release blocker. Every agent session lifecycle
   command must pass the same current credential, membership, workspace, and
   tombstone checks as other agent mutations before it changes session state.

2. **A refused start can silence an unmanaged seat's hook.**
   `startManagedSession` writes generation-0 context before acquire
   (`src/cloud/session-cli.ts:212`) and keeps it after the definite
   `session_not_managed` refusal (lines 226-230).
   `managedHookGate` treats the presence of any context file as evidence of
   management and refuses when none has live proof
   (`src/listener/hook.ts:902-905`). The next hook prints and advances
   nothing, even though the principal is still unmanaged. Preserve same-proof
   retry only for an unknown acquire result. A definite unmanaged refusal must
   not leave a file that changes hook behavior, and the hook must distinguish
   unmanaged context from an enabled context with lost proof.

3. **Server session status always omits the generation.**
   The members read selects session metadata without `s.generation`
   (`supabase/functions/read/index.ts:630-643`), while the client exposes
   `server.generation` (`src/cloud/session-cli.ts:335-345`). The committed
   live-control JSON already shows `null`. Add the selected column and a test
   that reaches the read edge rather than injecting a fake members response.

4. **An unmanaged claim can persist an unverified session binding.**
   The claim call passes a parsed session whenever the headers are well formed,
   even when `agent.managed_at` is null
   (`supabase/functions/command/index.ts:8518-8526`). The fence correctly
   permits an unmanaged principal, but `claimAgentInbox` then writes that
   unverified UUID and generation to the delivery row
   (`supabase/functions/command/durable-delivery.ts:343-358`). Later normal
   unmanaged claims do not match the fake binding. Pass session proof to the
   claim layer only when management is enabled. Add a real-Postgres control:
   claim once with well-formed arbitrary session headers, let the lease expire,
   then prove a normal unmanaged listener can reclaim the same delivery.

## Evidence corrections owed

- `mini-live-control-63acfdb/README.md` names a `control.log` that is not in
  the committed directory.
- The same README says the session-status server block reported generation 3,
  while `step7-rerun.json` shows `server.generation: null`. The DB row
  reported generation 3; status did not.
- `laptop-arms/arm-grok-exact-e8abf8ab.md` is interleaved, corrupted output.
  It is cited as a valid FAIL in `client.md` and the laptop resume file.
  Per the `releases` brain topic, a garbled file is not a review. Preserve it
  only as invalid raw output or rename it with `NO-VERDICT`; do not count it.
- `docs/evidence/2026-09-06-markdown-qa/RESULTS.md` contains an unrelated
  generated Chrome-path change from `/Users/tom` to `/Users/yulanbot`.
  Restore the parent version.
- `supabase/functions/command/index.ts:7407` has trailing whitespace.

## Checks run on the exact merge

All of these passed in the detached worktree at `0483eb9`:

- `npm run build`
- `npm run check:tests`
- `npm run check:edge`
- `npm test`: 924 passed, 0 failed
- `npm run test:p1-cli`: 552 passed, 0 failed
- clean `site` build with the saved local `.env`
- `npm --prefix site test`: 547 passed, 0 failed, 1 skipped

The first parallel `npm test` run had two timing/stderr failures under heavy
load; the same gate passed alone. The first site run had no `site/.env` and
correctly failed provider and layout controls; it passed after a clean build
with the saved site settings. Neither failure is an identity regression.

Earlier evidence on product-identical `63acfdb` reports
`test:p1-server` 182/0 and `test:p1-local` 48/0 plus a local live control.
Those tests did not cover the four blockers above.

## Review records

- `grok-0483eb9.md`: substantive exact review, `VERDICT: FAIL`.
- `gemini-0483eb9.md`: independent exact review, `VERDICT: FAIL`; the
  revocation bypass was independently confirmed above.
- `grok-plan-mode-NO-VERDICT.md`: first read-only plan-mode attempt. It has no
  verdict and is not a review.

No production mutation was performed in this adjudication. The identity merge
and deploy had already completed in another session.
