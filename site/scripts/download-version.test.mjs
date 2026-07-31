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
 * EXACTLY those values on FOUR independently-scoped surfaces, each in its own stable
 * output context:
 *
 *   1. the AfterInstall `cswarm --version` example in its output block
 *      (AfterInstall.astro <- lib/release.ts CLI_VERSION_LINE, rendered as a code line);
 *   2. the footer shipping-version line in the footer's version span
 *      (SiteFooter.astro <- lib/release.ts CLI_VERSION_LINE);
 *   3. the visible pinned install command in the "pin a version" code block
 *      (OtherWays.astro <- lib/release.ts INSTALL_CMD_PINNED, rendered as the line text);
 *   4. the pinned command's `data-copy` payload on the copy button
 *      (CodeBlock.astro's data-copy attribute, same INSTALL_CMD_PINNED value).
 *
 * FOUR SURFACES, NOT TWO. The old gate reduced everything to a value set, so removing the
 * AfterInstall output line "passed" because the footer carries the same string, and removing
 * the copy payload "passed" because the visible pin still shows it. Each surface here has
 * its own scoped count, and a deletion mutation that removes exactly one of them while the
 * other three stay intact must turn the predicate red — one test per surface below.
 *
 * "A bump touches package.json alone" is FALSE and the superseded phrasing is gone: a real
 * npm release bumps the root manifest AND its lockfile (see release-lockfile.test.mjs).
 * Here the site renders what the repo-root package.json ships; the lockfile, not this test,
 * is what keeps the two in step.
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
const VERSION_LINE = `cswarm ${CLI_VERSION} (protocol ${PROTOCOL_VERSION})`;
const PINNED_CMD =
  `curl -fsSL https://commonswarm.com/install.sh | CSWARM_VERSION=${CLI_VERSION} sh`;

function countLiteral(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function countRegex(haystack, re) {
  return (haystack.match(re) ?? []).length;
}

const FOOTER_SPAN_RE = new RegExp(
  `<span class="mono ft__version-str"[^>]*>cswarm ${escapeRegex(CLI_VERSION)} \\(protocol ${escapeRegex(PROTOCOL_VERSION)}\\)</span>`,
);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The four /download version surfaces as INDEPENDENT scoped counts over the built HTML. */
function surfaceCounts(html) {
  return {
    /** 1: AfterInstall `cswarm --version` example, in its code-line output span. */
    afterInstallOutputLine: countLiteral(html, `<span class="ui-code__line">${VERSION_LINE}</span>`),
    /** 2: footer shipping-version line, in the footer's version span. */
    footerShippingVersionLine: countRegex(html, FOOTER_SPAN_RE),
    /** 3: visible pinned install command, as the pin code block's line text. */
    visiblePinnedCommand: countLiteral(
      html,
      `<span class="ui-code__prompt" aria-hidden="true">$ </span>${PINNED_CMD}</span>`,
    ),
    /** 4: pinned command's data-copy payload on the copy button. */
    pinnedCopyPayload: countLiteral(html, `data-copy="${PINNED_CMD}"`),
  };
}

/**
 * The gate. True only when all four surfaces are present exactly once — a page that renders
 * the version from any other source (or drops any one surface) fails.
 */
function downloadCarriesShippedVersion(html) {
  return Object.values(surfaceCounts(html)).every((count) => count === 1);
}

const SURFACE_KEYS = Object.keys(surfaceCounts(""));

test("download version gate: clean built /download carries all four shipping-version surfaces", () => {
  const html = readFileSync(DIST_DOWNLOAD, "utf8");
  const counts = surfaceCounts(html);
  for (const key of SURFACE_KEYS) {
    assert.equal(
      counts[key],
      1,
      `${key} must appear exactly once on the clean built /download, found ${counts[key]}`,
    );
  }
  assert.equal(
    downloadCarriesShippedVersion(html),
    true,
    "the clean artifact must satisfy the four-surface predicate",
  );
});

test("download version gate: a deliberately mutated stale artifact is rejected", () => {
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

/*
 * DELETION MUTATION CONTROLS — one per surface. Removing exactly one surface (while the
 * other three stay byte-intact) must flip the predicate from green to red. Each control
 * proves BOTH directions: the targeted surface count drops to 0 while the other three sit
 * at 1 (so the mutation removed precisely what it claims), and the predicate turns red.
 */

function assertTargetedDeletion(html, missingKey) {
  const counts = surfaceCounts(html);
  for (const key of SURFACE_KEYS) {
    const expected = key === missingKey ? 0 : 1;
    assert.equal(
      counts[key],
      expected,
      `${key}: expected ${expected} after deleting only ${missingKey}, found ${counts[key]}`,
    );
  }
  assert.equal(
    downloadCarriesShippedVersion(html),
    false,
    `the predicate must turn red when only ${missingKey} is deleted`,
  );
}

test("deletion control: removing only the AfterInstall output line turns the gate red", () => {
  const html = readFileSync(DIST_DOWNLOAD, "utf8");
  const mutated = html.replace(
    `<span class="ui-code__line">${VERSION_LINE}</span>`,
    `<span class="ui-code__line"></span>`,
  );
  assert.notEqual(mutated, html, "the mutation must change the artifact");
  assertTargetedDeletion(mutated, "afterInstallOutputLine");
});

test("deletion control: removing only the footer shipping-version line turns the gate red", () => {
  const html = readFileSync(DIST_DOWNLOAD, "utf8");
  const mutated = html.replace(FOOTER_SPAN_RE, `<span class="mono ft__version-str"></span>`);
  assert.notEqual(mutated, html, "the mutation must change the artifact");
  assertTargetedDeletion(mutated, "footerShippingVersionLine");
});

test("deletion control: removing only the visible pinned command turns the gate red", () => {
  const html = readFileSync(DIST_DOWNLOAD, "utf8");
  const mutated = html.replace(
    `<span class="ui-code__prompt" aria-hidden="true">$ </span>${PINNED_CMD}</span>`,
    `<span class="ui-code__prompt" aria-hidden="true">$ </span></span>`,
  );
  assert.notEqual(mutated, html, "the mutation must change the artifact");
  assertTargetedDeletion(mutated, "visiblePinnedCommand");
});

test("deletion control: removing only the pinned command's data-copy payload turns the gate red", () => {
  const html = readFileSync(DIST_DOWNLOAD, "utf8");
  const mutated = html.replace(`data-copy="${PINNED_CMD}"`, `data-copy=""`);
  assert.notEqual(mutated, html, "the mutation must change the artifact");
  assertTargetedDeletion(mutated, "pinnedCopyPayload");
});
