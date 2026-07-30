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
  assert.match(source, /hasFreshInteractiveAuth\(/);
  assert.match(source, /reason: "fresh_auth_required"/);
  assert.match(source, /FROM swarm\.repositories/);
  assert.match(source, /landing_authority_user_id = \$\{wire\.user_id\}/);
  assert.doesNotMatch(source, /landingAuthorityChangeResolved:\s*\(\)\s*=>\s*true/);
  assert.match(source, /event\.type === "MemberRemoved"/);
  assert.match(source, /updated\.length !== 1/);
  assert.match(source, /SET revoked_at = \$\{new Date\(payload\.revoked_at\)\}/);
});

test("fresh-auth helper cannot be weakened to JWT iat or token refresh", async () => {
  const source = await readFile(
    "supabase/functions/command/fresh-auth.ts",
    "utf8",
  );
  assert.match(source, /FRESH_INTERACTIVE_AUTH_SECONDS = 300/);
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
