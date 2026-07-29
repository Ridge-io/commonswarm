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
export const AGENT_TOKEN_MAX_TTL_MS = 8 * 60 * 60 * 1_000;

// §2.3 continuous-renewal horizon. A worksession that runs for weeks must not
// be paid for by lengthening the bearer token: the TTL constants above stay
// where they are, and the successor endpoint below carries the run instead.
// The horizon is the periodic human reauthorisation that stops silent renewal
// becoming an unbounded ambient-authority deputy.
export const RENEWAL_HORIZON_DEFAULT_MS = 30 * 24 * 60 * 60 * 1_000;
export const RENEWAL_HORIZON_MAX_MS = 90 * 24 * 60 * 60 * 1_000;
/** ~1 successor/hour across the default horizon, with restart headroom. */
export const RENEWAL_MAX_SUCCESSORS_DEFAULT = 800;

export type WorkspaceCommand =
  | { kind: 'create_workspace'; workspace_id: string; name: string }
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
  | { kind: 'create_agent_principal'; principal_id: string; name: string }
  | { kind: 'revoke_agent_principal'; principal_id: string }
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
  max_successors: number;
  successors_used: number;
  /** Hard continuous-renewal horizon; past it a human must reauthorise. */
  horizon_expires_at: number;
  revoked_at: number | null;
}

/** Transaction-time renewal facts, all read from server state (§2.3). */
export interface RenewalFacts {
  /** Live grant for the predecessor's (principal, run); null when absent. */
  grant: RenewalGrantFacts | null;
  /** The predecessor row names a grant other than the run's live grant. */
  grant_mismatch: boolean;
  /** A successor for this exact predecessor already exists. */
  superseded: boolean;
  /** Any token in the lineage is revoked, or the lineage carries a tombstone. */
  lineage_revoked: boolean;
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
  | 'renewal_binding_incomplete'
  | 'renewal_lineage_revoked'
  | 'renewal_grant_not_found'
  | 'renewal_grant_mismatch'
  | 'renewal_grant_revoked'
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
  'invite_member',
  'revoke_invitation',
  'accept_invitation',
  'remove_member',
  'change_role',
  'create_agent_principal',
  'revoke_agent_principal',
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
        return domain(ctx, cmd.kind, 'token_ttl_invalid', 'token TTL must be positive and at most 8 hours');
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
      /* ★ SUPERSESSION IS CHECKED BEFORE EXPIRY, AND THE ORDER IS THE WHOLE POINT.
       *
       * Superseding a predecessor is implemented as setting expires_at = now, so a
       * superseded token IS an expired token and the expiry branch would always answer
       * first. That made 'predecessor_superseded' unreachable — a named reason that could
       * never fire, which reads as a distinction the system draws and does not.
       *
       * It matters beyond tidiness because these two say opposite things to whoever is
       * holding the credential. 'expired' means time passed and you should have renewed
       * sooner. 'superseded' means A SUCCESSOR ALREADY EXISTS — you renewed twice, or you
       * lost a concurrency race, and there is a live credential you should be using instead.
       * Told the wrong one, an agent retries the renewal that just lost and loses again.
       *
       * Measured: the concurrent-double-renewal test had exactly one winner (correct) while
       * the loser was told 'predecessor_expired' (misleading), which is how this surfaced. */
      const facts = ctx.renewalFacts(predecessor.token_id);
      if (facts.superseded) {
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
      // A grant row whose horizon exceeds the maximum is refused rather than
      // honoured: the cap has to hold even against a corrupted or hostile row.
      if (
        !Number.isFinite(grant.horizon_expires_at)
        || grant.horizon_expires_at - ctx.now > RENEWAL_HORIZON_MAX_MS
      ) {
        return domain(
          ctx,
          cmd.kind,
          'renewal_horizon_invalid',
          'renewal horizon exceeds the 90-day maximum',
        );
      }
      if (grant.horizon_expires_at <= ctx.now) {
        return domain(
          ctx,
          cmd.kind,
          'renewal_horizon_reached',
          'the continuous-renewal horizon has passed; a human must reauthorise this run',
        );
      }
      if (
        !Number.isInteger(grant.max_successors)
        || !Number.isInteger(grant.successors_used)
        || grant.successors_used >= grant.max_successors
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
      const expires_at = Math.min(
        ctx.now + AGENT_TOKEN_DEFAULT_TTL_MS,
        grant.horizon_expires_at,
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
