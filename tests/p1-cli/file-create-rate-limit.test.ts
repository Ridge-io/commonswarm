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
  /* Searching for both literals anywhere in the file leaves a SWAP green: the server would
   * report "workspace" for an identity refusal and both strings would still be present. Bind
   * each label to the limit constant its own refusal is raised against. */
  const identityBlock = /FILE_CREATE_RATE_LIMIT_PER_HOUR[\s\S]{0,600}?scope:\s*"(\w+)"/.exec(index);
  assert.ok(identityBlock, "no scope field follows the per-identity file-create limit");
  assert.equal(
    identityBlock![1],
    "identity",
    "the per-identity file-create refusal reports the wrong scope",
  );

  const workspaceBlock =
    /FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR[\s\S]{0,600}?scope:\s*"(\w+)"/.exec(index);
  assert.ok(workspaceBlock, "no scope field follows the per-workspace file-create ceiling");
  assert.equal(
    workspaceBlock![1],
    "workspace",
    "the per-workspace file-create refusal reports the wrong scope",
  );
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
  /* `45,000` is arithmetic over three constants, so a literal search stays green after any of
   * them moves and the documented worst case quietly becomes false. Recompute it. */
  const index = read("supabase/functions/command/index.ts");
  const constant = (source: string, name: string): number => {
    const raw = new RegExp(`(?:export )?const ${name} = (\\d+)`).exec(source)?.[1];
    assert.ok(raw, `${name} is no longer a numeric literal`);
    return Number(raw);
  };
  const members = constant(index, "FREE_TIER_MEMBER_LIMIT");
  const principals = constant(index, "FREE_TIER_PRINCIPAL_LIMIT");
  const perIdentity = constant(edge, "FILE_CREATE_RATE_LIMIT_PER_HOUR");
  const ceiling = constant(edge, "FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR");

  const identities = members + principals;
  const aggregate = identities * perIdentity;
  const grouped = aggregate.toLocaleString("en-US");
  for (const [label, text] of [["file-artifacts.ts", edge], ["FILE-ARTIFACTS.md", doc]] as const) {
    assert.ok(
      text.includes(grouped),
      `${label} does not state the aggregate ${grouped} (${members} + ${principals} = ${identities} identities x ${perIdentity})`,
    );
    assert.ok(
      text.includes(`${identities} identities`),
      `${label} does not state ${identities} identities`,
    );
  }

  /* The prose also claims the ceiling bounds that aggregate by a multiple. FLOOR, not round:
   * 45,000 / 2,000 is 22.5, and "23x" would claim a tightness the ceiling does not deliver
   * (2,000 x 23 = 46,000 > 45,000). The prose says "at least", which is the floor. */
  const multiple = Math.floor(aggregate / ceiling);
  for (const [label, text] of [["file-artifacts.ts", edge], ["FILE-ARTIFACTS.md", doc]] as const) {
    assert.match(
      text,
      new RegExp(`by at least ${multiple}\\s*(?:x|×)`),
      `${label} does not say the ceiling bounds the aggregate by at least ${multiple}x (${aggregate} / ${ceiling})`,
    );
  }
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
 * written against ALLOWED_TYPE_GROUPS — reading the same array the message is built from
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
  /* A sanity floor only — it proves the sentence was parsed, not that the allowlist is intact.
   * This test compares two renderings that both come from ALLOWED_TYPE_GROUPS, so dropping an
   * extension from that array leaves them agreeing and keeps this green. What catches a silent
   * narrowing is the pair of gates at the end of this file, which bind the array to the
   * enumerations published in SWARM-CLOUD.md 2.8 and in the file-artifacts design doc. */
  assert.ok(named.length >= 10, `the refusal names only ${named.length} extensions: ${FILE_TYPE_REFUSED_MESSAGE}`);

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
    accepted.length >= 10,
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
  const template = /export const FILE_TYPE_REFUSED_MESSAGE =([\s\S]*?);\n/.exec(edge)?.[1];
  assert.ok(template, "FILE_TYPE_REFUSED_MESSAGE is no longer declared in file-artifacts.ts");
  // A backtick alone is not proof of generation: a hand-written backtick string passes that.
  // The template must READ the groups for both halves it publishes.
  assert.match(
    template!,
    /ALLOWED_TYPE_GROUPS[\s\S]*group\.extensions/,
    "FILE_TYPE_REFUSED_MESSAGE no longer builds its extension list from ALLOWED_TYPE_GROUPS",
  );
  assert.match(
    template!,
    /group\.contentTypes/,
    "FILE_TYPE_REFUSED_MESSAGE no longer builds its content-type list from ALLOWED_TYPE_GROUPS",
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

/* The content-type half of the refusal, held to ALLOWED_CONTENT_TYPE_RE the same way the
 * extension half is: the named set is parsed out of the SHIPPED SENTENCE and checked against
 * the regex's own source and against fileContentAllowed. The first attempt at this sentence
 * said "an application type for those documents and archives", which is false —
 * application/json and the two YAML types are accepted and are neither. */
test("every content type the refusal names is accepted, and the set matches the regex", async () => {
  const edgeModule = "../../supabase/functions/command/file-artifacts.ts";
  const { FILE_TYPE_REFUSED_MESSAGE, fileContentAllowed } = (await import(edgeModule)) as {
    FILE_TYPE_REFUSED_MESSAGE: string;
    fileContentAllowed: (name: string, contentType: string) => boolean;
  };
  const edge = read("supabase/functions/command/file-artifacts.ts");

  /* Each group renders as `label: .ext .ext / type, type`. Anchor on that shape rather than
   * splitting the whole message on "; " — the header sentence contains "; charset=utf-8". */
  const named = [...FILE_TYPE_REFUSED_MESSAGE.matchAll(/[a-z]+: (?:\.[a-z0-9.]+ ?)+\/ ([^;]+)/g)]
    .flatMap((match) => match[1]!.split(",").map((entry) => entry.trim()))
    .filter((entry) => entry.length > 0);
  assert.ok(named.length >= 15, `the refusal names only ${named.length} content types`);

  /* Assert the wildcard on BOTH sides before setting it aside. Filtering it out of the
   * comparison is what let the shipped sentence lose the text class without any gate noticing:
   * a Grok arm measured 33 pass, 0 fail with that entry deleted from what the user is shown. */
  const textPattern = /const TEXT_SUBTYPE_PATTERN = "([^"]+)";/.exec(edge)?.[1];
  assert.ok(textPattern, "TEXT_SUBTYPE_PATTERN is no longer a string constant in file-artifacts.ts");
  assert.ok(
    named.includes(textPattern!),
    `the refusal no longer names ${textPattern}; a user reading it would not know any text subtype is allowed`,
  );
  assert.ok(
    FILE_TYPE_REFUSED_MESSAGE.includes(textPattern!),
    `the shipped sentence does not contain ${textPattern}`,
  );

  // Behavioural half: a named type on an allowed extension must be accepted. `.md` is in the
  // text group, so the extension never decides these cases.
  for (const contentType of named) {
    // The text entry is a CLASS, not a literal: probe a member of it. Everything else is literal.
    const probe = contentType.startsWith("text/[") ? "text/markdown" : contentType;
    assert.equal(
      fileContentAllowed("plan.md", probe),
      true,
      `the refusal names ${contentType} as allowed, but fileContentAllowed refuses it`,
    );
  }

  // Negative control on the same invocation: types the sentence does NOT name must be refused,
  // so the loop above cannot pass vacuously.
  for (const contentType of [
    "application/octet-stream",
    "application/x-sh",
    "application/xml",
    "image/tiff",
    "video/mp4",
    "application/vnd.openxmlformats-officedocument.drawingml.chart",
  ]) {
    assert.ok(!named.includes(contentType), `this negative control is stale: ${contentType} is now named`);
    assert.equal(
      fileContentAllowed("plan.md", contentType),
      false,
      `${contentType} is not named in the refusal but fileContentAllowed accepts it`,
    );
  }

  // Set half: everything the COMPILED regex accepts must be named. ALLOWED_CONTENT_TYPE_RE is
  // generated from the same list, so this direction is now structural rather than a comparison
  // of two hand-maintained sets — but it still catches an entry that compiles to something
  // wider than it reads.
  const { ALLOWED_CONTENT_TYPE_RE } = (await import(edgeModule)) as {
    ALLOWED_CONTENT_TYPE_RE: RegExp;
  };
  const source = /^\^\(\?:(.+)\)\$$/.exec(ALLOWED_CONTENT_TYPE_RE.source)?.[1];
  assert.ok(source, `ALLOWED_CONTENT_TYPE_RE is no longer the generated alternation: ${ALLOWED_CONTENT_TYPE_RE.source}`);
  const enumerated = source!
    .split("|")
    .map((alternative) => unescapeLiteral(alternative))
    .filter((entry) => entry !== textPattern);
  assert.ok(
    enumerated.length >= 12,
    `could not enumerate ALLOWED_CONTENT_TYPE_RE: parsed ${enumerated.length} from ${source}`,
  );
  assert.ok(
    source!.split("|").some((alternative) => unescapeLiteral(alternative) === textPattern),
    `ALLOWED_CONTENT_TYPE_RE no longer carries the ${textPattern} class it prints: ${source}`,
  );

  const namedLeaves = new Set(named.filter((entry) => entry !== textPattern));
  for (const contentType of enumerated) {
    assert.ok(
      namedLeaves.has(contentType),
      `ALLOWED_CONTENT_TYPE_RE accepts ${contentType} but the refusal does not name it`,
    );
  }
  assert.deepEqual(
    [...namedLeaves].sort(),
    [...new Set(enumerated)].sort(),
    "the content types the refusal names and the ones the regex accepts are not the same set",
  );
});

