/**
 * Claude ACP subprocess core — measured against claude-agent-acp 0.64.2.
 *
 * Spawn shape: `claude-agent-acp` with no arguments. The bridge speaks ACP
 * protocolVersion 1 and emits session/request_permission. It uses the
 * operator's normal HOME for Claude Code keychain/OAuth state.
 */

import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve as resolvePath,
} from "node:path";
import {
  ACP_DEFAULT_REQUEST_TIMEOUT_MS,
  ACP_VERSION_CHECK_TIMEOUT_MS,
  CLAUDE_ACP_MEASURED_VERSION,
} from "./bounds.js";
import { sanitizeChildEnv } from "./env.js";
import { AcpHostSession, createBoundTransport } from "./session.js";
import {
  AcpHostError,
  AcpVersionError,
  type HostSessionEvents,
  type PermissionCallback,
} from "./types.js";

export type ClaudeAcpOpenOptions = {
  cwd: string;
  /** Absolute realpath to claude-agent-acp. Bare names are resolved once at open. */
  executable?: string;
  permissionCallback?: PermissionCallback;
  events?: HostSessionEvents;
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Abort only the opening handshake; an opened handle owns its close lifecycle. */
  signal?: AbortSignal;
  /** Skip version gate (tests only). */
  skipVersionCheck?: boolean;
  clientName?: string;
  clientVersion?: string;
  /** When true, prompts are enabled without canary (tests only). */
  promptsEnabled?: boolean;
};

export type ClaudeAcpHandle = {
  session: AcpHostSession;
  child: ChildProcessWithoutNullStreams;
  executable: string;
  args: string[];
  env: Record<string, string>;
  close: () => Promise<void>;
};

const CHILD_EXIT_WAIT_MS = 3_000;
const CHILD_KILL_WAIT_MS = 1_000;
const WINDOWS_NPM_SHIM_MAX_BYTES = 64 * 1024;
const WINDOWS_NPM_ENTRYPOINT = [
  "node_modules",
  "@agentclientprotocol",
  "claude-agent-acp",
  "dist",
  "index.js",
] as const;

function resolveWindowsNpmShim(shim: string): string {
  let source: string;
  try {
    source = readFileSync(shim, "utf8");
  } catch {
    throw new AcpHostError(
      "executable_missing",
      `could not read claude-agent-acp npm shim: ${shim}`,
    );
  }
  if (
    Buffer.byteLength(source, "utf8") > WINDOWS_NPM_SHIM_MAX_BYTES ||
    !source.includes(
      String.raw`"%dp0%\node_modules\@agentclientprotocol\claude-agent-acp\dist\index.js"`,
    )
  ) {
    throw new AcpHostError(
      "executable_missing",
      `unrecognized claude-agent-acp npm shim: ${shim}`,
    );
  }
  const target = join(dirname(shim), ...WINDOWS_NPM_ENTRYPOINT);
  try {
    accessSync(target, fsConstants.R_OK);
    return realpathSync(target);
  } catch {
    throw new AcpHostError(
      "executable_missing",
      `claude-agent-acp package entrypoint is missing beside npm shim: ${shim}`,
    );
  }
}

function resolvedClaudeCandidate(
  candidate: string,
  platform: NodeJS.Platform,
): string {
  accessSync(candidate, fsConstants.X_OK);
  const real = realpathSync(candidate);
  return platform === "win32" && extname(real).toLowerCase() === ".cmd"
    ? resolveWindowsNpmShim(real)
    : real;
}

/** Resolve bare or relative executable to one absolute realpath for probe and spawn. */
export function resolveClaudeExecutable(
  executable = "claude-agent-acp",
  pathEnv?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (
    isAbsolute(executable) ||
    executable.includes("/") ||
    executable.includes("\\")
  ) {
    const abs = resolvePath(executable);
    const candidates = platform === "win32" && extname(abs) === ""
      ? [`${abs}.cmd`]
      : [abs];
    for (const candidate of candidates) {
      try {
        return resolvedClaudeCandidate(candidate, platform);
      } catch (error) {
        if (error instanceof AcpHostError) throw error;
      }
    }
    throw new AcpHostError("executable_missing", `not executable: ${abs}`);
  }
  const pathValue = pathEnv ?? process.env.PATH ?? "";
  const names = platform === "win32" && extname(executable) === ""
    ? [`${executable}.cmd`]
    : [executable];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        return resolvedClaudeCandidate(candidate, platform);
      } catch (error) {
        if (error instanceof AcpHostError) throw error;
      }
    }
  }
  throw new AcpHostError(
    "executable_missing",
    `claude-agent-acp executable not found on PATH: ${executable}`,
  );
}

/** Launch an npm JavaScript entrypoint through Node on native Windows. */
export function buildClaudeLaunch(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  return platform === "win32" && extname(executable).toLowerCase() === ".js"
    ? { command: process.execPath, args: [executable, ...args] }
    : { command: executable, args: [...args] };
}

/** Parse the bridge's measured bare semver version output. */
export function parseClaudeVersionOutput(stdout: string): string | null {
  const match = stdout.trim().match(/^(\d+\.\d+\.\d+)$/);
  return match?.[1] ?? null;
}

