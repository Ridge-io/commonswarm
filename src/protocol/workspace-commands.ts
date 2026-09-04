// Pure workspace-authority decision core (§3.4).
//
// Authorization facts are injected as transaction-time oracles. Credential
// kind and the agent-scope denylist are enforced here as defense in depth:
// wiring mistakes may not turn an agent credential into human authority.

import { Actor, SCHEMA_VERSION } from './events.js';
import {
  WorkspaceEventEnvelope,
  WorkspaceEventType,
  WorkspaceRejectionReason,
  WorkspaceRole,
  WorkspaceState,
} from './workspace-events.js';

export const INVITATION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const AGENT_TOKEN_DEFAULT_TTL_MS = 60 * 60 * 1_000;
/* 30 DAYS, raised 8h→24h→30d by operator rulings 2026-08-18/19. The bootstrap credential
 * crosses a human (pasted into another machine's chat, often after environment repair on
 * that side), and rotation cannot start until a listener is READY — the step most likely to
 * be broken. 30d is the ceiling BY CONSTRUCTION: it equals RENEWAL_HORIZON_DEFAULT_MS, the
 * once-a-month human reauthorisation checkpoint, so no bearer credential of any kind can
 * outlive a month without a person touching it. "Never expire" was considered and refused —
 * a pasted prompt is a standing transcript, and a non-expiring secret in one is a backdoor.
 * The web connect flow DEFAULTS to 24h and offers 7d/30d; rotation SUCCESSORS stay short
 * (renewal.ts keeps its own 8h successor cap); this bounds only the bootstrap. */
export const AGENT_TOKEN_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

// §2.3 continuous-renewal horizon. A worksession that runs for weeks must not
// be paid for by lengthening the bearer token: the TTL constants above stay
// where they are, and the successor endpoint below carries the run instead.
// The horizon is the periodic human reauthorisation that stops silent renewal
// becoming an unbounded ambient-authority deputy.
export const RENEWAL_HORIZON_DEFAULT_MS = 30 * 24 * 60 * 60 * 1_000;
export const RENEWAL_HORIZON_MAX_MS = 90 * 24 * 60 * 60 * 1_000;
/** ~1 successor/hour across the default horizon, with restart headroom. */
export const RENEWAL_MAX_SUCCESSORS_DEFAULT = 800;

/**
 * Days a STANDING grant may go unused before it pauses itself.
 *
 * A standing grant has no horizon, so this is the only automatic bound left on
 * it — and it has to stay, now that standing is what a person gets by default
 * from the web add-agent flow. Without it a forgotten agent would hold renewable
 * authority forever with nothing measuring whether anybody still wants it.
 *
 * It is no longer terminal. supabase/migrations/20260904000001_standing_grant_resume.sql
 * makes the pause recoverable by one explicit, audited action from a person who
 * could already revoke the grant, so idleness costs a restart rather than the
 * lineage.
 *
 * MIRRORS `interval '14 days'` in swarm.prepare_renewal_grant. This module is
 * pure and cannot read SQL, so the mirror is held by
 * tests/p1-cli/standing-grants.test.ts, which reads the migration and both
 * copies of the constant. The refusal detail below is BUILT from this number
 * rather than typed beside it.
 */
export const RENEWAL_IDLE_PAUSE_DAYS = 14;

export type WorkspaceCommand =
  | { kind: 'create_workspace'; workspace_id: string; name: string }
  | { kind: 'archive_workspace' }
  | {
      kind: 'invite_member';
      invitation_id: string;
      email: string | null;
      role: WorkspaceRole;
      token_hash: string;
      expires_at: number;
    }
  | { kind: 'revoke_invitation'; invitation_id: string }
  | { kind: 'accept_invitation'; token_hash: string }
  | {
      kind: 'remove_member';
      user_id: string;
      landing_authority_successor_user_id?: string;
    }
  | {
      kind: 'change_role';
      user_id: string;
      role: WorkspaceRole;
      landing_authority_successor_user_id?: string;
    }
  | {
      kind: 'create_agent_principal';
      principal_id: string;
      name: string;
      /** Human-declared model identity; never an authorization input. */
      model?: string | null;
    }
  | { kind: 'revoke_agent_principal'; principal_id: string }
  | {
      /**
       * Agent self-description (docs/design/2026-08-03-AGENT-SELF-IDENTIFY.md):
       * the target principal is ALWAYS the presenting token's own — there is no
       * target field, the same shape as renew_agent_token, so a worker can
       * describe itself and nothing else. Model is descriptive identity, never
       * an authorization input. Humans are refused: they already set model at
       * create_agent_principal, and self-description by proxy is a guess.
       */
      kind: 'declare_agent_model';
      model: string | null;
    }
  | {
      /**
       * Human-set agent model — the mirror of declare_agent_model. An agent may
       * only describe itself; a person may relabel agents in their workspace
       * under the same gate as revoke_agent_principal (owner/admin, or the
       * member who owns the principal). Model stays descriptive identity,
       * never an authorization input; the event envelope's actor_user carries
       * WHO set it, distinguishing a human set from a self-declaration.
       */
      kind: 'set_agent_model';
      principal_id: string;
      model: string | null;
    }
  | {
      /**
       * Product feedback from the people AND the agents using the deployment —
       * the operator's ruling (2026-08-19) is that agents are the real users
       * and their bug reports and feature requests are collected first-class.
       * Accepted from BOTH credential kinds; attribution comes from the
       * presenting credential only (no caller-supplied reporter fields), and
       * the payload is inert product data: it grants nothing, targets nothing,
       * and is never an authorization input.
       */
      kind: 'submit_feedback';
      feedback_id: string;
      category: 'bug' | 'idea' | 'friction';
      body: string;
      /** Flat client-declared context (cswarm version, host, surface). */
      context: Record<string, string> | null;
    }
  | {
      kind: 'mint_agent_token';
      token_id: string;
      principal_id: string;
      run_id: string;
      task_id: string;
      epoch: number;
      scopes: string[];
      ttl_ms?: number;
    }
  | { kind: 'revoke_agent_token'; token_id: string }
  | {
      /**
       * §2.3 fenced successor — never the generic mint. The presented
       * predecessor credential is the whole caller input: `ctx` carries it as
       * `presenting_token_id`, and principal, run, task and epoch are not
       * fields at all because the reducer reads them off the predecessor row.
       *
       * The two fields present are adapter-derived, not caller-selected.
       * `successor_token_id` is minted by the adapter; `scopes` are the ones
       * the adapter read FROM THE PREDECESSOR, restated here only so the
       * reducer can re-check attenuation against the predecessor rather than
       * trust the adapter. An adapter wiring mistake therefore cannot widen a
       * successor, which is the entire point of §2.3's "attenuation vs the
       * predecessor, NOT the human's broader rights".
       */
      kind: 'renew_agent_token';
      successor_token_id: string;
      scopes: string[];
    };

