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
}

export async function loadAgentCredential(
  tx: Sql,
  tokenHash: Uint8Array,
): Promise<AgentAuthRow | null> {
  const rows = await tx<AgentAuthRow[]>`
    SELECT
      t.token_id, t.principal_id, t.run_id, r.device_id,
      p.owner_user_id, p.workspace_id AS principal_workspace_id,
      t.lineage_id, t.scopes, t.surrender_only,
      t.revoked_at AS token_revoked_at,
      p.revoked_at AS principal_revoked_at,
      r.ended_at AS run_ended_at,
      d.revoked_at AS device_revoked_at,
      t.expires_at > statement_timestamp() AS unexpired
    FROM swarm.agent_tokens AS t
    JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
    JOIN swarm.agent_runs AS r
      ON r.run_id = t.run_id AND r.principal_id = t.principal_id
    JOIN swarm.devices AS d ON d.device_id = r.device_id
    WHERE t.token_hash = ${tokenHash}
    LIMIT 1
  `;
  const agent = rows[0];
  return agent?.unexpired ? agent : null;
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
