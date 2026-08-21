import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(siteDir, "dist");
/* The consumer promise. This constant is a SYNC BOUNDARY, not a copy control: its job is to
 * keep the OG alt text and the social card describing whatever the homepage currently
 * promises. Moving it when the promise moves is the gate working; moving it to make a diff
 * pass would not be. The card image itself is regenerated from scripts/og-card.mjs.
 *
 * 2026-08-21: this boundary was NOT sufficient and the gap is worth naming. It pinned alt
 * to this constant and the constant to nothing, so the social card kept promising "Your
 * agents can reach your teammates' agents" through TWO homepage rewrites — every shared
 * link previewed copy that was no longer on the page, and every gate stayed green. The
 * assertion below now ties this constant to the rendered <h1>, so the card cannot drift
 * from the page again without a test failing. */
const currentOgHeadline = "Your agents stop working blind.";
const currentOgMechanism = "One prompt connects each agent";
const retiredOgCommand = "cswarm accept --link-stdin";

const routes = [
  { name: "home", path: "/", file: "index.html" },
  { name: "start", path: "/start", file: "start/index.html" },
  { name: "download", path: "/download", file: "download/index.html" },
  { name: "app", path: "/app", file: "app/index.html" },
  { name: "terms", path: "/terms", file: "terms/index.html" },
  { name: "privacy", path: "/privacy", file: "privacy/index.html" },
  {
    name: "acceptable-use",
    path: "/acceptable-use",
    file: "acceptable-use/index.html",
  },
];

const decode = (value) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const attrs = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)]
      .slice(1)
      .map((match) => [match[1], decode(match[2] ?? "")]),
  );

