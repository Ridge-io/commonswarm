export const AGENT_SESSION_ID_HEADER = 'x-cswarm-session-id';
export const AGENT_SESSION_GENERATION_HEADER = 'x-cswarm-session-generation';
export const AGENT_SESSION_KEY_HEADER = 'x-cswarm-session-key';

export interface AgentSessionProof {
  session_id: string;
  generation: number;
  key: string;
}

export type AgentSessionErrorCode = 
  | 'session_proof_missing'
  | 'session_proof_invalid'
  | 'session_expired'
  | 'session_retired'
  | 'session_conflict'
  | 'session_not_managed'
  | 'session_already_managed';
