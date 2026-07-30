import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/*
 * Observer for the workspace-header agent roster, dialog model. Source-anchored like the
 * other app observers: it reads LiveDashboard.astro and asserts the mechanisms, not a
 * render. Picked up by site `npm test` through the observer glob in site package.json.
 *
 * Governing ruling (Lead7, 2026-07-30): the agent roster moves OUT of the rail into a
 * Slack-style header stack button that opens an accessible dialog (responsive sheet at
 * mobile widths). The rail keeps workspace switching, account, and details only, and must
 * not grow with agent count.
 */
const dashboard = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");

test("the rail carries no agent roster: no list, no rail Add door, no collapse sync", () => {
  assert.doesNotMatch(
    dashboard,
    /data-agent-list/,
    "the rail's full agent list is superseded by the header dialog",
  );
  assert.doesNotMatch(dashboard, /data-add-agent-rail/);
  assert.doesNotMatch(dashboard, /rail-mobile-summary/);
  assert.doesNotMatch(
    dashboard,
    /narrowRail|syncAgentRail/,
    "nothing remains that needs collapsing on narrow screens",
  );
  assert.doesNotMatch(
    dashboard,
    /Workspace and agent navigation/,
    "the rail's accessible name went stale when agents moved to the header — it must not return",
  );
  assert.match(dashboard, /aria-label="Workspace navigation and details"/);
});

test("the header control is one stack button with a dialog relationship", () => {
  assert.match(dashboard, /data-header-roster/);
  assert.match(
    dashboard,
    /data-roster-open[^>]*aria-haspopup="dialog"/,
    "the single header control announces that it opens a dialog",
  );
  assert.match(dashboard, /aria-expanded/);
  assert.match(dashboard, /data-header-agent-stack/);
  assert.match(
    dashboard,
    /view and manage agents/,
    "the accessible name says what the button shows and what it does",
  );
  assert.match(
    dashboard,
    /\.dashboard__roster-stack[\s\S]*margin-inline-start:\s*-0\.5rem/,
    "the stack overlaps its uniform circular initials",
  );
});

test("agent avatars keep one shape and one tint mechanism", () => {
  assert.doesNotMatch(
    dashboard,
    /avatarShape|data-avatar-shape/,
    "mixed border-radii on identical initial tiles read as inconsistency, not identity",
  );
  assert.match(dashboard, /dashboard__avatar--tinted/);
  assert.match(dashboard, /--avatar-hue/);
});

test("management lives in a dialog whose first primary action is Add an agent", () => {
  assert.match(dashboard, /<dialog/);
  assert.match(dashboard, /data-roster-dialog/);
  const open = dashboard.indexOf("data-roster-dialog");
  const add = dashboard.indexOf("data-add-agent-dialog");
  const search = dashboard.indexOf("data-roster-search");
  const list = dashboard.indexOf("data-dialog-agent-list");
  assert.ok(open >= 0 && add > open, "the Add door is inside the dialog");
  assert.ok(add < search && search < list, "Add an agent is the first action, then filter, then roster");
  assert.match(
    dashboard,
    /add\.hidden = sampleMode/,
    "sample mode never shows an Add door that cannot mint",
  );
  assert.match(dashboard, /rosterFilter/);
  assert.match(dashboard, /dataset\.removeAgent/);
  assert.match(dashboard, /data-agent-error/);
});

test("the dialog is modal with Escape, backdrop, close, and focus handling", () => {
  assert.match(dashboard, /dialog\.showModal\(\)/);
  assert.match(
    dashboard,
    /event\.target === dialog[\s\S]*dialog\.close\(\)/,
    "backdrop clicks close the dialog",
  );
  assert.match(
    dashboard,
    /dialog\?\.addEventListener\("close"/,
    "every close path (Escape included, via the native cancel) re-syncs aria-expanded",
  );
  assert.match(
    dashboard,
    /one<HTMLButtonElement>\("\[data-roster-open\]"\)[\s\S]*?focus\(\{ preventScroll: true \}\)/,
    "after a removal reload, focus lands back on the stack button that opened the flow",
  );
});

test("the dialog cannot outlive its workspace or session", () => {
  const openWorkspace = dashboard.slice(
    dashboard.indexOf("const openWorkspace ="),
    dashboard.indexOf("const openAgentChoice ="),
  );
  assert.match(openWorkspace, /closeRosterDialog\(\)/);
  const signout = dashboard.slice(
    dashboard.indexOf('for (const button of all<HTMLButtonElement>("[data-signout]"))'),
    dashboard.indexOf(
      'one<HTMLButtonElement>("[data-add-agent]")?.addEventListener("click", openAgentChoice)',
    ),
  );
  assert.match(signout, /closeRosterDialog\(\)/);
});

test("the dialog is a bottom sheet at mobile widths", () => {
  assert.match(
    dashboard,
    /@media \(max-width: 52rem\)[\s\S]*\.dashboard__roster-dialog\s*\{[\s\S]*margin-block-start:\s*auto/,
  );
  assert.match(
    dashboard,
    /\.dashboard__roster-dialog::backdrop/,
  );
});

test("the stack gets its own header row and the body floor gives it back at mobile widths", () => {
  assert.match(
    dashboard,
    /@media \(max-width: 52rem\)[\s\S]*\.dashboard__channel-roster\s*\{[\s\S]*flex:\s*1 1 100%/,
    "the roster row never depends on the workspace name's length",
  );
  assert.match(
    dashboard,
    /\.dashboard__channel--roster \.dashboard__channel-body\s*\{[\s\S]*min-block-size:\s*calc\(100svh - 5\.5rem - 4\.5rem - 3\.5rem\)/,
  );
});

test("unknown agent-authored signals trigger a bounded roster refresh", () => {
  assert.match(
    dashboard,
    /signal\.fromKind === "agent" && !knownAgents\.has\(signal\.from\)/,
    "a new agent's first signal is the join event the roster learns from",
  );
  assert.match(dashboard, /rosterRefreshInFlight/);
  assert.match(
    dashboard,
    /Date\.now\(\) - rosterRefreshAttemptedAt < 10_000/,
    "a failing roster refresh must not retry on every two-second poll",
  );
  assert.match(dashboard, /void refreshRosterForUnknownAgents/);
  assert.match(
    dashboard,
    /setInterval\(\(\) => void refreshLatestSignals\(\), 2_000\)/,
    "the two-second signal polling cadence is preserved",
  );
});
