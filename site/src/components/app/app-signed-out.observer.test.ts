import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { AUTH_PROVIDERS, authProvider } from "../../lib/auth-providers.js";

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
  assert.match(panel, /Sign up or log in<\/h1>/);
  assert.match(panel, /<p class="dashboard__eyebrow">CommonSwarm<\/p>/);
  assert.match(
    panel,
    /Use your email to create an account or log in\./,
  );
  assert.match(panel, /up to ten\s+workspaces, no card\./);
  assert.doesNotMatch(panel, /workspaces you belong to/i);
  assert.doesNotMatch(panel, /invitation/i);

  /*
   * The OAuth control is GENERATED here, so this pins the COMPONENT's position, not a label.
   * The claim it used to make — "Sign in with GitHub" appears after the email field — cannot be
   * made against the source any more and must not be restated as if it could: the label and the
   * provider set now come from auth-providers.ts and the deployment. The built page is checked
   * below instead, which is where a label exists.
   */
  const email = panel.indexOf('id="dashboard-email"');
  const providerButtons = panel.indexOf("<ProviderButtons");
  assert.ok(
    email >= 0 && providerButtons > email,
    "email must precede the generated provider buttons in the shared auth view",
  );
  /*
   * Astro's braced JSX-style template comments are compiled away, so they are not markup. They
   * ARE text in this file, and the comment beside these buttons NAMES the control it replaced.
   * Strip those comments before asserting, or this control goes red on the sentence that
   * explains why it exists.
   */
  const markup = panel.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
  assert.doesNotMatch(
    markup,
    /data-signin-github|Sign in with GitHub/,
    "the signed-out panel must not hand-write a provider button or its label",
  );
  assert.match(panel, /data-auth-view="choices">/);
  assert.doesNotMatch(panel, /data-auth-view="choices" hidden/);
  assert.match(panel, /Email me a sign-in link/);
  assert.match(panel, /No password\. The link returns you to this page\./);
  assert.match(panel, /Use a different address/);

  assert.match(panel, /href="\/terms"/);
  assert.match(panel, /href="\/privacy"/);
  assert.match(panel, /drafts published for review \(not yet in force\)/);
  assert.doesNotMatch(panel, /by using this service you agree/i);

  /*
   * The handler is bound to the panel's own generated buttons, by the generic attribute. A
   * looser `/signInWithProvider\(/` would also match the re-authentication handler further down
   * the file, so it would stay green with this panel's handler deleted.
   */
  assert.match(source, /\[data-signed-out-onramp\] \[data-signin-provider\]/);
  assert.match(source, /signInWithProvider\(\s*\n?\s*button\.dataset\.signinProvider/);
  assert.doesNotMatch(
    source,
    /signInWithGitHub/,
    "the named GitHub wrapper is gone from this page; a dead import would keep it in the bundle",
  );
  assert.match(source, /showAuthView\("choices"\)/);
});

/*
 * The BUILT panel, because the label a reader sees exists only after the build.
 *
 * The source test above cannot say what the buttons read: the component renders one per
 * provider the deployment reported at build time. So this reads dist/app/index.html and asserts
 * the panel's buttons are exactly the providers AUTH_PROVIDERS names, with its labels character
 * for character. It does not require GitHub specifically — that would be the typed claim this
 * lane removed — but it does require the set to be non-empty, because site/.env points at a
 * deployment with a door open and an empty set here would mean the build silently lost it.
 */
test("the built signed-out panel offers generated provider buttons", async () => {
  const html = await readFile(
    new URL("../../../dist/app/index.html", import.meta.url),
    "utf8",
  );
  const start = html.indexOf('data-signed-out-onramp');
  assert.ok(start >= 0, "dist/app/index.html has no signed-out panel; run `npm run build` in site/");
  const end = html.indexOf('data-panel="create"', start);
  assert.ok(end > start, "the signed-out panel has no end in the built page");
  const panel = html.slice(start, end);

  const ids = [...new Set(
    [...panel.matchAll(/data-signin-provider="([^"]+)"/g)].map((match) => match[1] as string),
  )];
  assert.ok(
    ids.length > 0,
    "the built signed-out panel renders no provider button. site/.env points at a deployment " +
      "that reports at least one enabled provider, so an empty set is a lost door, not a state.",
  );
  for (const id of ids) {
    const provider = authProvider(id);
    assert.match(
      panel,
      new RegExp(
        `<button[^>]*data-signin-provider="${provider.id}"[^>]*>\\s*` +
          `${provider.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</button>`,
      ),
      `the ${id} button must read exactly "${provider.label}", the label in auth-providers.ts`,
    );
  }
  assert.ok(
    ids.every((id) => AUTH_PROVIDERS.some((provider) => provider.id === id)),
    "every rendered button must be a provider AUTH_PROVIDERS names",
  );
});
