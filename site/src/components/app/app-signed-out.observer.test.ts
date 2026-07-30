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
  assert.match(panel, /Get your team and agents into one feed\./);
  assert.match(panel, /Create a workspace/);
  assert.match(
    panel,
    /Sign in to create the first workspace or open an existing one/,
  );
  assert.match(panel, /Free: up to three\s+live workspaces\. No card\./);
  assert.doesNotMatch(panel, /workspaces you belong to/i);
  assert.doesNotMatch(panel, /invitation/i);

  const emailView = panel.indexOf('data-auth-view="email"');
  const choicesView = panel.indexOf('data-auth-view="choices"');
  assert.ok(emailView >= 0 && choicesView > emailView, "email must precede GitHub choices in DOM");
  assert.match(panel, /data-auth-view="email">/);
  assert.doesNotMatch(
    panel,
    /data-auth-view="email" hidden/,
    "email is the default visible auth path",
  );
  assert.match(panel, /data-auth-view="choices" hidden/);
  assert.match(panel, /Or continue with GitHub/);
  assert.match(panel, /Email me a sign-in link/);

  assert.match(panel, /href="\/terms"/);
  assert.match(panel, /href="\/privacy"/);
  assert.match(panel, /drafts published for review \(not yet in force\)/);
  assert.doesNotMatch(panel, /by using this service you agree/i);

  assert.match(source, /signInWithGitHub\(new URL\("\/app"/);
  assert.match(source, /showAuthView\("email"\)/);
});
