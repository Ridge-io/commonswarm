/**
 * The acceptable-use page publishes FILE_CREATE_RATE_LIMIT_PER_HOUR as a typed sentence, and
 * AGENTS.md requires that a user-facing number come from the enforcement it describes. A direct
 * import is not available here: the constant lives in a Deno edge module that pulls postgres and
 * the generated protocol bundle, and `tsconfig.json` covers only `src/`. This gate reads both
 * files instead and fails when the published number and the enforced constant disagree.
 *
 * Compare-not-generate is the deliberate choice for the SITE, and only for the site: Astro
 * builds in Node and the constants live in a Deno module that imports postgres, so a build-time
 * import would drag the edge's dependency tree into the marketing site. Inside the edge, where
 * there is no such boundary, a user-facing enumeration IS generated from the enforcement — see
 * FILE_TYPE_REFUSED_MESSAGE in file-artifacts.ts and its gate at the end of this file.
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
  const published = /(?:and |, )?(\d+) version creates per identity per hour/.exec(page)?.[1];
  assert.ok(enforced, "FILE_CREATE_RATE_LIMIT_PER_HOUR is missing from file-artifacts.ts");
  assert.ok(published, "acceptable-use no longer carries the file-create hourly cap sentence");
  assert.equal(
    Number(published),
    Number(enforced),
    `acceptable-use publishes ${published} version creates per identity per hour; the edge enforces ${enforced}`,
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
  const inComment = /\*\s+(\d+) version creates \/ identity \/ hour/.exec(page)?.[1];
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
  const documented = /\|\s*upload rate\s*\|\s*(\d+) version-creates per identity per hour/.exec(doc)?.[1];
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
  const bucket = index.indexOf("`file:create:${auth.credentialKind}:${rateIdentity.toLowerCase()}`");
  const create = index.indexOf("fileVersionCreate", bucket === -1 ? 0 : bucket);
  assert.ok(bucket > 0, "the file-create rate bucket key is gone; the comment above the constant describes it");
  assert.ok(
    create > bucket,
    "fileVersionCreate now runs before the file:create rate bucket is incremented, so a refused "
      + "attempt no longer spends from it — the comment on FILE_CREATE_RATE_LIMIT_PER_HOUR says it does",
  );
});

/* Item C: workspace file-create ceiling controls (docs/design/SWARM-CLOUD.md §2.8). */

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
  const wsBucket = index.indexOf("`file:create:ws:${route.workspaceId.toLowerCase()}`");
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

test("the edge enforcement lowercases UUIDs in rate bucket keys", () => {
  const index = read("supabase/functions/command/index.ts");
  const wsKey = index.includes("`file:create:ws:${route.workspaceId.toLowerCase()}`");
  const idKey = index.includes("`file:create:${auth.credentialKind}:${rateIdentity.toLowerCase()}`");
  assert.ok(wsKey, "the workspace file-create rate bucket key does not lowercase workspaceId");
  assert.ok(idKey, "the identity file-create rate bucket key does not lowercase rateIdentity");
});

test("file-create rate-limit refusals return machine-readable scope field", () => {
  const index = read("supabase/functions/command/index.ts");
  const idScope = /scope:\s*"identity"/.test(index);
  const wsScope = /scope:\s*"workspace"/.test(index);
  assert.ok(idScope, "identity file-create rate limit refusal is missing scope: 'identity'");
  assert.ok(wsScope, "workspace file-create rate limit refusal is missing scope: 'workspace'");
});

test("storage bucket migration fails loudly if not exactly one row updated", () => {
  const migration = read("supabase/migrations/20260913000001_file_bucket_size_limit.sql");
  assert.match(migration, /GET DIAGNOSTICS\s+v_rows\s*=\s*ROW_COUNT;/);
  assert.match(migration, /IF\s+v_rows\s*<>\s*1\s+THEN/);
  assert.match(migration, /RAISE EXCEPTION/);
});

