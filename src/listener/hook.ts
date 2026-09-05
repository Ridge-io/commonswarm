import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SignalRecord } from "../cloud/command-client.js";
import { listBrainRowsAsAgent } from "../cloud/brain-agent.js";
import { brainTopicSnapshots } from "../cloud/brain.js";
import { cloudTarget, type CloudTarget } from "../cloud/config.js";
import {
  DeliveryCommandClient,
  observationCommandId,
} from "../cloud/delivery.js";
import {
  followHttpDetails,
  readAgentSignalDirectory,
  readAgentSignalPage,
  signalAddressesAgent,
  type SignalDirectory,
} from "../cloud/signals.js";
import {
  deleteSecureJsonFile,
  readSecureJsonFile,
  readSecureJsonFileIfPresent,
  withFileLock,
  writeSecureJsonFile,
} from "../cloud/storage.js";
import { defaultListenerStateDirectory } from "./file-store.js";
import { FileBrainDigestStore } from "./brain-digest.js";
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
export const HOOK_MULTI_PRINCIPAL_GUIDANCE =
  "This host runs multiple agents. The CommonSwarm hook needs --principal-id. " +
  "Reinstall it for this agent: cswarm hook install claude --principal-id <uuid> --write";

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
  principalIds?: readonly string[];
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

function hasRequiredKeys(
  row: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => Object.hasOwn(row, key));
}

const LISTENER_CREDENTIAL_KEYS = [
  "version",
  "profileId",
  "targetUrl",
  "anonKey",
  "workspaceId",
  "principalId",
  "credential",
  "updatedAt",
] as const;
const HOOK_SURFACE_KEYS = new Set([
  "version",
  "surfacedSignalIds",
  "reportedDroppedCount",
  "credentialFailureReported",
]);

function parseListenerCredential(
  raw: string,
  rejectUnknownKeys = false,
): ListenerCredentialState {
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
    !(rejectUnknownKeys
      ? exactKeys(row, LISTENER_CREDENTIAL_KEYS)
      : hasRequiredKeys(row, LISTENER_CREDENTIAL_KEYS)) ||
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
  }), true);
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

function parseSurface(raw: string, rejectUnknownKeys = false): HookSurfaceFile {
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
    (rejectUnknownKeys && Object.keys(row).some((key) => !HOOK_SURFACE_KEYS.has(key))) ||
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

export interface HookSurfaceEvidence {
  exists: boolean;
  surfacedSignalIds: readonly string[];
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

  /** Preview unseen hook rows without taking a write lock or advancing state. */
  async previewUnseen<T extends { signalId: string }>(items: readonly T[]): Promise<T[]> {
    const raw = await readSecureJsonFileIfPresent(this.path, MAX_HOOK_SURFACE_BYTES);
    const seen = new Set(raw === null ? [] : parseSurface(raw).surfacedSignalIds);
    const unseen: T[] = [];
    for (const item of items) {
      const signalId = item.signalId.toLowerCase();
      if (!UUID_RE.test(signalId) || seen.has(signalId)) continue;
      seen.add(signalId);
      unseen.push(item);
    }
    return unseen;
  }

  /** Read attendance evidence without advancing the hook high-water. */
  async evidence(): Promise<HookSurfaceEvidence> {
    return await withFileLock(this.instanceDirectory, HOOK_SURFACE_LOCK, async () => {
      const raw = await readSecureJsonFile(this.path, MAX_HOOK_SURFACE_BYTES);
      if (raw === null) return { exists: false, surfacedSignalIds: [] };
      const state = parseSurface(raw);
      return {
        exists: true,
        surfacedSignalIds: state.surfacedSignalIds,
      };
    }, { timeoutMs: HOOK_LOCK_TIMEOUT_MS });
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
        }), true)),
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
    !hasRequiredKeys(row, ["version", "lastCheckAt"]) || row.version !== 1 ||
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
  listenerLive: boolean | null;
  credential: ListenerCredentialState | null;
  credentialReadFailed: boolean;
}

interface StoredStatusContext {
  instanceDirectory: string;
  paths: ListenerPaths;
  status: ListenerStatus;
}

