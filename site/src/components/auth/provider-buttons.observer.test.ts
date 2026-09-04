/*
 * Controls on the provider list.
 *
 * The load-bearing one is "the rendered buttons and the provider list agree". AGENTS.md
 * records four releases in a row (v0.1.48-v0.1.50) where a user-facing enumeration drifted
 * from the enforcement AFTER two review arms passed, because reading such a sentence means
 * re-deriving the enforcement by hand. These tests do that re-derivation mechanically.
 *
 * THEY MEASURE THE BUILT HTML, NOT THE TEMPLATE. A template that loops over the array proves
 * nothing on its own — a hand-written extra button beside the loop would still render. The
 * dist file is the artifact a visitor receives, so that is what is compared against the
 * array. Run `npm run build` in site/ first; without it these fail for the wrong reason, and
 * the first test says so.
 *
 * THE FLAG IS READ THE SAME WAY THE BUILD READS IT. Expected output comes from
 * enabledProviders(process.env.PUBLIC_SWARM_AUTH_PROVIDERS), so building and testing with the
 * same environment agree, and building with the flag but testing without it goes red — which
 * is the correct answer, not a nuisance.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  AUTH_PROVIDERS,
  AUTH_PROVIDERS_ENV_VAR,
  DEFAULT_AUTH_PROVIDER_IDS,
  UnknownAuthProvider,
  authProvider,
  enabledProviders,
  listSentence,
  providerChoices,
} from "../../lib/auth-providers.js";

const INVITE_HTML = new URL("../../../dist/invite/index.html", import.meta.url);
const COMMONSWARM = new URL("../../lib/commonswarm.ts", import.meta.url);
const ONRAMP = new URL("../invite/InviteOnramp.astro", import.meta.url);
const BUTTONS = new URL("./ProviderButtons.astro", import.meta.url);

const expected = enabledProviders(process.env[AUTH_PROVIDERS_ENV_VAR]);

async function inviteHtml(): Promise<string> {
  try {
    return await readFile(INVITE_HTML, "utf8");
  } catch {
    assert.fail(
      `dist/invite/index.html is missing. Run \`npm run build\` in site/ before this suite; ` +
        `these controls compare the array against BUILT output, not the template.`,
    );
  }
}

function renderedProviderIds(html: string): string[] {
  return [...html.matchAll(/data-signin-provider="([^"]+)"/g)]
    .map((match) => match[1] as string)
    .sort();
}

test("CONTROL: the rendered sign-in buttons are exactly the enabled provider list", async () => {
  const html = await inviteHtml();
  const rendered = renderedProviderIds(html);
  const listed = expected.map((provider) => provider.id).sort();
  assert.deepEqual(
    rendered,
    listed,
    `The invite page renders [${rendered.join(", ")}] but auth-providers.ts enables ` +
      `[${listed.join(", ")}]. A button that is not in AUTH_PROVIDERS would be refused by ` +
      `signInWithProvider; a provider in the list with no button is a door nobody can open.`,
  );
  assert.ok(rendered.length > 0, "the invite page must offer at least one OAuth provider");
});

test("CONTROL: every button label is the label the constant carries, character for character", async () => {
  const html = await inviteHtml();
  for (const provider of expected) {
    const button = new RegExp(
      `<button[^>]*data-signin-provider="${provider.id}"[^>]*>\\s*` +
        `${provider.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</button>`,
    );
    assert.match(
      html,
      button,
      `The ${provider.id} button must read exactly "${provider.label}" — the label in ` +
        `auth-providers.ts. A hand-typed label is an enumeration with no control on it.`,
    );
  }
});

test("CONTROL: a provider this build does not enable appears nowhere on the page", async () => {
  const html = await inviteHtml();
  const enabled = new Set(expected.map((provider) => provider.id));
  const dark = AUTH_PROVIDERS.filter((provider) => !enabled.has(provider.id));
  for (const provider of dark) {
    assert.doesNotMatch(
      html,
      new RegExp(provider.name, "i"),
      `"${provider.name}" is not enabled in this build but its name is on the invite page. ` +
        `Landing dark means the copy is dark too, not just the button.`,
    );
  }
});

test("CONTROL: the enforcement accepts every rendered id and refuses anything else", async () => {
  const html = await inviteHtml();
  for (const id of renderedProviderIds(html)) {
    assert.doesNotThrow(
      () => authProvider(id),
      `The page renders a ${id} button but signInWithProvider would refuse that id.`,
    );
  }
  assert.throws(() => authProvider("facebook"), UnknownAuthProvider);
  assert.throws(() => authProvider(""), UnknownAuthProvider);
  assert.throws(() => authProvider("GitHub"), UnknownAuthProvider);
});

test("CONTROL: signInWithOAuth is called once and never with a literal provider", async () => {
  const source = await readFile(COMMONSWARM, "utf8");
  const calls = source.match(/signInWithOAuth\(/g) ?? [];
  assert.equal(
    calls.length,
    1,
    "There must be exactly one signInWithOAuth call site. A second one is a second " +
      "enforcement, and two enforcements drift.",
  );
  assert.doesNotMatch(
    source,
    /signInWithOAuth\(\{[\s\S]{0,80}?provider:\s*["'`]/,
    "The provider passed to Supabase must come from authProvider(), not from a string " +
      "literal. A literal is the drift this module exists to prevent.",
  );
  assert.match(source, /const entry = authProvider\(provider\);/);
  assert.match(source, /provider: entry\.id,/);
});

test("CONTROL: the invite onramp never names a provider in a literal", async () => {
  const source = await readFile(ONRAMP, "utf8");
  for (const provider of AUTH_PROVIDERS) {
    assert.doesNotMatch(
      source,
      new RegExp(provider.name),
      `InviteOnramp.astro names "${provider.name}" directly. Provider names in that file ` +
        `must be derived from the rendered buttons through authProvider(), so the sentence ` +
        `and the buttons cannot disagree.`,
    );
  }
  assert.match(source, /renderedProviderNames\(\)/);
  assert.match(source, /listSentence\(renderedProviderNames\(\)\)/);
});

test("the flag name in the component matches AUTH_PROVIDERS_ENV_VAR", async () => {
  const source = await readFile(BUTTONS, "utf8");
  assert.match(
    source,
    new RegExp(`import\\.meta\\.env\\.${AUTH_PROVIDERS_ENV_VAR}`),
    `ProviderButtons.astro must read import.meta.env.${AUTH_PROVIDERS_ENV_VAR}. Vite only ` +
      `substitutes a statically written PUBLIC_ name, so this one literal is required — and ` +
      `this control is why it cannot drift from the exported constant.`,
  );
  assert.ok(AUTH_PROVIDERS_ENV_VAR.startsWith("PUBLIC_"));
});

test("enabledProviders: default, selection, order, and operator typos", () => {
  assert.deepEqual(
    enabledProviders(null).map((provider) => provider.id),
    [...DEFAULT_AUTH_PROVIDER_IDS],
  );
  assert.deepEqual(enabledProviders(undefined).map((p) => p.id), [...DEFAULT_AUTH_PROVIDER_IDS]);
  assert.deepEqual(enabledProviders("").map((p) => p.id), [...DEFAULT_AUTH_PROVIDER_IDS]);
  assert.deepEqual(enabledProviders("   ").map((p) => p.id), [...DEFAULT_AUTH_PROVIDER_IDS]);
  assert.deepEqual(enabledProviders("github,google").map((p) => p.id), ["github", "google"]);
  assert.deepEqual(enabledProviders(" GitHub , GOOGLE ").map((p) => p.id), ["github", "google"]);
  assert.deepEqual(enabledProviders("google").map((p) => p.id), ["google"]);
  // Order follows AUTH_PROVIDERS, never the operator's typing order.
  assert.deepEqual(enabledProviders("google,github").map((p) => p.id), ["github", "google"]);
  // A typo must not blank the sign-in page.
  assert.deepEqual(enabledProviders("gooogle").map((p) => p.id), [...DEFAULT_AUTH_PROVIDER_IDS]);
  assert.deepEqual(enabledProviders("gooogle,github").map((p) => p.id), ["github"]);
});

test("providerChoices reads as a sentence for one, two, and three providers", () => {
  assert.equal(listSentence([]), "");
  assert.equal(listSentence(["GitHub"]), "GitHub");
  assert.equal(listSentence(["GitHub", "Google"]), "GitHub or Google");
  assert.equal(listSentence(["GitHub", "Google", "Apple"]), "GitHub, Google, or Apple");
  assert.equal(providerChoices(enabledProviders("github,google")), "GitHub or Google");
  assert.equal(providerChoices(enabledProviders("github")), "GitHub");
});

test("AUTH_PROVIDERS ids are unique and are the strings GoTrue takes verbatim", () => {
  const ids = AUTH_PROVIDERS.map((provider) => provider.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate provider id");
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]*$/);
  for (const provider of AUTH_PROVIDERS) {
    assert.ok(provider.label.includes(provider.name), "the label must contain the name");
  }
  // Measured 2026-09-04 on https://api.commonswarm.com/auth/v1/settings: GoTrue enumerates
  // both of these as providers it knows. Neither id is invented.
  assert.deepEqual(ids, ["github", "google"]);
});
