/**
 * ★ THIS FILE IS NAMED IN `npm test`. Bounded stderr-tail capture (D-090
 * family): the ring keeps the END of a crash log, sanitizes it, and delivers
 * it exactly once when a real child process exits.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  attachStderrTailRing,
  sanitizeStderrTail,
} from "../src/host/stderr-tail.js";

test("ring overflow keeps the TAIL, not the head", () => {
  const stream = new PassThrough();
  const ring = attachStderrTailRing(stream);
  // 8 KiB of numbered lines: far past the 4096-byte ring capacity.
  const lines: string[] = [];
  for (let index = 0; index < 400; index += 1) {
    lines.push(`line-${String(index).padStart(4, "0")}`);
  }
  stream.write(lines.join("\n"));
  const tail = ring.read();
  assert.ok(tail.includes("line-0399"), "the final line must survive");
  assert.doesNotMatch(tail, /line-0000/, "the first line must be discarded");
  // Mutation control for the bound itself: remove the ring cap (or the
  // TAIL_MAX_CHARS slice) and this assertion fails.
  assert.ok(tail.length <= 2_048, `tail exceeds its bound: ${tail.length}`);
});

test("sanitizer strips ANSI and control characters but keeps newline and tab", () => {
  const raw = "\u001b[31mError:\u001b[0m\tworker died\r\nbell\u0007 end";
  const clean = sanitizeStderrTail(raw);
  assert.equal(clean.includes("\u001b"), false, "ANSI escape survived");
  assert.equal(clean.includes("\u0007"), false, "BEL survived");
  assert.ok(clean.includes("\t"), "tab must survive");
  assert.ok(clean.includes("\n"), "newline must survive");
  assert.match(clean, /Error:\tworker died/);
});

test("sanitizer redacts credential-shaped substrings so the event validator cannot drop the line", () => {
  const raw = "auth failed for swm_agt_AbC123-xyz retrying\n";
  const clean = sanitizeStderrTail(raw);
  assert.doesNotMatch(clean, /swm_agt_/i);
  assert.match(clean, /\[redacted-credential\]/);
  // Control: the surrounding diagnostic text must survive the redaction.
  assert.match(clean, /auth failed for .* retrying/);
});

test("sanitizer output is bounded at 2048 characters and keeps the end", () => {
  const raw = `HEAD-${"x".repeat(5_000)}-TAIL`;
  const clean = sanitizeStderrTail(raw);
  assert.equal(clean.length <= 2_048, true);
  assert.ok(clean.endsWith("-TAIL"));
  assert.doesNotMatch(clean, /HEAD-/);
});

test("a real child that writes stderr and dies delivers one sanitized tail, exactly once across exit and close", async () => {
  /* The exact wiring every host uses in place of the old drain: ring on
   * stderr, one latched callback registered on BOTH "exit" (so the tail is
   * available synchronously with the event the failure derives from) and
   * "close" (fallback). The child sleeps briefly after writing so the pipe
   * data reaches the parent before exit — the mechanism under test is the
   * latch and sanitize, not the kernel's delivery order. */
  const child = spawn(process.execPath, [
    "-e",
    'process.stderr.write("\\u001b[31mfatal:\\u001b[0m provider crashed\\n");' +
      "setTimeout(() => process.exit(7), 50);",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const tails: string[] = [];
  const ring = attachStderrTailRing(child.stderr!);
  let delivered = false;
  const publishTail = () => {
    if (delivered) return;
    delivered = true;
    tails.push(ring.read());
  };
  child.once("exit", publishTail);
  child.once("close", publishTail);
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", (exitCode) => resolve(exitCode));
  });
  // Both events have fired by "close"; give the latch handlers a turn.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(code, 7);
  assert.equal(tails.length, 1, "the tail must be delivered exactly once");
  assert.match(tails[0]!, /fatal: provider crashed/);
  assert.doesNotMatch(tails[0]!, /\u001b/);
});

