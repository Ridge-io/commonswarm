export const STANDING_GRANT_COPY =
  "This does not expire. Revoke is the only kill switch.";

export type GrantRiskBadge =
  | "REVOKED"
  | "SUSPENDED"
  | "NEW HOST"
  | "UNBOUND"
  | "STALE"
  | "HORIZON 3d";

export interface GrantRiskInput {
  kind: "timeboxed" | "standing";
  horizonExpiresAt: string | null;
  boundDeviceId: string | null;
  lastUsedAt: string | null;
  issuedAt: string;
  newHostAt: string | null;
  suspendedAt: string | null;
  revokedAt: string | null;
}

/** Select exactly one risk in the design's required precedence. */
export function grantRiskBadge(
  grant: GrantRiskInput,
  now = Date.now(),
): GrantRiskBadge | null {
  if (grant.revokedAt !== null) return "REVOKED";
  if (grant.suspendedAt !== null) return "SUSPENDED";
  if (grant.newHostAt !== null) return "NEW HOST";
  if (grant.kind === "standing" && grant.boundDeviceId === null) return "UNBOUND";
  const lastUsed = Date.parse(grant.lastUsedAt ?? grant.issuedAt);
  if (Number.isFinite(lastUsed) && now - lastUsed > 7 * 24 * 60 * 60 * 1_000) {
    return "STALE";
  }
  if (grant.horizonExpiresAt !== null) {
    const horizon = Date.parse(grant.horizonExpiresAt);
    if (
      Number.isFinite(horizon) &&
      horizon - now <= 3 * 24 * 60 * 60 * 1_000
    ) {
      return "HORIZON 3d";
    }
  }
  return null;
}