test("file create comments and design doc state correct free-tier aggregate arithmetic and no false fairness claim", () => {
  const edge = read("supabase/functions/command/file-artifacts.ts");
  const doc = read("docs/design/2026-08-18-FILE-ARTIFACTS.md");
  assert.ok(!edge.includes("30,000"), "file-artifacts.ts still contains stale 30,000 arithmetic");
  assert.ok(!doc.includes("30,000"), "FILE-ARTIFACTS.md still contains stale 30,000 arithmetic");
  assert.ok(edge.includes("45,000"), "file-artifacts.ts does not state 45,000 aggregate");
  assert.ok(doc.includes("45,000"), "FILE-ARTIFACTS.md does not state 45,000 aggregate");
  assert.ok(!edge.includes("one member cannot exhaust the workspace"), "file-artifacts.ts still claims one member cannot exhaust the workspace");
  assert.ok(!doc.includes("one member cannot exhaust the workspace"), "FILE-ARTIFACTS.md still claims one member cannot exhaust the workspace");
  assert.ok(!doc.includes("600 version-creates per principal per hour"), "FILE-ARTIFACTS.md still states per principal");
  assert.ok(doc.includes("600 version-creates per identity per hour"), "FILE-ARTIFACTS.md does not state per identity");
});

test("FileCommandRefused carries machine-readable scope, limit and resets_at", () => {
  const client = read("src/cloud/files.ts");
  assert.match(client, /readonly\s+scope:\s*string\s*\|\s*null/);
  assert.match(client, /readonly\s+limit:\s*number\s*\|\s*null/);
  assert.match(client, /readonly\s+resets_at:\s*string\s*\|\s*null/);
  assert.match(client, /new\s+FileCommandRefused\([\s\S]*?scope,[\s\S]*?limit,[\s\S]*?resets_at\)/);
});

/* Item C structural citation gates: cross-file pointers must cite the symbol, and the cited
 * file:line must resolve to that symbol so an edit breaks the gate loudly instead of rotting.
 *
 * SCOPE: these gates bind the pointers Item C wrote or touched — SWARM-CLOUD.md §2.8,
 * src/cloud/files.ts, the acceptable-use comments, and the file-artifacts design doc. They do
 * NOT bind every `file:line` in those documents. SWARM-CLOUD.md's board-v2 sections still cite
 * `index.ts` / `src/index.ts` in the separate local `swarm` CLI, which is not in this
 * repository and cannot be resolved from here. Do not read a green run as "every pointer in
 * these files resolves". */

test("SWARM-CLOUD.md §2.8 points at the active lines for fileContentAllowed and FILE_NAME_RE", () => {
  const doc = read("docs/design/SWARM-CLOUD.md");
  const edge = read("supabase/functions/command/file-artifacts.ts").split("\n");

  const typeCited = /fileContentAllowed[`,\s]+(?:`?supabase\/functions\/command\/)?file-artifacts\.ts:(\d+)/.exec(doc)?.[1];
  assert.ok(typeCited, "SWARM-CLOUD.md §2.8 no longer cites a line for fileContentAllowed");
  const typeLine = Number(typeCited);
  assert.ok(
    typeLine > 0 && typeLine <= edge.length,
    `SWARM-CLOUD.md cites line :${typeLine} for fileContentAllowed, but file has ${edge.length} lines`,
  );
  assert.ok(
    edge[typeLine - 1].includes("fileContentAllowed"),
    `SWARM-CLOUD.md cites file-artifacts.ts:${typeLine} for fileContentAllowed, but line is: ${JSON.stringify(edge[typeLine - 1])}`,
  );

  const nameCited = /FILE_NAME_RE.*?supabase\/functions\/command\/file-artifacts\.ts:(\d+)/.exec(doc)?.[1];
  assert.ok(nameCited, "SWARM-CLOUD.md §2.8 no longer cites a line for FILE_NAME_RE");
  const nameLine = Number(nameCited);
  assert.ok(
    nameLine > 0 && nameLine <= edge.length,
    `SWARM-CLOUD.md cites line :${nameLine} for FILE_NAME_RE, but file has ${edge.length} lines`,
  );
  assert.ok(
    edge[nameLine - 1].includes("FILE_NAME_RE"),
    `SWARM-CLOUD.md cites file-artifacts.ts:${nameLine} for FILE_NAME_RE, but line is: ${JSON.stringify(edge[nameLine - 1])}`,
  );
});