interface HookContextDiscovery {
  contexts: ListenerHookContext[];
  requiresPrincipalScope: boolean;
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

async function discoverStoredStatusContexts(
  stateDirectory: string,
): Promise<StoredStatusContext[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(stateDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const contexts: StoredStatusContext[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !INSTANCE_KEY_RE.test(entry.name)) continue;
    const instanceDirectory = join(stateDirectory, entry.name);
    const storedStatus = await statusContext(
      stateDirectory,
      entry.name,
      instanceDirectory,
    );
    if (storedStatus !== null) {
      contexts.push({
        instanceDirectory,
        paths: storedStatus.paths,
        status: storedStatus.status,
      });
    }
  }
  return contexts;
}

/** Enumerate only principal identities authenticated by a valid local status.json. */
export async function discoverListenerHookPrincipalIds(
  stateDirectory = defaultListenerStateDirectory(),
): Promise<string[]> {
  if (!isAbsolute(stateDirectory)) return [];
  const stored = await discoverStoredStatusContexts(stateDirectory);
  return [...new Set(stored.map((context) => context.status.principalId))].sort();
}

async function discoverContexts(
  stateDirectory: string,
  principalIds: readonly string[] | undefined,
  isListenerLive: NonNullable<HookCheckOptions["isListenerLive"]> = listenerIsLive,
): Promise<HookContextDiscovery> {
  const storedContexts = await discoverStoredStatusContexts(stateDirectory);
  const availablePrincipals = new Set(
    storedContexts.map((context) => context.status.principalId),
  );
  let selectedPrincipals: Set<string>;
  if (principalIds === undefined) {
    if (availablePrincipals.size > 1) {
      return { contexts: [], requiresPrincipalScope: true };
    }
    selectedPrincipals = availablePrincipals;
  } else {
    if (principalIds.some((principalId) => !UUID_RE.test(principalId))) {
      return { contexts: [], requiresPrincipalScope: false };
    }
    selectedPrincipals = new Set(principalIds.map((principalId) => principalId.toLowerCase()));
  }
  const contexts: ListenerHookContext[] = [];
  for (const storedStatus of storedContexts) {
    if (!selectedPrincipals.has(storedStatus.status.principalId)) continue;
    const statusIsLive = await isListenerLive(storedStatus);
    if (statusIsLive === false) {
      contexts.push({
        instanceDirectory: storedStatus.instanceDirectory,
        paths: storedStatus.paths,
        status: storedStatus.status,
        listenerLive: false,
        credential: null,
        credentialReadFailed: false,
      });
      continue;
    }
    await deleteSecureJsonFile(
      join(storedStatus.instanceDirectory, RETIRED_HOOK_CREDENTIAL_FILE),
    ).catch(() => undefined);
    try {
      const credential = await readListenerCredentialState(storedStatus.instanceDirectory);
      contexts.push({
        instanceDirectory: storedStatus.instanceDirectory,
        paths: storedStatus.paths,
        status: storedStatus.status,
        listenerLive: statusIsLive,
        credential,
        credentialReadFailed: credential === null,
      });
    } catch {
      contexts.push({
        instanceDirectory: storedStatus.instanceDirectory,
        paths: storedStatus.paths,
        status: storedStatus.status,
        listenerLive: statusIsLive,
        credential: null,
        credentialReadFailed: true,
      });
    }
  }
  return { contexts, requiresPrincipalScope: false };
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
    ...((signal.attachments?.length ?? 0) > 0
      ? { attachmentCount: signal.attachments!.length }
      : {}),
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
    ...(item.attachmentCount === undefined
      ? []
      : [`Attachments: ${item.attachmentCount}. Run cswarm inbox to see names and exact retrieval commands.`]),
    `${replyLabel} cswarm reply ${item.signalId} "<answer>" --workspace-id ${item.workspaceId}`,
  ].join("\n");
}

/** Give hook and status output one restart command that preserves recorded routing. */
export function listenerRestartCommand(status: ListenerStatus): string {
  const routeMode = status.routeMode ?? "worker";
  return [
    "cswarm listen start",
    "--agent-token-stdin",
    `--workspace-id ${status.workspaceId}`,
    `--provider ${status.provider}`,
    ...(status.permissionMode ? [`--permissions ${status.permissionMode}`] : []),
    `--route ${routeMode}`,
    ...(routeMode === "split" && status.deferOverChars !== null &&
        status.deferOverChars !== undefined
      ? [`--defer-over ${status.deferOverChars}`]
      : []),
  ].join(" ");
}

