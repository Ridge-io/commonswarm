import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/*
 * Observer for the Slack-shaped workspace shell. The site gate reaches this file through
 * its recursive component observer-test glob. Source assertions pin the state machine and the
 * bounded rail; emitted assets prove Astro ships the light field and typographic hierarchy.
 */
const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");
const dashboard = readFileSync(join(componentDir, "LiveDashboard.astro"), "utf8");
const appHtml = readFileSync(join(siteRoot, "dist", "app", "index.html"), "utf8");
const assetPaths = Array.from(
  appHtml.matchAll(/(?:src|href)="\/(_astro\/[^"?#]+\.(?:js|css))/g),
  (match) => match[1]!,
);
const builtAssets = assetPaths
  .map((assetPath) => readFileSync(join(siteRoot, "dist", assetPath), "utf8"))
  .join("\n");

test("the workspace shell is grouped as streams, people, and bounded agent navigation", () => {
  for (const token of [
    "STREAMS",
    "PEOPLE",
    "AGENTS",
    "# all-signals",
    "Every agent belongs to a person. Workspace-owned agents are not supported yet.",
    "data-sidebar-people-list",
    "data-sidebar-agent-list",
  ]) {
    assert.ok(dashboard.includes(token), `dashboard shell is missing ${token}`);
  }
  assert.match(
    dashboard,
    /\.dashboard__sidebar-agent-list\s*\{[\s\S]*?max-block-size:\s*14rem;[\s\S]*?overflow-y:\s*auto;/,
    "the AGENTS rail must have a fixed maximum height and its own vertical scroll",
  );
  assert.match(dashboard, /const renderSidebarParticipants =/);
  assert.match(dashboard, /renderSidebarParticipants\(\);/);
});

test("the channel header says what the immutable all-signals stream is", () => {
  assert.match(dashboard, /># all-signals<\/h1>/);
  assert.ok(
    dashboard.includes("Intent posted by every agent in this workspace. Immutable, and never a claim."),
  );
});

test("feed filters are client-side and direct-to-you shares the row-target predicate", () => {
  for (const filter of ["all", "broadcast", "direct-to-you"]) {
    assert.match(dashboard, new RegExp(`data-feed-filter="${filter}"`));
  }
  assert.match(
    dashboard,
    /type SignalFilter = "all" \| "broadcast" \| "direct-to-you";/,
  );
  assert.match(dashboard, /let signalFilter: SignalFilter = "all";/);
  assert.match(dashboard, /const signalIsDirectToViewer = \([\s\S]*?signal: Signal/);
  assert.match(dashboard, /const visibleSignals = signals\.filter/);
  assert.match(dashboard, /signalFilter === "broadcast"[\s\S]*signalIsBroadcast/);
  assert.match(dashboard, /signalFilter === "direct-to-you"[\s\S]*signalIsDirectToViewer/);
});

test("sidebar counts come from loaded signals and the shipped field stays light", () => {
  assert.match(dashboard, /const broadcastCount = signals\.filter\(signalIsBroadcast\)\.length;/);
  assert.match(dashboard, /const directCount = signals\.length - broadcastCount;/);
  assert.ok(builtAssets.includes("dashboard__workspace-summary"));
  assert.ok(builtAssets.includes("dashboard__feed-filters"));
  assert.match(
    builtAssets,
    /\.dashboard\{[^}]*--dashboard-field:#f7f6f2[^}]*--dashboard-ink:#1d1c1d/,
    "the dashboard owns a stable neutral light field even when the OS prefers dark",
  );
});

test("agent navigation keeps identity explicit and uses presence as a secondary cue", () => {
  assert.match(dashboard, /className = "dashboard__sidebar-agent"/);
  assert.match(dashboard, /className = "dashboard__presence-dot"/);
  assert.match(dashboard, /badge\.textContent = "AGENT"/);
  assert.match(dashboard, /operated by/);
});
