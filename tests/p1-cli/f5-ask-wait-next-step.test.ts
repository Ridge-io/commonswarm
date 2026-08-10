import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASK_WAIT_TIMEOUT_MESSAGE,
  askWaitJsonPayload,
} from "../../src/cloud/signals.js";

/* F-5 of the 2026-08-10 dogfood.
 *
 * `cswarm ask --wait` timed out and said "the ask remains live" — true, and it left the reader
 * with nothing to do. That is the defect Wren and Joist recorded on `listen stop`: a correct
 * state word in a success-shaped response, which a reader skims past. The fix there was to name
 * the confirming command, and this is the same shape.
 *
 * `cswarm inbox` is verified, not guessed: the run posted an ask, replied to it, and read the
 * reply back from the asker's inbox. */

test("F-5: the ask-wait timeout names the command that answers it", () => {
  assert.match(ASK_WAIT_TIMEOUT_MESSAGE, /cswarm inbox/, "no next step is given");
  assert.match(
    ASK_WAIT_TIMEOUT_MESSAGE,
    /remains live/,
    "the state it already stated correctly was dropped",
  );
});

test("F-5: the JSON surface and the human surface cannot drift", () => {
  /* CONTROL, and the reason this is a constant rather than two edits. workspaces.ts records the
   * incident: a reviewer changed the message at ONE json site, left the renderer alone, and every
   * test passed while the two surfaces said different things. A test naming one cannot see the
   * other, so the gate is that they are the SAME object. */
  const payload = askWaitJsonPayload(
    { id: "x" } as never,
    null,
    true,
  ) as Record<string, unknown>;

  assert.equal(
    payload.message,
    ASK_WAIT_TIMEOUT_MESSAGE,
    "the JSON surface no longer reads the shared constant",
  );
});

test("F-5: a reply that DID arrive is not given the timeout text", () => {
  /* Over-fix control: pointing every ask-wait at the inbox would be wrong when the reply is
   * already in hand and printed directly above. */
  const payload = askWaitJsonPayload(
    { id: "x" } as never,
    { id: "y" } as never,
    false,
  ) as Record<string, unknown>;

  assert.notEqual(payload.message, ASK_WAIT_TIMEOUT_MESSAGE);
  assert.doesNotMatch(String(payload.message), /cswarm inbox/);
});
