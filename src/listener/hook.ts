import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SignalRecord } from "../cloud/command-client.js";
import { cloudTarget, type CloudTarget } from "../cloud/config.js";
import {
  followHttpDetails,
  readAgentSignalDirectory,
  readAgentSignalPage,
  type SignalDirectory,
} from "../cloud/signals.js";
import {
  deleteSecureJsonFile,
  readSecureJsonFile,
  withFileLock,
  writeSecureJsonFile,
} from "../cloud/storage.js";
import { defaultListenerStateDirectory } from "./file-store.js";
import {
  FilePendingMainQueue,
  type PendingMainEntry,
} from "./main-routing.js";
import {
  listenerPaths,
  queryListenerControl,
  readListenerStatus,
  writeListenerStatus,
  type ListenerPaths,
  type ListenerStatus,
} from "./control.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const INSTANCE_KEY_RE = /^[0-9a-f]{64}$/;
const MAX_HOOK_CREDENTIAL_BYTES = 8 * 1024;
const MAX_HOOK_SURFACE_BYTES = 128 * 1024;
const MAX_GLOBAL_STATE_BYTES = 4 * 1024;
const LISTENER_CREDENTIAL_FILE = "listener-credential.json";
const RETIRED_HOOK_CREDENTIAL_FILE = "hook-credential.json";
const HOOK_SURFACE_FILE = "hook-surface.json";
const GLOBAL_STATE_FILE = "hook-check.json";
const HOOK_SURFACE_LOCK = "hook-surface";
const GLOBAL_STATE_LOCK = "hook-check";
const HOOK_LOCK_TIMEOUT_MS = 250;

export const HOOK_CHECK_TIMEOUT_MS = 3_000;
export const HOOK_DEFAULT_COOLDOWN_SECONDS = 30;
export const HOOK_SURFACED_IDS_MAX = 1_024;
export const HOOK_BODY_PREVIEW_CHARS = 240;

export interface ListenerCredentialState {
  version: 1;
  profileId: string;
  targetUrl: string;
  anonKey: string;
  workspaceId: string;
  principalId: string;
  credential: string;
  updatedAt: string;
}

interface HookSurfaceFile {
  version: 1;
  surfacedSignalIds: string[];
  reportedDroppedCount: number;
  credentialFailureReported: boolean;
}

interface HookGlobalState {
  version: 1;
  lastCheckAt: number;
}

export interface HookCheckOptions {
  stateDirectory?: string;
  cooldownSeconds?: number;
  now?: () => number;
  fetcher?: typeof fetch;
  write?: (output: string) => void | Promise<void>;
  isListenerLive?: (context: {
    paths: ListenerPaths;
    status: ListenerStatus;
  }) => boolean | Promise<boolean>;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(row).length === expected.size &&
    Object.keys(row).every((key) => expected.has(key));
}

function parseListenerCredential(raw: string): ListenerCredentialState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("stored listener hook credential is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored listener hook credential is malformed");
  }
  const row = value as Record<string, unknown>;
  if (
    !exactKeys(row, [
      "version",
      "profileId",
      "targetUrl",
      "anonKey",
      "workspaceId",
      "principalId",
      "credential",
      "updatedAt",
    ]) ||
    row.version !== 1 ||
    typeof row.profileId !== "string" || !/^[0-9a-f]{24}$/.test(row.profileId) ||
    typeof row.targetUrl !== "string" ||
    typeof row.anonKey !== "string" || row.anonKey.length < 1 || row.anonKey.length > 4_096 ||
    typeof row.workspaceId !== "string" || !UUID_RE.test(row.workspaceId) ||
    typeof row.principalId !== "string" || !UUID_RE.test(row.principalId) ||
    typeof row.credential !== "string" || !TOKEN_RE.test(row.credential) ||
    typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))
  ) {
    throw new Error("stored listener hook credential is malformed");
  }
  const target = cloudTarget(row.targetUrl, row.anonKey);
  if (target.profileId !== row.profileId) {
    throw new Error("stored listener hook credential target does not match its profile");
  }
  return {
    version: 1,
    profileId: row.profileId,
    targetUrl: target.url,
    anonKey: target.anonKey,
    workspaceId: row.workspaceId.toLowerCase(),
    principalId: row.principalId.toLowerCase(),
    credential: row.credential,
    updatedAt: row.updatedAt,
  };
}

