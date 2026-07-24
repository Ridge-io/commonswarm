// Pure fold for the workspace-authority stream (§3.4).

import { SCHEMA_VERSION } from './events.js';
import { StreamIntegrityError, UnknownEventTypeError } from './reducer.js';
import {
  AgentPrincipalCreated,
  AgentPrincipalRevoked,
  AgentTokenMinted,
  AgentTokenRevoked,
  InvitationAccepted,
  InvitationRevoked,
  MemberInvited,
  MemberJoined,
  MemberRemoved,
  MemberRoleChanged,
  WORKSPACE_EVENT_TYPES,
  WORKSPACE_ROLES,
  WorkspaceCommandRejected,
  WorkspaceCreated,
  WorkspaceEventEnvelope,
  WorkspaceRole,
  WorkspaceState,
} from './workspace-events.js';

function req<T extends object>(
  payload: unknown,
  keys: readonly (keyof T)[],
  type: string,
  seq: number,
): T {
  if (!payload || typeof payload !== 'object') {
    throw new StreamIntegrityError(`event "${type}" at seq ${seq} has a non-object payload`);
  }
  for (const key of keys) {
    if ((payload as Record<string, unknown>)[key as string] === undefined) {
      throw new StreamIntegrityError(
        `event "${type}" at seq ${seq} is missing payload field "${String(key)}"`,
      );
    }
  }
  return payload as T;
}

function ownerDelta(from: WorkspaceRole | null, to: WorkspaceRole | null): number {
  return (to === 'owner' ? 1 : 0) - (from === 'owner' ? 1 : 0);
}

function assertRole(value: unknown, field: string, type: string, seq: number): void {
  if (!(WORKSPACE_ROLES as readonly unknown[]).includes(value)) {
    throw new StreamIntegrityError(
      `event "${type}" at seq ${seq} has invalid ${field} "${String(value)}"`,
    );
  }
}

function assertOwnerCount(state: WorkspaceState, env: WorkspaceEventEnvelope): void {
  const actual = Object.values(state.members).filter(
    (member) => member.revoked_at === null && member.role === 'owner',
  ).length;
  if (state.owners_count !== actual || actual < 1) {
    throw new StreamIntegrityError(
      `event "${env.type}" at seq ${env.seq} violates owner count invariant `
      + `(projected ${state.owners_count}, actual ${actual})`,
    );
  }
}

