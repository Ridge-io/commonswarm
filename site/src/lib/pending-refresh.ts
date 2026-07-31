/*
 * Ownership gate for the dashboard's pending-access refresh.
 *
 * Pending access (teammate invites and unused agent keys) has its own bounded
 * workspace cadence. Known pending access refreshes promptly; an empty local
 * list refreshes less often so access created in another browser is discovered.
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
  readonly #activeCooldownMs: number;
  readonly #discoveryCooldownMs: number;

  constructor(activeCooldownMs: number, discoveryCooldownMs: number) {
    this.#activeCooldownMs = activeCooldownMs;
    this.#discoveryCooldownMs = discoveryCooldownMs;
  }

  /**
   * True when this caller becomes the owner and should fetch. Known pending
   * access uses the active cooldown; local zero uses the slower discovery
   * cooldown. A different workspace or newer generation takes the gate from a
   * stale owner instead of waiting.
   */
  tryAcquire(
    workspaceId: string,
    version: number,
    now: number,
    hasPending: boolean,
  ): boolean {
    const cooldownMs = hasPending
      ? this.#activeCooldownMs
      : this.#discoveryCooldownMs;
    if (now - this.#attemptedAt < cooldownMs) return false;
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
