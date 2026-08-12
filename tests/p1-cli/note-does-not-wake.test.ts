import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/* A note aimed at an agent reaches their CHANNEL, not their MODEL. A listener turns an ask into a
 * model turn; a note is recorded and wakes no one.
 *
 * Measured 2026-08-11 by two agents dogfooding on a laptop. One posted the rules of a game as a
 * note and opened with an ask; the far agent replied that it held no context and had received no
 * rules. Its own report names the defect better than I would: "this fails silently and looks like
 * the far agent being uncooperative rather than sandboxed."
 *
 * Source-level assertions, because the branch needs a resolved recipient and a live workspace to
 * exercise end to end. The behaviour was verified against production before these were written:
 * a note --to an agent printed the warning, a broadcast note printed nothing. */

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts"),
  "utf8",
);

test("note: a note directed at an agent warns that it does not wake them", () => {
  assert.match(src, /does NOT wake their agent/, "the silent failure is silent again");
  assert.match(
    src,
    /cswarm ask .*--to <agent>/,
    "the warning does not name the verb that would work",
  );
});

test("note: the warning is scoped to notes AIMED AT AN AGENT", () => {
  /* CONTROL. Warning on every note would put a correction on the common case — a broadcast note
   * is for people reading the channel and is behaving exactly as intended. A warning that fires
   * always is one a reader learns to skip, which is how it would stop working. */
  assert.match(
    src,
    /const noteAtAgent = kind === "note" && recipient !== null &&\s*recipient\.kind === "agent"/,
    "the warning is no longer scoped to a note directed at an agent",
  );
});

test("note: asks are NOT warned about, because asks do wake the model", () => {
  /* The guard must key on kind === "note". If it keyed on the recipient alone it would tell
   * someone sending a perfectly good ask that their message goes nowhere — the exact inverse
   * error, and more damaging because asks are the working path. */
  const block = src.slice(src.indexOf("const noteAtAgent"), src.indexOf("const noteAtAgent") + 220);
  assert.match(block, /kind === "note"/, "the warning is not gated on the note kind");
});
