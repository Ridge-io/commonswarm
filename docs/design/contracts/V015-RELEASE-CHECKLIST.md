# CommonSwarm v0.1.5 release, deployment, and production-verification checklist

> **Superseded in part by D-044, 2026-08-04:** the cross-owner zero-tool release gate below is
> retired. Cross-owner listener verification now proves the operator's existing worker/project
> context, sender/operator provenance, and the advisory confirmation steer. Server authority gates
> remain unchanged.

Status: **NO-GO until server/runtime integration and the versioned exact-SHA gates pass**.  
Pause re-measurement: Lead root `d7c0b1a59646ae624385d6cd09a919ad0b24c43b`; unaccepted clean
candidates Runtime A2 `ab1b240334efc62b50027512f64692e15d0e0752` and Server Phase B
`d972c3f8181c8da927edd8cf9818044261d9b08b`; production remains v0.1.4. This checklist supersedes
any older ordering that omits `test:p1-local`, tests stale
`site/dist`, or gates before the version bump.

## Current measured production floor

- Root and both lockfile version fields remain `0.1.4`; no v0.1.5 tag or release exists.
- Latest GitHub release is final `v0.1.4` with exactly `cswarm` and `cswarm.sha256`.
- Existing `site/dist` is historical v0.1.4 output, not release evidence.
- Public production currently returns 200 for all eight routes and `/install.sh`; `/nope.sh`
  returns 404. `/download` advertises/pins 0.1.4 on all four independent surfaces.
- `/start` has a nonempty backend meta value and no service-role credential marker.
- Production functions at the audit were command v15, read v6, capability v2; the existing Vercel
  production deployment was `dpl_FLsNC8Cu549rfCh8fSShPo3zX3AM` on project `coswarm-site`.
- Site/Vercel/Supabase deploy inputs are structurally present and the configured JWT role is
  `anon`. Re-verify immediately before mutation.

## Corrections to older handoff ordering

1. `npm run test:p1-local` is a real exclusive-DB gate and may not be silently omitted.
2. Build a clean site before site tests because the tests inspect `site/dist`.
3. Bump to 0.1.5 before the final frozen-SHA reviews/gates. A version bump moves the SHA.
4. Regenerate `_shared/protocol.js`, then prove it does not dirty the frozen candidate before
   `check:edge`; typechecking a stale generated bundle proves nothing.
5. Use the feature-specific rollout order:
   migration → command claim/ACK → backend controls → read capability → CLI release → site.
6. Record the operator-authorized Grok substitution durably: Grok is credit-exhausted, so exact
   Codex plus Gemini/Kimi inversion is the current release gate. Never silently claim Grok ran.
7. Rebuild `dist-release` and execute an isolated copy. Old output inside this ESM repo is not
   evidence about the candidate.

## 1. Freeze the complete versioned candidate

- Integrate accepted server and runtime candidates into the Lead branch.
- Resolve the literal root test list as an explicit union; enumerate all test files and prove a
  package script reaches each one.
- Enumerate exact migration/function changes relative to the intended landing base. Do not deploy
  `capability` unless the final diff changes it.
- Run `npm version --no-git-tag-version 0.1.5`.
- Prove exact equality of:
  - `package.json.version`;
  - `package-lock.json.version`;
  - `package-lock.json.packages[""].version`.
- Do not manually edit generated `/download` surfaces or unrelated minimum/protocol literals.
- Commit and freeze a clean exact SHA. Any later movement restarts exact Codex and independent
  cross-family review.

## 2. Full exact-SHA gate

Run pure/static gates first:

```sh
npm install                         # only if dependency/lock state requires it
npm test
npm run check:tests
npm run build
npm run build:command-core
git diff --exit-code -- supabase/functions/_shared/protocol.js
npm run check:edge
```

Before DB gates, prove no other DB/serve/test process owns the slot. Then run serially:

```sh
npm run db:start
npm run db:reset
npm run test:p1-cli
npm run test:p1-local
npm run test:p1-server
npm run check:edge
```

Do not overlap any reset/suite/function server. Record exact exits, counts, elapsed time, and the
zero-process checks.

Then build/test site and artifact in this order:

```sh
cd site
rm -rf dist
npm run build                       # enumerate exactly 8 HTML routes
cd ..
npm --prefix site test
scripts/build-release.sh
git diff --check
git status --short
```

Also prove:

- actual root/p1-cli/p1-local/p1-server/site inventories and test reach;
- release bundle line-one shebang;
- an isolated copy prints exactly `cswarm 0.1.5 (protocol 0.1.0)`;
- `shasum -a 256 -c dist-release/cswarm.sha256` passes;
- root, `site/public`, and built `site/dist` installers are byte-identical;
- all four independent `/download` 0.1.5 surfaces occur exactly once;
- browser bundle has its known positive sentinel and none of the root-only sentinels;
- ~~execute the **12 recorded controls**; **0 of the 10 required domains has a recorded
  domain-valid control and all 10 are blind**~~ — **dead (2026-08-03):** the Stage 7 control lane
  added seven exact mutant/test pairs and closed six of the seven previously blind domains;
- execute the **22 recorded controls** exactly as enumerated in
  `docs/design/2026-08-03-STAGE7-CAUSAL-CONTROL-REGISTER.md`, including its binding per-test,
  concurrency, watchdog, named-red, and exclusive-slot rules. That register records the current
  release coverage truth: **9 of the 10 required domains have a recorded domain-valid control;
  claim one-winner remains blind after its exact mutant stayed green and triggered the mandatory
  stop.** Do not report that domain as closed.