test("src/cloud/files.ts points at active lines for FILE_MAX_VERSION_BYTES, FILE_CONTENT_WARNING, and ALLOWED_CONTENT_TYPE_RE", () => {
  const client = read("src/cloud/files.ts");
  const edge = read("supabase/functions/command/file-artifacts.ts").split("\n");
  const readEdge = read("supabase/functions/read/index.ts").split("\n");

  // FILE_MAX_VERSION_BYTES
  const maxBytesCited = /supabase\/functions\/command\/file-artifacts\.ts:(\d+)\s*\(FILE_MAX_VERSION_BYTES\)/.exec(client)?.[1];
  assert.ok(maxBytesCited, "src/cloud/files.ts no longer cites line for FILE_MAX_VERSION_BYTES");
  const maxBytesLine = Number(maxBytesCited);
  assert.ok(
    edge[maxBytesLine - 1].includes("FILE_MAX_VERSION_BYTES"),
    `src/cloud/files.ts cites file-artifacts.ts:${maxBytesLine} for FILE_MAX_VERSION_BYTES, but line is: ${JSON.stringify(edge[maxBytesLine - 1])}`,
  );

  // FILE_CONTENT_WARNING in file-artifacts.ts
  const warnEdgeCited = /FILE_CONTENT_WARNING in supabase\/functions\/command\/file-artifacts\.ts:(\d+)/.exec(client)?.[1];
  assert.ok(warnEdgeCited, "src/cloud/files.ts no longer cites line for edge FILE_CONTENT_WARNING");
  const warnEdgeLine = Number(warnEdgeCited);
  assert.ok(
    edge[warnEdgeLine - 1].includes("FILE_CONTENT_WARNING"),
    `src/cloud/files.ts cites file-artifacts.ts:${warnEdgeLine} for FILE_CONTENT_WARNING, but line is: ${JSON.stringify(edge[warnEdgeLine - 1])}`,
  );

  // FILE_CONTENT_WARNING in read/index.ts
  const warnReadCited = /read\/index\.ts:(\d+)/.exec(client)?.[1];
  assert.ok(warnReadCited, "src/cloud/files.ts no longer cites line for read/index.ts FILE_CONTENT_WARNING");
  const warnReadLine = Number(warnReadCited);
  assert.ok(
    readEdge[warnReadLine - 1].includes("FILE_CONTENT_WARNING"),
    `src/cloud/files.ts cites read/index.ts:${warnReadLine} for FILE_CONTENT_WARNING, but line is: ${JSON.stringify(readEdge[warnReadLine - 1])}`,
  );

  // ALLOWED_CONTENT_TYPE_RE
  const allowCited = /ALLOWED_CONTENT_TYPE_RE[\s\S]*?\(file-artifacts\.ts:(\d+)\)/.exec(client)?.[1];
  assert.ok(allowCited, "src/cloud/files.ts no longer cites line for ALLOWED_CONTENT_TYPE_RE");
  const allowLine = Number(allowCited);
  assert.ok(
    edge[allowLine - 1].includes("ALLOWED_CONTENT_TYPE_RE"),
    `src/cloud/files.ts cites file-artifacts.ts:${allowLine} for ALLOWED_CONTENT_TYPE_RE, but line is: ${JSON.stringify(edge[allowLine - 1])}`,
  );

  // AGENT_TOKEN_MAX_TTL_MS cited by symbol alone without brittle line number
  assert.ok(
    client.includes("AGENT_TOKEN_MAX_TTL_MS"),
    "src/cloud/files.ts no longer names AGENT_TOKEN_MAX_TTL_MS symbol",
  );
  assert.ok(
    !/command\/?index\.ts:\d+/.test(client),
    "src/cloud/files.ts still contains a brittle command index.ts line citation instead of symbol-only reference",
  );
});

