import type { AgentSessionProof } from "./session-contract.js";
import { sessionProofOf, type SessionContextDocument } from "./session-context.js";

export type ManagedAckRefusalCode =
  | "ack_proof_missing"
  | "ack_proof_stale"
  | "ack_injection_unproven"
  | "ack_host_session_mismatch"
  | "ack_host_session_untrusted";

export type ManagedAckDecision =
  | { ok: true }
  | { ok: false; code: ManagedAckRefusalCode };

export class ManagedAckRefusedError extends Error {
  readonly name = "ManagedAckRefusedError";

  constructor(readonly code: ManagedAckRefusalCode) {
    super(managedAckMessage(code));
  }
}

const MANAGED_ACK_MESSAGES = {
  ack_proof_missing: "cannot mark an ask received without a current session proof",
  ack_proof_stale: "cannot mark an ask received with a stale session proof",
  ack_injection_unproven:
    "cannot mark an ask received until it is injected into the bound host conversation",
  ack_host_session_mismatch:
    "cannot mark an ask received: the host conversation is not the bound session",
  ack_host_session_untrusted:
    "cannot mark an ask received: the host did not prove the current conversation",
} as const satisfies Record<ManagedAckRefusalCode, string>;

export function managedAckMessage(code: ManagedAckRefusalCode): string {
  return MANAGED_ACK_MESSAGES[code];
}

/**
 * ACK requires current proof AND successful host injection into the bound
 * conversation. A stale hook, old generation, or unmatched file cannot pass.
 */
export type ManagedAckInput = {
  context: SessionContextDocument;
  proof: AgentSessionProof | null;
  injectionSucceeded: boolean;
  observedHostSessionId: string | null;
  hostIdentityTrusted: boolean;
};

export function canAckManagedDelivery(input: ManagedAckInput): ManagedAckDecision {
  if (input.proof === null) return { ok: false, code: "ack_proof_missing" };
  if (
    input.proof.session_id !== input.context.session_id ||
    input.proof.generation !== input.context.generation ||
    input.proof.key !== input.context.session_key ||
    input.context.generation < 1
  ) {
    return { ok: false, code: "ack_proof_stale" };
  }
  if (!input.injectionSucceeded) {
    return { ok: false, code: "ack_injection_unproven" };
  }
  if (!input.hostIdentityTrusted || input.observedHostSessionId === null) {
    return { ok: false, code: "ack_host_session_untrusted" };
  }
  if (input.observedHostSessionId !== input.context.host_session_id) {
    return { ok: false, code: "ack_host_session_mismatch" };
  }
  return { ok: true };
}

export function assertManagedAckAllowed(
  input: Parameters<typeof canAckManagedDelivery>[0],
): void {
  const decision = canAckManagedDelivery(input);
  if (!decision.ok) throw new ManagedAckRefusedError(decision.code);
}

/** Build the ACK gate input from a live context plus the real injection result. */
export function managedAckInput(input: {
  context: SessionContextDocument;
  proof?: AgentSessionProof | null;
  injectionSucceeded: boolean;
  observedHostSessionId: string | null;
  hostIdentityTrusted: boolean;
}): ManagedAckInput {
  return {
    context: input.context,
    proof: input.proof !== undefined ? input.proof : sessionProofOf(input.context),
    injectionSucceeded: input.injectionSucceeded,
    observedHostSessionId: input.observedHostSessionId,
    hostIdentityTrusted: input.hostIdentityTrusted,
  };
}
