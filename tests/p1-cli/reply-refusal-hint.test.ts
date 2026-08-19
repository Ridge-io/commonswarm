import { test } from "node:test";
import assert from "node:assert/strict";
import { replyRefusalHint } from "../../src/cli.js";
import { CommandHttpError } from "../../src/cloud/command-client.js";

/*
 * Fastio feedback 2026-08-19: `cswarm reply <own-ask-id>` surfaced a bare "HTTP 403
 * forbidden" with no next step. The hint classifies on the typed HTTP status (D-053:
 * never the message), because the server returns a generic 403 for "this reply target
 * is not one you may answer" — which replying to your own ask always is.
 */

test("a 403 on reply yields an actionable hint naming the reply-to-someone-else fix", () => {
  const hint = replyRefusalHint(new CommandHttpError(403, "command failed (HTTP 403)"));
  assert.notEqual(hint, null);
  assert.match(String(hint), /addressed to you/);
  assert.match(String(hint), /your own ask/);
  assert.match(String(hint), /cswarm ask --to|cswarm note/);
});

test("non-403 errors pass through untouched (no false hint)", () => {
  // A 500 is a real server failure, not the reply-audience case; the caller must see it.
  assert.equal(replyRefusalHint(new CommandHttpError(500, "internal_error")), null);
  assert.equal(replyRefusalHint(new CommandHttpError(404)), null);
  assert.equal(replyRefusalHint(new Error("some other failure")), null);
  assert.equal(replyRefusalHint(null), null);
});
