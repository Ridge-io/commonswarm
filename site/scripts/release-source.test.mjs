import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLI_VERSION,
  CLI_VERSION_LINE,
  CLIENT_PROTOCOL_VERSION,
  INSTALL_CMD_PINNED,
} from "../src/lib/release.ts";

/*
 * release module gate — directly exercises site/src/lib/release.ts, the single shared
 * module that composes every /download version surface.
 *
 * WHY IT IMPORTS THE MODULE. The download-version gate proves the BUILT page; this gate
 * proves the MODULE. Loading release.ts under the site test's own runner (`node --import
 * tsx`) exercises the real code path — the JSON import attribute, the src/cloud/config.ts
 * import (which pulls node:crypto — fine under Node, and exactly why install.ts must never
 * import release.ts for the browser), and the module-scope validators. The expected values
 * on the other side are derived INDEPENDENTLY: the test reads package.json and config.ts
 * with fs and composes the expected line/command by hand, so a regression that made
 * release.ts and this test agree with each other but not with reality could not occur
 * without this test's own derivations also being wrong.
 *
 * Picked up by `npm --prefix site test` through the `scripts/*.test.mjs` glob.
 */

const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(siteDir, "..");

/** Independent: the version string off the repo-root manifest. */
function expectedCliVersion() {
  const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
  assert.equal(typeof pkg?.version, "string");
  assert.ok(pkg.version.length > 0);
  return pkg.version;
}

/** Independent: the protocol string off its one source. */
function expectedProtocolVersion() {
  const source = readFileSync(join(repoDir, "src/cloud/config.ts"), "utf8");
  const match = source.match(/CLIENT_PROTOCOL_VERSION\s*=\s*"([^"]+)"/);
  assert.ok(match, "CLIENT_PROTOCOL_VERSION must be readable from src/cloud/config.ts");
  return match[1];
}

/** Independent: the install host off its browser-safe constant. */
function expectedInstallHost() {
  const source = readFileSync(join(siteDir, "src/lib/install.ts"), "utf8");
  const match = source.match(/INSTALL_HOST\s*=\s*"([^"]+)"/);
  assert.ok(match, "INSTALL_HOST must be readable from site/src/lib/install.ts");
  return match[1];
}

test("release module: CLI_VERSION and CLIENT_PROTOCOL_VERSION match their one sources", () => {
  assert.equal(CLI_VERSION, expectedCliVersion());
  assert.equal(CLIENT_PROTOCOL_VERSION, expectedProtocolVersion());
  assert.equal(typeof CLIENT_PROTOCOL_VERSION, "string");
  assert.ok(CLIENT_PROTOCOL_VERSION.length > 0);
});

test("release module: CLI_VERSION_LINE is composed in the binary's exact shape", () => {
  const expected = `cswarm ${expectedCliVersion()} (protocol ${expectedProtocolVersion()})`;
  assert.equal(CLI_VERSION_LINE, expected);
});

test("release module: INSTALL_CMD_PINNED keeps the exact pipe semantics and shipping version", () => {
  const expected =
    `curl -fsSL https://${expectedInstallHost()}/install.sh | ` +
    `CSWARM_VERSION=${expectedCliVersion()} sh`;
  assert.equal(INSTALL_CMD_PINNED, expected);
});
