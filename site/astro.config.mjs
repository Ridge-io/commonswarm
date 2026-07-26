// @ts-check
import { defineConfig } from "astro/config";

// Static output on purpose. The site has no server-side behaviour — the one interactive
// piece is a client-side illustration that makes no network calls — so a static build is
// the fastest thing to serve and the cheapest thing to host.
//
// `site` is required for canonical URLs and the OG tags in Base.astro to resolve to
// absolute URLs. It is a placeholder until the real domain is decided; the CTA install URL
// is likewise not live yet (there is no public dist repo). Both are tracked as launch
// blockers rather than quietly invented.
export default defineConfig({
  // DO NOT put a plausible-sounding domain here. "coswarm.dev" was used as a placeholder and
  // it is a REAL, UNRELATED SHIPPING PRODUCT (a self-hosted Docker Swarm PaaS) whose
  // /install.sh returns HTTP 200 and runs as root. The hero's copy button was handing readers
  // a command that would root-install a stranger's software. Verified live before this fix.
  // NO DOMAIN IS DECIDED. .invalid is reserved by RFC 2606 and can never resolve, which is the
  // point: a placeholder must not be a real host. Do NOT put coswarm.dev here -- it is a live,
  // unrelated product whose /install.sh returns 200 and runs as root.
  site: "https://coswarm.invalid",
  output: "static",
  build: {
    inlineStylesheets: "auto",
  },
  compressHTML: true,
});
