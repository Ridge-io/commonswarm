import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const cwd = process.cwd();
const siteRoot = fs.existsSync(path.join(cwd, "src", "components", "app"))
  ? cwd
  : path.join(cwd, "site");

const read = (relative: string): string =>
  fs.readFileSync(path.join(siteRoot, relative), "utf8");

test("every current workspace-creation door enters the dashboard", () => {
  const sources = [
    "src/components/SiteHeader.astro",
    "src/components/SiteFooter.astro",
    "src/components/landing/ConsumerHero.astro",
    "src/components/landing/ConsumerStory.astro",
    "src/components/download/AfterInstall.astro",
  ].map(read);

  for (const source of sources) {
    assert.doesNotMatch(source, /href=["']\/start["']/);
    assert.match(source, /href\s*[:=]\s*["']\/app["']/);
  }
});

test("/start is only a query-and-fragment-preserving compatibility handoff", () => {
  const start = read("src/pages/start.astro");

  assert.match(start, /new URL\("\/app", window\.location\.origin\)/);
  assert.match(start, /target\.search = window\.location\.search/);
  assert.match(start, /target\.hash = window\.location\.hash/);
  assert.match(start, /window\.location\.replace\(target\.href\)/);
  assert.doesNotMatch(start, /Progress|SignInPanel|ReadyPanel|AgentConnect/);
  assert.deepEqual(
    fs.readdirSync(path.join(siteRoot, "src", "components", "start")).sort(),
    ["onramp.observer.mjs"],
    "retired signup panels must not remain available for an accidental rewire",
  );
});

test("/app is email-first, truthful about the free tier, and owns consent", () => {
  const dashboard = read("src/components/app/LiveDashboard.astro");
  const emailAt = dashboard.indexOf('id="dashboard-email"');
  const githubAt = dashboard.indexOf("data-signin-github");

  assert.ok(emailAt >= 0);
  assert.ok(githubAt > emailAt, "email must appear before GitHub in the signed-out gateway");
  assert.match(dashboard, /data-auth-view="choices"/);
  assert.match(dashboard, /No password\./);
  assert.match(dashboard, /up to ten\s+workspaces, no card\./);
  assert.match(dashboard, /href="\/terms"/);
  assert.match(dashboard, /href="\/privacy"/);
  assert.match(dashboard, /drafts published for review \(not yet in force\)/);
  assert.doesNotMatch(dashboard, /Signing in means you accept/);
  assert.doesNotMatch(dashboard, /<main class="dashboard__root">/);
});

test("the live dashboard offers peer agent and collaborator paths from an empty workspace", () => {
  const dashboard = read("src/components/app/LiveDashboard.astro");
  const settings = read("src/lib/workspace-settings.ts");
  const connect = read("src/components/connect/AgentConnect.astro");
  const prompt = read("src/components/connect/agent-prompt.ts");

  assert.match(dashboard, /Name your workspace\./);
  assert.match(dashboard, /Name another workspace\./);
  assert.doesNotMatch(dashboard, /data-create-eyebrow/);
  assert.doesNotMatch(dashboard, /<label for="dashboard-workspace-name">/);
  assert.match(dashboard, /id="dashboard-workspace-name"[\s\S]*?aria-label="Workspace name"/);
  // Manage people moved off the rail into the header "People & agents" dialog
  // (operator direction 2026-08-19): the member-management surface now lives as a
  // section inside that dialog, not a rail <details>.
  assert.match(dashboard, /id="dashboard-roster-title">\s*People &amp; agents/);
  assert.match(dashboard, /class="dashboard__roster-dialog-members" data-member-details/);
  assert.doesNotMatch(dashboard, /data-member-count/);
  assert.match(dashboard, /Choose who joins first\./);
  assert.match(dashboard, /data-add-agent/);
  assert.match(dashboard, /data-invite-collaborator/);
  assert.match(dashboard, /Invite a collaborator/);
  assert.doesNotMatch(dashboard, /data-add-agent-channel/);
  const noAgents = dashboard.match(
    /data-channel-view="no-agents"[\s\S]*?<\/section>/,
  )?.[0] ?? "";
  assert.equal(
    [...noAgents.matchAll(/data-add-agent(?=[\s>])/g)].length,
    1,
    "zero-agent state must render exactly one Add-agent action",
  );
  assert.equal(
    [...noAgents.matchAll(/data-invite-collaborator(?=[\s>])/g)].length,
    1,
    "zero-agent state must render exactly one collaborator-invite action",
  );
  assert.match(
    dashboard,
    /\[data-invite-collaborator\][\s\S]*?openInvite\("channel"\)/,
    "the collaborator action enters the member-invite flow and returns to the channel",
  );
  assert.doesNotMatch(
    dashboard,
    /<p class="dashboard__channel-id">/,
    "the primary channel header must not expose the workspace UUID",
  );
  assert.match(dashboard, /aria-label="Workspace settings"/);
  assert.match(dashboard, /renderWorkspaceSettings\(root,/);
  assert.match(settings, /id\.dataset\.channelId = ""/);
  assert.match(
    dashboard,
    /error instanceof WorkspaceLimitReached \|\| error instanceof WorkspaceOutcomeUnknown[\s\S]*\? ""[\s\S]*: "Trying again checks the same request; it cannot create a duplicate\."/,
  );
  assert.match(connect, /Generate prompt/);
  assert.match(connect, /Copy prompt/);
  assert.equal(
    [...connect.matchAll(/<button\b[^>]*data-action="copy"[^>]*>/g)].length,
    1,
    "the one-time prompt result must render exactly one copy action",
  );
  assert.match(
    connect,
    /\.ac__block\s*\{[\s\S]*?min-inline-size:\s*0;[\s\S]*?inline-size:\s*100%/,
    "the non-wrapping prompt must scroll inside the mobile card, not widen it",
  );
  /*
   * TWO ASSERTIONS DIED HERE on 2026-07-30, by Lead7 ruling, not by bit-rot:
   *   - the rail's Add-an-agent door (`data-add-agent-rail`, hidden in sample mode)
   *   - the mobile collapse sync (`agentRail.open = !narrowRail.matches`)
   * Both locked the rail-resident agent roster, which the workspace-header roster
   * redesign moved OUT of the rail: the header carries a stack button that opens the
   * management dialog, and the rail must not grow with agent count. The successor
   * assertions live in header-roster.observer.test.ts, picked up by the same glob.
   */
  /*
   * RETIRED CLAIM (2026-09-03). These two assertions required a SECOND Sign out button in the
   * channel header (`dashboard__mobile-signout`), on the premise that "the desktop rail footer
   * disappears" at narrow widths. That premise stopped being true on 2026-08-19, when the rail
   * foot moved INTO the mobile top bar: measured at 390x844, the account trigger sits at the
   * top right and its menu still carries Sign out. The duplicate was 63px of a header row that
   * now has to fit on one line, so it was removed. The successor assertions below pin the door
   * that is actually there.
   */
  assert.match(
    dashboard,
    /<button class="dashboard__text-button dashboard__user-menu-item" type="button" role="menuitem" data-signout>Sign out<\/button>/,
    "the account menu must carry Sign out",
  );
  assert.match(
    dashboard,
    /@media \(max-width: 52rem\)[\s\S]*\.dashboard__rail-foot\s*\{[\s\S]*grid-column:\s*3;[\s\S]*grid-row:\s*1/,
    "the account menu must move into the mobile top bar, which is what makes one Sign out enough",
  );
  assert.doesNotMatch(
    dashboard,
    /dashboard__mobile-signout/,
    "a second Sign out in the channel header is retired; the account menu is the one door",
  );
  /* The trigger moving to the top bar is not enough on its own: the menu opens UPWARD, which
     is right for a rail footer and wrong for a top bar. Measured before this rule at 390x844,
     320x568, and 700x800, the Sign out box sat at a negative top — off the screen. */
  assert.match(
    dashboard,
    /@media \(max-width: 52rem\)[\s\S]*\.dashboard__user-menu\s*\{[\s\S]*inset-block-start:\s*calc\(100% \+ var\(--s-2\)\)/,
    "the account menu must open downward once its trigger sits in the top bar",
  );
  /* The popover is a grid, so a stray placement on one of its items silently reorders the MENU
     while DOM and focus order stay put — measured once, from a leftover rule that put the theme
     toggle on row 3 and painted Sign out first. A text guard here was tried and removed: it went
     red on a COMMENT that quoted the old rule, and stayed green for `grid-area`, for `order`,
     and for a grouped selector. The control is a live one, in
     mobile-feed-layout.observer.test.ts, "the account menu paints in DOM order and stays on
     screen at phone widths"; its mutation is `order: 3` on the toggle. */
  assert.doesNotMatch(dashboard, /cswarm working-on|cswarm note|cswarm ask/);
  assert.match(dashboard, /Waiting for your agent’s first update\./);
  assert.doesNotMatch(connect, /commonswarm\.com\/start/);
  assert.match(prompt, /Workspace id:/);
  assert.match(prompt, /DO NOT ECHO THIS CREDENTIAL BACK/);
  assert.match(prompt, /cswarm working-on/);
});