export function reduceWorkspace(
  prev: WorkspaceState | null,
  env: WorkspaceEventEnvelope,
): WorkspaceState {
  if (!(WORKSPACE_EVENT_TYPES as readonly string[]).includes(env.type)) {
    throw new UnknownEventTypeError(env.type, env.seq);
  }
  if (env.schema_version !== SCHEMA_VERSION) {
    throw new StreamIntegrityError(
      `event "${env.type}" at seq ${env.seq} is schema v${env.schema_version}, `
      + `expected v${SCHEMA_VERSION} (upcast before reduce)`,
    );
  }

  if (env.type === 'CommandRejected') {
    req<WorkspaceCommandRejected>(
      env.payload,
      ['workspace_id', 'command', 'reason', 'detail'],
      env.type,
      env.seq,
    );
    if (!prev) {
      throw new StreamIntegrityError(`CommandRejected before WorkspaceCreated (seq ${env.seq})`);
    }
    return prev;
  }

  if (env.type === 'WorkspaceCreated') {
    if (prev) {
      throw new StreamIntegrityError(`WorkspaceCreated for an existing workspace (seq ${env.seq})`);
    }
    const p = req<WorkspaceCreated>(
      env.payload,
      ['workspace_id', 'name', 'created_by', 'created_at'],
      env.type,
      env.seq,
    );
    return {
      workspace: {
        workspace_id: p.workspace_id,
        name: p.name,
        created_by: p.created_by,
        created_at: p.created_at,
        archived_at: null,
      },
      members: {
        [p.created_by]: {
          user_id: p.created_by,
          role: 'owner',
          invited_by: null,
          joined_at: p.created_at,
          revoked_at: null,
        },
      },
      invitations: {},
      principals: {},
      tokens: {},
      owners_count: 1,
    };
  }

  if (!prev) {
    throw new StreamIntegrityError(`event "${env.type}" before WorkspaceCreated (seq ${env.seq})`);
  }
  const s = prev;
  let next: WorkspaceState;

  switch (env.type) {
    case 'MemberInvited': {
      const p = req<MemberInvited>(
        env.payload,
        [
          'invitation_id', 'email', 'role', 'token_hash', 'expires_at',
          'created_by', 'created_at',
        ],
        env.type,
        env.seq,
      );
      if (s.invitations[p.invitation_id]) {
        throw new StreamIntegrityError(`duplicate invitation "${p.invitation_id}" at seq ${env.seq}`);
      }
      if (
        Object.values(s.invitations).some(
          (invitation) => invitation.token_hash === p.token_hash,
        )
      ) {
        throw new StreamIntegrityError(`duplicate invitation token_hash at seq ${env.seq}`);
      }
      assertRole(p.role, 'role', env.type, env.seq);
      next = {
        ...s,
        invitations: {
          ...s.invitations,
          [p.invitation_id]: {
            ...p,
            consumed_at: null,
            consumed_by: null,
            revoked_at: null,
          },
        },
      };
      break;
    }
    case 'InvitationRevoked': {
      const p = req<InvitationRevoked>(env.payload, ['invitation_id', 'revoked_at'], env.type, env.seq);
      const invitation = s.invitations[p.invitation_id];
      if (!invitation) {
        throw new StreamIntegrityError(`unknown invitation "${p.invitation_id}" at seq ${env.seq}`);
      }
      next = {
        ...s,
        invitations: {
          ...s.invitations,
          [p.invitation_id]: { ...invitation, revoked_at: p.revoked_at },
        },
      };
      break;
    }
    case 'InvitationAccepted': {
      const p = req<InvitationAccepted>(
        env.payload,
        ['invitation_id', 'consumed_by', 'consumed_at'],
        env.type,
        env.seq,
      );
      const invitation = s.invitations[p.invitation_id];
      if (!invitation) {
        throw new StreamIntegrityError(`unknown invitation "${p.invitation_id}" at seq ${env.seq}`);
      }
      next = {
        ...s,
        invitations: {
          ...s.invitations,
          [p.invitation_id]: {
            ...invitation,
            consumed_at: p.consumed_at,
            consumed_by: p.consumed_by,
          },
        },
      };
      break;
    }
    case 'MemberJoined': {
      const p = req<MemberJoined>(
        env.payload,
        ['user_id', 'role', 'invited_by', 'joined_at'],
        env.type,
        env.seq,
      );
      const existing = s.members[p.user_id];
      assertRole(p.role, 'role', env.type, env.seq);
      if (existing?.revoked_at === null) {
        throw new StreamIntegrityError(`live member "${p.user_id}" joined twice at seq ${env.seq}`);
      }
      next = {
        ...s,
        members: {
          ...s.members,
          [p.user_id]: { ...p, revoked_at: null },
        },
        owners_count: s.owners_count + ownerDelta(null, p.role),
      };
      break;
    }
    case 'MemberRemoved': {
      const p = req<MemberRemoved>(env.payload, ['user_id', 'revoked_at'], env.type, env.seq);
      const member = s.members[p.user_id];
      if (!member || member.revoked_at !== null) {
        throw new StreamIntegrityError(`cannot remove non-live member "${p.user_id}" at seq ${env.seq}`);
      }
      next = {
        ...s,
        members: {
          ...s.members,
          [p.user_id]: { ...member, revoked_at: p.revoked_at },
        },
        owners_count: s.owners_count + ownerDelta(member.role, null),
      };
      break;
    }
    case 'MemberRoleChanged': {
      const p = req<MemberRoleChanged>(
        env.payload,
        ['user_id', 'from_role', 'to_role'],
        env.type,
        env.seq,
      );
      const member = s.members[p.user_id];
      assertRole(p.from_role, 'from_role', env.type, env.seq);
      assertRole(p.to_role, 'to_role', env.type, env.seq);
      if (!member || member.revoked_at !== null || member.role !== p.from_role) {
        throw new StreamIntegrityError(`role change has stale member state at seq ${env.seq}`);
      }
      next = {
        ...s,
        members: {
          ...s.members,
          [p.user_id]: { ...member, role: p.to_role },
        },
        owners_count: s.owners_count + ownerDelta(p.from_role, p.to_role),
      };
      break;
    }
    case 'AgentPrincipalCreated': {
      const p = req<AgentPrincipalCreated>(
        env.payload,
        ['principal_id', 'owner_user_id', 'name', 'created_at'],
        env.type,
        env.seq,
      );
      if (s.principals[p.principal_id]) {
        throw new StreamIntegrityError(`duplicate principal "${p.principal_id}" at seq ${env.seq}`);
      }
      next = {
        ...s,
        principals: {
          ...s.principals,
          [p.principal_id]: { ...p, revoked_at: null },
        },
      };
      break;
    }
    case 'AgentPrincipalRevoked': {
      const p = req<AgentPrincipalRevoked>(
        env.payload,
        ['principal_id', 'revoked_at'],
        env.type,
        env.seq,
      );
      const principal = s.principals[p.principal_id];
      if (!principal) {
        throw new StreamIntegrityError(`unknown principal "${p.principal_id}" at seq ${env.seq}`);
      }
      next = {
        ...s,
        principals: {
          ...s.principals,
          [p.principal_id]: { ...principal, revoked_at: p.revoked_at },
        },
      };
      break;
    }
    case 'AgentTokenMinted': {
      const p = req<AgentTokenMinted>(
        env.payload,
        [
          'token_id', 'principal_id', 'run_id', 'task_id', 'epoch',
          'scopes', 'issued_at', 'expires_at',
        ],
        env.type,
        env.seq,
      );
      if (s.tokens[p.token_id]) {
        throw new StreamIntegrityError(`duplicate token "${p.token_id}" at seq ${env.seq}`);
      }
      next = {
        ...s,
        tokens: {
          ...s.tokens,
          [p.token_id]: { ...p, scopes: [...p.scopes], revoked_at: null },
        },
      };
      break;
    }
    case 'AgentTokenRevoked': {
      const p = req<AgentTokenRevoked>(env.payload, ['token_id', 'revoked_at'], env.type, env.seq);
      const token = s.tokens[p.token_id];
      if (!token) {
        throw new StreamIntegrityError(`unknown token "${p.token_id}" at seq ${env.seq}`);
      }
      next = {
        ...s,
        tokens: {
          ...s.tokens,
          [p.token_id]: { ...token, revoked_at: p.revoked_at },
        },
      };
      break;
    }
    default:
      throw new UnknownEventTypeError(env.type, env.seq);
  }

  assertOwnerCount(next, env);
  return next;
}

export function reduceWorkspaceStream(
  events: readonly WorkspaceEventEnvelope[],
): WorkspaceState | null {
  let state: WorkspaceState | null = null;
  let lastSeq = -Infinity;
  for (const event of events) {
    if (event.seq <= lastSeq) {
      throw new StreamIntegrityError(
        `events out of order or duplicated: seq ${event.seq} after ${lastSeq}`,
      );
    }
    lastSeq = event.seq;
    state = reduceWorkspace(state, event);
  }
  return state;
}
