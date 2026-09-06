import { randomUUID } from "node:crypto";
import { lstat, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import {
  readSecureJsonFile,
  writeSecureJsonFile,
  deleteSecureJsonFile,
} from "./storage.js";
import type { CloudTarget } from "./config.js";
import {
  SESSION_CONTEXT_VERSION,
  SESSION_ENFORCEMENT_STATES,
  SESSION_MODES,
  SESSION_PROVIDERS,
  SESSION_RECEIVE_STATES,
  type SessionEnforcementState,
  type SessionMode,
  type SessionProvider,
  type SessionReceiveState,
} from "./session-contract.js";
import { type AgentSessionProof } from "./session-contract.js";
import {
  generateSessionKey,
  isSessionKey,
  isSessionUuid,
} from "./session-proof.js";
import { newCommandId } from "./command-client.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CONTEXT_BYTES = 16 * 1024;
const URL_RE = /^https?:\/\/[^/\s]+$/i;

export type SessionContextErrorCode =
  | "session_context_path_not_absolute"
  | "session_context_symlink"
  | "session_context_not_owned"
  | "session_context_insecure_mode"
  | "session_context_not_regular_file"
  | "session_context_unsafe_parent"
  | "session_context_inside_repository"
  | "session_context_corrupt"
  | "session_context_missing"
  | "session_context_token_file_invalid"
  | "session_context_conflict"
  | "session_identity_mismatch";

export class SessionContextError extends Error {
  readonly name = "SessionContextError";

  constructor(
    readonly code: SessionContextErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

export interface SessionContextDocument {
  version: typeof SESSION_CONTEXT_VERSION;
  url: string;
  profile_id: string;
  workspace_id: string;
  principal_id: string;
  session_id: string;
  generation: number;
  session_key: string;
  provider: SessionProvider;
  mode: SessionMode;
  host_session_id: string;
  token_file: string;
  acquire_command_id: string;
  host_label: string | null;
  enforcement: SessionEnforcementState;
  receive_verification: SessionReceiveState;
  /**
   * Set when this execution UUID was released locally. A released file keeps
   * generation for the record, clears the private key, and is never live proof.
   */
  released_at: string | null;
}

export interface SessionIdentity {
  principal_id: string;
  workspace_id: string;
}

function modeOf(statMode: number): number {
  return statMode & 0o777;
}

function assertCurrentOwner(uid: number): void {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new SessionContextError(
      "session_context_not_owned",
      "session context path is not owned by the current user",
    );
  }
}

async function lstatPath(path: string): Promise<import("node:fs").Stats> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw error;
    }
    throw new SessionContextError(
      "session_context_unsafe_parent",
      "session context path could not be inspected",
    );
  }
}

