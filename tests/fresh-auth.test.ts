import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRESH_INTERACTIVE_AUTH_SECONDS,
  hasFreshInteractiveAuth,
  newestInteractiveAmrSeconds,
} from "../supabase/functions/command/fresh-auth.js";

const NOW_SECONDS = 2_000_000_000;

test("Decision 183 interactive AMR allowlist is complete", () => {
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
    assert.equal(
      newestInteractiveAmrSeconds({
        amr: [{ method, timestamp: NOW_SECONDS - 1 }],
      }),
      NOW_SECONDS - 1,
      method,
    );
  }
});

test("fresh auth uses newest interactive AMR, never refresh or JWT iat", () => {
  const claims = {
    iat: NOW_SECONDS,
    amr: [
      { method: "oauth", timestamp: NOW_SECONDS - 301 },
      { method: "token_refresh", timestamp: NOW_SECONDS },
    ],
  };
  const interactive = newestInteractiveAmrSeconds(claims);
  assert.equal(interactive, NOW_SECONDS - 301);
  assert.equal(hasFreshInteractiveAuth(interactive, NOW_SECONDS * 1000), false);
  assert.equal(
    hasFreshInteractiveAuth(
      NOW_SECONDS - FRESH_INTERACTIVE_AUTH_SECONDS,
      NOW_SECONDS * 1000,
    ),
    true,
  );
});

test("fresh auth fails closed for excluded, missing, malformed, and future AMR", () => {
  for (
    const claims of [
      {},
      { amr: null },
      { amr: [{ method: "token_refresh", timestamp: NOW_SECONDS }] },
      { amr: [{ method: "recovery", timestamp: NOW_SECONDS }] },
      { amr: [{ method: "email_change", timestamp: NOW_SECONDS }] },
      { amr: [{ method: "anonymous", timestamp: NOW_SECONDS }] },
      { amr: [{ method: "oauth", timestamp: "not-a-number" }] },
    ]
  ) {
    assert.equal(newestInteractiveAmrSeconds(claims), null);
  }
  for (const method of ["sso", "saml", "email", "signup"]) {
    assert.equal(
      newestInteractiveAmrSeconds({ amr: [{ method, timestamp: NOW_SECONDS - 1 }] }),
      null,
      `undocumented alias ${method} must fail closed`,
    );
  }
  assert.equal(
    hasFreshInteractiveAuth(NOW_SECONDS + 1, NOW_SECONDS * 1000),
    false,
  );
});