test("acceptable-use comment cites active lines for file caps and index.ts limits", () => {
  const page = read("site/src/pages/acceptable-use.astro");
  const edge = read("supabase/functions/command/file-artifacts.ts").split("\n");
  const index = read("supabase/functions/command/index.ts").split("\n");

  // file-artifacts.ts:52-55 range check
  const rangeMatch = /supabase\/functions\/command\/file-artifacts\.ts:(\d+)-(\d+)/.exec(page);
  assert.ok(rangeMatch, "acceptable-use no longer cites line range for file caps");
  const startLine = Number(rangeMatch[1]);
  const endLine = Number(rangeMatch[2]);
  const slice = edge.slice(startLine - 1, endLine).join("\n");
  assert.ok(slice.includes("FILE_MAX_VERSION_BYTES"), `lines ${startLine}-${endLine} missing FILE_MAX_VERSION_BYTES`);
  assert.ok(slice.includes("FILE_WORKSPACE_MAX_BYTES"), `lines ${startLine}-${endLine} missing FILE_WORKSPACE_MAX_BYTES`);
  assert.ok(slice.includes("FILE_WORKSPACE_MAX_NAMES"), `lines ${startLine}-${endLine} missing FILE_WORKSPACE_MAX_NAMES`);
  assert.ok(slice.includes("FILE_MAX_VERSIONS_PER_NAME"), `lines ${startLine}-${endLine} missing FILE_MAX_VERSIONS_PER_NAME`);

  // FILE_MAX_VERSIONS_PER_NAME, :55
  const verMatch = /FILE_MAX_VERSIONS_PER_NAME, :(\d+)/.exec(page);
  assert.ok(verMatch, "acceptable-use no longer cites line for FILE_MAX_VERSIONS_PER_NAME");
  const verLine = Number(verMatch[1]);
  assert.ok(edge[verLine - 1].includes("FILE_MAX_VERSIONS_PER_NAME"),
    `acceptable-use cites line ${verLine} for FILE_MAX_VERSIONS_PER_NAME, but line is: ${JSON.stringify(edge[verLine - 1])}`);

  // index.ts citations
  const checkIndex = (regex: RegExp, symbol: string) => {
    const m = regex.exec(page);
    assert.ok(m, `acceptable-use missing citation for ${symbol}`);
    const line = Number(m[1]);
    assert.ok(
      index[line - 1].includes(symbol),
      `acceptable-use cites index.ts:${line} for ${symbol}, but found: ${JSON.stringify(index[line - 1])}`,
    );
  };

  checkIndex(/FREE_TIER_WORKSPACE_LIMIT,[\s*]+supabase\/functions\/command\/index\.ts:(\d+)/, "FREE_TIER_WORKSPACE_LIMIT");
  checkIndex(/SIGNAL_CREDENTIAL_LIMIT, :(\d+)/, "SIGNAL_CREDENTIAL_LIMIT");
  checkIndex(/SIGNAL_WORKSPACE_LIMIT, :(\d+)/, "SIGNAL_WORKSPACE_LIMIT");
  checkIndex(/incrementRateBucket, :(\d+)/, "date_trunc('hour', statement_timestamp())");
  checkIndex(/INVITATION_MAX_TTL_MS, :(\d+)/, "INVITATION_MAX_TTL_MS");
  checkIndex(/AGENT_TOKEN_MAX_TTL_MS, :(\d+)/, "AGENT_TOKEN_MAX_TTL_MS");

  const untilMatch = /index\.ts:(\d+)-(\d+)\s*\(SIGNAL_MAX_UNTIL_MS\)/.exec(page);
  assert.ok(untilMatch, "acceptable-use missing citation for SIGNAL_MAX_UNTIL_MS");
  const untilSlice = index.slice(Number(untilMatch[1]) - 1, Number(untilMatch[2])).join("\n");
  assert.ok(untilSlice.includes("SIGNAL_MAX_UNTIL_MS"), `index.ts:${untilMatch[1]}-${untilMatch[2]} missing SIGNAL_MAX_UNTIL_MS`);
});

test("the file-artifacts design doc cites objectSize symbol alone in file-artifacts.ts", () => {
  const doc = read("docs/design/2026-08-18-FILE-ARTIFACTS.md");
  const edge = read("supabase/functions/command/file-artifacts.ts");
  assert.ok(
    doc.includes("`file-artifacts.ts`, `objectSize` at commit"),
    "design doc no longer cites objectSize symbol in file-artifacts.ts",
  );
  assert.ok(
    edge.includes("objectSize("),
    "file-artifacts.ts no longer contains objectSize method",
  );
  assert.ok(
    !/file-artifacts\.ts:\d+/.test(doc),
    "design doc contains line citation into file-artifacts.ts instead of symbol-only citation",
  );
});

/* The refusal a user reads must name exactly what the check accepts. AGENTS.md: "An
 * enumeration inside a message must be generated, not typed." This gate is deliberately NOT
 * written against ALLOWED_EXTENSION_GROUPS — reading the same array the message is built from
 * would be a circular control that passes whatever the array says. It parses the extensions
 * OUT OF THE SHIPPED SENTENCE and runs each one through fileContentAllowed, the function the
 * edge actually calls. Measured defect it exists to catch: the typed sentence it replaced
 * omitted .html, .htm and .yml, all of which the check accepts. */
