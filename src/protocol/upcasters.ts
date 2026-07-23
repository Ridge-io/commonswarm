// Per-(event_type, version) upcaster registry (§2.1). Old persisted events are
// migrated to the current schema BEFORE the reducer sees them, so the reducer
// only ever handles current-version payloads and golden full-history replays
// stay deterministic across schema evolution. A missing upcaster for a version
// gap HALTS (never silently skips); an event newer than we support HALTS too
// ("clients never advance past an unknown authoritative event type").

import { EventEnvelope, EventType, SCHEMA_VERSION } from './events.js';

/** A single-step migration of a payload from version V to V+1. */
export type Upcaster = (payload: any) => any;

const registry = new Map<string, Upcaster>();

function key(type: string, fromVersion: number): string {
  return `${type}:${fromVersion}`;
}

export function registerUpcaster(type: EventType, fromVersion: number, fn: Upcaster): void {
  registry.set(key(type, fromVersion), fn);
}

export class UpcastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpcastError';
  }
}

/** Migrate a raw payload to the current SCHEMA_VERSION, one registered step at a time. */
export function upcastPayload(type: EventType, fromVersion: number, payload: unknown): { payload: unknown; schema_version: number } {
  let v = fromVersion;
  let p = payload;
  if (v > SCHEMA_VERSION) {
    throw new UpcastError(`event "${type}" is schema v${v}, newer than supported v${SCHEMA_VERSION}; halting`);
  }
  while (v < SCHEMA_VERSION) {
    const fn = registry.get(key(type, v));
    if (!fn) throw new UpcastError(`no upcaster for "${type}" v${v}→v${v + 1}`);
    p = fn(p);
    v += 1;
  }
  return { payload: p, schema_version: SCHEMA_VERSION };
}

/** Upcast a full envelope in place-safe fashion (returns a new envelope). */
export function upcastEnvelope(raw: EventEnvelope): EventEnvelope {
  const { payload, schema_version } = upcastPayload(raw.type, raw.schema_version, raw.payload);
  return { ...raw, payload, schema_version };
}

// ---- Reference migration (illustrative; also exercised by the golden replay) --
// The current schema is v1, so no production upcaster fires yet. This registered
// v0→v1 for TaskCreated is the TEMPLATE every future migration follows, and it
// lets the golden-replay fixture prove the machinery end-to-end: a legacy
// TaskCreated payload `{ id, name }` becomes the current `{ task_id, slug }`.
registerUpcaster('TaskCreated', 0, (p: { id: string; name: string }) => ({ task_id: p.id, slug: p.name }));
