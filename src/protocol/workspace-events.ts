// Pure workspace-authority event model (§3.4).
//
// These events share the canonical EventEnvelope with task events. Payloads
// are reducer-complete, but never contain raw invitation or agent-token
// material: invitations carry only the server-computed token hash and token
// events carry only token identifiers.

import { EventEnvelope } from './events.js';

export type WorkspaceRole = 'owner' | 'admin' | 'member';
export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member'] as const;

export type WorkspaceEventType =
  | 'WorkspaceCreated'
  | 'MemberInvited'
  | 'InvitationRevoked'
  | 'InvitationAccepted'
  | 'MemberJoined'
  | 'MemberRemoved'
  | 'MemberRoleChanged'
  | 'AgentPrincipalCreated'
  | 'AgentPrincipalRevoked'
  | 'AgentTokenMinted'
  | 'AgentTokenRevoked'
  | 'CommandRejected';

export const WORKSPACE_EVENT_TYPES: readonly WorkspaceEventType[] = [
  'WorkspaceCreated',
  'MemberInvited',
  'InvitationRevoked',
  'InvitationAccepted',
  'MemberJoined',
  'MemberRemoved',
  'MemberRoleChanged',
  'AgentPrincipalCreated',
  'AgentPrincipalRevoked',
  'AgentTokenMinted',
  'AgentTokenRevoked',
  'CommandRejected',
] as const;

export type WorkspaceEventEnvelope<P = unknown> = EventEnvelope<P, WorkspaceEventType>;

export interface WorkspaceRecord {
  workspace_id: string;
  name: string;
  created_by: string;
  created_at: number;
  archived_at: number | null;
}

export interface WorkspaceMember {
  user_id: string;
  role: WorkspaceRole;
  invited_by: string | null;
  joined_at: number;
  revoked_at: number | null;
}

export interface WorkspaceInvitation {
  invitation_id: string;
  email: string | null;
  role: WorkspaceRole;
  /** Server-computed digest. Raw invitation capability material is never an event. */
  token_hash: string;
  expires_at: number;
  created_by: string;
  created_at: number;
  consumed_at: number | null;
  consumed_by: string | null;
  revoked_at: number | null;
}

export interface WorkspacePrincipal {
  principal_id: string;
  owner_user_id: string;
  name: string;
  created_at: number;
  revoked_at: number | null;
}

export interface WorkspaceAgentToken {
  token_id: string;
  principal_id: string;
  run_id: string;
  /** Legacy fixture rows may be unbound; governed mint events are always bound. */
  task_id: string | null;
  epoch: number | null;
  scopes: string[];
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface WorkspaceState {
  workspace: WorkspaceRecord;
  members: Record<string, WorkspaceMember>;
  invitations: Record<string, WorkspaceInvitation>;
  principals: Record<string, WorkspacePrincipal>;
  tokens: Record<string, WorkspaceAgentToken>;
  /** Denormalized invariant backstop; must equal the live Owner count. */
  owners_count: number;
}

// ---- Reducer-complete payloads ---------------------------------------------

export interface WorkspaceCreated {
  workspace_id: string;
  name: string;
  created_by: string;
  created_at: number;
}

export interface MemberInvited {
  invitation_id: string;
  email: string | null;
  role: WorkspaceRole;
  token_hash: string;
  expires_at: number;
  created_by: string;
  created_at: number;
}

export interface InvitationRevoked {
  invitation_id: string;
  revoked_at: number;
}

export interface InvitationAccepted {
  invitation_id: string;
  consumed_by: string;
  consumed_at: number;
}

export interface MemberJoined {
  user_id: string;
  role: WorkspaceRole;
  invited_by: string | null;
  joined_at: number;
}

export interface MemberRemoved {
  user_id: string;
  revoked_at: number;
}

export interface MemberRoleChanged {
  user_id: string;
  from_role: WorkspaceRole;
  to_role: WorkspaceRole;
}

export interface AgentPrincipalCreated {
  principal_id: string;
  owner_user_id: string;
  name: string;
  created_at: number;
}

export interface AgentPrincipalRevoked {
  principal_id: string;
  revoked_at: number;
}

export interface AgentTokenMinted {
  token_id: string;
  principal_id: string;
  run_id: string;
  task_id: string;
  epoch: number;
  scopes: string[];
  issued_at: number;
  expires_at: number;
}

export interface AgentTokenRevoked {
  token_id: string;
  revoked_at: number;
}

export type WorkspaceRejectionReason =
  | 'workspace_exists'
  | 'operator_not_allowed'
  | 'workspace_not_found'
  | 'credential_kind_forbidden'
  | 'role_forbidden'
  | 'member_exists'
  | 'member_not_found'
  | 'invitation_ttl_invalid'
  | 'invitation_not_found'
  | 'invitation_not_live'
  | 'invitation_token_mismatch'
  | 'identity_not_verified'
  | 'last_owner'
  | 'landing_authority_unresolved'
  | 'principal_name_taken'
  | 'principal_not_found'
  | 'principal_not_owned'
  | 'principal_revoked'
  | 'token_not_found'
  | 'token_revoked'
  | 'scope_not_allowed'
  | 'scope_denylisted'
  | 'binding_required'
  | 'token_ttl_invalid'
  | 'bad_state';

export interface WorkspaceCommandRejected {
  workspace_id: string;
  command: string;
  reason: WorkspaceRejectionReason;
  detail: string;
}
