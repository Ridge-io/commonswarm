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
    "src/components/landing/Hero.astro",
    "src/components/landing/Invite.astro",
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
  assert.match(dashboard, /Free: up to three\s+live workspaces\. No card\./);
  assert.match(dashboard, /href="\/terms"/);
  assert.match(dashboard, /href="\/privacy"/);
  assert.match(dashboard, /drafts published for review \(not yet in force\)/);
  assert.doesNotMatch(dashboard, /Signing in means you accept/);
  assert.doesNotMatch(dashboard, /<main class="dashboard__root">/);
});

test("the live dashboard retains the empty-channel to copy-prompt path", () => {
  const dashboard = read("src/components/app/LiveDashboard.astro");
  const connect = read("src/components/connect/AgentConnect.astro");
  const prompt = read("src/components/connect/agent-prompt.ts");

  assert.match(dashboard, /You don’t have a workspace yet/);
  assert.match(dashboard, /Nobody else is here yet/);
  assert.match(dashboard, /data-add-agent/);
  assert.match(
    dashboard,
    /data-add-agent-channel[\s\S]*one<HTMLButtonElement>\("\[data-add-agent-channel\]"\)\?\.addEventListener\("click", openConnect\)/,
  );
  assert.match(
    dashboard,
    /const addInChannel = one<HTMLButtonElement>\("\[data-add-agent-channel\]"\);[\s\S]*addInChannel\.hidden = sampleMode \|\| agents\.length === 0/,
  );
  assert.doesNotMatch(
    dashboard,
    /\.dashboard__rail-label-row,\s*\.dashboard__rail-agents,\s*\.dashboard__channel-add/,
    "the narrow layout may hide the rail, but not the channel-level Add agent control",
  );
  assert.match(
    dashboard,
    /@media \(max-width: 34rem\)[\s\S]*\.dashboard__channel-head \{[\s\S]*flex-direction: column[\s\S]*\.dashboard__channel-actions \{[\s\S]*inline-size: 100%;[\s\S]*flex-wrap: wrap/,
  );
  assert.match(
    dashboard,
    /error instanceof WorkspaceLimitReached \|\| error instanceof WorkspaceOutcomeUnknown[\s\S]*\? ""[\s\S]*: "Trying again checks the same request; it cannot create a duplicate\."/,
  );
  assert.match(connect, /Create the copy-paste prompt/);
  assert.match(connect, /Copy prompt/);
  assert.doesNotMatch(connect, /commonswarm\.com\/start/);
  assert.match(prompt, /Workspace id:/);
  assert.match(prompt, /DO NOT ECHO THIS CREDENTIAL BACK/);
  assert.match(prompt, /cswarm working-on/);
});
