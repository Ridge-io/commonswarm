#!/usr/bin/env node
/**
 * Refuse the CLI gate when the build output it spawns is missing.
 *
 * tests/p1-cli/unknown-flag-message.test.ts spawns dist/cli.js and waits for
 * that child to reach a local HTTP server. In a fresh worktree there is no
 * dist/, so the child dies at once, the request never arrives, and the run
 * hangs forever: node --test applies no default per-test timeout. The gate
 * gave no output and no exit code, which reads as a slow suite rather than a
 * missing build.
 *
 * Usage: node scripts/require-cli-build.mjs [repo-root]
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The build outputs the CLI gate spawns. Checked and reported from here. */
const REQUIRED_BUILD_OUTPUTS = ["dist/cli.js"];

/** The package script that produces them. */
const BUILD_SCRIPT = "build";

const root = process.argv[2] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");

function remedy() {
  /* Name a script that exists. A remedy naming a command the project does not
   * have sends the reader to a second dead end. */
  let scripts = {};
  try {
    scripts = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ).scripts ?? {};
  } catch {
    scripts = {};
  }
  return Object.hasOwn(scripts, BUILD_SCRIPT)
    ? `Next: npm run ${BUILD_SCRIPT}`
    : `Next: build the CLI. This checkout has no "${BUILD_SCRIPT}" script, so ${root}/package.json is not the one this gate expects.`;
}

/* Present AND non-empty. A zero-byte dist/cli.js is what an interrupted build
 * leaves, and it hangs the gate the same way a missing one does. This does not
 * make the gate un-hangable: a file that exists and crashes on start still
 * passes here, so the claim is only about a missing or empty build. */
function absent(output) {
  try {
    return statSync(resolve(root, output)).size === 0;
  } catch {
    return true;
  }
}

const missing = REQUIRED_BUILD_OUTPUTS.filter(absent);

if (missing.length > 0) {
  const count = missing.length === 1 ? "1 build output is" : `${missing.length} build outputs are`;
  process.stderr.write(
    [
      `Cannot run the CLI gate: ${count} missing.`,
      ...missing.map((output) => `  missing: ${output}`),
      "This gate spawns the built CLI. Without it a test waits for a request that never arrives, and the run hangs with no output and no exit code.",
      remedy(),
      "",
    ].join("\n"),
  );
  process.exit(1);
}
