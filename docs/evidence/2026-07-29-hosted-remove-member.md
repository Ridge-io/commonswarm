# Hosted remove-member evidence

## Contract

- Base under review freeze: `c0dc2ca8dcd2495dc4b41f375c2059c6208bc772`.
- Removal is workspace-scoped and never writes a global tombstone.
- An active repository mapping that names the target as landing authority
  refuses with `landing_authority_unresolved`; this command never transfers or
  rewrites repository authority.
- Fresh authentication is 300 seconds from the newest interactive AMR in
  verified claims for the presented session. Decision #183 allows
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

## Pure gates after rebase

- `npm test`: 94 passed.
- `npm run test:p1-cli`: 130 passed.
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
observer now requires both global and human-connect entries. A clean full
server rerun is pending release of the main/DB freeze.

## Remaining immutable-candidate work

- Clean full `npm run test:p1-server` under an announced exclusive DB slot.
- Re-run all required gates/mutations if the base changes.
- Commit the final evidence, freeze one SHA, push the task branch, and obtain
  substantive Grok/xAI and agy/Gemini reviews of that exact SHA.
- No landing or deployment is authorized.