/* Returns the contents of the parenthesised group that OPENS at `open`, matching parentheses by
 * depth. Parsing a regex with a regex is what produced an unbalanced body on the first attempt. */
function balancedGroup(source: string, open: number): string {
  assert.equal(source[open], "(", `expected a group at index ${open} of ${source}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`unbalanced group from index ${open} in ${source}`);
}

/* Unescapes the regex-literal escapes the allowlist uses, and refuses anything else so a future
 * metacharacter cannot be silently turned into a literal. */
function unescapeLiteral(part: string): string {
  const escapes = [...part.matchAll(/\\(.)/g)].map((match) => match[1]!);
  for (const escaped of escapes) {
    assert.ok(
      ".+/".includes(escaped),
      `ALLOWED_CONTENT_TYPE_RE now escapes \\${escaped}; this parser only understands \\. \\+ and \\/`,
    );
  }
  return part.replace(/\\([.+/])/g, "$1");
}

/* Expands a regex alternation body, including one level of nesting, into its leaf strings.
 * `(pdf|json|vnd\.x\.(a|b))` -> ["pdf", "json", "vnd.x.a", "vnd.x.b"]. */
function expandAlternation(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  const parts: string[] = [];
  for (const character of body) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "|" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  for (const part of parts) {
    const nested = /^(.*?)\(([^)]*)\)$/.exec(part);
    if (nested) {
      for (const leaf of expandAlternation(nested[2]!)) {
        out.push(unescapeLiteral(nested[1]!) + leaf);
      }
    } else {
      out.push(unescapeLiteral(part));
    }
  }
  return out;
}

/* The independent pin for the allowlist itself (Codex, round 2): the gates above compare two
 * renderings that both come from ALLOWED_TYPE_GROUPS, so dropping an extension from that array
 * keeps them green while silently narrowing what the service accepts. SWARM-CLOUD.md §2.8 is a
 * separate artifact, written by hand and reviewed as spec, so binding the code to IT means a
 * narrowing has to be made deliberately in both places. */
test("the extension allowlist matches the enumeration published in SWARM-CLOUD.md 2.8", () => {
  const doc = read("docs/design/SWARM-CLOUD.md");
  const edge = read("supabase/functions/command/file-artifacts.ts");

  const section = /checked together for text \(([\s\S]*?)\), and archives \(([^)]*)\)/.exec(doc);
  assert.ok(section, "SWARM-CLOUD.md 2.8 no longer enumerates the extension allowlist");
  const published = [...section![0].matchAll(/`\.([a-z0-9.]+)`/g)].map((match) => match[1]!);
  assert.ok(published.length >= 20, `parsed only ${published.length} extensions from SWARM-CLOUD.md 2.8`);

  const groups = /const ALLOWED_TYPE_GROUPS = \[([\s\S]*?)\n\] as const;/.exec(edge)?.[1];
  assert.ok(groups, "ALLOWED_TYPE_GROUPS is no longer a literal array in file-artifacts.ts");
  const enforced = [...groups!.matchAll(/extensions: \[([^\]]*)\]/g)]
    .flatMap((match) => [...match[1]!.matchAll(/"([a-z0-9.]+)"/g)].map((entry) => entry[1]!));

  assert.deepEqual(
    [...new Set(published)].sort(),
    [...new Set(enforced)].sort(),
    "SWARM-CLOUD.md 2.8 and ALLOWED_TYPE_GROUPS enumerate different extension sets",
  );
});

/* Same sweep, second surface. The design doc's 5 listed the extensions too and omitted .yml,
 * so its "Everything else ... is refused" sentence was false for a type the service accepts.
 * A copy fix must reach every surface in the claim family, not just the one that was reported. */
test("the file-artifacts design doc enumerates the same extension allowlist", () => {
  const doc = read("docs/design/2026-08-18-FILE-ARTIFACTS.md");
  const edge = read("supabase/functions/command/file-artifacts.ts");

  const section = /^Allowlist\. The declared content type and the filename extension([\s\S]*?)refused with the list\./m.exec(doc);
  assert.ok(section, "the design doc 5 no longer enumerates the extension allowlist");
  const published = [...section![1]!.matchAll(/`\.([a-z0-9.]+)`/g)].map((match) => match[1]!);

  const groups = /const ALLOWED_TYPE_GROUPS = \[([\s\S]*?)\n\] as const;/.exec(edge)?.[1];
  assert.ok(groups, "ALLOWED_TYPE_GROUPS is no longer a literal array in file-artifacts.ts");
  const enforced = [...groups!.matchAll(/extensions: \[([^\]]*)\]/g)]
    .flatMap((match) => [...match[1]!.matchAll(/"([a-z0-9.]+)"/g)].map((entry) => entry[1]!));

  assert.deepEqual(
    [...new Set(published)].sort(),
    [...new Set(enforced)].sort(),
    "the design doc 5 and ALLOWED_TYPE_GROUPS enumerate different extension sets",
  );
});

/* The refusal's own framing makes two claims beyond the lists: that the groups need not match,
 * and that `text/*` means a LOWERCASE subtype. Both are claims about behaviour, so both get a
 * control — a true sentence with nothing holding it is how this paragraph drifted before. */
test("the refusal's framing claims hold against fileContentAllowed", async () => {
  const edgeModule = "../../supabase/functions/command/file-artifacts.ts";
  const { FILE_TYPE_REFUSED_MESSAGE, fileContentAllowed, validateFileCommand } =
    (await import(edgeModule)) as {
      FILE_TYPE_REFUSED_MESSAGE: string;
      fileContentAllowed: (name: string, contentType: string) => boolean;
      validateFileCommand: (
        cmd: Record<string, unknown>,
      ) => { ok: true; command: unknown } | { ok: false };
    };

  assert.match(
    FILE_TYPE_REFUSED_MESSAGE,
    /they need not come from the same group/,
    "the refusal no longer says the groups need not match",
  );
  // An image extension with a text-group content type: accepted, because the two halves are
  // independent. If this ever became false, the sentence above would be a lie.
  assert.equal(fileContentAllowed("plan.png", "application/json"), true);
  assert.equal(fileContentAllowed("plan.md", "image/png"), true);

  /* `text/*` is printed as a wildcard, so the message has to say how wide it really is. The
   * regex class is [a-z0-9.+-]+ and the pattern is anchored, which is NARROWER than "any text
   * subtype": no uppercase, no underscore, and no parameter. A Grok arm caught the earlier
   * wording ("any lowercase text subtype") claiming the parameter case. */
  assert.match(
    FILE_TYPE_REFUSED_MESSAGE,
    /Send the content type bare: a parameter such as "; charset=utf-8" is refused/,
    "the refusal no longer warns that a content-type parameter is refused",
  );
  assert.match(
    FILE_TYPE_REFUSED_MESSAGE,
    /Case does not matter\./,
    "the refusal no longer says case is normalised for the caller",
  );
  assert.ok(
    !/lowercase/.test(FILE_TYPE_REFUSED_MESSAGE),
    "the refusal claims lowercase again; validateFileCommand lowercases content_type for the caller",
  );
  /* These go through validateFileCommand FIRST. A control that calls fileContentAllowed on the
   * raw string does not reach the path a user's request takes: the validator lowercases
   * content_type, so the raw function refuses TEXT/PLAIN while the service accepts it —
   * measured on production. Probe what the user actually hits. */
  const accepts = (contentType: string): boolean => {
    const validated = validateFileCommand({
      kind: "file_version_create",
      file_id: "3f1d4c6a-0000-4000-8000-000000000001",
      version_id: "3f1d4c6a-0000-4000-8000-000000000002",
      name: "plan.md",
      declared_size_bytes: 16,
      content_type: contentType,
    });
    if (!validated.ok) return false;
    const command = validated.command as { name: string; content_type: string };
    return fileContentAllowed(command.name, command.content_type);
  };

  assert.equal(accepts("text/html"), true);
  assert.equal(accepts("text/vnd.curl"), true, "dots are in the subtype class");
  assert.equal(accepts("text/x-yaml"), true, "hyphens are in the subtype class");
  assert.equal(accepts("TEXT/PLAIN"), true, "the validator no longer lowercases content_type");
  assert.equal(accepts("text/x_custom"), false, "underscores are no longer refused");
  assert.equal(
    accepts("text/plain; charset=utf-8"),
    false,
    "a content-type parameter is no longer refused; the message still tells users to send it bare",
  );
  assert.equal(
    accepts("application/json; charset=utf-8"),
    false,
    "a parameter is refused on text/ but not on application/; the message speaks for both",
  );
  // The raw function is stricter than the path. Keeping this here so nobody re-derives the
  // control from fileContentAllowed and re-learns it the hard way.
  assert.equal(
    fileContentAllowed("plan.md", "TEXT/PLAIN"),
    false,
    "fileContentAllowed now accepts uppercase; the validator's lowercasing is no longer what carries it",
  );
});

/* The CLI is the last mile, and it TRUNCATES. `safeError` in src/cli.ts strips ANSI, maps the
 * C0 range (newlines included) to spaces, and slices to 1000 characters. A Grok arm measured the
 * multi-line version of this refusal at 1,148 characters: the user lost the tail of the images
 * group and the whole archives group, so the message that exists to name the allowlist did not
 * name all of it. Gate the STRING THE USER SEES, not the constant. */
test("the refusal survives the CLI's own truncation with every group intact", async () => {
  const edgeModule = "../../supabase/functions/command/file-artifacts.ts";
  const { FILE_TYPE_REFUSED_MESSAGE } = (await import(edgeModule)) as {
    FILE_TYPE_REFUSED_MESSAGE: string;
  };
  const cli = read("src/cli.ts");

  /* Read the limit and the transformation out of safeError rather than repeating them: if the
   * CLI's cap moves, this gate moves with it instead of defending a number nobody kept. */
  const body = /function safeError\(error: unknown\): string \{([\s\S]*?)\n\}/.exec(cli)?.[1];
  assert.ok(body, "safeError is no longer recognisable in src/cli.ts");
  const cap = Number(/\.slice\(0,\s*(\d+)\)/.exec(body!)?.[1]);
  assert.ok(Number.isFinite(cap) && cap > 0, `safeError no longer slices to a fixed length: ${body}`);
  /* The C0 mapping lives in sanitizeForTerminal, which safeError composes; read it there rather
   * than requiring it inline, so moving the transformation does not fake a pass. */
  assert.match(body!, /sanitizeForTerminal\(message\)/, "safeError no longer routes through the terminal sanitiser");
  const sanitizer = /function sanitizeForTerminal\(value: string\): string \{([\s\S]*?)\n\}/.exec(cli)?.[1];
  assert.ok(sanitizer, "sanitizeForTerminal is no longer recognisable in src/cli.ts");
  assert.match(sanitizer!, /u0000-\\u001f/, "the terminal sanitiser no longer maps the C0 range, so newlines may now survive");

  const rendered = FILE_TYPE_REFUSED_MESSAGE
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, cap);

  assert.ok(
    rendered.length < cap,
    `the refusal renders to ${rendered.length} characters and safeError cuts at ${cap}; the tail of the allowlist never reaches the user`,
  );

  /* Every group label and every leaf must still be present AFTER the cut. */
  const groups = /const ALLOWED_TYPE_GROUPS = \[([\s\S]*?)\n\] as const;/.exec(
    read("supabase/functions/command/file-artifacts.ts"),
  )?.[1];
  assert.ok(groups, "ALLOWED_TYPE_GROUPS is no longer a literal array");
  for (const label of [...groups!.matchAll(/label: "([a-z]+)"/g)].map((match) => match[1]!)) {
    assert.ok(rendered.includes(`${label}:`), `the group "${label}" is cut off before the user sees it`);
  }
  for (const extension of [...groups!.matchAll(/extensions: \[([^\]]*)\]/g)]
    .flatMap((match) => [...match[1]!.matchAll(/"([a-z0-9.]+)"/g)].map((entry) => entry[1]!))) {
    assert.ok(rendered.includes(`.${extension}`), `.${extension} is cut off before the user sees it`);
  }
  /* The text entry is an IDENTIFIER in the array, not a quoted string, so a parser that reads
   * only quoted leaves silently skips the one entry that is a pattern. A Grok arm measured the
   * consequence: dropping the text class from the shipped sentence left every gate green.
   * Resolve the identifier to its value and hold it to the same standard as the literals. */
  const textPattern = /const TEXT_SUBTYPE_PATTERN = "([^"]+)";/.exec(
    read("supabase/functions/command/file-artifacts.ts"),
  )?.[1];
  assert.ok(textPattern, "TEXT_SUBTYPE_PATTERN is no longer a string constant in file-artifacts.ts");

  for (const contentType of [...groups!.matchAll(/contentTypes: \[([^\]]*)\]/g)]
    .flatMap((match) =>
      [...match[1]!.matchAll(/"([^"]+)"|(TEXT_SUBTYPE_PATTERN)/g)]
        .map((entry) => entry[1] ?? textPattern!)
    )) {
    assert.ok(rendered.includes(contentType), `${contentType} is cut off before the user sees it`);
  }
});

