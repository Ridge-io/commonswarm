import { readEndpoint, type CloudTarget } from "./config.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RenewalGrantStatus {
  renewal_grant_id: string;
  principal_id: string;
  kind: "timeboxed" | "standing";
  horizon_expires_at: string | null;
  bound_device_id: string | null;
  last_used_at: string | null;
  last_used_device_id: string | null;
  last_used_from: string | null;
  new_host_at: string | null;
  suspended_at: string | null;
  revoked_at: string | null;
  token_id: string | null;
  issued_at: string | null;
  token_expires_at: string | null;
  token_revoked_at: string | null;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`renewal grant read returned malformed ${field}`);
  }
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  const text = nullableString(value, field);
  if (text !== null && !Number.isFinite(Date.parse(text))) {
    throw new Error(`renewal grant read returned malformed ${field}`);
  }
  return text;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`renewal grant read returned malformed ${field}`);
  }
  return value.toLowerCase();
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : uuid(value, field);
}

function parseGrant(value: unknown): RenewalGrantStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("renewal grant read returned a malformed row");
  }
  const row = value as Record<string, unknown>;
  if (row.kind !== "timeboxed" && row.kind !== "standing") {
    throw new Error("renewal grant read returned malformed kind");
  }
  const horizon = nullableTimestamp(
    row.horizon_expires_at,
    "horizon_expires_at",
  );
  if (
    (row.kind === "standing" && horizon !== null) ||
    (row.kind === "timeboxed" && horizon === null)
  ) {
    throw new Error("renewal grant read returned an invalid kind/horizon pair");
  }
  return {
    renewal_grant_id: uuid(row.renewal_grant_id, "renewal_grant_id"),
    principal_id: uuid(row.principal_id, "principal_id"),
    kind: row.kind,
    horizon_expires_at: horizon,
    bound_device_id: nullableUuid(row.bound_device_id, "bound_device_id"),
    last_used_at: nullableTimestamp(row.last_used_at, "last_used_at"),
    last_used_device_id: nullableUuid(
      row.last_used_device_id,
      "last_used_device_id",
    ),
    last_used_from: nullableString(row.last_used_from, "last_used_from"),
    new_host_at: nullableTimestamp(row.new_host_at, "new_host_at"),
    suspended_at: nullableTimestamp(row.suspended_at, "suspended_at"),
    revoked_at: nullableTimestamp(row.revoked_at, "revoked_at"),
    token_id: nullableUuid(row.token_id, "token_id"),
    issued_at: nullableTimestamp(row.issued_at, "issued_at"),
    token_expires_at: nullableTimestamp(
      row.token_expires_at,
      "token_expires_at",
    ),
    token_revoked_at: nullableTimestamp(
      row.token_revoked_at,
      "token_revoked_at",
    ),
  };
}

/** Read member-scoped renewal grants through the read edge. */
export async function readRenewalGrants(
  target: CloudTarget,
  credential: string,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<RenewalGrantStatus[]> {
  const response = await fetcher(readEndpoint(target), {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      apikey: target.anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      resource: "renewal_grants",
      workspace_id: workspaceId,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`renewal grant read failed (HTTP ${response.status})`);
  }
  const body = await response.json().catch(() => null) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("renewal grant read returned malformed JSON");
  }
  const grants = (body as Record<string, unknown>).grants;
  if (!Array.isArray(grants)) {
    throw new Error("renewal grant read returned no grants array");
  }
  return grants.map(parseGrant);
}

/** User-facing grant state, tied to server-enforced nullability. */
export function describeRenewalGrant(grant: RenewalGrantStatus): string[] {
  const lines = grant.kind === "standing"
    ? ["Grant: standing — does not expire; revoke is the only kill switch."]
    : [`Grant: timeboxed — renewal horizon ${grant.horizon_expires_at}.`];
  if (grant.suspended_at !== null) {
    lines.push(
      `SUSPENDED since ${grant.suspended_at}. Next step: ask a workspace owner to revoke this grant and mint a new credential.`,
    );
  }
  if (grant.revoked_at !== null) {
    lines.push(`REVOKED since ${grant.revoked_at}. Next step: mint a new grant if this agent should continue.`);
  }
  return lines;
}
