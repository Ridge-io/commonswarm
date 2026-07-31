import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  readSecureJsonFile,
  writeSecureJsonFile,
} from "../cloud/storage.js";
import type {
  ListenerEffectRecord,
  ListenerEffectState,
  ListenerEffectStore,
} from "./types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,72}$/;
const MAX_EFFECT_BYTES = 32 * 1024;
const STATES = new Set<ListenerEffectState>([
  "received",
  "prompting",
  "reply_ready",
  "posting",
  "done",
  "expired",
  "failed",
]);
const RELATIONS = new Set(["same_owner", "cross_owner", "unknown"]);

/** Default secure state root for long-lived listener metadata and effects. */
export function defaultListenerStateDirectory(): string {
  return process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, "cswarm", "listeners")
    : join(homedir(), ".cswarm", "listeners");
}

/** Stable local instance key; provider is excluded so one principal has one listener. */
export function listenerInstanceKey(input: {
  profileId: string;
  workspaceId: string;
  principalId: string;
}): string {
  if (!UUID_RE.test(input.workspaceId) || !UUID_RE.test(input.principalId)) {
    throw new Error("listener workspace and principal ids must be UUIDs");
  }
  if (!input.profileId || input.profileId.includes("\0")) {
    throw new Error("listener profile id is invalid");
  }
  return createHash("sha256")
    .update(input.profileId)
    .update("\0")
    .update(input.workspaceId.toLowerCase())
    .update("\0")
    .update(input.principalId.toLowerCase())
    .digest("hex");
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nullableString(value: unknown, max: number): value is string | null {
  return value === null ||
    (typeof value === "string" && value.length <= max);
}

function parseEffect(raw: string, expectedId: string): ListenerEffectRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("stored listener effect is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored listener effect is malformed");
  }
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.signalId !== "string" ||
    row.signalId.toLowerCase() !== expectedId ||
    !UUID_RE.test(row.signalId) ||
    row.effectOrdinal !== 0 ||
    typeof row.commandId !== "string" ||
    !COMMAND_ID_RE.test(row.commandId) ||
    typeof row.askBody !== "string" ||
    row.askBody.length < 1 ||
    row.askBody.length > 2_000 ||
    typeof row.askUntil !== "string" ||
    !Number.isFinite(Date.parse(row.askUntil)) ||
    typeof row.senderOwnerRelation !== "string" ||
    !RELATIONS.has(row.senderOwnerRelation) ||
    typeof row.state !== "string" ||
    !STATES.has(row.state as ListenerEffectState) ||
    !integer(row.promptAttempts) ||
    !integer(row.postAttempts) ||
    !nullableString(row.replyBody, 2_000) ||
    typeof row.replyTruncated !== "boolean" ||
    !nullableString(row.replySignalId, 64) ||
    !nullableString(row.failureCode, 96) ||
    typeof row.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(row.updatedAt))
  ) {
    throw new Error("stored listener effect is malformed");
  }
  if (row.replySignalId !== null && !UUID_RE.test(row.replySignalId)) {
    throw new Error("stored listener effect is malformed");
  }
  return row as unknown as ListenerEffectRecord;
}

/** One secure atomic file per immutable signal effect. */
export class FileListenerEffectStore implements ListenerEffectStore {
  readonly instanceDirectory: string;
  private readonly effectsDirectory: string;

  constructor(options: {
    profileId: string;
    workspaceId: string;
    principalId: string;
    stateDirectory?: string;
  }) {
    const root = options.stateDirectory ?? defaultListenerStateDirectory();
    if (!isAbsolute(root)) {
      throw new Error("listener state directory must be absolute");
    }
    this.instanceDirectory = join(root, listenerInstanceKey(options));
    this.effectsDirectory = join(this.instanceDirectory, "effects");
  }

  async read(signalId: string): Promise<ListenerEffectRecord | null> {
    const id = this.checkedId(signalId);
    const raw = await readSecureJsonFile(
      join(this.effectsDirectory, `${id}.json`),
      MAX_EFFECT_BYTES,
    );
    return raw === null ? null : parseEffect(raw, id);
  }

  async write(record: ListenerEffectRecord): Promise<void> {
    const id = this.checkedId(record.signalId);
    const serialized = JSON.stringify(record);
    parseEffect(serialized, id);
    if (Buffer.byteLength(serialized, "utf8") > MAX_EFFECT_BYTES) {
      throw new Error("listener effect is too large");
    }
    await writeSecureJsonFile(
      join(this.effectsDirectory, `${id}.json`),
      serialized,
    );
  }

  private checkedId(signalId: string): string {
    if (!UUID_RE.test(signalId)) {
      throw new Error("listener signal id must be a UUID");
    }
    return signalId.toLowerCase();
  }
}

