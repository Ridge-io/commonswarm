// Pure event reducer: fold a task's canonical event stream into its projection
// state (§2.2). No I/O. Events fold in ascending `seq`. The first event for a
// task MUST be TaskCreated; an unknown event type HALTS (§2.1 — "clients never
// advance past an unknown authoritative event type").

import {
  EventEnvelope, TaskState, EVENT_TYPES,
  TaskCreated, LeaseAcquired, LeaseRenewed, LeaseHandedOff, LeaseTakenOver,
  TaskSubmitted, TaskClosed, TaskReopened,
} from './events.js';

/** Thrown when the reducer meets an event type it does not know — the client must stop, not skip. */
export class UnknownEventTypeError extends Error {
  constructor(public readonly type: string, public readonly seq: number) {
    super(`unknown authoritative event type "${type}" at seq ${seq}; halting`);
    this.name = 'UnknownEventTypeError';
  }
}

/** Thrown when a stream is malformed (e.g. a non-create event before the task exists). */
export class StreamIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamIntegrityError';
  }
}

/** Apply one event to the (possibly absent) task state. Returns the next state. */
export function reduceTask(prev: TaskState | null, env: EventEnvelope): TaskState {
  if (!(EVENT_TYPES as readonly string[]).includes(env.type)) {
    throw new UnknownEventTypeError(env.type, env.seq);
  }

  // CommandRejected is a committed domain event but never mutates the task
  // projection — it is audit/history, not a state transition.
  if (env.type === 'CommandRejected') {
    if (!prev) throw new StreamIntegrityError(`CommandRejected before task exists (seq ${env.seq})`);
    return prev;
  }

  if (env.type === 'TaskCreated') {
    if (prev) throw new StreamIntegrityError(`TaskCreated for an already-existing task (seq ${env.seq})`);
    const p = env.payload as TaskCreated;
    return {
      task_id: p.task_id,
      slug: p.slug,
      lifecycle: 'open',
      version: 1,
      epoch: 0,
      owner: null,
      lease_expiry: null,
      submission: null,
      closed_disposition: null,
    };
  }

  if (!prev) throw new StreamIntegrityError(`event "${env.type}" before TaskCreated (seq ${env.seq})`);
  const s = prev;

  switch (env.type) {
    case 'LeaseAcquired': {
      const p = env.payload as LeaseAcquired;
      return { ...s, lifecycle: 'active', epoch: p.epoch, owner: p.owner, lease_expiry: p.lease_expiry };
    }
    case 'LeaseRenewed': {
      const p = env.payload as LeaseRenewed;
      // Epoch unchanged; only the expiry moves. Lifecycle unchanged (active or awaiting_review).
      return { ...s, lease_expiry: p.lease_expiry };
    }
    case 'LeaseHandedOff': {
      const p = env.payload as LeaseHandedOff;
      return { ...s, lifecycle: 'active', epoch: p.epoch, owner: p.to_owner, lease_expiry: p.lease_expiry };
    }
    case 'LeaseTakenOver': {
      const p = env.payload as LeaseTakenOver;
      return { ...s, lifecycle: 'active', epoch: p.epoch, owner: p.owner, lease_expiry: p.lease_expiry };
    }
    case 'TaskSubmitted': {
      const p = env.payload as TaskSubmitted;
      // Freeze the submission (a later submit supersedes it). Lease continues.
      return {
        ...s,
        lifecycle: 'awaiting_review',
        submission: { epoch: p.epoch, branch: p.branch, head_sha: p.head_sha, evidence_set: [...p.evidence_set] },
      };
    }
    case 'TaskClosed': {
      const p = env.payload as TaskClosed;
      return { ...s, lifecycle: 'done', closed_disposition: p.disposition };
    }
    case 'TaskReopened': {
      const p = env.payload as TaskReopened;
      // Invalidate the open submission; bump version; clear the lease so the next
      // acquire re-establishes ownership. Epoch stays monotonic (never decreases),
      // so any pre-reopen token remains fenced.
      return { ...s, lifecycle: 'reopened', version: p.version, submission: null, owner: null, lease_expiry: null };
    }
    default: {
      // Exhaustiveness guard; unreachable given the EVENT_TYPES check above.
      throw new UnknownEventTypeError(env.type, env.seq);
    }
  }
}

/** Fold a full (seq-ordered) stream for one task into its final projection. */
export function reduceStream(events: readonly EventEnvelope[]): TaskState | null {
  let state: TaskState | null = null;
  let lastSeq = -Infinity;
  for (const env of events) {
    if (env.seq <= lastSeq) {
      throw new StreamIntegrityError(`events out of order or duplicated: seq ${env.seq} after ${lastSeq}`);
    }
    lastSeq = env.seq;
    state = reduceTask(state, env);
  }
  return state;
}
