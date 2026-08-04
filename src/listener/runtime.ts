import { createHash } from "node:crypto";
import {
  CommandHttpError,
  SIGNAL_REQUEST_TIMEOUT_MS,
  ThinCommandClient,
  type SignalRecord,
} from "../cloud/command-client.js";
import type { CloudTarget } from "../cloud/config.js";
import {
  DeliveryCommandClient,
  DeliveryHttpError,
  DeliveryProtocolError,
  DeliveryTransportError,
  DELIVERY_REQUEST_TIMEOUT_MS,
  type DeliveryClaimResult,
  type DeliveryRow,
  type DeliveryOutcome,
} from "../cloud/delivery.js";
import {
  isFollowCredentialFailure,
  isRetryableFollowError,
  nextFollowBackoffMs,
  readAgentSignalPage,
  SIGNAL_READ_TIMEOUT_MS,
  type AgentSignalPage,
  type SignalCursor,
} from "../cloud/signals.js";
import {
  RenewalReauthorisationRequired,
  RenewalRevoked,
} from "../cloud/renewal.js";
import { ACP_DEFAULT_REQUEST_TIMEOUT_MS } from "../host/bounds.js";
import type {
  ListenerDeliveryJournal,
  ListenerDeliveryJournalRecord,
} from "./delivery-journal.js";
import { ListenerEngine, newReceivedAskRecord } from "./engine.js";
import { newObservedNoteRecord } from "./file-store.js";
import type {
  ListenerEffectRecord,
  ListenerEffectStore,
  ListenerModel,
  ListenerProcessResult,
  ListenerReplyPoster,
  ListenerSenderProvenance,
  ListenerSenderProvenanceContext,
} from "./types.js";

export const LISTENER_PAGE_LIMIT = 100;
export const LISTENER_IDLE_POLL_MS = 2_000;
/** Server-fixed maximum delivery lease (§ frozen runtime budgets). */
export const LISTENER_DELIVERY_MAX_LEASE_MS = 900_000;
export const LISTENER_DELIVERY_SAFETY_MARGIN_MS = 30_000;
export const LISTENER_ACK_ONLY_MINIMUM_MS =
  DELIVERY_REQUEST_TIMEOUT_MS + LISTENER_DELIVERY_SAFETY_MARGIN_MS;
export const LISTENER_REPLY_ONLY_MINIMUM_MS =
  SIGNAL_REQUEST_TIMEOUT_MS + LISTENER_ACK_ONLY_MINIMUM_MS;
export const LISTENER_PROMPT_START_MINIMUM_MS =
  SIGNAL_READ_TIMEOUT_MS +
  ACP_DEFAULT_REQUEST_TIMEOUT_MS +
  LISTENER_REPLY_ONLY_MINIMUM_MS;
export const LISTENER_DELIVERY_RETRY_INITIAL_MS = 500;
export const LISTENER_DELIVERY_RETRY_MAX_MS = 30_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ListenerDeliveryMode = "durable_claim" | "cursor_fallback";

export type ListenerDeliveryClient = Pick<
  DeliveryCommandClient,
  "claimAgentInbox" | "ackAgentDelivery"
>;

export type ListenerDeliveryJournalClient = Pick<
  ListenerDeliveryJournal,
  | "read"
  | "reserveClaim"
  | "recordClaimAttempt"
  | "recordLease"
  | "prepareAck"
  | "clearActive"
>;

export class ListenerCapabilityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ListenerCapabilityError";
    this.code = code;
  }
}

export interface ListenerCredentialSession {
  bearer(): Promise<string>;
}

export interface ListenerRuntimeModel extends ListenerModel {
  start(): Promise<void>;
  cancel(): void;
  close(): Promise<void>;
}

export type ListenerRuntimeEvent =
  | { type: "ready"; workspaceId: string; principalId: string; ts: string }
  | {
    type: "effect";
    signalId: string;
    status: ListenerProcessResult["status"] | "observed";
    failureCode: string | null;
    ts: string;
  }
  | {
    type: "read_retry";
    attempt: number;
    delayMs: number;
    ts: string;
  }
  | { type: "malformed_row"; index: number; ts: string }
  | {
    type: "delivery_mode";
    mode: ListenerDeliveryMode;
    pendingDeliveryCount: number | null;
    ts: string;
  }
  | {
    type: "delivery_claim";
    signalId: string | null;
    pendingDeliveryCount: number;
    terminalDeliveryFailureCount: number;
    ts: string;
  }
  | { type: "delivery_terminal_failures"; count: number; ts: string }
  | {
    type: "delivery_ack";
    signalId: string;
    outcome: DeliveryOutcome;
    ts: string;
  };