/** Bounded renewal grant created at human `join`/`spawn` (§2.3). */
export interface RenewalGrantFacts {
  renewal_grant_id: string;
  kind: 'timeboxed' | 'standing';
  /** NULL means unlimited and is valid only for a standing grant. */
  max_successors: number | null;
  successors_used: number;
  /**
   * Successors this grant issued that were never used, because the response
   * carrying the raw credential was lost. Subtracted from `successors_used` to
   * give the effective spend the ceiling is measured against: an attempt that
   * reached nobody must not cost budget, or a flaky network becomes the human
   * reauthorisation renewal exists to avoid.
   *
   * A separate monotone counter rather than a decrement of `successors_used`:
   * the database refuses to lower either number, so "credit" can only ever be
   * a record of something that happened, never an unwinding.
   */
  successors_stranded: number;
  /** NULL means no horizon and is valid only for a standing grant. */
  horizon_expires_at: number | null;
  revoked_at: number | null;
  suspended_at: number | null;
}

/** Transaction-time renewal facts, all read from server state (§2.3). */
export interface RenewalFacts {
  /** Live grant for the predecessor's (principal, run); null when absent. */
  grant: RenewalGrantFacts | null;
  /** The predecessor row names a grant other than the run's live grant. */
  grant_mismatch: boolean;
  /**
   * An UNREVOKED successor for this exact predecessor already exists.
   *
   * "Unrevoked", not "exists": a revoked successor frees the one-successor slot
   * on purpose, and this flag has to say the same thing the partial unique index
   * says or the reducer and the database disagree about who may renew.
   */
  superseded: boolean;
  /**
   * That successor has never authenticated — PENDING — so by definition nobody
   * holds a working copy of it and it is disposable. Meaningful only when
   * `superseded`; false when no successor exists.
   */
  successor_pending: boolean;
  /** The existing successor's id, so an adapter can replace a pending one. */
  successor_token_id: string | null;
  /**
   * The PRESENTING predecessor had itself never authenticated before this
   * request, read BEFORE this request's own first-use stamp. See the refusal
   * below for why a token in that state may not renew.
   */
  predecessor_pending: boolean;
  /** Any token in the lineage is revoked, or the lineage carries a tombstone. */
  lineage_revoked: boolean;
  /**
   * Stable result of the database's lazy standing-grant check. It can persist an
   * idle suspension or new-host stamp before the pure reducer refuses renewal.
   */
  grant_preflight_code:
    | 'renewal_grant_not_found'
    | 'renewal_grant_revoked'
    | 'renewal_grant_suspended'
    | 'renewal_idle_suspended'
    | 'renewal_horizon_reached'
    | 'renewal_device_unavailable'
    | 'renewal_device_mismatch'
    | null;
}

export interface DecideWorkspaceCtx {
  now: number;
  actor: Actor;
  credential_kind: 'human' | 'agent';
  /** Exact presenting token, populated only for an agent capability credential. */
  presenting_token_id: string | null;
  command_id: string;
  workspace_id: string;
  stream_id: string;

  /** P1 workspace creation is operator-allowlisted. */
  operatorAllowed(actor: Actor): boolean;
  /** Live workspace role; null means no current membership. */
  role(user_id: string): WorkspaceRole | null;
  /** Invitation target already resolves to a live member. */
  inviteeAlreadyMember(email: string | null): boolean;
  /** The human identity has completed the verification required for acceptance. */
  identityVerified(user_id: string): boolean;
  /** Current rights of the presenting human credential. */
  humanRights(actor: Actor): readonly string[];
  /**
   * True if the target holds no landing authority, or the supplied successor
   * resolves every affected authority to a live eligible human.
   */
  landingAuthorityChangeResolved(
    target_user_id: string,
    successor_user_id: string | null,
  ): boolean;
  /**
   * Renewal facts for the presenting predecessor (§2.3). Optional so an
   * adapter that has not wired renewal fails closed — `renewal_unsupported` —
   * instead of renewing against permissive defaults.
   */
  renewalFacts?(predecessor_token_id: string): RenewalFacts;

  nextSeq(): number;
  nextEventId(): string;
}

/**
 * §2.3 successor refusals. Each is its own string so an audit row names the
 * exact fence that fired: "renewal refused" without the cause is unactionable
 * for the operator who has to decide between reauthorising and revoking.
 */
export type RenewalRejectionReason =
  | 'renewal_unsupported'
  | 'renewal_requires_agent_credential'
  | 'predecessor_not_presented'
  | 'predecessor_not_found'
  | 'predecessor_not_owned'
  | 'predecessor_revoked'
  | 'predecessor_expired'
  | 'predecessor_superseded'
  | 'predecessor_pending_first_use'
  | 'renewal_binding_incomplete'
  | 'renewal_lineage_revoked'
  | 'renewal_grant_not_found'
  | 'renewal_grant_mismatch'
  | 'renewal_grant_revoked'
  | 'renewal_grant_suspended'
  | 'renewal_idle_suspended'
  | 'renewal_device_unavailable'
  | 'renewal_device_mismatch'
  | 'renewal_horizon_reached'
  | 'renewal_horizon_invalid'
  | 'renewal_successors_exhausted'
  | 'renewal_scope_widened';

/**
 * Renewal reasons live here rather than in the shared event vocabulary so the
 * successor endpoint can name each fence without widening `WorkspaceRejectionReason`,
 * which other streams also consume.
 */
export type WorkspaceCommandRejectionReason =
  | WorkspaceRejectionReason
  | RenewalRejectionReason;

export interface WorkspaceDecisionAccepted {
  ok: true;
  events: WorkspaceEventEnvelope[];
}

export interface WorkspaceDecisionRejected {
  ok: false;
  class: 'authz' | 'domain';
  reason: WorkspaceCommandRejectionReason;
  detail: string;
  /** Empty for authz; exactly one CommandRejected for domain refusal. */
  events: WorkspaceEventEnvelope[];
}

export type WorkspaceDecision = WorkspaceDecisionAccepted | WorkspaceDecisionRejected;

/**
 * READ THIS BEFORE "FIXING" THE OMISSION BELOW.
 *
 * `renew_agent_token` is deliberately absent from this set, and that is not an
 * oversight. §2.3 renewal is presented BY the worker credential being renewed,
 * so requiring a human credential would make the endpoint unreachable and put
 * us back on the 8h wall. It is the single exception, and it is fenced rather
 * than trusted: the `renew_agent_token` case refuses a human credential too,
 * accepts no caller-selected target fields, and re-applies
 * `isAgentScopeDenylisted` to the inherited scopes. Every OTHER command an
 * agent may not issue is still listed here — adding renewal to the list, or
 * removing anything else from it, both break §2.3.
 */
