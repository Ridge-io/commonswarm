import type {
  SignalReadFailureClassification,
  SignalReadFailureCode,
} from "../cloud/signals.js";

const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;
const HEALTH_WINDOW_MS = 24 * HOUR_MS;
export const LISTENER_READ_RETRY_HOUR_CAP = 25;
export const LISTENER_READ_RETRY_MINUTE_CAP = 61;
export const LISTENER_CLAIM_HOUR_CAP = 25;
export const LISTENER_THROUGHPUT_LAPSE_RATIO = 0.5;

export interface ListenerReadRetryHour {
  hourStart: string;
  retries: number;
  episodes: number;
  longestEpisodeAttempts: number;
  longestEpisodeDurationMs: number;
}

export interface ListenerReadRetryMinute {
  minuteStart: string;
  retries: number;
}

export interface ListenerClaimHour {
  hourStart: string;
  claims: number;
}

export interface ListenerReadHealth {
  currentEpisodeStartedAt: string | null;
  currentEpisodeAttempts: number;
  currentReasonCode: SignalReadFailureCode | null;
  currentHttpStatus: number | null;
  currentErrorConstructor: string | null;
  retryHours: ListenerReadRetryHour[];
  retryMinutes: ListenerReadRetryMinute[];
  claimCadenceMs: number | null;
  claimHours: ListenerClaimHour[];
}

export interface ListenerClaimThroughputHour {
  hourStart: string;
  claims: number;
  expectedClaims: number;
  ratio: number;
}

export interface ListenerReadHealthSummary {
  currentEpisodeDurationMs: number | null;
  episodesLast24h: number;
  longestEpisodeAttemptsLast24h: number;
  longestEpisodeDurationMsLast24h: number;
  retriesLastHour: number;
  retryHours: ListenerReadRetryHour[];
  claimThroughputHours: ListenerClaimThroughputHour[];
  throughputLapseHours: ListenerClaimThroughputHour[];
}

const FAILURE_CODES = new Set<SignalReadFailureCode>([
  "http_status",
  "no_response",
  "body_timeout",
  "malformed_response",
  "aborted",
  "host_ports_exhausted",
  "unclassified",
]);

/** Empty local health state for one new listener supervisor. */
export function emptyListenerReadHealth(): ListenerReadHealth {
  return {
    currentEpisodeStartedAt: null,
    currentEpisodeAttempts: 0,
    currentReasonCode: null,
    currentHttpStatus: null,
    currentErrorConstructor: null,
    retryHours: [],
    retryMinutes: [],
    claimCadenceMs: null,
    claimHours: [],
  };
}

function bucketStart(ts: string, sizeMs: number): string {
  const time = Date.parse(ts);
  return new Date(Math.floor(time / sizeMs) * sizeMs).toISOString();
}

function trimNewest<T extends { hourStart: string }>(
  rows: T[],
  cap: number,
): T[] {
  return rows
    .sort((left, right) => Date.parse(left.hourStart) - Date.parse(right.hourStart))
    .slice(-cap);
}

function recordRetryHour(
  rows: ListenerReadRetryHour[],
  ts: string,
  episodeStarted: boolean,
): ListenerReadRetryHour[] {
  const hourStart = bucketStart(ts, HOUR_MS);
  const next = rows.map((row) => ({ ...row }));
  const existing = next.find((row) => row.hourStart === hourStart);
  if (existing) {
    existing.retries += 1;
    if (episodeStarted) existing.episodes += 1;
  } else {
    next.push({
      hourStart,
      retries: 1,
      episodes: episodeStarted ? 1 : 0,
      longestEpisodeAttempts: 0,
      longestEpisodeDurationMs: 0,
    });
  }
  return trimNewest(next, LISTENER_READ_RETRY_HOUR_CAP);
}

function recordRetryMinute(
  rows: ListenerReadRetryMinute[],
  ts: string,
): ListenerReadRetryMinute[] {
  const minuteStart = bucketStart(ts, MINUTE_MS);
  const next = rows.map((row) => ({ ...row }));
  const existing = next.find((row) => row.minuteStart === minuteStart);
  if (existing) {
    existing.retries += 1;
  } else {
    next.push({ minuteStart, retries: 1 });
  }
  return next
    .sort((left, right) =>
      Date.parse(left.minuteStart) - Date.parse(right.minuteStart)
    )
    .slice(-LISTENER_READ_RETRY_MINUTE_CAP);
}

