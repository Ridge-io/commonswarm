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
  assert.match(connect, /Create the copy-paste prompt/);
  assert.match(connect, /Copy prompt/);
  assert.doesNotMatch(connect, /commonswarm\.com\/start/);
  assert.match(prompt, /Workspace id:/);
  assert.match(prompt, /DO NOT ECHO THIS CREDENTIAL BACK/);
  assert.match(prompt, /cswarm working-on/);
});
