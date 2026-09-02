import { randomUUID } from "node:crypto";
import type { SignalRecord } from "../cloud/command-client.js";
import type { CloudTarget } from "../cloud/config.js";
import { sanitizeText } from "../host/sanitize.js";
import type { HostSessionEvents, SanitizedSessionUpdate } from "../host/types.js";
import type { ListenerRuntimeEvent, ListenerRuntimeModel } from "./runtime.js";
import type {
  ListenerPromptMode,
  ListenerPromptResult,
} from "./types.js";

export const ACTIVITY_FRAME_INTERVAL_MS = 750;
export const ACTIVITY_HEARTBEAT_MS = 15_000;
export const ACTIVITY_TOOL_TITLE_MAX = 160;
export const ACTIVITY_REQUEST_TIMEOUT_MS = 5_000;

export type ListenerActivityPhase =
  | "claimed"
  | "prompting"
  | "tool-running"
  | "replying"
  | "idle";

export interface AgentActivityFrameRequest {
  version: 1;
  workspaceId: string;
  streamId: string;
  sequence: number;
  phase: ListenerActivityPhase;
  signalId: string | null;
  toolTitle: string | null;
  elapsedMs: number;
}

export interface AgentActivityTransport {
  publish(frame: AgentActivityFrameRequest): Promise<void>;
}

export interface ListenerActivityCredentialSession {
  bearer(): Promise<string>;
}

interface ActivityClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: ActivityClock = {
  now: Date.now,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

const TERMINAL_TOOL_STATUSES = new Set([
  "cancelled",
  "completed",
  "done",
  "failed",
  "rejected",
]);

/** Publish one bounded frame through the agent-authenticated activity edge. */
export class AgentActivityEndpointTransport implements AgentActivityTransport {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly target: CloudTarget,
    private readonly credentialSession: ListenerActivityCredentialSession,
    fetcher?: typeof fetch,
  ) {
    this.fetcher = fetcher ?? fetch;
  }

  async publish(frame: AgentActivityFrameRequest): Promise<void> {
    const credential = await this.credentialSession.bearer();
    const response = await this.fetcher(
      `${this.target.url}/functions/v1/activity`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          apikey: this.target.anonKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: frame.version,
          workspace_id: frame.workspaceId,
          stream_id: frame.streamId,
          sequence: frame.sequence,
          phase: frame.phase,
          signal_id: frame.signalId,
          tool_title: frame.toolTitle,
          elapsed_ms: frame.elapsedMs,
        }),
        signal: AbortSignal.timeout(ACTIVITY_REQUEST_TIMEOUT_MS),
      },
    );
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(`activity publish failed (${response.status})`);
    }
  }
}

interface ListenerActivityControllerOptions {
  workspaceId: string;
  transport: AgentActivityTransport;
  streamId?: string;
  clock?: ActivityClock;
}

/**
 * Coalesce the structured live-steering view chosen in SWARM-CLOUD §2.13.
 *
 * Frames are ephemeral and re-derivable from the listener's current turn. They
 * are never read back after the final signal, so RAM and best-effort Realtime
 * are within the durable-by-default boundary. Raw terminal bytes, stderr, and
 * message bodies have no field in this type and cannot enter the transport.
 */
