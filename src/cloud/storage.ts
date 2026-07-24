import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { CloudTarget } from "./config.js";

const KEYCHAIN_SERVICE = "io.ridge.coswarm";
const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 30_000;
const MAX_KEYCHAIN_RECORD_BYTES = 126;
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_PENDING_COMMANDS = 32;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,72}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FALLBACK_WARNING =
  "⚠ no OS keychain found. Storing the rotating refresh credential in a 0600 file under a 0700 directory. This is less protected than a keychain.";

export interface CredentialRecord {
  version: 1;
  refreshToken: string;
  generation: number;
  deviceId: string;
  userId: string;
}

export interface PendingCommandRecord {
  commandId: string;
  kind: string;
  createdAt: number;
}

export interface CredentialProfile {
  version: 1;
  userId: string | null;
  workspaceId: string | null;
  email?: string | null;
  principalId?: string | null;
  principalName?: string | null;
  pendingCommands: Record<string, PendingCommandRecord>;
}

export interface CredentialStore {
  readonly kind: "keychain" | "file";
  readonly location: string;
  read(): Promise<CredentialRecord | null>;
  write(record: CredentialRecord): Promise<void>;
  delete(): Promise<void>;
  readProfile(): Promise<CredentialProfile>;
  writeProfile(profile: CredentialProfile): Promise<void>;
  withLock<T>(work: () => Promise<T>): Promise<T>;
}

export interface CredentialStoreOptions {
  target: CloudTarget;
  stateDirectory?: string;
  forceFile?: boolean;
  allowFileFallback?: boolean;
  platform?: NodeJS.Platform;
  warn?: (message: string) => void;
  securityPath?: string;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function defaultStateDirectory(): string {
  return join(homedir(), ".coswarm", "credentials.d");
}

function mode(statMode: number): number {
  return statMode & 0o777;
}

function assertOwnedByCurrentUser(uid: number): void {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new Error("credential path is not owned by the current user");
  }
}

