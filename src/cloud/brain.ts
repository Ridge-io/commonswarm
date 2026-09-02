/*
 * Workspace-brain names live inside the existing file-artifact namespace.
 *
 * The files table permits any 1..255-character name, but the file command's
 * effective name rule rejects `/` (supabase/functions/command/file-artifacts.ts).
 * `brain--<topic>.md` is therefore the closest reversible reserved prefix to
 * the proposed `brain/<topic>.md`, without a schema or storage change.
 */

import type { FileListRow } from "./files.js";
import {
  BRAIN_FILE_PREFIX,
  BRAIN_FILE_SUFFIX,
  BRAIN_TOPIC_MAX_LENGTH,
} from "../protocol/brain-version-window.js";

export { BRAIN_FILE_PREFIX, BRAIN_FILE_SUFFIX, BRAIN_TOPIC_MAX_LENGTH };
export const BRAIN_END_OF_TASK_NUDGE =
  "Durable finding? cswarm brain put <topic> — see brain get brain-how-to";

const BRAIN_TOPIC_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** A topic name that cannot map to one safe, canonical file-artifact name. */
export class BrainTopicError extends Error {
  override name = "BrainTopicError";
}

export interface BrainTopicSelector {
  topic: string;
  version: number | null;
}

/** Canonicalizes the CLI topic argument without silently changing punctuation. */
export function canonicalBrainTopic(value: string): string {
  const topic = value.trim().toLowerCase();
  if (
    topic.length < 1 ||
    topic.length > BRAIN_TOPIC_MAX_LENGTH ||
    !BRAIN_TOPIC_RE.test(topic)
  ) {
    throw new BrainTopicError(
      `brain topics use ${BRAIN_TOPIC_MAX_LENGTH} or fewer lowercase letters, numbers, dots, dashes, or underscores; start with a letter or number`,
    );
  }
  return topic;
}

/** Accepts the compact `<topic>@<version>` history selector. */
export function parseBrainTopicSelector(value: string): BrainTopicSelector {
  const at = value.lastIndexOf("@");
  if (at < 0) return { topic: canonicalBrainTopic(value), version: null };
  const rawVersion = value.slice(at + 1);
  if (!/^[1-9][0-9]*$/.test(rawVersion)) {
    throw new BrainTopicError("brain topic history uses <topic>@<positive-version>");
  }
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version)) {
    throw new BrainTopicError("brain topic version is too large");
  }
  return {
    topic: canonicalBrainTopic(value.slice(0, at)),
    version,
  };
}

/** Maps one public topic slug into the reserved file-artifact name. */
export function brainFileName(value: string): string {
  return `${BRAIN_FILE_PREFIX}${canonicalBrainTopic(value)}${BRAIN_FILE_SUFFIX}`;
}

/** Returns the canonical topic for a reserved brain file, or null for a normal file. */
export function brainTopicFromFileName(name: string): string | null {
  const lower = name.toLowerCase();
  if (!lower.startsWith(BRAIN_FILE_PREFIX) || !lower.endsWith(BRAIN_FILE_SUFFIX)) {
    return null;
  }
  const topic = lower.slice(BRAIN_FILE_PREFIX.length, -BRAIN_FILE_SUFFIX.length);
  try {
    return canonicalBrainTopic(topic);
  } catch (error) {
    if (error instanceof BrainTopicError) return null;
    throw error;
  }
}

export interface BrainTopicRow {
  topic: string;
  file: FileListRow;
}

export interface BrainTopicSnapshot {
  topic: string;
  version: number;
  updatedAt: string;
}

export interface BrainVersionCounts {
  live: number;
  retired: number;
}

function nonNegativeCount(value: number | string | undefined): number | null {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** Keeps the 0.1.47 read wire usable during an edge-before-client rollout. */
export function brainVersionCounts(file: FileListRow): BrainVersionCounts {
  return {
    live: nonNegativeCount(file.live_version_count) ?? file.current_version,
    retired: nonNegativeCount(file.retired_version_count) ?? 0,
  };
}

/** Keep every brain-list consumer on one reserved-name filter and ordering. */
export function brainRowsFromFiles(rows: readonly FileListRow[]): BrainTopicRow[] {
  return rows
    .filter((row) => row.tombstoned_at === null)
    .flatMap((file) => {
      const topic = brainTopicFromFileName(file.name);
      return topic === null ? [] : [{ topic, file }];
    })
    .sort((left, right) => left.topic.localeCompare(right.topic));
}

/** Names and versions only; no brain body is downloaded for a digest. */
export function brainTopicSnapshots(
  rows: readonly BrainTopicRow[],
): BrainTopicSnapshot[] {
  return rows.map(({ topic, file }) => ({
    topic,
    version: file.current_version,
    updatedAt: file.committed_at ?? file.created_at,
  }));
}

/** Print one fixed checkpoint only for a completed replied delivery. */
export function brainEndOfTaskNudge(
  outcomes: readonly unknown[],
): string | null {
  return outcomes.some((outcome) => outcome === "replied")
    ? BRAIN_END_OF_TASK_NUDGE
    : null;
}