export interface ListenerRuntimeOptions {
  target: CloudTarget;
  workspaceId: string;
  principalId: string;
  credentialSession: ListenerCredentialSession;
  store: ListenerEffectStore;
  model: ListenerRuntimeModel;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  pageLimit?: number;
  pollMs?: number;
  onEvent?: (event: ListenerRuntimeEvent) => void;
  readPage?: (input: {
    token: string;
    after: SignalCursor | null;
    limit: number;
    signal?: AbortSignal;
    onMalformedRow: (index: number) => void;
  }) => Promise<AgentSignalPage>;
  poster?: ListenerReplyPoster;
  listenerInstanceId?: string;
  deliveryJournal?: ListenerDeliveryJournalClient;
  deliveryClient?: ListenerDeliveryClient;
  resolveSenderProvenance?: (
    signal: SignalRecord,
    context: ListenerSenderProvenanceContext,
  ) => Promise<ListenerSenderProvenance>;
}

export type ListenerRuntimeStop =
  | { reason: "cancelled" }
  | { reason: "credential"; error: Error }
  | { reason: "fatal"; error: Error };

/**
 * Name-only cancellation recognition, plus the explicit caller signal state
 * adjudicated by callers. Arbitrary `aborted`/`cancelled` message substrings
 * are untrusted and must never become cancellation; typed HTTP errors can
 * never be cancellation because of their text.
 */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Closed credential-loss predicate shared by the read and engine catches and
 * injected into the engine seam; runtime exposes no override. Typed HTTP is
 * decided by status alone (401/403), renewal errors by their exact classes,
 * and every other non-HTTP value delegates to the established fleet predicate,
 * so typed HTTP 5xx/409 text can never fall through to wording.
 */
function isCredentialLoss(error: unknown): boolean {
  if (error instanceof CommandHttpError) {
    return error.status === 401 || error.status === 403;
  }
  if (
    error instanceof RenewalReauthorisationRequired ||
    error instanceof RenewalRevoked
  ) {
    return true;
  }
  return isFollowCredentialFailure(error);
}

function isDeliveryCredentialLoss(error: unknown): boolean {
  return isCredentialLoss(error) ||
    (error instanceof DeliveryHttpError &&
      (error.status === 401 || error.status === 403));
}

function isRetryableDeliveryError(error: unknown): boolean {
  return error instanceof DeliveryTransportError ||
    (error instanceof DeliveryHttpError &&
      (error.status === 429 || error.status >= 500));
}

function deliveryRetryDelay(
  attempt: number,
  error: unknown,
  random: () => number,
): number {
  const exponent = Math.min(20, Math.max(0, attempt - 1));
  const ceiling = Math.min(
    LISTENER_DELIVERY_RETRY_MAX_MS,
    LISTENER_DELIVERY_RETRY_INITIAL_MS * (2 ** exponent),
  );
  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * ceiling);
  const retryAfter = error instanceof DeliveryHttpError && error.status === 429
    ? error.retryAfterMs ?? 0
    : 0;
  return Math.max(jitter, retryAfter);
}

function validateClaimResult(result: DeliveryClaimResult): void {
  if (result.deliveries.length > 1) {
    throw new DeliveryProtocolError("delivery claim returned more than one row");
  }
}

function exactRecoveredLease(
  active: NonNullable<ListenerDeliveryJournalRecord["active"]>,
  delivery: DeliveryRow,
): boolean {
  return active.signalId === delivery.signal.id.toLowerCase() &&
    active.leaseId === delivery.leaseId.toLowerCase() &&
    active.leasedUntil === delivery.leasedUntil;
}

function authoritativeSignal(delivery: DeliveryRow): SignalRecord {
  return {
    ...delivery.signal,
    sender_owner_relation: delivery.senderOwnerRelation,
  };
}

function ackForTerminalEffect(
  record: ListenerEffectRecord,
  now: () => number,
): { outcome: DeliveryOutcome; lastErrorCode: "provider_refused" | "local_effect_failed" | "host_session_failed" | null } {
  if (record.state === "done" && record.signalKind === "ask" && record.replySignalId) {
    return { outcome: "replied", lastErrorCode: null };
  }
  if (record.state === "observed" && record.signalKind === "note") {
    return { outcome: "observed", lastErrorCode: null };
  }
  if (
    record.state === "expired" &&
    record.signalKind === "ask" &&
    Date.parse(record.askUntil) <= now()
  ) {
    return { outcome: "expired", lastErrorCode: null };
  }
  if (record.state !== "failed" || record.signalKind !== "ask") {
    throw new Error("listener effect is not a verified terminal delivery effect");
  }
  const code = record.failureCode ?? "";
  if (
    code === "model_refusal" ||
    code === "model_cancelled" ||
    code === "blank_reply"
  ) {
    return { outcome: "failed_terminal", lastErrorCode: "provider_refused" };
  }
  if (/prompt|acp|child|host|session/i.test(code)) {
    return { outcome: "failed_terminal", lastErrorCode: "host_session_failed" };
  }
  if (/post|http_|transport|reply_body/i.test(code)) {
    return { outcome: "failed_terminal", lastErrorCode: "local_effect_failed" };
  }
  return { outcome: "failed_terminal", lastErrorCode: "local_effect_failed" };
}

