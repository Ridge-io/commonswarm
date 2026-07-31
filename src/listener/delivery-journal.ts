/**
 * Delivery journal for listener crash-recovery and claim/ACK durability (§6, §7).
 */

import { isAbsolute, join } from "node:path";
import { types } from "node:util";
import {
  readSecureJsonFile,
  withFileLock,
  writeSecureJsonFile,
} from "../cloud/storage.js";
import {
  defaultListenerStateDirectory,
  listenerInstanceKey,
} from "./file-store.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,72}$/;
const MAX_JOURNAL_BYTES = 8192;
const ISO_8601_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-]\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12:
      return 31;
    case 4: case 6: case 9: case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_8601_RE.exec(value);
  if (!match) return false;

  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);
  const hour = parseInt(match[4]!, 10);
  const minute = parseInt(match[5]!, 10);
  const second = parseInt(match[6]!, 10);

  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59 ||
    second < 0 || second > 59
  ) {
    return false;
  }

  if (match[7] !== undefined && match[8] !== undefined) {
    const offsetHour = Math.abs(parseInt(match[7], 10));
    const offsetMin = parseInt(match[8], 10);
    if (offsetHour > 23 || offsetMin < 0 || offsetMin > 59) {
      return false;
    }
  }

  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;

  return true;
}

export interface ListenerActiveClaim {
  phase: "claim_pending" | "leased" | "ack_pending";
  claimOrdinal: number;
  claimCommandId: string;
  claimCreatedAt: string;
  claimLastAttemptAt: string | null;
  signalId: string | null;
  leaseId: string | null;
  leasedUntil: string | null;
  ack: null | {
    commandId: string;
    outcome: "replied" | "observed" | "expired" | "failed_terminal";
    lastErrorCode:
      | "provider_refused"
      | "local_effect_failed"
      | "host_session_failed"
      | "credential_unavailable"
      | null;
    preparedAt: string;
  };
}

export interface ListenerDeliveryJournalRecord {
  version: 1;
  workspaceId: string;
  principalId: string;
  listenerInstanceId: string;
  nextClaimOrdinal: number;
  active: null | ListenerActiveClaim;
  updatedAt: string;
}

export interface RecordLeaseInput {
  signalId: string;
  leaseId: string;
  leasedUntil: string;
  now?: string;
}

export interface PrepareAckInput {
  outcome: "replied" | "observed" | "expired" | "failed_terminal";
  lastErrorCode:
    | "provider_refused"
    | "local_effect_failed"
    | "host_session_failed"
    | "credential_unavailable"
    | null;
  preparedAt?: string;
  now?: string;
}

export interface ListenerDeliveryJournal {
  readonly instanceDirectory: string;
  readonly journalPath: string;
  read(): Promise<ListenerDeliveryJournalRecord>;
  reserveClaim(now?: string): Promise<ListenerActiveClaim>;
  recordClaimAttempt(now?: string): Promise<void>;
  recordLease(input: RecordLeaseInput): Promise<void>;
  prepareAck(input: PrepareAckInput): Promise<void>;
  clearActive(now?: string): Promise<void>;
}

export interface OpenListenerDeliveryJournalOptions {
  profileId: string;
  workspaceId: string;
  principalId: string;
  proposedListenerInstanceId: string;
  stateDirectory?: string;
  now?: string;
}

export interface SelectedListenerDeliveryJournal {
  journal: ListenerDeliveryJournal;
  record: ListenerDeliveryJournalRecord;
  listenerInstanceId: string;
}

const ALLOWED_TOP_KEYS = new Set([
  "version",
  "workspaceId",
  "principalId",
  "listenerInstanceId",
  "nextClaimOrdinal",
  "active",
  "updatedAt",
]);

const ALLOWED_ACTIVE_KEYS = new Set([
  "phase",
  "claimOrdinal",
  "claimCommandId",
  "claimCreatedAt",
  "claimLastAttemptAt",
  "signalId",
  "leaseId",
  "leasedUntil",
  "ack",
]);

const ALLOWED_ACK_KEYS = new Set([
  "commandId",
  "outcome",
  "lastErrorCode",
  "preparedAt",
]);

