import {
  AGENT_SESSION_RENEW_AFTER_MS,
  AGENT_SESSION_TTL_MS,
  type AgentSessionProof,
} from "./session-contract.js";
import { AgentSessionError } from "./session-errors.js";
import { AgentSessionClient } from "./session-client.js";
import {
  sessionProofOf,
  writeSessionContext,
  type SessionContextDocument,
} from "./session-context.js";
import { bindSessionProof } from "./session-proof.js";

export type SessionDispatchState = "running" | "stopped";

export interface SessionManagerOptions {
  client: AgentSessionClient;
  credential: () => Promise<string>;
  workspaceId: string;
  contextPath: string;
  context: SessionContextDocument;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onDispatchStop?: (reason: AgentSessionError | Error) => void;
}

/**
 * One deterministic receiver owns renewals. A stopped model turn does not
 * renew; this manager does, independently of any ACP child.
 */
export class AgentSessionManager {
  private context: SessionContextDocument;
  private dispatch: SessionDispatchState = "running";
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private renewing = false;
  private lastProofAt: number;
  private readonly now: () => number;
  private readonly setTimer: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly options: SessionManagerOptions) {
    this.context = options.context;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.lastProofAt = this.now();
  }

  currentContext(): SessionContextDocument {
    return this.context;
  }

  currentProof(): AgentSessionProof | null {
    return sessionProofOf(this.context);
  }

  dispatchState(): SessionDispatchState {
    return this.dispatch;
  }

  boundFetcher(fetcher: typeof fetch): typeof fetch {
    return bindSessionProof(fetcher, this.currentProof());
  }

  /** Piggyback: a successful agent write proves the lease is still live. */
  noteSuccessfulWrite(): void {
    if (!this.started || this.dispatch !== "running") return;
    this.lastProofAt = this.now();
    this.armTimer();
  }

  start(): void {
    if (this.dispatch !== "running") return;
    this.started = true;
    this.armTimer();
  }

  stopTimers(): void {
    this.started = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  async release(): Promise<void> {
    this.stopTimers();
    const proof = this.currentProof();
    this.dispatch = "stopped";
    if (proof === null) return;
    const credential = await this.options.credential();
    await this.options.client.release(
      credential,
      this.options.workspaceId,
      proof,
    );
  }

  async applyGeneration(generation: number): Promise<SessionContextDocument> {
    this.context = { ...this.context, generation, enforcement: "enabled" };
    await writeSessionContext(this.options.contextPath, this.context);
    this.lastProofAt = this.now();
    return this.context;
  }

  private armTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (!this.started || this.dispatch !== "running") return;
    const due = this.lastProofAt + AGENT_SESSION_RENEW_AFTER_MS;
    const wait = Math.max(0, due - this.now());
    this.timer = this.setTimer(() => {
      void this.renewIfDue();
    }, wait);
  }

  private async renewIfDue(): Promise<void> {
    if (this.dispatch !== "running" || this.renewing) return;
    const proof = this.currentProof();
    if (proof === null) {
      this.stopDispatch(new Error("session proof is not yet acquired"));
      return;
    }
    const age = this.now() - this.lastProofAt;
    if (age >= AGENT_SESSION_TTL_MS) {
      this.stopDispatch(new AgentSessionError(403, "session_expired"));
      return;
    }
    this.renewing = true;
    try {
      const credential = await this.options.credential();
      await this.options.client.renew(
        credential,
        this.options.workspaceId,
        proof,
      );
      this.lastProofAt = this.now();
      this.armTimer();
    } catch (error) {
      this.stopDispatch(error instanceof Error ? error : new Error("renew failed"));
    } finally {
      this.renewing = false;
    }
  }

  private stopDispatch(reason: Error): void {
    this.dispatch = "stopped";
    this.stopTimers();
    this.options.onDispatchStop?.(reason);
  }
}
