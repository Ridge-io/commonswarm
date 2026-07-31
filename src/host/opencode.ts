/**
 * OpenCode ACP subprocess core — measured against opencode 1.18.10.
 *
 * Spawn shape: `opencode acp --pure`
 * Never passes provider credentials on argv/env. Auth is file-based under a
 * private 0700 home (auth-only copy + generated ask/deny config). Real prompts
 * stay blocked until the shared ACP permission-boundary canary passes.
 */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  ACP_DEFAULT_REQUEST_TIMEOUT_MS,
  ACP_VERSION_CHECK_TIMEOUT_MS,
  OPENCODE_FORCED_PERMISSION_TOOLS,
  OPENCODE_MEASURED_VERSION,
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

export type OpenCodeAcpOpenOptions = {
  cwd: string;
  /** Absolute path or bare name resolved via PATH. Default: "opencode". */
  executable?: string;
  model?: string;
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
  /**
   * Private absolute home already prepared with auth + safe config.
   * When omitted, open builds a temporary auth-only home and removes it on close
   * only if this open path created it (listener owns long-lived homes).
   */
  isolatedHome?: string;
  /** When true, remove isolatedHome on close (single-shot cross-owner open). */
  disposeHomeOnClose?: boolean;
};

export type OpenCodeAcpHandle = {
  session: AcpHostSession;
  child: ChildProcessWithoutNullStreams;
  executable: string;
  args: string[];
  env: Record<string, string>;
  home: string;
  close: () => Promise<void>;
};

const MAX_OPENCODE_AUTH_BYTES = 256 * 1024;

/** Resolve an executable path and refuse non-files / non-executables. */
export function resolveOpenCodeExecutable(executable = "opencode"): string {
  if (isAbsolute(executable) || executable.includes("/")) {
    const abs = resolvePath(executable);
    try {
      accessSync(abs, fsConstants.X_OK);
    } catch {
      throw new AcpHostError("executable_missing", `not executable: ${abs}`);
    }
    return abs;
  }
  return executable;
}

/** Parse `opencode --version` stdout. Measured target is exactly 1.18.10. */
export function parseOpenCodeVersionOutput(stdout: string): string | null {
  const m = stdout.match(/\b(\d+\.\d+\.\d+)\b/);
  return m?.[1] ?? null;
}

/** Run `executable --version` and refuse anything other than the measured version. */
export async function assertOpenCodeMeasuredVersion(
  executable: string,
  expected = OPENCODE_MEASURED_VERSION,
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
  const version = parseOpenCodeVersionOutput(stdout);
  if (!version) {
    throw new AcpVersionError(
      `could not parse opencode version from: ${stdout.trim().slice(0, 200)}`,
    );
  }
  if (version !== expected) {
    throw new AcpVersionError(
      `refusing opencode ${version}; host core is measured for ${expected} only`,
    );
  }
  return version;
}

/**
 * Build argv for the OpenCode ACP stdio agent.
 * Only `acp --pure` — no model flag on 1.18.10 acp surface; model stays config-side.
 */
export function buildOpenCodeAcpArgs(): string[] {
  return ["acp", "--pure"];
}

/** Safe permission map: every known 1.18.10 tool + wildcard must ask (ACP deny path). */
export function buildOpenCodeForcedPermissionConfig(): Record<string, "ask"> {
  const permission: Record<string, "ask"> = {};
  for (const tool of OPENCODE_FORCED_PERMISSION_TOOLS) {
    permission[tool] = "ask";
  }
  return permission;
}

