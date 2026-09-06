import type postgres from "npm:postgres@3.4.9";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export interface AgentAuthRow {
  token_id: string;
  principal_id: string;
  run_id: string;
  device_id: string;
  owner_user_id: string;
  principal_workspace_id: string;
  lineage_id: string;
  scopes: unknown;
  surrender_only: boolean;
  token_revoked_at: Date | null;
  principal_revoked_at: Date | null;
  run_ended_at: Date | null;
  device_revoked_at: Date | null;
  unexpired: boolean;
  managed_at: Date | null;
}

/**
 * Resolves the presented agent credential AND records that it has been used, in
 * every edge function that authenticates one — §2.3 first-use supersession.
 *
 * ★ THE STAMP LIVES HERE, NOT IN THE COMMAND FUNCTION, AND THAT PLACEMENT IS THE
 * WHOLE CORRECTNESS ARGUMENT. `first_used_at IS NULL` ("PENDING") is what makes a
 * successor DISPOSABLE: a renewal that finds a pending successor revokes it and
 * issues a fresh one, on the reasoning that a token nobody has ever used is a
 * token nobody received. That reasoning is only sound if EVERY authentication
 * path stamps. An earlier version stamped only in the command function, so an
 * agent doing what agents actually do between commands — polling `read` for
 * signals — authenticated successfully over and over while its credential stayed
 * PENDING for ever. Any later renewal from the still-live predecessor would then
 * revoke a credential that was in active use, permanently and with a tombstone,
 * and the agent's next command would 401 with no reason naming the discard.
 * "Pending" has to mean "unused", and `read` is a use.
 *
 * TWO STATEMENTS, NOT ONE, AND NOT AN ACCIDENT. The stamping UPDATE takes a row
 * lock, so a concurrent discard of the same token makes this block. Under READ
 * COMMITTED a statement's snapshot is taken before it waits: the UPDATE
 * re-evaluates the row after the lock clears (so it correctly declines to stamp a
 * token revoked while we waited), but any SELECT in the SAME statement would
 * still report that row as it looked BEFORE the wait — i.e. not revoked. Folded
 * into one statement, this function would hand back a credential whose revocation
 * had already committed. The liveness read is therefore its own statement, taken
 * on a fresh snapshot after the lock is released. It costs one round trip on the
 * agent auth path and it is the difference between reading state and reading the
 * past.
 */
export async function loadAgentCredential(
  tx: Sql,
  tokenHash: Uint8Array,
): Promise<(AgentAuthRow & { first_use: boolean }) | null> {
  const stamped = await tx<{ token_id: string; first_use: boolean }[]>`
    WITH presented AS (
      -- The joins are repeated here rather than left to the liveness read so
      -- that a hash resolving to a token whose principal, run or device row is
      -- missing is never stamped: that credential does not authenticate, and a
      -- use that did not happen must not end anything.
      SELECT t.token_id, t.predecessor_token_id, t.first_used_at
      FROM swarm.agent_tokens AS t
      JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
      JOIN swarm.agent_runs AS r
        ON r.run_id = t.run_id AND r.principal_id = t.principal_id
      JOIN swarm.devices AS d ON d.device_id = r.device_id
      WHERE t.token_hash = ${tokenHash}
      LIMIT 1
    ),
    stamp AS (
      UPDATE swarm.agent_tokens AS s
      SET first_used_at = statement_timestamp()
      FROM presented AS p
      WHERE s.token_id = p.token_id
        AND s.first_used_at IS NULL
        AND s.revoked_at IS NULL
        AND s.expires_at > statement_timestamp()
      RETURNING s.token_id
    ),
    handover AS (
      -- The successor is now known to have reached its holder, so the
      -- predecessor's job is over. Ending it HERE rather than at issue is the
      -- fix: superseding at issue kills the predecessor for a successor that may
      -- never arrive, which strands the worker when the response is lost.
      --
      -- It reads stamp, not presented, so the predecessor is ended only when
      -- this call really was the first use. Two concurrent first uses cannot
      -- both stamp: the second UPDATE re-checks first_used_at IS NULL against
      -- the row the first one wrote and matches nothing.
      UPDATE swarm.agent_tokens AS pred
      SET expires_at = statement_timestamp()
      FROM presented AS p
      JOIN stamp AS s ON s.token_id = p.token_id
      WHERE pred.token_id = p.predecessor_token_id
        AND pred.revoked_at IS NULL
        AND pred.expires_at > statement_timestamp()
      RETURNING pred.token_id
    )
    SELECT
      pre.token_id,
      pre.first_used_at IS NULL AS first_use
    FROM presented AS pre
  `;
  const presented = stamped[0];
  if (!presented) return null;

  const rows = await tx<AgentAuthRow[]>`
    SELECT
      t.token_id, t.principal_id, t.run_id, r.device_id,
      p.owner_user_id, p.workspace_id AS principal_workspace_id,
      t.lineage_id, t.scopes, t.surrender_only,
      t.revoked_at AS token_revoked_at,
      p.revoked_at AS principal_revoked_at,
      r.ended_at AS run_ended_at,
      d.revoked_at AS device_revoked_at,
      t.expires_at > statement_timestamp() AS unexpired,
      p.managed_at AS managed_at
    FROM swarm.agent_tokens AS t
    JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
    JOIN swarm.agent_runs AS r
      ON r.run_id = t.run_id AND r.principal_id = t.principal_id
    JOIN swarm.devices AS d ON d.device_id = r.device_id
    WHERE t.token_id = ${presented.token_id}::uuid
  `;
  const agent = rows[0];
  if (!agent?.unexpired) return null;
  return { ...agent, first_use: presented.first_use === true };
}

