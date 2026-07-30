# Hosted remove-member evidence

## Contract

- Base under review freeze: `c0dc2ca8dcd2495dc4b41f375c2059c6208bc772`.
- Removal is workspace-scoped and never writes a global tombstone.
- An active repository mapping that names the target as landing authority
  refuses with `landing_authority_unresolved`; this command never transfers or
  rewrites repository authority.
- Fresh authentication is 300 seconds from the newest interactive AMR in
  verified claims for the presented session. **Decision #198 / D-035** allows
  only the exact literals `oauth`, `password`, `otp`, `totp`, `sso/saml`,
  `magiclink`, and `email/signup`; refresh/recovery/invite/email-change/
  anonymous/missing/malformed/future methods fail closed. JWT `iat` and global
  sign-in timestamps are not used. Slash-bearing values are literals, not aliases.
- Idempotency replay precedes the fresh-auth gate. A stale first attempt is
  audit-only and unledgered; the CLI preserves that command ID for the explicit
  post-login retry.
- Clock-skew policy: `ageSeconds >= -5` (`FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS`)
  and `ageSeconds <= 300`. The five-second negative floor absorbs auth-service versus
  database clock skew; the 300-second upper freshness bound is unchanged. Zero-tolerance
  prose is superseded. String-array AMR entries are rejected (Supabase JWT Claims define
  object `{method,timestamp}` entries); hosted real-token shape remains unestablished.

## Implemented seams

- Strict global kind registration and `{kind,user_id}` wire validation.
- Human-only workspace routing with uniform agent denial.
- Repository-backed landing-authority oracle (not hardcoded true).
- `MemberRemoved` projection updates exactly one live membership in the routed
  workspace using the event timestamp (`payload.revoked_at` = reducer `ctx.now`).
- Typed command client, exact member selector, explicit CLI confirmation, JSON
  output, and named recovery.
- Thin browser member roster with role-aware removal, explicit confirmation,
  GitHub/email reauthentication, and no automatic action after redirect — resume
  only by explicit Remove again.
- Reachable unit, mutation, CLI, dashboard observer, and p1-server coverage.

## Authoritative server gate (run-019)

- Ledger: `run-019` under task `hosted-remove-member-v2` on exact candidate
  `2e1dac9` (content transplanted onto `swarm/Onyx/hosted-remove-member-final`).
- **`npm run test:p1-server`: 37/37 pass, 0 fail / 0 cancel / 0 skip.**
- Runs **017** and **018** are **INVALID** exclusive-DB evidence: duplicate Lead7
  sessions overlapped the suite and polluted the shared function log stream
  (Decision #199 / #200). Do not cite 017/018 as product findings; the pre-auth
  observer that caught contaminated log cardinality must not be weakened.

## Pure and client gates (pre-final on transplanted content)

- Historical pure on `2e1dac9`: `npm test` 94/94; `npm run test:p1-cli` 131/131.
- Final exact-SHA counts for this frozen branch are recorded under **Final gates**
  below after the mutation matrix and commit.

## Mutation matrix (actual temporary source)

Each arm mutates production source, runs the named pure/site observer on the same
invocation, requires RED, then restores the production file byte-identical to the
pre-arm snapshot. Arms executed against the Onyx final worktree (see COMPLETE
message for commands and exit codes):

1. Remove `remove_member` from one `COMMAND_KINDS` registration site.
2. Replace exact `sso/saml` allowlist entry with bare `sso`.
3. Admit `token_refresh` into the interactive allowlist.
4. Remove `getClaims` / `newestInteractiveAmrSeconds(claimsData.claims)` verified-claims wiring.
5. Hardcode landing oracle to always true.
6. Drop `MemberRemoved` `workspace_id` scope from the projection UPDATE.
7. Drop exact-one `updated.length !== 1` rowcount guard.
8. Remove browser `window.confirm` / `removeWorkspaceMember` / `FreshLoginRequired` catch.
9. Clear pending command id on `ReauthenticationRequired`.
10. Reorder so remove_member fresh-auth runs inside / before idempotency step 7.

Prior lane arms 1–3 were already RED-then-restored on `2e1dac9` before handoff; this
finalizer re-ran the full named set against strengthened observers.

11. Zero `FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS` (5 → 0): focused age-bound observer and
    source match for `= 5` RED; production restored byte-identical. Documents auth-service
    versus database skew floor without weakening the 300-second upper bound.

**Reviewer disposition (Gemini):** string-array AMR support is **not** implemented. Supabase
JWT Claims Reference defines object entries with timestamps; timestamp-less strings fail
closed. The pure test title already reads `D-035 / Decision 198` on this candidate (a claim
that it still said Decision 183 was a stale artifact). **Nonblocking ceiling (Slate N1):**
the p1-server harness has no safe injection for verified stale AMR without broad test-only
auth hooks; exclusive server coverage of 401 `fresh_auth_required` with no membership row and
no idempotency ledger remains unestablished here.

## D-034 content note

Orphan browser candidate `4be37fc` and primary-clone main paths for
`site/src/lib/commonswarm.ts` and `tests/p1-cli/browser-fetch-deadline.test.ts` were
measured byte-identical at reconciliation; browser runtime landed via `e753728` with
later evidence corrections on main. That does not establish hosted remove_member.

## Final gates (this frozen branch)

Recorded after mutation matrix restore + sequential pure/build/edge/site and one exclusive
`swarm run --task hosted-remove-member-final -- npm run test:p1-server` (no competing suite).

- Branch: `swarm/Onyx/hosted-remove-member-final`
- Worktree: `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Onyx--hosted-remove-member-final`
- Base: `c0dc2ca` + transplanted remove_member commits + observer/doc hygiene
- **Exact freeze SHA is not self-referenced in this file** (a commit cannot contain its own
  post-amend tip). The candidate tip is reported externally in the COMPLETE message and
  reviewer packets: `git -C <worktree> rev-parse HEAD` on the clean branch tip.
- `npm test`: **99/99** pass (`/tmp/onyx-final-gates2/npm-test.log`)
- `npm run test:p1-cli`: **131/131** pass (`/tmp/onyx-final-gates2/p1-cli.log`)
- `npm run check:tests`: pass
- `npm run build`: pass
- `npm run check:edge`: pass (command + read + capability)
- `npm run test:site`: **19/19** pass (after clean site build; `/tmp/onyx-final-gates2/test-site.log`)
- `npm --prefix site run build`: pass, 7 routes (`/tmp/onyx-final-gates/site-build.log`)
- `npm run test:p1-server`: **37/37** pass, exclusive; ledger log
  `/Users/yulanbot/.swarm/evidence/9a518dee-016e-48bb-ac28-4d29ea2f826c/hosted-remove-member-final/run-002.log`

Mutation matrix: `docs/evidence/2026-07-29-hosted-remove-member-mutations.tsv` (arms 1–11 each
RED then byte-identical production restore; per-arm logs under `/tmp/onyx-mut-logs/`).

## Explicit ceilings (not established)

- Hosted GoTrue **literal AMR array shape** on real production tokens.
- Hosted **client/server clock margin** under live NTP skew.
- Production **end-to-end remove_member** behavior after deploy.
- **Slate N1 / p1-server stale-AMR refusal arm:** harness cannot inject verified stale
  interactive AMR without broad test-only auth hooks; exclusive assertion of 401
  `fresh_auth_required` with no membership change and no idempotency row remains
  unestablished here (nonblocking).
- No deploy, land, push-to-main, or self-review claim is made in this evidence document.
