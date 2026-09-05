/**
 * `npm run test:p1-cli` hung forever in a fresh worktree.
 *
 * tests/p1-cli/unknown-flag-message.test.ts spawns dist/cli.js and then awaits
 * a request from that child. Without a build the child dies immediately, the
 * request never arrives, and node --test applies no default per-test timeout,
 * so the gate produced no output and no exit code. Six tests reported failures
 * first, which made it read as a slow suite rather than a missing build.
 *
 * Reached by `npm run test:p1-cli` through tests/p1-cli/**\/*.test.ts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const guard = resolve(repoRoot, "scripts", "require-cli-build.mjs");

interface Run {
  status: number;
  stderr: string;
  stdout: string;
}

function runGuard(root: string): Run {
  const result = spawnSync(process.execPath, [guard, root], {
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

async function fakeRoot(
  options: {
    withDist: boolean;
    withBuildScript?: boolean;
    emptyDist?: boolean;
  },
): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "cswarm-build-guard-"));
  const scripts = options.withBuildScript === false
    ? { test: "node --test" }
    : { build: "tsc", test: "node --test" };
  await writeFile(
    resolve(root, "package.json"),
    JSON.stringify({ name: "fake", scripts }),
    "utf8",
  );
  if (options.withDist) {
    await mkdir(resolve(root, "dist"), { recursive: true });
    await writeFile(
      resolve(root, "dist", "cli.js"),
      options.emptyDist === true ? "" : "#!/usr/bin/env node\n",
      "utf8",
    );
  }
  return root;
}

test("a missing build stops the gate at once and names the output and the remedy", async () => {
  const root = await fakeRoot({ withDist: false });

  try {
    const started = Date.now();
    const run = runGuard(root);
    const elapsed = Date.now() - started;

    assert.equal(run.status, 1);
    assert.ok(elapsed < 1_000, `took ${elapsed}ms, which is not "fails fast"`);
    assert.match(run.stderr, /missing: dist\/cli\.js/);
    assert.match(run.stderr, /npm run build/);
    /* The reason matters as much as the remedy: without it the reader has no
     * way to connect a silent hang to an absent file. */
    assert.match(run.stderr, /hangs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a built checkout passes silently", async () => {
  /* CONTROL. A guard that always failed would satisfy the test above and would
   * make the gate unrunnable. */
  const root = await fakeRoot({ withDist: true });

  try {
    const run = runGuard(root);

    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
    assert.equal(run.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the remedy names a script this project actually has", async () => {
  /* AGENTS.md: a list inside a user-facing message must come from the thing it
   * describes. A remedy naming a command that does not exist sends the reader
   * to a second dead end, which has shipped four times in one release cycle. */
  const root = await fakeRoot({ withDist: false });

  try {
    const run = runGuard(root);
    const named = run.stderr.match(/npm run ([a-z][a-z0-9:-]*)/);
    assert.notEqual(named, null, run.stderr);

    const scripts = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ).scripts as Record<string, string>;
    assert.ok(
      Object.hasOwn(scripts, named![1]!),
      `remedy names "${named![1]}", which is not a script`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a checkout without the build script is told that, not sent to run it", async () => {
  const root = await fakeRoot({ withDist: false, withBuildScript: false });

  try {
    const run = runGuard(root);

    assert.equal(run.status, 1);
    assert.doesNotMatch(run.stderr, /npm run build/);
    assert.match(run.stderr, /no "build" script/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the CLI gate runs the guard before any test, and this repo satisfies it", async () => {
  /* The guard is worth nothing if the gate does not call it. */
  const packageJson = JSON.parse(
    await readFile(resolve(repoRoot, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  const command = packageJson.scripts?.["test:p1-cli"] ?? "";

  assert.ok(
    command.startsWith("node scripts/require-cli-build.mjs &&"),
    `test:p1-cli does not begin with the guard: ${command}`,
  );
  /* This suite is running, so the build it guards must be present. */
  assert.equal(runGuard(repoRoot).status, 0);
});

test("a zero-byte build output is treated as missing", async () => {
  /* What an interrupted build leaves behind. The file exists, so an
   * existence-only guard passes it and the gate hangs exactly as before. */
  const root = await fakeRoot({ withDist: true, emptyDist: true });

  try {
    const run = runGuard(root);

    assert.equal(run.status, 1);
    assert.match(run.stderr, /missing: dist\/cli\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a directory at the build output path is treated as missing", async () => {
  /* A directory reports a non-zero size, so a size-only check passes it and
   * the gate then hangs spawning something that is not a program. */
  const root = await fakeRoot({ withDist: false });

  try {
    await mkdir(resolve(root, "dist", "cli.js"), { recursive: true });
    const run = runGuard(root);

    assert.equal(run.status, 1);
    assert.match(run.stderr, /missing: dist\/cli\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