export async function agentCredentialRevoked(
  tx: Sql,
  agent: AgentAuthRow,
  membershipRevokedAt: Date | null,
): Promise<boolean> {
  if (
    membershipRevokedAt !== null ||
    agent.token_revoked_at !== null ||
    agent.principal_revoked_at !== null ||
    agent.run_ended_at !== null ||
    agent.device_revoked_at !== null ||
    agent.surrender_only
  ) {
    return true;
  }

  const targets: Array<[string, string]> = [
    ["token", agent.token_id],
    ["principal", agent.principal_id],
    ["run", agent.run_id],
    ["device", agent.device_id],
    ["membership", agent.owner_user_id],
    ["lineage", agent.lineage_id],
    ["family", agent.lineage_id],
  ];
  const ids = [...new Set(targets.map(([, id]) => id))];
  const rows = await tx<{ kind: string; target_id: string }[]>`
    SELECT kind, target_id
    FROM swarm.revocation_tombstones
    WHERE target_id = ANY(${ids}::uuid[])
  `;
  const expected = new Set(targets.map(([kind, id]) => `${kind}:${id}`));
  return rows.some((row) => expected.has(`${row.kind}:${row.target_id}`));
}

import {
  agentSessionErrorStatus,
  type AgentSessionErrorCode,
  type AgentSessionProof,
  type AgentSessionProofParse,
} from "../../../src/cloud/session-wire.ts";

export type { AgentSessionProof };

export async function hashSessionKey(key: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i]! ^ right[i]!;
  }
  return diff === 0;
}

function asBytes(value: Uint8Array | ArrayBuffer | string): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

export type AgentSessionFenceResult =
  | { ok: true }
  | { ok: false; error: AgentSessionErrorCode; status: number };

function refuse(error: AgentSessionErrorCode): AgentSessionFenceResult {
  return { ok: false, error, status: agentSessionErrorStatus(error) };
}

/**
 * Session-proof fence for an agent-authenticated mutation.
 *
 * Callers skip this for kinds in AGENT_SESSION_PROOF_EXEMPT_KINDS.
 * When managedAt is null the session tables are not consulted (unmanaged
 * principals must not pay that query). When managedAt is undefined the
 * session row is still the source of "is managed" (legacy path).
 */
export async function enforceAgentSessionProof(
  tx: Sql,
  args: {
    principalId: string;
    workspaceId: string;
    proofParse: AgentSessionProofParse;
    managedAt?: Date | string | null;
  },
): Promise<AgentSessionFenceResult> {
  if (args.managedAt === null) {
    return { ok: true };
  }

  const rows = await tx<{
    session_id: string;
    generation: string | number | bigint;
    key_hash: Uint8Array | ArrayBuffer | string | null;
    live: boolean;
    lifecycle_state: string;
  }[]>`
    SELECT
      session_id,
      generation,
      key_hash,
      (expired_at IS NOT NULL AND expired_at > statement_timestamp()) AS live,
      lifecycle_state
    FROM swarm.agent_execution_sessions
    WHERE principal_id = ${args.principalId}::uuid
      AND workspace_id = ${args.workspaceId}::uuid
  `;
  const session = rows[0];
  const managed = args.managedAt !== undefined
    ? args.managedAt !== null
    : session !== undefined && session.lifecycle_state === "enabled";
  if (!managed) {
    return { ok: true };
  }
  if (!args.proofParse.ok) {
    return refuse(args.proofParse.error);
  }
  if (session === undefined) {
    return refuse("session_proof_invalid");
  }
  if (!session.live) {
    return refuse("session_expired");
  }
  const proof = args.proofParse.proof;
  if (proof.session_id !== session.session_id) {
    return refuse("session_conflict");
  }
  if (Number(session.generation) !== proof.generation) {
    return refuse("session_conflict");
  }
  const stored = asBytes(session.key_hash ?? new Uint8Array());
  if (stored === null || stored.length === 0) {
    return refuse("session_proof_invalid");
  }
  const presented = await hashSessionKey(proof.key);
  if (!bytesEqual(stored, presented)) {
    return refuse("session_proof_invalid");
  }
  return { ok: true };
}

/** @deprecated use enforceAgentSessionProof; kept for the item-4 seam. */
export async function authenticateAgentSession(
  tx: Sql,
  principalId: string,
  workspaceId: string,
  proof: AgentSessionProof | null,
  _isAcquire: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const proofParse: AgentSessionProofParse = proof === null
    ? { ok: false, error: "session_proof_missing" }
    : { ok: true, proof };
  const result = await enforceAgentSessionProof(tx, {
    principalId,
    workspaceId,
    proofParse,
  });
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error };
}