test("every extension the refusal names is accepted, and named-absent ones are refused", async () => {
  /* The specifier is a variable on purpose. tsconfig.tests.json has
   * allowImportingTsExtensions off, so a literal ".ts" specifier is TS5097 at `check:tests`;
   * the edge module has no .js build to point at, because tsc covers only src/. Keeping the
   * real module under test matters more than a literal here: reading the file as text would
   * make this a control over the source of the message rather than over the function the
   * edge calls. */
  const edgeModule = "../../supabase/functions/command/file-artifacts.ts";
  const { ALLOWED_EXTENSION_RE, FILE_TYPE_REFUSED_MESSAGE, fileContentAllowed } =
    (await import(edgeModule)) as {
      ALLOWED_EXTENSION_RE: RegExp;
      FILE_TYPE_REFUSED_MESSAGE: string;
      fileContentAllowed: (name: string, contentType: string) => boolean;
    };

  const named = [...FILE_TYPE_REFUSED_MESSAGE.matchAll(/(?<![A-Za-z0-9])\.([A-Za-z0-9.]+)/g)]
    .map((match) => match[1]!.toLowerCase());
  assert.ok(named.length >= 20, `the refusal names only ${named.length} extensions: ${FILE_TYPE_REFUSED_MESSAGE}`);

  // The historical defect was a message naming a SUBSET of what the check accepts: .html, .htm
  // and .yml were accepted and unnamed, so the loop below — which only proves named ⊆ accepted —
  // would have passed it. Compare the two SETS, using the regex's own source as the second,
  // independently rendered view of the allowlist (escaped dots, `|` joined, anchored).
  const accepted = ALLOWED_EXTENSION_RE.source
    .replace(/^\\\.\(\?:/, "")
    .replace(/\)\$$/, "")
    .split("|")
    .map((alternative) => alternative.replace(/\\\./g, ".").toLowerCase());
  assert.ok(
    accepted.length >= 20,
    `could not parse the extension allowlist out of ALLOWED_EXTENSION_RE: ${ALLOWED_EXTENSION_RE.source}`,
  );
  assert.deepEqual(
    [...new Set(named)].sort(),
    [...new Set(accepted)].sort(),
    "the extensions the refusal names and the extensions ALLOWED_EXTENSION_RE accepts are not the same set",
  );

  for (const extension of named) {
    assert.equal(
      fileContentAllowed(`plan.${extension}`, "text/plain"),
      true,
      `the refusal names .${extension} as allowed, but fileContentAllowed refuses plan.${extension}`,
    );
  }

  // Negative control on the same invocation: an allowed content type with an extension the
  // sentence does NOT name must still be refused, so the loop above cannot pass vacuously.
  for (const extension of ["exe", "sh", "gz", "tar", "xml", "js", "mdx"]) {
    assert.ok(
      !named.includes(extension),
      `this negative control is stale: the refusal now names .${extension}`,
    );
    assert.equal(
      fileContentAllowed(`plan.${extension}`, "text/plain"),
      false,
      `.${extension} is not named in the refusal but fileContentAllowed accepts plan.${extension}`,
    );
  }
});

/* The refusal message must be built, not typed: a string literal at the refusal site is the
 * defect this lane removed, and it would pass the behavioural gate above only by luck. */
