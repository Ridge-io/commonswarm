/*
 * Workspace-brain names live inside the existing file-artifact namespace.
 *
 * The files table permits any 1..255-character name, but the file command's
 * effective name rule rejects `/` (supabase/functions/command/file-artifacts.ts).
 * `brain--<topic>.md` is therefore the closest reversible reserved prefix to
 * the proposed `brain/<topic>.md`, without a schema or storage change.
 */

export const BRAIN_FILE_PREFIX = "brain--";
export const BRAIN_FILE_SUFFIX = ".md";
export const BRAIN_TOPIC_MAX_LENGTH =
  255 - BRAIN_FILE_PREFIX.length - BRAIN_FILE_SUFFIX.length;

const BRAIN_TOPIC_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** A topic name that cannot map to one safe, canonical file-artifact name. */
export class BrainTopicError extends Error {
  override name = "BrainTopicError";
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
