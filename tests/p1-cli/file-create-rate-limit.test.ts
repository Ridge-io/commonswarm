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
  const published = /(?:and |, )?(\d+) version creates per principal per hour/.exec(page)?.[1];
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

/* Codex's checker arm, round two: the figure in the design document's enforcement table is typed
 * by hand and no gate reads it. It is the copy this repo has already let drift once. */

test("the file-artifacts design doc publishes the enforced hourly cap", () => {
  const edge = read("supabase/functions/command/file-artifacts.ts");
  const doc = read("docs/design/2026-08-18-FILE-ARTIFACTS.md");
  const enforced = /^export const FILE_CREATE_RATE_LIMIT_PER_HOUR = (\d+);$/m.exec(edge)?.[1];
  const documented = /\|\s*upload rate\s*\|\s*(\d+) version-creates per principal per hour/.exec(doc)?.[1];
  assert.ok(enforced, "FILE_CREATE_RATE_LIMIT_PER_HOUR is missing from file-artifacts.ts");
  assert.ok(documented, "the design doc's enforcement table no longer states the upload rate");
  assert.equal(Number(documented), Number(enforced),
    `docs/design/2026-08-18-FILE-ARTIFACTS.md documents ${documented}/hour; the edge enforces ${enforced}`);
});

/* Codex's checker arm, round three: the comment claims a REFUSED create still spends from the
 * bucket. That is only true while the bucket increment precedes the create call, and no control
 * bound the ordering — moving validation above the bucket block left every other gate green. */

test("the rate bucket is spent before the create runs, so refusals count", () => {
  const index = read("supabase/functions/command/index.ts");
  const bucket = index.indexOf("`file:create:${auth.credentialKind}:${rateIdentity}`");
  const create = index.indexOf("fileVersionCreate", bucket === -1 ? 0 : bucket);
  assert.ok(bucket > 0, "the file-create rate bucket key is gone; the comment above the constant describes it");
  assert.ok(
    create > bucket,
    "fileVersionCreate now runs before the file:create rate bucket is incremented, so a refused "
      + "attempt no longer spends from it — the comment on FILE_CREATE_RATE_LIMIT_PER_HOUR says it does",
  );
});

/* Item C: workspace file-create fairness ceiling controls (docs/design/SWARM-CLOUD.md §2.8). */

test("acceptable-use publishes the enforced file-create workspace hourly ceiling", () => {
  const edge = read("supabase/functions/command/file-artifacts.ts");
  const page = read("site/src/pages/acceptable-use.astro");
  const enforced = /^export const FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR = (\d+);$/m.exec(edge)?.[1];
  const published = /and ([\d,]+) version creates per workspace per hour/.exec(page)?.[1]?.replace(/,/g, "");
  assert.ok(enforced, "FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR is missing from file-artifacts.ts");
  assert.ok(published, "acceptable-use no longer carries the workspace file-create ceiling sentence");
  assert.equal(
    Number(published),
    Number(enforced),
    `acceptable-use publishes ${published} version creates per workspace per hour; the edge enforces ${enforced}`,
  );
});

test("the acceptable-use comment points at the line FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR is really on", () => {
  const edge = read("supabase/functions/command/file-artifacts.ts").split("\n");
  const page = read("site/src/pages/acceptable-use.astro");
  const actual = edge.findIndex((l) => l.startsWith("export const FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR")) + 1;
  const cited = /FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR, :(\d+)/.exec(page)?.[1];
  assert.ok(actual > 0, "FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR is missing from file-artifacts.ts");
  assert.ok(cited, "acceptable-use no longer cites a line for FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR");
  assert.equal(Number(cited), actual, `acceptable-use cites :${cited}; the constant is on line ${actual}`);
});

test("the edge enforcement reads FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR rather than a literal", () => {
  const index = read("supabase/functions/command/index.ts");
  const guard = /if \(wsBucket\.count > FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR\)/.test(index);
  const passed = /incrementRateBucket\([\s\S]{0,200}?FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR,/.test(index);
  assert.ok(guard, "the workspace file-create refusal no longer compares against FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR");
  assert.ok(passed, "incrementRateBucket is no longer given FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR as its limit");
});

test("the acceptable-use pointer comment carries the enforced workspace number too", () => {
  const edge = read("supabase/functions/command/file-artifacts.ts");
  const page = read("site/src/pages/acceptable-use.astro");
  const enforced = /^export const FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR = (\d+);$/m.exec(edge)?.[1];
  const inComment = /\*\s+([\d,]+) version creates \/ ws \/ hour/.exec(page)?.[1]?.replace(/,/g, "");
  assert.ok(enforced, "FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR is missing from file-artifacts.ts");
  assert.ok(inComment, "the acceptable-use pointer comment no longer carries the workspace file-create ceiling");
  assert.equal(Number(inComment), Number(enforced),
    `the pointer comment says ${inComment}; the edge enforces ${enforced}`);
});

test("the file-artifacts design doc publishes the enforced workspace ceiling", () => {
  const edge = read("supabase/functions/command/file-artifacts.ts");
  const doc = read("docs/design/2026-08-18-FILE-ARTIFACTS.md");
  const enforced = /^export const FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR = (\d+);$/m.exec(edge)?.[1];
  const documented = /\|\s*workspace upload ceiling\s*\|\s*(\d+) version-creates per workspace per hour/.exec(doc)?.[1];
  assert.ok(enforced, "FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR is missing from file-artifacts.ts");
  assert.ok(documented, "the design doc's enforcement table no longer states the workspace upload ceiling");
  assert.equal(Number(documented), Number(enforced),
    `docs/design/2026-08-18-FILE-ARTIFACTS.md documents ${documented}/hour; the edge enforces ${enforced}`);
});

test("the workspace rate bucket is spent before the create runs, so refusals count", () => {
  const index = read("supabase/functions/command/index.ts");
  const wsBucket = index.indexOf("`file:create:ws:${route.workspaceId}`");
  const create = index.indexOf("fileVersionCreate", wsBucket === -1 ? 0 : wsBucket);
  assert.ok(wsBucket > 0, "the workspace file-create rate bucket key is gone");
  assert.ok(
    create > wsBucket,
    "fileVersionCreate now runs before the file:create:ws rate bucket is incremented, so a refused "
      + "attempt no longer spends from it — the comment on FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR says it does",
  );
});

test("storage bucket migration file_size_limit matches FILE_MAX_VERSION_BYTES", () => {
  const edge = read("supabase/functions/command/file-artifacts.ts");
  const migration = read("supabase/migrations/20260913000001_file_bucket_size_limit.sql");
  const expr = /^export const FILE_MAX_VERSION_BYTES = ([^;]+);$/m.exec(edge)?.[1];
  assert.ok(expr, "FILE_MAX_VERSION_BYTES is missing from file-artifacts.ts");
  const expectedBytes = Function(`"use strict"; return (${expr});`)() as number;
  const setLimit = /file_size_limit\s*=\s*(\d+)/.exec(migration)?.[1];
  assert.ok(setLimit, "file_size_limit is missing from the migration");
  assert.equal(
    Number(setLimit),
    expectedBytes,
    `migration sets file_size_limit = ${setLimit}; FILE_MAX_VERSION_BYTES is ${expectedBytes}`,
  );
});
