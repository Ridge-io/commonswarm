import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SignalRecord } from "../cloud/command-client.js";
import { cloudTarget, type CloudTarget } from "../cloud/config.js";
import {
  readAgentSignalDirectory,
  readAgentSignalPage,
  type SignalDirectory,
} from "../cloud/signals.js";
import {
  readSecureJsonFile,
  withFileLock,
  writeSecureJsonFile,
} from "../cloud/storage.js";
import { defaultListenerStateDirectory } from "./file-store.js";
import {
  FilePendingMainQueue,
  type PendingMainEntry,
} from "./main-routing.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const INSTANCE_KEY_RE = /^[0-9a-f]{64}$/;
const MAX_HOOK_CREDENTIAL_BYTES = 8 * 1024;
const MAX_HOOK_SURFACE_BYTES = 128 * 1024;
const MAX_GLOBAL_STATE_BYTES = 4 * 1024;
const HOOK_CREDENTIAL_FILE = "hook-credential.json";
const HOOK_SURFACE_FILE = "hook-surface.json";
const GLOBAL_STATE_FILE = "hook-check.json";
const HOOK_SURFACE_LOCK = "hook-surface";
const GLOBAL_STATE_LOCK = "hook-check";
const HOOK_LOCK_TIMEOUT_MS = 250;

export const HOOK_CHECK_TIMEOUT_MS = 3_000;
export const HOOK_DEFAULT_COOLDOWN_SECONDS = 30;
export const HOOK_SURFACED_IDS_MAX = 1_024;
export const HOOK_BODY_PREVIEW_CHARS = 240;

export interface ListenerHookCredential {
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
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(row).length === expected.size &&
    Object.keys(row).every((key) => expected.has(key));
}

function parseHookCredential(raw: string): ListenerHookCredential {
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

/** Mirror only the listener's current bearer into its owned 0600 state directory. */
export async function writeListenerHookCredential(
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
  const record = parseHookCredential(JSON.stringify({
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
    join(instanceDirectory, HOOK_CREDENTIAL_FILE),
    JSON.stringify(record),
  );
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
    !exactKeys(row, ["version", "surfacedSignalIds"]) ||
    row.version !== 1 || !Array.isArray(row.surfacedSignalIds) ||
    row.surfacedSignalIds.length > HOOK_SURFACED_IDS_MAX ||
    row.surfacedSignalIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))
  ) {
    throw new Error("stored listener hook surface state is malformed");
  }
  const ids = row.surfacedSignalIds.map((id) => String(id).toLowerCase());
  if (new Set(ids).size !== ids.length) {
    throw new Error("stored listener hook surface state repeats a signal");
  }
  return { version: 1, surfacedSignalIds: ids };
}

/** Atomic high-water set: returned records have been marked before they can be printed. */
export class FileHookSurfaceStore {
  private readonly path: string;

  constructor(private readonly instanceDirectory: string) {
    if (!isAbsolute(instanceDirectory)) {
      throw new Error("listener hook surface directory must be absolute");
    }
    this.path = join(instanceDirectory, HOOK_SURFACE_FILE);
  }

  async claimUnseen<T extends { signalId: string }>(items: readonly T[]): Promise<T[]> {
    return await withFileLock(this.instanceDirectory, HOOK_SURFACE_LOCK, async () => {
      const raw = await readSecureJsonFile(this.path, MAX_HOOK_SURFACE_BYTES);
      const state = raw === null
        ? { version: 1 as const, surfacedSignalIds: [] }
        : parseSurface(raw);
      const seen = new Set(state.surfacedSignalIds);
      const unseen: T[] = [];
      for (const item of items) {
        const signalId = item.signalId.toLowerCase();
        if (!UUID_RE.test(signalId) || seen.has(signalId)) continue;
        seen.add(signalId);
        unseen.push(item);
      }
      if (unseen.length > 0) {
        const surfacedSignalIds = [...seen].slice(-HOOK_SURFACED_IDS_MAX);
        await writeSecureJsonFile(
          this.path,
          JSON.stringify(parseSurface(JSON.stringify({
            version: 1,
            surfacedSignalIds,
          }))),
        );
      }
      return unseen;
    }, { timeoutMs: HOOK_LOCK_TIMEOUT_MS });
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
  credential: ListenerHookCredential;
}

async function discoverContexts(stateDirectory: string): Promise<ListenerHookContext[]> {
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
    try {
      const raw = await readSecureJsonFile(
        join(instanceDirectory, HOOK_CREDENTIAL_FILE),
        MAX_HOOK_CREDENTIAL_BYTES,
      );
      if (raw !== null) {
        contexts.push({ instanceDirectory, credential: parseHookCredential(raw) });
      }
    } catch {
      // One damaged listener must not hide healthy listeners on the same machine.
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

/** Render untrusted teammate text only inside JSON quotes in a MESSAGE block. */
export function renderHookSignal(item: SurfaceItem): string {
  const sender = item.senderName === null ? item.fromId : item.senderName;
  return [
    `[CSWARM MESSAGE from ${item.fromKind} ${JSON.stringify(sender)}; workspace ${item.workspaceId}]`,
    preview(item.body),
    `operator reply command: cswarm reply ${item.signalId} "<answer>" --workspace-id ${item.workspaceId}`,
  ].join("\n");
}

async function pendingItems(contexts: readonly ListenerHookContext[]): Promise<SurfaceItem[]> {
  const surfaced: SurfaceItem[] = [];
  for (const context of contexts) {
    const queue = new FilePendingMainQueue(context.instanceDirectory);
    const pending = await queue.read();
    const store = new FileHookSurfaceStore(context.instanceDirectory);
    const unseen = await store.claimUnseen(pending);
    await queue.remove(
      new Set(pending.map((entry) => entry.signalId)),
      HOOK_LOCK_TIMEOUT_MS,
    );
    surfaced.push(...unseen);
  }
  return surfaced;
}

async function inboxItems(
  context: ListenerHookContext,
  options: { fetcher?: typeof fetch; signal: AbortSignal; deadlineMs: number; now: () => number },
): Promise<SurfaceItem[]> {
  const stored = context.credential;
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
  return await new FileHookSurfaceStore(context.instanceDirectory).claimUnseen(candidates);
}

/** Fail-silent hook body. The caller supplies the hard abort timer. */
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
    const contexts = await discoverContexts(stateDirectory);
    if (contexts.length === 0) return "";
    const pending = await pendingItems(contexts);
    if (!await reserveCheck(stateDirectory, cooldownSeconds * 1_000, now())) {
      return pending.map(renderHookSignal).join("\n\n");
    }
    if (options.signal.aborted) return pending.map(renderHookSignal).join("\n\n");
    const network = await Promise.all(contexts.map(async (context) => {
      try {
        return await inboxItems(context, {
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          signal: options.signal,
          deadlineMs: options.deadlineMs,
          now,
        });
      } catch {
        return [];
      }
    }));
    return [...pending, ...network.flat()].map(renderHookSignal).join("\n\n");
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