async function assertNotInsideRepository(absolute: string): Promise<void> {
  let current = dirname(absolute);
  const root = parsePath(current).root || "/";
  while (true) {
    try {
      const info = await lstat(join(current, ".git"));
      if (info.isDirectory() || info.isFile() || info.isSymbolicLink()) {
        throw new SessionContextError(
          "session_context_inside_repository",
          "session context must live outside a git repository",
        );
      }
    } catch (error) {
      if (error instanceof SessionContextError) throw error;
    }
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertSafeAncestors(absolute: string): Promise<void> {
  const parent = dirname(resolve(absolute));
  let info: import("node:fs").Stats;
  try {
    info = await lstatPath(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new SessionContextError(
      "session_context_symlink",
      `session context parent is a symlink: ${parent}`,
    );
  }
  if (!info.isDirectory()) {
    throw new SessionContextError(
      "session_context_unsafe_parent",
      `session context parent is not a directory: ${parent}`,
    );
  }
  if ((info.mode & 0o002) !== 0) {
    throw new SessionContextError(
      "session_context_unsafe_parent",
      `session context parent is world-writable: ${parent}`,
    );
  }
  assertCurrentOwner(info.uid);
}

async function assertOwnedDirectory(path: string, expectedMode: number): Promise<void> {
  const info = await lstatPath(path);
  if (info.isSymbolicLink()) {
    throw new SessionContextError(
      "session_context_symlink",
      `session directory is a symlink: ${path}`,
    );
  }
  if (!info.isDirectory()) {
    throw new SessionContextError(
      "session_context_unsafe_parent",
      `session directory is not a directory: ${path}`,
    );
  }
  assertCurrentOwner(info.uid);
  if (modeOf(info.mode) !== expectedMode) {
    throw new SessionContextError(
      "session_context_insecure_mode",
      `session directory must be mode ${expectedMode.toString(8)} (found ${modeOf(info.mode).toString(8)})`,
    );
  }
}

async function ensureOwnedDirectory(path: string): Promise<void> {
  try {
    await assertOwnedDirectory(path, 0o700);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await assertOwnedDirectory(path, 0o700);
}

export async function assertSafeContextPath(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new SessionContextError(
      "session_context_path_not_absolute",
      "session context path must be absolute",
    );
  }
  const absolute = resolve(path);
  await assertSafeAncestors(absolute);
  await assertNotInsideRepository(absolute);
  return absolute;
}

export async function assertSafeTokenFilePath(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new SessionContextError(
      "session_context_token_file_invalid",
      "token file path must be absolute",
    );
  }
  const absolute = resolve(path);
  let info: import("node:fs").Stats;
  try {
    info = await lstat(absolute);
  } catch {
    throw new SessionContextError(
      "session_context_token_file_invalid",
      "token file does not exist",
    );
  }
  if (info.isSymbolicLink()) {
    throw new SessionContextError(
      "session_context_token_file_invalid",
      "token file must not be a symlink",
    );
  }
  if (!info.isFile()) {
    throw new SessionContextError(
      "session_context_token_file_invalid",
      "token file must be a regular file",
    );
  }
  assertCurrentOwner(info.uid);
  if (modeOf(info.mode) !== 0o600) {
    throw new SessionContextError(
      "session_context_token_file_invalid",
      `token file must be mode 0600 (found ${modeOf(info.mode).toString(8)})`,
    );
  }
  const parent = dirname(absolute);
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new SessionContextError(
      "session_context_token_file_invalid",
      "token file parent must be a real directory",
    );
  }
  assertCurrentOwner(parentInfo.uid);
  if (modeOf(parentInfo.mode) !== 0o700) {
    throw new SessionContextError(
      "session_context_token_file_invalid",
      "token file parent must be mode 0700",
    );
  }
  return absolute;
}

export function defaultSessionRootDirectory(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "cswarm", "sessions");
  return join(homedir(), ".config", "cswarm", "sessions");
}

export function defaultSessionContextPath(
  workspaceId: string,
  principalId: string,
  sessionId: string,
): string {
  return join(
    defaultSessionRootDirectory(),
    workspaceId.toLowerCase(),
    principalId.toLowerCase(),
    `${sessionId.toLowerCase()}.json`,
  );
}

function asStringSet<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof value !== "string") return null;
  return (allowed as readonly string[]).includes(value) ? value as T : null;
}

export function parseSessionContext(raw: string): SessionContextDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SessionContextError(
      "session_context_corrupt",
      "session context is not JSON",
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionContextError(
      "session_context_corrupt",
      "session context is not an object",
    );
  }
  const row = value as Record<string, unknown>;
  const mode = asStringSet(row.mode, SESSION_MODES);
  const provider = asStringSet(row.provider, SESSION_PROVIDERS);
  const enforcement = asStringSet(row.enforcement, SESSION_ENFORCEMENT_STATES) ??
    "unknown";
  const receive = asStringSet(row.receive_verification, SESSION_RECEIVE_STATES) ??
    "manual";
  const releasedAt = parseReleasedAt(row.released_at);
  const sessionKey = typeof row.session_key === "string" ? row.session_key : null;
  const keyOk = sessionKey !== null &&
    (releasedAt !== null
      ? sessionKey === "" || isSessionKey(sessionKey)
      : isSessionKey(sessionKey));
  if (
    row.version !== SESSION_CONTEXT_VERSION ||
    typeof row.url !== "string" ||
    !URL_RE.test(row.url) ||
    typeof row.profile_id !== "string" ||
    !/^[0-9a-f]{24}$/.test(row.profile_id) ||
    typeof row.workspace_id !== "string" ||
    !UUID_RE.test(row.workspace_id) ||
    typeof row.principal_id !== "string" ||
    !UUID_RE.test(row.principal_id) ||
    typeof row.session_id !== "string" ||
    !isSessionUuid(row.session_id) ||
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 0 ||
    sessionKey === null ||
    !keyOk ||
    provider === null ||
    mode === null ||
    typeof row.host_session_id !== "string" ||
    row.host_session_id.length < 1 ||
    row.host_session_id.length > 200 ||
    typeof row.token_file !== "string" ||
    !isAbsolute(row.token_file) ||
    typeof row.acquire_command_id !== "string" ||
    !/^[A-Za-z0-9_-]{8,72}$/.test(row.acquire_command_id) ||
    !(
      row.host_label === null ||
      (typeof row.host_label === "string" && row.host_label.length <= 120)
    ) ||
    releasedAt === undefined
  ) {
    throw new SessionContextError(
      "session_context_corrupt",
      "session context fields are malformed",
    );
  }
  return {
    version: SESSION_CONTEXT_VERSION,
    url: row.url,
    profile_id: row.profile_id,
    workspace_id: row.workspace_id.toLowerCase(),
    principal_id: row.principal_id.toLowerCase(),
    session_id: row.session_id.toLowerCase(),
    generation: row.generation,
    session_key: sessionKey,
    provider,
    mode,
    host_session_id: row.host_session_id,
    token_file: row.token_file,
    acquire_command_id: row.acquire_command_id,
    host_label: row.host_label === null ? null : row.host_label,
    enforcement,
    receive_verification: receive,
    released_at: releasedAt,
  };
}