function isAckableTerminalEffect(
  record: ListenerEffectRecord,
  now: () => number,
): boolean {
  return (record.state === "done" &&
      record.signalKind === "ask" &&
      !!record.replySignalId) ||
    (record.state === "observed" && record.signalKind === "note") ||
    (record.state === "expired" &&
      record.signalKind === "ask" &&
      Date.parse(record.askUntil) <= now()) ||
    (record.state === "failed" && record.signalKind === "ask");
}

function effectPhaseBudget(record: ListenerEffectRecord | null): number {
  if (record === null || record.state === "received" || record.state === "prompting") {
    return LISTENER_PROMPT_START_MINIMUM_MS;
  }
  if (record.state === "reply_ready" || record.state === "posting") {
    return LISTENER_REPLY_ONLY_MINIMUM_MS;
  }
  return LISTENER_ACK_ONLY_MINIMUM_MS;
}

function verifyPreparedAckEffect(
  record: ListenerEffectRecord | null,
  active: NonNullable<ListenerDeliveryJournalRecord["active"]>,
  now: () => number,
): void {
  if (record === null || record.signalId !== active.signalId || active.ack === null) {
    throw new Error("prepared delivery ACK has no matching terminal effect");
  }
  const mapped = ackForTerminalEffect(record, now);
  if (
    mapped.outcome !== active.ack.outcome ||
    mapped.lastErrorCode !== active.ack.lastErrorCode
  ) {
    throw new Error("prepared delivery ACK does not match the terminal effect");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function eventTime(now: () => number): string {
  return new Date(now()).toISOString();
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    signal?.addEventListener("abort", finish, { once: true });
    timer = setTimeout(finish, ms);
  });
}

function requireCapabilities(page: AgentSignalPage): void {
  if (!page.capabilities.senderOwnerRelation) {
    throw new ListenerCapabilityError(
      "sender_relation_capability_missing",
      "the read service does not prove sender ownership; refusing to wake a model",
    );
  }
  if (!page.capabilities.cursorAfter || page.legacyCursorFallback) {
    throw new ListenerCapabilityError(
      "cursor_capability_missing",
      "the read service does not support lossless ascending inbox pages; refusing to wake a model",
    );
  }
}

function classifyDeliveryMode(
  page: AgentSignalPage,
  durableConfigured: boolean,
): ListenerDeliveryMode {
  const { deliveryClaim, deliveryAck } = page.capabilities;
  if (deliveryClaim && !deliveryAck) {
    throw new ListenerCapabilityError(
      "delivery_capability_inconsistent",
      "the read service delivery capability is inconsistent",
    );
  }
  if ((deliveryClaim || deliveryAck) && !durableConfigured) {
    throw new ListenerCapabilityError(
      "delivery_configuration_missing",
      "durable delivery configuration is required by the read service",
    );
  }
  return deliveryClaim && deliveryAck ? "durable_claim" : "cursor_fallback";
}

function sameEffectSignal(
  record: ListenerEffectRecord,
  signal: SignalRecord,
): boolean {
  return record.signalId === signal.id.toLowerCase() &&
    record.signalKind === signal.kind &&
    record.askBody === signal.body &&
    record.askUntil === signal.until &&
    record.senderOwnerRelation === (signal.sender_owner_relation ?? "unknown");
}

/** Bind recovered effects to the immutable fields from the authoritative lease. */
function immutableSignalFingerprint(
  signalId: string,
  signalKind: string,
  body: string,
  until: string,
  senderOwnerRelation: string,
): string {
  return createHash("sha256").update(JSON.stringify([
    signalId,
    signalKind,
    body,
    until,
    senderOwnerRelation,
  ])).digest("hex");
}

function signalFingerprint(signal: SignalRecord): string {
  return immutableSignalFingerprint(
    signal.id.toLowerCase(),
    signal.kind,
    signal.body,
    signal.until,
    signal.sender_owner_relation ?? "unknown",
  );
}

function sameRecoveredEffect(
  active: NonNullable<ListenerDeliveryJournalRecord["active"]>,
  effect: ListenerEffectRecord,
): boolean {
  return typeof active.signalFingerprint === "string" &&
    active.signalFingerprint === immutableSignalFingerprint(
      effect.signalId,
      effect.signalKind,
      effect.askBody,
      effect.askUntil,
      effect.senderOwnerRelation,
    );
}

async function observeFallbackNote(
  store: ListenerEffectStore,
  signal: SignalRecord,
  now: () => number,
): Promise<ListenerEffectRecord> {
  const existing = await store.read(signal.id);
  if (existing !== null) {
    if (!sameEffectSignal(existing, signal) || existing.state !== "observed") {
      throw new Error("stored listener effect does not match the direct note");
    }
    return existing;
  }
  const observed = newObservedNoteRecord({
    signalId: signal.id,
    body: signal.body,
    until: signal.until,
    senderOwnerRelation: signal.sender_owner_relation ?? "unknown",
    updatedAt: eventTime(now),
  });
  await store.write(observed);
  const persisted = await store.read(signal.id);
  if (
    persisted === null ||
    !sameEffectSignal(persisted, signal) ||
    persisted.state !== "observed"
  ) {
    throw new Error("stored listener note effect could not be verified");
  }
  return persisted;
}

