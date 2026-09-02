/*
 * Pure policy for the reserved workspace-brain file namespace.
 *
 * The name is the durable pointer. Normal files keep the fixed 20-version cap,
 * while a brain topic keeps a rolling window of 20 live versions. Pending
 * uploads are counted separately because bytes do not become a version until
 * commit.
 */

export const BRAIN_FILE_PREFIX = "brain--";
export const BRAIN_FILE_SUFFIX = ".md";
export const BRAIN_TOPIC_MAX_LENGTH =
  255 - BRAIN_FILE_PREFIX.length - BRAIN_FILE_SUFFIX.length;
export const BRAIN_LIVE_VERSION_LIMIT = 20;

const BRAIN_FILE_NAME_RE = /^brain--[a-z0-9][a-z0-9._-]*\.md$/i;

export function isBrainFileArtifactName(name: string): boolean {
  return name.length <= 255 && BRAIN_FILE_NAME_RE.test(name);
}

export interface FileVersionWindowPlan {
  brainTopic: boolean;
  createAllowed: boolean;
  retireOnCommitCount: number;
}

/**
 * Reduces the locked database counts into the next version-window action.
 * A brain create is blocked only by 20 unexpired pending uploads. At commit,
 * retire enough of the oldest live versions to leave room for this version.
 */
export function planFileVersionWindow(
  name: string,
  liveCount: number,
  inFlightCount: number,
): FileVersionWindowPlan {
  if (!Number.isSafeInteger(liveCount) || liveCount < 0) {
    throw new RangeError("liveCount must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(inFlightCount) || inFlightCount < 0) {
    throw new RangeError("inFlightCount must be a non-negative safe integer");
  }
  const brainTopic = isBrainFileArtifactName(name);
  return {
    brainTopic,
    createAllowed: brainTopic
      ? inFlightCount < BRAIN_LIVE_VERSION_LIMIT
      : liveCount + inFlightCount < BRAIN_LIVE_VERSION_LIMIT,
    retireOnCommitCount: brainTopic
      ? Math.max(0, liveCount - BRAIN_LIVE_VERSION_LIMIT + 1)
      : 0,
  };
}
