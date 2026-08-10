import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SITE_ORIGIN,
  discoverCloudTarget,
} from "../../src/cloud/current-target.js";

/* F-1 of the 2026-08-10 dogfood. `install.sh` closes by telling a stranger with no invite to run
 * `cswarm login` and `cswarm new`; both refused with "no Cloud target is selected", and the
 * remedy offered three routes, none open to that reader. Measured cold, in an isolated HOME.
 *
 * The values are published by us on the host the installer came from, so the fix is to ask the
 * deployment. AGENTS.md: "The anon key is a public identifier protected by RLS, not a secret." */

const URL = "https://ukezjcnxjvkpkeezxaew.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig";

const page = (url = URL, key = KEY) =>
  `<html><head><meta name="commonswarm:url" content="${url}">` +
  `<meta name="commonswarm:anon-key" content="${key}"></head></html>`;

const serving = (body: string, status = 200) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

test("F-1: a cold install discovers the deployment it came from", async () => {
  const target = await discoverCloudTarget({ fetcher: serving(page()) });

  assert.equal(target?.url, URL);
  assert.equal(target?.anonKey, KEY);
});

test("F-1: a plaintext origin is refused before any request is made", async () => {
  /* A discovered target is WRITTEN to the credential store, so an origin that can be tampered
   * with in flight chooses where this CLI sends its traffic from then on. */
  let called = false;
  const fetcher = (async () => {
    called = true;
    return new Response(page());
  }) as unknown as typeof fetch;

  const target = await discoverCloudTarget({
    origin: "http://commonswarm.com",
    fetcher,
  });

  assert.equal(target, null);
  assert.equal(called, false, "it contacted a plaintext origin");
});

test("F-1: every failure returns null, so the caller's own error survives", async () => {
  /* Null rather than throw is the point: the caller rethrows the ORIGINAL message, which
   * describes the user's situation. A discovery reporting its own network problem would replace
   * that with a message about ours. */
  const cases: Array<[string, typeof fetch]> = [
    ["404", serving("nope", 404)],
    ["no meta tags", serving("<html><head></head></html>")],
    ["only the url tag", serving(`<meta name="commonswarm:url" content="${URL}">`)],
    ["not a valid target", serving(page("not-a-url", KEY))],
    ["network error", (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch],
  ];

  for (const [name, fetcher] of cases) {
    assert.equal(await discoverCloudTarget({ fetcher }), null, name);
  }
});

test("F-1: the default origin is the public deployment, and it is overridable", async () => {
  /* CONTROL on the request itself. Without asserting the URL, a discovery that fetched some
   * other host — or the right host with the wrong path — would pass every test above. */
  const seen: string[] = [];
  const fetcher = (async (input: string) => {
    seen.push(String(input));
    return new Response(page());
  }) as unknown as typeof fetch;

  await discoverCloudTarget({ fetcher });
  await discoverCloudTarget({ origin: "https://swarm.example.com", fetcher });

  assert.equal(seen[0], `${DEFAULT_SITE_ORIGIN}/start`);
  assert.equal(seen[1], "https://swarm.example.com/start");
  assert.equal(DEFAULT_SITE_ORIGIN, "https://commonswarm.com");
});
