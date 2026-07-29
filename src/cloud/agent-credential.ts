/*
 * Where a renewed agent credential lives between CLI invocations.
 *
 * WHY THIS FILE EXISTS AT ALL. An agent credential arrives on stdin and, until now, died
 * with the process. That is fine for a one-hour token and fatal for the thing the product
 * is actually for: a work session that runs for days or weeks. §2.3 answers it with a
 * fenced successor operation rather than a longer token, which only works if the successor
 * outlives the invocation that obtained it — so it has to be written down somewhere.
 *
 * THE PREDECESSOR IS NEVER WRITTEN HERE. Only the live successor is, under the same
 * discipline §2.3 requires of the CLI's own credential storage: a 0600 file inside a 0700
 * directory owned by the current user, atomically replaced, never an env var and never a
 * log line. `swm_agt_` material appears in exactly one field of one record and in no
 * message, no Error, and no filename.
 *
 * THE FILENAME IS A LINEAGE KEY, NOT A CREDENTIAL. The record has to be found again next
 * invocation, when all the process has is the same (by then expired) stdin credential. So
 * the file is named by sha256 of that root credential, truncated — the same one-way
 * derivation the server stores as token_hash. It reverses to nothing, and it means a
 * second agent handed a different credential on the same machine gets a different record
 * rather than silently adopting somebody else's successor.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CloudTarget } from "./config.js";
import {
  deleteSecureJsonFile,
  readSecureJsonFile,
  withFileLock,
  writeSecureJsonFile,
} from "./storage.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const MAX_RECORD_BYTES = 4 * 1024;

/**
 * One renewal lineage's current live credential. `rootTokenId` is what makes a stale
 * record detectable: a human who issues a fresh credential produces a new lineage key, but
 * a bare (non-artifact) credential carries no id, so the field is null there and the
 * lineage key alone has to carry it.
 */
export interface AgentCredentialRecord {
  version: 1;
  /**
   * The live SUCCESSOR secret, or null when no successor exists yet.
   *
   * ★ NULL IS A REAL STATE AND WRITING THE PREDECESSOR HERE INSTEAD IS A BUG. A renewal
   * whose outcome was lost has to record its command id (see pendingRenewal) BEFORE any
   * successor exists — otherwise the retry cannot be a replay, and a renewal that
   * committed unseen leaves an orphaned successor and a superseded predecessor, which is
   * the one way this feature can brick the agent it exists to keep alive. Filling this
   * field with the predecessor to satisfy the type would copy a secret the caller already
   * holds onto the disk for no benefit. So: null, and the reader below refuses to adopt it.
   */
  token: string | null;
  tokenId: string | null;
  principalId: string | null;
  runId: string | null;
  /** The token_id of the credential a human handed over; null for a bare token. */
  rootTokenId: string | null;
  /** Bumped on every write, so a concurrent renewal is detectable rather than silent. */
  generation: number;
  issuedAt: number;
  expiresAt: number | null;
  /** When a person must re-authorise. Null when the deployment did not say. */
  horizonExpiresAt: number | null;
  /** Successors this lineage may still obtain, as last reported. Null when unknown. */
  successorsRemaining: number | null;
  /**
   * A renewal whose outcome was never learned. Keeping its command id is what makes the
   * next attempt a REPLAY instead of a second successor — the same discipline
   * src/cloud/pending-command.ts applies to a mint, for the same reason.
   */
  pendingRenewal: { commandId: string; startedAt: number } | null;
}

export interface AgentCredentialStore {
  readonly location: string;
  read(): Promise<AgentCredentialRecord | null>;
  write(record: AgentCredentialRecord): Promise<void>;
  delete(): Promise<void>;
  withLock<T>(work: () => Promise<T>): Promise<T>;
}

/** The one-way lineage key. Exported so a test can prove it never contains the token. */
export function credentialLineageKey(rootToken: string): string {
  return createHash("sha256").update(rootToken).digest("hex").slice(0, 32);
}

export function defaultAgentCredentialDirectory(): string {
  const configured = process.env.SWARM_AGENT_STATE_DIR;
  if (configured) return configured;
  return process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, "cswarm", "agent-credentials")
    : join(homedir(), ".cswarm", "agent-credentials");
}