/** Persist one classified retry and its current-episode counters. */
export function recordListenerReadRetry(
  health: ListenerReadHealth,
  input: {
    ts: string;
    episodeStartedAt: string;
    episodeAttempt: number;
    failure: SignalReadFailureClassification;
  },
): ListenerReadHealth {
  return {
    ...health,
    currentEpisodeStartedAt: input.episodeStartedAt,
    currentEpisodeAttempts: input.episodeAttempt,
    currentReasonCode: input.failure.code,
    currentHttpStatus: input.failure.httpStatus,
    currentErrorConstructor: input.failure.errorConstructor,
    retryHours: recordRetryHour(
      health.retryHours,
      input.ts,
      input.episodeAttempt === 1,
    ),
    retryMinutes: recordRetryMinute(health.retryMinutes, input.ts),
  };
}

/** Close exactly one retry episode and retain its bounded longest-episode facts. */
export function recordListenerReadRecovery(
  health: ListenerReadHealth,
  input: {
    startedAt: string;
    attempts: number;
    durationMs: number;
  },
): ListenerReadHealth {
  const hourStart = bucketStart(input.startedAt, HOUR_MS);
  const retryHours = health.retryHours.map((row) => ({ ...row }));
  const hour = retryHours.find((row) => row.hourStart === hourStart);
  if (hour) {
    if (
      input.durationMs > hour.longestEpisodeDurationMs ||
      (input.durationMs === hour.longestEpisodeDurationMs &&
        input.attempts > hour.longestEpisodeAttempts)
    ) {
      hour.longestEpisodeAttempts = input.attempts;
      hour.longestEpisodeDurationMs = input.durationMs;
    }
  }
  return {
    ...health,
    currentEpisodeStartedAt: null,
    currentEpisodeAttempts: 0,
    currentReasonCode: null,
    currentHttpStatus: null,
    currentErrorConstructor: null,
    retryHours: trimNewest(retryHours, LISTENER_READ_RETRY_HOUR_CAP),
  };
}

/** Record the configured claim cadence used to compute an expected hourly count. */
export function recordListenerClaimCadence(
  health: ListenerReadHealth,
  cadenceMs: number,
): ListenerReadHealth {
  return { ...health, claimCadenceMs: cadenceMs };
}

/** Increment one local claim-throughput hour. */
export function recordListenerClaim(
  health: ListenerReadHealth,
  ts: string,
): ListenerReadHealth {
  const hourStart = bucketStart(ts, HOUR_MS);
  const claimHours = health.claimHours.map((row) => ({ ...row }));
  const hour = claimHours.find((row) => row.hourStart === hourStart);
  if (hour) hour.claims += 1;
  else claimHours.push({ hourStart, claims: 1 });
  return {
    ...health,
    claimHours: trimNewest(claimHours, LISTENER_CLAIM_HOUR_CAP),
  };
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate the bounded nested status structure before it reaches a local state file. */
export function isListenerReadHealth(value: unknown): value is ListenerReadHealth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, [
    "currentEpisodeStartedAt",
    "currentEpisodeAttempts",
    "currentReasonCode",
    "currentHttpStatus",
    "currentErrorConstructor",
    "retryHours",
    "retryMinutes",
    "claimCadenceMs",
    "claimHours",
  ])) return false;
  if (
    !(row.currentEpisodeStartedAt === null || validTimestamp(row.currentEpisodeStartedAt)) ||
    !validCount(row.currentEpisodeAttempts) ||
    !(row.currentReasonCode === null ||
      (typeof row.currentReasonCode === "string" &&
        FAILURE_CODES.has(row.currentReasonCode as SignalReadFailureCode))) ||
    !(row.currentHttpStatus === null ||
      (typeof row.currentHttpStatus === "number" &&
        Number.isSafeInteger(row.currentHttpStatus) &&
        row.currentHttpStatus >= 100 && row.currentHttpStatus <= 599)) ||
    !(row.currentErrorConstructor === null ||
      (typeof row.currentErrorConstructor === "string" &&
        /^[A-Za-z0-9_$-]{1,96}$/.test(row.currentErrorConstructor))) ||
    !(row.claimCadenceMs === null ||
      (typeof row.claimCadenceMs === "number" &&
        Number.isSafeInteger(row.claimCadenceMs) && row.claimCadenceMs >= 1)) ||
    !Array.isArray(row.retryHours) ||
    row.retryHours.length > LISTENER_READ_RETRY_HOUR_CAP ||
    !Array.isArray(row.retryMinutes) ||
    row.retryMinutes.length > LISTENER_READ_RETRY_MINUTE_CAP ||
    !Array.isArray(row.claimHours) ||
    row.claimHours.length > LISTENER_CLAIM_HOUR_CAP
  ) return false;
  if (
    (row.currentEpisodeStartedAt === null) !== (row.currentEpisodeAttempts === 0) ||
    (row.currentEpisodeStartedAt === null) !== (row.currentReasonCode === null) ||
    (row.currentReasonCode === "http_status") !== (row.currentHttpStatus !== null) ||
    (row.currentReasonCode === "unclassified") !==
      (row.currentErrorConstructor !== null)
  ) return false;
  for (const value of row.retryHours) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const hour = value as Record<string, unknown>;
    if (!exactKeys(hour, [
      "hourStart",
      "retries",
      "episodes",
      "longestEpisodeAttempts",
      "longestEpisodeDurationMs",
    ]) || !validTimestamp(hour.hourStart) || !validCount(hour.retries) ||
      !validCount(hour.episodes) || !validCount(hour.longestEpisodeAttempts) ||
      !validCount(hour.longestEpisodeDurationMs)) return false;
  }
  for (const value of row.retryMinutes) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const minute = value as Record<string, unknown>;
    if (!exactKeys(minute, ["minuteStart", "retries"]) ||
      !validTimestamp(minute.minuteStart) || !validCount(minute.retries)) return false;
  }
  for (const value of row.claimHours) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const hour = value as Record<string, unknown>;
    if (!exactKeys(hour, ["hourStart", "claims"]) ||
      !validTimestamp(hour.hourStart) || !validCount(hour.claims)) return false;
  }
  return true;
}

