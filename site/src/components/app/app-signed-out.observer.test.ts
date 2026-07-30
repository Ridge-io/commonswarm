import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("signed-out /app onramp is cold-stranger, email-first, free, draft-legal", async () => {
  const source = await readFile(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  const panelStart = source.indexOf('data-panel="signed-out"');
  assert.ok(panelStart >= 0, "signed-out panel must exist");
  const panelEnd = source.indexOf('data-panel="create"', panelStart);
  assert.ok(panelEnd > panelStart);
  const panel = source.slice(panelStart, panelEnd);

  assert.match(panel, /data-signed-out-onramp/);
  assert.match(panel, /See what your agents are doing\./);
  assert.match(panel, /<p class="dashboard__eyebrow">CommonSwarm<\/p>/);
  assert.match(
    panel,
    /Sign in\s+to open yours\. New here\? Signing in starts your free account/,
  );
  assert.match(panel, /up to three\s+workspaces, no card\./);
  assert.doesNotMatch(panel, /workspaces you belong to/i);
  assert.doesNotMatch(panel, /invitation/i);

  const email = panel.indexOf('id="dashboard-email"');
  const github = panel.indexOf("data-signin-github");
  assert.ok(email >= 0 && github > email, "email must precede GitHub in the shared auth view");
  assert.match(panel, /data-auth-view="choices">/);
  assert.doesNotMatch(panel, /data-auth-view="choices" hidden/);
  assert.match(panel, /Sign in with GitHub/);
  assert.match(panel, /Email me a sign-in link/);
  assert.match(panel, /No password\. The link returns you to this page\./);
  assert.match(panel, /Use a different address/);

  assert.match(panel, /href="\/terms"/);
  assert.match(panel, /href="\/privacy"/);
  assert.match(panel, /drafts published for review \(not yet in force\)/);
  assert.doesNotMatch(panel, /by using this service you agree/i);

  assert.match(source, /signInWithGitHub\(new URL\("\/app"/);
  assert.match(source, /showAuthView\("choices"\)/);
});
