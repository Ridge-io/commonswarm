/**
 * Pure process-boundary coverage for codex-acp 1.1.9.
 *
 * ★ THIS FILE IS NAMED IN `npm test`; it uses fake bridge executables and no
 * network, Codex session, or billable model prompt.
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
  CODEX_ACP_MEASURED_VERSION,
  AcpVersionError,
  assertCodexMeasuredVersion,
  buildCodexAcpArgs,
  buildCodexChildEnv,
  buildCodexLaunch,
  openCodexAcpSession,
  parseCodexVersionOutput,
  resolveCodexExecutable,
  terminateCodexChild,
} from "../src/host/index.js";

async function writeFakeCodexBridge(
  root: string,
  protocolVersion = 1,
): Promise<{ target: string; shim: string; log: string }> {
  const target = join(root, `fake-codex-acp-${protocolVersion}.cjs`);
  const shim = join(root, "codex-acp");
  const log = join(root, `bridge-${protocolVersion}.ndjson`);
  await writeFile(
    target,
    `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `const log = ${JSON.stringify(log)};\n` +
      `fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME ?? null, swarm: process.env.SWARM_AGENT_TOKEN ?? null, pid: process.pid }) + "\\n");\n` +
      `if (process.argv[2] === "--version") { process.stdout.write("@agentclientprotocol/codex-acp 1.1.9\\n"); process.exit(0); }\n` +
      `let buffer = "";\n` +
      `process.stdin.setEncoding("utf8");\n` +
      `process.stdin.on("data", (chunk) => {\n` +
      `  buffer += chunk;\n` +
      `  let newline;\n` +
      `  while ((newline = buffer.indexOf("\\n")) !== -1) {\n` +
      `    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);\n` +
      `    if (!line.trim()) continue;\n` +
      `    const message = JSON.parse(line);\n` +
      `    fs.appendFileSync(log, JSON.stringify({ method: message.method, params: message.params }) + "\\n");\n` +
      `    let result;\n` +
      `    if (message.method === "initialize") result = { protocolVersion: ${protocolVersion}, agentCapabilities: {}, authMethods: [], _meta: { agentVersion: "1.1.9" } };\n` +
      `    else if (message.method === "session/new") result = { sessionId: "codex-test-session", modes: { currentModeId: "agent", availableModes: [{ id: "agent" }, { id: "read-only" }] } };\n` +
      `    else if (message.method === "session/load") result = { sessionId: message.params.sessionId };\n` +
      `    else if (message.method === "session/set_mode") result = {};\n` +
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

test("Codex bridge args enter ACP mode without flags", () => {
  assert.deepEqual(buildCodexAcpArgs(), []);
});

test("Codex bridge version parser accepts only the measured package shape", () => {
  assert.equal(
    parseCodexVersionOutput("@agentclientprotocol/codex-acp 1.1.9\n"),
    "1.1.9",
  );
  assert.equal(parseCodexVersionOutput("1.1.9\n"), null);
  assert.equal(parseCodexVersionOutput("no version"), null);
});

test("Codex child env preserves HOME but strips inherited Codex and credential state", () => {
  const env = buildCodexChildEnv({
    PATH: "/usr/bin",
    HOME: "/Users/test",
    USER: "test",
    LANG: "en_US.UTF-8",
    CODEX_THREAD_ID: "codex",
    CODEX_MANAGED_BY_NPM: "session",
    OPENAI_API_KEY: "secret",
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

test("Codex executable PATH walk resolves an npm-style shim to one real path", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-resolve-"));
  const target = join(root, "bridge-target");
  const shim = join(root, "codex-acp");
  try {
    await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(target, 0o700);
    await symlink(target, shim);
    assert.equal(
      resolveCodexExecutable("codex-acp", root),
      realpathSync(target),
    );
    assert.equal(resolveCodexExecutable(shim, "/unused"), realpathSync(target));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows npm shim resolves to one Node-launched package entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-win-shim-"));
  const targetDir = join(
    root,
    "node_modules",
    "@agentclientprotocol",
    "codex-acp",
    "dist",
  );
  const target = join(targetDir, "index.js");
  const shim = join(root, "codex-acp.cmd");
  try {
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      target,
      `if (process.argv[2] === "--version") process.stdout.write("@agentclientprotocol/codex-acp 1.1.9\\n");\n`,
    );
    await writeFile(
      shim,
      `@ECHO off\r\n"%dp0%\\node_modules\\@agentclientprotocol\\codex-acp\\dist\\index.js" %*\r\n`,
      { mode: 0o700 },
    );
    await chmod(shim, 0o700);
    const resolved = resolveCodexExecutable(shim, "/unused", "win32");
    assert.equal(resolved, realpathSync(target));
    assert.deepEqual(buildCodexLaunch(resolved, [], "win32"), {
      command: process.execPath,
      args: [resolved],
    });
    assert.equal(
      await assertCodexMeasuredVersion(resolved, { platform: "win32" }),
      CODEX_ACP_MEASURED_VERSION,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex version probe uses the supplied spawn environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-version-"));
  const executable = join(root, "fake-codex-acp.mjs");
  const measuredHome = join(root, "operator-home");
  try {
    await writeFile(
      executable,
      `#!${process.execPath}\n` +
        `process.stdout.write(process.env.HOME === ${JSON.stringify(measuredHome)} ? "@agentclientprotocol/codex-acp 1.1.9\\n" : "@agentclientprotocol/codex-acp 0.0.0\\n");\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const env = buildCodexChildEnv({
      PATH: process.env.PATH,
      HOME: measuredHome,
      SWARM_AGENT_TOKEN: "must-not-reach-probe",
    });
    assert.equal(
      await assertCodexMeasuredVersion(executable, { env }),
      CODEX_ACP_MEASURED_VERSION,
    );
    await assert.rejects(
      () => assertCodexMeasuredVersion(executable, { env: { ...env, HOME: "/wrong" } }),
      (error: unknown) => error instanceof AcpVersionError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex teardown escalates from ignored SIGTERM to SIGKILL and confirms exit", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await once(child.stdout, "data");
  await terminateCodexChild(child);
  assert.equal(child.signalCode, "SIGKILL");
});

test("openCodexAcpSession probes and spawns one realpath with one sanitized env", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-open-"));
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-cwd-"));
  try {
    const fake = await writeFakeCodexBridge(root);
    const handle = await openCodexAcpSession({
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
    assert.deepEqual(await handle.session.load("codex-restored-session"), {
      sessionId: "codex-restored-session",
      loaded: true,
    });
    const rows = (await readFile(fake.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        args?: string[];
        home: string | null;
        swarm: string | null;
        method?: string;
        params?: unknown;
      });
    const processRows = rows.filter((row) => Array.isArray(row.args));
    assert.deepEqual(processRows.map((row) => row.args), [["--version"], []]);
    assert.deepEqual(processRows.map((row) => row.home), [
      join(root, "operator-home"),
      join(root, "operator-home"),
    ]);
    assert.deepEqual(processRows.map((row) => row.swarm), [null, null]);
    const modeFrames = rows.filter((row) => row.method === "session/set_mode");
    assert.deepEqual(modeFrames.map((row) => row.params), [
      { sessionId: "codex-test-session", modeId: "read-only" },
      { sessionId: "codex-restored-session", modeId: "read-only" },
    ]);
    await handle.close();
    assert.ok(handle.child.exitCode !== null || handle.child.signalCode !== null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("openCodexAcpSession confirms child exit after initialization failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-open-fail-"));
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-cwd-"));
  try {
    const fake = await writeFakeCodexBridge(root, 99);
    await assert.rejects(
      () =>
        openCodexAcpSession({
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
      .map((line) => JSON.parse(line) as { args?: string[]; pid?: number });
    const childRow = rows.find((row) => row.args?.length === 0);
    assert.ok(childRow);
    assert.equal(typeof childRow.pid, "number");
    assert.throws(
      () => process.kill(childRow.pid!, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("openCodexAcpSession converts a post-probe spawn race to spawn_failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-spawn-race-"));
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-cwd-"));
  const target = join(root, "vanishing-codex-acp.cjs");
  try {
    await writeFile(
      target,
      `#!${process.execPath}\n` +
        `require("node:fs").unlinkSync(__filename);\n` +
        `process.stdout.write("@agentclientprotocol/codex-acp 1.1.9\\n");\n`,
      { mode: 0o700 },
    );
    await chmod(target, 0o700);
    await assert.rejects(
      () =>
        openCodexAcpSession({
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

test("aborting Codex initialization terminates the spawned bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-abort-open-"));
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-cwd-"));
  const target = join(root, "hanging-codex-acp.cjs");
  const log = join(root, "hanging-pid.txt");
  try {
    await writeFile(
      target,
      `#!${process.execPath}\n` +
        `const fs = require("node:fs");\n` +
        `if (process.argv[2] === "--version") { process.stdout.write("@agentclientprotocol/codex-acp 1.1.9\\n"); process.exit(0); }\n` +
        `fs.writeFileSync(${JSON.stringify(log)}, String(process.pid));\n` +
        `process.on("SIGTERM", () => process.exit(0));\n` +
        `setInterval(() => {}, 1000);\n`,
      { mode: 0o700 },
    );
    await chmod(target, 0o700);
    const controller = new AbortController();
    const opening = openCodexAcpSession({
      cwd,
      executable: target,
      env: { PATH: root, HOME: join(root, "operator-home") },
      requestTimeoutMs: 120_000,
      signal: controller.signal,
    });
    let childPid = 0;
    for (let attempt = 0; attempt < 500; attempt += 1) {
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

test("missing Codex bridge reports executable_missing", () => {
  assert.throws(
    () => resolveCodexExecutable("no-such-codex-acp-zzzz", "/usr/bin"),
    /executable_missing|not found on PATH/i,
  );
});

test("source contains no isolated-home or temporary-cwd lifecycle", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(resolve("src/host/codex.ts"), "utf8")
  );
  assert.doesNotMatch(source, /isolatedHome|mkdtemp|sweepStale|canaryCwd/);
});
