interface EntityAgent {
  principalId: string;
  name: string;
  model: string | null;
  ownerUserId: string;
}

interface EntityAccessStatus {
  tokenId: string;
  issuedAt: string;
  expiresAt: string;
  firstUsedAt: string | null;
  revokedAt: string | null;
}

export interface AgentEntityView {
  name: string;
  model: string;
  ownerUserId: string;
  ownerName: string;
  principalId: string;
  tokenId: string;
  issuedAt: string;
  expiresAt: string;
  firstUsedAt: string;
  revokedAt: string;
  revoked: boolean;
}

/** Keeps access-state fallbacks explicit so missing data cannot masquerade as live data. */
export const agentEntityView = (
  agent: EntityAgent,
  status: EntityAccessStatus | undefined,
  ownerName: string,
  formatDate: (value: string) => string,
): AgentEntityView => ({
  name: agent.name,
  model: agent.model ?? "Model not specified",
  ownerUserId: agent.ownerUserId,
  ownerName,
  principalId: agent.principalId,
  tokenId: status?.tokenId ?? "Not available",
  issuedAt: status ? formatDate(status.issuedAt) : "Not available",
  expiresAt: status ? formatDate(status.expiresAt) : "Not available",
  firstUsedAt: status
    ? status.firstUsedAt === null
      ? "Never used"
      : formatDate(status.firstUsedAt)
    : "Not available",
  revokedAt: status
    ? status.revokedAt === null
      ? "Not revoked"
      : formatDate(status.revokedAt)
    : "Not available",
  revoked: status?.revokedAt !== null && status?.revokedAt !== undefined,
});

/** Shows identifiers compactly without discarding the value exposed by the control title. */
export const truncateEntityId = (value: string): string =>
  value.length <= 17 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
