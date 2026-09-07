# 2026-09-07 RESUME HERE — agent-session identity

Written for a cold successor after the exact merge review.

## What is live

- Remote `main` is `042afa63b965f43637561277090c02a921c3a1a7`;
  CommonSwarm 0.1.64 is live.
- Identity merge `0483eb997572ba42aad3ccc8474196bb745253b5` is an
  ancestor of main. Its migrations, command/read/activity edges, client, and
  site went live during the 0.1.62 release.
- A production members read on 2026-09-07 found 13 agent principals and zero
  with `managed_at`. The managed session lifecycle is deployed but no seat
  has been cut over.
- Route main remains the only listener route. No listener starts a headless
  model.

## What is written

- Code candidate:
  `63acfdb336a77fba884070849c8d83cc761855a5`.
- Identity branch: local `lane/agent-identity` at
  `13e6f46699bca51c525084d90a5cb320cc44ed75`; remote branch at
  `dd2651b48e5304f9821e453fcf9c726a3d0225fd`.
- Merged identity commit:
  `0483eb997572ba42aad3ccc8474196bb745253b5`, parents
  `a6184a99a32255fe3b84aa68a555b3a3996c61dd` and
  `dd2651b48e5304f9821e453fcf9c726a3d0225fd`.
- Product paths in `0483eb9` are byte-identical to `63acfdb`. Eleven
  evidence/resume files differ after the code candidate.
- Exact review and root adjudication are in
  `docs/evidence/2026-09-07-agent-identity-exact-review/`.

## Decision

`0483eb9` landed before the exact review completed. Exact Grok and Gemini
reviews both failed it. Root checked current main and accepted four live
defects:

1. Revoked credentials and revoked owner memberships bypass the ordinary
   revocation check on acquire/renew/release session paths.
2. A definite `session_not_managed` start refusal leaves a generation-0
   context that makes the hook refuse an unmanaged seat.
3. The members read omits `s.generation`, so
   `session status --json` reports `server.generation: null`.
4. An unmanaged claim can persist arbitrary well-formed session headers and
   make later normal claims unable to reclaim the row.

Read `ROOT-ADJUDICATION.md` before changing code. It has the exact producer,
consumer, trigger, outcome, and required test for each item.

Do not enable managed sessions for any seat until these four defects are fixed.
Stock unmanaged clients do not send session headers, so the current fleet does
not normally reach defect 4. A custom client with a valid agent credential can.

## Next command and order

Use a new worktree. The shared checkout is not safe to write:

```sh
git fetch origin
git worktree add <session-scratchpad>/identity-r7 \
  -b lane/identity-r7 origin/lane/identity-handoff-astra-20260907
```

Then:

1. Add failing focused controls for all four blockers. The revocation and
   unmanaged delivery controls must reach real PostgreSQL through
   `test:p1-server`.
2. Fix the four defects. Keep acquire lost-response retry with the same private
   proof. Do not delete a draft context after an unknown transport outcome.
3. Correct the five evidence issues listed in `ROOT-ADJUDICATION.md`.
4. Run `npm run build`, `npm run check:tests`, `npm run check:edge`,
   `npm test`, `npm run test:p1-cli`, the clean site build and site tests,
   then the exclusive `test:p1-local` and `test:p1-server` gates.
5. Run a local live control that covers revoked-session renewal and unmanaged
   claim recovery. Use `--state-dir <temp>`; do not touch production.
6. Obtain new Grok exact and Gemini inversion reviews on the final exact SHA.
   A fix changes the SHA, so the reviews on `0483eb9` cannot approve it.
7. Hand the new exact SHA and evidence to CSwarmDevLead. Deploy changed server
   edges before the client, then the site if it changes. No new migration is
   expected from the four known fixes. Cut over one seat only after the live
   controls pass.

## Current workspace state

- Shared checkout:
  `/Users/yulanbot/Developer/Ridge.io/cloud-swarm`, clean local `main` at
  `042afa63b965f43637561277090c02a921c3a1a7`, equal to remote main when this
  handoff was written.
- Exact review worktree:
  `/private/tmp/cswarm-astra-identity-20260906-01a07471/final-verify`.
- The other visible worktrees include `spec/app-backlog` and the old
  `lane/agent-identity`; treat them as other agents' work.
- The exact review jobs finished. No Grok or AGY process started by this
  adjudication should remain.

## Coordination

- Signal `988f33f6-e2e2-489a-b27a-aa29fd14dee0` told CSwarmDevLead not to
  land `0483eb9` until exact results arrived. The merge landed before those
  results were sent.
- As of the last manual read, no directed reply or new identity warning was in
  CswarmAstra's inbox.
- The `app-backlog` brain topic is the release ledger. Its old item −1 says
  the candidate is ready; the handoff updates that claim to blocked on the four
  defects above.

## Deliberately deferred

- Production deployment of the follow-up fixes.
- Renewal-under-load measurement.
- A native attendance callback for non-Claude hosts.
- End-to-end Codex same-chat injection. Manual reads remain the supported
  low-cost path; the optional heartbeat stays paused unless the operator
  chooses its model-turn cost.

## Not established

- No managed production seat or cutover control.
- No exact-SHA PASS after the four fixes.
- No foreign-UID context-file control.
- No end-to-end Codex callback receipt.

The prior claim “every gate green, arms passed, ready for release” is retired.
The gates were green, but they did not cover the four exact-review defects.
