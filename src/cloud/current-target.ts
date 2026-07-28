import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  cloudTarget,
  type CloudTarget,
} from "./config.js";
import { defaultCredentialStateDirectory } from "./storage.js";

const CURRENT_TARGET_FILE = "current-target.json";
const MAX_CURRENT_TARGET_BYTES = 16 * 1024;

interface StoredCurrentTarget {
  version: 1;
  url: string;
  anonKey: string;
}

export interface CurrentTargetOptions {
  stateDirectory?: string;
}

export interface ResolveCloudTargetOptions extends CurrentTargetOptions {
  explicitUrl?: string;
  explicitAnonKey?: string;
  environmentalUrl?: string;
  environmentalAnonKey?: string;
  mode?: "human" | "agent";
}

function stateDirectory(options: CurrentTargetOptions): string {
  return options.stateDirectory ?? defaultCredentialStateDirectory();
}

export function currentTargetPath(options: CurrentTargetOptions = {}): string {
  return join(stateDirectory(options), CURRENT_TARGET_FILE);
}

function mode(statMode: number): number {
  return statMode & 0o777;
}

function assertOwnedByCurrentUser(uid: number): void {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new Error("current-target path is not owned by the current user");
  }
}

function assertDirectory(path: string, info: Stats): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`current-target directory is not a real directory: ${path}`);
  }
  assertOwnedByCurrentUser(info.uid);
  if (mode(info.mode) !== 0o700) {
    throw new Error(
      `current-target directory must be mode 0700 (found ${
        mode(info.mode).toString(8)
      }): ${path}`,
    );
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    assertDirectory(path, await lstat(path));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  assertDirectory(path, await lstat(path));
}

async function existingDirectory(path: string): Promise<boolean> {
  try {
    assertDirectory(path, await lstat(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertCurrentTargetFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`current-target file is not a regular file: ${path}`);
  }
  assertOwnedByCurrentUser(info.uid);
  if (mode(info.mode) !== 0o600) {
    throw new Error(
      `current-target file must be mode 0600 (found ${
        mode(info.mode).toString(8)
      }): ${path}`,
    );
  }
}

function parseStoredCurrentTarget(raw: string): CloudTarget {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("stored current target is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored current target is malformed");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "anonKey" ||
    keys[1] !== "url" ||
    keys[2] !== "version" ||
    record.version !== 1 ||
    typeof record.url !== "string" ||
    typeof record.anonKey !== "string"
  ) {
    throw new Error("stored current target is malformed");
  }
  try {
    const parsed = cloudTarget(record.url, record.anonKey);
    if (parsed.url !== record.url || parsed.anonKey !== record.anonKey) {
      throw new Error("stored current target is malformed");
    }
    return parsed;
  } catch {
    throw new Error("stored current target is malformed");
  }
}

export async function readCurrentTarget(
  options: CurrentTargetOptions = {},
): Promise<CloudTarget | null> {
  const path = currentTargetPath(options);
  if (!await existingDirectory(dirname(path))) return null;
  try {
    await assertCurrentTargetFile(path);
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_CURRENT_TARGET_BYTES) {
      throw new Error("stored current target is malformed");
    }
    return parseStoredCurrentTarget(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCurrentTarget(
  target: CloudTarget,
  options: CurrentTargetOptions = {},
): Promise<void> {
  const validated = cloudTarget(target.url, target.anonKey);
  const path = currentTargetPath(options);
  await ensureDirectory(dirname(path));
  try {
    await assertCurrentTargetFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const record: StoredCurrentTarget = {
    version: 1,
    url: validated.url,
    anonKey: validated.anonKey,
  };
  const serialized = JSON.stringify(record);
  const temporary =
    `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await chmod(path, 0o600);
  await assertCurrentTargetFile(path);
}

export async function clearCurrentTarget(
  options: CurrentTargetOptions = {},
): Promise<boolean> {
  const path = currentTargetPath(options);
  if (!await existingDirectory(dirname(path))) return false;
  try {
    await assertCurrentTargetFile(path);
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function targetFingerprint(target: CloudTarget): string {
  return createHash("sha256").update(target.anonKey).digest("hex").slice(0, 12);
}

export function currentTargetSummary(
  target: CloudTarget,
): { url: string; anon_key_fingerprint: string } {
  return {
    url: target.url,
    anon_key_fingerprint: targetFingerprint(target),
  };
}

function missingTargetError(mode: "human" | "agent"): Error {
  if (mode === "agent") {
    return new Error(
      "agent credentials never inherit a human's saved Cloud target; pass --url and --anon-key or set SWARM_CLOUD_URL and SWARM_CLOUD_ANON_KEY",
    );
  }
  return new Error(
    "no Cloud target is selected: start with cswarm accept --link-stdin because invite links carry the Cloud target and save its Supabase project base URL, or run cswarm target set --url https://<ref>.supabase.co --anon-key <key> using values from the deployment operator who invited you; scripts and CI may instead pass --url and --anon-key or set SWARM_CLOUD_URL and SWARM_CLOUD_ANON_KEY",
  );
}

function missingAnonKeyError(
  mode: "human" | "agent",
  mismatchedStoredTarget: boolean,
): Error {
  if (mode === "agent") {
    return missingTargetError(mode);
  }
  if (mismatchedStoredTarget) {
    return new Error(
      "the selected Cloud URL differs from the stored current target; pass its matching --anon-key, set SWARM_CLOUD_ANON_KEY, or run cswarm target set with the complete target",
    );
  }
  return new Error(
    "no Cloud anon key is selected: pass --anon-key, set SWARM_CLOUD_ANON_KEY, or run cswarm target set with the complete target",
  );
}

export async function resolveCloudTarget(
  options: ResolveCloudTargetOptions,
): Promise<CloudTarget> {
  const mode = options.mode ?? "human";
  const explicitOrEnvironmentalUrl =
    options.explicitUrl ?? options.environmentalUrl;
  const explicitOrEnvironmentalAnonKey =
    options.explicitAnonKey ?? options.environmentalAnonKey;
  const needsStored =
    explicitOrEnvironmentalUrl === undefined ||
    explicitOrEnvironmentalAnonKey === undefined;
  const stored = mode === "human" && needsStored
    ? await readCurrentTarget(options)
    : null;
  const url = explicitOrEnvironmentalUrl ?? stored?.url ?? "";
  if (!url.trim()) throw missingTargetError(mode);

  let anonKey = explicitOrEnvironmentalAnonKey;
  let mismatchedStoredTarget = false;
  if (anonKey === undefined && stored !== null) {
    const normalized = cloudTarget(url, stored.anonKey);
    if (normalized.url === stored.url) {
      anonKey = stored.anonKey;
    } else {
      mismatchedStoredTarget = true;
    }
  }
  if (!anonKey?.trim()) {
    throw missingAnonKeyError(mode, mismatchedStoredTarget);
  }
  return cloudTarget(url, anonKey);
}
