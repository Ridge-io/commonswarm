import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { sanitizeChildEnv } from "../../../src/host/env.ts";

type JsonRpcId = string | number;
type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const executable = resolve(process.argv[2] ?? "node_modules/.bin/codex-acp");
const probeCwd = mkdtempSync(join(tmpdir(), "cswarm-codex-acp-spike-"));
const deniedSentinel = "SWARM_CODEX_ACP_SPIKE_SENTINEL";
const parentEnv = { ...process.env, [deniedSentinel]: "must-not-reach-child" };
const childEnv = sanitizeChildEnv(parentEnv);
const strippedParentKeys = Object.keys(parentEnv)
  .filter((key) => !(key in childEnv))
  .sort();

if (!existsSync(executable)) {
  throw new Error(`codex-acp executable does not exist: ${executable}`);
}
if (childEnv[deniedSentinel] !== undefined) {
  throw new Error("sanitizeChildEnv positive control failed: SWARM sentinel survived");
}
if (typeof childEnv.HOME !== "string" || childEnv.HOME.length === 0) {
  throw new Error("sanitizeChildEnv removed HOME; file-backed Codex auth cannot work");
}
const versionOutput = execFileSync(executable, ["--version"], {
  cwd: probeCwd,
  env: childEnv,
  encoding: "utf8",
}).trim();
const versionMatch = versionOutput.match(
  /^@agentclientprotocol\/codex-acp (\d+\.\d+\.\d+)$/,
);
if (!versionMatch) {
  throw new Error(`could not parse codex-acp version from: ${versionOutput.slice(0, 200)}`);
}
const adapterRequire = createRequire(executable);
const codexPackage = JSON.parse(
  readFileSync(adapterRequire.resolve("@openai/codex/package.json"), "utf8"),
) as { version?: unknown };
const installLock = JSON.parse(
  readFileSync(resolve("node_modules/.package-lock.json"), "utf8"),
) as { packages?: Record<string, { version?: unknown; integrity?: unknown }> };
const codexLock = installLock.packages?.["node_modules/@openai/codex"];
if (
  typeof codexPackage.version !== "string" ||
  codexLock?.version !== codexPackage.version ||
  typeof codexLock.integrity !== "string"
) {
  throw new Error("could not identify the resolved @openai/codex runtime artifact");
}

const child = spawn(executable, [], {
  cwd: probeCwd,
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = createInterface({ input: child.stdout });
const pending = new Map<JsonRpcId, Pending>();
const permissionRequests: Array<Record<string, unknown>> = [];
const updateKinds = new Map<string, number>();
const stderr: string[] = [];
let nextId = 1;

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => stderr.push(chunk));

function send(message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`${method} timed out after 180 seconds`));
    }, 180_000);
    pending.set(id, {
      method,
      resolve: resolveRequest,
      reject: rejectRequest,
      timer,
    });
    send({ id, method, params });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function countUpdate(params: unknown): void {
  if (!isRecord(params) || !isRecord(params.update)) return;
  const kind = typeof params.update.sessionUpdate === "string"
    ? params.update.sessionUpdate
    : "unknown";
  updateKinds.set(kind, (updateKinds.get(kind) ?? 0) + 1);
}

function denyPermission(id: JsonRpcId, params: Record<string, unknown>): void {
  permissionRequests.push(params);
  const options = Array.isArray(params.options) ? params.options : [];
  const reject = options.find((option) =>
    isRecord(option) &&
    (option.kind === "reject_once" || option.kind === "reject_always") &&
    typeof option.optionId === "string"
  );
  if (isRecord(reject) && typeof reject.optionId === "string") {
    send({
      id,
      result: {
        outcome: { outcome: "selected", optionId: reject.optionId },
      },
    });
    return;
  }
  send({ id, result: { outcome: { outcome: "cancelled" } } });
}

