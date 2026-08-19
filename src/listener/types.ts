import type {
  SenderOwnerRelation,
  SignalRecord,
} from "../cloud/command-client.js";

/**
 * The closed signal family a durable effect records. Asks keep the v1
 * deterministic reply path; notes are direct signals the listener observes
 * with zero model/reply effects at all.
 */
export type ListenerSignalKind = "ask" | "note";

export type ListenerEffectState =
  | "received"
  | "prompting"
  | "reply_ready"
  | "posting"
  | "done"
  | "expired"
  | "failed"
  | "observed";

/**
 * Schema version 2: the v1 ask file plus a closed `signalKind` discriminator.
 *
 * Version 1 files stay readable and upcast in memory to signalKind "ask"
 * without a re-write. `state: "observed"` is a terminal, note-only state:
 * an observed note carries zero prompt/post attempts, no reply body or reply
 * signal, and an empty `commandId` because it has no reply command. The
 * cross-field invariants behind those words live in `parseListenerEffectRecord`;
 * the type alone does not encode them (§ Listener integration).
 */
export interface ListenerEffectRecord {
  version: 2;
  signalId: string;
  signalKind: ListenerSignalKind;
  effectOrdinal: 0;
  commandId: string;
  askBody: string;
  askUntil: string;
  senderOwnerRelation: SenderOwnerRelation;
  state: ListenerEffectState;
  promptAttempts: number;
  postAttempts: number;
  replyBody: string | null;
  replyTruncated: boolean;
  replySignalId: string | null;
  failureCode: string | null;
  updatedAt: string;
}

export interface ListenerEffectStore {
  read(signalId: string): Promise<ListenerEffectRecord | null>;
  write(record: ListenerEffectRecord): Promise<void>;
}

/**
 * Default budget for one listener worker PROMPT turn (10 minutes).
 *
 * The transport default (ACP_DEFAULT_REQUEST_TIMEOUT_MS, 120s) protects the
 * handshake path: initialize, session/new, and the permission canary must
 * answer quickly, and a tight bound turns a wedged child into a fast,
 * restartable failure. A prompt turn is different — a worker legitimately
 * thinks, runs tools, and edits files for minutes, and a heavyweight ask was
 * measured dying at exactly +120s twice (retry_pending, acptimeouterror)
 * before succeeding on promptAttempts 3. Raising only the prompt budget is
 * safe because the durable claim/ack layer already redelivers the signal if
 * the worker dies mid-turn — the timeout is not the only safety net.
 * Override per-listener with `cswarm listen start --turn-budget`.
 */
export const LISTENER_PROMPT_TIMEOUT_MS = 600_000;

export type ListenerPermissionMode = "deny" | "allow";

export type ListenerPromptMode = "worker";

export interface ListenerSenderProvenance {
  senderName: string | null;
  operatorId: string | null;
  operatorName: string | null;
}

export interface ListenerSenderProvenanceContext {
  signal?: AbortSignal;
  deadlineMs: number;
}

export interface ListenerPromptResult {
  message: string;
  stopReason:
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal"
    | "cancelled";
}

export interface ListenerModel {
  prompt(
    signal: SignalRecord,
    mode: ListenerPromptMode,
    prompt: string,
    attempt: number,
  ): Promise<ListenerPromptResult>;
}

export interface ListenerReplyPoster {
  post(input: {
    signal: SignalRecord;
    body: string;
    commandId: string;
    /**
     * Caller cancellation, distinct from the internal transport deadlines. The
     * poster wires it into its transport; it is never persisted, logged, or sent.
     */
    abortSignal?: AbortSignal;
  }): Promise<{ signalId: string }>;
}

export type ListenerProcessResult =
  | { status: "ignored"; reason: "not_ask" }
  | { status: "done"; record: ListenerEffectRecord }
  | { status: "expired"; record: ListenerEffectRecord }
  | { status: "failed"; record: ListenerEffectRecord }
  | {
    status: "retry_pending";
    phase: "prompt" | "post";
    record: ListenerEffectRecord;
  };