const ALLOWED_PHASES = new Set(["claim_pending", "leased", "ack_pending"]);
const ALLOWED_OUTCOMES = new Set([
  "replied",
  "observed",
  "expired",
  "failed_terminal",
]);
const ALLOWED_ERROR_CODES = new Set([
  "provider_refused",
  "local_effect_failed",
  "host_session_failed",
  "credential_unavailable",
]);

/** Generate deterministic claim command ID for listener instance and ordinal (§7). */
export function claimCommandId(
  listenerInstanceId: string,
  claimOrdinal: number,
): string {
  if (!UUID_RE.test(listenerInstanceId)) {
    throw new Error("stored delivery journal is malformed");
  }
  if (!Number.isSafeInteger(claimOrdinal) || claimOrdinal < 0) {
    throw new Error("stored delivery journal is malformed");
  }
  const cleanUuid = listenerInstanceId.toLowerCase().replace(/-/g, "");
  const base36Ordinal = claimOrdinal.toString(36);
  const id = `claim_${cleanUuid}_${base36Ordinal}`;
  if (!COMMAND_ID_RE.test(id)) {
    throw new Error("stored delivery journal is malformed");
  }
  return id;
}

/** Generate deterministic ACK command ID for lease UUID (§7). */
export function ackCommandId(leaseId: string): string {
  if (!UUID_RE.test(leaseId)) {
    throw new Error("stored delivery journal is malformed");
  }
  const cleanLease = leaseId.toLowerCase().replace(/-/g, "");
  const id = `ack_${cleanLease}`;
  if (!COMMAND_ID_RE.test(id)) {
    throw new Error("stored delivery journal is malformed");
  }
  return id;
}


function assertPlainObject(
  input: unknown,
  allowedKeys: string[],
  requiredKeys: string[],
  errMessage = "delivery journal mutation rejected",
): Record<string, unknown> {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error(errMessage);
    }
    if (types.isProxy(input)) {
      throw new Error(errMessage);
    }
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(errMessage);
    }
    if (Object.getOwnPropertySymbols(input).length > 0) {
      throw new Error(errMessage);
    }
    const ownProps = Object.getOwnPropertyNames(input);
    const allowedSet = new Set(allowedKeys);
    for (const prop of ownProps) {
      if (!allowedSet.has(prop)) {
        throw new Error(errMessage);
      }
      const desc = Object.getOwnPropertyDescriptor(input, prop);
      if (!desc || !desc.enumerable || desc.get !== undefined || desc.set !== undefined) {
        throw new Error(errMessage);
      }
    }
    for (const req of requiredKeys) {
      if (!ownProps.includes(req)) {
        throw new Error(errMessage);
      }
    }
    return input as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.message === errMessage) {
      throw err;
    }
    throw new Error(errMessage);
  }
}