/** `undefined` means the field is malformed; `null` means not released. */
function parseReleasedAt(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return undefined;
  }
  return value;
}

export function isReleasedSession(context: SessionContextDocument): boolean {
  return context.released_at !== null;
}

/** Retire the private key locally. Generation stays for the record. */
export function markSessionReleased(
  context: SessionContextDocument,
  releasedAt: string = new Date().toISOString(),
): SessionContextDocument {
  return {
    ...context,
    session_key: "",
    released_at: releasedAt,
  };
}

export function sessionProofOf(
  context: SessionContextDocument,
): AgentSessionProof | null {
  if (isReleasedSession(context)) return null;
  if (context.generation < 1) return null;
  if (!isSessionKey(context.session_key)) return null;
  return {
    session_id: context.session_id,
    generation: context.generation,
    key: context.session_key,
  };
}

export function sessionLifecycleState(
  context: SessionContextDocument,
): "stopped" | "running" | "unacquired" {
  if (
    isReleasedSession(context) ||
    (sessionProofOf(context) === null && context.generation >= 1)
  ) {
    return "stopped";
  }
  if (sessionProofOf(context) === null) return "unacquired";
  return "running";
}

export function publicSessionStatus(
  context: SessionContextDocument,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: context.version,
    url: context.url,
    profile_id: context.profile_id,
    workspace_id: context.workspace_id,
    principal_id: context.principal_id,
    session_id: context.session_id,
    generation: context.generation,
    provider: context.provider,
    mode: context.mode,
    host_session_id: context.host_session_id,
    host_label: context.host_label,
    token_file: context.token_file,
    enforcement: context.enforcement,
    receive_verification: context.receive_verification,
    released_at: context.released_at,
    state: sessionLifecycleState(context),
    has_private_proof: sessionProofOf(context) !== null,
    ...extras,
  };
}

export function newSessionBinding(input: {
  target: CloudTarget;
  workspaceId: string;
  principalId: string;
  provider: SessionProvider;
  mode: SessionMode;
  hostSessionId: string;
  tokenFile: string;
  hostLabel?: string | null;
  sessionId?: string;
  sessionKey?: string;
  acquireCommandId?: string;
}): SessionContextDocument {
  return {
    version: SESSION_CONTEXT_VERSION,
    url: input.target.url,
    profile_id: input.target.profileId,
    workspace_id: input.workspaceId.toLowerCase(),
    principal_id: input.principalId.toLowerCase(),
    session_id: (input.sessionId ?? randomUUID()).toLowerCase(),
    generation: 0,
    session_key: input.sessionKey ?? generateSessionKey(),
    provider: input.provider,
    mode: input.mode,
    host_session_id: input.hostSessionId,
    token_file: input.tokenFile,
    acquire_command_id: input.acquireCommandId ?? newCommandId(),
    host_label: input.hostLabel ?? null,
    enforcement: "unknown",
    receive_verification: input.mode === "interactive" ? "manual" : "unverified",
    released_at: null,
  };
}

