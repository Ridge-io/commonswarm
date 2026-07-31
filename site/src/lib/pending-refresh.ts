/*
 * Ownership gate for the dashboard's pending-access refresh.
 *
 * The browser polls signals every two seconds per workspace, and pending access
 * (teammate invites and unused agent keys) rides that poll at a slower cooldown.
 * The race this exists for: a refresh for workspace A is slow, the user switches
 * to workspace B, and B's refresh must neither wait behind A's request nor be
 * disturbed when A's request finally settles. A single boolean in-flight flag
 * fails both halves — B blocks behind A, and A's late completion frees a slot
 * it no longer owns.
 *
 * Ownership is therefore a (workspaceId, version) pair, not a boolean. Acquiring
 * for a different workspace or a newer generation replaces the stale owner;
 * releasing clears only ownership the caller still holds. The gate is pure and
 * I/O-free so the dashboard and its test drive the same decisions.
 */

export interface PendingRefreshOwner {
  workspaceId: string;
  version: number;
}

export class PendingRefreshGate {
  #owner: PendingRefreshOwner | null = null;
  #attemptedAt = Number.NEGATIVE_INFINITY;
  readonly #cooldownMs: number;

  constructor(cooldownMs: number) {
    this.#cooldownMs = cooldownMs;
  }

  /**
   * True when this caller becomes the owner and should fetch. False when nothing
   * is pending, when the cooldown is still running, or when this exact refresh
   * is already in flight. A different workspace or newer generation takes the
   * gate from the stale owner instead of waiting.
   */
  tryAcquire(
    workspaceId: string,
    version: number,
    now: number,
    hasPending: boolean,
  ): boolean {
    if (!hasPending) return false;
    if (now - this.#attemptedAt < this.#cooldownMs) return false;
    const owner = this.#owner;
    if (
      owner !== null &&
      owner.workspaceId === workspaceId &&
      owner.version === version
    ) {
      return false;
    }
    this.#owner = { workspaceId, version };
    this.#attemptedAt = now;
    return true;
  }

  /**
   * Clears ownership only when the caller still holds it — a stale request's
   * completion must never free a newer owner's slot.
   */
  release(workspaceId: string, version: number): void {
    if (
      this.#owner !== null &&
      this.#owner.workspaceId === workspaceId &&
      this.#owner.version === version
    ) {
      this.#owner = null;
    }
  }

  /**
   * A workspace switch restarts the cooldown so the fresh workspace's pending
   * rows refresh on the next poll rather than a full cooldown late.
   */
  resetCooldown(): void {
    this.#attemptedAt = Number.NEGATIVE_INFINITY;
  }
}
