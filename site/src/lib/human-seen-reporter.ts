/** Browser-side batching for focused-viewport human receipt attestations. */

export const HUMAN_SEEN_BATCH_MAX = 50;
export const HUMAN_SEEN_FLUSH_MS = 750;

export interface HumanSeenIntersection {
  scope: string;
  signalId: string;
  isIntersecting: boolean;
}

export interface HumanSeenReporterOptions {
  hasFocus(): boolean;
  send(scope: string, signalIds: readonly string[]): Promise<void>;
  schedule?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancel?(timer: ReturnType<typeof setTimeout>): void;
  flushMs?: number;
}

/** Deduplicate ids and keep every command inside the edge's 50-id wire cap. */
export function humanSeenBatches(
  signalIds: readonly string[],
  maximum = HUMAN_SEEN_BATCH_MAX,
): string[][] {
  if (!Number.isSafeInteger(maximum) || maximum < 1) return [];
  const unique = [...new Set(signalIds)];
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += maximum) {
    batches.push(unique.slice(start, start + maximum));
  }
  return batches;
}

/**
 * Track rows that intersect the transcript viewport. A row becomes reportable
 * only while the document has focus; a later focus event rechecks rows that
 * stayed visible while the tab was in the background.
 */
export class HumanSeenReporter {
  readonly #hasFocus: () => boolean;
  readonly #send: HumanSeenReporterOptions["send"];
  readonly #schedule: NonNullable<HumanSeenReporterOptions["schedule"]>;
  readonly #cancel: NonNullable<HumanSeenReporterOptions["cancel"]>;
  readonly #flushMs: number;
  readonly #visible = new Map<string, HumanSeenIntersection>();
  readonly #pending = new Map<string, HumanSeenIntersection>();
  readonly #reported = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #flushing: Promise<void> | null = null;

  constructor(options: HumanSeenReporterOptions) {
    this.#hasFocus = options.hasFocus;
    this.#send = options.send;
    this.#schedule = options.schedule ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.#cancel = options.cancel ?? ((timer) => clearTimeout(timer));
    this.#flushMs = options.flushMs ?? HUMAN_SEEN_FLUSH_MS;
  }

  #key(entry: Pick<HumanSeenIntersection, "scope" | "signalId">): string {
    return `${entry.scope}\u0000${entry.signalId}`;
  }

  #queue(entry: HumanSeenIntersection): void {
    if (!this.#hasFocus()) return;
    const key = this.#key(entry);
    if (this.#reported.has(key)) return;
    this.#pending.set(key, entry);
    if (this.#timer === null) {
      this.#timer = this.#schedule(() => void this.flush(), this.#flushMs);
    }
  }

  /** Apply one IntersectionObserver delivery. */
  intersections(entries: readonly HumanSeenIntersection[]): void {
    for (const entry of entries) {
      const key = this.#key(entry);
      if (!entry.isIntersecting) {
        this.#visible.delete(key);
        continue;
      }
      this.#visible.set(key, entry);
      this.#queue(entry);
    }
  }

  /** Recheck currently visible rows after the window receives focus. */
  focus(): void {
    if (!this.#hasFocus()) return;
    for (const entry of this.#visible.values()) this.#queue(entry);
  }

  /** Flush already-attested rows whenever document visibility changes. */
  visibilityChange(_visible: boolean): void {
    void this.flush();
  }

  /** Forget stale DOM nodes before a transcript rerender. */
  resetVisible(): void {
    this.#visible.clear();
  }

  /** Send pending attestations grouped by authenticated user/workspace scope. */
  async flush(): Promise<void> {
    if (this.#flushing !== null) return await this.#flushing;
    if (this.#timer !== null) {
      this.#cancel(this.#timer);
      this.#timer = null;
    }
    if (this.#pending.size === 0) return;

    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#flushing = (async () => {
      const byScope = new Map<string, string[]>();
      for (const entry of pending) {
        const ids = byScope.get(entry.scope) ?? [];
        ids.push(entry.signalId);
        byScope.set(entry.scope, ids);
      }
      for (const [scope, signalIds] of byScope) {
        for (const batch of humanSeenBatches(signalIds)) {
          try {
            await this.#send(scope, batch);
            for (const signalId of batch) {
              this.#reported.add(this.#key({ scope, signalId }));
            }
          } catch {
            for (const signalId of batch) {
              const entry = { scope, signalId, isIntersecting: true };
              this.#pending.set(this.#key(entry), entry);
            }
          }
        }
      }
    })();
    try {
      await this.#flushing;
    } finally {
      this.#flushing = null;
      if (this.#pending.size > 0 && this.#timer === null) {
        this.#timer = this.#schedule(() => void this.flush(), this.#flushMs);
      }
    }
  }
}