const HUMAN_ONLY_COMMANDS = new Set<WorkspaceCommand['kind']>([
  'create_workspace',
  'archive_workspace',
  'invite_member',
  'revoke_invitation',
  'accept_invitation',
  'remove_member',
  'change_role',
  'create_agent_principal',
  'revoke_agent_principal',
  'set_agent_model',
  'mint_agent_token',
]);

/**
 * Intrinsic denylist categories from §2.3. This is deliberately not injectable:
 * a missing or permissive I/O adapter cannot authorize these agent capabilities.
 * Scopes are tokenized so equivalent `:`, `.`, `_`, and `-` spellings cannot
 * evade the category checks.
 */
export function isAgentScopeDenylisted(scope: string): boolean {
  const words = scopeWords(scope);
  const has = (...values: string[]) => values.some((value) => words.has(value));
  const mutates = has(
    'accept', 'add', 'archive', 'assign', 'author', 'change', 'create',
    'delete', 'demote', 'invalidate', 'issue', 'map', 'mint', 'promote',
    'remove', 'remap', 'revoke', 'set', 'transfer', 'update', 'write',
  );

  if (words.has('grant') && has('create', 'issuance', 'issue', 'mint', 'revoke')) return true;
  if (
    has('credential', 'token', 'worker')
    && has('create', 'issuance', 'issue', 'mint', 'renew')
  ) return true;
  if (has('invite', 'invitation')) return true;
  if (has('membership', 'member', 'role', 'owner', 'ownership') && mutates) return true;
  if (has('repo', 'repository') && has('archive', 'map', 'remap')) return true;
  if (words.has('workspace') && has('archive', 'create', 'delete')) return true;
  if (words.has('capability') && words.has('url') && has('create', 'issue', 'mint')) return true;
  if (words.has('discard')) return true;
  if (
    has('invalidate', 'revoke')
    && has(
      'credential', 'device', 'family', 'lineage', 'membership',
      'principal', 'refresh', 'run', 'token',
    )
  ) return true;
  if (mutates && has('knowledge', 'playbook')) return true;
  if (mutates && words.has('instruction') && has('foundational', 'trusted')) return true;
  if (mutates && words.has('schema') && has('acceptance', 'trusted')) return true;
  return false;
}

function scopeWords(scope: string): Set<string> {
  return new Set(
    scope
      .trim()
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((word) => {
        if (word.length > 3 && word.endsWith('ies')) {
          return `${word.slice(0, -3)}y`;
        }
        if (word.length > 1 && word.endsWith('s') && !word.endsWith('ss')) {
          return word.slice(0, -1);
        }
        return word;
      }),
  );
}

function env<P>(
  ctx: DecideWorkspaceCtx,
  type: WorkspaceEventType,
  payload: P,
): WorkspaceEventEnvelope<P> {
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

function accept(events: WorkspaceEventEnvelope[]): WorkspaceDecisionAccepted {
  return { ok: true, events };
}

function authz(
  reason: WorkspaceCommandRejectionReason,
  detail: string,
): WorkspaceDecisionRejected {
  return { ok: false, class: 'authz', reason, detail, events: [] };
}

function domain(
  ctx: DecideWorkspaceCtx,
  command: WorkspaceCommand['kind'],
  reason: WorkspaceCommandRejectionReason,
  detail: string,
): WorkspaceDecisionRejected {
  return {
    ok: false,
    class: 'domain',
    reason,
    detail,
    events: [
      env(ctx, 'CommandRejected', {
        workspace_id: ctx.workspace_id,
        command,
        reason,
        detail,
      }),
    ],
  };
}

function liveMember(state: WorkspaceState, user_id: string) {
  const member = state.members[user_id];
  return member?.revoked_at === null ? member : null;
}

function callerUser(ctx: DecideWorkspaceCtx): string | null {
  return ctx.actor.user;
}

/**
 * One normalization for BOTH model-writing commands (declare_agent_model,
 * set_agent_model), so the agent path and the human path can never drift.
 * Mirrors agent_principals_model_bounded in
 * 20260730000001_workspace_access_lifecycle.sql: btrim'd, 1..120 chars, no
 * [[:cntrl:]] (C0 + DEL); the class here adds C1 + bidi controls, deliberately
 * STRICTER than the constraint — accepted-by-reducer must never fail projection.
 */
function normalizedModel(
  value: unknown,
): { ok: true; model: string | null } | { ok: false; message: string } {
  if (value === null) return { ok: true, model: null };
  if (typeof value !== 'string') {
    return { ok: false, message: 'model must be a string or null' };
  }
  const trimmed = value.trim();
  if (trimmed.length > 120) {
    return { ok: false, message: 'model must be at most 120 characters' };
  }
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(trimmed)) {
    return { ok: false, message: 'model must not contain control characters' };
  }
  return { ok: true, model: trimmed.length === 0 ? null : trimmed };
}

export const FEEDBACK_CATEGORIES = ['bug', 'idea', 'friction'] as const;
export const FEEDBACK_BODY_MAX = 4_000;
export const FEEDBACK_CONTEXT_MAX_BYTES = 2_048;

/**
 * One normalization for feedback bodies, mirrored by feedback_body_bounded in
 * the swarm.feedback migration: trimmed, 1..4000 chars, and unlike model
 * strings the body may carry newlines and tabs (it is prose); every other
 * control character (C0, DEL, C1, bidi) is refused. Stricter here than the DB
 * constraint in the same direction as normalizedModel — accepted-by-reducer
 * must never fail projection.
 */
export function normalizedFeedbackBody(
  value: unknown,
): { ok: true; body: string } | { ok: false; message: string } {
  if (typeof value !== 'string') {
    return { ok: false, message: 'feedback body must be a string' };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'feedback body must not be empty' };
  }
  if (trimmed.length > FEEDBACK_BODY_MAX) {
    return { ok: false, message: `feedback body must be at most ${FEEDBACK_BODY_MAX} characters` };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(trimmed)) {
    return { ok: false, message: 'feedback body must not contain control characters (newlines and tabs are fine)' };
  }
  return { ok: true, body: trimmed };
}