/* ALLOWED_CONTENT_TYPE_RE stopped being a hand-written literal and is now compiled from
 * ALLOWED_TYPE_GROUPS, which removes the second hand-maintained set a review arm objected to.
 * A generated security control has to prove it did not move: this pins it against the exact
 * literal it replaced, kept here verbatim, over every accepted type and a set of near misses
 * chosen to catch an unescaped metacharacter (`svg+xml`, the dotted openxmlformats names, a
 * trailing newline, an empty string). */
const CONTENT_TYPE_RE_BEFORE_GENERATION =
  /^(text\/[a-z0-9.+-]+|application\/(pdf|json|x-yaml|yaml|zip|gzip|x-gzip|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation))|image\/(png|jpeg|gif|webp|svg\+xml))$/;

test("the generated content-type regex accepts and refuses exactly what the literal did", async () => {
  const edgeModule = "../../supabase/functions/command/file-artifacts.ts";
  const { ALLOWED_CONTENT_TYPE_RE } = (await import(edgeModule)) as {
    ALLOWED_CONTENT_TYPE_RE: RegExp;
  };

  const cases = [
    "text/plain", "text/markdown", "text/csv", "text/html", "text/x-yaml", "text/vnd.curl",
    "text/a", "text/0", "text/a.b+c-d", "text/x_custom", "TEXT/plain", "text/", "text",
    "text/plain; charset=utf-8", "text/plain;charset=utf-8", "text/plain ",
    "application/json", "application/yaml", "application/x-yaml", "application/pdf",
    "application/zip", "application/gzip", "application/x-gzip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.drawingml.chart",
    "application/vnd.openxmlformats-officedocumentXwordprocessingml.document",
    "application/octet-stream", "application/xml", "application/x-sh", "application/",
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
    "image/svgWxml", "image/tiff", "image/", "video/mp4", "", "/", "x",
    "application/jsonX", "Xapplication/json", "\napplication/json", "application/json\n",
  ];

  for (const value of cases) {
    assert.equal(
      ALLOWED_CONTENT_TYPE_RE.test(value),
      CONTENT_TYPE_RE_BEFORE_GENERATION.test(value),
      `generating ALLOWED_CONTENT_TYPE_RE changed the ruling for ${JSON.stringify(value)}`,
    );
  }

  // Positive controls on the same invocation: the differential can discriminate.
  assert.equal(CONTENT_TYPE_RE_BEFORE_GENERATION.test("text/plain"), true);
  assert.equal(CONTENT_TYPE_RE_BEFORE_GENERATION.test("application/octet-stream"), false);
  assert.ok(cases.length >= 40, `the differential shrank to ${cases.length} cases`);
});

