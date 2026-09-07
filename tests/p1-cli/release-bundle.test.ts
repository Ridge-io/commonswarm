/**
 * The source suites never load the shipped CJS bundle. 0.1.62 crashed at
 * createRequire(import.meta.url) while every tsx gate stayed green.
 *
 * Reached by `npm test` (named in the literal list) and by `npm run test:p1-cli` (glob).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const buildRelease = join(repoRoot, "scripts", "build-release.sh");
const bundlePath = join(repoRoot, "dist-release", "cswarm");
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_BRIDGE = "missing-claude-agent-acp";

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  ) as { version: unknown };
  assert.equal(typeof manifest.version, "string");
  assert.ok((manifest.version as string).length > 0);
  return manifest.version as string;
}

function runIsolated(
  bin: string,
  args: string[],
  options: { cwd: string; home: string; input?: string },
) {
  return spawnSync(bin, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: options.home,
    },
    input: options.input ?? "",
    timeout: 20_000,
  });
}

test("the shipped CJS artifact starts and can load a host module", { timeout: 120_000 }, async () => {
  const version = await packageVersion();
  const build = spawnSync("bash", [buildRelease], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(
    build.status,
    0,
    `scripts/build-release.sh exit ${build.status}\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const isolated = await mkdtemp(join(tmpdir(), "cswarm-bundle-"));
  const home = await mkdtemp(join(tmpdir(), "cswarm-bundle-home-"));
  const bin = join(isolated, "cswarm");
  const missing = join(isolated, MISSING_BRIDGE);
  try {
    await copyFile(bundlePath, bin);
    await chmod(bin, 0o755);

    const versionRun = runIsolated(bin, ["--version"], { cwd: isolated, home });
    assert.equal(versionRun.status, 0, versionRun.stderr + versionRun.stdout);
    assert.match(versionRun.stdout, new RegExp(`^cswarm ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`));
    assert.doesNotMatch(
      `${versionRun.stdout}${versionRun.stderr}`,
      /ERR_INVALID_ARG_VALUE|import\.meta/,
    );

    const helpRun = runIsolated(bin, ["--help"], { cwd: isolated, home });
    assert.equal(helpRun.status, 0, helpRun.stderr + helpRun.stdout);
    assert.match(helpRun.stdout, /^cswarm /);
    assert.match(helpRun.stdout, /^Usage:/m);
    assert.match(helpRun.stdout, /cswarm listen start/);

    const credential = JSON.stringify({
      message: AGENT_CREDENTIAL_MESSAGE_D088,
      status: "accepted",
      principal_id: PRINCIPAL_ID,
      token_id: "33333333-3333-4333-8333-333333333333",
      run_id: "44444444-4444-4444-8444-444444444444",
      agent_token: `swm_agt_${"A".repeat(43)}`,
      expires_at: "2030-01-01T00:00:00.000Z",
    });
    const loaderRun = runIsolated(
      bin,
      [
        "listen",
        "start",
        "--url",
        "http://127.0.0.1:9",
        "--anon-key",
        "synthetic-anon-key",
        "--workspace-id",
        WORKSPACE_ID,
        "--provider",
        "claude",
        "--cwd",
        isolated,
        "--state-dir",
        join(isolated, "state"),
        "--allow-unattended",
        "--agent-token-stdin",
        "--claude-executable",
        missing,
      ],
      { cwd: isolated, home, input: credential },
    );
    const loaderOut = `${loaderRun.stdout}${loaderRun.stderr}`;
    assert.notEqual(loaderRun.status, 0, loaderOut);
    assert.match(loaderOut, /could not use --claude-executable/);
    assert.match(loaderOut, /not executable/);
    assert.doesNotMatch(
      loaderOut,
      /ERR_INVALID_ARG_VALUE|Cannot find module|ERR_MODULE_NOT_FOUND/,
    );
  } finally {
    await rm(isolated, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
