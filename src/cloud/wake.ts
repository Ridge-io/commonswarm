/**
 * Optional wake hint on read, claim, and renewal responses (W3.4).
 * 0.1.57 servers omit it. A present value must be the closed { topic, event } object.
 */

export const WAKE_EVENT = "wake";
export const WAKE_TOPIC_PREFIX = "cswarm-wake:";
export const WAKE_ID_LENGTH = 43;
export const WAKE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
export const WAKE_TOPIC_RE = /^cswarm-wake:[A-Za-z0-9_-]{43}$/;

export interface WakeHint {
  topic: string;
  event: typeof WAKE_EVENT;
}

export function isWakeTopic(value: string): boolean {
  return WAKE_TOPIC_RE.test(value);
}

export class WakeHintError extends Error {
  readonly code = "malformed_wake";
  constructor(message: string) {
    super(message);
    this.name = "WakeHintError";
  }
}

/**
 * Absent or null means the server did not send a hint. A present value is
 * checked against the same topic shape the Realtime join uses.
 */
export function parseOptionalWakeHint(value: unknown): WakeHint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WakeHintError("wake hint must be an object");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.topic !== "string" || !isWakeTopic(row.topic)) {
    throw new WakeHintError("wake hint topic is malformed");
  }
  if (row.event !== WAKE_EVENT) {
    throw new WakeHintError("wake hint event is malformed");
  }
  return { topic: row.topic, event: WAKE_EVENT };
}
