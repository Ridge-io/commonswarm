/*
 * The pending-access model shared by every surface that shows it.
 *
 * Pending access is the waiting room of a workspace: teammate invitations not yet
 * redeemed, and agent keys not yet used. Two surfaces render it — the rail's
 * Pending access details (desktop) and the Agents dialog section (the only
 * reachable one at mobile widths) — and a bounded workspace poll keeps it fresh,
 * including discovery of access created by another browser. One function builds
 * the rows so the two lists can never disagree about content, order, or wording;
 * one predicate decides whether the poll should run, so the cadence can never
 * depend on which channel view is open or what this browser already knows.
 *
 * Pure and I/O-free so the dashboard and its test drive the same decisions.
 */

import type { AgentAccessStatus, PendingMemberInvite } from "./commonswarm";

export interface PendingAccessRow {
  /** Which cancel command the row needs: revoke_invitation or revoke_agent_token. */
  kind: "invite" | "agent";
  /** The id the cancel command sends: invitationId or tokenId. */
  id: string;
  workspaceId: string;
  /** The row's strong line: the invitee's email or the agent's name. */
  title: string;
  /** The row's quiet line: kind, owner/model where relevant, and the expiry. */
  state: string;
  /** The Cancel button's accessible name, specific to the row it cancels. */
  cancelLabel: string;
}

/**
 * Rows for both pending lists, in display order: teammate invitations first,
 * then unused agent keys. An agent key is pending only while it is unused,
 * unrevoked, and unexpired — a consumed or dead key is history, not access.
 */
export function pendingAccessRows(
  invites: PendingMemberInvite[],
  access: AgentAccessStatus[],
  ownerName: (userId: string) => string,
  now: number,
  relative: (iso: string) => string,
): PendingAccessRow[] {
  const rows: PendingAccessRow[] = [];
  for (const invitation of invites) {
    rows.push({
      kind: "invite",
      id: invitation.invitationId,
      workspaceId: invitation.workspaceId,
      title: invitation.email,
      state: `Teammate invite · expires ${relative(invitation.expiresAt)}`,
      cancelLabel: `Cancel invite for ${invitation.email}`,
    });
  }
  for (const entry of access) {
    const pending =
      entry.firstUsedAt === null &&
      entry.revokedAt === null &&
      new Date(entry.expiresAt).getTime() > now;
    if (!pending) continue;
    rows.push({
      kind: "agent",
      id: entry.tokenId,
      workspaceId: entry.workspaceId,
      title: entry.agentName,
      state:
        `${entry.model ?? "Model not specified"} · owned by ${ownerName(entry.ownerUserId)}` +
        ` · expires ${relative(entry.expiresAt)}`,
      cancelLabel: `Cancel access for ${entry.agentName}`,
    });
  }
  return rows;
}

/**
 * True once the exact freshly-created teammate invitation is absent from the
 * server's pending set. Other invitations cannot keep its one-use link alive.
 */
export function shouldRetireFreshInvite(
  invitationId: string,
  invites: PendingMemberInvite[],
): boolean {
  return (
    invitationId.length > 0 &&
    !invites.some((invitation) => invitation.invitationId === invitationId)
  );
}

/**
 * Whether the pending-access poll should be running at all. Deliberately NOT a
 * function of the channel view or current pending rows: a collaborator can add
 * the first invite from another browser, so local zero is not proof that there
 * is nothing to discover. The refresh gate supplies the slower idle cadence.
 */
export function shouldPollPendingAccess(args: {
  sampleMode: boolean;
  activeWorkspaceId: string;
  visible: boolean;
}): boolean {
  return (
    !args.sampleMode &&
    args.activeWorkspaceId.length > 0 &&
    args.visible
  );
}
