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
 * Optional compare-and-set on a file's newest LIVE version.
 *
 * A write without it stays last-write-wins, which is what silently replaced a
 * brain topic composed from a stale copy on 2026-09-04. This is deliberately
 * narrower than the optimistic-concurrency primitive in SWARM-CLOUD.md §2.9:
 * that specifies an opaque ETag and a three-way merge, and states the revision
 * token must NOT be a client-guessable integer. A version integer is guessable,
 * so this does not defend the ABA case (read v3, write content that ignores v3,
 * present 3). It refuses the accidental clobber that was measured, and it can
 * never be worse than the unconditional write it replaces. Read §2.9 before
 * treating this as that primitive.
 */
export const FILE_VERSION_PRECONDITION_FAILED = "file_version_precondition_failed";

/** The value carried on the wire, and the same bound the CLI enforces. */
export function isFileVersionPrecondition(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Zero means "no live version yet", which is what a file with only pending
 * uploads and a name that has never been committed both report.
 */
export function fileVersionPreconditionSatisfied(
  requiredVersion: number,
  liveVersion: number,
): boolean {
  return requiredVersion === liveVersion;
}

/** One sentence, built once, so the server and the CLI cannot drift apart. */
export function fileVersionPreconditionMessage(
  requiredVersion: number,
  liveVersion: number,
): string {
  const current = liveVersion === 0
    ? "this name has no live version yet"
    : `this file is at version ${liveVersion}`;
  return `${current}; the request required version ${requiredVersion}, so nothing was uploaded`;
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