/** Run the resolved bridge with the exact environment used for its ACP process. */
export async function assertClaudeMeasuredVersion(
  executable: string,
  options?: {
    expected?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    /** Injected only to exercise native Windows launch shape in pure tests. */
    platform?: NodeJS.Platform;
  },
): Promise<string> {
  const expected = options?.expected ?? CLAUDE_ACP_MEASURED_VERSION;
  const timeoutMs = options?.timeoutMs ?? ACP_VERSION_CHECK_TIMEOUT_MS;
  const env = options?.env ?? sanitizeChildEnv(process.env);
  const launch = buildClaudeLaunch(executable, ["--version"], options?.platform);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      launch.command,
      launch.args,
      { timeout: timeoutMs, encoding: "utf8", env: env as NodeJS.ProcessEnv },
      (error, out, stderr) => {
        if (error) {
          reject(
            new AcpVersionError(
              `failed to run ${executable} --version: ${error.message}${
                stderr ? ` (${stderr.trim()})` : ""
              }`,
            ),
          );
          return;
        }
        resolve(out);
      },
    );
  });
  const version = parseClaudeVersionOutput(stdout);
  if (!version) {
    throw new AcpVersionError(
      `could not parse claude-agent-acp version from: ${stdout.trim().slice(0, 200)}`,
    );
  }
  if (version !== expected) {
    throw new AcpVersionError(
      `refusing claude-agent-acp ${version}; host core is measured for ${expected} only`,
    );
  }
  return version;
}

/** The bridge enters ACP mode with no command-line arguments. */
export function buildClaudeAcpArgs(): string[] {
  return [];
}

/** Preserve the normal home while stripping CommonSwarm and credential variables. */
export function buildClaudeChildEnv(
  parent: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  return sanitizeChildEnv(parent);
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Stop the bridge with SIGTERM, escalate to SIGKILL, and confirm it exited. */
export async function terminateClaudeChild(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // already dead
  }
  await waitForChildExit(child, CHILD_EXIT_WAIT_MS);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // already dead
  }
  await waitForChildExit(child, CHILD_KILL_WAIT_MS);
  if (child.exitCode === null && child.signalCode === null) {
    throw new AcpHostError(
      "child_exit_timeout",
      "Claude ACP bridge did not exit after SIGTERM and SIGKILL",
    );
  }
}

/** Open the measured Claude bridge, initialize ACP, and create one worker session. */
export async function openClaudeAcpSession(
  options: ClaudeAcpOpenOptions,
): Promise<ClaudeAcpHandle> {
  const parentEnv = options.env ?? process.env;
  if (options.signal?.aborted) {
    throw new AcpHostError(
      "cancelled",
      "Claude ACP bridge opening was cancelled",
    );
  }
  const pathEnv = parentEnv.PATH;
  const executable = resolveClaudeExecutable(
    options.executable ?? "claude-agent-acp",
    typeof pathEnv === "string" ? pathEnv : undefined,
  );
  const env = buildClaudeChildEnv(parentEnv);
  if (!options.skipVersionCheck) {
    await assertClaudeMeasuredVersion(executable, { env });
  }
  if (options.signal?.aborted) {
    throw new AcpHostError(
      "cancelled",
      "Claude ACP bridge opening was cancelled",
    );
  }

  const args = buildClaudeAcpArgs();
  const launch = buildClaudeLaunch(executable, args);
  const child = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    cwd: options.cwd,
  }) as ChildProcessWithoutNullStreams;
  const spawnError = new Promise<never>((_resolve, reject) => {
    child.once("error", () => {
      reject(
        new AcpHostError(
          "spawn_failed",
          "failed to spawn the Claude ACP bridge",
        ),
      );
    });
  });
  let removeAbortListener: () => void = () => undefined;
  const abortError = new Promise<never>((_resolve, reject) => {
    const signal = options.signal;
    if (!signal) return;
    const onAbort = () => {
      reject(
        new AcpHostError(
          "cancelled",
          "Claude ACP bridge opening was cancelled",
        ),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  if (!child.stdin || !child.stdout) {
    await terminateClaudeChild(child);
    throw new AcpHostError("spawn_failed", "child missing stdio pipes");
  }
  // Provider stderr may contain prompt text or local paths. Drain, never log.
  child.stderr.on("data", () => undefined);
  child.stderr.resume();

  let sessionRef: AcpHostSession | null = null;
  const transport = createBoundTransport({
    readable: child.stdout,
    writable: child.stdin,
    requestTimeoutMs: options.requestTimeoutMs ?? ACP_DEFAULT_REQUEST_TIMEOUT_MS,
    getSession: () => sessionRef,
    onChildExit: (handler) => {
      child.on("exit", (code, signal) => handler(code, signal));
    },
  });

  try {
    const session = await Promise.race([
      AcpHostSession.connect({
        transport,
        cwd: options.cwd,
        permissionCallback: options.permissionCallback,
        events: options.events,
        requestTimeoutMs: options.requestTimeoutMs,
        clientName: options.clientName,
        clientVersion: options.clientVersion,
        promptsEnabled: options.promptsEnabled,
      }),
      spawnError,
      abortError,
    ]);
    removeAbortListener();
    sessionRef = session;

    let closePromise: Promise<void> | null = null;
    const close = async () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        try {
          await session.close();
        } finally {
          await terminateClaudeChild(child);
        }
      })();
      return closePromise;
    };

    return { session, child, executable, args, env, close };
  } catch (error) {
    removeAbortListener();
    transport.close();
    await terminateClaudeChild(child);
    throw error;
  }
}

export { CLAUDE_ACP_MEASURED_VERSION };
