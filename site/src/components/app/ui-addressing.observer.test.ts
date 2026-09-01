import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { signalIsDirectToViewer } from "../../lib/signal-feed";

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
    /\.select\("id,from,from_kind,to,to_agent,kind,body,about,until,created_at,attachments"\)/,
  );
  assert.match(clientSource, /toAgent: row\.to_agent === null \|\| row\.to_agent === undefined/);
  assert.match(
    builtAssets,
    /select\([`'"]id,from,from_kind,to,to_agent,kind,body,about,until,created_at,attachments[`'"]\)/,
  );
  assert.match(builtAssets, /toAgent:[^,}]*to_agent/);
});

test("built feed gives every row a literal identity badge and explicit readable target", () => {
  for (const token of [
    "dashboard__message-identity-badge",
    "dashboard__message-target",
    "AGENT",
    "PERSON",
    "everyone",
    "an agent",
    "workspace member",
  ]) {
    assert.ok(builtAssets.includes(token), `built /app is missing ${token}`);
  }
  assert.match(
    renderFeed,
    /target\.append\("→ "\)[\s\S]*signal\.toAgent !== null && targetAgent[\s\S]*targetAgent\.name[\s\S]*signal\.to !== null && people\.has\(signal\.to\)[\s\S]*people\.get\(signal\.to\)![\s\S]*"an agent"[\s\S]*"a workspace member"[\s\S]*"everyone"/,
  );
});

test("agent feed attribution says operated by and retires owned by in that renderer", () => {
  assert.ok(builtAssets.includes("operated by"));
  assert.doesNotMatch(renderFeed, /owned by/);
  assert.match(renderFeed, /const ownerName = people\.get\(authorAgent\.ownerUserId\)/);
  assert.match(
    renderFeed,
    /if \(ownerName\)[\s\S]*\{ kind: "person", id: authorAgent\.ownerUserId \}[\s\S]*operator\.append\("Workspace member"\)/,
  );
});

/* ~~"...and their operated agents"~~ Dead 2026-09-01, operator report: the
 * operated-agent clause degenerated to tinting every directed row in a
 * solo-owner workspace. The tint follows the same person-only rule as the
 * Direct-to-you filter. */
test("direct-to-viewer rows ship a distinct tint for the person only", () => {
  assert.ok(builtAssets.includes("dashboard__message--direct-to-viewer"));
  assert.match(renderFeed, /signalIsDirectToViewer\(signal, viewerId\)/);
  assert.doesNotMatch(renderFeed, /targetAgent\?\.ownerUserId === session\?\.user\.id/);
  assert.match(
    builtAssets,
    /\.dashboard__message--direct-to-viewer\{[^}]*background:/,
  );
});

/* S2 (2026-09-01 inversion review): the tint read
 *   if (signalIsDirectToViewer(signal, viewerId) || signal.to === session?.user.id)
 * and viewerId IS session.user.id whenever a session exists, so the second
 * clause repeated the first and the function was not load-bearing — mutate it
 * to `() => false` and the tint still fired. The regex above could not see
 * that. Two pins close it: the tint's condition is the function call ALONE,
 * and the function itself is person-only. The site test suite has no DOM
 * harness (no jsdom/happy-dom), so the row is not rendered here; the
 * behavioural half is the function the tint now depends on entirely. */
test("the tint depends on signalIsDirectToViewer alone, and that rule is person-only", () => {
  assert.match(
    renderFeed,
    /if \(signalIsDirectToViewer\(signal, viewerId\)\) \{\s*row\.classList\.add\("dashboard__message--direct-to-viewer"\);/,
    "the tint condition must be the shared rule and nothing else",
  );
  assert.doesNotMatch(renderFeed, /signalIsDirectToViewer\(signal, viewerId\) \|\|/);
  /* The retired clause is quoted, struck through, in the dead-marker comment
   * above the tint (kept on purpose: corrections live in the artefact). Read
   * the CODE for a second copy, not the comments. */
  const renderFeedCode = renderFeed.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(
    renderFeedCode,
    /signal\.to === session\?\.user\.id/,
    "no second copy of the direct-to-you rule may sit beside the shared one",
  );
  assert.equal(
    renderFeedCode.match(/dashboard__message--direct-to-viewer/g)?.length,
    1,
    "the tint class must be added from exactly one place",
  );

  // Behaviour of the rule the tint now depends on: to the person, and only then.
  assert.equal(signalIsDirectToViewer({ to: "viewer", toAgent: null }, "viewer"), true);
  assert.equal(
    signalIsDirectToViewer({ to: null, toAgent: "agent-the-viewer-operates" }, "viewer"),
    false,
    "a message to an agent the viewer operates is not direct to the viewer",
  );
  assert.equal(signalIsDirectToViewer({ to: "other", toAgent: null }, "viewer"), false);
  assert.equal(signalIsDirectToViewer({ to: null, toAgent: null }, "viewer"), false);
  assert.equal(
    signalIsDirectToViewer({ to: "", toAgent: null }, ""),
    false,
    "a signed-out viewer (empty id) never matches, even an empty `to`",
  );
});

test("feed hierarchy is structural and makes no unmeasured visibility claim", () => {
  for (const selector of [
    ".dashboard__message-meta strong",
    ".dashboard__message-identity-badge",
    ".dashboard__message-operator",
    ".dashboard__message-meta time",
    ".dashboard__message-markdown",
  ]) {
    assert.ok(builtAssets.includes(selector), `built /app CSS is missing ${selector}`);
  }
  assert.doesNotMatch(renderFeed, /only .* sees|private|lock icon/i);
});
