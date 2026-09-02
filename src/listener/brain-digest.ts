import { isAbsolute, join } from "node:path";
import type { BrainTopicSnapshot } from "../cloud/brain.js";
import {
  readSecureJsonFile,
  readSecureJsonFileIfPresent,
  withFileLock,
  writeSecureJsonFile,
} from "../cloud/storage.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOPIC_RE = /^[a-z0-9][a-z0-9._-]*$/;
const BRAIN_DIGEST_FILE = "brain-digest.json";
const BRAIN_DIGEST_LOCK = "brain-digest";
const MAX_BRAIN_DIGEST_STATE_BYTES = 128 * 1024;
const MAX_BRAIN_DIGEST_TOPICS = 2_048;
const BRAIN_DIGEST_LOCK_TIMEOUT_MS = 250;
const BRAIN_DIGEST_TOPIC_LIMIT = 2;

interface BrainDigestState {
  version: 1;
  principalId: string;
  topicVersions: Record<string, number>;
}

function parseState(raw: string): BrainDigestState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("stored brain digest state is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored brain digest state is malformed");
  }
  const row = value as Record<string, unknown>;
  const topicVersions = row.topicVersions;
  if (
    row.version !== 1 ||
    typeof row.principalId !== "string" || !UUID_RE.test(row.principalId) ||
    !topicVersions || typeof topicVersions !== "object" ||
    Array.isArray(topicVersions) ||
    Object.keys(topicVersions).length > MAX_BRAIN_DIGEST_TOPICS
  ) {
    throw new Error("stored brain digest state is malformed");
  }
  for (const [topic, version] of Object.entries(topicVersions)) {
    if (
      !TOPIC_RE.test(topic) ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) || version < 1
    ) {
      throw new Error("stored brain digest state is malformed");
    }
  }
  return {
    version: 1,
    principalId: row.principalId.toLowerCase(),
    topicVersions: topicVersions as Record<string, number>,
  };
}

function currentState(
  principalId: string,
  topics: readonly BrainTopicSnapshot[],
): BrainDigestState {
  if (topics.length > MAX_BRAIN_DIGEST_TOPICS) {
    throw new Error("brain digest has too many topics");
  }
  const topicVersions: Record<string, number> = {};
  for (const topic of topics) {
    if (
      !TOPIC_RE.test(topic.topic) ||
      !Number.isSafeInteger(topic.version) || topic.version < 1 ||
      !Number.isFinite(Date.parse(topic.updatedAt)) ||
      topicVersions[topic.topic] !== undefined
    ) {
      throw new Error("brain digest topic list is malformed");
    }
    topicVersions[topic.topic] = topic.version;
  }
  return { version: 1, principalId, topicVersions };
}

function newestFirst(
  topics: readonly BrainTopicSnapshot[],
): BrainTopicSnapshot[] {
  return [...topics].sort((left, right) =>
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    left.topic.localeCompare(right.topic)
  );
}

function changedTopics(
  previous: BrainDigestState | null,
  topics: readonly BrainTopicSnapshot[],
): BrainTopicSnapshot[] {
  return previous === null
    ? newestFirst(topics).slice(0, BRAIN_DIGEST_TOPIC_LIMIT)
    : topics.filter((topic) => previous.topicVersions[topic.topic] !== topic.version);
}

/** One compact changed-only line; topic bodies never enter this formatter. */
export function renderBrainDigest(
  topicCount: number,
  topics: readonly BrainTopicSnapshot[],
): string | null {
  if (topics.length === 0) return null;
  const names = newestFirst(topics)
    .map((topic) => `${topic.topic} v${topic.version}`)
    .join(", ");
  return `[CommonSwarm brain] ${topicCount} ${topicCount === 1 ? "topic" : "topics"}; ` +
    `NEW/UPDATED since your last check: ${names}. Read: cswarm brain get <topic>`;
}

/** Atomic per-principal high-water shared by hook and durable worker prompts. */
export class FileBrainDigestStore {
  readonly location: string;
  private readonly principalId: string;

  constructor(private readonly instanceDirectory: string, principalId: string) {
    if (!isAbsolute(instanceDirectory) || !UUID_RE.test(principalId)) {
      throw new Error("brain digest state needs an absolute listener directory and principal UUID");
    }
    this.principalId = principalId.toLowerCase();
    this.location = join(instanceDirectory, BRAIN_DIGEST_FILE);
  }

  /** Read the shared high-water without advancing it. */
  async preview(topics: readonly BrainTopicSnapshot[]): Promise<string | null> {
    const raw = await readSecureJsonFileIfPresent(
      this.location,
      MAX_BRAIN_DIGEST_STATE_BYTES,
    );
    const previous = raw === null ? null : parseState(raw);
    if (previous !== null && previous.principalId !== this.principalId) {
      throw new Error("stored brain digest state belongs to another principal");
    }
    currentState(this.principalId, topics);
    return renderBrainDigest(topics.length, changedTopics(previous, topics));
  }

  async consume(topics: readonly BrainTopicSnapshot[]): Promise<string | null> {
    return await withFileLock(this.instanceDirectory, BRAIN_DIGEST_LOCK, async () => {
      const raw = await readSecureJsonFile(
        this.location,
        MAX_BRAIN_DIGEST_STATE_BYTES,
      );
      const previous = raw === null ? null : parseState(raw);
      if (previous !== null && previous.principalId !== this.principalId) {
        throw new Error("stored brain digest state belongs to another principal");
      }
      const next = currentState(this.principalId, topics);
      const changed = changedTopics(previous, topics);
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized, "utf8") > MAX_BRAIN_DIGEST_STATE_BYTES) {
        throw new Error("brain digest state is larger than this store accepts");
      }
      if (raw !== serialized) {
        await writeSecureJsonFile(this.location, serialized);
      }
      return renderBrainDigest(topics.length, changed);
    }, { timeoutMs: BRAIN_DIGEST_LOCK_TIMEOUT_MS });
  }
}
