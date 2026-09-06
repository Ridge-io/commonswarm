/*
 * Workspace feed wake: subscribe to the private cswarm-signals topic and
 * refresh the feed on events, with a 30-second reconcile while SUBSCRIBED and
 * the existing 2-second poll when not. Push is a hint; the signal page is
 * still the truth.
 *
 * Status is classified by the Realtime subscribe callback names in
 * FEED_PUSH_FALLBACK_STATUSES, never by a thrown Error's presentation text (D-053).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const WORKSPACE_SIGNALS_TOPIC_PREFIX = "cswarm-signals:";
export const WORKSPACE_SIGNALS_EVENT = "signal";
export const FEED_PUSH_SUBSCRIBED_STATUS = "SUBSCRIBED";

/** Fallback poll while the workspace signal topic is not SUBSCRIBED. */
export const FEED_POLL_MS = 2_000;
/** Reconcile while the workspace signal topic is SUBSCRIBED. Spec §4.3. */
export const FEED_RECONCILE_MS = 30_000;
/** Resubscribe delays after CHANNEL_ERROR / TIMED_OUT / CLOSED. */
export const FEED_PUSH_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;

/**
 * Realtime subscribe statuses that drop push and restore the poll.
 * The controller reads this set; tests emit the same names as literals.
 */
export const FEED_PUSH_FALLBACK_STATUSES = [
  "CHANNEL_ERROR",
  "TIMED_OUT",
  "CLOSED",
] as const;

export type FeedPushFallbackStatus = (typeof FEED_PUSH_FALLBACK_STATUSES)[number];

const FEED_PUSH_FALLBACK_STATUS_SET: ReadonlySet<string> = new Set(
  FEED_PUSH_FALLBACK_STATUSES,
);

export function isFeedPushFallbackStatus(
  status: string,
): status is FeedPushFallbackStatus {
  return FEED_PUSH_FALLBACK_STATUS_SET.has(status);
}

/** Topic name from the workspace id; never caller-entered text. */
export function workspaceSignalsTopic(workspaceId: string): string {
  if (!UUID_RE.test(workspaceId)) {
    throw new Error("workspace signals workspace id is malformed");
  }
  return `${WORKSPACE_SIGNALS_TOPIC_PREFIX}${workspaceId.toLowerCase()}`;
}

export function feedRefreshIntervalMs(subscribed: boolean): number {
  return subscribed ? FEED_RECONCILE_MS : FEED_POLL_MS;
}

export interface FeedPushSubscription {
  unsubscribe(): Promise<void>;
}

export interface FeedPushRealtimeChannel {
  on(
    type: "broadcast",
    filter: { event: string },
    callback: (message: unknown) => void,
  ): unknown;
  subscribe(callback: (status: string) => void): unknown;
}

export interface FeedPushChannelClient {
  channel(
    name: string,
    opts: {
      config: {
        private: boolean;
        broadcast: { ack: boolean; self: boolean };
      };
    },
  ): FeedPushRealtimeChannel;
  removeChannel(channel: FeedPushRealtimeChannel): Promise<unknown> | unknown;
}

export interface FeedPushTimers {
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number | undefined): void;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
}

export interface FeedPushHooks {
  subscribe: (
    workspaceId: string,
    onEvent: () => void,
    onStatus: (status: string) => void,
  ) => Promise<FeedPushSubscription>;
  refresh: () => Promise<void> | void;
  timers: FeedPushTimers;
}

/**
 * Bind one private workspace-signal channel. Callers that await (session,
 * setAuth) must pass a workspace id captured before those awaits.
 */
export function attachWorkspaceSignalsChannel(
  c: FeedPushChannelClient,
  workspaceId: string,
  onEvent: () => void,
  onStatus: (status: string) => void,
): FeedPushSubscription {
  const workspaceForJoin = workspaceId;
  let removed = false;
  const channel = c.channel(workspaceSignalsTopic(workspaceForJoin), {
    config: {
      private: true,
      broadcast: { ack: false, self: false },
    },
  });
  channel.on("broadcast", { event: WORKSPACE_SIGNALS_EVENT }, () => {
    if (removed) return;
    onEvent();
  });
  channel.subscribe((status) => {
    if (removed) return;
    onStatus(status);
  });
  return {
    async unsubscribe(): Promise<void> {
      if (removed) return;
      removed = true;
      await c.removeChannel(channel);
    },
  };
}

export class FeedPushController {
  readonly #hooks: FeedPushHooks;
  #generation = 0;
  #workspaceId = "";
  #subscription: FeedPushSubscription | null = null;
  #subscribed = false;
  #armed = false;
  #refreshTimer: number | undefined;
  #backoffTimer: number | undefined;
  #backoffAttempt = 0;
  #refreshing = false;
  #queued = false;
  #chain: Promise<void> = Promise.resolve();