async function secureDirectory(path: string): Promise<void> {
  let created = false;
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`credential directory is not a real directory: ${path}`);
    }
    assertOwnedByCurrentUser(info.uid);
    if (mode(info.mode) !== 0o700) {
      throw new Error(
        `credential directory must be mode 0700 (found ${mode(info.mode).toString(8)}): ${path}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    created = true;
  }
  if (created) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`credential directory is not a real directory: ${path}`);
    }
    assertOwnedByCurrentUser(info.uid);
    if (mode(info.mode) !== 0o700) {
      throw new Error(`credential directory could not be secured to mode 0700: ${path}`);
    }
  }
}

async function secureCredentialFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`credential file is not a regular file: ${path}`);
  }
  assertOwnedByCurrentUser(info.uid);
  if (mode(info.mode) !== 0o600) {
    throw new Error(
      `credential file must be mode 0600 (found ${mode(info.mode).toString(8)}): ${path}`,
    );
  }
}

function parseRecord(raw: string): CredentialRecord {
  let value: Partial<CredentialRecord>;
  try {
    if (raw.startsWith("{")) {
      value = JSON.parse(raw) as Partial<CredentialRecord>;
    } else {
      const [version, refreshToken, generation, deviceId, userId, ...extra] =
        raw.split("|");
      if (extra.length > 0) throw new Error("extra compact credential fields");
      value = {
        version: Number(version) as 1,
        refreshToken,
        generation: Number(generation),
        deviceId,
        userId,
      };
    }
  } catch {
    throw new Error("stored credential record is malformed");
  }
  if (
    value.version !== 1 ||
    typeof value.refreshToken !== "string" ||
    value.refreshToken.length < 8 ||
    value.refreshToken.length > 2_048 ||
    /[|\u0000-\u001f\u007f]/.test(value.refreshToken) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation ?? -1) < 0 ||
    typeof value.deviceId !== "string" ||
    !UUID_RE.test(value.deviceId) ||
    typeof value.userId !== "string" ||
    !UUID_RE.test(value.userId)
  ) {
    throw new Error("stored credential record is malformed");
  }
  return value as CredentialRecord;
}

function keychainRecord(record: CredentialRecord): string {
  const validated = parseRecord(JSON.stringify(record));
  const compact = [
    validated.version,
    validated.refreshToken,
    validated.generation,
    validated.deviceId,
    validated.userId,
  ].join("|");
  if (Buffer.byteLength(compact, "utf8") > MAX_KEYCHAIN_RECORD_BYTES) {
    throw new Error(
      "refresh credential is too large for secure macOS Keychain CLI input",
    );
  }
  return compact;
}

function emptyProfile(): CredentialProfile {
  return {
    version: 1,
    userId: null,
    workspaceId: null,
    email: null,
    principalId: null,
    principalName: null,
    pendingCommands: {},
  };
}

function parseProfile(raw: string): CredentialProfile {
  let value: Partial<CredentialProfile>;
  try {
    value = JSON.parse(raw) as Partial<CredentialProfile>;
  } catch {
    throw new Error("stored credential profile is malformed");
  }
  const pending = value.pendingCommands;
  if (
    value.version !== 1 ||
    !(
      value.userId === null ||
      (typeof value.userId === "string" && UUID_RE.test(value.userId))
    ) ||
    !(
      value.workspaceId === null ||
      (typeof value.workspaceId === "string" && UUID_RE.test(value.workspaceId))
    ) ||
    !(
      value.email === undefined ||
      value.email === null ||
      (
        typeof value.email === "string" &&
        value.email.length >= 3 &&
        value.email.length <= 320 &&
        !/[\u0000-\u001f\u007f-\u009f]/.test(value.email)
      )
    ) ||
    !(
      value.principalId === undefined ||
      value.principalId === null ||
      (typeof value.principalId === "string" && UUID_RE.test(value.principalId))
    ) ||
    !(
      value.principalName === undefined ||
      value.principalName === null ||
      (
        typeof value.principalName === "string" &&
        value.principalName.length >= 1 &&
        value.principalName.length <= 80 &&
        /^[a-z0-9._@-]+$/.test(value.principalName)
      )
    ) ||
    !pending ||
    typeof pending !== "object" ||
    Array.isArray(pending) ||
    Object.keys(pending).length > MAX_PENDING_COMMANDS
  ) {
    throw new Error("stored credential profile is malformed");
  }
  for (const [intentHash, record] of Object.entries(pending)) {
    if (
      !SHA256_RE.test(intentHash) ||
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      typeof record.commandId !== "string" ||
      !COMMAND_ID_RE.test(record.commandId) ||
      typeof record.kind !== "string" ||
      record.kind.length < 1 ||
      record.kind.length > 64 ||
      !Number.isSafeInteger(record.createdAt) ||
      record.createdAt < 0
    ) {
      throw new Error("stored credential profile is malformed");
    }
  }
  return value as CredentialProfile;
}

async function run(
  executable: string,
  args: string[],
  input?: string,
  detached = false,
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      detached,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(`${input}\n`);
    else child.stdin.end();
  });
}

async function securityAvailable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

abstract class LockedCredentialStore implements CredentialStore {
  abstract readonly kind: "keychain" | "file";
  abstract readonly location: string;
  abstract read(): Promise<CredentialRecord | null>;
  abstract write(record: CredentialRecord): Promise<void>;
  abstract delete(): Promise<void>;
  private readonly profilePath: string;

  constructor(
    protected readonly stateDirectory: string,
    private readonly lockName: string,
  ) {
    this.profilePath = join(stateDirectory, `${lockName}.profile.json`);
  }

  async readProfile(): Promise<CredentialProfile> {
    await secureDirectory(this.stateDirectory);
    try {
      await secureCredentialFile(this.profilePath);
      const raw = await readFile(this.profilePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_PROFILE_BYTES) {
        throw new Error("stored credential profile is malformed");
      }
      return parseProfile(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyProfile();
      }
      throw error;
    }
  }

  async writeProfile(profile: CredentialProfile): Promise<void> {
    await secureDirectory(this.stateDirectory);
    const serialized = JSON.stringify(parseProfile(JSON.stringify(profile)));
    if (Buffer.byteLength(serialized, "utf8") > MAX_PROFILE_BYTES) {
      throw new Error("stored credential profile is too large");
    }
    try {
      await secureCredentialFile(this.profilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary =
      `${this.profilePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, this.profilePath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await chmod(this.profilePath, 0o600);
    await secureCredentialFile(this.profilePath);
  }

  async withLock<T>(work: () => Promise<T>): Promise<T> {
    await secureDirectory(this.stateDirectory);
    const lockPath = join(this.stateDirectory, `${this.lockName}.lock`);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let handle: Awaited<ReturnType<typeof open>> | null = null;

    while (handle === null) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
          "utf8",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lockInfo = await stat(lockPath).catch(() => null);
        if (lockInfo && Date.now() - lockInfo.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error("timed out waiting for the credential refresh lock");
        }
        await delay(25 + randomBytes(1)[0]! % 75);
      }
    }

    try {
      return await work();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

class MacKeychainStore extends LockedCredentialStore {
  readonly kind = "keychain" as const;
  readonly location = "macOS Keychain";
  private readonly account: string;

  constructor(
    stateDirectory: string,
    profileId: string,
    private readonly securityPath: string,
  ) {
    super(stateDirectory, profileId);
    this.account = `refresh:${profileId}`;
  }

  async read(): Promise<CredentialRecord | null> {
    const result = await run(this.securityPath, [
      "find-generic-password",
      "-a",
      this.account,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
    if (result.code === 44) return null;
    if (result.code !== 0) {
      throw new Error("unable to read the refresh credential from macOS Keychain");
    }
    return parseRecord(result.stdout.trimEnd());
  }

  async write(record: CredentialRecord): Promise<void> {
    const serialized = keychainRecord(record);
    const result = await run(
      this.securityPath,
      [
        "add-generic-password",
        "-U",
        "-a",
        this.account,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ],
      // macOS `security -w` prompts twice. A detached child has no controlling
      // TTY, so both prompts consume this pipe instead of exposing or blocking
      // on an interactive refresh-token prompt.
      `${serialized}\n${serialized}`,
      true,
    );
    if (result.code !== 0) {
      throw new Error("unable to write the refresh credential to macOS Keychain");
    }
  }

  async delete(): Promise<void> {
    const result = await run(this.securityPath, [
      "delete-generic-password",
      "-a",
      this.account,
      "-s",
      KEYCHAIN_SERVICE,
    ]);
    if (result.code !== 0 && result.code !== 44) {
      throw new Error("unable to delete the refresh credential from macOS Keychain");
    }
  }
}

class SecureFileStore extends LockedCredentialStore {
  readonly kind = "file" as const;
  readonly location: string;

  constructor(
    stateDirectory: string,
    profileId: string,
    private readonly warn: (message: string) => void,
  ) {
    super(stateDirectory, profileId);
    this.location = join(stateDirectory, `${profileId}.json`);
  }

  private warning(): void {
    this.warn(`${FALLBACK_WARNING} Path: ${this.location}`);
  }

  async read(): Promise<CredentialRecord | null> {
    this.warning();
    await secureDirectory(dirname(this.location));
    try {
      await secureCredentialFile(this.location);
      return parseRecord(await readFile(this.location, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(record: CredentialRecord): Promise<void> {
    this.warning();
    await secureDirectory(dirname(this.location));
    try {
      await secureCredentialFile(this.location);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${this.location}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, this.location);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await chmod(this.location, 0o600);
    await secureCredentialFile(this.location);
  }

  async delete(): Promise<void> {
    this.warning();
    await secureDirectory(dirname(this.location));
    try {
      await secureCredentialFile(this.location);
      await unlink(this.location);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function credentialStore(
  options: CredentialStoreOptions,
): Promise<CredentialStore> {
  const stateDirectory = options.stateDirectory ?? defaultStateDirectory();
  const platform = options.platform ?? process.platform;
  const securityPath = options.securityPath ?? "/usr/bin/security";
  const warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));

  if (
    !options.forceFile &&
    platform === "darwin" &&
    await securityAvailable(securityPath)
  ) {
    return new MacKeychainStore(
      stateDirectory,
      options.target.profileId,
      securityPath,
    );
  }

  const allowed = options.allowFileFallback ??
    process.env.SWARM_ALLOW_INSECURE_STORE !== "0";
  if (!allowed) {
    throw new Error(
      "no OS keychain is available and the secure-file fallback is disabled",
    );
  }
  if (platform === "win32") {
    throw new Error(
      "no supported OS keychain is available and file permissions cannot be verified on this platform",
    );
  }
  return new SecureFileStore(stateDirectory, options.target.profileId, warn);
}
