/**
 * OpenCode ACP subprocess core — measured against opencode 1.18.10.
 *
 * Spawn shape: `opencode acp --pure`
 * Project config merge is defeated only by OPENCODE_DISABLE_PROJECT_CONFIG=1
 * (measured via `debug config --pure`), not by a private HOME alone.
 * Auth is file-based under a private 0700 home (auth-only copy + generated
 * forced-ask config). Worker prompts stay blocked until the shared ACP canary;
 * hard-denied isolated prompts use the measured exact effective-config gate.
 */

import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
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

/** Ownership marker written into every managed OpenCode home. */
export const OPENCODE_HOME_OWNER_FILE = ".cswarm-opencode-owner.json";

export type OpenCodeHomeOwner = {
  version: 1;
  pid: number;
  uid: number;
  instanceId: string;
  role: "worker" | "isolated" | "ephemeral";
  createdAt: string;
};

export type OpenCodeAcpOpenOptions = {
  cwd: string;
  /** Absolute realpath to opencode. Bare names are resolved once at open. */
  executable?: string;
  model?: string;
  permissionCallback?: PermissionCallback;
  events?: HostSessionEvents;
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Skip version gate (tests only). */
  skipVersionCheck?: boolean;
  /** Skip effective-config project-disable probe (tests only). */
  skipConfigProbe?: boolean;
  clientName?: string;
  clientVersion?: string;
  /** When true, prompts are enabled without canary (tests only). */
  promptsEnabled?: boolean;
  /**
   * Hard-deny every tool through OpenCode's measured env permission surface.
   * The exact effective-config probe replaces the incompatible dynamic canary:
   * OpenCode removes hard-denied tools before the model can request one.
   */
  denyTools?: boolean;
  /**
   * Private absolute home already prepared with auth + safe config.
   * When omitted, open builds a temporary auth-only home and removes it on close
   * when this open path created it or disposeHomeOnClose is set.
   */
  isolatedHome?: string;
  /** When true, remove isolatedHome on close (single-shot cross-owner open). */
  disposeHomeOnClose?: boolean;
  /**
   * Explicit test-only: allow missing OpenCode auth when preparing homes.
   * Production paths must leave this unset/false.
   */
  allowMissingAuth?: boolean;
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
export const OPENCODE_HOME_PREFIX = "cswarm-opencode-home-";
const CHILD_EXIT_WAIT_MS = 3_000;
const CHILD_KILL_WAIT_MS = 1_000;
/** Orphans without a live owner may be swept after this age. */
const STALE_HOME_MAX_AGE_MS = 60 * 60 * 1000;

/** True when signal 0 reaches pid (process exists and is killable by us). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolve bare or relative executable to one absolute realpath (same for probe + spawn). */
export function resolveOpenCodeExecutable(
  executable = "opencode",
  pathEnv?: string,
): string {
  if (isAbsolute(executable) || executable.includes("/")) {
    const abs = resolvePath(executable);
    try {
      accessSync(abs, fsConstants.X_OK);
    } catch {
      throw new AcpHostError("executable_missing", `not executable: ${abs}`);
    }
    try {
      return realpathSync(abs);
    } catch {
      throw new AcpHostError(
        "executable_missing",
        `could not realpath opencode executable: ${abs}`,
      );
    }
  }
  const pathValue = pathEnv ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, executable);
    try {
      accessSync(candidate, fsConstants.X_OK);
      try {
        return realpathSync(candidate);
      } catch {
        throw new AcpHostError(
          "executable_missing",
          `could not realpath opencode executable: ${candidate}`,
        );
      }
    } catch (err) {
      if (err instanceof AcpHostError) throw err;
      // try next PATH entry
    }
  }
  throw new AcpHostError(
    "executable_missing",
    `opencode executable not found on PATH: ${executable}`,
  );
}

export function buildOpenCodeHomeOwner(options: {
  role: OpenCodeHomeOwner["role"];
  instanceId?: string;
  pid?: number;
  now?: () => number;
}): OpenCodeHomeOwner {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return {
    version: 1,
    pid: options.pid ?? process.pid,
    uid,
    instanceId: options.instanceId ?? randomUUID(),
    role: options.role,
    createdAt: new Date((options.now ?? Date.now)()).toISOString(),
  };
}

