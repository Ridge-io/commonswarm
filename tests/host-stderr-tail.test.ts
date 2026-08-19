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

test("a real child that writes stderr and dies delivers one sanitized tail on close", async () => {
  // The exact wiring every host uses in place of the old drain: ring on
  // stderr, callback once on "close" (stderr fully flushed by then).
  const child = spawn(process.execPath, [
    "-e",
    'process.stderr.write("\\u001b[31mfatal:\\u001b[0m provider crashed\\n"); process.exit(7);',
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const tails: string[] = [];
  const ring = attachStderrTailRing(child.stderr!);
  child.once("close", () => tails.push(ring.read()));
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", (exitCode) => resolve(exitCode));
  });
  // Let the once-handler above run regardless of registration order.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(code, 7);
  assert.equal(tails.length, 1, "the tail must be delivered exactly once");
  assert.match(tails[0]!, /fatal: provider crashed/);
  assert.doesNotMatch(tails[0]!, /\u001b/);
});