/* The refusal's machine-readable fields reach the terminal too. D-053 keeps us off
 * `error.message` for CLASSIFICATION; it does not make the other wire fields safe to PRINT.
 * `scope` and `resets_at` are strings the SERVER chooses, and this lane added a branch that
 * wrote them raw beside a sanitised message — the one unsanitised path in the pair. A Codex arm
 * caught it. Assert the CLI routes them through the same terminal sanitiser. */
test("the CLI sanitises the refusal's wire fields before they reach the terminal", () => {
  const cli = read("src/cli.ts");

  assert.match(
    cli,
    /function sanitizeForTerminal\(value: string\): string \{[\s\S]*?u001b[\s\S]*?u0000-\\u001f/,
    "sanitizeForTerminal no longer strips ANSI escapes and the C0 range",
  );
  assert.match(
    cli,
    /const message = error instanceof Error \? error\.message : "unknown error";\s*\n\s*return sanitizeForTerminal\(message\)/,
    "safeError no longer routes through sanitizeForTerminal",
  );
  assert.match(
    cli,
    /const extra = parts\.length > 0\s*\n?\s*\? ` \[\$\{sanitizeForTerminal\(parts\.join\(", "\)\)\.slice\(0, \d+\)\}\]`/,
    "the scope/limit/resets_at line no longer sanitises the values it prints",
  );

  /* The behaviour the assertions above stand for, exercised directly: a hostile scope value
   * must lose its escape sequence and its control characters. */
  const sanitize = (value: string): string =>
    value
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
  const hostile = "identity\u001b[2J\u001b[1;1Hcswarm: everything is fine\u0007";
  const cleaned = sanitize(hostile);
  assert.ok(!cleaned.includes("\u001b"), "the sanitiser left an escape character in place");
  assert.ok(!/[\u0000-\u001f]/.test(cleaned), "the sanitiser left a C0 control character in place");
  assert.ok(cleaned.startsWith("identity"), `the sanitiser mangled the legitimate prefix: ${JSON.stringify(cleaned)}`);
  // Positive control on the same invocation: an ordinary value passes through untouched.
  assert.equal(sanitize("workspace"), "workspace");
});
