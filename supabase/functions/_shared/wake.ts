/**
 * Wake topic wire shape (W3). The topic string is a credential: never log it,
 * never put it in audit detail, never echo it outside the response field.
 *
 * Prefix, event name, and id length are the same constants the SQL policy
 * (`wake_topic_authorized`) and the trigger (`wake_agent_delivery`) enforce.
 * A typed list here would drift the moment either side changed.
 */
export const WAKE_EVENT = "wake" as const;
export const WAKE_TOPIC_PREFIX = "cswarm-wake:" as const;
export const WAKE_ID_LENGTH = 43;
export const WAKE_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export type WakeWire = {
  topic: `${typeof WAKE_TOPIC_PREFIX}${string}`;
  event: typeof WAKE_EVENT;
};

export function isWakeId(value: string): boolean {
  return WAKE_ID_RE.test(value);
}

export function wakeTopic(wakeId: string): `${typeof WAKE_TOPIC_PREFIX}${string}` {
  return `${WAKE_TOPIC_PREFIX}${wakeId}`;
}

export function wakeWire(
  wakeId: string | null | undefined,
): WakeWire | undefined {
  if (typeof wakeId !== "string" || !isWakeId(wakeId)) return undefined;
  return { topic: wakeTopic(wakeId), event: WAKE_EVENT };
}

export function optionalWake(
  wakeId: string | null | undefined,
): { wake: WakeWire } | Record<string, never> {
  const wire = wakeWire(wakeId);
  return wire === undefined ? {} : { wake: wire };
}
