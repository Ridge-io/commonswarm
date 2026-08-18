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

/**
 * The saved target. The anon key is returned ONLY under `--reveal-anon-key`. D-079.
 *
 * The key used to be fingerprinted here and nowhere else, which made this summary useless for
 * the one job an agent needs it for. Agent credentials deliberately do not inherit a human's
 * saved target, and the refusal says *"pass --url and --anon-key or set SWARM_CLOUD_URL and
 * SWARM_CLOUD_ANON_KEY"* — so the CLI demanded a value **no command would return**. Wren, on a
 * second machine, satisfied it by reading `~/.cswarm/credentials.d/current-target.json` directly,
 * which is the outcome the fingerprint was presumably meant to prevent.
 *
 * There was never a secret to protect. AGENTS.md: *"The anon key is a public identifier protected
 * by RLS, not a secret."* The product publishes this exact value in a `commonswarm:anon-key`
 * meta tag on every page of commonswarm.com. Fingerprinting it treated a published identifier as
 * a credential and pushed agents into the credential store to get it.
 *
 * The default stays fingerprinted, and that is deliberate rather than timid: a 208-character JWT
 * printed by default lands in logs, screenshots and pasted issues, where the next reader may not
 * check WHICH key it is. `supabase projects api-keys` prints the service-role key two rows below
 * the anon key, so "cswarm prints keys" is a habit worth not forming.
 *
 * `--reveal-anon-key` makes it an explicit act. That closes the dead end without changing what a
 * casual invocation emits, and the existing control asserting the default output omits the key
 * stays true and unedited.
 */
export function currentTargetSummary(
  target: CloudTarget,
  reveal = false,
): { url: string; anon_key_fingerprint: string; anon_key?: string } {
  return {
    url: target.url,
    anon_key_fingerprint: targetFingerprint(target),
    ...(reveal ? { anon_key: target.anonKey } : {}),
  };
}

/** The deployment a cold install belongs to. Overridable so a private deployment can self-host. */
export const DEFAULT_SITE_ORIGIN = "https://commonswarm.com";

/** One meta tag's content, by name, from an HTML document. Our own markup, not the general case. */
function metaContent(html: string, name: string): string | null {
  /* Attribute order is fixed by our own templates (name then content) and both are
   * double-quoted. Deliberately narrow: this parses ONE shape and returns null for anything
   * else, rather than pretending to be an HTML parser. */
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta\\s+name="${escaped}"\\s+content="([^"]*)"`,
    "i",
  );
  const found = pattern.exec(html);
  return found?.[1] ?? null;
}

/**
 * The Cloud target of the deployment this CLI was installed from. Returns null on ANY failure.
 *
 * F-1 of the 2026-08-10 dogfood. `install.sh` closes by telling a stranger with no invite to run
 * `cswarm login` and `cswarm new`, and both refused: no Cloud target is selected. The remedy text
 * then offered three routes and none was open to that reader — they had no invite link, "whoever
 * runs this deployment" was themselves, and they had not created a Supabase project. The
 * installer's own comment at line 147 states the reason not to send someone to `login`, 35 lines
 * above the line that does it.
 *
 * The values are not secret and are already published, by us, on the host the installer came
 * from — AGENTS.md: "The anon key is a public identifier protected by RLS, not a secret." So this
 * is the onboarding direction applied: detect rather than ask. Trusting HTTPS from this origin is
 * the same trust already placed in it by `curl -fsSL … | sh`.
 *
 * Null on every failure so the CALLER can surface the original, more informative error. A
 * discovery that reported its own network problem would replace a message about the user's
 * situation with one about ours.
 */
export async function discoverCloudTarget(
  options: { origin?: string; fetcher?: typeof fetch } = {},
): Promise<CloudTarget | null> {
  const origin = options.origin ?? process.env.CSWARM_SITE ?? DEFAULT_SITE_ORIGIN;
  /* Refuse plaintext outright, BEFORE any request. A discovered target is written to the
   * credential store, so an origin that can be tampered with in flight chooses where this CLI
   * sends its traffic from then on. */
  if (!origin.startsWith("https://")) return null;
  const doFetch = options.fetcher ?? fetch;
  try {
    const response = await doFetch(`${origin}/start`, {
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const url = metaContent(html, "commonswarm:url");
    const anonKey = metaContent(html, "commonswarm:anon-key");
    /* This guard is NOT independently gated by a test, and that is recorded rather than hidden:
     * deleting it leaves every F-1 test green, because `cloudTarget(url, null)` currently throws
     * a TypeError that the catch below turns into the same null. So the behaviour is right for
     * the wrong reason. Keep it — the alternative is a code path whose correctness depends on a
     * crash, and a future lenient `cloudTarget` would then save a target with no key. */
    if (url === null || anonKey === null) return null;
    return cloudTarget(url, anonKey);
  } catch {
    return null;
  }
}

function missingTargetError(mode: "human" | "agent"): Error {
  if (mode === "agent") {
    return new Error(
      "agent credentials never inherit a human's saved Cloud target; pass --url and --anon-key or set SWARM_CLOUD_URL and SWARM_CLOUD_ANON_KEY",
    );
  }
  return new Error(
    /* "who invited you" assumed an inviter. Self-serve signup is live, so a reader who created
     * their own workspace has no such person and the sentence sends them to nobody. Same family
     * as the 3-project cap telling the account holder to ask an operator who is themselves —
     * instruction text written for a different reader than the one receiving it. See D-067. */
    /* The hosted reader must be able to FINISH the target-set command, not just start it: the
     * inversion arm on this change showed every listed route was closed for the self-serve
     * hosted reader because <key> named no source. The anon key is public (RLS-protected) and
     * published in the meta tags of https://commonswarm.com/start — say so. Same F-1/D-067
     * family: a route you cannot complete is not a route. */
    "no Cloud target is selected: most commands discover the hosted target from https://commonswarm.com automatically, so seeing this usually means that fetch failed — check network or your egress allowlist. Otherwise start with cswarm accept --link-stdin because invite links carry the Cloud target and save its Supabase project base URL, or run cswarm target set --url https://api.commonswarm.com --anon-key <key> for the hosted service — the anon key is public, in the meta tags at https://commonswarm.com/start (a self-hosted deployment uses its https://<ref>.supabase.co URL from whoever runs it, or from your own project's API settings if you created it); scripts and CI may instead pass --url and --anon-key or set SWARM_CLOUD_URL and SWARM_CLOUD_ANON_KEY",
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