async function readOrReplaceUnreadableEffect(
  store: ListenerEffectStore,
  signal: SignalRecord,
  now: () => number,
): Promise<ListenerEffectRecord | null> {
  try {
    return await store.read(signal.id);
  } catch {
    // Retry before replacement so one transient read does not discard a valid
    // effect. The signal came from the authoritative read/claim response.
  }
  try {
    return await store.read(signal.id);
  } catch {
    const replacement = signal.kind === "note"
      ? newObservedNoteRecord({
        signalId: signal.id,
        body: signal.body,
        until: signal.until,
        senderOwnerRelation: signal.sender_owner_relation ?? "unknown",
        updatedAt: eventTime(now),
      })
      : {
        ...newReceivedAskRecord(signal, now()),
        state: "failed" as const,
        failureCode: "local_effect_corrupt",
      };
    // A corrupt ask may have posted already, but its exact reply body/receipt
    // is no longer knowable. Terminalize the local-effect failure instead of
    // prompting a different reply under the same idempotency command id.
    await store.write(replacement);
    const repaired = await store.read(signal.id);
    if (repaired === null || !sameEffectSignal(repaired, signal)) {
      throw new Error("unreadable listener effect could not be replaced");
    }
    return repaired;
  }
}

async function closeBeforeStart(
  model: ListenerRuntimeModel,
  error: Error,
): Promise<ListenerRuntimeStop> {
  model.cancel();
  try {
    await model.close();
  } catch (closeError) {
    return { reason: "fatal", error: asError(closeError) };
  }
  return { reason: "fatal", error };
}

/**
 * Durable listener loop. The first authenticated capability-bearing read and
 * provider canary both succeed before `ready` is emitted.
 */
