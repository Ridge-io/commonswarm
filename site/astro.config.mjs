// @ts-check
import { defineConfig } from "astro/config";

// Static output on purpose. The site has no server-side behaviour — the one interactive
// piece is a client-side illustration that makes no network calls — so a static build is
// the fastest thing to serve and the cheapest thing to host.
//
// `site` is required for canonical URLs and the OG tags in Base.astro to resolve to
// absolute URLs. It is the real, live domain: commonswarm.com serves this site through
// Cloudflare DNS, and the install URL (commonswarm.com/install.sh) is live and installs
// cswarm from the public Ridge-io/cloud-swarm releases. The superseded note here — "a
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
  // NO DOMAIN IS DECIDED. .invalid is reserved by RFC 2606 and can never resolve, which is the
  // point: a placeholder must not be a real host. Do NOT put coswarm.dev here -- it is a live,
  // unrelated product whose /install.sh returns 200 and runs as root.
  site: "https://commonswarm.com",
  output: "static",
  build: {
    inlineStylesheets: "auto",
  },
  compressHTML: true,
});
