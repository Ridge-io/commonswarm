import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS,
  FRESH_INTERACTIVE_AUTH_SECONDS,
  hasFreshInteractiveAuth,
  newestInteractiveAmrSeconds,
} from "../supabase/functions/command/fresh-auth.js";

const NOW_SECONDS = 2_000_000_000;
const NOW_MS = NOW_SECONDS * 1000;

test("D-035 / Decision 198 interactive AMR allowlist is complete", () => {
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
  assert.equal(hasFreshInteractiveAuth(interactive, NOW_MS), false);
  assert.equal(
    hasFreshInteractiveAuth(
      NOW_SECONDS - FRESH_INTERACTIVE_AUTH_SECONDS,
      NOW_MS,
    ),
    true,
  );
});

test("fresh auth fails closed for excluded, missing, malformed AMR entries", () => {
  for (
    const claims of [
      {},
      { amr: null },
      { amr: [{ method: "token_refresh", timestamp: NOW_SECONDS }] },
      { amr: [{ method: "recovery", timestamp: NOW_SECONDS }] },
      { amr: [{ method: "email_change", timestamp: NOW_SECONDS }] },
      { amr: [{ method: "anonymous", timestamp: NOW_SECONDS }] },
      { amr: [{ method: "oauth", timestamp: "not-a-number" }] },
      // Timestamp-less RFC-style method strings cannot prove freshness.
      { amr: ["oauth", "password"] },
      { amr: ["oauth"] },
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
});

test("fresh auth age bounds: clock skew floor and 300s ceiling", () => {
  assert.equal(FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS, 5);
  assert.equal(FRESH_INTERACTIVE_AUTH_SECONDS, 300);

  // ageSeconds === -5 (interactive 5s ahead of server) accepted
  assert.equal(
    hasFreshInteractiveAuth(
      NOW_SECONDS + FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS,
      NOW_MS,
    ),
    true,
  );
  // ageSeconds < -5 rejected
  assert.equal(
    hasFreshInteractiveAuth(
      NOW_SECONDS + FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS + 1,
      NOW_MS,
    ),
    false,
  );
  // ageSeconds === 300 accepted
  assert.equal(
    hasFreshInteractiveAuth(
      NOW_SECONDS - FRESH_INTERACTIVE_AUTH_SECONDS,
      NOW_MS,
    ),
    true,
  );
  // ageSeconds > 300 rejected
  assert.equal(
    hasFreshInteractiveAuth(
      NOW_SECONDS - FRESH_INTERACTIVE_AUTH_SECONDS - 1,
      NOW_MS,
    ),
    false,
  );
});

test("fresh auth rejects malformed and nonfinite inputs", () => {
  assert.equal(hasFreshInteractiveAuth(null, NOW_MS), false);
  assert.equal(hasFreshInteractiveAuth(Number.NaN, NOW_MS), false);
  assert.equal(hasFreshInteractiveAuth(Number.POSITIVE_INFINITY, NOW_MS), false);
  assert.equal(hasFreshInteractiveAuth(NOW_SECONDS, Number.NaN), false);
  assert.equal(
    hasFreshInteractiveAuth(NOW_SECONDS, Number.POSITIVE_INFINITY),
    false,
  );
});
