/*
 * Ownership check for the dashboard's asynchronous teammate-invite submission.
 *
 * The invite response contains a one-use credential. It may be rendered only by
 * the exact workspace generation that submitted it: a workspace switch or even
 * a reload of the same workspace makes the response stale. Pure and I/O-free so
 * the dashboard and its causal race tests drive the same decision.
 */

export interface InviteSubmitOwner {
  workspaceId: string;
  version: number;
}

/** True only while the submitted workspace generation still owns the result. */
export function isInviteSubmitCurrent(
  owner: InviteSubmitOwner,
  activeWorkspaceId: string,
  requestVersion: number,
): boolean {
  return (
    owner.workspaceId === activeWorkspaceId &&
    owner.version === requestVersion
  );
}
