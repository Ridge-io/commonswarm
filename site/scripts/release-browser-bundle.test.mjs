import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * browser bundle guard — no root-only release metadata may leak into emitted browser JS.
 *
 * WHY IT EXISTS. When `lib/install.ts` imported `lib/release.ts`, the AgentConnect browser
 * bundle pulled in the repo-root package.json and src/cloud/config.ts (which imports
 * node:crypto). A clean build warned that node:crypto was externalized for browser
 * compatibility, and the emitted JS contained root-only strings that only belong in the
 * release toolchain — the npm script names `build:command-core` and `test:p1-server`,
 * plus `node:crypto` itself, the leaked import that named the warning. `install.ts` is
 * browser-safe again (release.ts imports install.ts, never the reverse), and this scan
 * pins the absence into the gate.
 *
 * POSITIVE CONTROL. Absence assertions pass vacuously if the glob is wrong or the scan is
 * empty, so the same scan must also find an ordinary, known browser-bundle string in at
 * least one emitted file. `navigator.clipboard` is emitted by CodeBlock.astro's copy
 * script on /download; finding it proves the scanner actually reads the emitted JS.
 *
 * Picked up by `npm --prefix site test` through the `scripts/*.test.mjs` glob. Requires a
 * prior site build — it reads `site/dist/_astro`.
 */

const SENTINELS = ["build:command-core", "test:p1-server", "node:crypto"];
const KNOWN_BROWSER_STRING = "navigator.clipboard";

const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const astroDir = join(siteDir, "dist", "_astro");

/** Every emitted JS file under dist/_astro continued is read here. */
function emittedBrowserJsFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (path.endsWith(".js")) {
        files.push(path);
      }
    }
  };
  walk(astroDir);
  return files;
}

test("browser bundle guard: no emitted browser JS contains root-only release metadata", () => {
  const files = emittedBrowserJsFiles();
  assert.ok(
    files.length > 0,
    `emitted browser JS must exist under ${astroDir} for the scan to mean anything`,
  );

  let knownStringFound = false;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const sentinel of SENTINELS) {
      assert.equal(
        source.includes(sentinel),
        false,
        `${sentinel} leaked into the browser bundle ${file}`,
      );
    }
    if (source.includes(KNOWN_BROWSER_STRING)) knownStringFound = true;
  }

  assert.equal(
    knownStringFound,
    true,
    `positive control: the scanner must find an ordinary browser-bundle string ` +
      `(${KNOWN_BROWSER_STRING}) across ${files.length} emitted file(s), or the absence ` +
      `assertions above would be vacuous`,
  );
});
