/**
 * Realtime wake subscriber. Push is a hint; the claim row stays the truth.
 * The topic is held in memory and never rendered, logged, or written to status.
 */
import { createClient } from "@supabase/supabase-js";
import type { CloudTarget } from "../cloud/config.js";
import {
  WAKE_EVENT,
  WAKE_TOPIC_PREFIX,
  isWakeTopic,
} from "../cloud/wake.js";
import { formatIdlePollDuration } from "../cloud/idle-poll.js";

export const LISTENER_RECONCILE_POLL_MS = 300_000;
export const WAKE_COALESCE_MS = 1_000;
export const WAKE_CLAIMS_PER_MINUTE_BUDGET = 50;
export const WAKE_RATE_LIMIT_POLL_MS = 60_000;

/** Realtime subscribe callback statuses, mapped at this boundary (D-053). */
export const REALTIME_SUBSCRIBE_STATUS = {
  SUBSCRIBED: "SUBSCRIBED",
  CHANNEL_ERROR: "CHANNEL_ERROR",
  CLOSED: "CLOSED",
  TIMED_OUT: "TIMED_OUT",
} as const;

export type RealtimeSubscribeStatus =
  (typeof REALTIME_SUBSCRIBE_STATUS)[keyof typeof REALTIME_SUBSCRIBE_STATUS];

export const WAKE_CONNECTION_STATES = [
  "disconnected",
  "connecting",
  "subscribed",
  "errored",
] as const;
export type WakeConnectionState = (typeof WAKE_CONNECTION_STATES)[number];

export const LISTENER_WAKE_MODES = ["push", "poll"] as const;
export type ListenerWakeMode = (typeof LISTENER_WAKE_MODES)[number];
export const LISTENER_WAKE_MODE_SET: ReadonlySet<string> = new Set(
  LISTENER_WAKE_MODES,
);

export const WAKE_ERROR_CODES = [
  "channel_error",
  "closed",
  "timed_out",
  "rate_limited",
] as const;
export type WakeErrorCode = (typeof WAKE_ERROR_CODES)[number];
export const WAKE_ERROR_CODE_SET: ReadonlySet<string> = new Set(WAKE_ERROR_CODES);

export const LISTENER_WAKE_STATUS_KEYS = [
  "mode",
  "subscribedAt",
  "reconnects",
  "lastWakeAt",
  "lastReconcileAt",
  "errorCode",
  "topicRotatedAt",
  "rateLimited",
] as const;

export const LISTENER_WAKE_SENSITIVE_KEYS = [
  "topic",
  "wakeTopic",
  "wake_topic",
] as const;

export type WakeWaitReason = "wake" | "state" | "deadline";

export interface ListenerWakeStatus {
  mode: ListenerWakeMode;
  subscribedAt: string | null;
  reconnects: number;
  lastWakeAt: string | null;
  lastReconcileAt: string | null;
  errorCode: WakeErrorCode | null;
  topicRotatedAt: string | null;
  rateLimited: boolean;
}

export interface WakeRealtimeChannel {
  on(
    type: "broadcast",
    filter: { event: string },
    callback: (message: { payload?: unknown }) => void,
  ): WakeRealtimeChannel;
  subscribe(
    callback: (status: string, err?: Error) => void,
  ): WakeRealtimeChannel;
  unsubscribe(): void | Promise<void>;
}

export interface WakeRealtimeClient {
  setAuth(token: string): void | Promise<void>;
  channel(
    topic: string,
    options: { config: { private: boolean } },
  ): WakeRealtimeChannel;
  removeChannel?(channel: WakeRealtimeChannel): void | Promise<void>;
  disconnect?(): void;
}

export interface WakeHandle {
  readonly state: WakeConnectionState;
  readonly hasTopic: boolean;
  snapshot(nowMs?: number): ListenerWakeStatus;
  next(options: {
    until: number;
    signal?: AbortSignal;
  }): Promise<WakeWaitReason>;
  setTopic(topic: string): void;
  noteReconcile(nowMs?: number): void;
  noteClaim(nowMs?: number): void;
  noteWakeClaim(nowMs?: number): void;
  canClaimOnWake(nowMs?: number): boolean;
  coalescingRemainingMs(nowMs?: number): number;
  overWakeBudget(nowMs?: number): boolean;
  markRateLimited(nowMs?: number): void;
  close(): Promise<void>;
}

