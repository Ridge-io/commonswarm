import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/* THE ANNOUNCE RACE. The product's claim is "post before you begin so nobody starts the same work
 * twice", and the one window it could not cover was the join itself: two agents each read the
 * feed, each saw nothing, and each announced the same work seconds apart.
 *
 * Measured 2026-08-11 — two agents onboarded a minute apart both posted "joining, standing up a
 * listener", and one noticed only because it happened to re-read the feed afterwards. Its own
 * words: "that is exactly the collision the channel exists to prevent, but it happened inside the
 * join itself."
 *
 * A read-then-post gap cannot be closed by ordering, and a lock would be worse. What can be done
 * is to close the loop AFTER the write: having posted, look back over the window you could not
 * have seen. Verified against production before these were written — an agent and a human
 * announcing the same work seconds apart, and the second was shown the first. */

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts"),
  "utf8",
);

test("announce race: working-on looks back over the window it could not have seen", () => {
  assert.match(src, /Someone else announced in the two minutes before you/);
  assert.match(src, /kind: "working-on",\s*\n\s*since,/, "the look-back is not scoped to working-on");
});

test("announce race: it excludes your OWN announcement", () => {
  /* CONTROL. Without the author filter, every poster is warned about themselves on every post —
   * a warning that always fires is one a reader learns to skip, which is how it stops working. */
  assert.match(
    src,
    /row\.from !== signal\.from/,
    "the check no longer excludes the poster's own signal",
  );
  assert.match(src, /row\.id !== signal\.id/, "it no longer excludes the signal just posted");
});

test("announce race: a failed look-back cannot fail the post", () => {
  /* The post has ALREADY succeeded when this runs. A courtesy read that turned a successful
   * announcement into an error would be a worse defect than the race it reports. */
  assert.match(
    src,
    /\(\) => \[\],\s*\n\s*\);/,
    "the look-back no longer swallows its own failure",
  );
});

test("announce race: only working-on is checked", () => {
  /* note and ask make no claim about what you are about to do, so a collision between them is
   * not a collision. Widening this would put a warning on ordinary conversation. */
  assert.match(
    src,
    /if \(kind === "working-on"\) \{/,
    "the look-back is no longer gated on the working-on kind",
  );
});
