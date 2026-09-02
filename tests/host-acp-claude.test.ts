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
import { registerStderrExitParityTests } from "./support/host-stderr-exit-parity.js";
import {
  CLAUDE_ACP_MIN_VERSION,
  AcpChildExitError,
  AcpHostError,
  AcpPermissionCanaryError,
  AcpVersionError,
  AcpVersionBelowFloorError,
  assertClaudeVersionFloor,
  buildClaudeAcpArgs,
  buildClaudeChildEnv,
  buildClaudeLaunch,
  openClaudeAcpSession,
  parseClaudeCodeVersionOutput,
  parseClaudeVersionOutput,
  resolvePackagedClaudeBridge,
  resolveClaudeExecutable,
  terminateClaudeChild,
} from "../src/host/index.js";

registerStderrExitParityTests({
  provider: "Claude",
  executableName: "claude-agent-acp.cjs",
  versionOutput: "0.64.2\n",
  open: ({ cwd, executable, onStderrTail }) =>
    openClaudeAcpSession({
      cwd,
      executable,
      env: { PATH: "/usr/bin", HOME: join(cwd, "operator-home") },
      requestTimeoutMs: 2_000,
      onStderrTail,
    }),
});

async function writeFakeClaudeBridge(
  root: string,
  protocolVersion = 1,
  promptError: { code: number; message: string; data?: unknown } | null = null,
): Promise<{ target: string; shim: string; log: string }> {
  const targetDir = join(
    root,
    "node_modules",
    "@agentclientprotocol",
    "claude-agent-acp",
    "dist",
  );
  const target = join(targetDir, "index.js");
  const shim = join(root, "claude-agent-acp");
  const log = join(root, `bridge-${protocolVersion}.ndjson`);
  await mkdir(targetDir, { recursive: true });
  await writeFile(
    target,
    `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `const { spawnSync } = require("node:child_process");\n` +
      `const log = ${JSON.stringify(log)};\n` +
      `const promptError = ${JSON.stringify(promptError)};\n` +
      `fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME ?? null, swarm: process.env.SWARM_AGENT_TOKEN ?? null, claudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE ?? null, pid: process.pid }) + "\\n");\n` +
      `if (process.argv[2] === "--version") { process.stdout.write("0.64.2\\n"); process.exit(0); }\n` +
      `if (process.env.CLAUDE_CODE_EXECUTABLE) spawnSync(process.env.CLAUDE_CODE_EXECUTABLE, ["--bridge-child"], { stdio: "ignore" });\n` +
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
      `    if (message.method === "session/prompt" && promptError) {\n` +
      `      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: promptError }) + "\\n");\n` +
      `      continue;\n` +
      `    }\n` +
      `    let result;\n` +
      `    if (message.method === "initialize") result = { protocolVersion: ${protocolVersion}, agentCapabilities: {}, authMethods: [], _meta: { agentVersion: "0.64.2" } };\n` +
      `    else if (message.method === "session/new") result = { sessionId: "claude-test-session", modes: { currentModeId: "auto", availableModes: [{ id: "auto" }, { id: "default" }] } };\n` +
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

test("Claude bridge args enter ACP mode without flags", () => {
  assert.deepEqual(buildClaudeAcpArgs(), []);
});

test("Claude bridge version parser accepts bare and named SemVer shapes", () => {
  assert.equal(parseClaudeVersionOutput("0.64.2\n"), "0.64.2");
  assert.equal(parseClaudeVersionOutput("claude-agent-acp 0.64.2\n"), "0.64.2");
  assert.equal(parseClaudeVersionOutput("no version"), null);
});

test("Claude Code version parser cannot be confused with the bridge version", () => {
  assert.equal(parseClaudeCodeVersionOutput("2.1.236 (Claude Code)\n"), "2.1.236");
  assert.equal(
    parseClaudeCodeVersionOutput(
      "update available\n2.1.236-canary.1 (Claude Code)\n",
    ),
    "2.1.236-canary.1",
  );
  assert.equal(
    parseClaudeCodeVersionOutput("2.1.236-beta.0+build.7 (Claude Code)\n"),
    "2.1.236-beta.0+build.7",
  );
  assert.equal(parseClaudeCodeVersionOutput("0.64.2\n"), null);
  assert.equal(parseClaudeVersionOutput("2.1.236 (Claude Code)\n"), null);
});

test("Claude child env preserves HOME but strips inherited Claude and credential state", () => {
  const env = buildClaudeChildEnv({
    PATH: "/usr/bin",
    HOME: "/Users/test",
    USER: "test",
    LANG: "en_US.UTF-8",
    CLAUDE_CODE_ENTRYPOINT: "claude",
    CLAUDE_CODE_SESSION_ID: "session",
    CLAUDE_CODE_EXECUTABLE: "/tmp/ambient-claude",
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

test("Claude child env pins an explicit Claude Code realpath after sanitizing", () => {
  const env = buildClaudeChildEnv(
    { PATH: "/usr/bin", CLAUDE_CODE_EXECUTABLE: "/tmp/ambient-claude" },
    "/opt/trusted/claude",
  );
  assert.equal(env.CLAUDE_CODE_EXECUTABLE, "/opt/trusted/claude");
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
      await assertClaudeVersionFloor(resolved, { platform: "win32" }),
      CLAUDE_ACP_MIN_VERSION,
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
      await assertClaudeVersionFloor(executable, { env }),
      CLAUDE_ACP_MIN_VERSION,
    );
    await assert.rejects(
      () => assertClaudeVersionFloor(executable, { env: { ...env, HOME: "/wrong" } }),
      (error: unknown) => error instanceof AcpVersionError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude bridge below-floor error preserves the minimum and actual versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-version-mismatch-"));
  const executable = join(root, "claude-agent-acp");
  try {
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write("0.63.9\\n");\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    await assert.rejects(
      () =>
        openClaudeAcpSession({
          cwd: root,
          executable,
          env: { PATH: root, HOME: root },
        }),
      (error: unknown) =>
        error instanceof AcpVersionBelowFloorError &&
        error.minimum === CLAUDE_ACP_MIN_VERSION &&
        error.actual === "0.63.9" &&
        error.code === "version_below_floor",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude version process failures stay inside the typed host error boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-version-timeout-"));
  const executable = join(root, "claude-agent-acp");
  try {
    await writeFile(
      executable,
      `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    await assert.rejects(
      () => assertClaudeVersionFloor(executable, { timeoutMs: 25 }),
      (error: unknown) =>
        error instanceof AcpVersionError && error.code === "version_refused",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skipVersionCheck rejects an ambiguous explicit executable before spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-skip-version-"));
  const executable = join(root, "claude");
  try {
    await writeFile(executable, `#!${process.execPath}\n`, { mode: 0o700 });
    await chmod(executable, 0o700);
    await assert.rejects(
      () =>
        openClaudeAcpSession({
          cwd: root,
          executable,
          skipVersionCheck: true,
          env: { PATH: root, HOME: root },
        }),
      (error: unknown) =>
        error instanceof AcpHostError &&
        error.code === "version_check_required",
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
  try {
    await once(child.stdout, "data");
    await terminateClaudeChild(child);
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await terminateClaudeChild(child);
    }
  }
});