/** Keep the listener and its read-only hook on one owned 0600 credential state file. */
export async function writeListenerCredentialState(
  instanceDirectory: string,
  input: {
    target: CloudTarget;
    workspaceId: string;
    principalId: string;
    credential: string;
    now?: number;
  },
): Promise<void> {
  if (!isAbsolute(instanceDirectory)) {
    throw new Error("listener hook state directory must be absolute");
  }
  const record = parseListenerCredential(JSON.stringify({
    version: 1,
    profileId: input.target.profileId,
    targetUrl: input.target.url,
    anonKey: input.target.anonKey,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    credential: input.credential,
    updatedAt: new Date(input.now ?? Date.now()).toISOString(),
  }));
  await writeSecureJsonFile(
    join(instanceDirectory, LISTENER_CREDENTIAL_FILE),
    JSON.stringify(record),
  );
  await deleteSecureJsonFile(
    join(instanceDirectory, RETIRED_HOOK_CREDENTIAL_FILE),
  ).catch(() => undefined);
}

/** Read the exact credential state used by the listener after verifying mode 0600. */
export async function readListenerCredentialState(
  instanceDirectory: string,
): Promise<ListenerCredentialState | null> {
  const raw = await readSecureJsonFile(
    join(instanceDirectory, LISTENER_CREDENTIAL_FILE),
    MAX_HOOK_CREDENTIAL_BYTES,
  );
  return raw === null ? null : parseListenerCredential(raw);
}

function parseSurface(raw: string): HookSurfaceFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("stored listener hook surface state is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored listener hook surface state is malformed");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) =>
      key !== "version" && key !== "surfacedSignalIds" &&
      key !== "reportedDroppedCount" && key !== "credentialFailureReported"
    ) ||
    row.version !== 1 || !Array.isArray(row.surfacedSignalIds) ||
    row.surfacedSignalIds.length > HOOK_SURFACED_IDS_MAX ||
    row.surfacedSignalIds.some((id) => typeof id !== "string" || !UUID_RE.test(id)) ||
    !(row.reportedDroppedCount === undefined ||
      (typeof row.reportedDroppedCount === "number" &&
        Number.isSafeInteger(row.reportedDroppedCount) && row.reportedDroppedCount >= 0)) ||
    !(row.credentialFailureReported === undefined ||
      typeof row.credentialFailureReported === "boolean")
  ) {
    throw new Error("stored listener hook surface state is malformed");
  }
  const ids = row.surfacedSignalIds.map((id) => String(id).toLowerCase());
  if (new Set(ids).size !== ids.length) {
    throw new Error("stored listener hook surface state repeats a signal");
  }
  return {
    version: 1,
    surfacedSignalIds: ids,
    reportedDroppedCount: typeof row.reportedDroppedCount === "number"
      ? row.reportedDroppedCount
      : 0,
    credentialFailureReported: row.credentialFailureReported === true,
  };
}

export interface HookSurfaceStage<T> {
  unseen: T[];
  droppedSinceLastCheck: number;
  credentialFailureReported: boolean;
}

/** Stage output without advancing the high-water; commit is called only after stdout. */
export class FileHookSurfaceStore {
  private readonly path: string;

  constructor(private readonly instanceDirectory: string) {
    if (!isAbsolute(instanceDirectory)) {
      throw new Error("listener hook surface directory must be absolute");
    }
    this.path = join(instanceDirectory, HOOK_SURFACE_FILE);
  }