export function parseJournalRecord(
  raw: string,
  expectedWorkspaceId?: string,
  expectedPrincipalId?: string,
): ListenerDeliveryJournalRecord {
  if (Buffer.byteLength(raw, "utf8") > MAX_JOURNAL_BYTES) {
    throw new Error("stored delivery journal is malformed");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("stored delivery journal is malformed");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("stored delivery journal is malformed");
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("stored delivery journal is malformed");
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("stored delivery journal is malformed");
  }

  const ownProps = Object.getOwnPropertyNames(value);
  if (
    ownProps.length !== ALLOWED_TOP_KEYS.size ||
    !ownProps.every((p) => ALLOWED_TOP_KEYS.has(p))
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  for (const prop of ownProps) {
    const desc = Object.getOwnPropertyDescriptor(value, prop);
    if (!desc || !desc.enumerable || desc.get !== undefined || desc.set !== undefined) {
      throw new Error("stored delivery journal is malformed");
    }
  }

  const row = value as Record<string, unknown>;

  if (row.version !== 1) {
    throw new Error("stored delivery journal is malformed");
  }

  if (
    typeof row.workspaceId !== "string" ||
    !UUID_RE.test(row.workspaceId) ||
    row.workspaceId !== row.workspaceId.toLowerCase()
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  if (
    expectedWorkspaceId &&
    row.workspaceId !== expectedWorkspaceId.toLowerCase()
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  if (
    typeof row.principalId !== "string" ||
    !UUID_RE.test(row.principalId) ||
    row.principalId !== row.principalId.toLowerCase()
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  if (
    expectedPrincipalId &&
    row.principalId !== expectedPrincipalId.toLowerCase()
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  if (
    typeof row.listenerInstanceId !== "string" ||
    !UUID_RE.test(row.listenerInstanceId) ||
    row.listenerInstanceId !== row.listenerInstanceId.toLowerCase()
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  if (
    !Number.isSafeInteger(row.nextClaimOrdinal) ||
    (row.nextClaimOrdinal as number) < 0
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  if (!isValidIsoTimestamp(row.updatedAt)) {
    throw new Error("stored delivery journal is malformed");
  }

  if (row.active === null) {
    return row as unknown as ListenerDeliveryJournalRecord;
  }

  if (
    typeof row.active !== "object" ||
    row.active === null ||
    Array.isArray(row.active)
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  const activeProto = Object.getPrototypeOf(row.active);
  if (activeProto !== Object.prototype && activeProto !== null) {
    throw new Error("stored delivery journal is malformed");
  }

  if (Object.getOwnPropertySymbols(row.active).length > 0) {
    throw new Error("stored delivery journal is malformed");
  }

  const activeProps = Object.getOwnPropertyNames(row.active);
  if (
    activeProps.length !== ALLOWED_ACTIVE_KEYS.size ||
    !activeProps.every((p) => ALLOWED_ACTIVE_KEYS.has(p))
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  for (const prop of activeProps) {
    const desc = Object.getOwnPropertyDescriptor(row.active, prop);
    if (!desc || !desc.enumerable || desc.get !== undefined || desc.set !== undefined) {
      throw new Error("stored delivery journal is malformed");
    }
  }

  const active = row.active as Record<string, unknown>;

  if (
    typeof active.phase !== "string" ||
    !ALLOWED_PHASES.has(active.phase)
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  if (
    !Number.isSafeInteger(active.claimOrdinal) ||
    (active.claimOrdinal as number) < 0 ||
    (active.claimOrdinal as number) >= (row.nextClaimOrdinal as number)
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  if (
    typeof active.claimCommandId !== "string" ||
    !COMMAND_ID_RE.test(active.claimCommandId)
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  const expectedClaimCmdId = claimCommandId(
    row.listenerInstanceId as string,
    active.claimOrdinal as number,
  );
  if (active.claimCommandId !== expectedClaimCmdId) {
    throw new Error("stored delivery journal is malformed");
  }

  if (!isValidIsoTimestamp(active.claimCreatedAt)) {
    throw new Error("stored delivery journal is malformed");
  }

  if (
    active.claimLastAttemptAt !== null &&
    !isValidIsoTimestamp(active.claimLastAttemptAt)
  ) {
    throw new Error("stored delivery journal is malformed");
  }

  if (active.phase === "claim_pending") {
    if (
      active.signalId !== null ||
      active.leaseId !== null ||
      active.leasedUntil !== null ||
      active.ack !== null
    ) {
      throw new Error("stored delivery journal is malformed");
    }
  } else {
    // phase is "leased" or "ack_pending"
    if (active.claimLastAttemptAt === null) {
      throw new Error("stored delivery journal is malformed");
    }

    if (
      typeof active.signalId !== "string" ||
      !UUID_RE.test(active.signalId) ||
      active.signalId !== active.signalId.toLowerCase()
    ) {
      throw new Error("stored delivery journal is malformed");
    }

    if (
      typeof active.leaseId !== "string" ||
      !UUID_RE.test(active.leaseId) ||
      active.leaseId !== active.leaseId.toLowerCase()
    ) {
      throw new Error("stored delivery journal is malformed");
    }

    if (
      !isValidIsoTimestamp(active.leasedUntil) ||
      Date.parse(active.leasedUntil as string) <=
        Date.parse(active.claimCreatedAt as string)
    ) {
      throw new Error("stored delivery journal is malformed");
    }

    if (active.phase === "leased") {
      if (active.ack !== null) {
        throw new Error("stored delivery journal is malformed");
      }
    } else if (active.phase === "ack_pending") {
      if (
        typeof active.ack !== "object" ||
        active.ack === null ||
        Array.isArray(active.ack)
      ) {
        throw new Error("stored delivery journal is malformed");
      }

      const ackProto = Object.getPrototypeOf(active.ack);
      if (ackProto !== Object.prototype && ackProto !== null) {
        throw new Error("stored delivery journal is malformed");
      }

      if (Object.getOwnPropertySymbols(active.ack).length > 0) {
        throw new Error("stored delivery journal is malformed");
      }

      const ackProps = Object.getOwnPropertyNames(active.ack);
      if (
        ackProps.length !== ALLOWED_ACK_KEYS.size ||
        !ackProps.every((p) => ALLOWED_ACK_KEYS.has(p))
      ) {
        throw new Error("stored delivery journal is malformed");
      }

      for (const prop of ackProps) {
        const desc = Object.getOwnPropertyDescriptor(active.ack, prop);
        if (!desc || !desc.enumerable || desc.get !== undefined || desc.set !== undefined) {
          throw new Error("stored delivery journal is malformed");
        }
      }

      const ack = active.ack as Record<string, unknown>;

      if (
        typeof ack.commandId !== "string" ||
        !COMMAND_ID_RE.test(ack.commandId)
      ) {
        throw new Error("stored delivery journal is malformed");
      }

      const expectedAckCmdId = ackCommandId(active.leaseId as string);
      if (ack.commandId !== expectedAckCmdId) {
        throw new Error("stored delivery journal is malformed");
      }

      if (
        typeof ack.outcome !== "string" ||
        !ALLOWED_OUTCOMES.has(ack.outcome as string)
      ) {
        throw new Error("stored delivery journal is malformed");
      }

      if (ack.outcome === "failed_terminal") {
        if (
          typeof ack.lastErrorCode !== "string" ||
          !ALLOWED_ERROR_CODES.has(ack.lastErrorCode as string)
        ) {
          throw new Error("stored delivery journal is malformed");
        }
      } else {
        if (ack.lastErrorCode !== null) {
          throw new Error("stored delivery journal is malformed");
        }
      }

      if (!isValidIsoTimestamp(ack.preparedAt)) {
        throw new Error("stored delivery journal is malformed");
      }
    }
  }

  return row as unknown as ListenerDeliveryJournalRecord;
}

class FileListenerDeliveryJournal implements ListenerDeliveryJournal {
  readonly instanceDirectory: string;
  readonly journalPath: string;
  private readonly options: Readonly<{
    profileId: string;
    workspaceId: string;
    principalId: string;
    stateDirectory?: string;
  }>;

  constructor(options: {
    profileId: string;
    workspaceId: string;
    principalId: string;
    stateDirectory?: string;
  }) {
    assertPlainObject(
      options,
      ["profileId", "workspaceId", "principalId", "stateDirectory"],
      ["profileId", "workspaceId", "principalId"],
      "delivery journal configuration rejected",
    );

    if (
      typeof options.profileId !== "string" ||
      !options.profileId ||
      options.profileId.includes("\0") ||
      typeof options.workspaceId !== "string" ||
      !UUID_RE.test(options.workspaceId) ||
      typeof options.principalId !== "string" ||
      !UUID_RE.test(options.principalId)
    ) {
      throw new Error("delivery journal configuration rejected");
    }

    if (options.stateDirectory !== undefined) {
      if (
        typeof options.stateDirectory !== "string" ||
        options.stateDirectory.length === 0 ||
        options.stateDirectory.includes("\0")
      ) {
        throw new Error("delivery journal configuration rejected");
      }
    }

    this.options = Object.freeze({
      profileId: options.profileId,
      workspaceId: options.workspaceId.toLowerCase(),
      principalId: options.principalId.toLowerCase(),
      stateDirectory: options.stateDirectory,
    });

    const root = this.options.stateDirectory ?? defaultListenerStateDirectory();
    if (!isAbsolute(root)) {
      throw new Error("delivery journal configuration rejected");
    }
    this.instanceDirectory = join(root, listenerInstanceKey(this.options));
    this.journalPath = join(this.instanceDirectory, "delivery-journal.json");
  }

  private async readRecordUnlocked(): Promise<ListenerDeliveryJournalRecord> {
    let raw: string | null;
    try {
      raw = await readSecureJsonFile(this.journalPath, MAX_JOURNAL_BYTES);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("stored record is larger") ||
          error.message.includes("larger than this store accepts"))
      ) {
        throw new Error("stored delivery journal is malformed");
      }
      throw error;
    }

    if (raw === null) {
      throw new Error("stored delivery journal does not exist");
    }
    return parseJournalRecord(
      raw,
      this.options.workspaceId,
      this.options.principalId,
    );
  }

  async read(): Promise<ListenerDeliveryJournalRecord> {
    return await this.readRecordUnlocked();
  }

  private withLock<T>(work: () => Promise<T>): Promise<T> {
    return withFileLock(this.instanceDirectory, "delivery-journal", work);
  }

  private async writeRecordUnlocked(
    record: ListenerDeliveryJournalRecord,
  ): Promise<void> {
    const serialized = JSON.stringify(record);
    parseJournalRecord(
      serialized,
      this.options.workspaceId,
      this.options.principalId,
    );
    await writeSecureJsonFile(this.journalPath, serialized);
  }

  async reserveClaim(now?: string): Promise<ListenerActiveClaim> {
    const nowTimestamp = now ?? new Date().toISOString();
    if (!isValidIsoTimestamp(nowTimestamp)) {
      throw new Error("delivery journal mutation rejected");
    }

    return await this.withLock(async () => {
      const current = await this.readRecordUnlocked();
      if (current.active !== null) {
        throw new Error("delivery journal state conflict");
      }

      const ordinal = current.nextClaimOrdinal;
      const cmdId = claimCommandId(current.listenerInstanceId, ordinal);

      const activeClaim: ListenerActiveClaim = {
        phase: "claim_pending",
        claimOrdinal: ordinal,
        claimCommandId: cmdId,
        claimCreatedAt: nowTimestamp,
        claimLastAttemptAt: null,
        signalId: null,
        leaseId: null,
        leasedUntil: null,
        ack: null,
      };

      const updatedRecord: ListenerDeliveryJournalRecord = {
        ...current,
        nextClaimOrdinal: ordinal + 1,
        active: activeClaim,
        updatedAt: nowTimestamp,
      };

      await this.writeRecordUnlocked(updatedRecord);
      return activeClaim;
    });
  }

  async recordClaimAttempt(now?: string): Promise<void> {
    const nowTimestamp = now ?? new Date().toISOString();
    if (!isValidIsoTimestamp(nowTimestamp)) {
      throw new Error("delivery journal mutation rejected");
    }

    return await this.withLock(async () => {
      const current = await this.readRecordUnlocked();
      if (current.active === null) {
        throw new Error("delivery journal state conflict");
      }

      if (current.active.phase === "ack_pending") {
        throw new Error("delivery journal state conflict");
      }

      const updatedActive: ListenerActiveClaim = {
        ...current.active,
        claimLastAttemptAt: nowTimestamp,
      };

      const updatedRecord: ListenerDeliveryJournalRecord = {
        ...current,
        active: updatedActive,
        updatedAt: nowTimestamp,
      };

      await this.writeRecordUnlocked(updatedRecord);
    });
  }

  async recordLease(input: RecordLeaseInput): Promise<void> {
    assertPlainObject(
      input,
      ["signalId", "leaseId", "leasedUntil", "now"],
      ["signalId", "leaseId", "leasedUntil"],
      "delivery journal mutation rejected",
    );

    if (
      typeof input.signalId !== "string" ||
      !UUID_RE.test(input.signalId) ||
      typeof input.leaseId !== "string" ||
      !UUID_RE.test(input.leaseId) ||
      !isValidIsoTimestamp(input.leasedUntil)
    ) {
      throw new Error("delivery journal mutation rejected");
    }

    const canonicalSignalId = input.signalId.toLowerCase();
    const canonicalLeaseId = input.leaseId.toLowerCase();
    const leasedUntilSnapshot = input.leasedUntil;
    const nowInput = input.now;

    const nowTimestamp = nowInput ?? new Date().toISOString();
    if (!isValidIsoTimestamp(nowTimestamp)) {
      throw new Error("delivery journal mutation rejected");
    }

    return await this.withLock(async () => {
      const current = await this.readRecordUnlocked();
      if (current.active === null) {
        throw new Error("delivery journal state conflict");
      }

      if (Date.parse(leasedUntilSnapshot) <= Date.parse(current.active.claimCreatedAt)) {
        throw new Error("delivery journal mutation rejected");
      }

      if (current.active.phase === "leased") {
        if (
          current.active.signalId === canonicalSignalId &&
          current.active.leaseId === canonicalLeaseId &&
          current.active.leasedUntil === leasedUntilSnapshot
        ) {
          return;
        }
        throw new Error("delivery journal state conflict");
      }

      if (current.active.phase !== "claim_pending") {
        throw new Error("delivery journal state conflict");
      }

      const updatedActive: ListenerActiveClaim = {
        ...current.active,
        phase: "leased",
        claimLastAttemptAt: current.active.claimLastAttemptAt ?? nowTimestamp,
        signalId: canonicalSignalId,
        leaseId: canonicalLeaseId,
        leasedUntil: leasedUntilSnapshot,
      };

      const updatedRecord: ListenerDeliveryJournalRecord = {
        ...current,
        active: updatedActive,
        updatedAt: nowTimestamp,
      };

      await this.writeRecordUnlocked(updatedRecord);
    });
  }

  async prepareAck(input: PrepareAckInput): Promise<void> {
    assertPlainObject(
      input,
      ["outcome", "lastErrorCode", "preparedAt", "now"],
      ["outcome", "lastErrorCode"],
      "delivery journal mutation rejected",
    );

    if (
      typeof input.outcome !== "string" ||
      !ALLOWED_OUTCOMES.has(input.outcome)
    ) {
      throw new Error("delivery journal mutation rejected");
    }

    if (input.outcome === "failed_terminal") {
      if (
        typeof input.lastErrorCode !== "string" ||
        !ALLOWED_ERROR_CODES.has(input.lastErrorCode)
      ) {
        throw new Error("delivery journal mutation rejected");
      }
    } else {
      if (input.lastErrorCode !== null) {
        throw new Error("delivery journal mutation rejected");
      }
    }

    const outcomeSnapshot = input.outcome;
    const lastErrorCodeSnapshot = input.lastErrorCode;
    const preparedAtInput = input.preparedAt;
    const nowInput = input.now;

    const nowTimestamp = nowInput ?? new Date().toISOString();
    if (!isValidIsoTimestamp(nowTimestamp)) {
      throw new Error("delivery journal mutation rejected");
    }

    const preparedAtSnapshot = preparedAtInput ?? nowTimestamp;
    if (!isValidIsoTimestamp(preparedAtSnapshot)) {
      throw new Error("delivery journal mutation rejected");
    }

    return await this.withLock(async () => {
      const current = await this.readRecordUnlocked();
      if (current.active === null) {
        throw new Error("delivery journal state conflict");
      }

      if (current.active.phase === "ack_pending") {
        if (
          current.active.ack &&
          current.active.ack.outcome === outcomeSnapshot &&
          current.active.ack.lastErrorCode === lastErrorCodeSnapshot
        ) {
          return;
        }
        throw new Error("delivery journal state conflict");
      }

      if (current.active.phase !== "leased") {
        throw new Error("delivery journal state conflict");
      }

      const ackCmdId = ackCommandId(current.active.leaseId!);

      const updatedActive: ListenerActiveClaim = {
        ...current.active,
        phase: "ack_pending",
        ack: {
          commandId: ackCmdId,
          outcome: outcomeSnapshot,
          lastErrorCode: lastErrorCodeSnapshot,
          preparedAt: preparedAtSnapshot,
        },
      };

      const updatedRecord: ListenerDeliveryJournalRecord = {
        ...current,
        active: updatedActive,
        updatedAt: nowTimestamp,
      };

      await this.writeRecordUnlocked(updatedRecord);
    });
  }

  async clearActive(now?: string): Promise<void> {
    const nowTimestamp = now ?? new Date().toISOString();
    if (!isValidIsoTimestamp(nowTimestamp)) {
      throw new Error("delivery journal mutation rejected");
    }

    return await this.withLock(async () => {
      const current = await this.readRecordUnlocked();
      const updatedRecord: ListenerDeliveryJournalRecord = {
        ...current,
        active: null,
        updatedAt: nowTimestamp,
      };

      await this.writeRecordUnlocked(updatedRecord);
    });
  }
}

/**
 * Open or initialize the delivery journal for a logical listener (§5, §6).
 * Documented: The caller MUST hold the existing lifetime/start lock before calling this.
 */
export async function openListenerDeliveryJournal(
  options: OpenListenerDeliveryJournalOptions,
): Promise<SelectedListenerDeliveryJournal> {
  assertPlainObject(
    options,
    ["profileId", "workspaceId", "principalId", "proposedListenerInstanceId", "stateDirectory", "now"],
    ["profileId", "workspaceId", "principalId", "proposedListenerInstanceId"],
    "delivery journal configuration rejected",
  );

  if (
    typeof options.profileId !== "string" ||
    !options.profileId ||
    options.profileId.includes("\0") ||
    typeof options.workspaceId !== "string" ||
    !UUID_RE.test(options.workspaceId) ||
    typeof options.principalId !== "string" ||
    !UUID_RE.test(options.principalId) ||
    typeof options.proposedListenerInstanceId !== "string" ||
    !UUID_RE.test(options.proposedListenerInstanceId)
  ) {
    throw new Error("delivery journal configuration rejected");
  }

  if (options.stateDirectory !== undefined) {
    if (
      typeof options.stateDirectory !== "string" ||
      options.stateDirectory.length === 0 ||
      options.stateDirectory.includes("\0")
    ) {
      throw new Error("delivery journal configuration rejected");
    }
  }

  const profileIdSnapshot = options.profileId;
  const workspaceIdSnapshot = options.workspaceId.toLowerCase();
  const principalIdSnapshot = options.principalId.toLowerCase();
  const proposedInstanceIdSnapshot = options.proposedListenerInstanceId.toLowerCase();
  const stateDirectorySnapshot = options.stateDirectory;
  const nowInput = options.now;

  const nowTimestamp = nowInput ?? new Date().toISOString();
  if (!isValidIsoTimestamp(nowTimestamp)) {
    throw new Error("delivery journal configuration rejected");
  }

  const journal = new FileListenerDeliveryJournal({
    profileId: profileIdSnapshot,
    workspaceId: workspaceIdSnapshot,
    principalId: principalIdSnapshot,
    stateDirectory: stateDirectorySnapshot,
  });

  return await withFileLock(journal.instanceDirectory, "delivery-journal", async () => {
    let raw: string | null;
    try {
      raw = await readSecureJsonFile(journal.journalPath, MAX_JOURNAL_BYTES);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("stored record is larger") ||
          error.message.includes("larger than this store accepts"))
      ) {
        throw new Error("stored delivery journal is malformed");
      }
      throw error;
    }

    if (raw === null) {
      const record: ListenerDeliveryJournalRecord = {
        version: 1,
        workspaceId: workspaceIdSnapshot,
        principalId: principalIdSnapshot,
        listenerInstanceId: proposedInstanceIdSnapshot,
        nextClaimOrdinal: 0,
        active: null,
        updatedAt: nowTimestamp,
      };
      const serialized = JSON.stringify(record);
      parseJournalRecord(
        serialized,
        workspaceIdSnapshot,
        principalIdSnapshot,
      );
      await writeSecureJsonFile(journal.journalPath, serialized);
      return {
        journal,
        record,
        listenerInstanceId: record.listenerInstanceId,
      };
    }

    const existingRecord = parseJournalRecord(
      raw,
      workspaceIdSnapshot,
      principalIdSnapshot,
    );

    if (existingRecord.active !== null) {
      return {
        journal,
        record: existingRecord,
        listenerInstanceId: existingRecord.listenerInstanceId,
      };
    }

    const freshRecord: ListenerDeliveryJournalRecord = {
      version: 1,
      workspaceId: workspaceIdSnapshot,
      principalId: principalIdSnapshot,
      listenerInstanceId: proposedInstanceIdSnapshot,
      nextClaimOrdinal: 0,
      active: null,
      updatedAt: nowTimestamp,
    };
    const serialized = JSON.stringify(freshRecord);
    parseJournalRecord(
      serialized,
      workspaceIdSnapshot,
      principalIdSnapshot,
    );
    await writeSecureJsonFile(journal.journalPath, serialized);
    return {
      journal,
      record: freshRecord,
      listenerInstanceId: freshRecord.listenerInstanceId,
    };
  });
}
