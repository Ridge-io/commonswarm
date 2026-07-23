// SWARM-CLOUD protocol core — canonical events and task/lease projection state.
//
// This module is the reducer-complete authority core described in
// docs/design/SWARM-CLOUD.md §2.1 (protocol/envelope) and §2.2 (task/lease
// state machine). It is PURE: no I/O, no SQLite, no Supabase. P1 wires it
// behind the command API + Postgres; the local CLI (src/tasks.ts) is the
// legacy SQLite implementation and is intentionally NOT reused here
// ("Canonical cloud events are reducer-complete, defined independently of the
// legacy local audit rows" — §2.1).

/** Current schema version for every task/lease event type. */
export const SCHEMA_VERSION = 1;

/**
 * A principal is the authoritative actor identity, derived server-side from a
 * credential (§2.1 — never from request fields). A worker acts as its agent
 * principal; a human acts as their user. `canonicalPrincipal` collapses an
 * Actor to the single stable string used for ownership comparison.
 */
export interface Actor {
  user: string | null;
  agent_principal: string | null;
  run: string | null;
}

/** The owner-of-record identity: the agent principal if present, else the user. */
export function canonicalPrincipal(actor: Actor): string {
  const p = actor.agent_principal ?? actor.user;
  if (!p) throw new Error('actor has neither agent_principal nor user');
  return p;
}

/** Canonical event envelope (§2.1). `payload` is the per-type body below. */
export interface EventEnvelope<P = unknown> {
  workspace_id: string;
  stream_id: string;
  /** Monotonic per-stream sequence. Events fold in ascending seq. */
  seq: number;
  event_id: string;
  /** The command that produced this event (idempotency + provenance). */
  command_id: string;
  type: EventType;
  schema_version: number;
  actor_user: string | null;
  actor_agent_principal: string | null;
  actor_run: string | null;
  /** Server time (ms epoch). Never client-supplied (§2.1/§4 honest-liveness). */
  occurred_at_server: number;
  payload: P;
}

export type EventType =
  | 'TaskCreated'
  | 'LeaseAcquired'
  | 'LeaseRenewed'
  | 'LeaseHandedOff'
  | 'LeaseTakenOver'
  | 'TaskSubmitted'
  | 'TaskClosed'
  | 'TaskReopened'
  | 'CommandRejected';

export const EVENT_TYPES: readonly EventType[] = [
  'TaskCreated', 'LeaseAcquired', 'LeaseRenewed', 'LeaseHandedOff',
  'LeaseTakenOver', 'TaskSubmitted', 'TaskClosed', 'TaskReopened',
  'CommandRejected',
] as const;

// ---- Event payloads (schema_version 1) --------------------------------------

export interface TaskCreated { task_id: string; slug: string; }
export interface LeaseAcquired { task_id: string; epoch: number; owner: string; lease_expiry: number; }
export interface LeaseRenewed { task_id: string; epoch: number; lease_expiry: number; }
export interface LeaseHandedOff { task_id: string; epoch: number; from_owner: string; to_owner: string; lease_expiry: number; }
export interface LeaseTakenOver { task_id: string; epoch: number; owner: string; lease_expiry: number; grant_id: string | null; }
export interface TaskSubmitted { task_id: string; epoch: number; branch: string; head_sha: string; evidence_set: string[]; }
export interface TaskClosed { task_id: string; epoch: number; disposition: string; grant_id: string | null; }
export interface TaskReopened { task_id: string; version: number; }

/** A committed domain rejection (§2.1 — authz failures are NOT events; these are). */
export interface CommandRejected {
  task_id: string;
  command: string;
  /** Machine-stable rejection code; see RejectionReason. */
  reason: RejectionReason;
  /** Human-facing, already treated as data (control chars stripped at render). */
  detail: string;
}

export type RejectionReason =
  | 'slug_not_unique'
  | 'not_acquirable'          // task not open/reopened/active-with-expired-lease
  | 'not_owner'
  | 'stale_epoch'
  | 'lease_expired'
  | 'recipient_not_member'
  | 'live_lease_needs_grant'  // takeover of a live lease without a takeover grant
  | 'grant_invalid'
  | 'evidence_incomplete'
  | 'not_submitted'           // close/… requires awaiting_review
  | 'close_needs_grant'       // gated claim closed without a valid close grant
  | 'already_done'
  | 'unknown_task'
  | 'bad_state';

// ---- Task/lease projection state (§2.2) -------------------------------------

export type TaskLifecycle = 'open' | 'active' | 'awaiting_review' | 'reopened' | 'done';

/** Frozen on submit; survives lease expiry; invalidated by reopen / superseded by a new submit (§2.2). */
export interface Submission {
  epoch: number;
  branch: string;
  head_sha: string;
  evidence_set: string[];
}

export interface TaskState {
  task_id: string;
  slug: string;
  lifecycle: TaskLifecycle;
  /** Task version — bumped on reopen; invalidates prior submissions/grants (§2.2). */
  version: number;
  /** Lease epoch — 0 means never acquired. Incremented on acquire/handoff/takeover. */
  epoch: number;
  owner: string | null;
  lease_expiry: number | null;
  submission: Submission | null;
  closed_disposition: string | null;
}

/** True iff the lease is currently held and unexpired at `now`. */
export function leaseLive(state: TaskState, now: number): boolean {
  return state.owner !== null && state.lease_expiry !== null && state.lease_expiry > now;
}