  async stage<T extends { signalId: string }>(
    items: readonly T[],
    droppedCount: number,
  ): Promise<HookSurfaceStage<T>> {
    return await withFileLock(this.instanceDirectory, HOOK_SURFACE_LOCK, async () => {
      const raw = await readSecureJsonFile(this.path, MAX_HOOK_SURFACE_BYTES);
      const state = raw === null
        ? {
          version: 1 as const,
          surfacedSignalIds: [],
          reportedDroppedCount: 0,
          credentialFailureReported: false,
        }
        : parseSurface(raw);
      const seen = new Set(state.surfacedSignalIds);
      const unseen: T[] = [];
      for (const item of items) {
        const signalId = item.signalId.toLowerCase();
        if (!UUID_RE.test(signalId) || seen.has(signalId)) continue;
        seen.add(signalId);
        unseen.push(item);
      }
      return {
        unseen,
        droppedSinceLastCheck: droppedCount < state.reportedDroppedCount
          ? droppedCount
          : droppedCount - state.reportedDroppedCount,
        credentialFailureReported: state.credentialFailureReported,
      };
    }, { timeoutMs: HOOK_LOCK_TIMEOUT_MS });
  }

  async commit(options: {
    signalIds?: readonly string[];
    droppedCount?: number;
    credentialFailureReported?: boolean;
  }): Promise<void> {
    await withFileLock(this.instanceDirectory, HOOK_SURFACE_LOCK, async () => {
      const raw = await readSecureJsonFile(this.path, MAX_HOOK_SURFACE_BYTES);
      const state = raw === null
        ? {
          version: 1 as const,
          surfacedSignalIds: [],
          reportedDroppedCount: 0,
          credentialFailureReported: false,
        }
        : parseSurface(raw);
      const seen = new Set(state.surfacedSignalIds);
      for (const signalId of options.signalIds ?? []) {
        const checked = signalId.toLowerCase();
        if (UUID_RE.test(checked)) seen.add(checked);
      }
      await writeSecureJsonFile(
        this.path,
        JSON.stringify(parseSurface(JSON.stringify({
          version: 1,
          surfacedSignalIds: [...seen].slice(-HOOK_SURFACED_IDS_MAX),
          reportedDroppedCount: options.droppedCount ?? state.reportedDroppedCount,
          credentialFailureReported: options.credentialFailureReported ??
            state.credentialFailureReported,
        }))),
      );
    }, { timeoutMs: HOOK_LOCK_TIMEOUT_MS });
  }

  async claimUnseen<T extends { signalId: string }>(items: readonly T[]): Promise<T[]> {
    const staged = await this.stage(items, 0);
    if (staged.unseen.length > 0) {
      await this.commit({ signalIds: staged.unseen.map((item) => item.signalId) });
    }
    return staged.unseen;
  }
}

function parseGlobalState(raw: string): HookGlobalState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("stored hook cooldown state is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored hook cooldown state is malformed");
  }
  const row = value as Record<string, unknown>;
  if (
    !exactKeys(row, ["version", "lastCheckAt"]) || row.version !== 1 ||
    typeof row.lastCheckAt !== "number" || !Number.isSafeInteger(row.lastCheckAt) ||
    row.lastCheckAt < 0
  ) {
    throw new Error("stored hook cooldown state is malformed");
  }
  return { version: 1, lastCheckAt: row.lastCheckAt };
}

async function reserveCheck(
  stateDirectory: string,
  cooldownMs: number,
  now: number,
): Promise<boolean> {
  return await withFileLock(stateDirectory, GLOBAL_STATE_LOCK, async () => {
    const path = join(stateDirectory, GLOBAL_STATE_FILE);
    const raw = await readSecureJsonFile(path, MAX_GLOBAL_STATE_BYTES);
    const previous = raw === null ? null : parseGlobalState(raw);
    if (previous !== null && now - previous.lastCheckAt < cooldownMs) return false;
    await writeSecureJsonFile(path, JSON.stringify({ version: 1, lastCheckAt: now }));
    return true;
  }, { timeoutMs: HOOK_LOCK_TIMEOUT_MS });
}