export class ListenerActivityController {
  readonly events: HostSessionEvents;
  private readonly clock: ActivityClock;
  private readonly streamId: string;
  private sequence = 0;
  private phase: ListenerActivityPhase = "idle";
  private signalId: string | null = null;
  private signalStartedAt: number | null = null;
  private readonly runningTools = new Map<string, string>();
  private latestToolId: string | null = null;
  private dirty = false;
  private sending = false;
  private closed = false;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ListenerActivityControllerOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.streamId = options.streamId ?? randomUUID();
    this.events = { update: (update) => this.onSessionUpdate(update) };
  }

  /** Observe the listener state machine without changing its durable effect path. */
  onRuntimeEvent(event: ListenerRuntimeEvent): void {
    if (event.type === "ready") {
      this.setIdle();
    } else if (event.type === "delivery_claim" && event.signalId !== null) {
      this.beginSignal(event.signalId);
    } else if (event.type === "routing_decision") {
      this.beginSignal(event.signalId);
    } else if (event.type === "effect") {
      this.setIdle();
    }
  }

  /** Wrap one provider model so prompt and reply phases are visible. */
  instrumentModel(model: ListenerRuntimeModel): ListenerRuntimeModel {
    return {
      start: async () => await model.start(),
      prompt: async (
        signal: SignalRecord,
        mode: ListenerPromptMode,
        prompt: string,
        attempt: number,
      ): Promise<ListenerPromptResult> => {
        this.beginSignal(signal.id);
        this.setPhase("prompting");
        const result = await model.prompt(signal, mode, prompt, attempt);
        this.runningTools.clear();
        this.latestToolId = null;
        this.setPhase("replying");
        return result;
      },
      cancel: () => model.cancel(),
      close: async () => await model.close(),
    };
  }

  /** Stop pending local timers; a missing next frame becomes stale in the panel. */
  close(): void {
    this.closed = true;
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    if (this.heartbeatTimer !== null) this.clock.clearTimer(this.heartbeatTimer);
    this.timer = null;
    this.heartbeatTimer = null;
  }

  private onSessionUpdate(update: SanitizedSessionUpdate): void {
    if (this.signalId === null) return;
    if (update.kind !== "tool_call" && update.kind !== "tool_call_update") return;
    const id = update.toolCallId;
    if (!id) return;
    const status = update.status?.toLowerCase();
    if (status && TERMINAL_TOOL_STATUSES.has(status)) {
      this.runningTools.delete(id);
      if (this.latestToolId === id) {
        this.latestToolId = [...this.runningTools.keys()].at(-1) ?? null;
      }
      this.setPhase(this.runningTools.size > 0 ? "tool-running" : "prompting");
      return;
    }
    const sanitizedTitle = update.title === undefined
      ? this.runningTools.get(id)
      : sanitizeText(update.title).slice(0, ACTIVITY_TOOL_TITLE_MAX);
    const title = sanitizedTitle && sanitizedTitle.length > 0
      ? sanitizedTitle
      : "Tool";
    this.runningTools.set(id, title);
    this.latestToolId = id;
    this.setPhase("tool-running");
  }

  private beginSignal(signalId: string): void {
    if (this.signalId === signalId) return;
    this.signalId = signalId;
    this.signalStartedAt = this.clock.now();
    this.runningTools.clear();
    this.latestToolId = null;
    this.setPhase("claimed");
  }

  private setIdle(): void {
    this.signalId = null;
    this.signalStartedAt = null;
    this.runningTools.clear();
    this.latestToolId = null;
    this.setPhase("idle");
  }

  private setPhase(phase: ListenerActivityPhase): void {
    this.phase = phase;
    if (this.heartbeatTimer !== null) {
      this.clock.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.dirty = true;
    this.schedule();
  }

  private armHeartbeat(): void {
    if (this.closed || this.heartbeatTimer !== null) return;
    this.heartbeatTimer = this.clock.setTimer(() => {
      this.heartbeatTimer = null;
      this.dirty = true;
      this.schedule();
    }, ACTIVITY_HEARTBEAT_MS);
  }

  private schedule(): void {
    if (this.closed || this.timer !== null || this.sending) return;
    const delay = Math.max(
      0,
      this.lastSentAt + ACTIVITY_FRAME_INTERVAL_MS - this.clock.now(),
    );
    if (delay === 0) {
      void this.flush();
      return;
    }
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.closed || this.sending || !this.dirty) return;
    this.dirty = false;
    this.sending = true;
    this.lastSentAt = this.clock.now();
    const toolTitle = this.latestToolId === null
      ? null
      : this.runningTools.get(this.latestToolId) ?? null;
    const frame: AgentActivityFrameRequest = {
      version: 1,
      workspaceId: this.options.workspaceId,
      streamId: this.streamId,
      sequence: ++this.sequence,
      phase: this.phase,
      signalId: this.signalId,
      toolTitle,
      elapsedMs: this.signalStartedAt === null
        ? 0
        : Math.max(0, Math.round(this.clock.now() - this.signalStartedAt)),
    };
    try {
      await this.options.transport.publish(frame);
    } catch {
      // Realtime is a latency hint. A publish failure cannot change delivery,
      // the durable reply, listener liveness, or the next coalesced frame.
    } finally {
      this.sending = false;
      if (this.dirty) this.schedule();
      else this.armHeartbeat();
    }
  }
}