/** Flat string map, bounded serialized — context is descriptive, never large. */
export function normalizedFeedbackContext(
  value: unknown,
): { ok: true; context: Record<string, string> | null } | { ok: false; message: string } {
  if (value === null || value === undefined) return { ok: true, context: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'feedback context must be a flat object of strings' };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entry] of entries) {
    if (typeof entry !== 'string' || key.length === 0 || key.length > 64 || entry.length > 512) {
      return { ok: false, message: 'feedback context must be a flat object of bounded strings' };
    }
    if (/[\u0000-\u001f\u007f-\u009f]/.test(key + entry)) {
      return { ok: false, message: 'feedback context must not contain control characters' };
    }
  }
  if (entries.length === 0) return { ok: true, context: null };
  const serialized = JSON.stringify(Object.fromEntries(entries));
  // BYTES, not characters: the field is named _MAX_BYTES and this bounds what lands
  // in jsonb. length alone let a 1446-char CJK context store 4643 bytes (both arms).
  if (new TextEncoder().encode(serialized).length > FEEDBACK_CONTEXT_MAX_BYTES) {
    return { ok: false, message: `feedback context must serialize to at most ${FEEDBACK_CONTEXT_MAX_BYTES} bytes` };
  }
  return { ok: true, context: Object.fromEntries(entries) as Record<string, string> };
}

function ownerOrAdmin(role: WorkspaceRole | null): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Decide one workspace-authority command. Inputs and outputs are immutable;
 * raw credential/invitation material and hashing stay outside this module.
 */