Run `test:uxtest` if the final union affects its journey; otherwise record it as explicitly skipped
and unestablished.

## 3. Land and stage

- Fetch and re-read remote `main`; stop on unexpected movement.
- Fast-forward the exact accepted SHA to `main`; never force-push.
- Prove local HEAD and live remote main equality.
- Rebuild artifacts from the landed SHA if landing changed anything.
- Record artifact size and SHA-256.
- Prepare the immutable v0.1.5 tag target, but do not publish the release before backend readiness.

## 4. Production backend rollout

Before mutation record the remote migration ledger, function versions/hashes/status, Vercel
deployment, v0.1.4 tag/assets/checksum, and public/backend controls.

1. `supabase db push --dry-run --linked` enumerates only the reviewed additive migration.
2. Apply the migration.
3. Run the live-direct-row reconciliation assertion without recording bodies/credentials.
4. Re-run the linked migration ledger and require exact local/remote parity.
5. Deploy `command` from the exact landed SHA.
6. Before read advertises capability, verify anonymous `{}` → 400 `invalid_request`, authenticated
   claim/ACK positive path, wrong workspace/principal/revoked/stale/wrong/unknown indistinguishability,
   and zero body/bearer in ledger/audit.
7. Deploy `read`.
8. Eligible authenticated agent sees both `delivery_claim:1` and `delivery_ack:1`.
9. Verify read `{}` → 401, capability without token → 404, and nonexistent function → 404.
10. Run an exact v0.1.4 cursor-fallback client before and after capability activation.

Record deployed versions and hashes from production, not from source or logs.

## 5. Publish CLI, then deploy site

- Push immutable `v0.1.5`; remote tag target equals landed SHA.
- Create final non-draft/non-prerelease GitHub release with `--verify-tag` and exactly `cswarm` and
  `cswarm.sha256`.
- Verify target, two-asset inventory, sizes, local checksum, checksum file, GitHub digest, and an
  independently downloaded copy. Real assets return 200; a missing asset returns 404.
- Install through the public installer into an isolated directory pinned with
  `CSWARM_VERSION=0.1.5`; verify exact version/protocol and checksum.
- Only after assets exist: structurally parse site env as anon, clean-build, rerun site tests, copy
  `site/.vercel` into `site/dist/.vercel`, and deploy `site/dist --prod --yes --scope ridgedotio`.
- Prove `commonswarm.com` serves the new Ready deployment from project `coswarm-site`.

The site must never advertise a version before its downloadable release assets exist.

## 6. Production verification

Public controls:

- eight routes plus `/install.sh` return 200; `/nope.sh` returns 404;
- `/download` has two exact 0.1.5 version lines and two exact 0.1.5 pins; stale shipping 0.1.4
  surfaces are absent;
- `/start` has one nonempty backend meta value and zero service-role markers;
- deployed installer matches reviewed root installer; unpinned install yields 0.1.5.

Authenticated consumer journey:

- cold-browser magic-link completion and GitHub OAuth if claimed;
- create/open workspace;
- add own agent and automatic prompt completion;
- roster model/owner/avatar and feed update within five seconds;
- second human consumes teammate link and pending access clears;
- remove/revoke while history remains attributable;
- 390×844 mobile and focused keyboard/accessibility controls;
- cleanup every disposable fixture.

Listener/delivery journey:

- production OpenCode 1.18.10 listener remains a required host-matrix canary even though Pi is the
  engineering-worker harness;
- same-owner ask/note and real `tlangridge` ↔ `Ridgeio` cross-owner zero-tool turn;
- one-winner concurrent startup/claim, restart, and response-loss replay;
- effect persisted before ACK with one correlated reply;
- revocation stops claims/posts within the measured bound;
- credential absent from argv, environment, status, logs, and host frames;
- legacy v0.1.4 cursor client remains functional.

Run accelerated credential rotation. Start 24-hour and 7-day canaries. The 30-day elapsed canary
may remain explicitly post-MVP/unestablished.

## Rollback boundaries

- Before read capability: redeploy prior command v15; leave additive schema in place.
- After capability: remove `delivery_claim` from read first, keep ACK live, drain/rewind clients,
  wait at least maximum 15-minute lease plus margin, prove zero live leases, then remove ACK or
  restore command.
- Never destructively roll back delivery table, trigger, schedule, or rows in this release.
- Read defect: restore prior exact read v6/hash and verify safe fallback/refusal.
- Listener/adapter defect: disable the new adapter while retaining host-neutral cursor fallback.
- Site defect: re-alias prior known-good Vercel deployment to the same project aliases.
- Published CLI defect: never move v0.1.5 tag; contain by default pin only if needed, then publish
  corrected v0.1.6.

Rollback is not complete until public alias, backend capabilities, live leases, and installer
default are remeasured.

## Still unestablished

- final v0.1.5 SHA, migration filename, artifact digest/size, function versions/hashes, Vercel ID;
- full versioned-union gate and exact final counts;
- production durable claim/ACK, full listener, cross-owner turn, and long canaries;
- cold-browser email/OAuth, second-human link, pending-access clearing, and accessibility sweep;
- authenticated-QA cleanup; and
- legal activation, intentionally deferred pending operator/counsel approval.

All release and production evidence belongs under committed `docs/evidence/`, not only this ignored
working checklist.
