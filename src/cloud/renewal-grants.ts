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

/**
 * Days a standing grant may go unused before it pauses itself.
 *
 * MIRRORS `interval '14 days'` in swarm.prepare_renewal_grant, installed by
 * supabase/migrations/20260904000001_standing_grant_resume.sql, and the same
 * number in site/src/lib/standing-grants.ts. No module is imported by the CLI,
 * the site, and the SQL alike, so the mirror is held by a test that reads all
 * three files: tests/p1-cli/standing-grants.test.ts.
 */
export const STANDING_IDLE_PAUSE_DAYS = 14;

/**
 * Who may resume a paused grant. MIRRORS the gate in swarm.resume_renewal_grant:
 * workspace owner or admin, or the member who owns the agent principal.
 */
export const STANDING_RESUME_ACTORS: readonly string[] = [
  "a workspace owner",
  "an admin",
  "the member who added the agent",
];

function orList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/** Everything a standing grant does, one rule per enforced behaviour. */
export const STANDING_GRANT_RULES: readonly string[] = [
  "Access does not expire.",
  `${STANDING_IDLE_PAUSE_DAYS} days with no use pauses it; ${
    orList(STANDING_RESUME_ACTORS)
  } can resume it.`,
  "Revoking it is the only permanent stop.",
];

/**
 * User-facing grant state, tied to server-enforced nullability.
 *
 * THE SUSPENDED LINE NAMED THE WRONG REMEDY. It said "ask a workspace owner to
 * revoke this grant and mint a new credential" — which was the only thing that
 * worked while suspension was one-way, and which told the reader to perform the
 * PERMANENT kill in order to recover from the RECOVERABLE one. A resume now
 * exists, so the line names it and prints the command. Honesty is not
 * sufficient: a state word with no next step is a state word people skip.
 */
export function describeRenewalGrant(grant: RenewalGrantStatus): string[] {
  const lines = grant.kind === "standing"
    ? [`Grant: standing — ${STANDING_GRANT_RULES.join(" ")}`]
    : [`Grant: timeboxed — renewal horizon ${grant.horizon_expires_at}.`];
  if (grant.suspended_at !== null) {
    lines.push(
      `PAUSED since ${grant.suspended_at} after ${STANDING_IDLE_PAUSE_DAYS} days with no use. ` +
        "This is not revoked and the agent is not gone. Next step: " +
        `${orList(STANDING_RESUME_ACTORS)} runs ` +
        `cswarm grant resume --renewal-grant-id ${grant.renewal_grant_id}`,
    );
  }
  if (grant.revoked_at !== null) {
    lines.push(
      `REVOKED since ${grant.revoked_at}. This is permanent and cannot be resumed. ` +
        "Next step: mint a new grant if this agent should continue.",
    );
  }
  return lines;
}