interface ListenerHookContext {
  instanceDirectory: string;
  paths: ListenerPaths | null;
  status: ListenerStatus | null;
  credential: ListenerCredentialState | null;
  credentialReadFailed: boolean;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function statusContext(
  stateDirectory: string,
  key: string,
  instanceDirectory: string,
): Promise<{ paths: ListenerPaths; status: ListenerStatus } | null> {
  const provisional: ListenerPaths = {
    key,
    instanceDirectory,
    statusPath: join(instanceDirectory, "status.json"),
    logPath: join(instanceDirectory, "events.ndjson"),
    socketPath: "",
  };
  const status = await readListenerStatus(provisional).catch(() => null);
  if (status === null) return null;
  const paths = listenerPaths({
    profileId: status.profileId,
    workspaceId: status.workspaceId,
    principalId: status.principalId,
    stateDirectory,
  });
  if (paths.key !== key || paths.instanceDirectory !== instanceDirectory) return null;
  return { paths, status };
}

async function listenerIsLive(context: {
  paths: ListenerPaths;
  status: ListenerStatus;
}): Promise<boolean> {
  if (
    context.status.state === "stopped" ||
    context.status.state === "failed" ||
    !processIsAlive(context.status.pid)
  ) {
    return false;
  }
  try {
    await queryListenerControl(context.paths, "status", 250);
    return true;
  } catch {
    return false;
  }
}

async function discoverContexts(
  stateDirectory: string,
  isListenerLive: NonNullable<HookCheckOptions["isListenerLive"]> = listenerIsLive,
): Promise<ListenerHookContext[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(stateDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const contexts: ListenerHookContext[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !INSTANCE_KEY_RE.test(entry.name)) continue;
    const instanceDirectory = join(stateDirectory, entry.name);
    const storedStatus = await statusContext(
      stateDirectory,
      entry.name,
      instanceDirectory,
    );
    const statusIsLive = storedStatus === null
      ? null
      : await isListenerLive(storedStatus);
    if (statusIsLive === false) continue;
    await deleteSecureJsonFile(
      join(instanceDirectory, RETIRED_HOOK_CREDENTIAL_FILE),
    ).catch(() => undefined);
    try {
      const credential = await readListenerCredentialState(instanceDirectory);
      contexts.push({
        instanceDirectory,
        paths: storedStatus?.paths ?? null,
        status: storedStatus?.status ?? null,
        credential,
        credentialReadFailed: credential === null && storedStatus !== null,
      });
    } catch {
      if (storedStatus === null) continue;
      contexts.push({
        instanceDirectory,
        paths: storedStatus.paths,
        status: storedStatus.status,
        credential: null,
        credentialReadFailed: true,
      });
    }
  }
  return contexts;
}

type SurfaceItem = PendingMainEntry;

function entryFromSignal(
  signal: SignalRecord,
  principalId: string,
  directory: SignalDirectory | null,
  now: number,
): SurfaceItem {
  const senderName = signal.from_kind === "agent"
    ? directory?.agents.find((agent) => agent.principal_id === signal.from)?.name ?? null
    : directory?.members.find((member) => member.user_id === signal.from)?.display_name ?? null;
  return {
    signalId: signal.id,
    workspaceId: signal.workspace_id,
    principalId,
    fromId: signal.from,
    fromKind: signal.from_kind,
    ...(signal.kind === "ask" || signal.kind === "note" ? { kind: signal.kind } : {}),
    senderName,
    body: signal.body,
    createdAt: signal.created_at,
    queuedAt: new Date(now).toISOString(),
  };
}

function preview(value: string): string {
  let text = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (text.length > HOOK_BODY_PREVIEW_CHARS) {
    text = `${text.slice(0, HOOK_BODY_PREVIEW_CHARS - 1)}…`;
  }
  return JSON.stringify(text);
}

/** Render untrusted teammate text only inside JSON quotes in a CommonSwarm block. */
export function renderHookSignal(item: SurfaceItem): string {
  const sender = item.senderName === null ? item.fromId : item.senderName;
  const senderKind = item.fromKind === "user" ? "teammate" : "agent";
  const intent = item.kind === "ask"
    ? "is asking you:"
    : item.kind === "note"
    ? "sent you a note:"
    : "sent you a message:";
  const replyLabel = item.kind === "note" ? "reply (optional):" : "reply:";
  return [
    `[CommonSwarm] ${senderKind} ${JSON.stringify(sender)} ${intent}`,
    preview(item.body),
    `${replyLabel} cswarm reply ${item.signalId} "<answer>" --workspace-id ${item.workspaceId}`,
  ].join("\n");
}

async function inboxItems(
  context: ListenerHookContext,
  options: { fetcher?: typeof fetch; signal: AbortSignal; deadlineMs: number; now: () => number },
): Promise<SurfaceItem[]> {
  const stored = context.credential!;
  const target = cloudTarget(stored.targetUrl, stored.anonKey);
  const readOptions = {
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    signal: options.signal,
    deadlineMs: options.deadlineMs,
    now: options.now,
  };
  const page = await readAgentSignalPage(
    target,
    { kind: "agent", token: stored.credential },
    {
      workspaceId: stored.workspaceId,
      inbox: true,
      ascending: false,
      limit: 100,
      includeStale: false,
    },
    readOptions,
    { tolerateMalformedRows: true, maxMalformedRows: 3 },
  );
  const directed = page.signals.filter((signal) =>
    (signal.kind === "ask" || signal.kind === "note") &&
    signal.workspace_id === stored.workspaceId &&
    signal.to_agent === stored.principalId
  );
  if (directed.length === 0) return [];
  let directory: SignalDirectory | null = null;
  try {
    directory = await readAgentSignalDirectory(
      target,
      stored.credential,
      stored.workspaceId,
      readOptions,
    );
  } catch {
    directory = null;
  }
  const candidates = directed
    .map((signal) => entryFromSignal(signal, stored.principalId, directory, options.now()))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  return candidates;
}

function renderDroppedAsks(count: number): string {
  return `${count} routed asks were dropped from the overflow queue; ` +
    "check cswarm inbox. The signals remain in the inbox.";
}

const CREDENTIAL_READ_WARNING =
  "CommonSwarm could not read the configured listener credential safely. The hook is not checking routed asks. " +
  "Restart the listener with a fresh credential; any credential state file must be mode 0600. Then run cswarm listen status.";
const CREDENTIAL_401_WARNING =
  "CommonSwarm could not authenticate a listener credential (HTTP 401). The hook is not checking routed asks. " +
  "Restart the listener with a fresh credential, then run cswarm listen status.";

interface ContextCheck {
  context: ListenerHookContext;
  queue: FilePendingMainQueue;
  pending: SurfaceItem[];
  droppedCount: number;
  network: SurfaceItem[];
  credentialFailure: "read" | "401" | null;
  credentialHealthy: boolean;
}

/** Print first, then advance the high-water and remove local queue entries. */
export async function checkListenerHooks(
  options: HookCheckOptions & { signal: AbortSignal; deadlineMs: number },
): Promise<string> {
  try {
    const stateDirectory = options.stateDirectory ?? defaultListenerStateDirectory();
    if (!isAbsolute(stateDirectory)) return "";
    const now = options.now ?? Date.now;
    const cooldownSeconds = options.cooldownSeconds ?? HOOK_DEFAULT_COOLDOWN_SECONDS;
    if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 86_400) {
      return "";
    }
    const contexts = await discoverContexts(
      stateDirectory,
      options.isListenerLive ?? listenerIsLive,
    );
    if (contexts.length === 0) return "";
    const networkAllowed = await reserveCheck(
      stateDirectory,
      cooldownSeconds * 1_000,
      now(),
    );
    const checks = await Promise.all(contexts.map(async (context): Promise<ContextCheck> => {
      const queue = new FilePendingMainQueue(context.instanceDirectory);
      const pending = await queue.read();
      const stats = await queue.stats();
      let network: SurfaceItem[] = [];
      let credentialFailure: ContextCheck["credentialFailure"] =
        context.credentialReadFailed ? "read" : null;
      let credentialHealthy = false;
      if (networkAllowed && !options.signal.aborted && context.credential !== null) {
        try {
          network = await inboxItems(context, {
            ...(options.fetcher ? { fetcher: options.fetcher } : {}),
            signal: options.signal,
            deadlineMs: options.deadlineMs,
            now,
          });
          credentialHealthy = true;
        } catch (error) {
          if (followHttpDetails(error)?.status === 401) credentialFailure = "401";
        }
      }
      return {
        context,
        queue,
        pending,
        droppedCount: stats.droppedCount,
        network,
        credentialFailure,
        credentialHealthy,
      };
    }));

    const commits: Array<{
      check: ContextCheck;
      store: FileHookSurfaceStore;
      signalIds: string[];
      printedPendingSignalIds: string[];
      reportDrops: boolean;
      reportCredentialFailure: boolean;
    }> = [];
    const blocks: string[] = [];
    const emittedCredentialWarnings = new Set<string>();
    for (const check of checks) {
      const store = new FileHookSurfaceStore(check.context.instanceDirectory);
      const staged = await store.stage(
        [...check.pending, ...check.network],
        check.droppedCount,
      );
      blocks.push(...staged.unseen.map(renderHookSignal));
      const reportDrops = staged.droppedSinceLastCheck > 0;
      if (reportDrops) blocks.push(renderDroppedAsks(staged.droppedSinceLastCheck));
      const reportCredentialFailure = check.credentialFailure !== null &&
        !staged.credentialFailureReported;
      if (reportCredentialFailure) {
        const warning = check.credentialFailure === "401"
          ? CREDENTIAL_401_WARNING
          : CREDENTIAL_READ_WARNING;
        if (!emittedCredentialWarnings.has(warning)) {
          emittedCredentialWarnings.add(warning);
          blocks.push(warning);
        }
      }
      const pendingSignalIds = new Set(check.pending.map((entry) => entry.signalId));
      commits.push({
        check,
        store,
        signalIds: staged.unseen.map((item) => item.signalId),
        printedPendingSignalIds: staged.unseen
          .map((item) => item.signalId)
          .filter((signalId) => pendingSignalIds.has(signalId)),
        reportDrops,
        reportCredentialFailure,
      });
    }
    const output = blocks.join("\n\n");
    if (output.length > 0) await (options.write ?? (() => undefined))(output);

    for (const commit of commits) {
      await commit.store.commit({
        signalIds: commit.signalIds,
        ...(commit.reportDrops ? { droppedCount: commit.check.droppedCount } : {}),
        ...(commit.reportCredentialFailure
          ? { credentialFailureReported: true }
          : commit.check.credentialHealthy
          ? { credentialFailureReported: false }
          : {}),
      });
      const remainingCount = await commit.check.queue.remove(
        new Set(commit.printedPendingSignalIds),
        HOOK_LOCK_TIMEOUT_MS,
      );
      if (commit.check.context.paths !== null && commit.check.context.status !== null) {
        const latest = await readListenerStatus(commit.check.context.paths).catch(() => null);
        if (latest !== null && latest.pendingForMainCount !== remainingCount) {
          await writeListenerStatus(commit.check.context.paths, {
            ...latest,
            pendingForMainCount: remainingCount,
          });
        }
      }
    }
    return output;
  } catch {
    return "";
  }
}

/** Own the three-second ceiling and always resolve to safe stdout text. */
export async function runListenerHookCheck(options: HookCheckOptions = {}): Promise<string> {
  const controller = new AbortController();
  const deadlineMs = Date.now() + HOOK_CHECK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const checking = checkListenerHooks({
      ...options,
      signal: controller.signal,
      deadlineMs,
    });
    const timedOut = new Promise<string>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("");
      }, HOOK_CHECK_TIMEOUT_MS);
    });
    return await Promise.race([checking, timedOut]);
  } catch {
    return "";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