export async function writeOpenCodeHomeOwner(
  home: string,
  owner: OpenCodeHomeOwner,
): Promise<void> {
  const path = join(home, OPENCODE_HOME_OWNER_FILE);
  await writeFile(path, `${JSON.stringify(owner)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

export async function readOpenCodeHomeOwner(
  home: string,
): Promise<OpenCodeHomeOwner | null> {
  const path = join(home, OPENCODE_HOME_OWNER_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<OpenCodeHomeOwner>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      !Number.isSafeInteger(value.uid) ||
      typeof value.instanceId !== "string" ||
      !value.instanceId ||
      (value.role !== "worker" &&
        value.role !== "isolated" &&
        value.role !== "ephemeral") ||
      typeof value.createdAt !== "string"
    ) {
      return null;
    }
    return value as OpenCodeHomeOwner;
  } catch {
    return null;
  }
}

/**
 * Delete a home only when this process still owns it (matching instanceId)
 * or the marker is absent for a home we just created and still hold.
 */
export async function releaseOpenCodeHome(
  home: string,
  instanceId: string,
): Promise<void> {
  if (!isAbsolute(home)) return;
  const owner = await readOpenCodeHomeOwner(home);
  if (owner && owner.instanceId !== instanceId) {
    // Another process's home — never touch.
    return;
  }
  try {
    await rm(home, { recursive: true, force: true });
  } catch {
    await chmod(home, 0o700);
    await rm(home, { recursive: true, force: true });
  }
}

/** Parse `opencode --version` stdout. Measured target is exactly 1.18.10. */
export function parseOpenCodeVersionOutput(stdout: string): string | null {
  const m = stdout.match(/\b(\d+\.\d+\.\d+)\b/);
  return m?.[1] ?? null;
}

/** Run absolute executable --version with the same env the child will use. */
export async function assertOpenCodeMeasuredVersion(
  executable: string,
  options?: {
    expected?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  },
): Promise<string> {
  const expected = options?.expected ?? OPENCODE_MEASURED_VERSION;
  const timeoutMs = options?.timeoutMs ?? ACP_VERSION_CHECK_TIMEOUT_MS;
  const env = sanitizeChildEnv(options?.env ?? process.env);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      ["--version"],
      { timeout: timeoutMs, encoding: "utf8", env },
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

/** Generated opencode.json (global config under private XDG). */
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
 * ★ Private home alone does not disable project config merge — callers must set
 * OPENCODE_DISABLE_PROJECT_CONFIG and verify via assertOpenCodeEffectiveConfig.
 */
export async function prepareOpenCodeIsolatedHome(options: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  model?: string;
  home?: string;
  /** Explicit test-only; production must not set this. */
  allowMissingAuth?: boolean;
  /** Ownership/liveness metadata so sweep never kills a live listener home. */
  owner?: OpenCodeHomeOwner;
}): Promise<string> {
  const home = options.home ??
    await mkdtemp(join(tmpdir(), OPENCODE_HOME_PREFIX));
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
    const owner = options.owner ??
      buildOpenCodeHomeOwner({ role: "ephemeral" });
    await writeOpenCodeHomeOwner(home, owner);
    return home;
  } catch (error) {
    if (!options.home) {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Sanitized child env for OpenCode. Forces OPENCODE_DISABLE_PROJECT_CONFIG=1
 * after the allowlist so parent cannot unset it via a non-allowlisted path.
 */
export function buildOpenCodeChildEnv(
  parent: NodeJS.ProcessEnv | Record<string, string | undefined>,
  home: string,
  options?: { denyTools?: boolean },
): Record<string, string> {
  if (!isAbsolute(home)) {
    throw new AcpHostError(
      "isolated_home_invalid",
      "isolated OpenCode home must be absolute",
    );
  }
  const base = sanitizeChildEnv(parent);
  return {
    ...base,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_DATA_HOME: join(home, "xdg-data"),
    XDG_CACHE_HOME: join(home, "xdg-cache"),
    XDG_STATE_HOME: join(home, "xdg-state"),
    // Measured 1.18.10: private home alone still merges project opencode.json.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    ...(options?.denyTools === true
      ? { OPENCODE_PERMISSION: '{"*":"deny"}' }
      : {}),
  };
}

/**
 * Positive control: with a hostile project allow-all opencode.json as cwd,
 * effective `debug config --pure` must still show our forced-ask permissions.
 */
export async function assertOpenCodeEffectiveConfig(options: {
  executable: string;
  env: NodeJS.ProcessEnv | Record<string, string>;
  timeoutMs?: number;
  denyTools?: boolean;
}): Promise<{ permission: Record<string, unknown> }> {
  const hostile = await mkdtemp(join(tmpdir(), "cswarm-opencode-hostile-"));
  try {
    await chmod(hostile, 0o700);
    await writeFile(
      join(hostile, "opencode.json"),
      `${JSON.stringify({
        permission: {
          bash: "allow",
          edit: "allow",
          write: "allow",
          "*": "allow",
        },
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        options.executable,
        ["debug", "config", "--pure"],
        {
          timeout: options.timeoutMs ?? ACP_VERSION_CHECK_TIMEOUT_MS,
          encoding: "utf8",
          env: options.env as NodeJS.ProcessEnv,
          cwd: hostile,
        },
        (err, out, stderr) => {
          if (err) {
            reject(
              new AcpHostError(
                "opencode_config_probe_failed",
                `debug config --pure failed: ${err.message}${stderr ? ` (${stderr.trim().slice(0, 200)})` : ""}`,
              ),
            );
            return;
          }
          resolve(out);
        },
      );
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new AcpHostError(
        "opencode_config_probe_failed",
        "debug config --pure returned non-JSON",
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AcpHostError(
        "opencode_config_probe_failed",
        "debug config --pure returned a non-object",
      );
    }
    const permission = (parsed as { permission?: unknown }).permission;
    if (!permission || typeof permission !== "object" || Array.isArray(permission)) {
      throw new AcpHostError(
        "opencode_config_probe_failed",
        "debug config --pure missing permission map",
      );
    }
    const map = permission as Record<string, unknown>;
    if (options.denyTools === true) {
      assertHardDenyPermissionMap(map);
    } else {
      assertForcedAskPermissionMap(map);
    }
    return { permission: map };
  } finally {
    await rm(hostile, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The measured hard-deny config must end in wildcard deny. */
export function assertHardDenyPermissionMap(map: Record<string, unknown>): void {
  const keys = Object.keys(map);
  for (const [tool, value] of Object.entries(map)) {
    if (value === "allow") {
      throw new AcpHostError(
        "opencode_project_config_active",
        `effective OpenCode hard-deny config contains per-tool allow for ${tool}`,
      );
    }
  }
  if (map["*"] !== "deny" || keys[keys.length - 1] !== "*") {
    throw new AcpHostError(
      "opencode_config_probe_failed",
      "effective OpenCode config is missing the final hard-deny wildcard",
    );
  }
}

/**
 * Every OPENCODE_FORCED_PERMISSION_TOOLS entry must resolve to ask:
 * explicit ask, or (non-wildcard only) missing with wildcard ask and no allow.
 */
export function assertForcedAskPermissionMap(
  map: Record<string, unknown>,
): void {
  for (const tool of OPENCODE_FORCED_PERMISSION_TOOLS) {
    const value = map[tool];
    if (value === "allow") {
      throw new AcpHostError(
        "opencode_project_config_active",
        `effective OpenCode config still allows tool ${tool}; OPENCODE_DISABLE_PROJECT_CONFIG failed`,
      );
    }
    if (tool === "*") {
      if (value !== "ask") {
        throw new AcpHostError(
          "opencode_config_probe_failed",
          "effective OpenCode config missing forced-ask wildcard",
        );
      }
      continue;
    }
    const star = map["*"];
    const effective = value === undefined || value === null ? star : value;
    if (effective !== "ask") {
      throw new AcpHostError(
        "opencode_config_probe_failed",
        `effective OpenCode config lacks forced-ask for tool ${tool}`,
      );
    }
  }
  // Critical tools called out by audit — must not be allow even if map is odd.
  for (const critical of ["bash", "write", "edit", "execute", "*"] as const) {
    const value = map[critical];
    const star = map["*"];
    const effective = critical === "*"
      ? value
      : (value === undefined || value === null ? star : value);
    if (effective !== "ask") {
      throw new AcpHostError(
        "opencode_config_probe_failed",
        `critical tool ${critical} is not forced-ask`,
      );
    }
  }
}

/**
 * Remove only provably dead OpenCode homes under tmpdir.
 * Never age-deletes a home whose owner PID is still alive.
 */
export async function sweepStaleOpenCodeHomes(options?: {
  maxAgeMs?: number;
  now?: number;
  /** Inject for tests: override process liveness. */
  isAlive?: (pid: number) => boolean;
  /** Inject for tests: scan root (default tmpdir). */
  root?: string;
}): Promise<number> {
  const maxAgeMs = options?.maxAgeMs ?? STALE_HOME_MAX_AGE_MS;
  const now = options?.now ?? Date.now();
  const alive = options?.isAlive ?? isProcessAlive;
  const root = options?.root ?? tmpdir();
  const selfUid = typeof process.getuid === "function" ? process.getuid() : null;
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith(OPENCODE_HOME_PREFIX)) continue;
    const full = join(root, name);
    try {
      const st = await lstat(full);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (
        selfUid !== null &&
        typeof st.uid === "number" &&
        st.uid !== selfUid
      ) {
        continue; // never touch another user's dir
      }
      if ((Number(st.mode) & 0o777) !== 0o700) {
        // Unexpected mode — leave alone rather than rm -rf.
        continue;
      }
      const owner = await readOpenCodeHomeOwner(full);
      if (owner) {
        if (selfUid !== null && owner.uid !== selfUid) continue;
        if (alive(owner.pid)) {
          // Healthy long-lived listener home — never age-delete.
          continue;
        }
        // Owner process is dead: safe to reclaim regardless of age.
        await rm(full, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      // No ownership marker: only reclaim after age (legacy/orphan).
      if (now - st.mtimeMs < maxAgeMs) continue;
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // best-effort
    }
  }
  return removed;
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * SIGTERM then SIGKILL; await exit within bounds.
 * Throws if the child still has not exited — callers must not treat that as
 * success or delete credential homes (retain/escalate).
 */
export async function terminateOpenCodeChild(
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
      "OpenCode child did not exit after SIGTERM and SIGKILL",
    );
  }
}

/**
 * Open an OpenCode ACP host session: resolve absolute executable, version-check
 * and effective-config probe with the same env, spawn `acp --pure`.
 */
export async function openOpenCodeAcpSession(
  options: OpenCodeAcpOpenOptions,
): Promise<OpenCodeAcpHandle> {
  await sweepStaleOpenCodeHomes().catch(() => 0);

  const pathEnv = (options.env ?? process.env).PATH;
  const executable = resolveOpenCodeExecutable(
    options.executable ?? "opencode",
    typeof pathEnv === "string" ? pathEnv : undefined,
  );

  let home = options.isolatedHome;
  let createdHome = false;
  if (!home) {
    home = await prepareOpenCodeIsolatedHome({
      env: options.env ?? process.env,
      ...(options.model ? { model: options.model } : {}),
      ...(options.allowMissingAuth === true ? { allowMissingAuth: true } : {}),
    });
    createdHome = true;
  }

  const env = buildOpenCodeChildEnv(
    options.env ?? process.env,
    home,
    { denyTools: options.denyTools === true },
  );
  let childStarted = false;
  const disposeHome = async () => {
    if (createdHome || options.disposeHomeOnClose === true) {
      try {
        await rm(home!, { recursive: true, force: true });
      } catch {
        await chmod(home!, 0o700);
        await rm(home!, { recursive: true, force: true });
      }
    }
  };

  try {
    if (!options.skipVersionCheck) {
      await assertOpenCodeMeasuredVersion(executable, {
        env,
      });
    }
    if (!options.skipConfigProbe) {
      await assertOpenCodeEffectiveConfig({
        executable,
        env,
        denyTools: options.denyTools === true,
      });
    }

    const args = buildOpenCodeAcpArgs();
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: options.cwd,
    }) as ChildProcessWithoutNullStreams;
    childStarted = true;

    if (!child.stdin || !child.stdout) {
      await terminateOpenCodeChild(child);
      await disposeHome();
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
        // A verified hard-deny removes every tool from the request, so the
        // dynamic tool canary cannot run. The exact effective-config probe
        // above is the positive control for this independently denied path.
        promptsEnabled: options.denyTools === true || options.promptsEnabled,
      });
      sessionRef = session;

      let closePromise: Promise<void> | null = null;
      const close = async () => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          try {
            await session.close();
          } finally {
            // Only dispose the credential home after a verified child exit.
            // A hung child after SIGKILL retains the home for escalation.
            await terminateOpenCodeChild(child);
            await disposeHome();
          }
        })();
        return closePromise;
      };

      return { session, child, executable, args, env, home, close };
    } catch (err) {
      transport.close();
      let termErr: unknown = null;
      try {
        await terminateOpenCodeChild(child);
      } catch (e) {
        termErr = e;
      }
      if (termErr) {
        throw termErr;
      }
      await disposeHome();
      throw err;
    }
  } catch (err) {
    // Probe/version failure before a child exists: safe to dispose.
    // After childStarted, only dispose on verified terminate (above).
    if (!childStarted) {
      await disposeHome();
    }
    throw err;
  }
}

export { OPENCODE_MEASURED_VERSION, OPENCODE_FORCED_PERMISSION_TOOLS };
