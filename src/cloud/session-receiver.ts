/**
 * Interactive managed receiver. This module must never import an ACP model
 * or provider factory, and must never spawn a host child. It claims, surfaces
 * into the registered host conversation, and ACKs only after injection with
 * current proof.
 */
import type { CloudTarget } from "./config.js";
import {
  DeliveryCommandClient,
  type DeliveryRow,
} from "./delivery.js";
import { newCommandId } from "./command-client.js";
import {
  AGENT_SESSION_RENEW_AFTER_MS,
  type SessionReceiveState,
} from "./session-contract.js";
import { AgentSessionClient } from "./session-client.js";
import { AgentSessionManager } from "./session-manager.js";
import {
  assertManagedAckAllowed,
  canAckManagedDelivery,
  managedAckInput,
  type ManagedAckInput,
} from "./session-ack.js";
import {
  sessionProofOf,
  writeSessionContext,
  type SessionContextDocument,
} from "./session-context.js";
import { bindSessionProof } from "./session-proof.js";

export interface SurfacedAsk {
  signalId: string;
  kind: string;
  body: string;
  hostSessionId: string;
}

export interface HostInjectionCallback {
  inject(ask: SurfacedAsk): Promise<{ ok: true } | { ok: false; code: string }>;
}

let registeredHostInjection: HostInjectionCallback | null = null;

/** Hosts register a callback; the CLI never manufactures one. */
export function registerHostInjection(
  callback: HostInjectionCallback | null,
): void {
  registeredHostInjection = callback;
}

export function currentHostInjection(): HostInjectionCallback | null {
  return registeredHostInjection;
}

export interface InteractiveClaimClient {
  claim(): Promise<DeliveryRow[]>;
  ack(row: DeliveryRow, managedAck: ManagedAckInput): Promise<void>;
}

export interface InteractiveReceiverOptions {
  target: CloudTarget;
  credential: string;
  contextPath: string;
  context: SessionContextDocument;
  manager: AgentSessionManager;
  hostInjection?: HostInjectionCallback | null;
  hostIdentityTrusted?: boolean;
  observedHostSessionId?: string | null;
  claimClient?: InteractiveClaimClient;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export interface InteractiveReceiverStatus {
  mode: "interactive";
  session_id: string;
  generation: number;
  provider: SessionContextDocument["provider"];
  host_session_id: string;
  enforcement: SessionContextDocument["enforcement"];
  receive_verification: SessionReceiveState;
  dispatch: "running" | "stopped";
  surfaced: number;
  acked: number;
  buffered: number;
}

function sleepMs(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("interactive receiver aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("interactive receiver aborted");
      error.name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultClaimClient(
  options: InteractiveReceiverOptions,
): InteractiveClaimClient {
  const proof = sessionProofOf(options.context);
  const fetcher = bindSessionProof(options.fetcher ?? fetch, proof);
  const client = new DeliveryCommandClient(options.target, fetcher);
  return {
    async claim(): Promise<DeliveryRow[]> {
      const result = await client.claimAgentInbox({
        workspaceId: options.context.workspace_id,
        credential: options.credential,
        commandId: newCommandId(),
        listenerInstanceId: options.context.session_id,
        expectedPrincipalId: options.context.principal_id,
      });
      return result.deliveries;
    },
    async ack(row: DeliveryRow, managedAck: ManagedAckInput): Promise<void> {
      await client.ackAgentDelivery({
        workspaceId: options.context.workspace_id,
        credential: options.credential,
        commandId: newCommandId(),
        signalId: row.signal.id,
        leaseId: row.leaseId,
        listenerInstanceId: options.context.session_id,
        outcome: "observed",
        lastErrorCode: null,
        managedAck,
      });
    },
  };
}

/**
 * One interactive pass: claim, try host injection, ACK only when the gate
 * passes. Never constructs a model. Duplicate signal ids do not ACK twice.
 */
export async function runInteractiveReceiveOnce(
  options: InteractiveReceiverOptions,
  seen: Set<string>,
): Promise<{
  surfaced: number;
  acked: number;
  buffered: number;
  receive: SessionReceiveState;
}> {
  if (options.manager.dispatchState() !== "running") {
    return { surfaced: 0, acked: 0, buffered: 0, receive: "manual" };
  }
  const injection = options.hostInjection ?? null;
  const trusted = options.hostIdentityTrusted === true;
  const observedHost = options.observedHostSessionId ??
    (trusted ? options.context.host_session_id : null);
  const receive: SessionReceiveState = injection === null
    ? "manual"
    : trusted
    ? "callback"
    : "unverified";
  const claims = options.claimClient ?? defaultClaimClient(options);
  const deliveries = await claims.claim();
  options.manager.noteSuccessfulWrite();
  let surfaced = 0;
  let acked = 0;
  let buffered = 0;
  for (const row of deliveries) {
    if (seen.has(row.signal.id)) continue;
    const ask: SurfacedAsk = {
      signalId: row.signal.id,
      kind: row.signal.kind,
      body: row.signal.body,
      hostSessionId: options.context.host_session_id,
    };
    let injected = false;
    if (injection !== null && trusted) {
      const result = await injection.inject(ask);
      injected = result.ok === true;
    }
    if (injected) surfaced += 1;
    else buffered += 1;
    const proof = options.manager.currentProof();
    const ackGate = managedAckInput({
      context: options.context,
      proof,
      injectionSucceeded: injected,
      observedHostSessionId: observedHost,
      hostIdentityTrusted: trusted && injection !== null,
    });
    const decision = canAckManagedDelivery(ackGate);
    if (!decision.ok) continue;
    assertManagedAckAllowed(ackGate);
    await claims.ack(row, ackGate);
    seen.add(row.signal.id);
    acked += 1;
  }
  return { surfaced, acked, buffered, receive };
}

export async function runInteractiveReceiver(
  options: InteractiveReceiverOptions,
): Promise<InteractiveReceiverStatus> {
  const seen = new Set<string>();
  let surfaced = 0;
  let acked = 0;
  let buffered = 0;
  let receive: SessionReceiveState = options.context.receive_verification;
  const sleep = options.sleep ?? sleepMs;
  try {
    options.manager.start();
    while (options.manager.dispatchState() === "running") {
      if (options.signal?.aborted) break;
      const pass = await runInteractiveReceiveOnce(options, seen);
      surfaced += pass.surfaced;
      acked += pass.acked;
      buffered += pass.buffered;
      receive = pass.receive;
      if (options.context.receive_verification !== receive) {
        options.context = {
          ...options.context,
          receive_verification: receive,
        };
        await writeSessionContext(options.contextPath, options.context);
      }
      await sleep(AGENT_SESSION_RENEW_AFTER_MS, options.signal);
    }
  } catch (error) {
    if ((error as Error).name !== "AbortError") throw error;
  } finally {
    options.manager.stopTimers();
  }
  return {
    mode: "interactive",
    session_id: options.context.session_id,
    generation: options.context.generation,
    provider: options.context.provider,
    host_session_id: options.context.host_session_id,
    enforcement: options.context.enforcement,
    receive_verification: receive,
    dispatch: options.manager.dispatchState(),
    surfaced,
    acked,
    buffered,
  };
}

export function interactiveReceiverHasNoModelFactory(): true {
  return true;
}

export { AgentSessionClient };
