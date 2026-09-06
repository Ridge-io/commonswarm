/**
 * Shared idle-poll cadence for the listener claim loop and inbox --notify.
 *
 * Empty polls back off from the configured base to IDLE_POLL_MAX_MS.
 * Any delivery (a claimed row, or a rendered arrival) resets to the base.
 * The flag parser, status sentence, and bound copy all read these constants.
 */

export const IDLE_POLL_DEFAULT_MS = 15_000;
export const IDLE_POLL_MAX_MS = 60_000;
export const IDLE_POLL_MIN_MS = 1_000;
export const ARRIVAL_WATCH_POLL_MS = IDLE_POLL_MAX_MS;

const DURATION_RE = /^([1-9]\d*)(s|m)$/;

/** Whole-second duration used in flag errors and status sentences. */
export function formatIdlePollDuration(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error("idle poll duration must be a positive number of milliseconds");
  }
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  throw new Error("idle poll duration must be a whole number of seconds");
}

export const IDLE_POLL_MIN_LABEL = formatIdlePollDuration(IDLE_POLL_MIN_MS);
export const IDLE_POLL_DEFAULT_LABEL = formatIdlePollDuration(IDLE_POLL_DEFAULT_MS);
export const IDLE_POLL_MAX_LABEL = formatIdlePollDuration(IDLE_POLL_MAX_MS);

/**
 * Examples in flag errors. Built from the same default, doubled default, and
 * cap the parser enforces, so a bound change cannot leave a stale list.
 */
export function idlePollDurationExamples(): string[] {
  const midMs = Math.min(IDLE_POLL_MAX_MS, IDLE_POLL_DEFAULT_MS * 2);
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const ms of [IDLE_POLL_DEFAULT_MS, midMs, IDLE_POLL_MAX_MS]) {
    const label = formatIdlePollDuration(ms);
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

export const IDLE_POLL_DURATION_EXAMPLES = idlePollDurationExamples();

export function idlePollDurationHint(): string {
  return idlePollDurationExamples().join(", ");
}

export function idlePollBoundSentence(): string {
  return `between ${IDLE_POLL_MIN_LABEL} and ${IDLE_POLL_MAX_LABEL}`;
}

/**
 * Parse --poll-interval. Same shape as --turn-budget (whole number plus s or m).
 * Bounds come from IDLE_POLL_MIN_MS / IDLE_POLL_MAX_MS so the error cannot drift.
 */
export function parseIdlePollIntervalMs(
  value: string | undefined,
  defaultMs: number = IDLE_POLL_DEFAULT_MS,
): number {
  if (value === undefined) return defaultMs;
  const match = DURATION_RE.exec(value);
  if (!match) {
    throw new Error(
      `--poll-interval must be a duration such as ${idlePollDurationHint()}`,
    );
  }
  const unit = match[2] === "s" ? 1_000 : 60_000;
  const milliseconds = Number(match[1]) * unit;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < IDLE_POLL_MIN_MS ||
    milliseconds > IDLE_POLL_MAX_MS
  ) {
    throw new Error(`--poll-interval must be ${idlePollBoundSentence()}`);
  }
  return milliseconds;
}

/**
 * Next wait after an empty poll. emptyStreak is 0-based: the first empty wait
 * is the configured base, then it doubles until maxMs (IDLE_POLL_MAX_MS).
 * The flag parser enforces MIN/MAX; this helper does not raise a 1ms test
 * injection to IDLE_POLL_MIN_MS.
 */
export function nextIdlePollMs(
  baseMs: number,
  emptyStreak: number,
  maxMs: number = IDLE_POLL_MAX_MS,
): number {
  if (!Number.isSafeInteger(baseMs) || baseMs < 0) {
    throw new Error("idle poll base must be a non-negative number of milliseconds");
  }
  if (!Number.isSafeInteger(emptyStreak) || emptyStreak < 0) {
    throw new Error("idle poll empty streak must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maxMs) || maxMs < 0) {
    throw new Error("idle poll max must be a non-negative number of milliseconds");
  }
  const shift = Math.min(emptyStreak, 16);
  const grown = baseMs * (2 ** shift);
  return Math.min(maxMs, grown);
}

/** Status sentence. Names the interval in force right now, from the same constants. */
export function idlePollStatusSentence(currentMs: number): string {
  return `Current idle poll interval: ${formatIdlePollDuration(currentMs)}.`;
}

export function idlePollHelpSentence(defaultMs: number = IDLE_POLL_DEFAULT_MS): string {
  return `listen start --poll-interval sets how long the listener waits after an empty claim (default ${formatIdlePollDuration(defaultMs)}). A whole number plus s or m (for example ${idlePollDurationHint()}), ${idlePollBoundSentence()}. Empty polls double that wait up to ${IDLE_POLL_MAX_LABEL}; any delivery resets it to the configured interval.`;
}