const tags = (html, name) =>
  [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((match) =>
    attrs(match[0])
  );

const one = (items, predicate, message) => {
  const matches = items.filter(predicate);
  assert.equal(matches.length, 1, `${message}: expected one, found ${matches.length}`);
  return matches[0];
};

test("L4: every built route publishes coherent, route-specific social metadata", async () => {
  const observed = [];

  for (const route of routes) {
    const html = await readFile(join(distDir, route.file), "utf8");
    const metas = tags(html, "meta");
    const links = tags(html, "link");
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    assert.ok(titleMatch, `${route.name}: missing title`);
    const title = decode(titleMatch[1].trim());
    const meta = (kind, key) =>
      one(metas, (item) => item[kind] === key, `${route.name}: ${kind}=${key}`)
        .content;
    const link = (rel) =>
      one(links, (item) => item.rel === rel, `${route.name}: link rel=${rel}`);

    const description = meta("name", "description");
    const canonical = link("canonical").href;
    const expectedCanonical = `https://commonswarm.com${route.path}`;
    assert.equal(canonical, expectedCanonical, `${route.name}: canonical`);

    assert.equal(meta("property", "og:title"), title, `${route.name}: og:title`);
    assert.equal(
      meta("property", "og:description"),
      description,
      `${route.name}: og:description`,
    );
    assert.equal(
      meta("property", "og:url"),
      expectedCanonical,
      `${route.name}: og:url`,
    );
    assert.equal(
      meta("property", "og:image"),
      "https://commonswarm.com/og.png",
      `${route.name}: og:image`,
    );
    assert.equal(meta("property", "og:image:type"), "image/png");
    assert.equal(meta("property", "og:image:width"), "1200");
    assert.equal(meta("property", "og:image:height"), "630");
    const ogImageAlt = meta("property", "og:image:alt");
    assert.ok(
      ogImageAlt.includes(currentOgHeadline),
      `${route.name}: OG alt does not describe the current consumer promise`,
    );
    assert.ok(
      ogImageAlt.includes(currentOgMechanism),
      `${route.name}: OG alt does not describe the current connection mechanism`,
    );
    assert.equal(
      ogImageAlt.includes(retiredOgCommand),
      false,
      `${route.name}: OG alt still describes the invite-era command`,
    );

    /* THE TIE THAT WAS MISSING (2026-08-21). Everything above pins the alt to a constant in
     * this file; this pins the constant to what the homepage actually says. Apostrophes are
     * normalised because the card and alt use typographic ’ while the h1 renders &#39;, and
     * comparing raw would fail for a reason that has nothing to do with the promise. */
    if (route.name === "home") {
      const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "";
      const normalise = (value) =>
        value.replace(/<[^>]+>/g, "").replace(/&#39;|&rsquo;|’/g, "'").replace(/\s+/g, " ").trim();
      assert.equal(
        normalise(h1).length > 0,
        true,
        "home: could not read the h1 to compare against the social card",
      );
      assert.equal(
        normalise(currentOgHeadline),
        normalise(h1),
        "home: the social card promises something the homepage no longer says",
      );
    }

    assert.equal(meta("name", "twitter:card"), "summary_large_image");
    assert.equal(meta("name", "twitter:title"), title, `${route.name}: twitter:title`);
    assert.equal(
      meta("name", "twitter:description"),
      description,
      `${route.name}: twitter:description`,
    );
    assert.equal(
      meta("name", "twitter:image"),
      "https://commonswarm.com/og.png",
      `${route.name}: twitter:image`,
    );
    assert.equal(
      meta("name", "twitter:image:alt"),
      meta("property", "og:image:alt"),
      `${route.name}: twitter image alt`,
    );

    assert.deepEqual(link("icon"), {
      rel: "icon",
      href: "/favicon.svg",
      type: "image/svg+xml",
    });
    assert.equal(link("apple-touch-icon").href, "/apple-touch-icon.png");
    assert.equal(link("manifest").href, "/site.webmanifest");

    const themeColors = metas.filter((item) => item.name === "theme-color");
    assert.deepEqual(themeColors, [
      {
        name: "theme-color",
        content: "#f4f6fa",
        media: "(prefers-color-scheme: light)",
      },
      {
        name: "theme-color",
        content: "#08090c",
        media: "(prefers-color-scheme: dark)",
      },
    ]);

    observed.push({ title, description });
  }

  assert.equal(
    new Set(observed.map((item) => item.title)).size,
    routes.length,
    "titles must be route-specific",
  );
  assert.equal(
    new Set(observed.map((item) => item.description)).size,
    routes.length,
    "descriptions must be route-specific",
  );
});

test("L4: linked icon, manifest, and social-card assets agree with their metadata", async () => {
  const [manifestText, favicon, apple, png, generator] = await Promise.all([
    readFile(join(distDir, "site.webmanifest"), "utf8"),
    readFile(join(distDir, "favicon.svg"), "utf8"),
    readFile(join(distDir, "apple-touch-icon.png")),
    readFile(join(distDir, "og.png")),
    readFile(join(siteDir, "scripts/og-card.mjs"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.name, "CommonSwarm");
  assert.equal(manifest.short_name, "CommonSwarm");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.background_color, "#f4f6fa");
  assert.equal(manifest.theme_color, "#f4f6fa");
  assert.ok(
    manifest.icons.some(
      (icon) =>
        icon.src === "/favicon.svg" &&
        icon.sizes === "any" &&
        icon.type === "image/svg+xml",
    ),
    "manifest must point at the scalable favicon",
  );

  assert.match(favicon, /<title>CommonSwarm<\/title>/);
  assert.equal(apple.readUInt32BE(16), 180, "apple icon width");
  assert.equal(apple.readUInt32BE(20), 180, "apple icon height");
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", "OG image signature");
  assert.equal(png.readUInt32BE(16), 1200, "OG image width");
  assert.equal(png.readUInt32BE(20), 630, "OG image height");
  assert.match(generator, /import sharp from "sharp";/);
  assert.ok(generator.includes(currentOgHeadline));
  assert.ok(generator.includes(currentOgMechanism));
  assert.equal(
    generator.includes("INSTALL_CMD"),
    false,
    "OG card must lead with the consumer mechanism, not an install command",
  );
  assert.equal(
    generator.includes(retiredOgCommand),
    false,
    "OG generator still contains invite-era command",
  );
});
