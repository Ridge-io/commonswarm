// Pure command decision: given a task's current projection and a command,
// decide whether the transition is allowed and produce the canonical event(s).
// This is the §2.2 precondition table, expressed as one pure function.
//
// Rejection classes (§2.1):
//   - 'authz'  : the caller is not a member of the workspace/repo → NO stream
//                event; the caller sees a refusal and it goes to the audit log.
//   - 'domain' : caller is a valid member but the state/precondition forbids the
//                transition → a committed `CommandRejected` event (visible history).

import {
  Actor, EventEnvelope, EventType, TaskState, RejectionReason,
  canonicalPrincipal, leaseLive, SCHEMA_VERSION,
} from './events.js';

export type Command =
  | { kind: 'create'; task_id: string; slug: string }
  | { kind: 'acquire'; task_id: string; ttl_ms: number }
  | { kind: 'renew'; task_id: string; epoch: number; ttl_ms: number }
  | { kind: 'handoff'; task_id: string; epoch: number; to_owner: string; ttl_ms: number }
  | { kind: 'takeover'; task_id: string; grant_id: string | null; ttl_ms: number }
  | { kind: 'submit'; task_id: string; epoch: number; branch: string; head_sha: string; evidence_set: string[] }
  | { kind: 'close'; task_id: string; epoch: number; disposition: string; grant_id: string | null }
  | { kind: 'reopen'; task_id: string };

/**
 * Injected authority oracles + envelope factory. In P1 these are backed by the
 * command function's in-transaction reads; in tests they are plain closures.
 * Every oracle is a pure predicate over server-derived state — never over
 * client-supplied identity (§2.1).
 */
export interface DecideCtx {
  now: number;
  /** The authenticated caller, derived server-side. */
  actor: Actor;
  command_id: string;
  /** Is the caller a current member of this workspace/repo? (authz gate) */
  isMember(principal: string): boolean;
  /** Caller's role, for role-gated transitions (reopen). */
  role(principal: string): 'owner' | 'admin' | 'member' | null;
  /** Is `principal` a current member/principal eligible to receive a handoff? */
  isEligibleRecipient(principal: string): boolean;
  /** Does this task's *claim type* require a grant to close (§2.4)? */
  claimRequiresGrant(task_id: string): boolean;
  /** Is the presented evidence bundle complete/valid for submission (§2.4)? */
  evidenceComplete(task_id: string, evidence_set: readonly string[]): boolean;
  /** Is there a live takeover grant bound to this exact epoch (§2.5)? */
  validTakeoverGrant(task_id: string, grant_id: string | null, epoch: number): boolean;
  /** Is there a live close grant bound to this exact submission head_sha (§2.4/§2.5)? */
  validCloseGrant(task_id: string, grant_id: string | null, head_sha: string): boolean;
  /** Is this slug already taken in the stream? (create uniqueness) */
  slugTaken(slug: string): boolean;
  nextSeq(): number;
  nextEventId(): string;
  workspace_id: string;
  stream_id: string;
}

export interface DecisionAccepted {
  ok: true;
  events: EventEnvelope[];
  /** The projected state after applying the emitted events (convenience). */
}
export interface DecisionRejected {
  ok: false;
  class: 'authz' | 'domain';
  reason: RejectionReason;
  detail: string;
  /** For domain rejections: the single committed CommandRejected event. Empty for authz. */
  events: EventEnvelope[];
}
export type Decision = DecisionAccepted | DecisionRejected;

function env<P>(ctx: DecideCtx, type: EventType, payload: P): EventEnvelope<P> {
  return {
    workspace_id: ctx.workspace_id,
    stream_id: ctx.stream_id,
    seq: ctx.nextSeq(),
    event_id: ctx.nextEventId(),
    command_id: ctx.command_id,
    type,
    schema_version: SCHEMA_VERSION,
    actor_user: ctx.actor.user,
    actor_agent_principal: ctx.actor.agent_principal,
    actor_run: ctx.actor.run,
    occurred_at_server: ctx.now,
    payload,
  };
}