/** Derive rolling and completed-hour metrics without changing the durable file. */
export function summarizeListenerReadHealth(
  health: ListenerReadHealth,
  readyAt: string | null,
  nowMs: number,
): ListenerReadHealthSummary {
  const windowStart = nowMs - HEALTH_WINDOW_MS;
  const retryHours = health.retryHours.filter((row) =>
    Date.parse(row.hourStart) + HOUR_MS > windowStart &&
    Date.parse(row.hourStart) <= nowMs
  );
  let episodesLast24h = retryHours.reduce((sum, row) => sum + row.episodes, 0);
  let longestEpisodeAttemptsLast24h = 0;
  let longestEpisodeDurationMsLast24h = 0;
  for (const row of retryHours) {
    if (
      row.longestEpisodeDurationMs > longestEpisodeDurationMsLast24h ||
      (row.longestEpisodeDurationMs === longestEpisodeDurationMsLast24h &&
        row.longestEpisodeAttempts > longestEpisodeAttemptsLast24h)
    ) {
      longestEpisodeAttemptsLast24h = row.longestEpisodeAttempts;
      longestEpisodeDurationMsLast24h = row.longestEpisodeDurationMs;
    }
  }
  const currentStartedMs = health.currentEpisodeStartedAt === null
    ? null
    : Date.parse(health.currentEpisodeStartedAt);
  const currentEpisodeDurationMs = currentStartedMs === null
    ? null
    : Math.max(0, nowMs - currentStartedMs);
  if (
    currentStartedMs !== null && currentStartedMs >= windowStart &&
    currentEpisodeDurationMs !== null &&
    (currentEpisodeDurationMs > longestEpisodeDurationMsLast24h ||
      (currentEpisodeDurationMs === longestEpisodeDurationMsLast24h &&
        health.currentEpisodeAttempts > longestEpisodeAttemptsLast24h))
  ) {
    longestEpisodeAttemptsLast24h = health.currentEpisodeAttempts;
    longestEpisodeDurationMsLast24h = currentEpisodeDurationMs;
  }
  const rollingMinuteStart = Math.floor((nowMs - HOUR_MS) / MINUTE_MS) * MINUTE_MS;
  const retriesLastHour = health.retryMinutes.reduce((sum, row) =>
    Date.parse(row.minuteStart) >= rollingMinuteStart &&
      Date.parse(row.minuteStart) <= nowMs
      ? sum + row.retries
      : sum, 0);

  const claimThroughputHours: ListenerClaimThroughputHour[] = [];
  if (health.claimCadenceMs !== null && readyAt !== null) {
    const readyMs = Date.parse(readyAt);
    const firstFullHour = Math.ceil(readyMs / HOUR_MS) * HOUR_MS;
    const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    const first = Math.max(firstFullHour, currentHour - HEALTH_WINDOW_MS);
    const claimsByHour = new Map(
      health.claimHours.map((row) => [row.hourStart, row.claims]),
    );
    const expectedClaims = HOUR_MS / health.claimCadenceMs;
    for (let hour = first; hour < currentHour; hour += HOUR_MS) {
      const hourStart = new Date(hour).toISOString();
      const claims = claimsByHour.get(hourStart) ?? 0;
      claimThroughputHours.push({
        hourStart,
        claims,
        expectedClaims,
        ratio: claims / expectedClaims,
      });
    }
  }
  const throughputLapseHours = claimThroughputHours.filter(
    (hour) => hour.ratio < LISTENER_THROUGHPUT_LAPSE_RATIO,
  );
  return {
    currentEpisodeDurationMs,
    episodesLast24h,
    longestEpisodeAttemptsLast24h,
    longestEpisodeDurationMsLast24h,
    retriesLastHour,
    retryHours,
    claimThroughputHours,
    throughputLapseHours,
  };
}
