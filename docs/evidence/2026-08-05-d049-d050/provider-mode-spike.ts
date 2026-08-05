import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildClaudeAcpArgs,
  buildClaudeChildEnv,
  resolveClaudeExecutable,
} from "../../../src/host/claude.ts";
import { sanitizeChildEnv } from "../../../src/host/env.ts";
import {
  buildGrokAcpArgs,
  buildGrokChildEnv,
  resolveGrokExecutable,
} from "../../../src/host/grok.ts";
import {
  buildOpenCodeAcpArgs,
  buildOpenCodeChildEnv,
  prepareOpenCodeIsolatedHome,
  resolveOpenCodeExecutable,
} from "../../../src/host/opencode.ts";

type Provider = "claude" | "codex" | "grok" | "opencode";
type JsonRpcId = string | number;
type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function terminateChild(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(5_000, false)])) return;
  child.kill("SIGKILL");
  if (await Promise.race([exited.then(() => true), delay(5_000, false)])) return;
  throw new Error("provider child did not exit after SIGTERM and SIGKILL");
}

async function providerLaunch(provider: Provider): Promise<{
  executable: string;
  args: string[];
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  if (provider === "claude") {
    const executable = resolveClaudeExecutable("claude-agent-acp", process.env.PATH);
    return {
      executable,
      args: buildClaudeAcpArgs(),
      env: buildClaudeChildEnv(process.env),
      cleanup: async () => undefined,
    };
  }
  if (provider === "codex") {
    const executable = resolve("node_modules/.bin/codex-acp");
    if (!existsSync(executable)) {
      throw new Error(`codex-acp executable does not exist: ${executable}`);
    }
    return {
      executable,
      args: [],
      env: sanitizeChildEnv(process.env),
      cleanup: async () => undefined,
    };
  }
  if (provider === "grok") {
    return {
      executable: resolveGrokExecutable("grok"),
      args: buildGrokAcpArgs({}),
      env: buildGrokChildEnv(process.env),
      cleanup: async () => undefined,
    };
  }

  const home = await prepareOpenCodeIsolatedHome({ env: process.env });
  return {
    executable: resolveOpenCodeExecutable("opencode", process.env.PATH),
    args: buildOpenCodeAcpArgs(),
    env: buildOpenCodeChildEnv(process.env, home),
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
    },
  };
}

const provider = process.argv[2] as Provider | undefined;
const controlModeId = process.argv[3];
if (
  provider !== "claude" &&
  provider !== "codex" &&
  provider !== "grok" &&
  provider !== "opencode"
) {
  throw new Error("usage: provider-mode-spike.ts claude|codex|grok|opencode");
}

const launch = await providerLaunch(provider);
const cwd = await mkdtemp(join(tmpdir(), `cswarm-${provider}-mode-spike-`));
let child: ChildProcessWithoutNullStreams | null = null;
try {
  child = spawn(launch.executable, launch.args, {
    cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const activeChild = child;
  const lines = createInterface({ input: activeChild.stdout });
  const pending = new Map<JsonRpcId, Pending>();
  const stderr: string[] = [];
  let permissionRequestCount = 0;
  let nextId = 1;

  activeChild.stderr.setEncoding("utf8");
  activeChild.stderr.on("data", (chunk: string) => stderr.push(chunk));

  function send(message: Record<string, unknown>): void {
    activeChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`${method} timed out after 30 seconds`));
      }, 30_000);
      pending.set(id, {
        method,
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      });
      send({ id, method, params });
    });
  }

  lines.on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`invalid JSON: ${String(error)}`));
      }
      pending.clear();
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        if (message.method === "session/request_permission") {
          permissionRequestCount += 1;
          const params = isRecord(message.params) ? message.params : {};
          const options = Array.isArray(params.options) ? params.options : [];
          const reject = options.find((option) =>
            isRecord(option) &&
            (option.kind === "reject_once" || option.kind === "reject_always") &&
            typeof option.optionId === "string"
          );
          send({
            id: message.id,
            result: isRecord(reject) && typeof reject.optionId === "string"
              ? { outcome: { outcome: "selected", optionId: reject.optionId } }
              : { outcome: { outcome: "cancelled" } },
          });
          return;
        }
        send({
          id: message.id,
          error: { code: -32601, message: `Unsupported client method: ${message.method}` },
        });
      }
      return;
    }
    if (message.id === undefined) return;
    const entry = pending.get(message.id as JsonRpcId);
    if (!entry) return;
    pending.delete(message.id as JsonRpcId);
    clearTimeout(entry.timer);
    if (isRecord(message.error)) {
      entry.reject(new Error(`${entry.method} failed: ${JSON.stringify(message.error)}`));
      return;
    }
    entry.resolve(message.result);
  });

  activeChild.on("exit", (code, signal) => {
    const detail = stderr.join("").trim().slice(-2_000);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(
        new Error(
          `${provider} exited during ${entry.method} (code=${String(code)}, signal=${String(signal)})${
            detail ? `: ${detail}` : ""
          }`,
        ),
      );
    }
    pending.clear();
  });

  const initialize = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "cswarm-provider-mode-spike", version: "0.1.6" },
  });
  const newSession = await request("session/new", {
    cwd,
    mcpServers: [],
    _meta: { yoloMode: false },
  });
  const initializeRecord = isRecord(initialize) ? initialize : {};
  const newSessionRecord = isRecord(newSession) ? newSession : {};
  const configOptions = Array.isArray(newSessionRecord.configOptions)
    ? newSessionRecord.configOptions
    : [];
  const modeConfig = configOptions.find((option) =>
    isRecord(option) && (option.id === "mode" || option.category === "mode")
  );
  let control: Record<string, unknown> | null = null;
  if (controlModeId && typeof newSessionRecord.sessionId === "string") {
    const setMode = await request("session/set_mode", {
      sessionId: newSessionRecord.sessionId,
      modeId: controlModeId,
    });
    const sentinelPath = join(cwd, "permission-control.txt");
    const prompt = await request("session/prompt", {
      sessionId: newSessionRecord.sessionId,
      prompt: [{
        type: "text",
        text: provider === "claude"
          ? `Create the file ${sentinelPath} using the Write tool with content CSWARM_MODE_CONTROL. You must use the Write tool. Do nothing else.`
          : `Use a shell command to create ${sentinelPath} containing CSWARM_MODE_CONTROL. You must use the shell. Do nothing else.`,
      }],
    });
    control = {
      modeId: controlModeId,
      setMode,
      prompt,
      permissionRequestCount,
      sentinelCreated: existsSync(sentinelPath),
    };
  }
  console.log(JSON.stringify({
    provider,
    executable: launch.executable,
    args: launch.args,
    protocolVersion: initializeRecord.protocolVersion,
    agentInfo: initializeRecord.agentInfo,
    sessionId: newSessionRecord.sessionId,
    modes: newSessionRecord.modes ?? null,
    modeConfig: modeConfig ?? null,
    control,
    stderrTail: stderr.join("").trim().slice(-2_000),
  }, null, 2));
  lines.close();
} finally {
  await terminateChild(child);
  await launch.cleanup();
  await rm(cwd, { recursive: true, force: true });
}
