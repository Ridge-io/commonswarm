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
  assert.match(dashboard, /up to three\s+workspaces, no card\./);
  assert.match(dashboard, /href="\/terms"/);
  assert.match(dashboard, /href="\/privacy"/);
  assert.match(dashboard, /drafts published for review \(not yet in force\)/);
  assert.doesNotMatch(dashboard, /Signing in means you accept/);
  assert.doesNotMatch(dashboard, /<main class="dashboard__root">/);
});

test("the live dashboard offers peer agent and collaborator paths from an empty workspace", () => {
  const dashboard = read("src/components/app/LiveDashboard.astro");
  const connect = read("src/components/connect/AgentConnect.astro");
  const prompt = read("src/components/connect/agent-prompt.ts");

  assert.match(dashboard, /Name your workspace\./);
  assert.match(dashboard, /Name another workspace\./);
  assert.doesNotMatch(dashboard, /data-create-eyebrow/);
  assert.doesNotMatch(dashboard, /<label for="dashboard-workspace-name">/);
  assert.match(dashboard, /id="dashboard-workspace-name"[\s\S]*?aria-label="Workspace name"/);
  assert.match(dashboard, /<summary>Manage people<\/summary>/);
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
  assert.match(
    dashboard,
    /data-workspace-details[\s\S]*data-channel-id/,
    "support-only workspace details retain the ID in a collapsed disclosure",
  );
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
  assert.match(
    dashboard,
    /<button[^>]*class="[^"]*dashboard__mobile-signout[^"]*"[^>]*data-signout[^>]*>/,
    "the authenticated channel must retain a narrow-screen Sign out control",
  );
  assert.match(
    dashboard,
    /@media \(max-width: 52rem\)[\s\S]*\.dashboard__mobile-signout\s*\{[\s\S]*display:\s*inline-flex/,
    "the channel Sign out control must become visible when the desktop rail footer disappears",
  );
  assert.doesNotMatch(dashboard, /cswarm working-on|cswarm note|cswarm ask/);
  assert.match(dashboard, /Waiting for your agent’s first update\./);
  assert.doesNotMatch(connect, /commonswarm\.com\/start/);
  assert.match(prompt, /Workspace id:/);
  assert.match(prompt, /DO NOT ECHO THIS CREDENTIAL BACK/);
  assert.match(prompt, /cswarm working-on/);
});
