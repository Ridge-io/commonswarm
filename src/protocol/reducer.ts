// Pure event reducer: fold a task's canonical event stream into its projection
// state (§2.2). No I/O. Events fold in ascending `seq`. The first event for a
// task MUST be TaskCreated; an unknown event type HALTS (§2.1 — "clients never
// advance past an unknown authoritative event type").

import {
  EventEnvelope, TaskState, EVENT_TYPES, SCHEMA_VERSION,
  TaskCreated, LeaseAcquired, LeaseRenewed, LeaseHandedOff, LeaseTakenOver,
  TaskSubmitted, TaskClosed, TaskReopened, CommandRejected,
} from './events.js';

/** Assert required payload fields are present, converting a malformed event into a typed halt (not a raw TypeError). */
function req<T extends object>(payload: unknown, keys: readonly (keyof T)[], type: string, seq: number): T {
  if (!payload || typeof payload !== 'object') throw new StreamIntegrityError(`event "${type}" at seq ${seq} has a non-object payload`);
  for (const k of keys) {
    if ((payload as Record<string, unknown>)[k as string] === undefined) {
      throw new StreamIntegrityError(`event "${type}" at seq ${seq} is missing payload field "${String(k)}"`);
    }
  }
  return payload as T;
}

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
  // The reducer only ever sees CURRENT-version events; anything else must be
  // upcast first (§2.1). This makes upcast-before-reduce enforced, not convention.
  if (env.schema_version !== SCHEMA_VERSION) {
    throw new StreamIntegrityError(`event "${env.type}" at seq ${env.seq} is schema v${env.schema_version}, expected v${SCHEMA_VERSION} (upcast before reduce)`);
  }

  // CommandRejected is a committed domain event but never mutates the task
  // projection — it is audit/history, not a state transition.
  if (env.type === 'CommandRejected') {
    if (!prev) throw new StreamIntegrityError(`CommandRejected before task exists (seq ${env.seq})`);
    req<CommandRejected>(env.payload, ['task_id', 'command', 'reason', 'detail'], env.type, env.seq);
    return prev;
  }

  if (env.type === 'TaskCreated') {
    if (prev) throw new StreamIntegrityError(`TaskCreated for an already-existing task (seq ${env.seq})`);
    const p = req<TaskCreated>(env.payload, ['task_id', 'slug'], env.type, env.seq);
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

  // Epoch is MONOTONIC: acquire/handoff/takeover strictly increase it. Validate
  // after the payload has passed req(), so malformed input always produces the
  // typed stream-integrity halt rather than a raw property-access error.
  function assertEpochIncrease(ep: number): void {
    if (typeof ep !== 'number' || ep <= s.epoch) {
      throw new StreamIntegrityError(`${env.type} at seq ${env.seq} has non-increasing epoch ${ep} (current ${s.epoch})`);
    }
  }
  // Lifecycle after an owner-changing lease event: a pending frozen submission keeps
  // the task in awaiting_review (it stays closeable across reacquisition — §2.2); with
  // no submission the task is simply active. (handoff/live-takeover are blocked during
  // awaiting_review in decide(), so those only fire when submission is null.)
  const leaseLifecycle = s.submission ? 'awaiting_review' as const : 'active' as const;

  switch (env.type) {
    case 'LeaseAcquired': {
      const p = req<LeaseAcquired>(env.payload, ['task_id', 'epoch', 'owner', 'lease_expiry'], env.type, env.seq);
      assertEpochIncrease(p.epoch);
      return { ...s, lifecycle: leaseLifecycle, epoch: p.epoch, owner: p.owner, lease_expiry: p.lease_expiry };
    }
    case 'LeaseRenewed': {
      const p = req<LeaseRenewed>(env.payload, ['task_id', 'epoch', 'lease_expiry'], env.type, env.seq);
      if (p.epoch !== s.epoch) throw new StreamIntegrityError(`LeaseRenewed at seq ${env.seq} epoch ${p.epoch} != current ${s.epoch}`);
      // Epoch unchanged; only the expiry moves. Lifecycle unchanged (active or awaiting_review).
      return { ...s, lease_expiry: p.lease_expiry };
    }
    case 'LeaseHandedOff': {
      const p = req<LeaseHandedOff>(env.payload, ['task_id', 'epoch', 'from_owner', 'to_owner', 'lease_expiry'], env.type, env.seq);
      assertEpochIncrease(p.epoch);
      return { ...s, lifecycle: leaseLifecycle, epoch: p.epoch, owner: p.to_owner, lease_expiry: p.lease_expiry };
    }
    case 'LeaseTakenOver': {
      const p = req<LeaseTakenOver>(env.payload, ['task_id', 'epoch', 'owner', 'lease_expiry', 'grant_id'], env.type, env.seq);
      assertEpochIncrease(p.epoch);
      return { ...s, lifecycle: leaseLifecycle, epoch: p.epoch, owner: p.owner, lease_expiry: p.lease_expiry };
    }
    case 'TaskSubmitted': {
      const p = req<TaskSubmitted>(env.payload, ['task_id', 'epoch', 'branch', 'head_sha', 'evidence_set'], env.type, env.seq);
      // Freeze the submission (a later submit supersedes it). Lease continues.
      return {
        ...s,
        lifecycle: 'awaiting_review',
        submission: { epoch: p.epoch, branch: p.branch, head_sha: p.head_sha, evidence_set: [...p.evidence_set] },
      };
    }
    case 'TaskClosed': {
      const p = req<TaskClosed>(env.payload, ['task_id', 'epoch', 'disposition', 'grant_id'], env.type, env.seq);
      return { ...s, lifecycle: 'done', closed_disposition: p.disposition };
    }
    case 'TaskReopened': {
      const p = req<TaskReopened>(env.payload, ['task_id', 'version'], env.type, env.seq);
      if (p.version <= s.version) throw new StreamIntegrityError(`TaskReopened at seq ${env.seq} version ${p.version} not > current ${s.version}`);
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