function renderStrandedQueue(context: ListenerHookContext, count: number): string {
  const status = context.status!;
  const noun = count === 1 ? "message" : "messages";
  const verb = count === 1 ? "was" : "were";
  return `[CommonSwarm] ${count} ${noun} ${verb} waiting for agent ${status.principalId} ` +
    `in listener ${status.instanceId}, but that listener is no longer running. ` +
    "Restart it by piping the same agent credential into: " +
    listenerRestartCommand(status);
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
  /* THE RECIPIENT SET, not the scalar column.
   *
   * RETIRED 2026-09-05: this read `signal.to_agent === stored.principalId`. The
   * read edge has returned a signal to every agent the sender named since L2
   * (merge 060ff67) and the scalar column holds only the first, so a signal
   * naming this agent at position 1 was fetched and then dropped here. The
   * service now wakes that agent, so the session hook would have shown nothing
   * for a message the model was already answering. */
  const directed = page.signals.filter((signal) =>
    (signal.kind === "ask" || signal.kind === "note") &&
    signal.workspace_id === stored.workspaceId &&
    signalAddressesAgent(signal, stored.principalId)
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

async function brainDigestForCheck(
  check: ContextCheck,
  options: HookCheckOptions & { signal: AbortSignal; deadlineMs: number },
  now: () => number,
): Promise<string | null> {
  const stored = check.context.credential;
  if (
    stored === null || check.context.listenerLive === false || options.signal.aborted ||
    check.credentialFailure === "401"
  ) {
    return null;
  }
  try {
    const topics = await listBrainRowsAsAgent(
      cloudTarget(stored.targetUrl, stored.anonKey),
      stored.credential,
      stored.workspaceId,
      {
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        signal: options.signal,
        deadlineMs: options.deadlineMs,
        now,
      },
    );
    return await new FileBrainDigestStore(
      check.context.instanceDirectory,
      stored.principalId,
    ).consume(brainTopicSnapshots(topics));
  } catch {
    return null;
  }
}

async function recordQueuedObservations(
  check: ContextCheck,
  signalIds: readonly string[],
  options: HookCheckOptions & { signal: AbortSignal; deadlineMs: number },
  now: () => number,
): Promise<Set<string>> {
  const stored = check.context.credential;
  const remainingMs = options.deadlineMs - now();
  if (
    signalIds.length === 0 || stored === null || options.signal.aborted ||
    remainingMs <= 0
  ) {
    return new Set();
  }
  const client = new DeliveryCommandClient(
    cloudTarget(stored.targetUrl, stored.anonKey),
    options.fetcher ?? fetch,
    { deadlineMs: remainingMs, now },
  );
  const results = await Promise.all(signalIds.map(async (signalId) => {
    try {
      await client.observeQueuedAgentDelivery({
        workspaceId: stored.workspaceId,
        credential: stored.credential,
        commandId: observationCommandId(signalId),
        signalId,
      });
      return signalId;
    } catch {
      return null;
    }
  }));
  return new Set(results.filter((signalId): signalId is string => signalId !== null));
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
    const discovery = await discoverContexts(
      stateDirectory,
      options.principalIds,
      options.isListenerLive ?? listenerIsLive,
    );
    if (discovery.requiresPrincipalScope) {
      await (options.write ?? (() => undefined))(HOOK_MULTI_PRINCIPAL_GUIDANCE);
      return HOOK_MULTI_PRINCIPAL_GUIDANCE;
    }
    const contexts = discovery.contexts;
    if (contexts.length === 0) return "";
    let digestCandidate: ContextCheck | null = null;
    const networkAllowed = contexts.some((context) => context.listenerLive !== false)
      ? await reserveCheck(
        stateDirectory,
        cooldownSeconds * 1_000,
        now(),
      )
      : false;
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
        droppedCount: context.listenerLive === false ? 0 : stats.droppedCount,
        network,
        credentialFailure,
        credentialHealthy,
      };
    }));

    const commits: Array<{
      check: ContextCheck;
      store: FileHookSurfaceStore;
      signalIds: string[];
      plainPendingSignalIds: string[];
      observationPendingSignalIds: string[];
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
      const pendingSignalIds = new Set(check.pending.map((entry) => entry.signalId));
      const unseenPending = staged.unseen.filter((item) => pendingSignalIds.has(item.signalId));
      if (check.context.listenerLive === false && unseenPending.length > 0) {
        blocks.push(renderStrandedQueue(check.context, unseenPending.length));
      }
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
      /* The digest is DEFERRED, not computed here. Two defects the exact-review
       * arm measured on ea3cac4: it listed files even on a cooldown tick that
       * had skipped the network (inbox 1, files 2), and it ran BEFORE the write
       * — so a stalled brain list could spend the hook's 3s ceiling and kill
       * the process before pending asks reached stdout. Messages are the hook's
       * job; the digest is the optional extra and must never precede them. */
      if (checks.length === 1 && networkAllowed) digestCandidate = check;
      commits.push({
        check,
        store,
        signalIds: staged.unseen.map((item) => item.signalId),
        plainPendingSignalIds: check.pending
          .filter((item) => item.observationPending !== true)
          .map((item) => item.signalId),
        observationPendingSignalIds: check.pending
          .filter((item) => item.observationPending === true)
          .map((item) => item.signalId),
        reportDrops,
        reportCredentialFailure,
      });
    }
    const output = blocks.join("\n\n");
    if (output.length > 0) await (options.write ?? (() => undefined))(output);

    /* Signals are on stdout before the optional digest is even attempted. */
    let surfaced = output;
    if (digestCandidate !== null) {
      const brainDigest = await brainDigestForCheck(digestCandidate, options, now);
      if (brainDigest !== null) {
        const digestBlock = surfaced.length > 0 ? `\n\n${brainDigest}` : brainDigest;
        await (options.write ?? (() => undefined))(digestBlock);
        /* The return value is the contract for "what this hook surfaced", so it
         * carries the digest even though the digest was written second. */
        surfaced += digestBlock;
      }
    }

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
      // Stdout and the exact surfaced-id high-water are durable before this
      // network write. A failure therefore retains the queue entry for a silent
      // retry, while the high-water prevents the next hook from printing twice.
      const observedSignalIds = await recordQueuedObservations(
        commit.check,
        commit.observationPendingSignalIds,
        options,
        now,
      );
      const remainingCount = await commit.check.queue.remove(
        new Set([
          ...commit.plainPendingSignalIds,
          ...observedSignalIds,
        ]),
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
    return surfaced;
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