  constructor(hooks: FeedPushHooks) {
    this.#hooks = hooks;
  }

  get subscribed(): boolean {
    return this.#subscribed;
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  /** Resolves when the current start/stop chain has no join in flight. */
  whenIdle(): Promise<void> {
    return this.#chain.catch(() => undefined);
  }

  start(workspaceId: string): void {
    const workspaceForJoin = workspaceId;
    const generation = ++this.#generation;
    this.#workspaceId = workspaceForJoin;
    this.#subscribed = false;
    this.#backoffAttempt = 0;
    this.#clearBackoff();
    this.#syncRefreshTimer();
    this.#chain = this.#chain
      .catch(() => undefined)
      .then(() => this.#join(generation, workspaceForJoin));
  }

  stop(): void {
    this.#generation += 1;
    this.#workspaceId = "";
    this.#subscribed = false;
    this.#armed = false;
    this.#queued = false;
    this.#clearBackoff();
    this.#clearRefreshTimer();
    this.#chain = this.#chain
      .catch(() => undefined)
      .then(() => this.#teardown());
  }

  arm(): void {
    const wasArmed = this.#armed;
    this.#armed = true;
    if (this.#refreshTimer !== undefined) return;
    this.#syncRefreshTimer();
    if (!wasArmed && this.#subscribed) this.requestRefresh();
  }

  disarm(): void {
    this.#armed = false;
    this.#clearRefreshTimer();
  }

  requestRefresh(): void {
    if (this.#refreshing) {
      this.#queued = true;
      return;
    }
    this.#refreshing = true;
    void this.#runRefresh();
  }

  async #runRefresh(): Promise<void> {
    try {
      await this.#hooks.refresh();
    } finally {
      this.#refreshing = false;
      if (this.#queued) {
        this.#queued = false;
        this.#refreshing = true;
        await this.#runRefresh();
      }
    }
  }

  async #join(generation: number, workspaceId: string): Promise<void> {
    await this.#teardown();
    if (generation !== this.#generation) return;
    try {
      const subscription = await this.#hooks.subscribe(
        workspaceId,
        () => {
          if (generation !== this.#generation) return;
          this.requestRefresh();
        },
        (status) => {
          this.#onStatus(generation, workspaceId, status);
        },
      );
      if (generation !== this.#generation) {
        await subscription.unsubscribe();
        return;
      }
      this.#subscription = subscription;
    } catch {
      if (generation !== this.#generation) return;
      this.#setSubscribed(false);
      this.#scheduleResubscribe(generation, workspaceId);
    }
  }

  async #teardown(): Promise<void> {
    const subscription = this.#subscription;
    this.#subscription = null;
    if (!subscription) return;
    await subscription.unsubscribe();
  }

  #onStatus(generation: number, workspaceId: string, status: string): void {
    if (generation !== this.#generation) return;
    if (status === FEED_PUSH_SUBSCRIBED_STATUS) {
      this.#backoffAttempt = 0;
      this.#clearBackoff();
      this.#setSubscribed(true);
      return;
    }
    if (isFeedPushFallbackStatus(status)) {
      this.#setSubscribed(false);
      this.#scheduleResubscribe(generation, workspaceId);
    }
  }

  #setSubscribed(value: boolean): void {
    this.#subscribed = value;
    this.#syncRefreshTimer();
  }

  #syncRefreshTimer(): void {
    this.#clearRefreshTimer();
    if (!this.#armed) return;
    this.#refreshTimer = this.#hooks.timers.setInterval(
      () => this.requestRefresh(),
      feedRefreshIntervalMs(this.#subscribed),
    );
  }

  #clearRefreshTimer(): void {
    if (this.#refreshTimer === undefined) return;
    this.#hooks.timers.clearInterval(this.#refreshTimer);
    this.#refreshTimer = undefined;
  }

  #clearBackoff(): void {
    if (this.#backoffTimer === undefined) return;
    this.#hooks.timers.clearTimeout(this.#backoffTimer);
    this.#backoffTimer = undefined;
  }

  #scheduleResubscribe(generation: number, workspaceId: string): void {
    if (generation !== this.#generation) return;
    if (this.#backoffTimer !== undefined) return;
    const delay =
      FEED_PUSH_BACKOFF_MS[
        Math.min(this.#backoffAttempt, FEED_PUSH_BACKOFF_MS.length - 1)
      ]!;
    this.#backoffAttempt += 1;
    this.#backoffTimer = this.#hooks.timers.setTimeout(() => {
      this.#backoffTimer = undefined;
      if (generation !== this.#generation) return;
      const workspaceForJoin = workspaceId;
      const nextGeneration = ++this.#generation;
      this.#chain = this.#chain
        .catch(() => undefined)
        .then(() => this.#join(nextGeneration, workspaceForJoin));
    }, delay);
  }
}
