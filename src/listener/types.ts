import type {
  SenderOwnerRelation,
  SignalRecord,
} from "../cloud/command-client.js";

export type ListenerEffectState =
  | "received"
  | "prompting"
  | "reply_ready"
  | "posting"
  | "done"
  | "expired"
  | "failed";

export interface ListenerEffectRecord {
  version: 1;
  signalId: string;
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

export type ListenerPromptMode = "worker" | "isolated";

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

