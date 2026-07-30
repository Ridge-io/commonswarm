# Hosted remove-member evidence

## Contract

- Base under review freeze: `c0dc2ca8dcd2495dc4b41f375c2059c6208bc772`.
- Removal is workspace-scoped and never writes a global tombstone.
- An active repository mapping that names the target as landing authority
  refuses with `landing_authority_unresolved`; this command never transfers or
  rewrites repository authority.
- Fresh authentication is 300 seconds from the newest interactive AMR in
  verified claims for the presented session. Active swarm Decision #198 allows
  `oauth`, `password`, `otp`, `totp`, `sso/saml`, `magiclink`, and `email/signup`;
  refresh/recovery/email-change/anonymous/missing/malformed/future
  methods fail closed. JWT `iat` and global sign-in timestamps are not used.
- Idempotency replay precedes the fresh-auth gate. A stale first attempt is
  audit-only and unledgered; the CLI preserves that command ID for the explicit
  post-login retry.

## Implemented seams

- Strict global kind registration and `{kind,user_id}` wire validation.
- Human-only workspace routing with uniform agent denial.
- Repository-backed landing-authority oracle.
- `MemberRemoved` projection updates exactly one live membership using the
  event timestamp.
- Typed command client, exact member selector, explicit CLI confirmation, JSON
  output, and named recovery.
- Thin browser member roster with role-aware removal, explicit confirmation,
  GitHub/email reauthentication, and no automatic action after redirect.
- Reachable unit, mutation, CLI, dashboard observer, and p1-server coverage.

## Pure gates before the final observer commit

- `npm test`: 94 passed.
- `npm run test:p1-cli`: 131 passed.
- `npm run check:tests`: passed.
- `npm run check:edge`: passed.
- `npm run build`: passed.
- `npm --prefix site run build`: 7 routes built.
- `npm run test:site`: 19 passed.
- Mutation observers cover both kind registries, strict validation, verified
  claims, AMR policy, the real oracle, exact projection, browser API reachability,
  explicit confirmation, and no post-login automatic removal.

## Exclusive server gate

The first full run on the earlier approved base passed 35/37 tests. Both new
tests returned HTTP 400 and discriminated a missing `remove_member` entry in
the global `COMMAND_KINDS` registry. The registry was fixed and a mutation
observer now requires both global and human-connect entries.

The sole-runner rerun at `2e1dac9ebef19a4e442f5d4b9f174716bcd77eab`
is durable swarm task run 019: 37/37 passed, including both `remove_member`
server cases. Runs 017 and 018 are invalid because two Lead7 sessions
overlapped on the shared database and contaminated the pre-auth log observer;
they are not counted. The final observer-only SHA still requires a sole-runner
server rerun before review and landing.

## Measured production mutations

Each arm changed production source, made its named observer fail, and was then
restored. The restored production files matched their pre-mutation SHA-256
hashes before the observer commit.

| Mutated seam | Discriminating result |
|---|---|
| Remove the global `remove_member` registry entry | root observer red: registry count 1, expected 2 |
| Replace literal `sso/saml` with alias `sso` | fresh-auth observer red: required literal absent |
| Admit `token_refresh` as interactive AMR | task run 020 red |
| Replace verified `getClaims` with an unverified user read | task run 021 red |
| Hardcode the landing-authority oracle to true | task run 022 red |
| Drop `workspace_id` from `MemberRemoved` projection | task run 023 red |
| Drop the exact-one projection row-count guard | task run 024 red |
| Bypass browser confirmation | task run 026 red |
| Remove the browser command API call | task run 027 red |
| Disconnect both browser reauthentication actions | task run 028 red |
| Clear the pending command on `ReauthenticationRequired` | task run 029 red |
| Move fresh-auth refusal ahead of idempotency replay | task run 030 red |

Task run 025 is an intentionally uncounted harness invocation with the wrong
relative test path; it established nothing and was immediately repeated
correctly as run 026.

## Final immutable-candidate gate

The exact final SHA, complete gate logs, substantive independent Grok verdict,
and structured agy/Gemini verdict live in the swarm task ledger so this
committed evidence does not require a self-referential post-gate edit. Landing
and deployment are permitted only after both review arms approve the same SHA;
any code change requires both reviews again.

Local tests establish fail-closed behavior for the allowed and rejected claim
shapes; they do not establish which AMR values the hosted Supabase project
actually emits. A controlled hosted fresh-login removal must therefore be part
of post-deploy verification. Until that succeeds, hosted interactive removal
remains explicitly not established.
