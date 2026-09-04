/*
 * What a standing grant is, in the words a person reads.
 *
 * EVERY SENTENCE HERE IS BUILT FROM THE CONSTANT THE SERVER ENFORCES, and that
 * is not decoration. AGENTS.md records four shipped defects in one release
 * cycle where a correct-looking sentence carried a hand-typed list that had
 * drifted from the rule behind it. This file is the list; the sentence is
 * assembled from it. Add a rule the server enforces and the copy changes with
 * it, or the cross-check in tests/p1-cli/standing-grants.test.ts fails.
 *
 * THE PREVIOUS COPY WAS FALSE, AND A GREEN TEST DEFENDED IT. It read "This does
 * not expire. Revoke is the only kill switch." while
 * supabase/migrations/20260901000001_standing_grants.sql already suspended a
 * standing grant after 14 idle days with no way back — so revoke was not the
 * only thing that stopped it, and "does not expire" was not what happened. The
 * assertion in site/src/components/app/standing-grants.observer.test.ts pinned
 * that string exactly, which made it stable rather than true. The suspension is
 * now recoverable (supabase/migrations/20260904000001_standing_grant_resume.sql)
 * AND it is now stated.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED HERE. A standing grant carries
 * bound_device_id, and the mint sets it to the device that minted. For the web
 * flow that is the browser, and swarm.agent_runs pins the same device on the
 * run the agent inherits, so the binding is satisfied by construction and does
 * NOT restrict which machine renews. Copy saying "renews only on the device
 * that created it" would be a claim the enforcement does not make.
 */

/**
 * Days a standing grant may go unused before it pauses itself.
 *
 * MIRRORS `interval '14 days'` in swarm.prepare_renewal_grant, installed by
 * supabase/migrations/20260904000001_standing_grant_resume.sql. There is no
 * shared module between site/ and supabase/, so the mirror is held by a test
 * that reads both files rather than by an import.
 */
export const STANDING_IDLE_PAUSE_DAYS = 14;

/**
 * Who may bring a paused grant back, in the order the gate checks them.
 *
 * MIRRORS the gate in swarm.resume_renewal_grant: workspace role owner or
 * admin, or the member who owns the agent principal. It is the same gate as
 * revoke_agent_principal — whoever may stop this agent may also restart it, and
 * nobody else may do either.
 */
export const STANDING_RESUME_ACTORS: readonly string[] = [
  "a workspace owner",
  "an admin",
  "the member who added the agent",
];

/** "a, b, or c" — one place, so no sentence hand-punctuates the actor list. */
function orList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/**
 * Everything a standing grant does, one rule per enforced behaviour. Ordered
 * best news first, because the reader's question is "will my agent keep
 * working", and the honest answer is yes with two conditions.
 */
export const STANDING_GRANT_RULES: readonly string[] = [
  "Access does not expire.",
  `${STANDING_IDLE_PAUSE_DAYS} days with no use pauses it; ${
    orList(STANDING_RESUME_ACTORS)
  } can resume it.`,
  "Revoking it is the only permanent stop.",
];

/** The rules as one paragraph. Rendered on the add-agent screen and the roster. */
export const STANDING_GRANT_COPY = STANDING_GRANT_RULES.join(" ");

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
  /**
   * CURRENT suspension, not the last one that happened. The read functions
   * report the effective value — swarm_read.renewal_grant_roster returns NULL
   * here once a grant has been resumed — so a resumed grant stops wearing the
   * SUSPENDED badge without this file having to know about resume at all.
   */
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
