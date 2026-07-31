import {
  ThinCommandClient,
  type SignalRecord,
} from "../cloud/command-client.js";
import type { CloudTarget } from "../cloud/config.js";
import {
  isFollowCredentialFailure,
  isRetryableFollowError,
  nextFollowBackoffMs,
  readAgentSignalPage,
  type AgentSignalPage,
  type SignalCursor,
} from "../cloud/signals.js";
import {
  RenewalReauthorisationRequired,
  RenewalRevoked,
} from "../cloud/renewal.js";
import { ListenerEngine } from "./engine.js";
import type {
  ListenerEffectStore,
  ListenerModel,
  ListenerProcessResult,
  ListenerReplyPoster,
} from "./types.js";

export const LISTENER_PAGE_LIMIT = 100;
export const LISTENER_IDLE_POLL_MS = 2_000;

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
    status: ListenerProcessResult["status"];
    failureCode: string | null;
    ts: string;
  }
  | {
    type: "read_retry";
    attempt: number;
    delayMs: number;
    ts: string;
  }
  | { type: "malformed_row"; index: number; ts: string };

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
}

export type ListenerRuntimeStop =
  | { reason: "cancelled" }
  | { reason: "credential"; error: Error }
  | { reason: "fatal"; error: Error };

function isAbort(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "AbortError" || /aborted|cancelled/i.test(error.message));
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
  const client = new ThinCommandClient(options.target, options.fetcher);
  const poster: ListenerReplyPoster = options.poster ?? {
    post: async ({ signal, body, commandId }) => {
      const credential = await options.credentialSession.bearer();
      const result = await client.sendSignal({
        workspaceId: options.workspaceId,
        credential,
        commandId,
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
  });
  let malformedWarnings = 0;
  const readPage = options.readPage ?? (async (input) =>
    await readAgentSignalPage(
      options.target,
      { kind: "agent", token: input.token },
      {
        workspaceId: options.workspaceId,
        inbox: true,
        kind: "ask",
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
  let readAttempt = 0;
  try {
    while (true) {
      if (abort?.aborted) return { reason: "cancelled" };
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
        readAttempt = 0;
      } catch (error) {
        if (abort?.aborted || isAbort(error)) return { reason: "cancelled" };
        if (
          isFollowCredentialFailure(error) ||
          error instanceof RenewalReauthorisationRequired ||
          error instanceof RenewalRevoked
        ) {
          return { reason: "credential", error: asError(error) };
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
        return { reason: "fatal", error: asError(error) };
      }

      if (!ready) {
        try {
          await options.model.start();
        } catch (error) {
          return { reason: "fatal", error: asError(error) };
        }
        ready = true;
        options.onEvent?.({
          type: "ready",
          workspaceId: options.workspaceId,
          principalId: options.principalId,
          ts: eventTime(now),
        });
      }

      for (const signal of page.signals) {
        if (abort?.aborted) return { reason: "cancelled" };
        let result: ListenerProcessResult;
        try {
          result = await engine.process(signal);
        } catch (error) {
          if (abort?.aborted || isAbort(error)) return { reason: "cancelled" };
          return { reason: "fatal", error: asError(error) };
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

      const fullPage = page.rawCount >= pageLimit;
      if (fullPage) {
        if (page.nextCursor === null) {
          return {
            reason: "fatal",
            error: new Error(
              "the read service returned a full page without a safe cursor",
            ),
          };
        }
        after = page.nextCursor;
        continue;
      }
      // Full scan complete. Reset so late commits with older timestamps appear.
      after = null;
      await sleep(pollMs, abort);
    }
  } finally {
    options.model.cancel();
    await options.model.close().catch(() => undefined);
  }
}