export function decideWorkspace(
  state: WorkspaceState | null,
  cmd: WorkspaceCommand,
  ctx: DecideWorkspaceCtx,
): WorkspaceDecision {
  const user_id = callerUser(ctx);
  if (!user_id) {
    return authz('bad_state', 'credential has no server-derived human owner');
  }

  if (HUMAN_ONLY_COMMANDS.has(cmd.kind) && ctx.credential_kind !== 'human') {
    return authz('credential_kind_forbidden', 'command requires an interactive human credential');
  }

  if (cmd.kind === 'create_workspace') {
    if (state) {
      if (ctx.role(user_id) === null) {
        return authz('bad_state', 'caller is not a current workspace member');
      }
      return domain(ctx, cmd.kind, 'workspace_exists', 'workspace already exists');
    }
    if (!ctx.operatorAllowed(ctx.actor)) {
      return authz('operator_not_allowed', 'caller is not allowed to create a workspace');
    }
    if (cmd.workspace_id !== ctx.workspace_id) {
      return authz('bad_state', 'command does not match the resolved workspace');
    }
    return accept([
      env(ctx, 'WorkspaceCreated', {
        workspace_id: cmd.workspace_id,
        name: cmd.name,
        created_by: user_id,
        created_at: ctx.now,
      }),
    ]);
  }

  if (!state) {
    return authz('workspace_not_found', 'workspace is unavailable');
  }

  // Invitation acceptance is the sole non-member command: the capability hash
  // selects the invitation, and invitee/workspace binding comes from server
  // state plus auth.uid(); no invitation id is client-selectable.
  if (cmd.kind === 'accept_invitation') {
    if (!ctx.identityVerified(user_id)) {
      return authz('identity_not_verified', 'verified identity is required');
    }
    const matches = Object.values(state.invitations).filter(
      (invitation) => invitation.token_hash === cmd.token_hash,
    );
    if (matches.length !== 1) {
      return authz('invitation_token_mismatch', 'invitation capability is invalid');
    }
    const invitation = matches[0];
    if (
      invitation.consumed_at !== null
      || invitation.revoked_at !== null
      || invitation.expires_at <= ctx.now
    ) {
      return domain(ctx, cmd.kind, 'invitation_not_live', 'invitation is consumed, revoked, or expired');
    }
    if (liveMember(state, user_id)) {
      return domain(ctx, cmd.kind, 'member_exists', 'invitee is already a current member');
    }
    return accept([
      env(ctx, 'InvitationAccepted', {
        invitation_id: invitation.invitation_id,
        consumed_by: user_id,
        consumed_at: ctx.now,
      }),
      env(ctx, 'MemberJoined', {
        user_id,
        role: invitation.role,
        invited_by: invitation.created_by,
        joined_at: ctx.now,
      }),
    ]);
  }

  const actorRole = ctx.role(user_id);
  if (actorRole === null) {
    return authz('bad_state', 'caller is not a current workspace member');
  }

  switch (cmd.kind) {
    case 'archive_workspace': {
      if (actorRole !== 'owner') {
        return domain(
          ctx,
          cmd.kind,
          'not_workspace_owner',
          'closing a workspace requires the Owner role',
        );
      }
      /* Refuse instead of treating a second archive as success. A close command that
       * reaches the reducer twice with different command ids must not claim it changed
       * anything twice; normal HTTP routing hides archived workspaces before this point. */
      if (state.workspace.archived_at !== null) {
        return domain(
          ctx,
          cmd.kind,
          'workspace_already_archived',
          'workspace is already closed',
        );
      }
      return accept([
        env(ctx, 'WorkspaceArchived', { archived_at: ctx.now }),
      ]);
    }

    case 'invite_member': {
      if (!ownerOrAdmin(actorRole)) {
        return domain(ctx, cmd.kind, 'role_forbidden', 'inviting members requires Owner/Admin');
      }
      if (cmd.role === 'owner' && actorRole !== 'owner') {
        return domain(ctx, cmd.kind, 'role_forbidden', 'only an Owner may invite another Owner');
      }
      if (
        !Number.isFinite(cmd.expires_at)
        || cmd.expires_at <= ctx.now
        || cmd.expires_at - ctx.now > INVITATION_MAX_TTL_MS
      ) {
        return domain(ctx, cmd.kind, 'invitation_ttl_invalid', 'invitation TTL must be positive and at most 7 days');
      }
      if (ctx.inviteeAlreadyMember(cmd.email)) {
        return domain(ctx, cmd.kind, 'member_exists', 'invitee is already a current member');
      }
      if (
        state.invitations[cmd.invitation_id]
        || Object.values(state.invitations).some(
          (invitation) => invitation.token_hash === cmd.token_hash,
        )
      ) {
        return domain(ctx, cmd.kind, 'bad_state', 'invitation id or token hash already exists');
      }
      return accept([
        env(ctx, 'MemberInvited', {
          invitation_id: cmd.invitation_id,
          email: cmd.email,
          role: cmd.role,
          token_hash: cmd.token_hash,
          expires_at: cmd.expires_at,
          created_by: user_id,
          created_at: ctx.now,
        }),
      ]);
    }

    case 'revoke_invitation': {
      if (!ownerOrAdmin(actorRole)) {
        return domain(ctx, cmd.kind, 'role_forbidden', 'revoking invitations requires Owner/Admin');
      }
      const invitation = state.invitations[cmd.invitation_id];
      if (!invitation) {
        return domain(ctx, cmd.kind, 'invitation_not_found', 'invitation does not exist');
      }
      if (
        invitation.consumed_at !== null
        || invitation.revoked_at !== null
        || invitation.expires_at <= ctx.now
      ) {
        return domain(ctx, cmd.kind, 'invitation_not_live', 'invitation is not live');
      }
      return accept([
        env(ctx, 'InvitationRevoked', {
          invitation_id: cmd.invitation_id,
          revoked_at: ctx.now,
        }),
      ]);
    }

    case 'remove_member': {
      if (!ownerOrAdmin(actorRole)) {
        return domain(ctx, cmd.kind, 'role_forbidden', 'removing members requires Owner/Admin');
      }
      const target = liveMember(state, cmd.user_id);
      if (!target) {
        return domain(ctx, cmd.kind, 'member_not_found', 'target is not a current member');
      }
      if (actorRole === 'admin' && target.role === 'owner') {
        return domain(ctx, cmd.kind, 'role_forbidden', 'Admin cannot remove an Owner');
      }
      if (target.role === 'owner' && state.owners_count <= 1) {
        return domain(ctx, cmd.kind, 'last_owner', 'last Owner cannot be removed');
      }
      if (!ctx.landingAuthorityChangeResolved(
        cmd.user_id,
        cmd.landing_authority_successor_user_id ?? null,
      )) {
        return domain(
          ctx,
          cmd.kind,
          'landing_authority_unresolved',
          'landing authority must be transferred to a live successor first',
        );
      }
      return accept([
        env(ctx, 'MemberRemoved', { user_id: cmd.user_id, revoked_at: ctx.now }),
      ]);
    }

    case 'change_role': {
      if (!ownerOrAdmin(actorRole)) {
        return domain(ctx, cmd.kind, 'role_forbidden', 'changing roles requires Owner/Admin');
      }
      const target = liveMember(state, cmd.user_id);
      if (!target) {
        return domain(ctx, cmd.kind, 'member_not_found', 'target is not a current member');
      }
      if (target.role === cmd.role) {
        return domain(ctx, cmd.kind, 'bad_state', 'member already has that role');
      }
      if (
        actorRole === 'admin'
        && (target.role === 'owner' || cmd.role === 'owner')
      ) {
        return domain(ctx, cmd.kind, 'role_forbidden', 'Admin cannot add, remove, or change an Owner');
      }
      if (target.role === 'owner' && cmd.role !== 'owner' && state.owners_count <= 1) {
        return domain(ctx, cmd.kind, 'last_owner', 'last Owner cannot be demoted');
      }
      if (!ctx.landingAuthorityChangeResolved(
        cmd.user_id,
        cmd.landing_authority_successor_user_id ?? null,
      )) {
        return domain(
          ctx,
          cmd.kind,
          'landing_authority_unresolved',
          'landing authority must be transferred to a live successor first',
        );
      }
      return accept([
        env(ctx, 'MemberRoleChanged', {
          user_id: cmd.user_id,
          from_role: target.role,
          to_role: cmd.role,
        }),
      ]);
    }

    case 'create_agent_principal': {
      if (
        state.principals[cmd.principal_id]
        || Object.values(state.principals).some((principal) => principal.name === cmd.name)
      ) {
        return domain(ctx, cmd.kind, 'principal_name_taken', 'principal id or name already exists');
      }
      return accept([
        env(ctx, 'AgentPrincipalCreated', {
          principal_id: cmd.principal_id,
          owner_user_id: user_id,
          name: cmd.name,
          model: cmd.model ?? null,
          created_at: ctx.now,
        }),
      ]);
    }

    case 'revoke_agent_principal': {
      const principal = state.principals[cmd.principal_id];
      if (!principal) {
        return domain(ctx, cmd.kind, 'principal_not_found', 'agent principal does not exist');
      }
      if (principal.revoked_at !== null) {
        return domain(ctx, cmd.kind, 'principal_revoked', 'agent principal is already revoked');
      }
      if (!ownerOrAdmin(actorRole) && principal.owner_user_id !== user_id) {
        return domain(ctx, cmd.kind, 'principal_not_owned', 'Member may revoke only their own principal');
      }
      return accept([
        env(ctx, 'AgentPrincipalRevoked', {
          principal_id: cmd.principal_id,
          revoked_at: ctx.now,
        }),
      ]);
    }

    case 'submit_feedback': {
      /* Both credential kinds are welcome — feedback is the one command where
       * the AGENT is the primary author by design (operator ruling 2026-08-19:
       * agents are the real users). Attribution comes from the presenting
       * credential alone; the command carries no reporter fields to lie in. */
      /* feedback_id's UUID shape is a wire concern, enforced at the edge like
       * every other client-generated id in this file — the reducer validates
       * semantics only, matching its siblings. */
      if (!FEEDBACK_CATEGORIES.includes(cmd.category)) {
        return domain(ctx, cmd.kind, 'feedback_invalid', 'category must be bug, idea, or friction');
      }
      const body = normalizedFeedbackBody(cmd.body);
      if (!body.ok) {
        return domain(ctx, cmd.kind, 'feedback_invalid', body.message);
      }
      const context = normalizedFeedbackContext(cmd.context);
      if (!context.ok) {
        return domain(ctx, cmd.kind, 'feedback_invalid', context.message);
      }
      let reporter_kind: 'user' | 'agent';
      let reporter_id: string;
      if (ctx.credential_kind === 'agent') {
        if (ctx.actor.agent_principal === null) {
          return authz('principal_not_presented', 'agent feedback requires the presenting principal to be resolved');
        }
        const reporting = state.principals[ctx.actor.agent_principal];
        if (!reporting || reporting.revoked_at !== null) {
          return domain(ctx, cmd.kind, 'principal_revoked', 'the presenting principal is missing or revoked');
        }
        reporter_kind = 'agent';
        reporter_id = reporting.principal_id;
      } else {
        if (ctx.role(user_id) === null) {
          return authz('bad_state', 'caller is not a current workspace member');
        }
        reporter_kind = 'user';
        reporter_id = user_id;
      }
      return accept([
        env(ctx, 'FeedbackSubmitted', {
          feedback_id: cmd.feedback_id,
          category: cmd.category,
          body: body.body,
          context: context.context,
          reporter_kind,
          reporter_id,
          submitted_at: ctx.now,
        }),
      ]);
    }

    case 'mint_agent_token': {
      const principal = state.principals[cmd.principal_id];
      if (!principal) {
        return domain(ctx, cmd.kind, 'principal_not_found', 'agent principal does not exist');
      }
      if (principal.revoked_at !== null) {
        return domain(ctx, cmd.kind, 'principal_revoked', 'agent principal is revoked');
      }
      if (principal.owner_user_id !== user_id) {
        return domain(ctx, cmd.kind, 'principal_not_owned', 'tokens may be minted only for an owned principal');
      }
      if (
        !cmd.run_id
        || !cmd.task_id
        || !Number.isInteger(cmd.epoch)
        || cmd.epoch < 0
      ) {
        return domain(ctx, cmd.kind, 'binding_required', 'run_id, task_id, and a non-negative integer epoch are required');
      }
      const ttl = cmd.ttl_ms ?? AGENT_TOKEN_DEFAULT_TTL_MS;
      if (!Number.isFinite(ttl) || ttl <= 0 || ttl > AGENT_TOKEN_MAX_TTL_MS) {
        return domain(ctx, cmd.kind, 'token_ttl_invalid', 'token TTL must be positive and at most 30 days');
      }
      if (state.tokens[cmd.token_id]) {
        return domain(ctx, cmd.kind, 'bad_state', 'token id already exists');
      }
      if (
        cmd.scopes.length === 0
        || cmd.scopes.some((scope) => scopeWords(scope).size === 0)
      ) {
        return domain(ctx, cmd.kind, 'scope_not_allowed', 'at least one concrete scope is required');
      }
      if (cmd.scopes.some(isAgentScopeDenylisted)) {
        return domain(ctx, cmd.kind, 'scope_denylisted', 'one or more scopes are human-credential-only');
      }
      const humanRights = new Set(ctx.humanRights(ctx.actor));
      if (cmd.scopes.some((scope) => !humanRights.has(scope))) {
        return domain(ctx, cmd.kind, 'scope_not_allowed', 'requested scopes exceed the human credential rights');
      }
      return accept([
        env(ctx, 'AgentTokenMinted', {
          token_id: cmd.token_id,
          principal_id: cmd.principal_id,
          run_id: cmd.run_id,
          task_id: cmd.task_id,
          epoch: cmd.epoch,
          scopes: [...cmd.scopes],
          issued_at: ctx.now,
          expires_at: ctx.now + ttl,
        }),
      ]);
    }

    case 'declare_agent_model': {
      if (ctx.credential_kind !== 'agent') {
        return authz(
          'credential_kind_forbidden',
          'model declaration is presented by the agent describing itself; a human sets model at principal creation',
        );
      }
      if (ctx.actor.agent_principal === null) {
        return authz(
          'principal_not_presented',
          'model declaration requires the presenting agent principal to be resolved',
        );
      }
      const declaring = state.principals[ctx.actor.agent_principal];
      if (!declaring || declaring.revoked_at !== null) {
        return domain(ctx, cmd.kind, 'principal_revoked', 'the presenting principal is missing or revoked');
      }
      const normalized = normalizedModel(cmd.model);
      if (!normalized.ok) {
        return domain(ctx, cmd.kind, 'model_invalid', normalized.message);
      }
      return accept([
        env(ctx, 'AgentModelDeclared', {
          principal_id: declaring.principal_id,
          model: normalized.model,
          declared_at: ctx.now,
        }),
      ]);
    }

    case 'set_agent_model': {
      /* Same gate as revoke_agent_principal: owner/admin roles manage any
       * agent in the workspace; a plain member manages only their own. The
       * HUMAN_ONLY set already refused agent credentials before this case. */
      const principal = state.principals[cmd.principal_id];
      if (!principal) {
        return domain(ctx, cmd.kind, 'principal_not_found', 'agent principal does not exist');
      }
      if (principal.revoked_at !== null) {
        return domain(ctx, cmd.kind, 'principal_revoked', 'agent principal is revoked');
      }
      if (!ownerOrAdmin(actorRole) && principal.owner_user_id !== user_id) {
        return domain(ctx, cmd.kind, 'principal_not_owned', "Member may set only their own principal's model");
      }
      const normalized = normalizedModel(cmd.model);
      if (!normalized.ok) {
        return domain(ctx, cmd.kind, 'model_invalid', normalized.message);
      }
      return accept([
        env(ctx, 'AgentModelDeclared', {
          principal_id: principal.principal_id,
          model: normalized.model,
          declared_at: ctx.now,
        }),
      ]);
    }

    // §2.3 worker-token renewal: a fenced SUCCESSOR operation, never a mint.
    // The successor inherits principal, run, task, epoch and scopes from the
    // predecessor row in state; nothing here is read from the command except
    // the adapter-minted successor id and the scopes it claims to have copied,
    // and those scopes are checked back against the predecessor below.
    case 'renew_agent_token': {
      if (ctx.credential_kind !== 'agent') {
        return authz(
          'renewal_requires_agent_credential',
          'renewal is presented by the worker credential being renewed; a human re-authorises by minting',
        );
      }
      if (ctx.presenting_token_id === null || ctx.actor.agent_principal === null) {
        return authz(
          'predecessor_not_presented',
          'renewal requires the presenting agent token to be resolved',
        );
      }
      const predecessor = state.tokens[ctx.presenting_token_id];
      if (!predecessor) {
        return domain(
          ctx,
          cmd.kind,
          'predecessor_not_found',
          'presenting token is not a token of this workspace',
        );
      }
      if (!ctx.renewalFacts) {
        return authz(
          'renewal_unsupported',
          'no renewal oracle is wired; renewal fails closed rather than defaulting',
        );
      }
      if (predecessor.principal_id !== ctx.actor.agent_principal) {
        return authz(
          'predecessor_not_owned',
          'presenting token does not belong to the acting principal',
        );
      }
      const principal = state.principals[predecessor.principal_id];
      if (!principal || principal.revoked_at !== null) {
        return domain(
          ctx,
          cmd.kind,
          'principal_revoked',
          'the predecessor principal is missing or revoked',
        );
      }
      if (predecessor.revoked_at !== null) {
        return domain(ctx, cmd.kind, 'predecessor_revoked', 'predecessor token is revoked');
      }
      const facts = ctx.renewalFacts(predecessor.token_id);
      /* ★ SUPERSESSION IS CHECKED BEFORE EXPIRY, AND THE ORDER IS THE WHOLE POINT.
       *
       * Superseding a predecessor is implemented as setting expires_at = now, so a
       * superseded token IS an expired token and the expiry branch would always answer
       * first. That made 'predecessor_superseded' unreachable — a named reason that could
       * never fire, which reads as a distinction the system draws and does not.
       *
       * (Supersession now happens at the successor's FIRST USE rather than at issue, so
       * the two are no longer simultaneous — but the ordering still matters, because by
       * the time a second renewal is attempted the successor has usually been used and the
       * predecessor has therefore been ended. Nothing below relies on the old timing.)
       *
       * It matters beyond tidiness because these two say opposite things to whoever is
       * holding the credential. 'expired' means time passed and you should have renewed
       * sooner. 'superseded' means A SUCCESSOR ALREADY EXISTS — you renewed twice, or you
       * lost a concurrency race, and there is a live credential you should be using instead.
       * Told the wrong one, an agent retries the renewal that just lost and loses again.
       *
       * Measured: the concurrent-double-renewal test had exactly one winner (correct) while
       * the loser was told 'predecessor_expired' (misleading), which is how this surfaced.
       *
       * ★ `&& !facts.successor_pending` IS THE SELF-HEALING CLAUSE, NOT A LOOSENING.
       * A successor that has never authenticated reached nobody: the only copy of its raw
       * credential was in a response body, and if the presenter is back here asking again
       * then that body did not arrive. Refusing it 'predecessor_superseded' is what stranded
       * the worker permanently — a live successor nobody can reach, and a human
       * reauthorisation caused by a dropped connection. So a PENDING successor falls through
       * to be discarded and replaced by the adapter (which revokes it, recording that it was
       * stranded), while a USED successor still refuses here: that agent HAS a working
       * credential and must use it rather than renewing again. */
      if (facts.superseded && !facts.successor_pending) {
        return domain(
          ctx,
          cmd.kind,
          'predecessor_superseded',
          'predecessor has already issued a successor; use it rather than renewing again',
        );
      }
      if (predecessor.expires_at <= ctx.now) {
        return domain(ctx, cmd.kind, 'predecessor_expired', 'predecessor token has expired');
      }
      if (predecessor.task_id === null || predecessor.epoch === null) {
        return domain(
          ctx,
          cmd.kind,
          'renewal_binding_incomplete',
          'predecessor carries no task/epoch binding for the successor to inherit',
        );
      }
      // Fail-closed and lineage-wide: revoking any token in the lineage stops
      // every descendant renewing, so an individually-revoked worker can never
      // be resurrected through its children.
      if (facts.lineage_revoked) {
        return domain(
          ctx,
          cmd.kind,
          'renewal_lineage_revoked',
          'the renewal lineage carries a revocation',
        );
      }
      if (facts.grant_mismatch) {
        return domain(
          ctx,
          cmd.kind,
          'renewal_grant_mismatch',
          'the named grant is bound to a different principal or run',
        );
      }
      const grant = facts.grant;
      if (!grant) {
        return domain(
          ctx,
          cmd.kind,
          'renewal_grant_not_found',
          'no renewal grant was created for this run at join/spawn',
        );
      }
      if (grant.revoked_at !== null) {
        return domain(ctx, cmd.kind, 'renewal_grant_revoked', 'renewal grant is revoked');
      }
      /* THE DAY COUNT IS BUILT FROM THE CONSTANT, not typed into the sentence.
         It mirrors the interval in swarm.prepare_renewal_grant, and a sentence
         that states an enforced number has to move when the number does.
         The remedy is named too: this refusal reaches an agent that can do
         nothing about it, so the detail has to say who can. */
      if (facts.grant_preflight_code === 'renewal_idle_suspended') {
        return domain(
          ctx,
          cmd.kind,
          'renewal_idle_suspended',
          `standing grant went ${RENEWAL_IDLE_PAUSE_DAYS} days without use and is now paused; `
            + 'it is not revoked, and a workspace owner or admin, or the member who owns this agent, can resume it',
        );
      }
      if (
        facts.grant_preflight_code === 'renewal_grant_suspended'
        || grant.suspended_at !== null
      ) {
        return domain(
          ctx,
          cmd.kind,
          'renewal_grant_suspended',
          'renewal grant is paused; it is not revoked, and an owner must resume or revoke it',
        );
      }
      if (facts.grant_preflight_code === 'renewal_device_unavailable') {
        return domain(
          ctx,
          cmd.kind,
          'renewal_device_unavailable',
          'the bound grant cannot verify a device for this renewal',
        );
      }
      if (facts.grant_preflight_code === 'renewal_device_mismatch') {
        return domain(
          ctx,
          cmd.kind,
          'renewal_device_mismatch',
          'the renewal device does not match the grant binding',
        );
      }
      if (
        grant.kind === 'timeboxed'
        && facts.grant_preflight_code === 'renewal_horizon_reached'
      ) {
        return domain(
          ctx,
          cmd.kind,
          'renewal_horizon_reached',
          'the continuous-renewal horizon has passed; a human must reauthorise this run',
        );
      }
      // A timeboxed row whose horizon exceeds the maximum, or a row whose
      // nullability disagrees with its kind, is refused rather than honoured.
      const timeboxedHorizonValid = grant.kind === 'timeboxed'
        && Number.isFinite(grant.horizon_expires_at)
        && grant.horizon_expires_at !== null
        && grant.max_successors !== null
        && grant.horizon_expires_at - ctx.now <= RENEWAL_HORIZON_MAX_MS;
      const standingShapeValid = grant.kind === 'standing'
        && grant.horizon_expires_at === null
        && grant.max_successors === null;
      if (!timeboxedHorizonValid && !standingShapeValid) {
        return domain(
          ctx,
          cmd.kind,
          'renewal_horizon_invalid',
          'renewal grant kind, horizon, or successor ceiling is invalid',
        );
      }
      if (
        grant.kind === 'timeboxed'
        && grant.horizon_expires_at !== null
        && grant.horizon_expires_at <= ctx.now
      ) {
        return domain(
          ctx,
          cmd.kind,
          'renewal_horizon_reached',
          'the continuous-renewal horizon has passed; a human must reauthorise this run',
        );
      }
      /* ★ A PENDING CREDENTIAL MAY NOT RENEW. This is the bound on the overlap window
       * that first-use supersession deliberately creates.
       *
       * ★ IT IS DECIDED LAST, AFTER REVOCATION, GRANT AND HORIZON, AND THAT PLACEMENT IS
       * LOAD-BEARING. This refusal says "retry, you have not used this yet" — a transient
       * hint the client treats as a warning and retries past. Every check above it says
       * something a person has to act on: your lineage was revoked, your grant was
       * revoked, your horizon has passed. Decided first, this one MASKS all of them, and
       * an operator's revocation gets reported to the fleet as a retry hint.
       *
       * That is not hypothetical. The migration that added `first_used_at` does not
       * backfill it, so at the moment it applies EVERY token in the field is pending. Had
       * this check stayed at the top, the first renewal of every live agent — including
       * every agent an operator had just revoked — would have answered with it.
       *
       * The file argues at length a few lines below that telling an agent the wrong one
       * of two reasons makes it "retry the renewal that just lost and lose again". Same
       * rule, four more reasons.
       *
       * Between issue and first use a successor and its predecessor are both live. That
       * overlap is the price of recoverability — it is what lets a renewal whose response
       * was lost be retried instead of stranding the worker — and it is bounded by the
       * predecessor's remaining TTL (<= 1h). It must not be EXTENDABLE: if a token that
       * had never been used could itself issue a successor, an agent could chain unused
       * tokens and hold an ever-growing set of live credentials, none of which was ever
       * proven to have reached anybody.
       *
       * `predecessor_pending` is read BEFORE this request's own first-use stamp, which is
       * what makes the check mean something: authenticating to renew is itself a use, so
       * measured after the stamp no token is ever pending and the rule would be vacuous.
       *
       * Consequence worth stating plainly: an agent whose very first act with a fresh
       * successor is another renewal is refused exactly once. The refused request still
       * authenticated, so the stamp landed and the immediate retry succeeds. The cost is
       * one round trip; the alternative is an unbounded chain of unheld credentials. */
      if (facts.predecessor_pending) {
        return domain(
          ctx,
          cmd.kind,
          'predecessor_pending_first_use',
          'this credential has not been used yet; a successor is issued only from a credential already in use',
        );
      }
      /* ★ THE CEILING IS MEASURED ON EFFECTIVE SPEND, AND THIS ARITHMETIC IS MIRRORED
       * EXACTLY BY THE DATABASE. Keep the two identical or the fence and the reducer
       * will disagree about who is out of budget — which does not fail safe, it fails
       * CONFUSINGLY: the reducer authorises, `agent_tokens_successor_fence()` refuses
       * with SWARM_RENEWAL_GRANT_EXHAUSTED, the command function reads that as a lost
       * race and re-decides into `predecessor_superseded`, and the agent is told a cause
       * that is not what happened. That exact disagreement shipped once, from a version
       * of this block that subtracted one here and had no counterpart in SQL.
       *
       * Effective spend is `successors_used - successors_stranded`. A stranded successor
       * is one that was issued and never used because its response was lost; it reached
       * nobody, so it must not cost budget, or a run of dropped connections burns the
       * whole grant and forces the human reauthorisation renewal exists to avoid.
       *
       * The extra `- 1` when replacing is not a second discount. It is this request's own
       * credit, applied here because the adapter has not written it yet: replacing
       * increments BOTH counters (stranded for the discard, used for the replacement), so
       * effective spend is unchanged, whereas a fresh renewal increments only `used`. The
       * fence sees the credit already written and so tests the same number this does. */
      const replacing = facts.superseded && facts.successor_pending;
      const effectiveUsed = grant.successors_used - grant.successors_stranded;
      const successorsUsed = replacing ? effectiveUsed - 1 : effectiveUsed;
      if (
        !Number.isInteger(grant.successors_used)
        || !Number.isInteger(grant.successors_stranded)
        || (
          grant.max_successors !== null
          && (
            !Number.isInteger(grant.max_successors)
            || successorsUsed >= grant.max_successors
          )
        )
      ) {
        return domain(
          ctx,
          cmd.kind,
          'renewal_successors_exhausted',
          'renewal grant has no successors left',
        );
      }
      // Attenuation is measured against the PREDECESSOR, not against the
      // owning human's broader rights. Equal-or-narrower only.
      const inherited = new Set(predecessor.scopes);
      if (
        cmd.scopes.length === 0
        || cmd.scopes.some((scope) => !inherited.has(scope))
      ) {
        return domain(
          ctx,
          cmd.kind,
          'renewal_scope_widened',
          'successor scopes must be equal to or narrower than the predecessor',
        );
      }
      if (cmd.scopes.some(isAgentScopeDenylisted)) {
        return domain(ctx, cmd.kind, 'scope_denylisted', 'one or more scopes are human-credential-only');
      }
      if (state.tokens[cmd.successor_token_id]) {
        return domain(ctx, cmd.kind, 'bad_state', 'successor token id already exists');
      }
      // The successor never outlives the horizon: the last renewal before it
      // is short, not a free hour on the far side of the checkpoint.
      const expires_at = grant.kind === 'standing'
        ? ctx.now + AGENT_TOKEN_DEFAULT_TTL_MS
        : Math.min(
          ctx.now + AGENT_TOKEN_DEFAULT_TTL_MS,
          grant.horizon_expires_at!,
        );
      return accept([
        env(ctx, 'AgentTokenMinted', {
          token_id: cmd.successor_token_id,
          principal_id: predecessor.principal_id,
          run_id: predecessor.run_id,
          task_id: predecessor.task_id,
          epoch: predecessor.epoch,
          scopes: [...cmd.scopes],
          issued_at: ctx.now,
          expires_at,
          // Lineage marks, carried as extra payload fields. A dedicated
          // AgentTokenRenewed type would have to be added to
          // workspace-events.ts; the reducer folds the required AgentTokenMinted
          // fields and ignores the rest.
          predecessor_token_id: predecessor.token_id,
          renewal_grant_id: grant.renewal_grant_id,
        }),
      ]);
    }

    case 'revoke_agent_token': {
      if (ctx.credential_kind === 'agent') {
        if (
          ctx.presenting_token_id !== cmd.token_id
          || ctx.actor.agent_principal === null
        ) {
          return authz(
            'credential_kind_forbidden',
            'agent credential may revoke only its exact presenting token',
          );
        }
      }
      const token = state.tokens[cmd.token_id];
      if (!token) {
        return domain(ctx, cmd.kind, 'token_not_found', 'agent token does not exist');
      }
      if (token.revoked_at !== null) {
        return domain(ctx, cmd.kind, 'token_revoked', 'agent token is already revoked');
      }
      const principal = state.principals[token.principal_id];
      if (!principal) {
        return domain(ctx, cmd.kind, 'principal_not_found', 'token principal does not exist');
      }
      if (ctx.credential_kind === 'agent') {
        if (token.principal_id !== ctx.actor.agent_principal) {
          return authz(
            'credential_kind_forbidden',
            'agent credential may revoke only its exact presenting token',
          );
        }
      } else if (!ownerOrAdmin(actorRole) && principal.owner_user_id !== user_id) {
        return domain(ctx, cmd.kind, 'principal_not_owned', 'Member may revoke only a token for their own principal');
      }
      return accept([
        env(ctx, 'AgentTokenRevoked', { token_id: cmd.token_id, revoked_at: ctx.now }),
      ]);
    }
  }
}
