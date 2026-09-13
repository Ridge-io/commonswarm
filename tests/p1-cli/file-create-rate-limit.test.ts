/**
 * The acceptable-use page publishes FILE_CREATE_RATE_LIMIT_PER_HOUR as a typed sentence, and
 * AGENTS.md requires that a user-facing number come from the enforcement it describes. A direct
 * import is not available here: the constant lives in a Deno edge module that pulls postgres and
 * the generated protocol bundle, and `tsconfig.json` covers only `src/`. This gate reads both
 * files instead and fails when the published number and the enforced constant disagree.
 *
 * Gate: `npm run test:p1-cli` (globs tests/p1-cli/**\/*.test.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, root)), "utf8");
}

test("acceptable-use publishes the enforced file-create hourly cap", () => {
  const edge = read("supabase/functions/command/file-artifacts.ts");
  const page = read("site/src/pages/acceptable-use.astro");
  const enforced = /^export const FILE_CREATE_RATE_LIMIT_PER_HOUR = (\d+);$/m.exec(edge)?.[1];
  const published = /and (\d+) version creates per principal per hour/.exec(page)?.[1];
  assert.ok(enforced, "FILE_CREATE_RATE_LIMIT_PER_HOUR is missing from file-artifacts.ts");
  assert.ok(published, "acceptable-use no longer carries the file-create hourly cap sentence");
  assert.equal(
    Number(published),
    Number(enforced),
    `acceptable-use publishes ${published} version creates per principal per hour; the edge enforces ${enforced}`,
  );
});

test("the acceptable-use comment points at the line the constant is really on", () => {
  const edge = read("supabase/functions/command/file-artifacts.ts").split("\n");
  const page = read("site/src/pages/acceptable-use.astro");
  const actual = edge.findIndex((l) => l.startsWith("export const FILE_CREATE_RATE_LIMIT_PER_HOUR")) + 1;
  const cited = /FILE_CREATE_RATE_LIMIT_PER_HOUR, :(\d+)/.exec(page)?.[1];
  assert.ok(actual > 0, "FILE_CREATE_RATE_LIMIT_PER_HOUR is missing from file-artifacts.ts");
  assert.ok(cited, "acceptable-use no longer cites a line for FILE_CREATE_RATE_LIMIT_PER_HOUR");
  assert.equal(Number(cited), actual, `acceptable-use cites :${cited}; the constant is on line ${actual}`);
});

/* Grok's checker arm, 2026-09-12: the two gates above still pass if the ENFORCEMENT stops reading
 * the constant and hardcodes a number, and they ignore the same figure in the page's own pointer
 * comment. Both are the drift this file exists to catch, so both get a control. */

test("the edge enforcement reads the constant rather than a literal", () => {
  const index = read("supabase/functions/command/index.ts");
  const guard = /if \(bucket\.count > FILE_CREATE_RATE_LIMIT_PER_HOUR\)/.test(index);
  const passed = /incrementRateBucket\([\s\S]{0,200}?FILE_CREATE_RATE_LIMIT_PER_HOUR,/.test(index);
  assert.ok(guard, "the file-create refusal no longer compares against FILE_CREATE_RATE_LIMIT_PER_HOUR");
  assert.ok(passed, "incrementRateBucket is no longer given FILE_CREATE_RATE_LIMIT_PER_HOUR as its limit");
});

test("the acceptable-use pointer comment carries the enforced number too", () => {
  const edge = read("supabase/functions/command/file-artifacts.ts");
  const page = read("site/src/pages/acceptable-use.astro");
  const enforced = /^export const FILE_CREATE_RATE_LIMIT_PER_HOUR = (\d+);$/m.exec(edge)?.[1];
  const inComment = /\*\s+(\d+) version creates \/ principal \/ hour/.exec(page)?.[1];
  assert.ok(enforced, "FILE_CREATE_RATE_LIMIT_PER_HOUR is missing from file-artifacts.ts");
  assert.ok(inComment, "the acceptable-use pointer comment no longer carries the file-create cap");
  assert.equal(Number(inComment), Number(enforced),
    `the pointer comment says ${inComment}; the edge enforces ${enforced}`);
});