function parseAgentCredentialRecord(raw: string): AgentCredentialRecord {
  let value: Partial<AgentCredentialRecord>;
  try {
    value = JSON.parse(raw) as Partial<AgentCredentialRecord>;
  } catch {
    throw new Error("stored agent credential record is malformed");
  }
  if (
    value.version !== 1 ||
    !(
      value.token === null ||
      (typeof value.token === "string" && AGENT_TOKEN_RE.test(value.token))
    ) ||
    !(
      value.tokenId === null ||
      (typeof value.tokenId === "string" && UUID_RE.test(value.tokenId))
    ) ||
    !(
      value.principalId === null ||
      (typeof value.principalId === "string" && UUID_RE.test(value.principalId))
    ) ||
    !(
      value.runId === null ||
      (typeof value.runId === "string" && UUID_RE.test(value.runId))
    ) ||
    // A record naming a secret must name the token it belongs to, and vice versa; half of
    // an identity is a record no reader can check the lineage of.
    (value.token === null) !== (value.tokenId === null) ||
    !(
      value.rootTokenId === null ||
      (typeof value.rootTokenId === "string" && UUID_RE.test(value.rootTokenId))
    ) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation ?? -1) < 0 ||
    !Number.isSafeInteger(value.issuedAt) ||
    (value.issuedAt ?? -1) < 0 ||
    !(
      value.expiresAt === null ||
      (Number.isSafeInteger(value.expiresAt) && (value.expiresAt ?? -1) >= 0)
    ) ||
    // A live successor with no deadline could never be renewed on time.
    (value.token !== null && value.expiresAt === null) ||
    !(
      value.horizonExpiresAt === null ||
      (Number.isSafeInteger(value.horizonExpiresAt) &&
        (value.horizonExpiresAt ?? -1) >= 0)
    ) ||
    !(
      value.successorsRemaining === null ||
      (Number.isSafeInteger(value.successorsRemaining) &&
        (value.successorsRemaining ?? -1) >= 0)
    ) ||
    !isPendingRenewal(value.pendingRenewal)
  ) {
    throw new Error("stored agent credential record is malformed");
  }
  // Normalized rather than passed through, so every reader sees `null` and not the
  // absence of a key it forgot could be absent.
  return { ...value, pendingRenewal: value.pendingRenewal ?? null } as
    AgentCredentialRecord;
}

function isPendingRenewal(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.commandId === "string" &&
    /^ren_[A-Za-z0-9_-]{8,64}$/.test(record.commandId) &&
    Number.isSafeInteger(record.startedAt) &&
    (record.startedAt as number) >= 0
  );
}

/**
 * Opens the store for one lineage. Separate from the human credential store because the
 * two protect different secrets with different lifetimes, and because sharing a file would
 * make a logged-out human silently delete a running agent's live credential.
 */
export async function agentCredentialStore(options: {
  target: CloudTarget;
  lineageKey: string;
  stateDirectory?: string;
}): Promise<AgentCredentialStore> {
  if (!/^[0-9a-f]{32}$/.test(options.lineageKey)) {
    throw new Error("agent credential lineage key must be 32 lowercase hex characters");
  }
  const directory = options.stateDirectory ?? defaultAgentCredentialDirectory();
  if (!isAbsolute(directory)) {
    throw new Error("agent credential state directory must be an absolute path");
  }
  const name = `successor-${options.target.profileId}-${options.lineageKey}`;
  const location = join(directory, `${name}.json`);
  return {
    location,
    async read(): Promise<AgentCredentialRecord | null> {
      const raw = await readSecureJsonFile(location, MAX_RECORD_BYTES);
      return raw === null ? null : parseAgentCredentialRecord(raw);
    },
    async write(record: AgentCredentialRecord): Promise<void> {
      const serialized = JSON.stringify(
        parseAgentCredentialRecord(JSON.stringify(record)),
      );
      await writeSecureJsonFile(location, serialized);
    },
    async delete(): Promise<void> {
      await deleteSecureJsonFile(location);
    },
    async withLock<T>(work: () => Promise<T>): Promise<T> {
      return await withFileLock(directory, name, work);
    },
  };
}
