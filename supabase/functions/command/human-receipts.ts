/** Server-side writes for the browser's focused-viewport human receipt proxy. */
import type postgres from "postgres";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const SIGNALS_SEEN_KIND = "signals_seen";
export const SIGNALS_SEEN_MAX_IDS = 50;

export interface SignalsSeenCommand {
  kind: typeof SIGNALS_SEEN_KIND;
  signal_ids: string[];
}

export type MarkHumanSignalsSeenResult =
  | { status: "accepted"; matched: number }
  | { status: "forbidden"; matched: 0 };

/**
 * Record the server's first attested seen time for visible human-targeted or
 * broadcast signals, while refusing a known same-workspace signal that the
 * member was not eligible to receive.
 */
export async function markHumanSignalsSeen(
  tx: Sql,
  args: {
    workspaceId: string;
    userId: string;
    signalIds: readonly string[];
  },
): Promise<MarkHumanSignalsSeenResult> {
  const membership = await tx<{ live: boolean }[]>`
    SELECT true AS live
    FROM swarm.memberships AS membership
    JOIN swarm.workspaces AS workspace
      ON workspace.workspace_id = membership.workspace_id
     AND workspace.archived_at IS NULL
    WHERE membership.workspace_id = ${args.workspaceId}::uuid
      AND membership.user_id = ${args.userId}::uuid
      AND membership.revoked_at IS NULL
    LIMIT 1
  `;
  if (membership[0]?.live !== true) {
    return { status: "forbidden", matched: 0 };
  }

  const known = await tx<{
    id: string;
    to_user_id: string | null;
    to_agent_principal_id: string | null;
  }[]>`
    SELECT id, to_user_id, to_agent_principal_id
    FROM swarm.signals
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND id = ANY (${args.signalIds}::uuid[])
  `;
  const hasIneligibleSignal = known.some((signal) =>
    signal.to_agent_principal_id !== null ||
    (signal.to_user_id !== null && signal.to_user_id !== args.userId)
  );
  if (hasIneligibleSignal) {
    return { status: "forbidden", matched: 0 };
  }

  const eligibleIds = known.map((signal) => signal.id);
  if (eligibleIds.length === 0) {
    return { status: "accepted", matched: 0 };
  }
  await tx`
    INSERT INTO swarm.signal_human_receipts (
      workspace_id, signal_id, user_id, first_seen_at
    )
    SELECT
      signal.workspace_id,
      signal.id,
      ${args.userId}::uuid,
      statement_timestamp()
    FROM swarm.signals AS signal
    WHERE signal.workspace_id = ${args.workspaceId}::uuid
      AND signal.id = ANY (${eligibleIds}::uuid[])
      AND signal.to_agent_principal_id IS NULL
      AND (
        signal.to_user_id IS NULL
        OR signal.to_user_id = ${args.userId}::uuid
      )
    ON CONFLICT (signal_id, user_id) DO NOTHING
  `;
  return { status: "accepted", matched: eligibleIds.length };
}