function authz(reason: RejectionReason, detail: string): DecisionRejected {
  return { ok: false, class: 'authz', reason, detail, events: [] };
}
function domain(ctx: DecideCtx, task_id: string, command: string, reason: RejectionReason, detail: string): DecisionRejected {
  // A domain rejection is itself a committed event (visible history, §2.1).
  const rej = env(ctx, 'CommandRejected', { task_id, command, reason, detail });
  return { ok: false, class: 'domain', reason, detail, events: [rej] };
}
function accept(events: EventEnvelope[]): DecisionAccepted {
  return { ok: true, events };
}

/**
 * Decide a command against a task's current projection (`state` is null iff the
 * task does not yet exist). Returns the canonical events to append, or a typed
 * rejection. Never mutates its inputs.
 */
export function decide(state: TaskState | null, cmd: Command, ctx: DecideCtx): Decision {
  const me = canonicalPrincipal(ctx.actor);

  // Authz gate first: only a current member may drive any command (§2.1). This
  // failure is audit-only; it never becomes a stream event.
  if (!ctx.isMember(me)) return authz('bad_state', 'caller is not a current member');

  if (cmd.kind === 'create') {
    if (state) return domain(ctx, cmd.task_id, 'create', 'slug_not_unique', 'task already exists');
    if (ctx.slugTaken(cmd.slug)) return domain(ctx, cmd.task_id, 'create', 'slug_not_unique', 'slug already in use in this stream');
    return accept([env(ctx, 'TaskCreated', { task_id: cmd.task_id, slug: cmd.slug })]);
  }

  // All other commands require an existing task.
  if (!state) return domain(ctx, cmd.task_id, cmd.kind, 'unknown_task', 'no such task in this stream');
  const s = state;
  const live = leaseLive(s, ctx.now);

  switch (cmd.kind) {
    case 'acquire': {
      // open/reopened always; active/awaiting_review only when the lease is expired.
      const acquirable =
        s.lifecycle === 'open' || s.lifecycle === 'reopened' ||
        ((s.lifecycle === 'active' || s.lifecycle === 'awaiting_review') && !live);
      if (!acquirable) {
        const why = s.lifecycle === 'done' ? 'task is done; reopen first' : 'lease is live; use takeover';
        return domain(ctx, cmd.task_id, 'acquire', 'not_acquirable', why);
      }
      const epoch = s.epoch + 1;
      return accept([env(ctx, 'LeaseAcquired', { task_id: cmd.task_id, epoch, owner: me, lease_expiry: ctx.now + cmd.ttl_ms })]);
    }

    case 'renew': {
      if (s.owner !== me) return domain(ctx, cmd.task_id, 'renew', 'not_owner', 'only the lease owner may renew');
      if (cmd.epoch !== s.epoch) return domain(ctx, cmd.task_id, 'renew', 'stale_epoch', `presented epoch ${cmd.epoch} != current ${s.epoch}`);
      if (!live) return domain(ctx, cmd.task_id, 'renew', 'lease_expired', 'lease already expired; re-acquire');
      return accept([env(ctx, 'LeaseRenewed', { task_id: cmd.task_id, epoch: s.epoch, lease_expiry: ctx.now + cmd.ttl_ms })]);
    }

    case 'handoff': {
      if (s.owner !== me) return domain(ctx, cmd.task_id, 'handoff', 'not_owner', 'only the lease owner may hand off');
      if (cmd.epoch !== s.epoch) return domain(ctx, cmd.task_id, 'handoff', 'stale_epoch', `presented epoch ${cmd.epoch} != current ${s.epoch}`);
      if (!live) return domain(ctx, cmd.task_id, 'handoff', 'lease_expired', 'lease expired; cannot hand off');
      if (!ctx.isEligibleRecipient(cmd.to_owner)) return domain(ctx, cmd.task_id, 'handoff', 'recipient_not_member', 'recipient is not a current member/principal');
      const epoch = s.epoch + 1;
      return accept([env(ctx, 'LeaseHandedOff', { task_id: cmd.task_id, epoch, from_owner: me, to_owner: cmd.to_owner, lease_expiry: ctx.now + cmd.ttl_ms })]);
    }

    case 'takeover': {
      if (s.lifecycle === 'done') return domain(ctx, cmd.task_id, 'takeover', 'not_acquirable', 'task is done; reopen first');
      if (live) {
        // Stealing a LIVE lease requires a takeover grant bound to the current epoch.
        if (!ctx.validTakeoverGrant(cmd.task_id, cmd.grant_id, s.epoch)) {
          return domain(ctx, cmd.task_id, 'takeover', 'live_lease_needs_grant', 'live lease; a takeover grant bound to the current epoch is required');
        }
      }
      // Expired lease → behaves as acquire (no grant needed).
      const epoch = s.epoch + 1;
      return accept([env(ctx, 'LeaseTakenOver', { task_id: cmd.task_id, epoch, owner: me, lease_expiry: ctx.now + cmd.ttl_ms, grant_id: live ? cmd.grant_id : null })]);
    }

    case 'submit': {
      if (s.owner !== me) return domain(ctx, cmd.task_id, 'submit', 'not_owner', 'only the lease owner may submit');
      if (cmd.epoch !== s.epoch) return domain(ctx, cmd.task_id, 'submit', 'stale_epoch', `presented epoch ${cmd.epoch} != current ${s.epoch}`);
      if (!live) return domain(ctx, cmd.task_id, 'submit', 'lease_expired', 'lease expired; re-acquire before submitting');
      if (s.lifecycle === 'done') return domain(ctx, cmd.task_id, 'submit', 'already_done', 'task is done');
      if (!ctx.evidenceComplete(cmd.task_id, cmd.evidence_set)) return domain(ctx, cmd.task_id, 'submit', 'evidence_incomplete', 'evidence bundle missing/invalid for this claim');
      // A new submit supersedes any prior one (reducer overwrites the frozen submission).
      return accept([env(ctx, 'TaskSubmitted', { task_id: cmd.task_id, epoch: s.epoch, branch: cmd.branch, head_sha: cmd.head_sha, evidence_set: [...cmd.evidence_set] })]);
    }

    case 'close': {
      if (s.lifecycle === 'done') return domain(ctx, cmd.task_id, 'close', 'already_done', 'task is already done');
      if (s.lifecycle !== 'awaiting_review' || !s.submission) return domain(ctx, cmd.task_id, 'close', 'not_submitted', 'no frozen submission to close');
      // Close binds to the FROZEN submission (survives lease expiry), not the live lease.
      if (cmd.epoch !== s.submission.epoch) return domain(ctx, cmd.task_id, 'close', 'stale_epoch', `presented epoch ${cmd.epoch} != submission epoch ${s.submission.epoch} (superseded?)`);
      const roleOf = ctx.role(me);
      const isAdmin = roleOf === 'owner' || roleOf === 'admin';
      const isOwnerOfTask = s.owner === me;
      if (!isAdmin && !isOwnerOfTask) return domain(ctx, cmd.task_id, 'close', 'not_owner', 'only the task owner or a workspace Owner/Admin may close');
      // Gated claims: the task owner needs a valid close grant bound to the frozen head_sha.
      // A human Owner/Admin may close a gated claim directly.
      if (ctx.claimRequiresGrant(cmd.task_id) && !isAdmin) {
        if (!ctx.validCloseGrant(cmd.task_id, cmd.grant_id, s.submission.head_sha)) {
          return domain(ctx, cmd.task_id, 'close', 'close_needs_grant', 'this claim requires a close grant bound to the submitted head SHA');
        }
      }
      return accept([env(ctx, 'TaskClosed', { task_id: cmd.task_id, epoch: s.submission.epoch, disposition: cmd.disposition, grant_id: cmd.grant_id })]);
    }

    case 'reopen': {
      if (s.lifecycle === 'open' || s.lifecycle === 'reopened') return domain(ctx, cmd.task_id, 'reopen', 'bad_state', 'task is already open/reopened');
      const roleOf = ctx.role(me);
      const isAdmin = roleOf === 'owner' || roleOf === 'admin';
      const isOwnerOfTask = s.owner === me;
      if (!isAdmin && !isOwnerOfTask) return domain(ctx, cmd.task_id, 'reopen', 'not_owner', 'reopen requires a workspace Owner/Admin or the task owner');
      return accept([env(ctx, 'TaskReopened', { task_id: cmd.task_id, version: s.version + 1 })]);
    }
  }
}
