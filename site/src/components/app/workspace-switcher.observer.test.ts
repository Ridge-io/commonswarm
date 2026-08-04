import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/*
 * Observer for the one workspace control at the top of the authenticated rail. The site
 * test script reaches this file through its recursive component-observer glob. Static
 * assertions protect the state machine; built HTML and assets prove Astro ships the door.
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

const between = (source: string, start: string, end: string): string => {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing observer start anchor: ${start}`);
  assert.notEqual(endAt, -1, `missing observer end anchor: ${end}`);
  return source.slice(startAt, endAt);
};

test("the built rail starts with exactly one current-workspace control", () => {
  const rail = between(appHtml, '<aside class="dashboard__rail"', '<section class="dashboard__channel"');
  const control = rail.indexOf("data-workspace-menu-root");
  const streams = rail.indexOf("dashboard-streams-label");

  assert.ok(control >= 0 && control < streams, "the workspace control must be first in the rail");
  assert.equal((rail.match(/data-workspace-menu-trigger/g) ?? []).length, 1);
  assert.match(rail, /data-sidebar-workspace-name>Workspace</);
  assert.doesNotMatch(rail, /dashboard__workspace-switcher/);
  assert.match(rail, /href="\/" aria-label="CommonSwarm home">CommonSwarm</);
});

test("the menu renders every reachable workspace, marks the current one, and creates at the bottom", () => {
  const renderer = between(dashboard, "const renderWorkspaceList =", "const renderRoster =");
  const menu = between(
    appHtml,
    'id="dashboard-workspace-menu"',
    '<section class="dashboard__workspace-context"',
  );

  assert.match(dashboard, /workspaces = await workspaceMemberships\(\)/);
  assert.match(renderer, /for \(const workspace of workspaces\)/);
  assert.match(renderer, /role", "menuitemradio"/);
  assert.match(renderer, /aria-checked", String\(workspace\.id === selected\.id\)/);
  assert.match(renderer, /label\.textContent = workspace\.name/);
  assert.ok(menu.indexOf("data-workspace-list") < menu.indexOf("data-new-workspace"));
  assert.match(menu, />\+<[^]*>New workspace</);
  assert.match(dashboard, /data-new-workspace[^]*addEventListener\([^]*openNewWorkspace/);
  assert.match(dashboard, /const openNewWorkspace =[^]*renderCreate\(session\)/);
  assert.match(dashboard, /const made = await createWorkspace\(/);
  assert.match(
    dashboard,
    /workspaces = \[\s*madeWorkspace,\s*\.\.\.workspaces\.filter/,
    "creating another workspace must retain the memberships already loaded into the menu",
  );
});

test("the workspace menu supports keyboard, Escape focus restore, and click-outside close", () => {
  assert.match(
    appHtml,
    /data-workspace-menu-trigger[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-controls="dashboard-workspace-menu"/,
  );
  assert.match(dashboard, /event\.key !== "ArrowDown" && event\.key !== "ArrowUp"/);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
    assert.ok(dashboard.includes(`"${key}"`), `workspace keyboard handling is missing ${key}`);
  }
  assert.match(
    dashboard,
    /event\.key !== "Escape"[^]*closeWorkspaceMenu\(true\)/,
    "Escape must close and restore focus to the trigger",
  );
  assert.match(
    dashboard,
    /if \(restoreFocus\) trigger\?\.focus\(\{ preventScroll: true \}\)/,
  );
  assert.match(
    dashboard,
    /document\.addEventListener\("pointerdown"[^]*root\.contains\(event\.target as Node\)[^]*closeWorkspaceMenu\(\)/,
  );
  assert.match(dashboard, /document\.addEventListener\("focusin"/);
});

test("creation reuse, Back, and session reset preserve the surrounding dashboard state", () => {
  const create = between(dashboard, "const renderCreate =", "const renderWorkspaceError =");
  const reset = between(
    dashboard,
    "const resetWorkspaceSessionState =",
    "armLiveFeed =",
  );
  const listeners = between(
    dashboard,
    'one<HTMLButtonElement>("[data-create-cancel]")?.addEventListener',
    'one<HTMLButtonElement>("[data-roster-open]")?.addEventListener',
  );

  assert.match(create, /input\.disabled = false/);
  assert.match(create, /button\.disabled = false/);
  assert.match(create, /button\.removeAttribute\("aria-busy"\)/);
  assert.match(create, /button\.textContent = "Create workspace"/);
  assert.match(listeners, /showPanel\("channel"\);[\s\S]*returnToChannel\(\)/);
  assert.doesNotMatch(listeners, /renderChannel\(selected\)/);
  assert.match(reset, /workspaceTrigger\.setAttribute\("aria-label", "Choose workspace"\)/);
  assert.match(reset, /workspaceTrigger\.removeAttribute\("title"\)/);
  assert.match(reset, /workspaceName\.value = ""/);
});

test("the emitted browser assets carry the workspace menu behavior and presentation", () => {
  for (const token of [
    "data-workspace-menu-trigger",
    "data-workspace-menu-root",
    "data-new-workspace",
    "menuitemradio",
    "Current workspace:",
  ]) {
    assert.ok(builtAssets.includes(token), `built browser assets are missing ${token}`);
  }
  assert.match(builtAssets, /\.dashboard__workspace-menu\{/);
  assert.match(builtAssets, /\.dashboard__workspace-trigger\{/);
  assert.match(builtAssets, /\.dashboard__workspace-button\[aria-checked=true\]/);
});

test("the home link remains reachable beside the switcher at responsive widths", () => {
  assert.match(dashboard, /<div class="dashboard__rail-foot">[\s\S]*?href="\/"/);
  const responsive = between(dashboard, "@media (max-width: 52rem)", "@media (max-width: 34rem)");
  assert.match(responsive, /\.dashboard__rail-foot\s*\{\s*display: contents;/);
  assert.match(responsive, /\.dashboard__rail-account\s*\{\s*display: none;/);
  assert.match(
    responsive,
    /\.dashboard__rail-foot > \.dashboard__wordmark\s*\{[\s\S]*?grid-column: 2;[\s\S]*?grid-row: 1;/,
  );
});
