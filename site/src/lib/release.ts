/**
 * The shipping CLI version and the version surfaces built from it, in one shared module.
 *
 * WHY THIS FILE EXISTS. Three strings on /download each carried their own `0.1.4`
 * literal — the pinned install command (lib/install.ts), the "pin a version" card
 * (OtherWays.astro), and the `cswarm --version` example (AfterInstall.astro). A release
 * bump meant editing three strings in two files, and one missed copy shipped a page that
 * told a stranger to pin a release that does not exist. The F-1 gate that guarded the
 * old shape only hard-coded "0.1.4 present, 0.1.3 absent" — it rotted with the next
 * bump. This module is the replacement: everything derives, nothing is copied.
 *
 * WHERE THE VERSIONS COME FROM:
 *   • the CLI version is the repo-root package.json `version` — the same field that
 *     feeds CLI_BUILD_VERSION for the binary's own `--version` output (src/cli.ts);
 *   • the protocol version is imported from the protocol's one source,
 *     CLIENT_PROTOCOL_VERSION in src/cloud/config.ts, never re-typed here.
 * A version bump therefore touches exactly one file: the repo-root package.json. The
 * /download gate (site/scripts/download-version.test.mjs) proves a CLEAN built page
 * carries precisely what this module derives and rejects a stale artifact.
 *
 * WHY IT LOADS IN BOTH PLACES IT IS NEEDED. Astro/Vite runs it in component frontmatter
 * at build time; the repo's test runner runs it via `node --import tsx`. A JSON module
 * import attribute is plain ESM that both resolve, the repo-root config.ts import is a
 * normal TypeScript module import, and neither mechanism is a Node keepsake that Vite
 * would have to special-case.
 */

import pkg from "../../../package.json" with { type: "json" };
import { CLIENT_PROTOCOL_VERSION } from "../../../src/cloud/config.ts";

if (typeof pkg.version !== "string" || !pkg.version) {
  throw new Error(
    "release: repo-root package.json has no readable `version`. /download states the " +
      "shipping CLI version and must not render a blank or a guess.",
  );
}

/** The shipping CLI version — sole source, the repo-root package.json `version`. */
export const CLI_VERSION: string = pkg.version;

/** Exactly the shape the binary prints for `cswarm --version` (src/cli.ts composes it the same way). */
export const CLI_VERSION_LINE = `cswarm ${CLI_VERSION} (protocol ${CLIENT_PROTOCOL_VERSION})`;