test("openClaudeAcpSession default probes and spawns one bridge realpath with one sanitized env", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-open-"));
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-cwd-"));
  try {
    const fake = await writeFakeClaudeBridge(root);
    const handle = await openClaudeAcpSession({
      cwd,
      env: {
        PATH: root,
        HOME: join(root, "operator-home"),
        SWARM_AGENT_TOKEN: "must-not-reach-child",
      },
      requestTimeoutMs: 2_000,
    });
    try {
      assert.equal(handle.executable, realpathSync(fake.target));
      assert.deepEqual(handle.args, []);
      assert.equal(handle.env.HOME, join(root, "operator-home"));
      assert.equal(handle.env.SWARM_AGENT_TOKEN, undefined);
      assert.deepEqual(await handle.session.load("claude-restored-session"), {
        sessionId: "claude-restored-session",
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
        { sessionId: "claude-test-session", modeId: "default" },
        { sessionId: "claude-restored-session", modeId: "default" },
      ]);
    } finally {
      await handle.close();
    }
    assert.ok(handle.child.exitCode !== null || handle.child.signalCode !== null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Claude canary retains the bridge's typed authentication failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-auth-error-"));
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-cwd-"));
  const detail =
    "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed (failed 2 attempts)";
  try {
    const fake = await writeFakeClaudeBridge(root, 1, {
      code: -32603,
      message: detail,
      data: { errorKind: "authentication_failed" },
    });
    const handle = await openClaudeAcpSession({
      cwd,
      executable: fake.shim,
      env: { PATH: root, HOME: join(root, "operator-home") },
      requestTimeoutMs: 2_000,
    });
    try {
      await assert.rejects(
        () => handle.session.enablePromptsAfterCanary({ attempts: 1 }),
        (error: unknown) => {
          assert.ok(error instanceof AcpPermissionCanaryError);
          assert.equal(error.message, detail);
          assert.equal(error.reasonCode, "rpc_error");
          assert.deepEqual(error.peerError, {
            code: -32603,
            data: { errorKind: "authentication_failed" },
          });
          return true;
        },
      );
    } finally {
      await handle.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an explicit Claude Code executable skips an earlier unpackaged bridge PATH decoy", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-authoritative-"));
  const bridgeRoot = join(root, "bridge");
  const decoyRoot = join(root, "decoy");
  const trustedRoot = join(root, "trusted");
  const cwd = join(root, "cwd");
  const trusted = join(trustedRoot, "claude");
  const trustedLog = join(root, "trusted.log");
  const decoy = join(decoyRoot, "claude-agent-acp");
  const decoyLog = join(root, "decoy.log");
  try {
    await Promise.all([
      mkdir(bridgeRoot, { recursive: true }),
      mkdir(decoyRoot, { recursive: true }),
      mkdir(trustedRoot, { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ]);
    const fake = await writeFakeClaudeBridge(bridgeRoot);
    await writeFile(
      trusted,
      `#!${process.execPath}\n` +
        `const fs = require("node:fs");\n` +
        `fs.appendFileSync(${JSON.stringify(trustedLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
        `if (process.argv[2] === "--version") process.stdout.write("2.1.236 (Claude Code)\\n");\n`,
      { mode: 0o700 },
    );
    await writeFile(
      decoy,
      `#!${process.execPath}\n` +
        `require("node:fs").appendFileSync(${JSON.stringify(decoyLog)}, "used\\n");\n` +
        `process.stdout.write("0.64.2\\n");\n`,
      { mode: 0o700 },
    );
    await Promise.all([chmod(trusted, 0o700), chmod(decoy, 0o700)]);

    const handle = await openClaudeAcpSession({
      cwd,
      executable: trusted,
      env: {
        PATH: `${decoyRoot}:${bridgeRoot}`,
        HOME: join(root, "operator-home"),
      },
      requestTimeoutMs: 2_000,
    });
    try {
      assert.equal(handle.executable, realpathSync(fake.target));
      assert.equal(handle.env.CLAUDE_CODE_EXECUTABLE, realpathSync(trusted));
      assert.equal(
        resolvePackagedClaudeBridge(`${decoyRoot}:${bridgeRoot}`),
        realpathSync(fake.target),
      );
      const trustedRows = (await readFile(trustedLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(trustedRows, [["--version"], ["--bridge-child"]]);
      await assert.rejects(() => readFile(decoyLog, "utf8"), { code: "ENOENT" });
      const bridgeRows = (await readFile(fake.log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as {
          args?: string[];
          claudeCodeExecutable?: string | null;
        })
        .filter((row) => Array.isArray(row.args));
      assert.deepEqual(
        bridgeRows.map((row) => row.claudeCodeExecutable),
        [realpathSync(trusted), realpathSync(trusted)],
      );
    } finally {
      await handle.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an early Claude bridge exit publishes fully flushed stderr before open rejects", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-early-stderr-"));
  const cwd = join(root, "cwd");
  const executable = join(root, "failing-claude-agent-acp.cjs");
  try {
    await mkdir(cwd, { recursive: true });
    await writeFile(
      executable,
      `#!${process.execPath}\n` +
        `const { spawn } = require("node:child_process");\n` +
        `if (process.argv[2] === "--version") { process.stdout.write("0.64.2\\n"); process.exit(0); }\n` +
        `const grandchild = spawn(process.execPath, ["-e", "process.send?.('ready'); setTimeout(() => process.stderr.write('fatal: bridge child failed before handshake\\\\n'), 25)"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });\n` +
        `grandchild.once("message", () => process.exit(7));\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const tails: string[] = [];
    await assert.rejects(
      () =>
        openClaudeAcpSession({
          cwd,
          executable,
          env: { PATH: root, HOME: join(root, "operator-home") },
          requestTimeoutMs: 2_000,
          onStderrTail: (tail) => tails.push(tail),
        }),
      (error: unknown) =>
        error instanceof AcpChildExitError && error.code === "child_exit",
    );
    assert.deepEqual(tails, ["fatal: bridge child failed before handshake"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stdout EOF fails within a bound even while the child stays alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-stdout-eof-"));
  const cwd = join(root, "cwd");
  const executable = join(root, "silent-claude-agent-acp.cjs");
  try {
    await mkdir(cwd, { recursive: true });
    await writeFile(
      executable,
      `#!${process.execPath}\n` +
        `if (process.argv[2] === "--version") { process.stdout.write("0.64.2\\n"); process.exit(0); }\n` +
        `process.stdout.end();\n` +
        `setInterval(() => {}, 1000);\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const startedAt = Date.now();
    await assert.rejects(
      () =>
        openClaudeAcpSession({
          cwd,
          executable,
          env: { PATH: root, HOME: join(root, "operator-home") },
          requestTimeoutMs: 2_000,
        }),
      (error: unknown) => error instanceof AcpChildExitError,
    );
    assert.ok(Date.now() - startedAt < 1_300);
  } finally {
    await rm(root, { recursive: true, force: true });
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