export async function writeSessionContext(
  path: string,
  document: SessionContextDocument,
): Promise<SessionContextDocument> {
  const absolute = await assertSafeContextPath(path);
  await ensureOwnedDirectory(dirname(absolute));
  await assertSafeTokenFilePath(document.token_file);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  await writeSecureJsonFile(absolute, serialized);
  return document;
}

export async function readSessionContext(
  path: string,
): Promise<SessionContextDocument> {
  const absolute = await assertSafeContextPath(path);
  let info: import("node:fs").Stats;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionContextError(
        "session_context_missing",
        "session context file does not exist",
      );
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new SessionContextError(
      "session_context_symlink",
      "session context file is a symlink",
    );
  }
  if (!info.isFile()) {
    throw new SessionContextError(
      "session_context_not_regular_file",
      "session context is not a regular file",
    );
  }
  assertCurrentOwner(info.uid);
  if (modeOf(info.mode) !== 0o600) {
    throw new SessionContextError(
      "session_context_insecure_mode",
      `session context must be mode 0600 (found ${modeOf(info.mode).toString(8)})`,
    );
  }
  const raw = await readSecureJsonFile(absolute, MAX_CONTEXT_BYTES);
  if (raw === null) {
    throw new SessionContextError(
      "session_context_missing",
      "session context file does not exist",
    );
  }
  const parsed = parseSessionContext(raw);
  await assertSafeTokenFilePath(parsed.token_file);
  return parsed;
}

export async function readSessionContextIfPresent(
  path: string,
): Promise<SessionContextDocument | null> {
  try {
    return await readSessionContext(path);
  } catch (error) {
    if (
      error instanceof SessionContextError &&
      error.code === "session_context_missing"
    ) {
      return null;
    }
    throw error;
  }
}

export async function deleteSessionContext(path: string): Promise<void> {
  const absolute = await assertSafeContextPath(path);
  await deleteSecureJsonFile(absolute);
}

export function assertSameIdentity(
  context: SessionContextDocument,
  input: {
    identity: SessionIdentity;
    target: CloudTarget;
    tokenPrincipalId?: string | null;
    flagWorkspaceId?: string;
    flagUrl?: string;
    hostSessionId?: string;
  },
): void {
  if (input.identity.principal_id.toLowerCase() !== context.principal_id) {
    throw new SessionContextError(
      "session_identity_mismatch",
      "authenticated principal does not match the session context",
    );
  }
  if (input.identity.workspace_id.toLowerCase() !== context.workspace_id) {
    throw new SessionContextError(
      "session_identity_mismatch",
      "authenticated workspace does not match the session context",
    );
  }
  if (input.target.url !== context.url || input.target.profileId !== context.profile_id) {
    throw new SessionContextError(
      "session_identity_mismatch",
      "Cloud target does not match the session context",
    );
  }
  if (
    input.tokenPrincipalId !== undefined &&
    input.tokenPrincipalId !== null &&
    input.tokenPrincipalId.toLowerCase() !== context.principal_id
  ) {
    throw new SessionContextError(
      "session_identity_mismatch",
      "token artifact principal does not match the session context",
    );
  }
  if (
    input.flagWorkspaceId !== undefined &&
    input.flagWorkspaceId.toLowerCase() !== context.workspace_id
  ) {
    throw new SessionContextError(
      "session_identity_mismatch",
      "--workspace-id does not match the session context",
    );
  }
  if (input.flagUrl !== undefined && input.flagUrl !== context.url) {
    throw new SessionContextError(
      "session_identity_mismatch",
      "--url does not match the session context",
    );
  }
  if (
    input.hostSessionId !== undefined &&
    input.hostSessionId !== context.host_session_id
  ) {
    throw new SessionContextError(
      "session_identity_mismatch",
      "host session id does not match the session context",
    );
  }
}

export function assertUnacquiredOrSameBinding(
  existing: SessionContextDocument | null,
  next: SessionContextDocument,
): void {
  if (existing === null) return;
  if (existing.session_id !== next.session_id) {
    throw new SessionContextError(
      "session_context_conflict",
      "refusing to overwrite a different execution session binding",
    );
  }
  if (existing.session_key !== next.session_key) {
    throw new SessionContextError(
      "session_context_conflict",
      "refusing to replace the private session key for this execution UUID",
    );
  }
}
