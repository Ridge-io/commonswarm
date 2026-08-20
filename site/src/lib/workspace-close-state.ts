export interface CloseableWorkspace {
  id: string;
  name: string;
  archived: boolean;
}

export interface WorkspaceCloseState<T extends CloseableWorkspace> {
  workspaces: T[];
  activeWorkspaceRemains: boolean;
  nextWorkspace: T | null;
}

/** Removes closed rows and chooses only a live workspace after a close. */
export function workspaceStateAfterClose<T extends CloseableWorkspace>(
  activeWorkspaceId: string,
  closedWorkspaceId: string,
  workspaces: readonly T[],
): WorkspaceCloseState<T> {
  const live = workspaces.filter((workspace) =>
    workspace.id !== closedWorkspaceId && !workspace.archived
  );
  const current = live.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  return {
    workspaces: live,
    activeWorkspaceRemains: current !== null,
    nextWorkspace: current ?? live[0] ?? null,
  };
}
