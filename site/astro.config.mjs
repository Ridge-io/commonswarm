// @ts-check
import { writeFile } from "node:fs/promises";
import { defineConfig } from "astro/config";

const SITE_ORIGIN = "https://commonswarm.com";

/** @type {import("astro").Astro.Integration} */
const sitemap = {
  name: "commonswarm-sitemap",
  hooks: {
    "astro:build:done": async ({ pages, dir }) => {
      const urls = pages
        .map(({ pathname }) => new URL(pathname, SITE_ORIGIN).href)
        .sort()
        .map((url) => `  <url><loc>${url}</loc></url>`)
        .join("\n");
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
      await writeFile(new URL("sitemap.xml", dir), xml, "utf8");
    },
  },
};

// Static output on purpose. Interactive account and workspace behaviour runs in the browser
// against the hosted API, so the site does not need an Astro server runtime.
//
// `site` is required for canonical URLs and the OG tags in Base.astro to resolve to
// absolute URLs. It is the real, live domain: commonswarm.com serves this site through
// Cloudflare DNS, and the install URL (commonswarm.com/install.sh) is live and installs
// cswarm from the public Ridge-io/commonswarm releases. The superseded note here — "a
// placeholder until the real domain is decided; the CTA install URL is likewise not live
// yet" — is dead (2026-07-29); both launch blockers it tracked are resolved.
// WHERE THE BACKEND POINTER COMES FROM, AND WHY THERE IS NO `env:` BLOCK BELOW.
// The web app reads PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY (site/src/lib/
// commonswarm.ts:53-54). Vite exposes any PUBLIC_-prefixed variable to client code without
// being declared anywhere, so nothing has to be listed here for that to work.
//
// No `env: { schema: ... }` is declared ON PURPOSE. This build must succeed with neither
// variable set — that is the honest "not pointed at a backend" build, which renders the
// whole site and lets the app route say so (commonswarm.ts:55 returns null, and the UI
// treats null as a state, not an error). Declaring them as required config would move that
// decision from runtime to build time and turn a documented state into a broken build.
// If you ever add a schema here, make both entries optional, or read WEB-ONBOARDING.md
// first and change your mind.
export default defineConfig({
  // DO NOT put a plausible-sounding domain here. "coswarm.dev" was used as a placeholder and
  // it is a REAL, UNRELATED SHIPPING PRODUCT (a self-hosted Docker Swarm PaaS) whose
  // /install.sh returns HTTP 200 and runs as root. The hero's copy button was handing readers
  // a command that would root-install a stranger's software. Verified live before this fix.
  // The superseded line "NO DOMAIN IS DECIDED" is dead. commonswarm.com is the live public
  // domain. Do NOT put coswarm.dev here -- it is a live, unrelated product whose /install.sh
  // returns 200 and runs as root.
  site: SITE_ORIGIN,
  output: "static",
  integrations: [sitemap],
  build: {
    inlineStylesheets: "auto",
  },
  compressHTML: true,
});