test("the file_type_refused site passes the generated constant, not a literal", () => {
  const edge = read("supabase/functions/command/file-artifacts.ts");
  assert.match(
    edge,
    /"file_type_refused",\s*\n\s*FILE_TYPE_REFUSED_MESSAGE,/,
    "file_type_refused no longer passes FILE_TYPE_REFUSED_MESSAGE; a typed sentence has come back",
  );
  assert.ok(
    /export const FILE_TYPE_REFUSED_MESSAGE =\s*\n?\s*`/.test(edge),
    "FILE_TYPE_REFUSED_MESSAGE is no longer a template built from the allowlist groups",
  );
});

/* ★R15 depends on a property of a PINNED dependency, so the claim is bound to the installed
 * package rather than to a line number in it. The line citation this replaces (:345) was the
 * method summary; the two-hour sentence sat two lines lower, and nothing failed. */
test("the pinned storage-js still documents a two-hour signed upload URL", () => {
  const doc = read("docs/design/2026-08-18-FILE-ARTIFACTS.md");
  assert.match(
    doc,
    /signed upload URLs valid for TWO hours\s*\n?\s*\(`createSignedUploadUrl`/,
    "the ★R15 sentence no longer cites createSignedUploadUrl by symbol",
  );
  assert.ok(
    !/StorageFileApi\.ts:\d+\)/.test(doc),
    "a bare StorageFileApi.ts line citation is back in the design doc",
  );

  const types = read("node_modules/@supabase/storage-js/dist/index.d.cts");
  const start = types.indexOf("Creates a signed upload URL");
  assert.ok(start >= 0, "storage-js no longer documents createSignedUploadUrl");
  const block = types.slice(start, start + 400);
  assert.match(
    block,
    /valid for 2 hours/,
    "the pinned @supabase/storage-js no longer documents a two-hour signed upload URL; re-read ★R15 and the 3-hour pending sweep",
  );
});

/* The acceptable-use page publishes four more numbers that were bound only by a line citation,
 * so the pointer could stay correct while the number drifted. Bind the VALUES too. */
test("acceptable-use publishes the enforced byte, name and version caps", () => {
  const page = read("site/src/pages/acceptable-use.astro");
  const edge = read("supabase/functions/command/file-artifacts.ts");
  const protocolLimit = /export const BRAIN_LIVE_VERSION_LIMIT = (\d+)/.exec(
    read("src/protocol/brain-version-window.ts"),
  )?.[1];
  assert.ok(protocolLimit, "BRAIN_LIVE_VERSION_LIMIT is no longer in src/protocol/brain-version-window.ts");

  const constant = (name: string): number => {
    const raw = new RegExp(`export const ${name} = ([^;]+);`).exec(edge)?.[1];
    assert.ok(raw, `${name} is missing from file-artifacts.ts`);
    const resolved = raw!.trim() === "BRAIN_LIVE_VERSION_LIMIT" ? protocolLimit! : raw!;
    const value = Number(new Function(`return (${resolved});`)());
    assert.ok(Number.isFinite(value), `${name} does not evaluate to a number: ${raw}`);
    return value;
  };

  const perVersionMb = /(\d+) MB per version/.exec(page)?.[1];
  assert.ok(perVersionMb, "acceptable-use no longer publishes the per-version cap");
  assert.equal(
    Number(perVersionMb) * 1024 * 1024,
    constant("FILE_MAX_VERSION_BYTES"),
    "acceptable-use publishes a per-version cap the edge does not enforce",
  );

  const workspaceGb = /(\d+) GB per workspace/.exec(page)?.[1];
  assert.ok(workspaceGb, "acceptable-use no longer publishes the workspace byte cap");
  assert.equal(
    Number(workspaceGb) * 1024 * 1024 * 1024,
    constant("FILE_WORKSPACE_MAX_BYTES"),
    "acceptable-use publishes a workspace byte cap the edge does not enforce",
  );

  const names = /(\d+) unpurged names per workspace/.exec(page)?.[1];
  assert.ok(names, "acceptable-use no longer publishes the workspace name cap");
  assert.equal(
    Number(names),
    constant("FILE_WORKSPACE_MAX_NAMES"),
    "acceptable-use publishes a name cap the edge does not enforce",
  );

  const versions = /(\d+) live or in-flight versions per file name/.exec(page)?.[1];
  assert.ok(versions, "acceptable-use no longer publishes the per-name version cap");
  assert.equal(
    Number(versions),
    constant("FILE_MAX_VERSIONS_PER_NAME"),
    "acceptable-use publishes a per-name version cap the edge does not enforce",
  );
});

/* The quota sentence describes WHICH rows the byte cap counts. It counted "unpurged versions",
 * which is not what the SQL sums: a pending row older than the 3-hour window is still unpurged
 * and is NOT counted. */
test("acceptable-use describes the rows the byte quota actually sums", () => {
  const page = read("site/src/pages/acceptable-use.astro");
  const edge = read("supabase/functions/command/file-artifacts.ts");

  const sql = /SELECT coalesce\(sum\(size_bytes\)[\s\S]*?`/.exec(edge)?.[0];
  assert.ok(sql, "the workspace byte-quota query is no longer recognisable in file-artifacts.ts");
  assert.match(sql!, /state IN \('live', 'retired'\)/, "the byte quota no longer sums live and retired rows");
  assert.match(sql!, /state = 'pending'/, "the byte quota no longer includes in-flight rows");
  assert.match(sql!, /interval '3 hours'/, "the in-flight window in the byte quota is no longer 3 hours");

  assert.match(
    page,
    /1 GB per workspace counting live and retired versions plus uploads begun in the last 3 hours/,
    "acceptable-use no longer describes which rows the byte quota sums",
  );
  assert.ok(
    !/GB of unpurged versions/.test(page),
    "the retired wording 'GB of unpurged versions' is back; a pending row past the window is unpurged and uncounted",
  );
});