test("a credential bisected by ring eviction does not survive as an unrecognizable suffix", () => {
  /* The eviction cut can land mid-token, leaving a suffix that no longer
   * matches the swm_ prefix. The ring must therefore never keep a truncated
   * first line: it drops to the next newline boundary after any eviction. */
  const stream = new PassThrough();
  const ring = attachStderrTailRing(stream);
  const token = `swm_agt_${"S".repeat(40)}`; // 48 chars, then a newline
  /* Sized so the 4096-byte eviction cut lands INSIDE the token payload: the
   * bytes after the token must total between 4048 and 4094, putting the cut
   * 1..47 bytes into the 49-byte token line. Anything before the token is
   * evicted whole and only widens the margin. */
  /* Multi-byte payload, deliberately: 4096 BYTES of ASCII decode to 4096
   * CHARS, and the sanitizer's final 2048-char slice would remove the front
   * suffix anyway, masking the boundary drop under test. Three-byte CJK gives
   * ~1400 chars for the same bytes, so the bisected suffix survives the char
   * slice and only the line-boundary drop can remove it. */
  let after = "";
  // 31-byte lines land the total in (4048, 4094) after the 12-byte last line.
  while (Buffer.byteLength(after, "utf8") < 4_050) {
    after += `${"\u6c49".repeat(10)}\n`;
  }
  after += "last-line-ok";
  const afterBytes = Buffer.byteLength(after, "utf8");
  assert.ok(afterBytes > 4_047 && afterBytes < 4_095, `bad geometry: ${afterBytes}`);
  stream.write(`filler-head\n${token}\n${after}`);
  const tail = ring.read();
  // Positive control that eviction actually ran: the head is gone.
  assert.doesNotMatch(tail, /filler-head/, "no eviction happened; the test reached nothing");
  assert.doesNotMatch(tail, /swm_/i);
  assert.doesNotMatch(tail, /SSSS/, "a bisected token suffix survived eviction");
  assert.match(tail, /last-line-ok/, "content after the boundary must survive");
});

test("separators inside a token do not defeat the redactor", () => {
  /* Each case laces a credential with a separator the shared class must treat
   * as invisible-within-a-token: the strip deletes it so the token reassembles
   * and the redactor eats the whole thing. Every listed fragment must vanish;
   * the surrounding "auth ... failed" must survive. */
  const cases: Array<[string, string, string[]]> = [
    ["embedded CR", "auth swm_agt_AB\rCDEF failed\n", ["CDEF"]],
    ["zero-width space", "auth swm_\u200bagt_ZWTOKEN failed\n", ["ZWTOKEN"]],
    ["ANSI lacing", "auth swm_\u001b[31magt_ANSITOKEN\u001b[0m failed\n", ["ANSITOKEN"]],
    ["unusual charset run", "auth swm_agt_abc.def+ghi failed\n", ["def+ghi"]],
    ["NBSP U+00A0", "auth swm_agt_NBA\u00a0NBB failed\n", ["NBA", "NBB"]],
    ["en-quad U+2000", "auth swm_agt_ENA\u2000ENB failed\n", ["ENA", "ENB"]],
    ["line separator U+2028", "auth swm_agt_LSA\u2028LSB failed\n", ["LSA", "LSB"]],
    ["narrow NBSP U+202F", "auth swm_agt_NNA\u202fNNB failed\n", ["NNA", "NNB"]],
  ];
  for (const [label, raw, fragments] of cases) {
    const clean = sanitizeStderrTail(raw);
    assert.doesNotMatch(clean, /swm_/i, `${label}: prefix survived`);
    for (const fragment of fragments) {
      assert.equal(
        clean.includes(fragment),
        false,
        `${label}: token payload "${fragment}" survived`,
      );
    }
    assert.match(clean, /auth .*failed/, `${label}: surrounding text lost`);
  }
});

test("a single unterminated line too long for the ring is dropped WHOLE, not truncated-and-kept", () => {
  /* STRUCTURAL (final round): when eviction cuts a line and there is no newline
   * in the retained region, the entire partial line is dropped. This closes
   * every straddle-at-the-cut leak regardless of which separator sits at the
   * byte boundary — no partial line survives to be redacted. */
  const stream = new PassThrough();
  const ring = attachStderrTailRing(stream);
  const token = `swm_agt_${"Q".repeat(40)}`;
  // One line, no newline anywhere, longer than the 4096-byte ring: the cut
  // lands with no newline boundary, so the whole partial line is dropped.
  stream.write(`${"X".repeat(6_000)}${token}${"Y".repeat(200)}`);
  const tail = ring.read();
  assert.equal(tail, "", "a bisected unterminated line must be dropped entirely");

  // Positive control: the SAME token in a line UNDER the ring cap (no eviction)
  // is kept, with the token redacted — proving the emptiness above is caused by
  // eviction, not by a rule that always empties single lines.
  const small = new PassThrough();
  const smallRing = attachStderrTailRing(small);
  small.write(`prefix ${token} suffix`);
  const kept = smallRing.read();
  assert.match(kept, /prefix .*suffix/, "an un-evicted line must be kept");
  assert.doesNotMatch(kept, /swm_/i, "the token in a kept line is still redacted");
});