export interface WakeSubscriberOptions {
  target: CloudTarget;
  now?: () => number;
  createRealtime?: (target: CloudTarget) => WakeRealtimeClient;
}

function defaultRealtime(target: CloudTarget): WakeRealtimeClient {
  const client = createClient(target.url, target.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client.realtime as unknown as WakeRealtimeClient;
}

function isSubscribeStatus(value: string): value is RealtimeSubscribeStatus {
  return (
    value === REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED ||
    value === REALTIME_SUBSCRIBE_STATUS.CHANNEL_ERROR ||
    value === REALTIME_SUBSCRIBE_STATUS.CLOSED ||
    value === REALTIME_SUBSCRIBE_STATUS.TIMED_OUT
  );
}

/** Map a Realtime subscribe status code. Never reads error.message. */
export function wakeErrorCodeFromSubscribeStatus(
  status: string,
): WakeErrorCode | null {
  switch (status) {
    case REALTIME_SUBSCRIBE_STATUS.CHANNEL_ERROR:
      return "channel_error";
    case REALTIME_SUBSCRIBE_STATUS.CLOSED:
      return "closed";
    case REALTIME_SUBSCRIBE_STATUS.TIMED_OUT:
      return "timed_out";
    default:
      return null;
  }
}

export function emptyListenerWakeStatus(): ListenerWakeStatus {
  return {
    mode: "poll",
    subscribedAt: null,
    reconnects: 0,
    lastWakeAt: null,
    lastReconcileAt: null,
    errorCode: null,
    topicRotatedAt: null,
    rateLimited: false,
  };
}

/** Persist status.json when the wake block changes, not on every lastWakeAt tick. */
export function listenerWakePersistWorthy(
  previous: ListenerWakeStatus | undefined,
  next: ListenerWakeStatus,
  lastPersistMs: number,
  nowMs: number,
): boolean {
  if (previous === undefined) return true;
  if (
    previous.mode !== next.mode ||
    previous.rateLimited !== next.rateLimited ||
    previous.errorCode !== next.errorCode ||
    previous.reconnects !== next.reconnects ||
    previous.subscribedAt !== next.subscribedAt ||
    previous.topicRotatedAt !== next.topicRotatedAt ||
    previous.lastReconcileAt !== next.lastReconcileAt
  ) {
    return true;
  }
  if (previous.lastWakeAt !== next.lastWakeAt) {
    return nowMs - lastPersistMs >= WAKE_COALESCE_MS;
  }
  return false;
}

export function listenerWakeStatusSentence(
  wake: ListenerWakeStatus,
  pollIntervalMs: number,
  lastWakeLabel: string | null,
): string {
  if (wake.mode === "push") {
    const last = lastWakeLabel === null ? "no wake yet" : `last wake ${lastWakeLabel}`;
    return `push (Realtime), ${last}, reconcile every ${formatIdlePollDuration(LISTENER_RECONCILE_POLL_MS)}.`;
  }
  const code = wake.errorCode ?? "disconnected";
  return `poll every ${formatIdlePollDuration(pollIntervalMs)}. Realtime not connected (${code}).`;
}

type Waiter = {
  resolve: (reason: WakeWaitReason) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  signal: AbortSignal | undefined;
};

export class WakeSubscriber implements WakeHandle {
  private readonly now: () => number;
  private readonly target: CloudTarget;
  private readonly createRealtime: (target: CloudTarget) => WakeRealtimeClient;
  private realtime: WakeRealtimeClient | null = null;
  private channel: WakeRealtimeChannel | null = null;
  private topic: string | null = null;
  private waiter: Waiter | null = null;
  private pending: WakeWaitReason | null = null;
  private connectionState: WakeConnectionState = "disconnected";
  private subscribedAt: string | null = null;
  private reconnects = 0;
  private lastWakeAt: string | null = null;
  private lastReconcileAt: string | null = null;
  private lastErrorCode: WakeErrorCode | null = null;
  private topicRotatedAt: string | null = null;
  private rateLimitedUntil = 0;
  private lastClaimAt = 0;
  private wakeClaimTimes: number[] = [];
  private closed = false;
  private everSubscribed = false;

  constructor(options: WakeSubscriberOptions) {
    this.target = options.target;
    this.now = options.now ?? Date.now;
    this.createRealtime = options.createRealtime ?? defaultRealtime;
  }

  get state(): WakeConnectionState {
    return this.connectionState;
  }

  get hasTopic(): boolean {
    return this.topic !== null;
  }

  snapshot(nowMs: number = this.now()): ListenerWakeStatus {
    const rateLimited = this.wakeClaimPaused(nowMs);
    const mode: ListenerWakeMode =
      this.connectionState === "subscribed" && !rateLimited ? "push" : "poll";
    const errorCode = rateLimited
      ? "rate_limited"
      : this.lastErrorCode;
    return {
      mode,
      subscribedAt: this.subscribedAt,
      reconnects: this.reconnects,
      lastWakeAt: this.lastWakeAt,
      lastReconcileAt: this.lastReconcileAt,
      errorCode,
      topicRotatedAt: this.topicRotatedAt,
      rateLimited,
    };
  }

  noteReconcile(nowMs: number = this.now()): void {
    this.lastReconcileAt = new Date(nowMs).toISOString();
  }

  noteClaim(nowMs: number = this.now()): void {
    this.lastClaimAt = nowMs;
  }

  noteWakeClaim(nowMs: number = this.now()): void {
    this.noteClaim(nowMs);
    this.wakeClaimTimes.push(nowMs);
    this.trimWakeClaims(nowMs);
  }

  coalescingRemainingMs(nowMs: number = this.now()): number {
    if (this.lastClaimAt <= 0) return 0;
    return Math.max(0, this.lastClaimAt + WAKE_COALESCE_MS - nowMs);
  }

  overWakeBudget(nowMs: number = this.now()): boolean {
    this.trimWakeClaims(nowMs);
    return this.wakeClaimTimes.length >= WAKE_CLAIMS_PER_MINUTE_BUDGET;
  }

  canClaimOnWake(nowMs: number = this.now()): boolean {
    if (nowMs < this.rateLimitedUntil) return false;
    if (this.coalescingRemainingMs(nowMs) > 0) return false;
    return !this.overWakeBudget(nowMs);
  }

  markRateLimited(nowMs: number = this.now()): void {
    this.rateLimitedUntil = nowMs + WAKE_RATE_LIMIT_POLL_MS;
    this.lastErrorCode = "rate_limited";
    this.emitPending("state");
  }

  setTopic(topic: string): void {
    if (this.closed) return;
    if (!isWakeTopic(topic)) {
      throw new Error("wake topic is malformed");
    }
    if (this.topic === topic) return;
    const rotated = this.topic !== null;
    void this.detachChannel();
    this.topic = topic;
    if (rotated) {
      this.topicRotatedAt = new Date(this.now()).toISOString();
    }
    this.connect();
  }

  next(options: {
    until: number;
    signal?: AbortSignal;
  }): Promise<WakeWaitReason> {
    if (this.waiter !== null) {
      throw new Error("wake next() already has a waiter");
    }
    if (options.signal?.aborted) {
      return Promise.resolve("deadline");
    }
    const nowMs = this.now();
    if (this.pending !== null) {
      if (!(this.pending === "wake" && this.wakeClaimPaused(nowMs))) {
        const reason = this.pending;
        this.pending = null;
        return Promise.resolve(reason);
      }
    }
    if (nowMs >= options.until) {
      return Promise.resolve("deadline");
    }
    return new Promise<WakeWaitReason>((resolve) => {
      const finish = (reason: WakeWaitReason) => {
        if (this.waiter === null) return;
        const current = this.waiter;
        this.waiter = null;
        if (current.timer !== null) clearTimeout(current.timer);
        if (current.signal && current.onAbort) {
          current.signal.removeEventListener("abort", current.onAbort);
        }
        resolve(reason);
      };
      const delay = Math.max(0, options.until - this.now());
      const timer = setTimeout(() => finish("deadline"), delay);
      const onAbort = () => finish("deadline");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = {
        resolve: finish,
        timer,
        onAbort,
        signal: options.signal,
      };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.topic = null;
    this.finishWait("deadline");
    await this.detachChannel();
    try {
      this.realtime?.disconnect?.();
    } catch {
      // Closing a socket that is already down is not a listener failure.
    }
    this.realtime = null;
    this.connectionState = "disconnected";
  }

  private trimWakeClaims(nowMs: number): void {
    const minuteStart = Math.floor(nowMs / 60_000) * 60_000;
    this.wakeClaimTimes = this.wakeClaimTimes.filter((ts) => ts >= minuteStart);
  }

  /** Client budget or a server 429: do not claim on wake; poll covers the window. */
  private wakeClaimPaused(nowMs: number): boolean {
    return nowMs < this.rateLimitedUntil || this.overWakeBudget(nowMs);
  }

  private emitPending(reason: WakeWaitReason): void {
    if (this.waiter !== null) {
      if (reason === "wake" && this.wakeClaimPaused(this.now())) {
        this.pending = "wake";
        return;
      }
      this.finishWait(reason);
      return;
    }
    if (reason === "wake" || this.pending !== "wake") {
      this.pending = reason;
    }
  }

  private finishWait(reason: WakeWaitReason): void {
    const waiter = this.waiter;
    if (waiter === null) return;
    this.waiter = null;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(reason);
  }

  private connect(): void {
    if (this.closed || this.topic === null) return;
    if (this.realtime === null) {
      this.realtime = this.createRealtime(this.target);
      void this.realtime.setAuth(this.target.anonKey);
    }
    const topic = this.topic;
    this.connectionState = "connecting";
    this.lastErrorCode = null;
    const channel = this.realtime.channel(topic, {
      config: { private: true },
    });
    this.channel = channel;
    channel.on("broadcast", { event: WAKE_EVENT }, () => {
      this.lastWakeAt = new Date(this.now()).toISOString();
      this.emitPending("wake");
    });
    channel.subscribe((status) => {
      this.onSubscribeStatus(status);
    });
  }

  private onSubscribeStatus(status: string): void {
    if (this.closed) return;
    if (!isSubscribeStatus(status)) return;
    const wasSubscribed = this.connectionState === "subscribed";
    if (status === REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED) {
      this.connectionState = "subscribed";
      this.subscribedAt = new Date(this.now()).toISOString();
      this.lastErrorCode = null;
      if (this.everSubscribed && !wasSubscribed) this.reconnects += 1;
      this.everSubscribed = true;
      if (!wasSubscribed) this.emitPending("state");
      return;
    }
    const code = wakeErrorCodeFromSubscribeStatus(status);
    if (status === REALTIME_SUBSCRIBE_STATUS.CLOSED) {
      this.connectionState = "disconnected";
    } else {
      this.connectionState = "errored";
    }
    this.lastErrorCode = code;
    this.subscribedAt = null;
    if (wasSubscribed) this.emitPending("state");
  }

  private async detachChannel(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    if (channel === null) return;
    try {
      await channel.unsubscribe();
    } catch {
      // Unsubscribe after a drop is best-effort.
    }
    try {
      await this.realtime?.removeChannel?.(channel);
    } catch {
      // Same: the socket may already be gone.
    }
    if (this.channel !== null) return;
    if (this.connectionState === "subscribed") {
      this.connectionState = "disconnected";
      this.subscribedAt = null;
    }
  }
}

export function createWakeSubscriber(
  options: WakeSubscriberOptions,
): WakeSubscriber {
  return new WakeSubscriber(options);
}

export { WAKE_EVENT, WAKE_TOPIC_PREFIX, isWakeTopic };
