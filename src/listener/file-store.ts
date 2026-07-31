import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  readSecureJsonFile,
  writeSecureJsonFile,
} from "../cloud/storage.js";
import type { SenderOwnerRelation } from "../cloud/command-client.js";
import type {
  ListenerEffectRecord,
  ListenerEffectState,
  ListenerEffectStore,
  ListenerSignalKind,
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
  "observed",
]);
const RELATIONS = new Set(["same_owner", "cross_owner", "unknown"]);
const SIGNAL_KINDS = new Set<ListenerSignalKind>(["ask", "note"]);

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

/**
 * Parse and validate one stored effect in memory. Version-1 ask files are
 * upcast to the version-2 shape with `signalKind: "ask"` — the durable file
 * is never rewritten on read, and the upcast only adds the discriminator.
 * Cross-field invariants fail closed: a note can never carry reply/post
 * effects, `observed` is terminal and note-only, and version 1 is ask-only.
 */
export function parseListenerEffectRecord(
  raw: string,
  expectedId: string,
): ListenerEffectRecord {
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
    typeof row.version !== "number" ||
    (row.version !== 1 && row.version !== 2) ||
    typeof row.signalId !== "string" ||
    row.signalId.toLowerCase() !== expectedId ||
    !UUID_RE.test(row.signalId)
  ) {
    throw new Error("stored listener effect is malformed");
  }
  if (row.version === 1) {
    // A real version-1 file never carried `signalKind`; it is ask-only, and
    // `observed` did not exist then. Reject both so a foreign/note-shaped row
    // cannot masquerade as a v1 ask.
    if ("signalKind" in row || row.state === "observed") {
      throw new Error("stored listener effect is malformed");
    }
    return upcastV1Ask(row);
  }
  return parseV2Record(row);
}

function upcastV1Ask(row: Record<string, unknown>): ListenerEffectRecord {
  if (
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
  // Preserve every v1 value exactly; only the schema version and the new
  // discriminator change, so the durable ask body/command identity is intact.
  return {
    ...(row as unknown as Omit<ListenerEffectRecord, "version" | "signalKind">),
    version: 2,
    signalKind: "ask",
  } as ListenerEffectRecord;
}

function parseV2Record(row: Record<string, unknown>): ListenerEffectRecord {
  const signalKind = row.signalKind;
  if (
    typeof signalKind !== "string" ||
    !SIGNAL_KINDS.has(signalKind as ListenerSignalKind) ||
    row.effectOrdinal !== 0 ||
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
  if (signalKind === "note") {
    // A direct note never enters the model: a terminal observed effect with
    // zero prompt/post attempts, no reply body or reply signal, and no reply
    // command id. Anything else is an invalid mixed state and fails closed.
    if (
      typeof row.commandId !== "string" ||
      row.commandId !== "" ||
      row.state !== "observed" ||
      row.promptAttempts !== 0 ||
      row.postAttempts !== 0 ||
      row.replyBody !== null ||
      row.replyTruncated !== false ||
      row.replySignalId !== null ||
      row.failureCode !== null
    ) {
      throw new Error("stored listener effect is malformed");
    }
  } else {
    // Asks keep the deterministic reply command id and never carry the
    // note-only observed state.
    if (
      typeof row.commandId !== "string" ||
      !COMMAND_ID_RE.test(row.commandId) ||
      row.state === "observed"
    ) {
      throw new Error("stored listener effect is malformed");
    }
    if (row.replySignalId !== null && !UUID_RE.test(row.replySignalId)) {
      throw new Error("stored listener effect is malformed");
    }
  }
  return row as unknown as ListenerEffectRecord;
}

/**
 * The terminal v2 effect a direct note receives before server ack in the
 * later claim/ack runtime: causal durability with zero model or reply effects.
 */
export function newObservedNoteRecord(input: {
  signalId: string;
  body: string;
  until: string;
  senderOwnerRelation: SenderOwnerRelation;
  updatedAt: string;
}): ListenerEffectRecord {
  if (!UUID_RE.test(input.signalId)) {
    throw new Error("listener note signal id must be a UUID");
  }
  if (input.body.length < 1 || input.body.length > 2_000) {
    throw new Error("listener note body is invalid");
  }
  if (!Number.isFinite(Date.parse(input.until))) {
    throw new Error("listener note until is not a timestamp");
  }
  if (!RELATIONS.has(input.senderOwnerRelation)) {
    throw new Error("listener note sender relation is invalid");
  }
  if (!Number.isFinite(Date.parse(input.updatedAt))) {
    throw new Error("listener note updatedAt is not a timestamp");
  }
  return {
    version: 2,
    signalId: input.signalId.toLowerCase(),
    signalKind: "note",
    effectOrdinal: 0,
    commandId: "",
    askBody: input.body,
    askUntil: input.until,
    senderOwnerRelation: input.senderOwnerRelation,
    state: "observed",
    promptAttempts: 0,
    postAttempts: 0,
    replyBody: null,
    replyTruncated: false,
    replySignalId: null,
    failureCode: null,
    updatedAt: input.updatedAt,
  };
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
    return raw === null ? null : parseListenerEffectRecord(raw, id);
  }

  async write(record: ListenerEffectRecord): Promise<void> {
    const id = this.checkedId(record.signalId);
    const serialized = JSON.stringify(record);
    parseListenerEffectRecord(serialized, id);
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