export async function runListenerRuntime(
  options: ListenerRuntimeOptions,
): Promise<ListenerRuntimeStop> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const pageLimit = options.pageLimit ?? LISTENER_PAGE_LIMIT;
  const pollMs = options.pollMs ?? LISTENER_IDLE_POLL_MS;
  const abort = options.signal;
  const hasInstanceId = options.listenerInstanceId !== undefined;
  const hasJournal = options.deliveryJournal !== undefined;
  if (hasInstanceId !== hasJournal) {
    return await closeBeforeStart(
      options.model,
      new Error("listener instance id and delivery journal must be configured together"),
    );
  }
  if (hasInstanceId && !UUID_RE.test(options.listenerInstanceId!)) {
    return await closeBeforeStart(
      options.model,
      new Error("listener instance id must be a UUID"),
    );
  }
  if (options.deliveryClient !== undefined && !hasInstanceId) {
    return await closeBeforeStart(
      options.model,
      new Error("an injected delivery client requires durable delivery configuration"),
    );
  }
  let initialJournal: ListenerDeliveryJournalRecord | null = null;
  if (hasJournal) {
    try {
      initialJournal = await options.deliveryJournal!.read();
      if (
        initialJournal.workspaceId !== options.workspaceId.toLowerCase() ||
        initialJournal.principalId !== options.principalId.toLowerCase() ||
        initialJournal.listenerInstanceId !== options.listenerInstanceId!.toLowerCase()
      ) {
        throw new Error("delivery journal identity does not match the listener");
      }
    } catch (error) {
      return await closeBeforeStart(options.model, asError(error));
    }
  }
  const durableConfigured = initialJournal !== null;
  const deliveryClient = durableConfigured
    ? options.deliveryClient ?? new DeliveryCommandClient(options.target, options.fetcher)
    : null;
  let journalSnapshot = initialJournal;
  const warnedClaimCommands = new Set<string>();
  const client = new ThinCommandClient(options.target, options.fetcher);
  const poster: ListenerReplyPoster = options.poster ?? {
    post: async ({ signal, body, commandId, abortSignal }) => {
      const credential = await options.credentialSession.bearer();
      const result = await client.sendSignal({
        workspaceId: options.workspaceId,
        credential,
        commandId,
        // The engine-provided caller signal becomes the transport's caller
        // signal; no second signal is constructed and the command envelope is
        // unchanged.
        ...(abortSignal === undefined ? {} : { signal: abortSignal }),
        command: {
          kind: "post_signal",
          signal_kind: "note",
          body,
          to_user_id: null,
          to_agent_principal_id: null,
          in_reply_to: signal.id,
          about: null,
        },
      });
      return { signalId: result.response.signal!.id };
    },
  };
  const engine = new ListenerEngine({
    store: options.store,
    model: options.model,
    poster,
    now,
    // The runtime caller signal is cancellation only; the closed credential
    // predicate is wired into the engine seam so credential loss during reply
    // posting stops as credential instead of terminalizing the effect.
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.resolveSenderProvenance === undefined
      ? {}
      : { resolveSenderProvenance: options.resolveSenderProvenance }),
    isCredentialFailure: isCredentialLoss,
  });
  let malformedWarnings = 0;
  const readPage = options.readPage ?? (async (input) =>
    await readAgentSignalPage(
      options.target,
      { kind: "agent", token: input.token },
      {
        workspaceId: options.workspaceId,
        inbox: true,
        ascending: true,
        limit: input.limit,
        ...(input.after === null ? {} : { after: input.after }),
        includeStale: false,
      },
      {
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      },
      {
        tolerateMalformedRows: true,
        maxMalformedRows: 3,
        onMalformedRow: input.onMalformedRow,
      },
    ));

  let after: SignalCursor | null = null;
  let ready = false;
  let deliveryMode: ListenerDeliveryMode | null = null;
  let readAttempt = 0;
  // Cancel in-flight host turns immediately on abort — do not wait for finally.
  // A hung engine.process must see cancel while still pending, not only after it returns.
  const onAbort = () => {
    options.model.cancel();
  };
  if (abort) {
    if (abort.aborted) {
      options.model.cancel();
      // Do not swallow close failures (e.g. child_exit_timeout): escalate.
      await options.model.close();
      return { reason: "cancelled" };
    }
    abort.addEventListener("abort", onAbort);
  }
  let stop: ListenerRuntimeStop | undefined;

  const sendPreparedAck = async (
    active: NonNullable<ListenerDeliveryJournalRecord["active"]>,
  ): Promise<ListenerRuntimeStop | null> => {
    if (
      active.phase !== "ack_pending" ||
      active.signalId === null ||
      active.leaseId === null ||
      active.leasedUntil === null ||
      active.ack === null
    ) {
      return {
        reason: "fatal",
        error: new Error("delivery journal ACK state is incomplete"),
      };
    }
    try {
      const terminal = await options.store.read(active.signalId);
      verifyPreparedAckEffect(terminal, active, now);
    } catch (error) {
      return { reason: "fatal", error: asError(error) };
    }
    let attempt = 0;
    while (true) {
      try {
        const credential = await options.credentialSession.bearer();
        await deliveryClient!.ackAgentDelivery({
          workspaceId: options.workspaceId,
          credential,
          commandId: active.ack.commandId,
          signalId: active.signalId,
          leaseId: active.leaseId,
          listenerInstanceId: options.listenerInstanceId!,
          outcome: active.ack.outcome,
          lastErrorCode: active.ack.lastErrorCode,
        });
        await options.deliveryJournal!.clearActive(eventTime(now));
        after = null;
        options.onEvent?.({
          type: "delivery_ack",
          signalId: active.signalId,
          outcome: active.ack.outcome,
          ts: eventTime(now),
        });
        return null;
      } catch (error) {
        const staleUnavailable = now() >= Date.parse(active.leasedUntil) &&
          error instanceof DeliveryHttpError &&
          error.status === 403 &&
          error.code === "delivery_unavailable";
        if (staleUnavailable) {
          try {
            await options.deliveryJournal!.clearActive(eventTime(now));
            after = null;
            return null;
          } catch (clearError) {
            return { reason: "fatal", error: asError(clearError) };
          }
        }
        if (abort?.aborted) return { reason: "cancelled" };
        if (isDeliveryCredentialLoss(error)) {
          return { reason: "credential", error: asError(error) };
        }
        if (!isRetryableDeliveryError(error)) {
          return { reason: "fatal", error: asError(error) };
        }
        attempt += 1;
        await sleep(deliveryRetryDelay(attempt, error, random), abort);
        if (abort?.aborted) return { reason: "cancelled" };
      }
    }
  };
  try {
    while (true) {
      if (abort?.aborted) {
        stop = { reason: "cancelled" };
        break;
      }
      let page: AgentSignalPage;
      try {
        const token = await options.credentialSession.bearer();
        page = await readPage({
          token,
          after,
          limit: pageLimit,
          ...(abort ? { signal: abort } : {}),
          onMalformedRow: (index) => {
            if (malformedWarnings >= 3) return;
            malformedWarnings += 1;
            options.onEvent?.({
              type: "malformed_row",
              index,
              ts: eventTime(now),
            });
          },
        });
        requireCapabilities(page);
        const nextMode = classifyDeliveryMode(page, durableConfigured);
        if (nextMode !== deliveryMode) {
          deliveryMode = nextMode;
          options.onEvent?.({
            type: "delivery_mode",
            mode: nextMode,
            pendingDeliveryCount: nextMode === "durable_claim"
              ? page.pendingDeliveryCount
              : null,
            ts: eventTime(now),
          });
        }
        readAttempt = 0;
      } catch (error) {
        // Exact caller abort state is authoritative, then the closed credential
        // predicate, then name-only AbortError. This preserves an explicit
        // caller abort that already won while preventing hostile error message
        // text from impersonating cancellation.
        if (abort?.aborted) {
          stop = { reason: "cancelled" };
          break;
        }
        if (isCredentialLoss(error)) {
          stop = { reason: "credential", error: asError(error) };
          break;
        }
        if (isAbort(error)) {
          stop = { reason: "cancelled" };
          break;
        }
        if (isRetryableFollowError(error)) {
          readAttempt += 1;
          const delayMs = nextFollowBackoffMs(readAttempt, null, random);
          if (ready) {
            options.onEvent?.({
              type: "read_retry",
              attempt: readAttempt,
              delayMs,
              ts: eventTime(now),
            });
          }
          await sleep(delayMs, abort);
          continue;
        }
        stop = { reason: "fatal", error: asError(error) };
        break;
      }

      if (!ready) {
        try {
          await options.model.start();
        } catch (error) {
          stop = { reason: "fatal", error: asError(error) };
          break;
        }
        ready = true;
        options.onEvent?.({
          type: "ready",
          workspaceId: options.workspaceId,
          principalId: options.principalId,
          ts: eventTime(now),
        });
      }

      let currentJournalRecord: ListenerDeliveryJournalRecord | null = null;
      if (durableConfigured) {
        try {
          currentJournalRecord = journalSnapshot ??
            await options.deliveryJournal!.read();
          journalSnapshot = null;
        } catch (error) {
          stop = { reason: "fatal", error: asError(error) };
          break;
        }
      }

      const recovery = currentJournalRecord?.active ?? null;
      if (recovery?.phase === "ack_pending") {
        const horizon = Date.parse(recovery.leasedUntil!) +
          LISTENER_DELIVERY_SAFETY_MARGIN_MS;
        if (page.capabilities.deliveryAck && now() < horizon) {
          const ackStop = await sendPreparedAck(recovery);
          if (ackStop !== null) {
            stop = ackStop;
            break;
          }
          if (abort?.aborted) {
            stop = { reason: "cancelled" };
            break;
          }
          await sleep(pollMs, abort);
          continue;
        }
        await sleep(Math.max(0, horizon - now()), abort);
        if (abort?.aborted) {
          stop = { reason: "cancelled" };
          break;
        }
        if (now() >= horizon) {
          try {
            await options.deliveryJournal!.clearActive(eventTime(now));
            after = null;
          } catch (error) {
            stop = { reason: "fatal", error: asError(error) };
            break;
          }
        }
        continue;
      }

      if (recovery?.phase === "leased") {
        if (page.capabilities.deliveryAck) {
          let terminal: ListenerEffectRecord | null = null;
          if (recovery.signalId !== null) {
            try {
              terminal = await options.store.read(recovery.signalId);
            } catch {
              // An unreadable effect cannot safely be ACKed. Treat it exactly
              // like a missing effect so stale-lease clearing remains reachable.
              terminal = null;
            }
          }
          if (
            terminal !== null &&
            sameRecoveredEffect(recovery, terminal) &&
            isAckableTerminalEffect(terminal, now)
          ) {
            try {
              const mapped = ackForTerminalEffect(terminal, now);
              await options.deliveryJournal!.prepareAck({
                outcome: mapped.outcome,
                lastErrorCode: mapped.lastErrorCode,
                preparedAt: eventTime(now),
                now: eventTime(now),
              });
              const prepared = await options.deliveryJournal!.read();
              const ackStop = await sendPreparedAck(prepared.active!);
              if (ackStop !== null) {
                stop = ackStop;
                break;
              }
              continue;
            } catch (error) {
              stop = { reason: "fatal", error: asError(error) };
              break;
            }
          }
        }
        const leasedUntilMs = Date.parse(recovery.leasedUntil!);
        if (deliveryMode !== "durable_claim" || now() >= leasedUntilMs) {
          const horizon = leasedUntilMs + LISTENER_DELIVERY_SAFETY_MARGIN_MS;
          await sleep(Math.max(0, horizon - now()), abort);
          if (abort?.aborted) {
            stop = { reason: "cancelled" };
            break;
          }
          if (now() >= horizon) {
            try {
              await options.deliveryJournal!.clearActive(eventTime(now));
              after = null;
            } catch (error) {
              stop = { reason: "fatal", error: asError(error) };
              break;
            }
          }
          continue;
        }
        // A still-live durable lease falls through to exact command replay.
      }

      if (recovery?.phase === "claim_pending") {
        const horizon = recovery.claimLastAttemptAt === null
          ? now()
          : Date.parse(recovery.claimLastAttemptAt) +
            LISTENER_DELIVERY_MAX_LEASE_MS + LISTENER_DELIVERY_SAFETY_MARGIN_MS;
        if (deliveryMode !== "durable_claim" || now() >= horizon) {
          await sleep(Math.max(0, horizon - now()), abort);
          if (abort?.aborted) {
            stop = { reason: "cancelled" };
            break;
          }
          if (now() >= horizon) {
            try {
              await options.deliveryJournal!.clearActive(eventTime(now));
              after = null;
            } catch (error) {
              stop = { reason: "fatal", error: asError(error) };
              break;
            }
          }
          continue;
        }
        // A recent durable attempt falls through to exact command replay.
      }

      if (deliveryMode === "durable_claim") {
        if (abort?.aborted) {
          stop = { reason: "cancelled" };
          break;
        }
        const journal = options.deliveryJournal!;
        const record = currentJournalRecord!;
        let active = record.active;
        if (active === null) {
          try {
            active = await journal.reserveClaim(eventTime(now));
          } catch (error) {
            stop = { reason: "fatal", error: asError(error) };
            break;
          }
        }

        let result: DeliveryClaimResult | null = null;
        let deliveryAttempt = 0;
        while (result === null && !stop) {
          try {
            await journal.recordClaimAttempt(eventTime(now));
            const credential = await options.credentialSession.bearer();
            result = await deliveryClient!.claimAgentInbox({
              workspaceId: options.workspaceId,
              credential,
              commandId: active.claimCommandId,
              listenerInstanceId: options.listenerInstanceId!,
              expectedPrincipalId: options.principalId,
            });
            validateClaimResult(result);
          } catch (error) {
            if (abort?.aborted) {
              stop = { reason: "cancelled" };
              break;
            }
            if (isDeliveryCredentialLoss(error)) {
              stop = { reason: "credential", error: asError(error) };
              break;
            }
            if (!isRetryableDeliveryError(error)) {
              stop = { reason: "fatal", error: asError(error) };
              break;
            }
            deliveryAttempt += 1;
            const delayMs = deliveryRetryDelay(deliveryAttempt, error, random);
            await sleep(delayMs, abort);
            if (abort?.aborted) {
              stop = { reason: "cancelled" };
              break;
            }
          }
        }
        if (stop) break;
        if (result === null) {
          stop = { reason: "fatal", error: new Error("delivery claim did not settle") };
          break;
        }
        const claimed = result.deliveries[0] ?? null;
        options.onEvent?.({
          type: "delivery_claim",
          signalId: claimed?.signal.id ?? null,
          pendingDeliveryCount: result.pendingDeliveryCount,
          terminalDeliveryFailureCount: result.terminalDeliveryFailureCount,
          ts: eventTime(now),
        });
        if (
          result.terminalDeliveryFailureCount > 0 &&
          !warnedClaimCommands.has(active.claimCommandId)
        ) {
          warnedClaimCommands.add(active.claimCommandId);
          options.onEvent?.({
            type: "delivery_terminal_failures",
            count: result.terminalDeliveryFailureCount,
            ts: eventTime(now),
          });
        }
        if (claimed === null) {
          if (active.phase === "leased") {
            stop = {
              reason: "fatal",
              error: new Error("delivery claim replay did not return the stored lease"),
            };
            break;
          }
          try {
            await journal.clearActive(eventTime(now));
          } catch (error) {
            stop = { reason: "fatal", error: asError(error) };
            break;
          }
          await sleep(pollMs, abort);
          continue;
        }

        const leasedUntilMs = Date.parse(claimed.leasedUntil);
        if (
          !Number.isFinite(leasedUntilMs) ||
          leasedUntilMs > now() + LISTENER_DELIVERY_MAX_LEASE_MS
        ) {
          stop = { reason: "fatal", error: new Error("delivery lease deadline is invalid") };
          break;
        }
        if (active.phase === "leased") {
          if (!exactRecoveredLease(active, claimed)) {
            stop = {
              reason: "fatal",
              error: new Error("delivery claim replay does not match the stored lease"),
            };
            break;
          }
        } else {
          try {
            await journal.recordLease({
              signalId: claimed.signal.id,
              leaseId: claimed.leaseId,
              leasedUntil: claimed.leasedUntil,
              signalFingerprint: signalFingerprint(authoritativeSignal(claimed)),
              now: eventTime(now),
            });
          } catch (error) {
            stop = { reason: "fatal", error: asError(error) };
            break;
          }
        }
        if (abort?.aborted) {
          stop = { reason: "cancelled" };
          break;
        }
        const signal = authoritativeSignal(claimed);
        let terminal: ListenerEffectRecord | null = null;
        try {
          const existing = await readOrReplaceUnreadableEffect(
            options.store,
            signal,
            now,
          );
          if (existing !== null && !sameEffectSignal(existing, signal)) {
            throw new Error("stored listener effect does not match the authoritative delivery");
          }
          if (signal.kind === "note") {
            if (existing === null) {
              await options.store.write(newObservedNoteRecord({
                signalId: signal.id,
                body: signal.body,
                until: signal.until,
                senderOwnerRelation: signal.sender_owner_relation ?? "unknown",
                updatedAt: eventTime(now),
              }));
            }
            terminal = await options.store.read(signal.id);
            if (
              terminal === null ||
              !sameEffectSignal(terminal, signal) ||
              terminal.state !== "observed"
            ) {
              throw new Error("persisted note effect does not match the authoritative delivery");
            }
            options.onEvent?.({
              type: "effect",
              signalId: signal.id,
              status: "observed",
              failureCode: null,
              ts: eventTime(now),
            });
          } else if (signal.kind === "ask") {
            let processAttempt = 0;
            while (terminal === null) {
              const before = await options.store.read(signal.id);
              if (before !== null && !sameEffectSignal(before, signal)) {
                throw new Error("stored listener effect does not match the authoritative delivery");
              }
              const requiredBudget = effectPhaseBudget(before);
              if (leasedUntilMs <= now() + requiredBudget) {
                await sleep(
                  Math.max(
                    0,
                    leasedUntilMs + LISTENER_DELIVERY_SAFETY_MARGIN_MS - now(),
                  ),
                  abort,
                );
                if (abort?.aborted) {
                  stop = { reason: "cancelled" };
                  break;
                }
                if (now() >= leasedUntilMs + LISTENER_DELIVERY_SAFETY_MARGIN_MS) {
                  await journal.clearActive(eventTime(now));
                  after = null;
                }
                break;
              }
              const processed = await engine.process(signal);
              const effect = "record" in processed ? processed.record : null;
              options.onEvent?.({
                type: "effect",
                signalId: signal.id,
                status: processed.status,
                failureCode: effect?.failureCode ?? null,
                ts: eventTime(now),
              });
              if (processed.status === "ignored") {
                throw new Error("claimed delivery was ignored by the listener engine");
              }
              if (processed.status === "retry_pending") {
                processAttempt += 1;
                await sleep(
                  deliveryRetryDelay(processAttempt, null, random),
                  abort,
                );
                if (abort?.aborted) {
                  stop = { reason: "cancelled" };
                  break;
                }
                continue;
              }
              terminal = processed.record;
            }
          } else {
            throw new Error("claimed delivery has an unsupported signal kind");
          }
        } catch (error) {
          if (abort?.aborted) {
            stop = { reason: "cancelled" };
          } else if (isCredentialLoss(error)) {
            stop = { reason: "credential", error: asError(error) };
          } else if (isAbort(error)) {
            stop = { reason: "cancelled" };
          } else {
            stop = { reason: "fatal", error: asError(error) };
          }
          break;
        }
        if (stop) break;
        if (terminal === null) continue;

        try {
          // Load-bearing order: terminal effect persistence and exact reread
          // precede prepareAck; prepareAck persistence precedes network ACK.
          const persisted = await options.store.read(signal.id);
          if (persisted === null || !sameEffectSignal(persisted, signal)) {
            throw new Error("terminal listener effect does not match the delivery");
          }
          const mapped = ackForTerminalEffect(persisted, now);
          await journal.prepareAck({
            outcome: mapped.outcome,
            lastErrorCode: mapped.lastErrorCode,
            preparedAt: eventTime(now),
            now: eventTime(now),
          });
          const prepared = await journal.read();
          const ackStop = await sendPreparedAck(prepared.active!);
          if (ackStop !== null) {
            stop = ackStop;
            break;
          }
        } catch (error) {
          stop = { reason: "fatal", error: asError(error) };
          break;
        }
        if (abort?.aborted) {
          stop = { reason: "cancelled" };
          break;
        }
        continue;
      }

      for (const signal of page.signals) {
        if (abort?.aborted) {
          stop = { reason: "cancelled" };
          break;
        }
        if (signal.kind === "note") {
          try {
            await readOrReplaceUnreadableEffect(options.store, signal, now);
            const record = await observeFallbackNote(options.store, signal, now);
            options.onEvent?.({
              type: "effect",
              signalId: signal.id,
              status: "observed",
              failureCode: record.failureCode,
              ts: eventTime(now),
            });
          } catch (error) {
            stop = { reason: "fatal", error: asError(error) };
            break;
          }
          continue;
        }
        if (signal.kind !== "ask") continue;
        let result: ListenerProcessResult;
        try {
          await readOrReplaceUnreadableEffect(options.store, signal, now);
          result = await engine.process(signal);
        } catch (error) {
          if (abort?.aborted) {
            stop = { reason: "cancelled" };
            break;
          }
          if (isCredentialLoss(error)) {
            stop = { reason: "credential", error: asError(error) };
            break;
          }
          if (isAbort(error)) {
            stop = { reason: "cancelled" };
            break;
          }
          stop = { reason: "fatal", error: asError(error) };
          break;
        }
        const record = "record" in result ? result.record : null;
        options.onEvent?.({
          type: "effect",
          signalId: signal.id,
          status: result.status,
          failureCode: record?.failureCode ?? null,
          ts: eventTime(now),
        });
      }
      if (stop) break;

      const fullPage = page.rawCount >= pageLimit;
      if (fullPage) {
        if (page.nextCursor === null) {
          stop = {
            reason: "fatal",
            error: new Error(
              "the read service returned a full page without a safe cursor",
            ),
          };
          break;
        }
        after = page.nextCursor;
        continue;
      }
      // Full scan complete. Reset so late commits with older timestamps appear.
      after = null;
      await sleep(pollMs, abort);
    }
  } finally {
    abort?.removeEventListener("abort", onAbort);
    options.model.cancel();
    // Never swallow close failures — child_exit_timeout must reach supervisor.
    try {
      await options.model.close();
    } catch (error) {
      stop = { reason: "fatal", error: asError(error) };
    }
  }
  return stop ?? { reason: "cancelled" };
}
