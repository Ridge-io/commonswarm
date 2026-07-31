import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * download version gate — the release version surfaces on the BUILT /download page.
 *
 * REPLACES THE OLD F-1 SHAPE. F-1 (docs/evidence/2026-07-31-handoff/EXECUTION-ORDERS.md
 * §2.5) matched the built page for `0.1.4` present and `CSWARM_VERSION=0.1.3` absent —
 * two hard-coded literals that rotted the moment the next bump landed. This gate DERIVES
 * the expected version from the shipping source (repo-root package.json) and the protocol
 * from its one source (src/cloud/config.ts), then requires the built artifact to carry
 * EXACTLY those values — and nothing else — on both /download version surfaces:
 *
 *   • the pinned install command  (OtherWays.astro <- lib/install.ts INSTALL_CMD_PINNED,
 *                                   which takes its version from lib/release.ts)
 *   • the `cswarm --version` example (AfterInstall.astro <- lib/release.ts CLI_VERSION_LINE)
 *
 * A bump touches repo-root package.json alone; a build that still renders the old version
 * fails this gate, and the mutation test below proves the gate can tell a stale artifact
 * apart from the clean one rather than passing vacuously.
 *
 * Picked up by `npm --prefix site test` through the site test script's
 * `scripts/*.test.mjs` glob. Requires a prior site build — it reads `site/dist`.
 */

const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(siteDir, "..");
const DIST_DOWNLOAD = join(siteDir, "dist", "download", "index.html");

/** The shipping CLI version, from the one place it ships from. */
function shippingCliVersion() {
  const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
  if (typeof pkg?.version !== "string" || !pkg.version) {
    throw new Error(
      "download gate: repo-root package.json has no readable `version` — the gate must not guess.",
    );
  }
  return pkg.version;
}

/** The protocol version, read from the protocol's own source exactly as the site does. */
function protocolVersion() {
  const source = readFileSync(join(repoDir, "src/cloud/config.ts"), "utf8");
  const match = source.match(/CLIENT_PROTOCOL_VERSION\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error(
      "download gate: could not read CLIENT_PROTOCOL_VERSION from src/cloud/config.ts",
    );
  }
  return match[1];
}

const CLI_VERSION = shippingCliVersion();
const PROTOCOL_VERSION = protocolVersion();
const EXPECTED_LINE = `${CLI_VERSION} (protocol ${PROTOCOL_VERSION})`;

/** The two /download version surfaces, extracted from built HTML as DISTINCT values.
 *  The page renders the same line twice (footer + AfterInstall example), so a set, not a
 *  count, is the shape of the truth. */
function versionSurfaces(html) {
  return {
    pins: new Set(
      [...html.matchAll(/CSWARM_VERSION=([0-9]+(?:\.[0-9]+)*) sh/g)].map((m) => m[1]),
    ),
    lines: new Set(
      [...html.matchAll(/cswarm ([0-9]+(?:\.[0-9]+)*) \(protocol ([0-9]+(?:\.[0-9]+)*)\)/g)].map(
        (m) => `${m[1]} (protocol ${m[2]})`,
      ),
    ),
  };
}

/** The gate. True only when the artifact carries exactly the shipping version surfaces. */
function downloadCarriesShippedVersion(html) {
  const { pins, lines } = versionSurfaces(html);
  return (
    pins.size === 1 && pins.has(CLI_VERSION) && lines.size === 1 && lines.has(EXPECTED_LINE)
  );
}

test("download version gate: clean built /download carries exactly the shipping version", () => {
  const html = readFileSync(DIST_DOWNLOAD, "utf8");
  const { pins, lines } = versionSurfaces(html);
  assert.equal(
    pins.size,
    1,
    `pinned install command must render one version, found ${[...pins].join(", ")}`,
  );
  assert.ok(
    pins.has(CLI_VERSION),
    `pinned install command must render the shipped version ${CLI_VERSION}, found ${[...pins].join(", ")}`,
  );
  assert.equal(
    lines.size,
    1,
    `cswarm --version example must render one version line, found ${[...lines].join(", ")}`,
  );
  assert.ok(
    lines.has(EXPECTED_LINE),
    `cswarm --version example must render ${EXPECTED_LINE}, found ${[...lines].join(", ")}`,
  );
});

test("download version gate: a deliberately mutated artifact is rejected", () => {
  const html = readFileSync(DIST_DOWNLOAD, "utf8");
  assert.equal(
    downloadCarriesShippedVersion(html),
    true,
    "the clean artifact must pass before the mutation is meaningful",
  );
  const other = CLI_VERSION === "9.9.9" ? "9.9.8" : "9.9.9";
  const mutated = html.replaceAll(CLI_VERSION, other);
  assert.equal(
    downloadCarriesShippedVersion(mutated),
    false,
    `the gate must reject an artifact that renders ${other} while package.json ships ${CLI_VERSION}`,
  );
});