/** Generated opencode.json that ambient project allow cannot soften. */
export function buildOpenCodeSafeConfigJson(options?: {
  model?: string;
}): string {
  const body: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    permission: buildOpenCodeForcedPermissionConfig(),
  };
  if (options?.model) {
    body.model = options.model;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Validate OpenCode auth.json: owned, 0600, regular file, bounded, valid JSON.
 * Returns the raw bytes when present; throws structured AcpHostError otherwise.
 */
export async function readValidatedOpenCodeAuth(
  sourceAuthPath: string,
  options?: { allowMissing?: boolean },
): Promise<Buffer | null> {
  let info: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    info = await lstat(sourceAuthPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (options?.allowMissing) return null;
      throw new AcpHostError(
        "opencode_auth_missing",
        "OpenCode is not signed in; run opencode auth before starting the listener",
      );
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new AcpHostError(
      "opencode_auth_insecure",
      "OpenCode auth must be a secure regular file",
    );
  }
  if (
    typeof process.getuid === "function" &&
    (Number(info.uid) !== process.getuid() ||
      (Number(info.mode) & 0o777) !== 0o600)
  ) {
    throw new AcpHostError(
      "opencode_auth_insecure",
      "OpenCode auth must be owned by this user with mode 0600",
    );
  }
  if (Number(info.size) > MAX_OPENCODE_AUTH_BYTES) {
    throw new AcpHostError(
      "opencode_auth_too_large",
      "OpenCode auth file exceeds the listener safety bound",
    );
  }
  const raw = await readFile(sourceAuthPath);
  if (raw.byteLength > MAX_OPENCODE_AUTH_BYTES) {
    throw new AcpHostError(
      "opencode_auth_too_large",
      "OpenCode auth file exceeds the listener safety bound",
    );
  }
  try {
    JSON.parse(raw.toString("utf8"));
  } catch {
    throw new AcpHostError(
      "opencode_auth_malformed",
      "OpenCode auth file is malformed; run opencode auth again",
    );
  }
  return raw;
}

/** Resolve the host's real OpenCode auth path (XDG data or legacy). */
export function resolveOpenCodeAuthSourcePath(
  parent: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const xdgData = parent.XDG_DATA_HOME;
  if (typeof xdgData === "string" && isAbsolute(xdgData)) {
    return join(xdgData, "opencode", "auth.json");
  }
  const home = parent.HOME ?? homedir();
  return join(home, ".local", "share", "opencode", "auth.json");
}

/**
 * Prepare a private 0700 home: auth-only copy under XDG data + forced-ask config.
 * Does not copy project rules, MCPs, sessions, or user allow lists.
 */
export async function prepareOpenCodeIsolatedHome(options: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  model?: string;
  /** When set, write into this absolute empty directory instead of mkdtemp. */
  home?: string;
  /** Tests may skip missing auth when a fake open path is used. */
  allowMissingAuth?: boolean;
}): Promise<string> {
  const home = options.home ??
    await mkdtemp(join(tmpdir(), "cswarm-opencode-home-"));
  if (!isAbsolute(home)) {
    throw new AcpHostError(
      "isolated_home_invalid",
      "isolated OpenCode home must be absolute",
    );
  }
  await chmod(home, 0o700);
  try {
    const xdgConfig = join(home, "xdg-config");
    const xdgData = join(home, "xdg-data");
    const xdgCache = join(home, "xdg-cache");
    const xdgState = join(home, "xdg-state");
    for (const dir of [xdgConfig, xdgData, xdgCache, xdgState]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
    }
    const configDir = join(xdgConfig, "opencode");
    const dataDir = join(xdgData, "opencode");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await chmod(configDir, 0o700);
    await chmod(dataDir, 0o700);

    const configPath = join(configDir, "opencode.json");
    await writeFile(
      configPath,
      buildOpenCodeSafeConfigJson(
        options.model ? { model: options.model } : undefined,
      ),
      { flag: "wx", mode: 0o600 },
    );
    await chmod(configPath, 0o600);

    const sourceAuth = resolveOpenCodeAuthSourcePath(options.env ?? process.env);
    const authBytes = await readValidatedOpenCodeAuth(sourceAuth, {
      allowMissing: options.allowMissingAuth === true,
    });
    if (authBytes) {
      const destAuth = join(dataDir, "auth.json");
      await writeFile(destAuth, authBytes, { flag: "wx", mode: 0o600 });
      await chmod(destAuth, 0o600);
    }
    return home;
  } catch (error) {
    if (!options.home) {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

/** Sanitized child env pointing only at the private home XDG layout. */
export function buildOpenCodeChildEnv(
  parent: NodeJS.ProcessEnv | Record<string, string | undefined>,
  home: string,
): Record<string, string> {
  if (!isAbsolute(home)) {
    throw new AcpHostError(
      "isolated_home_invalid",
      "isolated OpenCode home must be absolute",
    );
  }
  return {
    ...sanitizeChildEnv(parent),
    HOME: home,
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_DATA_HOME: join(home, "xdg-data"),
    XDG_CACHE_HOME: join(home, "xdg-cache"),
    XDG_STATE_HOME: join(home, "xdg-state"),
  };
}

/**
 * Open an OpenCode ACP host session: version-check, prepare home if needed,
 * spawn `acp --pure`, initialize, session/new. Real prompts stay blocked until
 * session.enablePromptsAfterCanary().
 */
export async function openOpenCodeAcpSession(
  options: OpenCodeAcpOpenOptions,
): Promise<OpenCodeAcpHandle> {
  const executable = resolveOpenCodeExecutable(options.executable ?? "opencode");
  if (!options.skipVersionCheck) {
    await assertOpenCodeMeasuredVersion(executable);
  }
  const args = buildOpenCodeAcpArgs();
  let home = options.isolatedHome;
  let createdHome = false;
  if (!home) {
    home = await prepareOpenCodeIsolatedHome({
      env: options.env ?? process.env,
      ...(options.model ? { model: options.model } : {}),
    });
    createdHome = true;
  }
  const env = buildOpenCodeChildEnv(options.env ?? process.env, home);
  const child = spawn(executable, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    cwd: options.cwd,
  }) as ChildProcessWithoutNullStreams;

  if (!child.stdin || !child.stdout) {
    child.kill("SIGKILL");
    if (createdHome || options.disposeHomeOnClose) {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new AcpHostError("spawn_failed", "child missing stdio pipes");
  }
  // Provider stderr may contain prompt text — drain, never log.
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
      if (createdHome || options.disposeHomeOnClose === true) {
        await rm(home!, { recursive: true, force: true }).catch(() => undefined);
      }
    };

    return { session, child, executable, args, env, home, close };
  } catch (err) {
    transport.close();
    if (!child.killed) child.kill("SIGKILL");
    if (createdHome || options.disposeHomeOnClose === true) {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }
}

export { OPENCODE_MEASURED_VERSION, OPENCODE_FORCED_PERMISSION_TOOLS };
