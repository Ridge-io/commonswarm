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

const KEYCHAIN_SERVICE = "io.ridge.swarm.cloud";
const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 30_000;
const FALLBACK_WARNING =
  "⚠ no OS keychain found. Storing the rotating refresh credential in a 0600 file under a 0700 directory. This is less protected than a keychain.";

export interface CredentialRecord {
  version: 1;
  refreshToken: string;
  generation: number;
  deviceId: string;
  userId: string;
}

export interface CredentialStore {
  readonly kind: "keychain" | "file";
  readonly location: string;
  read(): Promise<CredentialRecord | null>;
  write(record: CredentialRecord): Promise<void>;
  delete(): Promise<void>;
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
  return join(homedir(), ".swarm", "credentials.d");
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
  const value = JSON.parse(raw) as Partial<CredentialRecord>;
  if (
    value.version !== 1 ||
    typeof value.refreshToken !== "string" ||
    value.refreshToken.length < 16 ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation ?? -1) < 0 ||
    typeof value.deviceId !== "string" ||
    typeof value.userId !== "string"
  ) {
    throw new Error("stored credential record is malformed");
  }
  return value as CredentialRecord;
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

  constructor(
    protected readonly stateDirectory: string,
    private readonly lockName: string,
  ) {}

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
    const serialized = JSON.stringify(record);
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
