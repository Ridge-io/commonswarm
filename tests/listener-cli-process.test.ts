import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { cloudTarget } from "../src/cloud/config.js";
import { listenerPaths } from "../src/listener/index.js";

const AGENT_MESSAGE =
  "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.";

function runCli(
  args: string[],
  options: {
    stdin?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

function fakeGrokSource(): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("grok 0.2.117 (fake)\\n");
  process.exit(0);
}

const audit = join(dirname(fileURLToPath(import.meta.url)), "grok-audit.ndjson");
appendFileSync(audit, JSON.stringify({
  event: "spawn",
  sandbox: process.env.GROK_SANDBOX ?? null,
  cmux_hooks_disabled: process.env.CMUX_GROK_HOOKS_DISABLED ?? null,
  has_swarm_env: Object.keys(process.env).some((key) => key.startsWith("SWARM_")),
  has_secret_env: Object.values(process.env).some((value) =>
    typeof value === "string" && value.includes("swm_agt_")
  ),
  argv_has_secret: process.argv.some((value) => value.includes("swm_agt_")),
  cwd: process.cwd(),
  home: process.env.HOME ?? null,
  grok_home: process.env.GROK_HOME ?? null,
  claude_hooks: process.env.GROK_CLAUDE_HOOKS_ENABLED ?? null,
  cursor_hooks: process.env.GROK_CURSOR_HOOKS_ENABLED ?? null,
  memory: process.env.GROK_MEMORY ?? null,
  subagents: process.env.GROK_SUBAGENTS ?? null,
}) + "\\n");

let buffer = "";
let permissionId = 1000;
const pending = new Map();
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");

function finishPrompt(hostId, text, optionId) {
  const canary = text.includes("cswarm-permission-boundary-canary");
  const denied = optionId === "deny";
  appendFileSync(audit, JSON.stringify({
    event: "permission",
    canary,
    option_id: optionId,
    sandbox: process.env.GROK_SANDBOX ?? null,
  }) + "\\n");
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "fake-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: denied ? "denied" : "completed",
      },
    },
  });
  if (!canary) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "fake listener reply" },
        },
      },
    });
  }
  send({
    jsonrpc: "2.0",
    id: hostId,
    result: { stopReason: "end_turn" },
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          _meta: { agentVersion: "0.2.117" },
        },
      });
      continue;
    }
    if (message.method === "session/new") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: "fake-session" },
      });
      continue;
    }
    if (message.method === "session/prompt") {
      const text = message.params?.prompt?.[0]?.text ?? "";
      const requestId = ++permissionId;
      pending.set(requestId, { hostId: message.id, text });
      send({
        jsonrpc: "2.0",
        id: requestId,
        method: "session/request_permission",
        params: {
          sessionId: "fake-session",
          toolCall: {
            toolCallId: "tool-1",
            title: "Fake tool",
            kind: "shell",
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      const optionId = message.result?.outcome?.optionId ?? "cancelled";
      finishPrompt(item.hostId, item.text, optionId);
    }
  }
});
`;
}

test("detached CLI receives, isolates, replies, reports status, and stops", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-cli-listener-"));
  const workerCwd = await mkdtemp(join(tmpdir(), "cswarm-cli-worker-"));
  const grokPath = join(root, "fake-grok.mjs");
  const auditPath = join(root, "grok-audit.ndjson");
  const providerHome = join(root, "provider-home");
  await writeFile(grokPath, fakeGrokSource(), { mode: 0o700 });
  await chmod(grokPath, 0o700);
  await mkdir(providerHome, { mode: 0o700 });
  const authPath = join(providerHome, "auth.json");
  await writeFile(authPath, JSON.stringify({ access_token: "fake-local-login" }), {
    mode: 0o600,
  });
  await chmod(authPath, 0o600);

  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const tokenId = randomUUID();
  const runId = randomUUID();
  const token = `swm_agt_${"A".repeat(43)}`;
  const artifact = JSON.stringify({
    message: AGENT_MESSAGE,
    status: "accepted",
    principal_id: principalId,
    token_id: tokenId,
    run_id: runId,
    agent_token: token,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  const asks = [
    {
      id: randomUUID(),
      workspace_id: workspaceId,
      from: randomUUID(),
      from_kind: "agent",
      to: null,
      to_agent: principalId,
      in_reply_to: null,
      about: null,
      kind: "ask",
      body: "same-owner test ask",
      until: new Date(Date.now() + 10 * 60_000).toISOString(),
      created_at: new Date(Date.now() - 2_000).toISOString(),
      sender_owner_relation: "same_owner",
    },
    {
      id: randomUUID(),
      workspace_id: workspaceId,
      from: randomUUID(),
      from_kind: "agent",
      to: null,
      to_agent: principalId,
      in_reply_to: null,
      about: null,
      kind: "ask",
      body: "cross-owner test ask",
      until: new Date(Date.now() + 10 * 60_000).toISOString(),
      created_at: new Date(Date.now() - 1_000).toISOString(),
      sender_owner_relation: "cross_owner",
    },
  ];
  const posts: Array<Record<string, unknown>> = [];
  const authHeaders: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    authHeaders.push(String(request.headers.authorization ?? ""));
    if (request.url === "/functions/v1/read") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        signals: asks,
        capabilities: { sender_owner_relation: 1, cursor_after: 1 },
      }));
      return;
    }
    if (request.url === "/functions/v1/command") {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      posts.push(parsed);
      const command = parsed.command as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        signal: {
          ...asks[0],
          id: randomUUID(),
          kind: "note",
          body: command.body,
          in_reply_to: command.in_reply_to,
          sender_owner_relation: undefined,
        },
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const canonicalWorkerCwd = await realpath(workerCwd);
  const common = [
    "--url",
    url,
    "--anon-key",
    "public-anon",
    "--workspace-id",
    workspaceId,
    "--state-dir",
    root,
  ];

  try {
    const startArgs = [
      "listen",
      "start",
      "--agent-token-stdin",
      ...common,
      "--cwd",
      workerCwd,
      "--permissions",
      "allow",
      "--grok-executable",
      grokPath,
      "--json",
    ];
    const startOptions = {
      stdin: artifact,
      env: {
        GROK_HOME: providerHome,
        SWARM_AGENT_TOKEN: token,
        DATABASE_URL: "postgres://must-not-reach-listener",
      },
    };
    const starts = await Promise.all([
      runCli(startArgs, startOptions),
      runCli(startArgs, startOptions),
    ]);
    const successfulStarts = starts.filter((result) => result.code === 0);
    const refusedStarts = starts.filter((result) => result.code !== 0);
    assert.equal(successfulStarts.length, 1, JSON.stringify(starts));
    assert.equal(refusedStarts.length, 1, JSON.stringify(starts));
    assert.match(refusedStarts[0]!.stderr, /already running/i);
    const started = successfulStarts[0]!;
    assert.equal(started.code, 0, started.stderr);
    const startJson = JSON.parse(started.stdout) as Record<string, unknown>;
    assert.equal(startJson.state, "ready");
    assert.equal(startJson.principalId, principalId);

    await waitFor(() => posts.length === 2);
    assert.equal(
      posts.every((post) =>
        typeof post.command_id === "string" &&
        /^reply_[a-f0-9]{32}_0$/.test(post.command_id)
      ),
      true,
    );
    assert.deepEqual(
      posts.map((post) =>
        (post.command as Record<string, unknown>).in_reply_to
      ).sort(),
      asks.map((ask) => ask.id).sort(),
    );
    assert.equal(authHeaders.every((header) => header === `Bearer ${token}`), true);

    const status = await runCli([
      "listen",
      "status",
      ...common,
      "--principal-id",
      principalId,
      "--json",
    ]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal((JSON.parse(status.stdout) as Record<string, unknown>).state, "ready");

    const stopped = await runCli([
      "listen",
      "stop",
      ...common,
      "--principal-id",
      principalId,
      "--json",
    ]);
    assert.equal(stopped.code, 0, stopped.stderr);
    await waitFor(async () => {
      const current = await runCli([
        "listen",
        "status",
        ...common,
        "--principal-id",
        principalId,
        "--json",
      ]);
      return current.code === 0 &&
        (JSON.parse(current.stdout) as Record<string, unknown>).state === "stopped";
    });

    const audit = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const spawns = audit.filter((row) => row.event === "spawn");
    assert.equal(spawns.length, 2);
    assert.equal(
      spawns.some((row) =>
        row.sandbox === null &&
        row.cwd === canonicalWorkerCwd &&
        row.grok_home === providerHome
      ),
      true,
    );
    assert.equal(
      spawns.some((row) =>
        row.sandbox === "strict" &&
        typeof row.cwd === "string" &&
        row.cwd !== canonicalWorkerCwd
      ),
      true,
    );
    assert.equal(spawns.every((row) => row.cmux_hooks_disabled === "1"), true);
    assert.equal(spawns.every((row) => row.has_swarm_env === false), true);
    assert.equal(spawns.every((row) => row.has_secret_env === false), true);
    assert.equal(spawns.every((row) => row.argv_has_secret === false), true);
    const isolatedSpawn = spawns.find((row) => row.sandbox === "strict");
    assert.ok(isolatedSpawn);
    assert.equal(isolatedSpawn.home, isolatedSpawn.grok_home);
    assert.notEqual(isolatedSpawn.home, process.env.HOME);
    assert.equal(isolatedSpawn.claude_hooks, "0");
    assert.equal(isolatedSpawn.cursor_hooks, "0");
    assert.equal(isolatedSpawn.memory, "0");
    assert.equal(isolatedSpawn.subagents, "0");
    const permissions = audit.filter((row) =>
      row.event === "permission" && row.canary === false
    );
    assert.equal(
      permissions.some((row) =>
        row.sandbox === null && row.option_id === "allow"
      ),
      true,
    );
    assert.equal(
      permissions.some((row) =>
        row.sandbox === "strict" && row.option_id === "deny"
      ),
      true,
    );

    const paths = listenerPaths({
      profileId: cloudTarget(url, "public-anon").profileId,
      workspaceId,
      principalId,
      stateDirectory: root,
    });
    const safeLog = await readFile(paths.logPath, "utf8");
    const safeStatus = await readFile(paths.statusPath, "utf8");
    assert.doesNotMatch(safeLog, /same-owner test ask|cross-owner test ask|swm_agt_/);
    assert.doesNotMatch(safeStatus, /same-owner test ask|cross-owner test ask|swm_agt_/);
  } finally {
    await runCli([
      "listen",
      "stop",
      ...common,
      "--principal-id",
      principalId,
      "--json",
    ]).catch(() => undefined);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
    await rm(workerCwd, { recursive: true, force: true });
  }
});

test("detached CLI reports missing Grok login without starting a model", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-cli-missing-auth-"));
  const emptyProviderHome = join(root, "empty-provider-home");
  await mkdir(emptyProviderHome, { mode: 0o700 });

  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const token = `swm_agt_${"B".repeat(43)}`;
  const artifact = JSON.stringify({
    message: AGENT_MESSAGE,
    status: "accepted",
    principal_id: principalId,
    token_id: randomUUID(),
    run_id: randomUUID(),
    agent_token: token,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before replying.
    }
    if (request.url === "/functions/v1/read") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        signals: [],
        capabilities: { sender_owner_relation: 1, cursor_after: 1 },
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const common = [
    "--url",
    url,
    "--anon-key",
    "public-anon",
    "--workspace-id",
    workspaceId,
    "--state-dir",
    root,
  ];

  try {
    const started = await runCli([
      "listen",
      "start",
      "--agent-token-stdin",
      ...common,
      "--json",
    ], {
      stdin: artifact,
      env: { GROK_HOME: emptyProviderHome },
    });
    assert.notEqual(started.code, 0);
    assert.match(started.stderr, /run grok login/i);
    assert.doesNotMatch(started.stdout + started.stderr, /swm_agt_/);

    const status = await runCli([
      "listen",
      "status",
      ...common,
      "--principal-id",
      principalId,
      "--json",
    ]);
    assert.equal(status.code, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as Record<string, unknown>;
    assert.equal(statusJson.state, "failed");
    assert.equal(statusJson.lastErrorCode, "grok_auth_missing");

    const paths = listenerPaths({
      profileId: cloudTarget(url, "public-anon").profileId,
      workspaceId,
      principalId,
      stateDirectory: root,
    });
    const safeLog = await readFile(paths.logPath, "utf8");
    const safeStatus = await readFile(paths.statusPath, "utf8");
    assert.doesNotMatch(safeLog + safeStatus, /swm_agt_/);
  } finally {
    await runCli([
      "listen",
      "stop",
      ...common,
      "--principal-id",
      principalId,
      "--json",
    ]).catch(() => undefined);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});
