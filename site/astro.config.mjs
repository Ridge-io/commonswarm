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
  site: "https://coswarm.dev",
  output: "static",
  build: {
    inlineStylesheets: "auto",
  },
  compressHTML: true,
});
