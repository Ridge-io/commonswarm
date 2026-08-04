/**
 * Grok ACP subprocess core — measured against grok 0.2.117, protocolVersion 1.
 *
 * Spawn shape: `grok agent --no-leader [-m MODEL] [--reasoning-effort EFFORT] stdio`
 * Never passes --always-approve. session/new always sets _meta.yoloMode false and
 * mcpServers []. Child env is allowlisted (see env.ts).
 *
 * Permission boundary: host answers session/request_permission via an injected
 * callback (default reject_once). The subprocess otherwise uses the operator's
 * local Grok configuration.
 */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  ACP_DEFAULT_REQUEST_TIMEOUT_MS,
  ACP_VERSION_CHECK_TIMEOUT_MS,
  GROK_MEASURED_VERSION,
} from "./bounds.js";
import { sanitizeChildEnv } from "./env.js";
import { AcpHostSession, createBoundTransport } from "./session.js";
import { AcpTransport } from "./transport.js";
import {
  AcpHostError,
  AcpVersionError,
  type HostSessionEvents,
  type PermissionCallback,
} from "./types.js";

export type GrokAcpOpenOptions = {
  cwd: string;
  /** Absolute path or bare name resolved via PATH. Default: "grok". */
  executable?: string;
  model?: string;
  /** Maps to --reasoning-effort / --effort. */
  effort?: string;
  permissionCallback?: PermissionCallback;
  events?: HostSessionEvents;
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Skip version gate (tests only). */
  skipVersionCheck?: boolean;
  clientName?: string;
  clientVersion?: string;
  /** When true, prompts are enabled without canary (tests only). */
  promptsEnabled?: boolean;
};

export type GrokAcpHandle = {
  session: AcpHostSession;
  child: ChildProcessWithoutNullStreams;
  executable: string;
  args: string[];
  env: Record<string, string>;
  close: () => Promise<void>;
};

/**
 * Resolve an executable path and refuse non-files / non-executables.
 */
export function resolveGrokExecutable(executable = "grok"): string {
  if (isAbsolute(executable) || executable.includes("/")) {
    const abs = resolvePath(executable);
    try {
      accessSync(abs, fsConstants.X_OK);
    } catch {
      throw new AcpHostError("executable_missing", `not executable: ${abs}`);
    }
    return abs;
  }
  // Bare name — leave to PATH at spawn; version check uses same name.
  return executable;
}

/**
 * Parse `grok --version` stdout. Measured target is exactly 0.2.117.
 */
export function parseGrokVersionOutput(stdout: string): string | null {
  const m = stdout.match(/\bgrok\s+(\d+\.\d+\.\d+)\b/i);
  return m?.[1] ?? null;
}

/**
 * Run `executable --version` and refuse anything other than the measured version.
 */
export async function assertGrokMeasuredVersion(
  executable: string,
  expected = GROK_MEASURED_VERSION,
  timeoutMs = ACP_VERSION_CHECK_TIMEOUT_MS,
): Promise<string> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      ["--version"],
      { timeout: timeoutMs, encoding: "utf8", env: sanitizeChildEnv(process.env) },
      (err, out, stderr) => {
        if (err) {
          reject(
            new AcpVersionError(
              `failed to run ${executable} --version: ${err.message}${stderr ? ` (${stderr.trim()})` : ""}`,
            ),
          );
          return;
        }
        resolve(out);
      },
    );
  });
  const version = parseGrokVersionOutput(stdout);
  if (!version) {
    throw new AcpVersionError(
      `could not parse grok version from: ${stdout.trim().slice(0, 200)}`,
    );
  }
  if (version !== expected) {
    throw new AcpVersionError(
      `refusing grok ${version}; host core is measured for ${expected} only`,
    );
  }
  return version;
}

/**
 * Build argv for the Grok ACP stdio agent. Never includes --always-approve.
 */
export function buildGrokAcpArgs(options: {
  model?: string;
  effort?: string;
}): string[] {
  const args = ["agent", "--no-leader"];
  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.effort) {
    args.push("--reasoning-effort", options.effort);
  }
  args.push("stdio");
  if (args.includes("--always-approve")) {
    // Belt and braces — must be unreachable.
    throw new AcpHostError("always_approve_forbidden", "refusing to pass --always-approve");
  }
  return args;
}

/** Sanitized Grok env plus host-owned constant safety overrides. */
export function buildGrokChildEnv(
  parent: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  return {
    ...sanitizeChildEnv(parent),
    GROK_DISABLE_AUTOUPDATER: "1",
  };
}

/**
 * Open a Grok ACP host session: version-check, spawn, initialize, session/new.
 * Real prompts remain blocked until session.enablePromptsAfterCanary().
 */
export async function openGrokAcpSession(
  options: GrokAcpOpenOptions,
): Promise<GrokAcpHandle> {
  const executable = resolveGrokExecutable(options.executable ?? "grok");
  if (!options.skipVersionCheck) {
    await assertGrokMeasuredVersion(executable);
  }
  const args = buildGrokAcpArgs({
    model: options.model,
    effort: options.effort,
  });
  const env = buildGrokChildEnv(options.env ?? process.env);
  const child = spawn(executable, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    cwd: options.cwd,
  }) as ChildProcessWithoutNullStreams;

  if (!child.stdin || !child.stdout) {
    child.kill("SIGKILL");
    throw new AcpHostError("spawn_failed", "child missing stdio pipes");
  }
  // Provider stderr is deliberately not logged: it may contain prompt text or
  // local paths. Drain it so a noisy child cannot deadlock on a full pipe.
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
    const session = await AcpHostSession.connect({
      transport,
      cwd: options.cwd,
      permissionCallback: options.permissionCallback,
      events: options.events,
      requestTimeoutMs: options.requestTimeoutMs,
      clientName: options.clientName,
      clientVersion: options.clientVersion,
      promptsEnabled: options.promptsEnabled,
    });
    sessionRef = session;

    const close = async () => {
      await session.close();
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    };

    return { session, child, executable, args, env, close };
  } catch (err) {
    transport.close();
    if (!child.killed) child.kill("SIGKILL");
    throw err;
  }
}

/**
 * Open a session over injected streams (pure tests / fake child).
 * Does not spawn or version-check.
 */
export async function openAcpSessionOverStdio(options: {
  cwd: string;
  readable: import("node:stream").Readable;
  writable: import("node:stream").Writable;
  permissionCallback?: PermissionCallback;
  events?: HostSessionEvents;
  requestTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  promptsEnabled?: boolean;
  onChildExit?: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
}): Promise<{ session: AcpHostSession; transport: AcpTransport }> {
  let sessionRef: AcpHostSession | null = null;
  const transport = createBoundTransport({
    readable: options.readable,
    writable: options.writable,
    requestTimeoutMs: options.requestTimeoutMs ?? ACP_DEFAULT_REQUEST_TIMEOUT_MS,
    getSession: () => sessionRef,
    onChildExit: options.onChildExit,
  });
  const session = await AcpHostSession.connect({
    transport,
    cwd: options.cwd,
    permissionCallback: options.permissionCallback,
    events: options.events,
    requestTimeoutMs: options.requestTimeoutMs,
    clientName: options.clientName,
    clientVersion: options.clientVersion,
    promptsEnabled: options.promptsEnabled,
  });
  sessionRef = session;
  return { session, transport };
}

export { GROK_MEASURED_VERSION };
