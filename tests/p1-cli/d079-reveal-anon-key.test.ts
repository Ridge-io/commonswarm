import assert from "node:assert/strict";
import { test } from "node:test";
import { currentTargetSummary } from "../../src/cloud/current-target.js";

/* D-079. Agent credentials deliberately never inherit a human's saved target, and the refusal
 * names `--url` and `--anon-key`. But `target show` returned only a FINGERPRINT, so the CLI
 * demanded a value no command would give. Wren, onboarding an agent on a second machine, closed
 * the gap by reading `~/.cswarm/credentials.d/current-target.json` directly — which is the
 * outcome fingerprinting was presumably meant to prevent.
 *
 * There was no secret to protect: the anon key is RLS-protected and published in a
 * `commonswarm:anon-key` meta tag on every page of commonswarm.com.
 *
 * The default stays fingerprinted anyway. That is not timidity — a 208-character JWT emitted by
 * default lands in logs and pasted issues, and `supabase projects api-keys` prints the
 * SERVICE-ROLE key two rows below the anon key, so "cswarm prints keys" is a habit worth not
 * forming. Revealing is an explicit act. */

const TARGET = {
  url: "https://example.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiJ9.anon-key-body-that-is-long.sig",
} as never;

test("D-079: the default omits the key, so the existing control stays true", () => {
  const summary = currentTargetSummary(TARGET);

  assert.equal("anon_key" in summary, false);
  assert.ok(summary.anon_key_fingerprint.length > 0);
  // The whole object must not carry the key by another name either.
  assert.doesNotMatch(JSON.stringify(summary), /anon-key-body/);
});

test("D-079: reveal returns the key, which is what closes the dead end", () => {
  const summary = currentTargetSummary(TARGET, true);

  assert.equal(summary.anon_key, (TARGET as unknown as { anonKey: string }).anonKey);
  // CONTROL: the fingerprint survives revealing. If reveal replaced it rather than adding to it,
  // the assertion above would pass while breaking every caller that compares targets at a glance.
  assert.ok(summary.anon_key_fingerprint.length > 0);
});

test("D-079: the fingerprint is not the key, in either mode", () => {
  // Without this, a fingerprint implementation that returned the key verbatim would satisfy both
  // tests above — the default test only checks the FIELD is absent, not that the value is.
  for (const reveal of [false, true]) {
    const summary = currentTargetSummary(TARGET, reveal);
    assert.notEqual(
      summary.anon_key_fingerprint,
      (TARGET as unknown as { anonKey: string }).anonKey,
    );
  }
});
