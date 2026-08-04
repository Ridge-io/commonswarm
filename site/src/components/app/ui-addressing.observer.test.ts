import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/*
 * Built-artifact observer for the dashboard's addressing slice. The site test script reaches
 * this file through its recursive component observer-test glob; reading dist/app keeps assertions
 * on the JavaScript and CSS Astro actually emits rather than on an unbuilt source promise.
 */
const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");
const dashboardSource = readFileSync(join(componentDir, "LiveDashboard.astro"), "utf8");
const clientSource = readFileSync(join(siteRoot, "src", "lib", "commonswarm.ts"), "utf8");
const appHtml = readFileSync(join(siteRoot, "dist", "app", "index.html"), "utf8");
const assetPaths = Array.from(
  appHtml.matchAll(/(?:src|href)="\/(_astro\/[^"?#]+\.(?:js|css))/g),
  (match) => match[1]!,
);
assert.ok(assetPaths.length > 0, "the built /app page must link emitted JS and CSS assets");
const builtAssets = assetPaths
  .map((assetPath) => readFileSync(join(siteRoot, "dist", assetPath), "utf8"))
  .join("\n");

const renderFeedStart = dashboardSource.indexOf("const renderFeed =");
const renderFeedEnd = dashboardSource.indexOf("const syncConnectWorkspace =", renderFeedStart);
assert.notEqual(renderFeedStart, -1, "the feed-render observer start anchor must resolve");
assert.notEqual(renderFeedEnd, -1, "the feed-render observer end anchor must resolve");
const renderFeed = dashboardSource.slice(renderFeedStart, renderFeedEnd);

test("built dashboard carries to_agent from the read query into Signal.toAgent", () => {
  assert.match(clientSource, /toAgent: string \| null/);
  assert.match(
    clientSource,
    /\.select\("id,from,from_kind,to,to_agent,kind,body,about,until,created_at"\)/,
  );
  assert.match(clientSource, /toAgent: row\.to_agent === null \|\| row\.to_agent === undefined/);
  assert.match(
    builtAssets,
    /select\([`'"]id,from,from_kind,to,to_agent,kind,body,about,until,created_at[`'"]\)/,
  );
  assert.match(builtAssets, /toAgent:[^,}]*to_agent/);
});

test("built feed gives every row a literal identity badge and explicit readable target", () => {
  for (const token of [
    "dashboard__message-identity-badge",
    "dashboard__message-target",
    "AGENT",
    "PERSON",
    "→ everyone",
    "an agent",
    "workspace member",
  ]) {
    assert.ok(builtAssets.includes(token), `built /app is missing ${token}`);
  }
  assert.match(
    renderFeed,
    /signal\.toAgent !== null[\s\S]*targetAgent\?\.name \?\? "an agent"[\s\S]*signal\.to !== null[\s\S]*people\.get\(signal\.to\) \?\? "a workspace member"[\s\S]*"→ everyone"/,
  );
});

test("agent feed attribution says operated by and retires owned by in that renderer", () => {
  assert.ok(builtAssets.includes("operated by"));
  assert.doesNotMatch(renderFeed, /owned by/);
  assert.match(renderFeed, /people\.get\(authorAgent\.ownerUserId\) \?\? "Workspace member"/);
});

test("direct-to-viewer rows ship a distinct tint for people and their operated agents", () => {
  assert.ok(builtAssets.includes("dashboard__message--direct-to-viewer"));
  assert.match(
    renderFeed,
    /signal\.to === session\?\.user\.id[\s\S]*targetAgent\?\.ownerUserId === session\?\.user\.id/,
  );
  assert.match(
    builtAssets,
    /\.dashboard__message--direct-to-viewer\{[^}]*background:/,
  );
});

test("feed hierarchy is structural and makes no unmeasured visibility claim", () => {
  for (const selector of [
    ".dashboard__message-meta strong",
    ".dashboard__message-identity-badge",
    ".dashboard__message-operator",
    ".dashboard__message-meta time",
    ".dashboard__message-body>p",
  ]) {
    assert.ok(builtAssets.includes(selector), `built /app CSS is missing ${selector}`);
  }
  assert.doesNotMatch(renderFeed, /only .* sees|private|lock icon/i);
});
