/**
 * Pure process-boundary coverage for claude-agent-acp 0.64.2.
 *
 * ★ THIS FILE IS NAMED IN `npm test`; it uses fake bridge executables and no
 * network, Claude session, or billable model prompt.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  CLAUDE_ACP_MEASURED_VERSION,
  AcpVersionError,
  assertClaudeMeasuredVersion,
  buildClaudeAcpArgs,
  buildClaudeChildEnv,
  buildClaudeLaunch,
  openClaudeAcpSession,
  parseClaudeVersionOutput,
  resolveClaudeExecutable,
  terminateClaudeChild,
} from "../src/host/index.js";

async function writeFakeClaudeBridge(
  root: string,
  protocolVersion = 1,
): Promise<{ target: string; shim: string; log: string }> {
  const target = join(root, `fake-claude-agent-acp-${protocolVersion}.cjs`);
  const shim = join(root, "claude-agent-acp");
  const log = join(root, `bridge-${protocolVersion}.ndjson`);
  await writeFile(
    target,
    `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `const log = ${JSON.stringify(log)};\n` +
      `fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME ?? null, swarm: process.env.SWARM_AGENT_TOKEN ?? null, pid: process.pid }) + "\\n");\n` +
      `if (process.argv[2] === "--version") { process.stdout.write("0.64.2\\n"); process.exit(0); }\n` +
      `let buffer = "";\n` +
      `process.stdin.setEncoding("utf8");\n` +
      `process.stdin.on("data", (chunk) => {\n` +
      `  buffer += chunk;\n` +
      `  let newline;\n` +
      `  while ((newline = buffer.indexOf("\\n")) !== -1) {\n` +
      `    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);\n` +
      `    if (!line.trim()) continue;\n` +
      `    const message = JSON.parse(line);\n` +
      `    let result;\n` +
      `    if (message.method === "initialize") result = { protocolVersion: ${protocolVersion}, agentCapabilities: {}, authMethods: [], _meta: { agentVersion: "0.64.2" } };\n` +
      `    else if (message.method === "session/new") result = { sessionId: "claude-test-session" };\n` +
      `    else if (message.method === "session/prompt") result = { stopReason: "end_turn" };\n` +
      `    else continue;\n` +
      `    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");\n` +
      `  }\n` +
      `});\n` +
      `process.on("SIGTERM", () => process.exit(0));\n`,
    { mode: 0o700 },
  );
  await chmod(target, 0o700);
  await symlink(target, shim);
  return { target, shim, log };
}

test("Claude bridge args enter ACP mode without flags", () => {
  assert.deepEqual(buildClaudeAcpArgs(), []);
});

test("Claude bridge version parser accepts only the measured bare semver shape", () => {
  assert.equal(parseClaudeVersionOutput("0.64.2\n"), "0.64.2");
  assert.equal(parseClaudeVersionOutput("claude-agent-acp 0.64.2\n"), null);
  assert.equal(parseClaudeVersionOutput("no version"), null);
});

test("Claude child env preserves HOME but strips inherited Claude and credential state", () => {
  const env = buildClaudeChildEnv({
    PATH: "/usr/bin",
    HOME: "/Users/test",
    USER: "test",
    LANG: "en_US.UTF-8",
    CLAUDE_CODE_ENTRYPOINT: "claude",
    CLAUDE_CODE_SESSION_ID: "session",
    ANTHROPIC_API_KEY: "secret",
    SWARM_AGENT_TOKEN: "secret",
    NODE_OPTIONS: "--require /tmp/hook.js",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/Users/test",
    USER: "test",
    LANG: "en_US.UTF-8",
  });
  assert.equal(JSON.stringify(env).includes("secret"), false);
});

test("Claude executable PATH walk resolves an npm-style shim to one real path", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-resolve-"));
  const target = join(root, "bridge-target");
  const shim = join(root, "claude-agent-acp");
  try {
    await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(target, 0o700);
    await symlink(target, shim);
    assert.equal(
      resolveClaudeExecutable("claude-agent-acp", root),
      realpathSync(target),
    );
    assert.equal(resolveClaudeExecutable(shim, "/unused"), realpathSync(target));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows npm shim resolves to one Node-launched package entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-win-shim-"));
  const targetDir = join(
    root,
    "node_modules",
    "@agentclientprotocol",
    "claude-agent-acp",
    "dist",
  );
  const target = join(targetDir, "index.js");
  const shim = join(root, "claude-agent-acp.cmd");
  try {
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      target,
      `if (process.argv[2] === "--version") process.stdout.write("0.64.2\\n");\n`,
    );
    await writeFile(
      shim,
      `@ECHO off\r\n"%dp0%\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js" %*\r\n`,
      { mode: 0o700 },
    );
    await chmod(shim, 0o700);
    const resolved = resolveClaudeExecutable(shim, "/unused", "win32");
    assert.equal(resolved, realpathSync(target));
    assert.deepEqual(buildClaudeLaunch(resolved, [], "win32"), {
      command: process.execPath,
      args: [resolved],
    });
    assert.equal(
      await assertClaudeMeasuredVersion(resolved, { platform: "win32" }),
      CLAUDE_ACP_MEASURED_VERSION,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude version probe uses the supplied spawn environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-version-"));
  const executable = join(root, "fake-claude-agent-acp.mjs");
  const measuredHome = join(root, "operator-home");
  try {
    await writeFile(
      executable,
      `#!${process.execPath}\n` +
        `process.stdout.write(process.env.HOME === ${JSON.stringify(measuredHome)} ? "0.64.2\\n" : "0.0.0\\n");\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const env = buildClaudeChildEnv({
      PATH: process.env.PATH,
      HOME: measuredHome,
      SWARM_AGENT_TOKEN: "must-not-reach-probe",
    });
    assert.equal(
      await assertClaudeMeasuredVersion(executable, { env }),
      CLAUDE_ACP_MEASURED_VERSION,
    );
    await assert.rejects(
      () => assertClaudeMeasuredVersion(executable, { env: { ...env, HOME: "/wrong" } }),
      (error: unknown) => error instanceof AcpVersionError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude teardown escalates from ignored SIGTERM to SIGKILL and confirms exit", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await once(child.stdout, "data");
  await terminateClaudeChild(child);
  assert.equal(child.signalCode, "SIGKILL");
});

test("openClaudeAcpSession probes and spawns one realpath with one sanitized env", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-open-"));
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-cwd-"));
  try {
    const fake = await writeFakeClaudeBridge(root);
    const handle = await openClaudeAcpSession({
      cwd,
      executable: fake.shim,
      env: {
        PATH: root,
        HOME: join(root, "operator-home"),
        SWARM_AGENT_TOKEN: "must-not-reach-child",
      },
      requestTimeoutMs: 2_000,
    });
    assert.equal(handle.executable, realpathSync(fake.target));
    assert.deepEqual(handle.args, []);
    assert.equal(handle.env.HOME, join(root, "operator-home"));
    assert.equal(handle.env.SWARM_AGENT_TOKEN, undefined);
    const rows = (await readFile(fake.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        args: string[];
        home: string | null;
        swarm: string | null;
      });
    assert.deepEqual(rows.map((row) => row.args), [["--version"], []]);
    assert.deepEqual(rows.map((row) => row.home), [
      join(root, "operator-home"),
      join(root, "operator-home"),
    ]);
    assert.deepEqual(rows.map((row) => row.swarm), [null, null]);
    await handle.close();
    assert.ok(handle.child.exitCode !== null || handle.child.signalCode !== null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("openClaudeAcpSession confirms child exit after initialization failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-open-fail-"));
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-cwd-"));
  try {
    const fake = await writeFakeClaudeBridge(root, 99);
    await assert.rejects(
      () =>
        openClaudeAcpSession({
          cwd,
          executable: fake.shim,
          env: { PATH: root, HOME: join(root, "operator-home") },
          requestTimeoutMs: 2_000,
        }),
      /protocolVersion/i,
    );
    const rows = (await readFile(fake.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; pid: number });
    const childRow = rows.find((row) => row.args.length === 0);
    assert.ok(childRow);
    assert.throws(
      () => process.kill(childRow.pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("openClaudeAcpSession converts a post-probe spawn race to spawn_failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-spawn-race-"));
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-cwd-"));
  const target = join(root, "vanishing-claude-agent-acp.cjs");
  try {
    await writeFile(
      target,
      `#!${process.execPath}\n` +
        `require("node:fs").unlinkSync(__filename);\n` +
        `process.stdout.write("0.64.2\\n");\n`,
      { mode: 0o700 },
    );
    await chmod(target, 0o700);
    await assert.rejects(
      () =>
        openClaudeAcpSession({
          cwd,
          executable: target,
          env: { PATH: root, HOME: join(root, "operator-home") },
          requestTimeoutMs: 2_000,
        }),
      /spawn_failed|failed to spawn/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("aborting Claude initialization terminates the spawned bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-abort-open-"));
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-cwd-"));
  const target = join(root, "hanging-claude-agent-acp.cjs");
  const log = join(root, "hanging-pid.txt");
  try {
    await writeFile(
      target,
      `#!${process.execPath}\n` +
        `const fs = require("node:fs");\n` +
        `if (process.argv[2] === "--version") { process.stdout.write("0.64.2\\n"); process.exit(0); }\n` +
        `fs.writeFileSync(${JSON.stringify(log)}, String(process.pid));\n` +
        `process.on("SIGTERM", () => process.exit(0));\n` +
        `setInterval(() => {}, 1000);\n`,
      { mode: 0o700 },
    );
    await chmod(target, 0o700);
    const controller = new AbortController();
    const opening = openClaudeAcpSession({
      cwd,
      executable: target,
      env: { PATH: root, HOME: join(root, "operator-home") },
      requestTimeoutMs: 120_000,
      signal: controller.signal,
    });
    let childPid = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        childPid = Number(await readFile(log, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(childPid > 0);
    controller.abort();
    await assert.rejects(opening, /cancelled/i);
    assert.throws(
      () => process.kill(childPid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("missing Claude bridge reports executable_missing", () => {
  assert.throws(
    () => resolveClaudeExecutable("no-such-claude-agent-acp-zzzz", "/usr/bin"),
    /executable_missing|not found on PATH/i,
  );
});

test("source contains no isolated-home or temporary-cwd lifecycle", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(resolve("src/host/claude.ts"), "utf8")
  );
  assert.doesNotMatch(source, /isolatedHome|mkdtemp|sweepStale|canaryCwd/);
});