lines.on("line", (line) => {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch (error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`invalid JSON from codex-acp: ${String(error)}`));
    }
    pending.clear();
    return;
  }
  if (!isRecord(message)) return;

  if (typeof message.method === "string") {
    if (message.method === "session/update") countUpdate(message.params);
    if (message.id !== undefined && message.method === "session/request_permission") {
      denyPermission(message.id as JsonRpcId, isRecord(message.params) ? message.params : {});
    } else if (message.id !== undefined) {
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

child.on("exit", (code, signal) => {
  const detail = stderr.join("").trim().slice(-2_000);
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(
      new Error(
        `codex-acp exited during ${entry.method} (code=${String(code)}, signal=${String(signal)})${
          detail ? `: ${detail}` : ""
        }`,
      ),
    );
  }
  pending.clear();
});

try {
  const initialize = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "cswarm-codex-acp-spike", version: "0.1.6" },
  });
  const newSession = await request("session/new", {
    cwd: probeCwd,
    mcpServers: [],
    _meta: { yoloMode: false },
  });
  if (!isRecord(newSession) || typeof newSession.sessionId !== "string") {
    throw new Error(`session/new missing sessionId: ${JSON.stringify(newSession)}`);
  }

  const noToolPrompt = await request("session/prompt", {
    sessionId: newSession.sessionId,
    prompt: [{ type: "text", text: "Reply with exactly CODEX_ACP_OK. Use no tools." }],
  });
  const defaultModeCanaryPath = join(probeCwd, "default-mode-canary.txt");
  const defaultModePermissionCountBefore = permissionRequests.length;
  const defaultModePrompt = await request("session/prompt", {
    sessionId: newSession.sessionId,
    prompt: [{
      type: "text",
      text: `Use a shell command to create ${defaultModeCanaryPath} containing CODEX_ACP_DEFAULT_MODE_CANARY. Do not merely explain.`,
    }],
  });
  const defaultModePermissionRequestCount =
    permissionRequests.length - defaultModePermissionCountBefore;
  const defaultModeCanaryContents = existsSync(defaultModeCanaryPath)
    ? readFileSync(defaultModeCanaryPath, "utf8")
    : null;

  const setReadOnlyMode = await request("session/set_mode", {
    sessionId: newSession.sessionId,
    modeId: "read-only",
  });
  const readOnlyCanaryPath = join(probeCwd, "read-only-canary.txt");
  const readOnlyPermissionCountBefore = permissionRequests.length;
  const readOnlyModePrompt = await request("session/prompt", {
    sessionId: newSession.sessionId,
    prompt: [{
      type: "text",
      text: `Use a shell command to create ${readOnlyCanaryPath} containing CODEX_ACP_READ_ONLY_CANARY. Do not merely explain.`,
    }],
  });
  const readOnlyModePermissionRequestCount =
    permissionRequests.length - readOnlyPermissionCountBefore;

  console.log(JSON.stringify({
    packageVersion: versionMatch[1],
    versionOutput,
    codexRuntime: {
      version: codexPackage.version,
      integrity: codexLock.integrity,
    },
    executable,
    probeCwd,
    sanitizedEnvironment: {
      ambientParentKeyCount: Object.keys(process.env).length,
      probeParentKeyCount: Object.keys(parentEnv).length,
      childKeyCount: Object.keys(childEnv).length,
      strippedKeyCount: strippedParentKeys.length,
      strippedParentKeys,
      homeSurvives: typeof childEnv.HOME === "string",
      denySentinelStripped: childEnv[deniedSentinel] === undefined,
    },
    initialize,
    newSession,
    noToolPrompt,
    defaultModePrompt,
    defaultModePermissionRequestCount,
    defaultModeCanaryFileExists: existsSync(defaultModeCanaryPath),
    defaultModeCanaryContents,
    setReadOnlyMode,
    readOnlyModePrompt,
    readOnlyModePermissionRequestCount,
    readOnlyModeCanaryFileExistsAfterDeny: existsSync(readOnlyCanaryPath),
    permissionRequestCount: permissionRequests.length,
    permissionRequests,
    updateKinds: Object.fromEntries([...updateKinds.entries()].sort()),
    stderrTail: stderr.join("").trim().slice(-2_000),
  }, null, 2));
} finally {
  lines.close();
  child.kill("SIGTERM");
}
