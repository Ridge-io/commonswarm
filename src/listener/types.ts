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
  | "observed"
  | "routed_main";

/**
 * Schema version 2: the v1 ask file plus a closed `signalKind` discriminator.
 *
 * Version 1 files stay readable and upcast in memory to signalKind "ask"
 * without a re-write. `observed` is terminal for worker-observed notes;
 * `routed_main` is terminal for asks or notes durably handed to the operator
 * session. Both carry zero
 * prompt/post attempts, no reply body or reply signal, and an empty
 * `commandId` because neither has a reply command. The
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
 * the worker dies mid-turn — the timeout is not the only safety net — AND
 * because each turn is clamped to the live credential's remaining lifetime
 * (clampTurnBudgetToCredential in cli.ts): renewal runs only between turns,
 * so an unclamped long turn could outlive its credential and stop the
 * listener as credential loss.
 * Override per-listener with `cswarm listen start --turn-budget`.
 */
export const LISTENER_PROMPT_TIMEOUT_MS = 600_000;

/**
 * A worker turn was deferred, not attempted: the live credential could not be
 * renewed, or its remaining lifetime is already inside the rotation margin, so
 * no budget could be proven to outlast the turn.
 *
 * ★ The invariant this enforces: a turn starts ONLY with a credential proven to
 * outlast it. Renewal runs between turns (in bearer()), never during a prompt,
 * so a turn begun on a nearly-dead credential would end in credential loss —
 * exactly what the raised prompt budget must not cause.
 *
 * Deferral is recoverable across TRANSIENT renewal failures: the durable
 * claim/ack layer redelivers the ask, and the retry begins after rotation has
 * recovered. It is NOT retried forever — after bounded prompt attempts exhaust
 * (LISTENER_MAX_PROMPT_ATTEMPTS in engine.ts) a truly-unrenewable ask goes
 * TERMINAL (failed + acked), which is correct: an ask that can never obtain a
 * live credential must stop, not loop. The terminal record carries this code —
 * the honest `renewal_unavailable`, recorded via engine failureCode() from
 * `.name` — never acptimeouterror and never a doomed 1s turn.
 */
export class ListenerRenewalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "renewal_unavailable";
  }
}

/**
 * The SINGLE gate every worker turn passes: resolve-or-defer the budget for the
 * credential live RIGHT NOW, then prompt.
 *
 * Kept as one function every model calls so no start-a-turn path can prompt
 * without first resolving/deferring. Its callers run it AFTER ensureWorker (the
 * respawn), so the budget reflects the credential at the moment the turn
 * actually starts — a slow respawn after a worker death cannot leave a stale
 * budget that outlives a now-dead credential. A deferral (the resolver throwing
 * ListenerRenewalUnavailableError) throws HERE, before session.prompt, so no
 * turn begins on a credential that cannot outlast it.
 */
export async function resolveBudgetAndPrompt<T>(
  session: { prompt(text: string, options: { timeoutMs: number }): Promise<T> },
  prompt: string,
  budget: number | (() => Promise<number>),
): Promise<T> {
  const timeoutMs = typeof budget === "number" ? budget : await budget();
  return await session.prompt(prompt, { timeoutMs });
}

/**
 * Why a delivery gave the worker seat back before it reached a terminal effect.
 * `hold_budget`: the per-delivery seat bound is spent. `lease_budget`: what is
 * left of the server lease no longer covers the next phase.
 *
 * Exported as the set so the status validator, the listener log and any message
 * that names these read the same constant instead of a typed copy.
 */
export const LISTENER_DELIVERY_HOLD_RELEASE_REASONS = [
  "hold_budget",
  "lease_budget",
] as const;

export type ListenerDeliveryHoldReleaseReason =
  typeof LISTENER_DELIVERY_HOLD_RELEASE_REASONS[number];

/**
 * The clause each release reason contributes to the operator's status line.
 *
 * A Record keyed by the union, so a new reason is a TYPE ERROR until it has a
 * clause. The first version of this line said "used its turn budget" for every
 * release; a `lease_budget` release runs no turn at all, so the sentence was
 * false for half the vocabulary. A review arm found that, which is what a typed
 * list inside a correct-looking sentence always costs.
 */
export const LISTENER_DELIVERY_HOLD_RELEASE_CLAUSES: Readonly<
  Record<ListenerDeliveryHoldReleaseReason, string>
> = {
  hold_budget: "it used the turn budget for one delivery",
  lease_budget: "what was left of its lease could not cover the next step",
};

/**
 * What the reader should do about each reason. A Record for the same reason as
 * the clauses: one shared remedy was measured wrong for half the vocabulary.
 *
 * Only `hold_budget` names a setting. `--turn-budget` IS the seat bound, so
 * raising it is the whole answer there. `lease_budget` needs nothing raised: the
 * server lease is a fixed 15 minutes and is not an operator flag, and the row
 * comes back under a NEW lease with its full length, so the next attempt starts
 * with the room this one ran out of.
 *
 * Correction to a claim made while reviewing this, recorded because a later
 * reader may meet it: raising `--turn-budget` does NOT raise the projected
 * phase minimum that `leaseSpent` tests. `effectPhaseBudget` returns
 * `LISTENER_PROMPT_START_MINIMUM_MS` and its siblings, built from
 * `SIGNAL_READ_TIMEOUT_MS`, `ACP_DEFAULT_REQUEST_TIMEOUT_MS`,
 * `SIGNAL_REQUEST_TIMEOUT_MS`, `DELIVERY_REQUEST_TIMEOUT_MS` and the safety
 * margin. It contains no turn budget. What a larger turn budget does change is
 * how much of the fixed lease one turn can consume before that check runs.
 */
export const LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES: Readonly<
  Record<ListenerDeliveryHoldReleaseReason, string>
> = {
  hold_budget:
    "a larger --turn-budget gives one delivery more of the seat, and the bound" +
    " is read when the listener starts, so stop this listener and start it" +
    " again to change it",
  lease_budget:
    "nothing needs changing: the row comes back under a new lease with its full" +
    " length, so the next attempt starts with the room this one ran out of",
};

export type ListenerPermissionMode = "deny" | "allow";

export type ListenerPromptMode = "worker";

export interface ListenerCanaryVerdict {
  passed: boolean;
  reason?: string;
}

/** Reports each bounded permission-canary attempt to local listener diagnostics. */
export type ListenerCanaryAttemptCallback = (
  attempt: number,
  total: number,
  result: ListenerCanaryVerdict,
) => void;

export interface ListenerSenderProvenance {
  senderName: string | null;
  operatorId: string | null;
  operatorName: string | null;
  /** Local changed-only context; never persisted in an effect or server payload. */
  brainDigest?: string;
  /** Broadcast rows included in this worker prompt. */
  feedDigest?: string;
  /** Exact broadcast ids represented by feedDigest. */
  renderedBroadcastIds?: string[];
}

export interface ListenerSenderProvenanceContext {
  signal?: AbortSignal;
  deadlineMs: number;
  /** True only for a worker prompt, never for main-route queue labeling. */
  includeBrainDigest?: boolean;
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
