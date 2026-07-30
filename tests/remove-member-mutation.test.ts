import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("remove_member edge security seams remain reachable and fail closed", async () => {
  const source = await readFile(
    "supabase/functions/command/index.ts",
    "utf8",
  );
  assert.match(source, /"remove_member",\s*\n\s*"create_agent_principal"/);
  assert.equal(
    (source.match(/"remove_member",\s*\n\s*"create_agent_principal"/g) ?? [])
      .length,
    2,
    "remove_member must remain in both the global and human-connect registries",
  );
  assert.match(
    source,
    /exactKeys\(cmd, \["kind", "user_id"\]\)/,
  );
  assert.match(source, /authClient\.auth\.getClaims\(credential\)/);
  assert.match(source, /newestInteractiveAmrSeconds\(claimsData\.claims\)/);
  assert.match(source, /hasFreshInteractiveAuth\(/);
  assert.match(source, /reason: "fresh_auth_required"/);
  assert.match(source, /FROM swarm\.repositories/);
  assert.match(source, /landing_authority_user_id = \$\{wire\.user_id\}/);
  assert.doesNotMatch(
    source,
    /landingAuthorityChangeResolved:\s*\(\)\s*=>\s*true/,
  );
  assert.match(source, /event\.type === "MemberRemoved"/);
  assert.match(source, /updated\.length !== 1/);
  assert.match(
    source,
    /SET revoked_at = \$\{new Date\(payload\.revoked_at\)\}/,
  );
  assert.match(
    source,
    /event\.type === "MemberRemoved"[\s\S]*?UPDATE swarm\.memberships[\s\S]*?WHERE workspace_id = \$\{route\.workspaceId\}::uuid[\s\S]*?AND user_id = \$\{payload\.user_id\}::uuid[\s\S]*?AND revoked_at IS NULL[\s\S]*?RETURNING user_id/,
    "MemberRemoved projection must stay scoped to one live membership in the routed workspace",
  );
});

test("fresh-auth helper cannot be weakened to JWT iat or token refresh", async () => {
  const source = await readFile(
    "supabase/functions/command/fresh-auth.ts",
    "utf8",
  );
  assert.match(source, /FRESH_INTERACTIVE_AUTH_SECONDS = 300/);
  assert.match(source, /FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS = 5/);
  assert.match(
    source,
    /ageSeconds >= -FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS/,
  );
  assert.doesNotMatch(source, /token_refresh/);
  assert.doesNotMatch(source, /\.iat\b/);
  for (
    const method of [
      "oauth",
      "password",
      "otp",
      "totp",
      "sso/saml",
      "magiclink",
      "email/signup",
    ]
  ) {
    assert.match(source, new RegExp(`"${method}"`));
  }
  for (const alias of ["sso", "saml", "email", "signup"]) {
    assert.doesNotMatch(source, new RegExp(`"${alias}"`));
  }
});

test("idempotency replay is resolved before remove_member fresh-auth refusal", async () => {
  const source = await readFile(
    "supabase/functions/command/index.ts",
    "utf8",
  );
  // Pin the live command path: step 7 is the idempotency lookup/replay, and
  // remove_member freshness must only run after that step completes. An earlier
  // existingRows in another route must not mask a reordered fresh-auth gate.
  const step7 = source.indexOf("await beforeStep(7);");
  assert.ok(step7 >= 0, "idempotency step 7 must remain reachable");
  const afterStep7 = source.indexOf("await afterStep(7);", step7);
  assert.ok(afterStep7 > step7, "idempotency step 7 must complete");
  const between = source.slice(step7, afterStep7);
  assert.match(
    between,
    /SELECT workspace_id, stream_id, request_hash, response\s+FROM swarm\.idempotency_keys/,
  );
  assert.match(
    between,
    /\? replayResult\(storedResponse\(existing\.response\), kind\)/,
  );
  assert.doesNotMatch(
    between,
    /command\.kind === "remove_member"/,
    "remove_member fresh-auth must not run inside the idempotency step",
  );
  const after = source.slice(afterStep7, afterStep7 + 900);
  assert.match(
    after,
    /if \(command\.kind === "remove_member"\) \{\s*const serverTime = await tx/,
    "remove_member fresh-auth must immediately follow idempotency completion",
  );
  assert.match(after, /hasFreshInteractiveAuth\(/);
});

test("fresh-login refusal preserves pending remove_member command id", async () => {
  const source = await readFile("src/cloud/pending-command.ts", "utf8");
  const start = source.indexOf(
    "if (error instanceof ReauthenticationRequired) {",
  );
  assert.ok(start >= 0, "ReauthenticationRequired branch must remain reachable");
  const end = source.indexOf("}", start);
  const block = source.slice(start, end + 1);
  assert.match(block, /throw error;/);
  assert.doesNotMatch(
    block,
    /clearPendingCommand/,
    "ReauthenticationRequired must not clear the pending command id",
  );
  assert.match(
    source,
    /A fresh-login refusal is explicitly not ledgered/,
  );
});

test("MemberRemoved event timestamp is the projection write timestamp", async () => {
  const commands = await readFile("src/protocol/workspace-commands.ts", "utf8");
  const edge = await readFile(
    "supabase/functions/command/index.ts",
    "utf8",
  );
  assert.match(
    commands,
    /case 'remove_member':[\s\S]*?env\(ctx, 'MemberRemoved', \{ user_id: cmd\.user_id, revoked_at: ctx\.now \}/,
  );
  assert.match(
    edge,
    /SET revoked_at = \$\{new Date\(payload\.revoked_at\)\}/,
  );
});
