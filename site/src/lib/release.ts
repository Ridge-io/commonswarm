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
 *   • the CLI version is the default-exported `version` field of the repo-root
 *     package.json — the same field that feeds CLI_BUILD_VERSION for the binary's
 *     own `--version` output (src/cli.ts);
 *   • the protocol version is imported from the protocol's one source,
 *     CLIENT_PROTOCOL_VERSION in src/cloud/config.ts, never re-typed here.
 * A version bump therefore touches the repo-root package manifest and its
 * lockfile (package.json + package-lock.json — `npm version --no-git-tag-version`
 * keeps both in step), and no site string is edited at all. The /download gate
 * (site/scripts/download-version.test.mjs) proves a CLEAN built page carries
 * precisely what this module derives and rejects a stale artifact, and the
 * lockfile gate (site/scripts/release-lockfile.test.mjs) proves the manifest
 * and the lockfile cannot drift apart.
 *
 * WHY IT LOADS IN BOTH PLACES IT IS NEEDED. Astro/Vite runs it in component frontmatter
 * at build time; the repo's test runner runs it via `node --import tsx`. A JSON module
 * import attribute is plain ESM that both resolve, the repo-root config.ts import is a
 * normal TypeScript module import, and neither mechanism is a Node keepsake that Vite
 * would have to special-case.
 *
 * WHY IT MUST NEVER BE IMPORTED FROM `lib/install.ts`. install.ts is imported by
 * browser code (agent-prompt.ts -> AgentConnect bundle). release.ts reads the repo-root
 * package.json and src/cloud/config.ts (which imports node:crypto), so pulling release.ts
 * into that chain ships root-only strings and an externalized node:crypto to the browser.
 * The dependency direction is one-way: THIS module imports install.ts's browser-safe
 * constants (INSTALL_HOST); install.ts imports nothing from here. Pin the command here,
 * and have the Astro components (server/build-time frontmatter) import it from here —
 * never route it back through install.ts.
 */

import pkg from "../../../package.json" with { type: "json" };
import { CLIENT_PROTOCOL_VERSION } from "../../../src/cloud/config.ts";
import { INSTALL_HOST } from "./install.ts";

if (typeof pkg.version !== "string" || !pkg.version) {
  throw new Error(
    "release: repo-root package.json has no readable `version`. /download states the " +
      "shipping CLI version and must not render a blank or a guess.",
  );
}
if (typeof CLIENT_PROTOCOL_VERSION !== "string" || !CLIENT_PROTOCOL_VERSION) {
  throw new Error(
    "release: CLIENT_PROTOCOL_VERSION (src/cloud/config.ts) is empty. /download states " +
      "the protocol version and must not render a blank or a guess.",
  );
}

/** The shipping CLI version — sole source, the repo-root package.json `version`. */
export const CLI_VERSION: string = pkg.version;

/** The protocol version, passed through from its one source (src/cloud/config.ts). */
export { CLIENT_PROTOCOL_VERSION };

/** Exactly the shape the binary prints for `cswarm --version` (src/cli.ts composes it the same way). */
export const CLI_VERSION_LINE = `cswarm ${CLI_VERSION} (protocol ${CLIENT_PROTOCOL_VERSION})`;

/**
 * Pin a version instead of taking latest. `CSWARM_VERSION` is read by the
 * installer itself; it is not a flag we invented for the page. The pipe order and
 * the variable name must not be rearranged. The host comes from the browser-safe
 * INSTALL_HOST in lib/install.ts; this is the server/build-time home of the pinned
 * command so the version halves stay in release.ts and out of the browser bundle.
 */
export const INSTALL_CMD_PINNED =
  `curl -fsSL https://${INSTALL_HOST}/install.sh | CSWARM_VERSION=${CLI_VERSION} sh`;
