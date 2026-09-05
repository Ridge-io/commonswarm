import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSecureJsonFile } from "../src/cloud/storage.js";
import test from "node:test";
import {
  CommandHttpError,
  SIGNAL_REQUEST_TIMEOUT_MS,
  type SignalRecord,
} from "../src/cloud/command-client.js";
import { cloudTarget } from "../src/cloud/config.js";
import {
  DeliveryHttpError,
  DeliveryProtocolError,
  DeliveryTransportError,
  DELIVERY_REQUEST_TIMEOUT_MS,
  DELIVERY_ACK_OUTCOMES,
  type DeliveryClaimResult,
  type DeliveryOutcome,
  type DeliveryRow,
} from "../src/cloud/delivery.js";
import { listenerStatusJson, renderListenerStatus, usage } from "../src/cli.js";
import {
  RenewalReauthorisationRequired,
  RenewalRevoked,
} from "../src/cloud/renewal.js";
import type {
  AgentSignalPage,
  SignalCursor,
} from "../src/cloud/signals.js";
import {
  SIGNAL_READ_TIMEOUT_MS,
  SignalHttpError,
  SignalTransportError,
} from "../src/cloud/signals.js";
import { ACP_DEFAULT_REQUEST_TIMEOUT_MS } from "../src/host/bounds.js";
import { AcpHostError } from "../src/host/types.js";
import {
  runListenerRuntime as runListenerRuntimeActual,
  LISTENER_DELIVERY_SAFETY_MARGIN_MS,
  LISTENER_HOST_PORTS_PROBE_MS,
  LISTENER_PROMPT_START_MINIMUM_MS,
  listenerPaths,
  readListenerStatus,
  queryListenerControl,
  runListenerSupervisor,
  claimCommandId,
  ackCommandId,
  FileListenerEffectStore,
  newReceivedAskRecord,
  newObservedNoteRecord,
  LISTENER_DELIVERY_HOLD_RELEASE_REASONS,
  LISTENER_DELIVERY_HOLD_RELEASE_CLAUSES,
  LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES,
  type ListenerActiveClaim,
  type ListenerDeliveryJournalRecord,
  type ListenerEffectRecord,
  type ListenerEffectStore,
  type ListenerPromptMode,
  type ListenerRuntimeEvent,
  type ListenerStatus,
  type ListenerRuntimeModel,
} from "../src/listener/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const SENDER_OPERATOR_ID = "44444444-4444-4444-8444-444444444444";

async function runListenerRuntime(
  options: Parameters<typeof runListenerRuntimeActual>[0],
): ReturnType<typeof runListenerRuntimeActual> {
  return await runListenerRuntimeActual({
    resolveSenderProvenance: async () => ({
      senderName: "Avery",
      operatorId: SENDER_OPERATOR_ID,
      operatorName: "Morgan",
    }),
    ...options,
  });
}

test("prompt-start lease budget reserves the provenance directory deadline", () => {
  assert.equal(
    LISTENER_PROMPT_START_MINIMUM_MS,
    SIGNAL_READ_TIMEOUT_MS +
      ACP_DEFAULT_REQUEST_TIMEOUT_MS +
      SIGNAL_REQUEST_TIMEOUT_MS +
      DELIVERY_REQUEST_TIMEOUT_MS +
      LISTENER_DELIVERY_SAFETY_MARGIN_MS,
  );
});

function ask(
  id: string,
  createdAt: string,
): SignalRecord {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    from: "33333333-3333-4333-8333-333333333333",
    from_kind: "agent",
    to: null,
    to_agent: PRINCIPAL_ID,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body: `ask-${id.slice(-4)}`,
    // Keep the shared non-expiry fixture far from wall-clock time. When this
    // was 2026-08-30, the gate began looping before its fetch-driven aborts.
    until: "2036-08-30T00:00:00.000Z",
    created_at: createdAt,
    sender_owner_relation: "same_owner",
  };
}

function note(
  id: string,
  createdAt: string,
): SignalRecord {
  return {
    ...ask(id, createdAt),
    kind: "note",
    body: `note-${id.slice(-4)}`,
  };
}

function journalRecord(
  active: ListenerActiveClaim | null = null,
): ListenerDeliveryJournalRecord {
  return {
    version: 1 as const,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: "44444444-4444-4444-8444-444444444444",
    nextClaimOrdinal: 0,
    active,
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

class MemoryDeliveryJournal {
  record: ListenerDeliveryJournalRecord;
  readonly calls: string[] = [];
  readonly audit?: string[];

  constructor(active: ListenerActiveClaim | null = null, audit?: string[]) {
    this.record = journalRecord(active);
    this.audit = audit;
    if (active !== null) this.record.nextClaimOrdinal = active.claimOrdinal + 1;
  }

  async read() {
    this.calls.push("read");
    this.audit?.push("journal:read");
    return structuredClone(this.record);
  }

  async reserveClaim(now = new Date().toISOString()) {
    this.calls.push("reserve");
    this.audit?.push("journal:reserve");
    assert.equal(this.record.active, null);
    const ordinal = this.record.nextClaimOrdinal;
    const active: ListenerActiveClaim = {
      phase: "claim_pending",
      claimOrdinal: ordinal,
      claimCommandId: claimCommandId(this.record.listenerInstanceId, ordinal),
      claimCreatedAt: now,
      claimLastAttemptAt: null,
      signalId: null,
      leaseId: null,
      leasedUntil: null,
      ack: null,
    };
    this.record.active = active;
    this.record.nextClaimOrdinal += 1;
    this.record.updatedAt = now;
    return structuredClone(active);
  }

  async recordClaimAttempt(now = new Date().toISOString()) {
    this.calls.push("attempt");
    this.audit?.push("journal:attempt");
    assert.ok(this.record.active);
    this.record.active.claimLastAttemptAt = now;
    this.record.updatedAt = now;
  }

  async recordLease(input: {
    signalId: string;
    leaseId: string;
    leasedUntil: string;
    signalFingerprint?: string;
    now?: string;
  }) {
    this.calls.push("lease");
    this.audit?.push("journal:lease");
    assert.ok(this.record.active);
    this.record.active = {
      ...this.record.active,
      phase: "leased",
      signalId: input.signalId,
      leaseId: input.leaseId,
      leasedUntil: input.leasedUntil,
      signalFingerprint: input.signalFingerprint ?? null,
    };
    this.record.updatedAt = input.now ?? new Date().toISOString();
  }

  async prepareAck(input: {
    outcome: "replied" | "observed" | "expired" | "failed_terminal";
    lastErrorCode: "provider_refused" | "local_effect_failed" | "host_session_failed" | "credential_unavailable" | null;
    preparedAt?: string;
    now?: string;
  }) {
    this.calls.push("prepareAck");
    this.audit?.push("journal:prepareAck");
    assert.ok(this.record.active?.leaseId);
    this.record.active = {
      ...this.record.active,
      phase: "ack_pending",
      ack: {
        commandId: ackCommandId(this.record.active.leaseId),
        outcome: input.outcome,
        lastErrorCode: input.lastErrorCode,
        preparedAt: input.preparedAt ?? input.now ?? new Date().toISOString(),
      },
    };
  }

  async clearActive(now = new Date().toISOString()) {
    this.calls.push("clear");
    this.audit?.push("journal:clear");
    this.record.active = null;
    this.record.updatedAt = now;
  }
}

function inactiveJournal() {
  return {
    async read() { return journalRecord(); },
    async reserveClaim() { throw new Error("reserve must not run"); },
    async recordClaimAttempt() { throw new Error("attempt must not run"); },
    async recordLease() { throw new Error("lease must not run"); },
    async prepareAck() { throw new Error("ack must not run"); },
    async clearActive() { throw new Error("clear must not run"); },
  };
}

function durablePage(
  signals: SignalRecord[] = [],
  pendingDeliveryCount = 0,
): AgentSignalPage {
  return page(signals, {
    capabilities: {
      senderOwnerRelation: true,
      cursorAfter: true,
      deliveryClaim: true,
      deliveryAck: true,
    },
    pendingDeliveryCount,
  });
}

function claimResult(
  deliveries: DeliveryRow[],
  pendingDeliveryCount: number,
  terminalDeliveryFailureCount = 0,
): DeliveryClaimResult {
  return {
    httpStatus: 200,
    capabilities: {
      deliveryClaim: true,
      deliveryAck: true,
      senderOwnerRelation: true,
    },
    deliveries,
    pendingDeliveryCount,
    terminalDeliveryFailureCount,
  };
}

class MemoryStore implements ListenerEffectStore {
  readonly records = new Map<string, ListenerEffectRecord>();
  async read(id: string) {
    return structuredClone(this.records.get(id) ?? null);
  }
  async write(record: ListenerEffectRecord) {
    this.records.set(record.signalId, structuredClone(record));
  }
}

class RecordingStore extends MemoryStore {
  constructor(private readonly audit: string[]) {
    super();
  }
  override async read(id: string) {
    this.audit.push("effect:read");
    return await super.read(id);
  }
  override async write(record: ListenerEffectRecord) {
    this.audit.push("effect:write");
    await super.write(record);
  }
}

function leasedActive(input: {
  signalId: string;
  signal?: SignalRecord;
  leaseId?: string;
  leasedUntil?: string;
  phase?: "leased" | "ack_pending";
  outcome?: "replied" | "observed" | "expired" | "failed_terminal";
  lastErrorCode?: "provider_refused" | "local_effect_failed" | "host_session_failed" | "credential_unavailable" | null;
}): ListenerActiveClaim {
  const leaseId = input.leaseId ?? "55555555-5555-4555-8555-555555555555";
  const phase = input.phase ?? "leased";
  return {
    phase,
    claimOrdinal: 0,
    claimCommandId: claimCommandId(
      "44444444-4444-4444-8444-444444444444",
      0,
    ),
    claimCreatedAt: "2026-07-30T00:00:00.000Z",
    claimLastAttemptAt: "2026-07-30T00:00:01.000Z",
    signalId: input.signalId,
    leaseId,
    leasedUntil: input.leasedUntil ?? "2026-07-30T00:15:00.000Z",
    signalFingerprint: input.signal
      ? createHash("sha256").update(JSON.stringify([
        input.signal.id.toLowerCase(),
        input.signal.kind,
        input.signal.body,
        input.signal.until,
        input.signal.sender_owner_relation ?? "unknown",
      ])).digest("hex")
      : null,
    ack: phase === "ack_pending"
      ? {
        commandId: ackCommandId(leaseId),
        outcome: input.outcome ?? "observed",
        lastErrorCode: input.lastErrorCode ?? null,
        preparedAt: "2026-07-30T00:00:02.000Z",
      }
      : null,
  };
}

class FakeModel implements ListenerRuntimeModel {
  starts = 0;
  closes = 0;
  cancels = 0;
  prompts: Array<{ id: string; mode: ListenerPromptMode; prompt: string }> = [];

  async start() {
    this.starts += 1;
  }
  async prompt(
    signal: SignalRecord,
    mode: ListenerPromptMode,
    prompt: string,
  ) {
    this.prompts.push({ id: signal.id, mode, prompt });
    return {
      message: `reply-${signal.id.slice(-4)}`,
      stopReason: "end_turn" as const,
    };
  }
  cancel() {
    this.cancels += 1;
  }
  async close() {
    this.closes += 1;
  }
}

function page(
  signals: SignalRecord[],
  options: Partial<AgentSignalPage> = {},
): AgentSignalPage {
  const last = signals[signals.length - 1];
  return {
    signals,
    capabilities: {
      senderOwnerRelation: true,
      cursorAfter: true,
      deliveryClaim: false,
      deliveryAck: false,
    },
    legacyCursorFallback: false,
    rawCount: signals.length,
    nextCursor: last
      ? { created_at: last.created_at, id: last.id }
      : null,
    malformedRows: 0,
    pendingDeliveryCount: null,
    ...options,
  };
}

async function observedReadRetry(
  failure: Error,
): Promise<{
  retry: Extract<ListenerRuntimeEvent, { type: "read_retry" }>;
  recovered: Extract<ListenerRuntimeEvent, { type: "read_recovered" }>;
}> {
  const model = new FakeModel();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let reads = 0;
  let nowMs = Date.parse("2026-09-01T12:00:00.000Z");
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    pollMs: 0,
    now: () => nowMs,
    random: () => 0,
    onEvent: (event) => events.push(event),
    sleep: async (ms) => {
      nowMs += ms;
    },
    readPage: async () => {
      reads += 1;
      if (reads === 1) return page([]);
      if (reads === 2) throw failure;
      controller.abort();
      return page([]);
    },
  });
  assert.equal(stop.reason, "cancelled");
  const retry = events.find(
    (event): event is Extract<ListenerRuntimeEvent, { type: "read_retry" }> =>
      event.type === "read_retry",
  );
  const recovered = events.find(
    (event): event is Extract<ListenerRuntimeEvent, { type: "read_recovered" }> =>
      event.type === "read_recovered",
  );
  assert.ok(retry, "the retry path was reached");
  assert.ok(recovered, "the successful read closed the retry episode");
  return { retry, recovered };
}

test("listener retry events classify HTTP, no-response, aborted, and host-port failures without text matching", async () => {
  const http = await observedReadRetry(new SignalHttpError(503));
  assert.equal(http.retry.failure.code, "http_status");
  assert.equal(http.retry.failure.httpStatus, 503);

  const noResponse = await observedReadRetry(new SignalTransportError());
  assert.equal(noResponse.retry.failure.code, "no_response");
  assert.equal(noResponse.retry.failure.httpStatus, null);

  const aborted = new DOMException("fake read abort", "AbortError");
  const abortEpisode = await observedReadRetry(aborted);
  assert.equal(abortEpisode.retry.failure.code, "aborted");
  assert.equal(abortEpisode.recovered.attempts, 1);
  assert.equal(abortEpisode.recovered.durationMs, abortEpisode.retry.delayMs);

  const noPorts = Object.assign(new Error("text does not classify this"), {
    code: "EADDRNOTAVAIL",
  });
  const portEpisode = await observedReadRetry(noPorts);
  assert.equal(portEpisode.retry.failure.code, "host_ports_exhausted");
  assert.equal(portEpisode.retry.delayMs, LISTENER_HOST_PORTS_PROBE_MS);
  assert.ok(portEpisode.retry.delayMs >= 60_000);
});

async function productionReadRetry(
  failingFetch: () => Promise<Response>,
): Promise<Extract<ListenerRuntimeEvent, { type: "read_retry" }>> {
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let fetchCalls = 0;
  const fetcher = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({
        signals: [],
        capabilities: { sender_owner_relation: 1, cursor_after: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return await failingFetch();
  }) as typeof fetch;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    fetcher,
    pollMs: 0,
    random: () => 0,
    onEvent: (event) => events.push(event),
    sleep: async (ms) => {
      if (ms > 0) controller.abort();
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(fetchCalls, 2, "the failure reached the production signal fetch");
  const retry = events.find(
    (event): event is Extract<ListenerRuntimeEvent, { type: "read_retry" }> =>
      event.type === "read_retry",
  );
  assert.ok(retry, "the production signal failure reached the retry event");
  return retry;
}

test("production listener reads preserve HTTP status, no response, and EADDRNOTAVAIL codes", async () => {
  const http = await productionReadRetry(async () =>
    new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
  );
  assert.equal(http.failure.code, "http_status");
  assert.equal(http.failure.httpStatus, 503);

  const noResponse = await productionReadRetry(async () => {
    throw new TypeError("fake socket closed before a response");
  });
  assert.equal(noResponse.failure.code, "no_response");

  const aborted = await productionReadRetry(async () => {
    throw new DOMException("fake provider abort", "AbortError");
  });
  assert.equal(aborted.failure.code, "aborted");

  const noPorts = await productionReadRetry(async () => {
    throw Object.assign(new Error("different message"), { code: "EADDRNOTAVAIL" });
  });
  assert.equal(noPorts.failure.code, "host_ports_exhausted");
  assert.equal(noPorts.delayMs, LISTENER_HOST_PORTS_PROBE_MS);
});

test("listener body-stall retry is classified through the production signal deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const model = new FakeModel();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let fetchCalls = 0;
  let bodyStarted = false;
  const fetcher = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({
        signals: [],
        capabilities: { sender_owner_relation: 1, cursor_after: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        bodyStarted = true;
        return await new Promise<unknown>(() => {});
      },
    } as Response;
  }) as typeof fetch;
  const pending = runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    fetcher,
    pollMs: 0,
    random: () => 0,
    onEvent: (event) => events.push(event),
    sleep: async (ms) => {
      if (ms > 0) controller.abort();
    },
  });
  for (let turn = 0; turn < 20 && !bodyStarted; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(fetchCalls, 2, "the ready read and stalled read both reached fetch");
  assert.equal(bodyStarted, true, "the stalled body consumer was reached");
  t.mock.timers.tick(SIGNAL_READ_TIMEOUT_MS);
  const stop = await pending;
  assert.equal(stop.reason, "cancelled");
  const retry = events.find(
    (event): event is Extract<ListenerRuntimeEvent, { type: "read_retry" }> =>
      event.type === "read_retry",
  );
  assert.ok(retry, "the production body deadline reached the listener retry path");
  assert.equal(retry.failure.code, "body_timeout");
});

test("incomplete durable configuration fails before credential or provider work", async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  let bearerCalls = 0;
  let readCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: "44444444-4444-4444-8444-444444444444",
    credentialSession: {
      async bearer() {
        bearerCalls += 1;
        return "token";
      },
    },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    readPage: async () => {
      readCalls += 1;
      controller.abort();
      return page([]);
    },
  });
  assert.equal(stop.reason, "fatal");
  assert.equal(bearerCalls, 0);
  assert.equal(readCalls, 0);
  assert.equal(model.starts, 0);
});

test("cursor fallback observes direct notes without model or reply effects", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11",
    "2026-07-30T00:00:01.000Z",
  );
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return page(reads === 1 ? [directNote] : []);
    },
    poster: {
      async post() {
        throw new Error("note must not post");
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  const record = await store.read(directNote.id);
  assert.ok(record);
  assert.equal(record.signalKind, "note");
  assert.equal(record.state, "observed");
  assert.equal(model.prompts.length, 0);
  assert.deepEqual(
    events.filter((event) => event.type === "delivery_mode"),
    [{
      type: "delivery_mode",
      mode: "cursor_fallback",
      pendingDeliveryCount: null,
      ts: events.find((event) => event.type === "delivery_mode")?.ts,
    }],
  );
});

test("durable markers select durable mode before probe rows can be cursor-processed", async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let reads = 0;
  const probeAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12",
    "2026-07-30T00:00:01.000Z",
  );
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: "44444444-4444-4444-8444-444444444444",
    deliveryJournal: inactiveJournal(),
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim not reached in mode test"); },
      async ackAgentDelivery() { throw new Error("ack not reached in mode test"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "delivery_mode") controller.abort();
    },
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      return page([probeAsk], {
        capabilities: {
          senderOwnerRelation: true,
          cursorAfter: true,
          deliveryClaim: true,
          deliveryAck: true,
        },
        pendingDeliveryCount: 4,
      });
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(model.prompts.length, 0);
  const modes = events.filter((event) => event.type === "delivery_mode");
  assert.equal(modes.length, 1);
  assert.deepEqual(modes[0], {
    type: "delivery_mode",
    mode: "durable_claim",
    pendingDeliveryCount: 4,
    ts: modes[0]?.ts,
  });
});

test("claim without ACK capability fails before provider work", async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: "44444444-4444-4444-8444-444444444444",
    deliveryJournal: inactiveJournal(),
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return page([], {
        capabilities: {
          senderOwnerRelation: true,
          cursorAfter: true,
          deliveryClaim: true,
          deliveryAck: false,
        },
        pendingDeliveryCount: 0,
      });
    },
  });
  assert.equal(stop.reason, "fatal");
  assert.match(
    stop.reason === "fatal" ? stop.error.message : "",
    /delivery capability is inconsistent/,
  );
  assert.equal(model.starts, 0);
});

test("delivery events reduce into the closed supervisor status fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-runtime-events-"));
  const paths = listenerPaths({
    profileId: `profile-${randomUUID()}`,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory: root,
  });
  const ts = "2026-07-30T00:00:01.000Z";
  const ackSnapshots: Array<{
    outcome: string | null;
    failures: number | null;
    human: string;
    json: Record<string, unknown>;
  }> = [];
  const status = await runListenerSupervisor({
    paths,
    profileId: "profile-test",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    run: async (_signal, onEvent) => {
      onEvent({ type: "ready", workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, ts });
      onEvent({ type: "delivery_mode", mode: "durable_claim", pendingDeliveryCount: 3, ts });
      onEvent({
        type: "delivery_claim",
        signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13",
        pendingDeliveryCount: 2,
        terminalDeliveryFailureCount: 1,
        ts,
      });
      onEvent({ type: "delivery_terminal_failures", count: 1, ts });
      const ack = async (
        signalId: string,
        outcome: DeliveryOutcome,
        ackTs: string,
      ) => {
        onEvent({ type: "delivery_ack", signalId, outcome, ts: ackTs });
        const snapshot = await queryListenerControl(paths, "status");
        ackSnapshots.push({
          outcome: snapshot.lastAckOutcome,
          failures: snapshot.consecutiveAckFailureCount,
          human: renderListenerStatus(snapshot),
          json: listenerStatusJson(snapshot),
        });
      };
      const incident: Array<[string, DeliveryOutcome, string]> = [
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13", "failed_terminal", "2026-09-03T17:06:52.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa14", "observed", "2026-09-03T17:12:52.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa15", "failed_terminal", "2026-09-03T17:23:15.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa16", "failed_terminal", "2026-09-03T17:24:30.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa17", "failed_terminal", "2026-09-03T17:52:30.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa18", "failed_terminal", "2026-09-03T18:36:28.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19", "failed_terminal", "2026-09-03T18:37:12.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20", "failed_terminal", "2026-09-03T18:37:35.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21", "observed", "2026-09-03T18:38:24.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22", "failed_terminal", "2026-09-03T18:44:31.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa23", "observed", "2026-09-03T18:45:38.000Z"],
      ];
      for (const event of incident) await ack(...event);
      /* Reaching `ready` again (a restartable blip, canary passed) must NOT clear
         the run. The permission canary is its own prompt: a provider can answer
         it and fail every real message, so `ready` is not provider proof. Without
         this pin, restoring `consecutiveAckFailureCount: 0` on `ready` leaves
         every other assertion in this file green. */
      onEvent({
        type: "ready",
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        ts: "2026-09-03T18:46:00.000Z",
      });
      const afterReady = await queryListenerControl(paths, "status");
      assert.equal(afterReady.consecutiveAckFailureCount, 8);
      assert.equal(afterReady.lastAckOutcome, "observed");
      const afterReadyHuman = renderListenerStatus(afterReady);
      assert.doesNotMatch(afterReadyHuman, /HANDLED: yes/);
      /* A negative alone passes if the line vanishes; pin the positive too. */
      assert.match(afterReadyHuman, /HANDLED: no\. 8 deliveries have failed since the last reply/);
      await ack("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa24", "queued", "2026-09-03T18:46:00.000Z");
      await ack("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa25", "expired", "2026-09-03T18:46:30.000Z");
      await ack("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa26", "replied", "2026-09-03T18:47:00.000Z");
      onEvent({
        type: "main_queue",
        signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13",
        pendingCount: 200,
        droppedOldest: true,
        droppedCount: 7,
        ts,
      });
      return { reason: "cancelled" };
    },
  });
  assert.equal(status.deliveryMode, "durable_claim");
  assert.equal(status.pendingDeliveryCount, null);
  assert.equal(status.lastTerminalDeliveryFailureCount, 1);
  assert.equal(status.lastTerminalDeliveryFailureAt, ts);
  assert.equal(status.lastClaimAt, ts);
  assert.equal(status.lastAckAt, "2026-09-03T18:47:00.000Z");
  assert.equal(status.lastAckOutcome, "replied");
  assert.equal(status.consecutiveAckFailureCount, 0);
  assert.deepEqual(
    ackSnapshots.map(({ outcome, failures }) => ({ outcome, failures })),
    [
      { outcome: "failed_terminal", failures: 1 },
      { outcome: "observed", failures: 1 },
      { outcome: "failed_terminal", failures: 2 },
      { outcome: "failed_terminal", failures: 3 },
      { outcome: "failed_terminal", failures: 4 },
      { outcome: "failed_terminal", failures: 5 },
      { outcome: "failed_terminal", failures: 6 },
      { outcome: "failed_terminal", failures: 7 },
      { outcome: "observed", failures: 7 },
      { outcome: "failed_terminal", failures: 8 },
      { outcome: "observed", failures: 8 },
      { outcome: "queued", failures: 8 },
      { outcome: "expired", failures: 8 },
      { outcome: "replied", failures: 0 },
    ],
  );
  const belowThreshold = ackSnapshots[2]!;
  assert.doesNotMatch(belowThreshold.human, /listener_delivery_failing/);
  assert.equal(belowThreshold.json.listenerLapse, false);
  const atThreshold = ackSnapshots[3]!;
  assert.match(atThreshold.human, /Listener LAPSE/);
  assert.match(atThreshold.human, /WARNING \[listener_delivery_failing\]/);
  assert.deepEqual(atThreshold.json.listenerLapseCodes, [
    "listener_delivery_failing",
  ]);
  const afterMeasuredIncident = ackSnapshots[10]!;
  assert.match(afterMeasuredIncident.human, /^Listener LAPSE/);
  assert.match(afterMeasuredIncident.human, /WARNING \[listener_delivery_failing\]/);
  /* The 18:47 state of the measured 2026-09-03 incident: the newest ack is the
     18:45:38 `observed` note. Observing a note starts no provider session, so it
     must NOT read as handled while the terminal-failure run stands. This assertion
     replaces one that required `HANDLED: yes` here — a green control pinning the
     exact false claim the lane exists to remove. */
  assert.doesNotMatch(afterMeasuredIncident.human, /HANDLED: yes/);
  assert.match(
    afterMeasuredIncident.human,
    /HANDLED: no\. 8 deliveries have failed since the last reply; the newest delivery acknowledgement was observed\./,
  );
  assert.equal(afterMeasuredIncident.json.handledState, "not_handled");
  assert.equal(afterMeasuredIncident.json.lastAckOutcome, "observed");
  assert.equal(afterMeasuredIncident.json.consecutiveAckFailureCount, 8);
  /* An observed note must not be renamed a failed delivery, and must not be
     called handled while the run stands. Both halves are pinned: without the
     second, restoring `Last handled signal:` here would still pass. */
  assert.doesNotMatch(afterMeasuredIncident.human, /Last failed delivery signal/);
  assert.doesNotMatch(afterMeasuredIncident.human, /Last handled signal/);
  assert.match(
    afterMeasuredIncident.human,
    /Last acknowledged signal: [0-9a-f-]+\. Its outcome was observed\./,
  );
  assert.equal(afterMeasuredIncident.json.listenerLapse, true);
  assert.deepEqual(afterMeasuredIncident.json.listenerLapseCodes, [
    "listener_delivery_failing",
  ]);
  const afterReply = ackSnapshots.at(-1)!;
  assert.doesNotMatch(afterReply.human, /listener_delivery_failing/);
  assert.equal(afterReply.json.listenerLapse, false);
  assert.equal(status.lastSignalId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13");
  assert.equal(status.pendingForMainCount, 200);
  assert.equal(status.droppedForMainCount, 7);
});

test("durable claim persists one command id across retries, uses fresh bearers, and clears zero results", async () => {
  const model = new FakeModel();
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const callOrder: string[] = [];
  const claimIds: string[] = [];
  const delays: number[] = [];
  let reads = 0;
  let attempts = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        callOrder.push("claim");
        claimIds.push(request.commandId);
        attempts += 1;
        if (attempts === 1) throw new DeliveryTransportError("ambiguous");
        if (attempts === 2) {
          throw new DeliveryHttpError(429, "rate_limited", "retry", 750);
        }
        return claimResult([], 0);
      },
      async ackAgentDelivery() { throw new Error("ack must not run"); },
    },
    credentialSession: {
      async bearer() {
        callOrder.push("bearer");
        return "token";
      },
    },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    random: () => 0.5,
    sleep: async (ms) => {
      delays.push(ms);
    },
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return durablePage([], 1);
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(attempts, 3);
  assert.equal(new Set(claimIds).size, 1);
  assert.equal(
    claimIds[0],
    claimCommandId(journal.record.listenerInstanceId, 0),
  );
  assert.deepEqual(journal.calls.slice(0, 6), [
    "read",
    "reserve",
    "attempt",
    "attempt",
    "attempt",
    "clear",
  ]);
  for (const [index, value] of callOrder.entries()) {
    if (value === "claim") assert.equal(callOrder[index - 1], "bearer");
  }
  assert.ok(delays.includes(750));
  assert.equal(journal.record.active, null);
  assert.equal(model.prompts.length, 0);
});

test("claim-pending recovery replays the exact persisted command without reserving a new claim", async () => {
  const active: ListenerActiveClaim = {
    phase: "claim_pending",
    claimOrdinal: 7,
    claimCommandId: claimCommandId(
      "44444444-4444-4444-8444-444444444444",
      7,
    ),
    claimCreatedAt: "2026-07-30T00:00:00.000Z",
    claimLastAttemptAt: "2026-07-30T00:00:01.000Z",
    signalId: null,
    leaseId: null,
    leasedUntil: null,
    ack: null,
  };
  const journal = new MemoryDeliveryJournal(active);
  const controller = new AbortController();
  const ids: string[] = [];
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        ids.push(request.commandId);
        return claimResult([], 0);
      },
      async ackAgentDelivery() { throw new Error("ack must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:02.000Z"),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return durablePage();
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(ids, [active.claimCommandId]);
  assert.equal(journal.calls.includes("reserve"), false);
  assert.equal(journal.record.nextClaimOrdinal, 8);
  assert.equal(journal.record.active, null);
});

test("C-1 composition: stale claim_pending clears before durable replay", async () => {
  const active: ListenerActiveClaim = {
    phase: "claim_pending",
    claimOrdinal: 7,
    claimCommandId: claimCommandId(
      "44444444-4444-4444-8444-444444444444",
      7,
    ),
    claimCreatedAt: "2026-07-30T00:00:00.000Z",
    claimLastAttemptAt: "2026-07-30T00:00:01.000Z",
    signalId: null,
    leaseId: null,
    leasedUntil: null,
    ack: null,
  };
  const journal = new MemoryDeliveryJournal(active);
  const controller = new AbortController();
  const ids: string[] = [];
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        ids.push(request.commandId);
        if (request.commandId === active.claimCommandId) {
          throw new DeliveryProtocolError(
            "stored replay returned an already expired lease",
          );
        }
        return claimResult([], 0);
      },
      async ackAgentDelivery() { throw new Error("ack must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:16:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 2) controller.abort();
      return durablePage();
    },
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "C-1 stale claim_pending must clear instead of fatally replaying an expired lease",
  );
  assert.deepEqual(ids, [
    claimCommandId(journal.record.listenerInstanceId, 8),
  ]);
  assert.deepEqual(journal.calls.slice(0, 7), [
    "read",
    "clear",
    "read",
    "reserve",
    "attempt",
    "clear",
    "read",
  ]);
});

test("a claimed lease is persisted before any effect work begins", async () => {
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const model = new FakeModel();
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa14",
    "2026-07-30T00:00:01.000Z",
  );
  const lease: DeliveryRow = {
    signal: claimedAsk,
    leaseId: "55555555-5555-4555-8555-555555555555",
    leasedUntil: "2026-07-30T00:15:00.000Z",
    senderOwnerRelation: "cross_owner",
  };
  const originalRecordLease = journal.recordLease.bind(journal);
  journal.recordLease = async (input) => {
    await originalRecordLease(input);
    controller.abort();
  };
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { return claimResult([lease], 1); },
      async ackAgentDelivery() { throw new Error("ack must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return durablePage();
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(journal.record.active?.phase, "leased");
  assert.equal(journal.record.active?.signalId, claimedAsk.id);
  assert.equal(journal.record.active?.leaseId, lease.leaseId);
  assert.equal(model.prompts.length, 0);
  assert.deepEqual(journal.calls.slice(0, 4), [
    "read",
    "reserve",
    "attempt",
    "lease",
  ]);
});

test("C-1: an expired durable leased claim without an effect clears and re-claims", async () => {
  const signalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad1";
  const active = leasedActive({
    signalId,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const controller = new AbortController();
  const claimIds: string[] = [];
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        claimIds.push(request.commandId);
        if (request.commandId === active.claimCommandId) {
          throw new DeliveryProtocolError("stored replay lease is no longer live");
        }
        controller.abort();
        return claimResult([], 0);
      },
      async ackAgentDelivery() { throw new Error("ACK must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "C-1 stale durable lease must recover instead of stopping fatally",
  );
  assert.equal(claimIds.includes(active.claimCommandId), false);
  assert.equal(journal.record.active, null);
});

test("D-041a: a corrupt recovered effect cannot block stale leased recovery", async (t) => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa041",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    signal: directNote,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-d041a-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const store = new FileListenerEffectStore({
    profileId: "profile-d041a",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  await writeFile(
    join(store.instanceDirectory, "effects", `${directNote.id}.json`),
    "{corrupt",
  );

  const controller = new AbortController();
  const claimIds: string[] = [];
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        claimIds.push(request.commandId);
        return claimResult([{
          signal: directNote,
          leaseId: "55555555-5555-4555-8555-555555555041",
          leasedUntil: "2026-07-30T00:17:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });

  assert.equal(
    stop.reason,
    "cancelled",
    stop.reason === "fatal"
      ? `D-041a recovery stopped fatally: ${stop.error.message}`
      : "D-041a corrupt effect must degrade to no terminal effect and clear the stale lease",
  );
  assert.equal(claimIds.includes(active.claimCommandId), false);
  assert.equal(ackCalls, 1);
  assert.equal((await store.read(directNote.id))?.state, "observed");
  assert.equal(journal.record.active, null);
});

test("D-041a enumeration: a requeued corrupt ask fails safely without a second reply", async (t) => {
  const directAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa043",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directAsk.id,
    signal: directAsk,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-d041a-ask-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const store = new FileListenerEffectStore({
    profileId: "profile-d041a-ask",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  await store.write(newReceivedAskRecord(
    directAsk,
    Date.parse("2026-07-30T00:00:02.000Z"),
  ));
  await writeFile(
    join(store.instanceDirectory, "effects", `${directAsk.id}.json`),
    "{corrupt",
  );

  const controller = new AbortController();
  const model = new FakeModel();
  let postCalls = 0;
  let ackCalls = 0;
  let ackOutcome: string | null = null;
  let ackErrorCode: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: directAsk,
          leaseId: "55555555-5555-4555-8555-555555555043",
          leasedUntil: "2026-07-30T00:17:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        ackOutcome = request.outcome;
        ackErrorCode = request.lastErrorCode;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    poster: {
      async post() {
        postCalls += 1;
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb043" };
      },
    },
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });

  assert.equal(stop.reason, "cancelled");
  assert.equal(model.prompts.length, 0);
  assert.equal(postCalls, 0);
  assert.equal(ackCalls, 1);
  assert.equal(ackOutcome, "failed_terminal");
  assert.equal(ackErrorCode, "local_effect_failed");
  assert.equal((await store.read(directAsk.id))?.state, "failed");
  assert.equal((await store.read(directAsk.id))?.failureCode, "local_effect_corrupt");
  assert.equal(journal.record.active, null);
});

test("D-041 enumeration: a fresh claim repairs corruption without process-local recovery state", async (t) => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa044",
    "2026-07-30T00:00:01.000Z",
  );
  const journal = new MemoryDeliveryJournal();
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-d041-fresh-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const store = new FileListenerEffectStore({
    profileId: "profile-d041-fresh",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  await writeFile(
    join(store.instanceDirectory, "effects", `${directNote.id}.json`),
    "{corrupt",
  );

  const controller = new AbortController();
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: directNote,
          leaseId: "55555555-5555-4555-8555-555555555044",
          leasedUntil: "2026-07-30T00:17:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });

  assert.equal(stop.reason, "cancelled");
  assert.equal(ackCalls, 1);
  assert.ok(journal.calls.includes("lease"));
  assert.equal((await store.read(directNote.id))?.state, "observed");
  assert.equal(journal.record.active, null);
});

test("D-041 enumeration: cursor fallback consumes a corrupt-effect repair", async (t) => {
  const directAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa045",
    "2026-07-30T00:00:01.000Z",
  );
  const journal = new MemoryDeliveryJournal(leasedActive({
    signalId: directAsk.id,
    signal: directAsk,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  }));
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-d041-fallback-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const store = new FileListenerEffectStore({
    profileId: "profile-d041-fallback",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  await store.write(newReceivedAskRecord(
    directAsk,
    Date.parse("2026-07-30T00:00:02.000Z"),
  ));
  await writeFile(
    join(store.instanceDirectory, "effects", `${directAsk.id}.json`),
    "{corrupt",
  );

  const controller = new AbortController();
  const model = new FakeModel();
  let postCalls = 0;
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() { throw new Error("ACK must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    poster: {
      async post() {
        postCalls += 1;
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb045" };
      },
    },
    signal: controller.signal,
    onEvent(event) {
      if (event.type === "effect") controller.abort();
    },
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      return page(reads === 1 ? [] : [directAsk]);
    },
  });

  assert.equal(stop.reason, "cancelled");
  assert.equal(model.prompts.length, 0);
  assert.equal(postCalls, 0);
  assert.equal((await store.read(directAsk.id))?.state, "failed");
  assert.equal((await store.read(directAsk.id))?.failureCode, "local_effect_corrupt");
  assert.equal(journal.record.active, null);
});

test("D-041b: fatal ACK replay recovers after the persisted lease horizon", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa042",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    phase: "ack_pending",
    outcome: "observed",
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  let ackCalls = 0;

  const firstStop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() {
        ackCalls += 1;
        throw new DeliveryProtocolError("fatal prepared ACK");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    now: () => Date.parse("2026-07-30T00:00:30.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(firstStop.reason, "fatal");
  assert.equal(journal.record.active?.phase, "ack_pending");

  const controller = new AbortController();
  const claimIds: string[] = [];
  const restartStop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        claimIds.push(request.commandId);
        controller.abort();
        return claimResult([], 0);
      },
      async ackAgentDelivery() {
        ackCalls += 1;
        throw new Error("expired ACK must not replay");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:01:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });

  assert.equal(
    restartStop.reason,
    "cancelled",
    "D-041b fatal ACK state must clear after lease expiry plus the safety margin",
  );
  assert.equal(ackCalls, 1);
  assert.equal(claimIds.includes(active.claimCommandId), false);
  assert.equal(journal.record.active, null);
});

test("C-1: an expired durable leased claim with a terminal effect ACKs before clearing", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad2",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    signal: directNote,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const controller = new AbortController();
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        throw new DeliveryProtocolError("expired claim replay must not run");
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "C-1 terminal durable recovery must ACK instead of replaying the expired claim",
  );
  assert.equal(ackCalls, 1);
  assert.equal(journal.record.active, null);
});

test("C-1 review: recovered terminal effects must match authoritative signal fields before ACK", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad9",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: "stale content under the same signal id",
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const controller = new AbortController();
  let ackCalls = 0;
  let claimCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claimCalls += 1;
        controller.abort();
        return claimResult([], 0);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(
    ackCalls,
    0,
    "C-1 recovered terminal effect with mismatched immutable fields must not be ACKed",
  );
  assert.equal(claimCalls, 1);
});

test("C-1 composition: an expired leased claim with a resumable effect re-claims and finishes", async () => {
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad4",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: claimedAsk.id,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  store.records.set(claimedAsk.id, {
    version: 2,
    signalId: claimedAsk.id,
    signalKind: "ask",
    effectOrdinal: 0,
    commandId: "reply_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaad4_0",
    askBody: claimedAsk.body,
    askUntil: claimedAsk.until,
    senderOwnerRelation: "same_owner",
    state: "received",
    promptAttempts: 0,
    postAttempts: 0,
    replyBody: null,
    replyTruncated: false,
    replySignalId: null,
    failureCode: "cancelled",
    updatedAt: "2026-07-30T00:00:02.000Z",
  });
  const controller = new AbortController();
  const model = new FakeModel();
  let claimCalls = 0;
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claimCalls += 1;
        return claimResult([{
          signal: claimedAsk,
          leaseId: "55555555-5555-4555-8555-5555555555d4",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
    poster: {
      async post() {
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbd4" };
      },
    },
  });
  assert.equal(
    stop.reason,
    "cancelled",
    `C-1 resumable recovery must not classify a nonterminal effect as terminal${
      stop.reason === "fatal" ? `: ${stop.error.message}` : ""
    }`,
  );
  assert.equal(claimCalls, 1);
  assert.equal(ackCalls, 1);
  assert.equal(model.prompts.length, 1);
  assert.equal((await store.read(claimedAsk.id))?.state, "done");
  assert.equal(journal.record.active, null);
});

test("C-1 composition: a live leased claim with a resumable effect replays immediately", async () => {
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad5",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: claimedAsk.id,
    leasedUntil: "2026-07-30T00:15:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  store.records.set(claimedAsk.id, {
    version: 2,
    signalId: claimedAsk.id,
    signalKind: "ask",
    effectOrdinal: 0,
    commandId: "reply_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaad5_0",
    askBody: claimedAsk.body,
    askUntil: claimedAsk.until,
    senderOwnerRelation: "same_owner",
    state: "prompting",
    promptAttempts: 1,
    postAttempts: 0,
    replyBody: null,
    replyTruncated: false,
    replySignalId: null,
    failureCode: null,
    updatedAt: "2026-07-30T00:00:02.000Z",
  });
  const controller = new AbortController();
  const model = new FakeModel();
  const claimIds: string[] = [];
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        claimIds.push(request.commandId);
        return claimResult([{
          signal: claimedAsk,
          leaseId: active.leaseId!,
          leasedUntil: active.leasedUntil!,
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => {
      controller.abort();
    },
    readPage: async () => durablePage([], 1),
    poster: {
      async post() {
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbd5" };
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(
    claimIds,
    [active.claimCommandId],
    "C-1 live durable recovery must replay the stored claim immediately",
  );
  assert.equal(ackCalls, 1);
  assert.equal(model.prompts.length, 1);
  assert.equal((await store.read(claimedAsk.id))?.state, "done");
  assert.equal(journal.record.active, null);
});

test("C-1 composition: an unverified terminal-shaped effect does not brick recovery", async () => {
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad6",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: claimedAsk.id,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  store.records.set(claimedAsk.id, {
    version: 2,
    signalId: claimedAsk.id,
    signalKind: "ask",
    effectOrdinal: 0,
    commandId: "reply_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaad6_0",
    askBody: claimedAsk.body,
    askUntil: claimedAsk.until,
    senderOwnerRelation: "same_owner",
    state: "done",
    promptAttempts: 1,
    postAttempts: 1,
    replyBody: "reply",
    replyTruncated: false,
    replySignalId: null,
    failureCode: null,
    updatedAt: "2026-07-30T00:00:02.000Z",
  });
  const controller = new AbortController();
  let claimCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claimCalls += 1;
        controller.abort();
        return claimResult([], 0);
      },
      async ackAgentDelivery() { throw new Error("unverified effect must not ACK"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "C-1 unverified terminal-shaped effects must recover instead of stopping fatally",
  );
  assert.equal(claimCalls, 1);
  assert.equal(journal.record.active, null);
});

test("MAJOR-3: failureCode error ACKs local_effect_failed and the runtime survives", async () => {
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const model = new FakeModel();
  model.prompt = async () => {
    throw new Error("ordinary model failure");
  };
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad3",
    "2026-07-30T00:00:01.000Z",
  );
  let ackCode: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedAsk,
          leaseId: "55555555-5555-4555-8555-5555555555d3",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCode = request.lastErrorCode;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "MAJOR-3 unknown failure classification must not brick the listener",
  );
  assert.equal(ackCode, "local_effect_failed");
  assert.equal(journal.record.active, null);
});

test("route=worker observes a durable note before prepareAck and network ACK", async () => {
  const audit: string[] = [];
  const journal = new MemoryDeliveryJournal(null, audit);
  const store = new RecordingStore(audit);
  const controller = new AbortController();
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa15",
    "2026-07-30T00:00:01.000Z",
  );
  const delivery: DeliveryRow = {
    signal: { ...directNote, sender_owner_relation: "same_owner" },
    leaseId: "55555555-5555-4555-8555-555555555556",
    leasedUntil: "2026-07-30T00:15:00.000Z",
    senderOwnerRelation: "cross_owner",
  };
  let ackOutcome: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        audit.push("network:claim");
        return claimResult([delivery], 1);
      },
      async ackAgentDelivery(request) {
        audit.push("network:ack");
        ackOutcome = request.outcome;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    routeMode: "worker",
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage(),
    poster: { async post() { throw new Error("note must not post"); } },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(ackOutcome, "observed");
  const record = await store.read(directNote.id);
  assert.ok(record);
  assert.equal(record.state, "observed");
  assert.equal(record.senderOwnerRelation, "cross_owner");
  assert.equal(journal.record.active, null);
  const writeAt = audit.indexOf("effect:write");
  const prepareAt = audit.indexOf("journal:prepareAck");
  const ackAt = audit.indexOf("network:ack");
  assert.ok(writeAt >= 0 && writeAt < prepareAt);
  assert.ok(audit.lastIndexOf("effect:read", prepareAt) > writeAt);
  assert.ok(prepareAt < ackAt);
});

test("route=worker replies to a durable ask after persisting prepareAck", async () => {
  const audit: string[] = [];
  const journal = new MemoryDeliveryJournal(null, audit);
  const store = new RecordingStore(audit);
  const controller = new AbortController();
  const model = new FakeModel();
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa16",
    "2026-07-30T00:00:01.000Z",
  );
  const delivery: DeliveryRow = {
    signal: claimedAsk,
    leaseId: "55555555-5555-4555-8555-555555555557",
    leasedUntil: "2026-07-30T00:15:00.000Z",
    senderOwnerRelation: "same_owner",
  };
  let outcome: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { return claimResult([delivery], 1); },
      async ackAgentDelivery(request) {
        audit.push("network:ack");
        outcome = request.outcome;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    routeMode: "worker",
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage(),
    poster: {
      async post() {
        audit.push("effect:post");
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(outcome, "replied");
  assert.equal(model.prompts.length, 1);
  assert.equal((await store.read(claimedAsk.id))?.state, "done");
  assert.ok(audit.indexOf("journal:prepareAck") < audit.indexOf("network:ack"));
  assert.ok(audit.lastIndexOf("effect:read", audit.indexOf("journal:prepareAck")) >= 0);
});

test("route=main queues and acknowledges a durable ask without prompting the worker", async () => {
  const journal = new MemoryDeliveryJournal();
  const store = new MemoryStore();
  const controller = new AbortController();
  const model = new FakeModel();
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa92",
    "2026-07-30T00:00:01.000Z",
  );
  const queued: Array<{ signalId: string; observationPending?: true }> = [];
  const runtimeEvents: ListenerRuntimeEvent[] = [];
  let ackOutcome: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedAsk,
          leaseId: "55555555-5555-4555-8555-555555555592",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackOutcome = request.outcome;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    routeMode: "main",
    deferOverChars: null,
    pendingMainQueue: {
      async enqueue(entry) {
        queued.push({
          signalId: entry.signalId,
          ...(entry.observationPending === true ? { observationPending: true } : {}),
        });
        return { count: 200, added: true, droppedOldest: true, droppedCount: 4 };
      },
    },
    onEvent(event) {
      runtimeEvents.push(event);
    },
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage(),
    poster: { async post() { throw new Error("main route must not post a worker reply"); } },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(queued, [{ signalId: claimedAsk.id, observationPending: true }]);
  assert.equal(
    ackOutcome,
    "queued",
    "routing to the interactive session is not observation before hook output",
  );
  assert.equal(model.starts, 0, "main route must not start an ACP worker session");
  assert.equal(model.prompts.length, 0, "mutation control: forcing worker route must prompt once");
  assert.ok(runtimeEvents.some((event) =>
    event.type === "main_queue" && event.pendingCount === 200 &&
    event.droppedOldest && event.droppedCount === 4
  ), "a bounded-queue drop must reach the supervisor as a warning event");
  assert.equal((await store.read(claimedAsk.id))?.state, "routed_main");
  assert.equal(journal.record.active, null);
});

test("route=main queues a durable note before the hook observes it", async () => {
  const journal = new MemoryDeliveryJournal();
  const store = new MemoryStore();
  const controller = new AbortController();
  const model = new FakeModel();
  const claimedNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac1",
    "2026-07-30T00:00:01.000Z",
  );
  const queued: Array<{
    signalId: string;
    kind?: "ask" | "note";
    observationPending?: true;
  }> = [];
  let ackOutcome: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedNote,
          leaseId: "55555555-5555-4555-8555-5555555555c1",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackOutcome = request.outcome;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    routeMode: "main",
    deferOverChars: null,
    pendingMainQueue: {
      async enqueue(entry) {
        queued.push({
          signalId: entry.signalId,
          ...(entry.kind === undefined ? {} : { kind: entry.kind }),
          ...(entry.observationPending === true ? { observationPending: true } : {}),
        });
        return { count: 1, added: true, droppedOldest: false, droppedCount: 0 };
      },
    },
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage(),
    poster: { async post() { throw new Error("main-routed note must not post"); } },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(queued, [{
    signalId: claimedNote.id,
    kind: "note",
    observationPending: true,
  }]);
  assert.equal(
    ackOutcome,
    "queued",
    "receipt cannot say observed before the interactive hook prints the note",
  );
  assert.equal(model.starts, 0);
  assert.equal(model.prompts.length, 0);
  assert.equal((await store.read(claimedNote.id))?.state, "routed_main");
  assert.equal(journal.record.active, null);
});

test("route=split queues an over-threshold note instead of claiming observation", async () => {
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const claimedNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac2",
    "2026-07-30T00:00:01.000Z",
  );
  let queuedKind: "ask" | "note" | undefined;
  let ackOutcome: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedNote,
          leaseId: "55555555-5555-4555-8555-5555555555c2",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackOutcome = request.outcome;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    routeMode: "split",
    deferOverChars: 1,
    pendingMainQueue: {
      async enqueue(entry) {
        queuedKind = entry.kind;
        return { count: 1, added: true, droppedOldest: false, droppedCount: 0 };
      },
    },
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(queuedKind, "note");
  assert.equal(ackOutcome, "queued");
  assert.equal(journal.record.active, null);
});

test("route=split keeps an under-threshold note on the observed worker path", async () => {
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const claimedNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac4",
    "2026-07-30T00:00:01.000Z",
  );
  let ackOutcome: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedNote,
          leaseId: "55555555-5555-4555-8555-5555555555c4",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackOutcome = request.outcome;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    routeMode: "split",
    deferOverChars: 100,
    pendingMainQueue: {
      async enqueue() {
        throw new Error("an under-threshold note must stay on the worker path");
      },
    },
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(ackOutcome, "observed");
  assert.equal(journal.record.active, null);
});

test("routed-main kill-between ordering: a pending persist failure leaves the lease unacked", async () => {
  const journal = new MemoryDeliveryJournal();
  const store = new MemoryStore();
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa93",
    "2026-07-30T00:00:01.000Z",
  );
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedAsk,
          leaseId: "55555555-5555-4555-8555-555555555593",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery() {
        ackCalls += 1;
        throw new Error("mutation: ACK ran before the pending write completed");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    routeMode: "main",
    deferOverChars: null,
    pendingMainQueue: {
      async enqueue() {
        throw new Error("simulated crash before pending queue persistence");
      },
    },
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "fatal");
  assert.match(
    stop.reason === "fatal" ? stop.error.message : "",
    /simulated crash before pending queue persistence/,
  );
  assert.equal(ackCalls, 0, "mutation: moving ACK before enqueue makes this 1");
  assert.equal(journal.record.active?.phase, "leased");
  assert.equal(await store.read(claimedAsk.id), null);
});

test("an authoritative claimed signal mismatch fails before engine write or ACK", async () => {
  const journal = new MemoryDeliveryJournal();
  const store = new MemoryStore();
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa17",
    "2026-07-30T00:00:01.000Z",
  );
  store.records.set(claimedAsk.id, {
    version: 2,
    signalId: claimedAsk.id,
    signalKind: "ask",
    effectOrdinal: 0,
    commandId: "reply_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa17_0",
    askBody: "different durable body",
    askUntil: claimedAsk.until,
    senderOwnerRelation: "same_owner",
    state: "received",
    promptAttempts: 0,
    postAttempts: 0,
    replyBody: null,
    replyTruncated: false,
    replySignalId: null,
    failureCode: null,
    updatedAt: "2026-07-30T00:00:00.000Z",
  });
  let ackCalls = 0;
  const model = new FakeModel();
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedAsk,
          leaseId: "55555555-5555-4555-8555-555555555558",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "cross_owner",
        }], 1);
      },
      async ackAgentDelivery() {
        ackCalls += 1;
        throw new Error("must not ACK mismatch");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "fatal");
  assert.match(stop.reason === "fatal" ? stop.error.message : "", /effect.*match/i);
  assert.equal(model.prompts.length, 0);
  assert.equal(ackCalls, 0);
  assert.equal(store.records.get(claimedAsk.id)?.askBody, "different durable body");
  assert.equal(journal.record.active?.phase, "leased");
});

test("ack_pending recovery retries one deterministic ACK body and clears only after success", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa18",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({ signalId: directNote.id, phase: "ack_pending", outcome: "observed" });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const controller = new AbortController();
  const requests: Array<Record<string, unknown>> = [];
  let attempts = 0;
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery(request) {
        requests.push({ ...request, credential: "redacted" });
        attempts += 1;
        if (attempts === 1) throw new DeliveryTransportError("ambiguous ACK");
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:30.000Z"),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return page([], {
        capabilities: {
          senderOwnerRelation: true,
          cursorAfter: true,
          deliveryClaim: false,
          deliveryAck: true,
        },
        pendingDeliveryCount: 1,
      });
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0]?.commandId, active.ack?.commandId);
  assert.equal(journal.record.active, null);
});

test("route=main does not replay a pre-fix observed-note ACK after restart", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac3",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    phase: "ack_pending",
    outcome: "observed",
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const controller = new AbortController();
  let ackCalls = 0;
  const originalClear = journal.clearActive.bind(journal);
  journal.clearActive = async (now) => {
    await originalClear(now);
    controller.abort();
  };
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim waits for the next loop"); },
      async ackAgentDelivery() {
        ackCalls += 1;
        throw new Error("a pre-fix observed ACK must not be sent on the main route");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    routeMode: "main",
    pendingMainQueue: {
      async enqueue() {
        throw new Error("recovery must wait for authoritative redelivery before queueing");
      },
    },
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:01:30.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(ackCalls, 0);
  assert.equal(journal.record.active, null, "redelivery remains available after lease cleanup");
});

test("MAJOR-4: delivery_unavailable at exact lease expiry clears stale state", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    phase: "ack_pending",
    outcome: "observed",
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const controller = new AbortController();
  let reads = 0;
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const originalClear = journal.clearActive.bind(journal);
  journal.clearActive = async (now) => {
    await originalClear(now);
    controller.abort();
  };
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() {
        throw new DeliveryHttpError(403, "delivery_unavailable", "unavailable");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:01:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return page([], {
        capabilities: {
          senderOwnerRelation: true,
          cursorAfter: true,
          deliveryClaim: false,
          deliveryAck: true,
        },
        pendingDeliveryCount: 1,
      });
    },
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "MAJOR-4 exact lease deadline must be stale rather than credential loss",
  );
  assert.equal(journal.record.active, null);
});

test("MAJOR-4: delivery_unavailable before lease expiry remains credential loss", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad4",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    phase: "ack_pending",
    outcome: "observed",
    leasedUntil: "2026-07-30T00:15:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() {
        throw new DeliveryHttpError(403, "delivery_unavailable", "unavailable");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    now: () => Date.parse("2026-07-30T00:02:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(stop.reason, "credential");
  assert.equal(journal.record.active?.phase, "ack_pending");
});

test("ACK-only rollback waits past a recovered nonterminal lease before clearing and rewinding", async () => {
  const signalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20";
  const active = leasedActive({
    signalId,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const controller = new AbortController();
  let clock = Date.parse("2026-07-30T00:00:00.000Z");
  const delays: number[] = [];
  const cursors: Array<SignalCursor | null> = [];
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() { throw new Error("ACK must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    now: () => clock,
    sleep: async (ms) => {
      delays.push(ms);
      clock += ms;
    },
    readPage: async ({ after }) => {
      cursors.push(after);
      reads += 1;
      if (reads > 1) controller.abort();
      return page([], {
        capabilities: {
          senderOwnerRelation: true,
          cursorAfter: true,
          deliveryClaim: false,
          deliveryAck: true,
        },
        pendingDeliveryCount: 1,
      });
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.ok(delays.some((delay) => delay >= 90_000));
  assert.equal(journal.record.active, null);
  assert.deepEqual(cursors.slice(0, 2), [null, null]);
});

test("caller abort during claim retry sleep starts no later delivery request", async () => {
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  let claimCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claimCalls += 1;
        throw new DeliveryTransportError("ambiguous claim");
      },
      async ackAgentDelivery() { throw new Error("ACK must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    sleep: async () => {
      controller.abort();
    },
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(claimCalls, 1);
  assert.equal(journal.record.active?.phase, "claim_pending");
});

test("caller abort during ACK retry sleep starts no later ACK request", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({ signalId: directNote.id, phase: "ack_pending", outcome: "observed" });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const controller = new AbortController();
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() {
        ackCalls += 1;
        throw new DeliveryTransportError("ambiguous ACK");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:30.000Z"),
    sleep: async () => {
      controller.abort();
    },
    readPage: async () => page([], {
      capabilities: {
        senderOwnerRelation: true,
        cursorAfter: true,
        deliveryClaim: false,
        deliveryAck: true,
      },
      pendingDeliveryCount: 1,
    }),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(ackCalls, 1);
  assert.equal(journal.record.active?.phase, "ack_pending");
});

test("a lease beyond the fixed server maximum fails before effect work", async () => {
  const journal = new MemoryDeliveryJournal();
  const model = new FakeModel();
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22",
    "2026-07-30T00:00:01.000Z",
  );
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedAsk,
          leaseId: "55555555-5555-4555-8555-555555555559",
          leasedUntil: "2026-07-30T00:15:00.001Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery() { throw new Error("ACK must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "fatal");
  assert.match(stop.reason === "fatal" ? stop.error.message : "", /lease deadline/);
  assert.equal(model.prompts.length, 0);
  assert.equal(journal.record.active?.phase, "claim_pending");
});

test("MAJOR-4: a mid-run expired lease 403 clears stale state without credential stop", async () => {
  const oldNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa23",
    "2026-07-30T00:00:01.000Z",
  );
  const oldActive = leasedActive({
    signalId: oldNote.id,
    phase: "ack_pending",
    outcome: "observed",
    leasedUntil: "2026-07-30T00:10:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(oldActive);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: oldNote.id,
    body: oldNote.body,
    until: oldNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const newNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa24",
    "2026-07-30T00:00:03.000Z",
  );
  let clock = Date.parse("2026-07-30T00:00:00.000Z");
  let ackCalls = 0;
  let reads = 0;
  const controller = new AbortController();
  const originalClear = journal.clearActive.bind(journal);
  let clears = 0;
  journal.clearActive = async (now) => {
    clears += 1;
    await originalClear(now);
    if (clears > 1) controller.abort();
  };
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: newNote,
          leaseId: "55555555-5555-4555-8555-555555555560",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        if (ackCalls === 1) {
          return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
        }
        clock = Date.parse("2026-07-30T00:16:00.000Z");
        throw new DeliveryHttpError(403, "delivery_unavailable", "unavailable");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => clock,
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads === 1) {
        return page([], {
          capabilities: {
            senderOwnerRelation: true,
            cursorAfter: true,
            deliveryClaim: false,
            deliveryAck: true,
          },
          pendingDeliveryCount: 1,
        });
      }
      return durablePage([], 1);
    },
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "MAJOR-4 mid-run stale delivery_unavailable must not report credential loss",
  );
  assert.equal(clears, 2);
  assert.equal(journal.record.active, null);
});

test("runtime refuses old edges before starting or prompting a model", async () => {
  const model = new FakeModel();
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    readPage: async () =>
      page([], {
        capabilities: {
          senderOwnerRelation: false,
          cursorAfter: true,
          deliveryClaim: false,
          deliveryAck: false,
        },
      }),
  });
  assert.equal(stop.reason, "fatal");
  assert.match(
    stop.reason === "fatal" ? stop.error.message : "",
    /does not prove sender ownership/,
  );
  assert.equal(model.starts, 0);
  assert.equal(model.prompts.length, 0);
  assert.equal(model.closes, 1);
});

test("runtime reports agent read revocation as a credential stop", async () => {
  const model = new FakeModel();
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    readPage: async () => {
      throw new SignalHttpError(403);
    },
  });
  assert.equal(stop.reason, "credential");
  assert.equal(model.starts, 0);
  assert.equal(model.closes, 1);
});

test("runtime drains pages, resets scan cursor, and posts stable replies", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const cursors: Array<SignalCursor | null> = [];
  const first = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    "2026-07-30T00:00:01.000Z",
  );
  const second = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    "2026-07-30T00:00:02.000Z",
  );
  const late = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    "2026-07-30T00:00:00.500Z",
  );
  let reads = 0;
  let bearerCalls = 0;
  const posts: Array<{ body: string; commandId: string }> = [];
  const fetcher = (async () => {
    bearerCalls += 0; // bearer is asserted separately; fetch sees no credential value.
    const body = posts.length === 0 ? "reply-aaa1" : `reply-aaa${posts.length + 1}`;
    return new Response(JSON.stringify({
      status: "accepted",
      ok: true,
      event_ids: [],
      signal: {
        ...first,
        id: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${posts.length + 1}`,
        kind: "note",
        body,
        in_reply_to: first.id,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: {
      async bearer() {
        bearerCalls += 1;
        return "token";
      },
    },
    store,
    model,
    signal: controller.signal,
    pageLimit: 2,
    pollMs: 1,
    fetcher,
    onEvent: (event) => events.push(event),
    sleep: async () => undefined,
    readPage: async ({ after }) => {
      cursors.push(after);
      reads += 1;
      if (reads === 1) return page([first, second]);
      if (reads === 2) return page([], { rawCount: 0, nextCursor: null });
      if (reads === 3) return page([late], { rawCount: 1 });
      controller.abort();
      return page([]);
    },
    poster: {
      async post({ body, commandId }) {
        bearerCalls += 1;
        posts.push({ body, commandId });
        return {
          signalId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${posts.length}`,
        };
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(cursors.slice(0, 4), [
    null,
    { created_at: second.created_at, id: second.id },
    null,
    null,
  ]);
  assert.deepEqual(model.prompts.map((item) => item.id), [
    first.id,
    second.id,
    late.id,
  ]);
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map((item) => item.commandId)).size, 3);
  assert.ok(bearerCalls >= reads + posts.length);
  assert.equal(events.filter((event) => event.type === "ready").length, 1);
  assert.equal(model.starts, 1);
  // Abort listener cancels immediately; finally also cancels (at least once).
  assert.ok(model.cancels >= 1);
  assert.equal(model.closes, 1);
});

test("runtime asks the credential session immediately before the real reply post", async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  const callOrder: string[] = [];
  let reads = 0;
  const replyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    callOrder.push(`fetch:${String(init?.headers && (init.headers as Record<string, string>).authorization)}`);
    controller.abort();
    return new Response(JSON.stringify({
      status: "accepted",
      ok: true,
      event_ids: [],
      signal: {
        ...ask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "2026-07-30T00:00:01.000Z"),
        id: replyId,
        kind: "note",
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: {
      async bearer() {
        callOrder.push("bearer");
        return "fresh-token";
      },
    },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    fetcher,
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      return page(
        reads === 1
          ? [ask(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
            "2026-07-30T00:00:01.000Z",
          )]
          : [],
      );
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(callOrder.slice(0, 3), [
    "bearer",
    "bearer",
    "fetch:Bearer fresh-token",
  ]);
});

test("runtime abort cancels model immediately while a hung prompt is pending", async () => {
  const model = new FakeModel();
  let releasePrompt: (() => void) | undefined;
  const hung = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  model.prompt = async () => {
    model.prompts.push({
      id: "hung",
      mode: "worker",
      prompt: "hang",
    });
    await hung;
    return { message: "late", stopReason: "end_turn" as const };
  };
  const controller = new AbortController();
  let cancelAtPrompt = 0;
  const originalCancel = model.cancel.bind(model);
  model.cancel = () => {
    cancelAtPrompt = model.prompts.length;
    originalCancel();
    releasePrompt?.();
  };
  let reads = 0;
  const stopPromise = runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads === 1) {
        return page([
          ask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9", "2026-07-30T00:00:01.000Z"),
        ]);
      }
      return page([]);
    },
    poster: {
      async post() {
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
      },
    },
  });
  // Wait until the hung prompt is entered, then abort while it is still pending.
  for (let i = 0; i < 50 && model.prompts.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(model.prompts.length, 1);
  assert.equal(model.cancels, 0);
  controller.abort();
  const stop = await stopPromise;
  assert.equal(stop.reason, "cancelled");
  // Causal: cancel fired while the hung prompt was in flight (not only in finally after settle).
  assert.equal(cancelAtPrompt, 1);
  assert.ok(model.cancels >= 1);
  assert.equal(model.closes, 1);
});

test("runtime emits only bounded malformed-row metadata", async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    sleep: async () => undefined,
    readPage: async ({ onMalformedRow }) => {
      reads += 1;
      for (let index = 0; index < 5; index += 1) onMalformedRow(index);
      controller.abort();
      return page([]);
    },
  });
  assert.equal(stop.reason, "cancelled");
  const malformed = events.filter((event) => event.type === "malformed_row");
  assert.equal(malformed.length, 3);
  assert.deepEqual(
    malformed.map((event) => Object.keys(event).sort()),
    [
      ["index", "ts", "type"],
      ["index", "ts", "type"],
      ["index", "ts", "type"],
    ],
  );
});

test("default poster credential failures stop as credential with the identical error and no reply fetch", async () => {
  const families = [
    new RenewalReauthorisationRequired(
      "horizon_reached",
      null,
      "renewal reauthorisation required",
    ),
    new RenewalRevoked("forbidden", "credential revoked"),
    new Error("reply credential secret is absent from the store"),
  ] as const;
  for (const [index, thrown] of families.entries()) {
    const model = new FakeModel();
    const store = new MemoryStore();
    let bearerCalls = 0;
    let fetchCalls = 0;
    const theAsk = ask(
      `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac${index}`,
      "2026-07-30T00:00:01.000Z",
    );
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      credentialSession: {
        async bearer() {
          bearerCalls += 1;
          if (bearerCalls === 1) return "token";
          throw thrown;
        },
      },
      store,
      model,
      // A reply fetch would call this; credential acquisition fails first.
      fetcher: (async () => {
        fetchCalls += 1;
        throw new Error("reply fetch must never run");
      }) as typeof fetch,
      sleep: async () => undefined,
      readPage: async () => page([theAsk]),
    });
    assert.equal(stop.reason, "credential");
    assert.equal(
      stop.reason === "credential" && stop.error,
      thrown,
      "the identical credential error must escape",
    );
    assert.equal(fetchCalls, 0, "no reply fetch may occur");
    const record = await store.read(theAsk.id);
    assert.ok(record);
    assert.equal(record.state, "reply_ready");
    assert.equal(record.failureCode, null);
    assert.equal(record.postAttempts, 1);
    assert.equal(model.closes, 1);
  }
});

test("an injected poster throwing typed 401 with hostile text stops as credential, never cancelled", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad0",
    "2026-07-30T00:00:01.000Z",
  );
  const thrown = new CommandHttpError(401, "server says operation cancelled");
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    sleep: async () => undefined,
    readPage: async () => page([theAsk]),
    poster: {
      async post() {
        throw thrown;
      },
    },
  });
  assert.equal(stop.reason, "credential", "typed 401 must stop as credential");
  assert.equal(stop.reason === "credential" && stop.error, thrown);
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "reply_ready");
  assert.equal(record.failureCode, null);
});

test("the default-post HTTP 401/403 path stops as credential, not fatal or cancelled", async () => {
  for (const status of [401, 403]) {
    const model = new FakeModel();
    const store = new MemoryStore();
    const statusIds: Record<number, string> = {
      401: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04",
      403: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05",
    };
    const theAsk = ask(
      statusIds[status]!,
      "2026-07-30T00:00:01.000Z",
    );
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      credentialSession: { async bearer() { return "token"; } },
      store,
      model,
      sleep: async () => undefined,
      readPage: async () => page([theAsk]),
      fetcher: (async () =>
        new Response(
          JSON.stringify({ message: "server says operation cancelled" }),
          {
            status,
            headers: { "content-type": "application/json" },
          },
        )) as typeof fetch,
    });
    assert.equal(stop.reason, "credential", `status ${status}`);
    const record = await store.read(theAsk.id);
    assert.ok(record);
    assert.equal(record.state, "reply_ready", `status ${status}`);
    assert.equal(record.failureCode, null, `status ${status}`);
  }
});

test("a trusted injected poster receives the same closed runtime credential classification", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  let scanCount = 0;
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaf0",
    "2026-07-30T00:00:01.000Z",
  );
  const thrown = new RenewalRevoked("forbidden", "credential revoked mid-reply");
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    sleep: async () => undefined,
    readPage: async () => {
      scanCount += 1;
      if (scanCount > 1) controller.abort();
      return page([theAsk]);
    },
    poster: {
      async post() {
        throw thrown;
      },
    },
  });
  assert.equal(stop.reason, "credential");
  assert.equal(stop.reason === "credential" && stop.error, thrown);
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "reply_ready");
  assert.equal(record.failureCode, null);
});

test("an explicitly already-aborted runtime stays cancelled even for credential-shaped errors", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab00",
    "2026-07-30T00:00:01.000Z",
  );
  const thrown = new RenewalRevoked("forbidden", "credential revoked");
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    sleep: async () => undefined,
    readPage: async () => page([theAsk]),
    poster: {
      async post() {
        // A credential-shaped error surfaces after the caller already aborted:
        // the exact abort state is authoritative, so the stop is cancelled.
        controller.abort();
        throw thrown;
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.notEqual(stop.reason, "credential");
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "reply_ready");
  assert.equal(record.failureCode, null);
});

test("runtime classifies noncredential secret wording only by the closed fleet convention", async () => {
  // Exact fleet wording is credential loss and stops resumable.
  const model = new FakeModel();
  const store = new MemoryStore();
  const exact = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab01",
    "2026-07-30T00:00:01.000Z",
  );
  const exactStop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    sleep: async () => undefined,
    readPage: async () => page([exact]),
    poster: {
      async post() {
        throw new Error("reply credential secret is absent from the store");
      },
    },
  });
  assert.equal(exactStop.reason, "credential");
  assert.equal((await store.read(exact.id))?.state, "reply_ready");

  // Different wording is an ordinary terminal failure, not credential loss.
  const model2 = new FakeModel();
  const store2 = new MemoryStore();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const other = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab02",
    "2026-07-30T00:00:01.000Z",
  );
  let reads = 0;
  const otherStop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: store2,
    model: model2,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads === 1) return page([other]);
      controller.abort();
      return page([]);
    },
    poster: {
      async post() {
        throw new Error("reply credential is missing");
      },
    },
  });
  assert.equal(otherStop.reason, "cancelled", "never a credential stop");
  const failed = events.find(
    (event) => event.type === "effect" && event.signalId === other.id,
  );
  assert.ok(failed && failed.type === "effect");
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureCode, "error");
});

test("the default poster forwards the runtime caller signal and stays bounded", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab03",
    "2026-07-30T00:00:01.000Z",
  );
  let requestSignal: AbortSignal | undefined;
  let fetchStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    fetchStarted?.();
    // Never settles and ignores abort: only caller cancellation bounds it.
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const stopPromise = runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    fetcher,
    sleep: async () => undefined,
    readPage: async () => page([theAsk]),
  });
  await started;
  controller.abort();
  const stop = await Promise.race([
    stopPromise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("runtime did not settle after caller abort")),
        2000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(stop.reason, "cancelled");
  assert.equal(
    requestSignal?.aborted,
    true,
    "the effective request signal must abort with the caller",
  );
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "reply_ready", "the effect must remain resumable");
});

test("an already-aborted runtime caller never starts the reply fetch and stays resumable", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab04",
    "2026-07-30T00:00:01.000Z",
  );
  let fetchCalls = 0;
  model.prompt = async () => {
    controller.abort();
    return { message: "reply", stopReason: "end_turn" as const };
  };
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    fetcher: (async () => {
      fetchCalls += 1;
      throw new Error("no reply fetch after an already-aborted caller");
    }) as typeof fetch,
    sleep: async () => undefined,
    readPage: async () => page([theAsk]),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(fetchCalls, 0, "no reply fetch may occur");
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "reply_ready", "the effect must remain resumable");
});

test("a restart carries the failure run, so the printed remedy cannot erase the alarm", async () => {
  /* The lapse notice tells the operator to stop and start the listener. Seeding a
     fresh run on start made following that advice delete the evidence: the next
     `observed` note then printed `HANDLED: yes` on a provider that was still dead
     -- the 17:12:52 state of the measured 2026-09-03 incident, reached by doing
     exactly what the notice said. Operator-read state is durable by default. */
  const root = await mkdtemp(join(tmpdir(), "cswarm-restart-carry-"));
  const paths = listenerPaths({
    profileId: `profile-${randomUUID()}`,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory: root,
  });
  const ts = "2026-09-03T18:00:00.000Z";
  const runOnce = async (
    body: (
      onEvent: (event: ListenerRuntimeEvent) => void,
    ) => Promise<void>,
  ) =>
    await runListenerSupervisor({
      paths,
      profileId: "profile-test",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      run: async (_signal, onEvent) => {
        onEvent({ type: "ready", workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, ts });
        await body(onEvent);
        return { reason: "cancelled" };
      },
    });

  const first = await runOnce(async (onEvent) => {
    for (const [signalId, at] of [
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab01", "2026-09-03T18:10:00.000Z"],
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab02", "2026-09-03T18:11:00.000Z"],
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab03", "2026-09-03T18:12:00.000Z"],
    ] as const) {
      onEvent({ type: "delivery_ack", signalId, outcome: "failed_terminal", ts: at });
    }
  });
  assert.equal(first.consecutiveAckFailureCount, 3);
  assert.match(renderListenerStatus(first), /WARNING \[listener_delivery_failing\]/);

  /* The restart the notice recommends, observed BEFORE any new ack. A later ack
     would set these fields itself, so asserting them after one would not reach
     the carry at all -- measured: dropping lastAckAt from the carry left that
     version of this test green. */
  const restarted = await runOnce(async () => {});
  assert.equal(restarted.consecutiveAckFailureCount, 3);
  assert.equal(restarted.lastAckOutcome, "failed_terminal");
  assert.equal(restarted.lastAckAt, "2026-09-03T18:12:00.000Z");
  assert.equal(restarted.lastSignalId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab03");
  const restartedHuman = renderListenerStatus(restarted);
  assert.doesNotMatch(restartedHuman, /at an unknown time/);
  assert.doesNotMatch(restartedHuman, /No signal has been handled yet/);

  /* Then one incoming note. */
  const second = await runOnce(async (onEvent) => {
    onEvent({
      type: "delivery_ack",
      signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab04",
      outcome: "observed",
      ts: "2026-09-03T18:20:00.000Z",
    });
  });
  assert.equal(second.lastAckOutcome, "observed");
  assert.equal(second.consecutiveAckFailureCount, 3);
  const human = renderListenerStatus(second);
  assert.doesNotMatch(human, /HANDLED: yes/);
  assert.match(human, /WARNING \[listener_delivery_failing\]/);
  /* The ack record must carry WHOLE. Carrying the outcome without its timestamp
     printed "the newest delivery acknowledgement was ..." above "No signal has
     been handled yet." on one screen. */
  assert.equal(second.lastAckAt, "2026-09-03T18:20:00.000Z");
  assert.doesNotMatch(human, /at an unknown time/);
  assert.doesNotMatch(human, /No signal has been handled yet/);
  /* The remedy is three verbs and is untested elsewhere: `listen stop` returns
     while `stopping`, and `listen start` refuses a stopping listener, so a
     printed `stop && start` pair races. It must also not name a terminal state
     the listener may never reach -- an unclean exit lands on `failed`. */
  assert.match(human, /Next: Read the failure codes in /);
  assert.match(human, /cswarm listen stop --workspace-id [0-9a-f-]+ --principal-id [0-9a-f-]+/);
  assert.match(human, /no longer running -- state stopped or failed, not stopping/);
  assert.match(human, /confirming with: cswarm listen status --workspace-id /);
  assert.doesNotMatch(human, /listen stop[^\n]*&&[^\n]*listen start/);

  /* A real reply still clears it across the same restart boundary. */
  const third = await runOnce(async (onEvent) => {
    onEvent({
      type: "delivery_ack",
      signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab05",
      outcome: "replied",
      ts: "2026-09-03T18:30:00.000Z",
    });
  });
  assert.equal(third.consecutiveAckFailureCount, 0);
  assert.doesNotMatch(renderListenerStatus(third), /listener_delivery_failing/);
  await rm(root, { recursive: true, force: true });
});

test("the outcome sentence names the acknowledged signal, not a newer effect", async () => {
  /* lastSignalId is advanced by `effect` before the ack for that signal lands, so
     for the whole prompt window the status held an older ack's outcome beside a
     newer signal id, and printed "Last failed delivery signal: <the newer one>".
     Found by a Gemini arm on 3b245ed. */
  const root = await mkdtemp(join(tmpdir(), "cswarm-ack-signal-"));
  const paths = listenerPaths({
    profileId: `profile-${randomUUID()}`,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory: root,
  });
  const ts = "2026-09-04T10:00:00.000Z";
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaac01";
  const B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaac02";
  let midWindow: ListenerStatus | undefined;
  const status = await runListenerSupervisor({
    paths,
    profileId: "profile-test",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    run: async (_signal, onEvent) => {
      onEvent({ type: "ready", workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, ts });
      onEvent({ type: "delivery_ack", signalId: A, outcome: "failed_terminal", ts: "2026-09-04T10:01:00.000Z" });
      /* B's effect runs before B's ack: the window the sentence used to lie in. */
      onEvent({
        type: "effect",
        signalId: B,
        status: "done",
        failureCode: null,
        ts: "2026-09-04T10:02:00.000Z",
      });
      midWindow = await queryListenerControl(paths, "status");
      return { reason: "cancelled" };
    },
  });
  assert.ok(midWindow);
  assert.equal(midWindow.lastSignalId, B);
  assert.equal(midWindow.lastAckSignalId, A);
  assert.equal(midWindow.lastAckOutcome, "failed_terminal");
  const human = renderListenerStatus(midWindow);
  assert.match(human, new RegExp(`Last failed delivery signal: ${A}\\.`));
  assert.doesNotMatch(human, new RegExp(`Last failed delivery signal: ${B}`));
  /* A restart carries the ack's own signal id with the rest of the ack record. */
  assert.equal(status.lastAckSignalId, A);
  const carried = await runListenerSupervisor({
    paths,
    profileId: "profile-test",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    run: async () => ({ reason: "cancelled" }),
  });
  assert.equal(carried.lastAckSignalId, A);
  assert.match(renderListenerStatus(carried), new RegExp(`Last failed delivery signal: ${A}\\.`));
  await rm(root, { recursive: true, force: true });
});

test("a status written before lastAckOutcome existed is not called unacknowledged", async () => {
  /* Every fleet listener at the 0.1.51 upgrade has lastAckAt and lastSignalId
     from 0.1.50 and no lastAckOutcome. Restarting it carries the timestamp and
     not the outcome, and a new CLI reading a still-running 0.1.50 listener sees
     the same shape live. Both DID acknowledge something. Found by a Grok arm on
     4992dd8. */
  const root = await mkdtemp(join(tmpdir(), "cswarm-legacy-ack-"));
  const paths = listenerPaths({
    profileId: `profile-${randomUUID()}`,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory: root,
  });
  const ackedAt = "2026-09-02T22:00:00.000Z";
  const signal = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaad01";
  /* A 0.1.50-shaped file: the shape the repo's own legacy-read test uses, plus
     the six delivery keys that version wrote, and none of the new ones. */
  const legacy = {
    version: 1,
    instanceId: randomUUID(),
    provider: "claude",
    profileId: "profile-test",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    pid: 4242,
    state: "stopped",
    startedAt: "2026-09-02T21:00:00.000Z",
    readyAt: "2026-09-02T21:00:05.000Z",
    updatedAt: ackedAt,
    stoppedAt: "2026-09-02T23:00:00.000Z",
    lastSignalId: signal,
    lastErrorCode: null,
    lastErrorDetail: null,
    lastWorkerStderrTail: null,
    logPath: paths.logPath,
    deliveryMode: "durable_claim",
    pendingDeliveryCount: null,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: ackedAt,
    lastAckAt: ackedAt,
    routeMode: "worker",
  };
  await writeSecureJsonFile(paths.statusPath, JSON.stringify(legacy));

  /* The new CLI reading the old file, no restart. */
  const asRead = await readListenerStatus(paths);
  assert.ok(asRead);
  assert.equal(asRead.lastAckAt, ackedAt);
  assert.equal(asRead.lastAckOutcome, null);
  const readHuman = renderListenerStatus(asRead);
  assert.doesNotMatch(readHuman, /No delivery acknowledgement is recorded/);
  assert.match(readHuman, new RegExp(`An acknowledgement was recorded at ${ackedAt}; its outcome was not recorded\\.`));
  assert.match(readHuman, /HANDLED: not yet measured/);

  /* The restart the upgrade implies: the carry brings lastAckAt, not an outcome. */
  const restarted = await runListenerSupervisor({
    paths,
    profileId: "profile-test",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    run: async () => ({ reason: "cancelled" }),
  });
  assert.equal(restarted.lastAckAt, ackedAt);
  assert.equal(restarted.lastAckOutcome, null);
  const restartedHuman = renderListenerStatus(restarted);
  assert.doesNotMatch(restartedHuman, /No delivery acknowledgement is recorded/);
  assert.match(restartedHuman, /its outcome was not recorded\./);
  await rm(root, { recursive: true, force: true });
});

/* Head-of-line blocking, measured 2026-09-04 on the lead's own seat: one
 * open-ended ask used the whole 10-minute turn budget and every later delivery
 * to that seat waited behind it. Two of the five asks in that hour were
 * byte-identical re-sends 1 to 6 minutes apart, because nothing showed the
 * sender that the seat was busy. These three tests pin the bound, the fields
 * that make the queue visible, and the receipt the release must not destroy. */

const HOLD_FIRST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab01";
const HOLD_SECOND_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab02";

/** A worker that consumes the whole seat budget on one signal and yields nothing. */
class SeatHoggingModel implements ListenerRuntimeModel {
  starts = 0;
  closes = 0;
  cancels = 0;
  readonly prompts: string[] = [];
  constructor(
    private readonly hogSignalId: string,
    private readonly burn: () => void,
  ) {}
  async start() {
    this.starts += 1;
  }
  async prompt(signal: SignalRecord, _mode: ListenerPromptMode) {
    this.prompts.push(signal.id);
    if (signal.id === this.hogSignalId) {
      this.burn();
      // What a wedged ACP child produces: a transient timeout, so the ask stays
      // retryable and the pre-bound loop would keep the seat for the lease.
      throw new AcpHostError("timeout", "worker turn timed out");
    }
    return {
      message: `reply-${signal.id.slice(-4)}`,
      stopReason: "end_turn" as const,
    };
  }
  cancel() {
    this.cancels += 1;
  }
  async close() {
    this.closes += 1;
  }
}

test("a delivery that spends its hold budget hands the seat to the next delivery", async () => {
  const first = ask(HOLD_FIRST_ID, "2026-07-30T00:00:01.000Z");
  const second = ask(HOLD_SECOND_ID, "2026-07-30T00:00:02.000Z");
  const holdBudgetMs = 600_000;
  const start = Date.parse("2026-07-30T00:00:00.000Z");
  let clock = start;
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const model = new SeatHoggingModel(first.id, () => {
    clock += holdBudgetMs;
  });
  let claims = 0;
  let acked: Array<{ signalId: string; outcome: DeliveryOutcome }> = [];
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryHoldBudgetMs: holdBudgetMs,
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        // The lease outlasts the hold budget on purpose: without the bound the
        // seat stays on the first delivery for the whole 15-minute lease.
        const row: DeliveryRow = claims === 1
          ? {
            signal: first,
            leaseId: "55555555-5555-4555-8555-555555555b01",
            leasedUntil: "2026-07-30T00:15:00.000Z",
            senderOwnerRelation: "same_owner",
          }
          : {
            signal: second,
            leaseId: "55555555-5555-4555-8555-555555555b02",
            leasedUntil: "2026-07-30T00:25:00.000Z",
            senderOwnerRelation: "same_owner",
          };
        return claimResult([row], claims === 1 ? 2 : 1);
      },
      async ackAgentDelivery(request) {
        acked.push({ signalId: request.signalId, outcome: request.outcome });
        controller.abort();
        return {
          httpStatus: 200,
          signalId: request.signalId,
          outcome: request.outcome,
        };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    poster: {
      async post() {
        return { signalId: "66666666-6666-4666-8666-666666666b02" };
      },
    },
    signal: controller.signal,
    now: () => clock,
    sleep: async () => undefined,
    readPage: async () => durablePage([], 2),
    onEvent: (event) => events.push(event),
  });

  assert.equal(
    stop.reason,
    "cancelled",
    stop.reason === "fatal" ? `stopped fatally: ${stop.error.message}` : "",
  );
  // The bound, stated as the reader reads it: the second delivery reached the
  // worker, and it did so without waiting out the first delivery's lease.
  assert.deepEqual(model.prompts, [first.id, second.id]);
  const released = events.filter(
    (event): event is Extract<
      ListenerRuntimeEvent,
      { type: "delivery_hold_released" }
    > => event.type === "delivery_hold_released",
  );
  assert.equal(released.length, 1);
  assert.equal(released[0]!.signalId, first.id);
  assert.equal(released[0]!.reason, "hold_budget");
  assert.equal(released[0]!.heldMs, holdBudgetMs);
  assert.ok(
    clock < Date.parse("2026-07-30T00:15:00.000Z"),
    "the seat moved on before the first delivery's lease expired",
  );
  // The released delivery keeps its lease and its receipt: only the second one
  // is acknowledged, so its sender still reads a delivery in progress.
  assert.deepEqual(acked, [{ signalId: second.id, outcome: "replied" }]);
});

test("the released delivery is not acknowledged with any outcome", async () => {
  // Generated from the wire vocabulary, so a new outcome cannot slip past this
  // by being absent from a typed list.
  const outcomes = [...DELIVERY_ACK_OUTCOMES];
  assert.ok(outcomes.includes("observed"));
  const first = ask(HOLD_FIRST_ID, "2026-07-30T00:00:01.000Z");
  const holdBudgetMs = 300_000;
  let clock = Date.parse("2026-07-30T00:00:00.000Z");
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const model = new SeatHoggingModel(first.id, () => {
    clock += holdBudgetMs;
  });
  const ackOutcomes: string[] = [];
  let claims = 0;
  await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryHoldBudgetMs: holdBudgetMs,
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        if (claims > 1) {
          controller.abort();
          return claimResult([], 1);
        }
        return claimResult([{
          signal: first,
          leaseId: "55555555-5555-4555-8555-555555555b03",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackOutcomes.push(request.outcome);
        return {
          httpStatus: 200,
          signalId: request.signalId,
          outcome: request.outcome,
        };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    poster: { async post() { throw new Error("no reply is ready"); } },
    signal: controller.signal,
    now: () => clock,
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(ackOutcomes, []);
  assert.equal(journal.record.active, null);
  const releases = events.filter((event): event is Extract<
    ListenerRuntimeEvent,
    { type: "delivery_hold_released" }
  > => event.type === "delivery_hold_released");
  assert.equal(releases.length, 1);
  /* Name WHICH bound fired. Asserting only that some release happened let this
     test stay green with the seat bound removed, because the lease bound can
     release too; the reason is what separates them. */
  assert.equal(releases[0]!.reason, "hold_budget");
  assert.ok(releases[0]!.heldMs >= holdBudgetMs, String(releases[0]!.heldMs));
});

test("listen status shows the delivery in hand and how long the queue has waited", () => {
  const claimedAt = "2026-07-30T00:00:00.000Z";
  const nowMs = Date.parse("2026-07-30T00:04:00.000Z");
  const status = {
    version: 1,
    instanceId: "44444444-4444-4444-8444-444444444444",
    pid: 4242,
    profileId: "profile-hold",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    provider: "claude",
    state: "ready",
    startedAt: claimedAt,
    readyAt: claimedAt,
    updatedAt: claimedAt,
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    lastErrorReasonCode: null,
    providerExecutable: null,
    providerVersion: null,
    providerLastMeasuredVersion: null,
    providerBundledAgentSdkVersion: null,
    providerBundledClaudeCodeVersion: null,
    providerMinimumRequiredVersion: null,
    lastWorkerStderrTail: null,
    deliveryMode: "durable_claim",
    pendingDeliveryCount: 3,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: claimedAt,
    lastAckAt: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: null,
    currentDeliverySignalId: HOLD_FIRST_ID,
    currentDeliverySince: claimedAt,
    heldBackDeliveries: [],
    pendingDeliveryCountAt: claimedAt,
    routeMode: "worker",
    deferOverChars: null,
    pendingForMainCount: 0,
    droppedForMainCount: 0,
    logPath: "/tmp/cswarm-hold/listener.log",
  } as unknown as ListenerStatus;

  const evidence = {
    pendingForMainOldestAt: null,
    hookSurfaceExists: false,
    hookSurfaceAdvanced: false,
  };
  const json = listenerStatusJson(status, undefined, evidence, nowMs);
  assert.equal(json.currentDeliverySignalId, HOLD_FIRST_ID);
  assert.equal(json.currentDeliverySince, claimedAt);
  assert.equal(json.currentDeliveryElapsedMs, 240_000);
  assert.deepEqual(json.heldBackDeliveries, []);
  assert.equal(json.heldBackDeliveryCount, 0);
  assert.equal(json.pendingDeliveryCountAt, claimedAt);

  const human = renderListenerStatus(status, evidence, nowMs);
  assert.ok(
    human.includes(`Working on delivery ${HOLD_FIRST_ID}, claimed 4m ago.`),
    human,
  );
  // The pending count carries the age of the observation that produced it.
  assert.ok(
    human.includes(
      "Pending deliveries reported by the service: 3. The service reported that 4m ago.",
    ),
    human,
  );
  /* An undated count is named as undated. An arm reached this window by killing
     a listener after the delivery-mode event and before its first claim. */
  const undated = renderListenerStatus(
    { ...status, pendingDeliveryCountAt: null },
    evidence,
    nowMs,
  );
  assert.ok(
    undated.includes(
      "Pending deliveries reported by the service: 3. When the service reported it was not recorded.",
    ),
    undated,
  );
  /* No waiting-to-be-claimed number is rendered at all. Two review rounds
     refuted every form of it; the retired wordings are named in cli.ts. */
  assert.ok(!human.includes("waiting behind it"), human);
  assert.ok(!human.includes("waiting to be claimed"), human);
  assert.ok(!human.includes("waited at least"), human);
  assert.ok(!human.includes("empty queue"), human);

  /* Each release reason gets its own clause, generated from the constant the
     runtime emits. A typed sentence said "used its turn budget" for both, which
     is false for lease_budget: that release runs no turn at all. */
  for (const reason of LISTENER_DELIVERY_HOLD_RELEASE_REASONS) {
    const heldBack = renderListenerStatus({
      ...status,
      pendingDeliveryCount: 2,
      currentDeliverySignalId: null,
      currentDeliverySince: null,
      heldBackDeliveries: [{ signalId: HOLD_FIRST_ID, at: claimedAt, reason }],
    }, evidence, nowMs);
    assert.ok(
      heldBack.includes(
        `Delivery ${HOLD_FIRST_ID} was handed back 4m ago because ${
          LISTENER_DELIVERY_HOLD_RELEASE_CLAUSES[reason]
        }.`,
      ),
      heldBack,
    );
    /* Past tense only: the retired clause claimed the row still sat with the
       service, which is false once the service expires and acknowledges it. */
    assert.ok(!heldBack.includes("stays with the service"), heldBack);
    /* The retired clause verbatim, not the phrase "comes back": the lease_budget
       remedy legitimately says the row comes back under a new lease. A negative
       control has to name what was retired, or it outlaws correct wording. */
    assert.ok(
      !heldBack.includes("which decides when it comes back"),
      heldBack,
    );
    assert.ok(
      heldBack.includes(
        "This listener has not answered it. After the lease ends the service either delivers it again or terminates it. If this repeats, " +
          `${LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES[reason]}.`,
      ),
      heldBack,
    );
    /* The swap control: this reason's line must NOT carry the other reason's
       remedy. A single shared remedy passed a per-reason assertion that only
       checked "the right text is present"; it fails only when the wrong text is
       also required to be absent. */
    for (const other of LISTENER_DELIVERY_HOLD_RELEASE_REASONS) {
      if (other === reason) continue;
      assert.ok(
        !heldBack.includes(LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES[other]),
        `${reason} carried the ${other} remedy: ${heldBack}`,
      );
      assert.ok(
        !heldBack.includes(LISTENER_DELIVERY_HOLD_RELEASE_CLAUSES[other]),
        `${reason} carried the ${other} clause: ${heldBack}`,
      );
    }
    /* No command is printed. The line renders only while the listener is ready
       or stopping, and `listen start` refuses in exactly those states, so a
       start command here would be refused by the process that printed it. */
    assert.ok(!heldBack.includes("cswarm listen start"), heldBack);
    /* The retired remedy named `cswarm receipt <id>`: not runnable as printed,
       because that verb requires an agent credential, and refused even with
       one, because the receipt read is author-only and this listener is the
       recipient. A remedy that names a command the reader cannot run is the
       same defect class as a typed enumeration inside a correct sentence. */
    assert.ok(!heldBack.includes("cswarm receipt"), heldBack);
    assert.ok(!heldBack.includes("still tracking"), heldBack);
  }
  for (
    const generated of [
      LISTENER_DELIVERY_HOLD_RELEASE_CLAUSES,
      LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES,
    ]
  ) {
    assert.equal(
      new Set(Object.values(generated)).size,
      LISTENER_DELIVERY_HOLD_RELEASE_REASONS.length,
      "each reason needs its own wording, or the sentence stops discriminating",
    );
  }
  /* Only hold_budget names a setting. --turn-budget IS the seat bound, so
     raising it is the answer there; lease_budget needs nothing changed, because
     the row returns under a new lease of full length. A shared remedy gave half
     the vocabulary advice that cannot prevent its own release. */
  assert.ok(
    LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES.hold_budget.includes(
      "a larger --turn-budget",
    ),
    LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES.hold_budget,
  );
  assert.ok(
    !LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES.lease_budget.includes(
      "--turn-budget",
    ),
    "a lease_budget release is not fixed by changing the turn budget",
  );

  // More than one can be held back at once, so the extras are counted.
  const twoHeldBack = renderListenerStatus({
    ...status,
    pendingDeliveryCount: 2,
    currentDeliverySignalId: null,
    currentDeliverySince: null,
    heldBackDeliveries: [
      { signalId: HOLD_SECOND_ID, at: claimedAt, reason: "hold_budget" },
      { signalId: HOLD_FIRST_ID, at: claimedAt, reason: "lease_budget" },
    ],
  }, evidence, nowMs);
  assert.ok(
    twoHeldBack.includes(
      "This listener is still tracking 1 other handed-back delivery.",
    ),
    twoHeldBack,
  );
  /* At the cap the count still describes the set, so it stays true. The retired
     wording claimed every hand-back, which a capped set cannot know. */
  const atCap = renderListenerStatus({
    ...status,
    currentDeliverySignalId: null,
    currentDeliverySince: null,
    heldBackDeliveries: Array.from({ length: 16 }, (_unused, index) => ({
      signalId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "b")}`,
      at: claimedAt,
      reason: "hold_budget" as const,
    })),
  }, evidence, nowMs);
  assert.ok(
    atCap.includes("This listener is still tracking 15 other handed-back deliveries."),
    atCap,
  );

  const idle = renderListenerStatus({
    ...status,
    pendingDeliveryCount: 0,
    currentDeliverySignalId: null,
    currentDeliverySince: null,
  }, evidence, nowMs);
  assert.ok(idle.includes("No delivery is being worked on right now."), idle);
  assert.ok(!idle.includes("was handed back"), idle);
});

test("a fast first failure keeps the seat and retries inside the hold budget", async () => {
  /* Measured on a live listener started with --turn-budget 30s: a projected
   * bound (now + one phase minimum against the deadline) released the seat
   * after 74ms, because one phase minimum is about four minutes and never fits
   * inside a 30s budget. The delivery lost its retry budget without using any
   * of its seat time. The bound is elapsed hold, so this retries. */
  const first = ask(HOLD_FIRST_ID, "2026-07-30T00:00:01.000Z");
  const holdBudgetMs = 30_000;
  let clock = Date.parse("2026-07-30T00:00:00.000Z");
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const prompts: string[] = [];
  let failures = 0;
  const model: ListenerRuntimeModel = {
    async start() {},
    async prompt(signal: SignalRecord) {
      prompts.push(signal.id);
      failures += 1;
      if (failures === 1) {
        // A worker child that dies in milliseconds: retryable, and nowhere near
        // the seat budget.
        clock += 74;
        throw new AcpHostError("child_exit", "worker child exited");
      }
      return {
        message: `reply-${signal.id.slice(-4)}`,
        stopReason: "end_turn" as const,
      };
    },
    cancel() {},
    async close() {},
  };
  const acked: string[] = [];
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryHoldBudgetMs: holdBudgetMs,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: first,
          leaseId: "55555555-5555-4555-8555-555555555b04",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
        }], 1);
      },
      async ackAgentDelivery(request) {
        acked.push(request.outcome);
        controller.abort();
        return {
          httpStatus: 200,
          signalId: request.signalId,
          outcome: request.outcome,
        };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    poster: {
      async post() {
        return { signalId: "66666666-6666-4666-8666-666666666b04" };
      },
    },
    signal: controller.signal,
    now: () => clock,
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
    onEvent: (event) => events.push(event),
  });

  assert.equal(
    stop.reason,
    "cancelled",
    stop.reason === "fatal" ? `stopped fatally: ${stop.error.message}` : "",
  );
  assert.deepEqual(prompts, [first.id, first.id]);
  assert.deepEqual(acked, ["replied"]);
  assert.equal(
    events.filter((event) => event.type === "delivery_hold_released").length,
    0,
    "74ms of a 30s seat budget is not a spent budget",
  );
});

test("a stopped listener does not claim to be working on a delivery", async (t) => {
  /* The status file outlives the process. Without clearing the held delivery on
   * the terminal transition, `cswarm listen status` on a listener that stopped
   * mid-turn reads "Working on delivery X, claimed 3h ago" about a process that
   * no longer exists. */
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-hold-stop-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const paths = listenerPaths({
    profileId: "profile-hold-stop",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  await runListenerSupervisor({
    paths,
    profileId: "profile-hold-stop",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    run: async (_signal, onEvent) => {
      onEvent({
        type: "delivery_claim",
        signalId: HOLD_FIRST_ID,
        pendingDeliveryCount: 2,
        terminalDeliveryFailureCount: 0,
        ts: "2026-07-30T00:00:00.000Z",
      });
      const held = await queryListenerControl(paths, "status");
      assert.equal(held.currentDeliverySignalId, HOLD_FIRST_ID);
      assert.equal(held.currentDeliverySince, "2026-07-30T00:00:00.000Z");
      return { reason: "cancelled" as const };
    },
  });

  const stopped = await readListenerStatus(paths);
  assert.equal(stopped?.state, "stopped");
  assert.equal(stopped?.currentDeliverySignalId, null);
  assert.equal(stopped?.currentDeliverySince, null);
  /* The held-back facts go too: their sentences are rendered against READ time,
     so a process that stopped observing three hours ago would still report on
     them in the present tense. Both review arms raised this on 33cd24b. */
  assert.deepEqual(stopped?.heldBackDeliveries, []);
  const human = renderListenerStatus(stopped!, {
    pendingForMainOldestAt: null,
    hookSurfaceExists: false,
    hookSurfaceAdvanced: false,
  }, Date.parse("2026-07-30T03:00:00.000Z"));
  assert.ok(!human.includes("Working on delivery"), human);
  assert.ok(human.includes("No delivery is being worked on right now."), human);
  assert.ok(!human.includes("was handed back"), human);
  /* The pending count survives, and its own sentence dates it: both arms said
     an undated count on a listener that died hours ago reads as current. */
  assert.ok(human.includes("The service reported that 3h ago."), human);
});

test("the supervisor tracks a handed-back delivery until it comes back", async (t) => {
  /* Not a string test: this drives the supervisor's event handling and reads
   * the live control socket, so it pins the state machine both review arms
   * attacked on 33cd24b. */
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-hold-track-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const paths = listenerPaths({
    profileId: "profile-hold-track",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  const seen: Array<{
    step: string;
    heldBack: readonly string[];
    current: string | null | undefined;
    heldBackLine: string | undefined;
  }> = [];
  await runListenerSupervisor({
    paths,
    profileId: "profile-hold-track",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    run: async (_signal, onEvent) => {
      const record = async (step: string) => {
        const snapshot = await queryListenerControl(paths, "status");
        seen.push({
          step,
          heldBack: (snapshot.heldBackDeliveries ?? []).map((entry) =>
            entry.signalId
          ),
          current: snapshot.currentDeliverySignalId,
          heldBackLine: renderListenerStatus(snapshot, {
            pendingForMainOldestAt: null,
            hookSurfaceExists: false,
            hookSurfaceAdvanced: false,
          }, Date.parse("2026-07-30T00:05:00.000Z")).split("\n").find((line) =>
            line.includes("was handed back")
          ),
        });
      };
      onEvent({
        type: "delivery_claim",
        signalId: HOLD_FIRST_ID,
        pendingDeliveryCount: 2,
        terminalDeliveryFailureCount: 0,
        ts: "2026-07-30T00:00:00.000Z",
      });
      await record("claimed first");
      onEvent({
        type: "delivery_hold_released",
        signalId: HOLD_FIRST_ID,
        reason: "hold_budget",
        heldMs: 600_000,
        ts: "2026-07-30T00:00:01.000Z",
      });
      await record("released first");
      onEvent({
        type: "delivery_claim",
        signalId: HOLD_SECOND_ID,
        pendingDeliveryCount: 2,
        terminalDeliveryFailureCount: 0,
        ts: "2026-07-30T00:00:02.000Z",
      });
      await record("claimed second");
      /* Two live held-back leases at once: the count grows and the newest one
         is named. A review arm built exactly this sequence against a version
         that tracked one id and derived a waiting count from it. */
      onEvent({
        type: "delivery_hold_released",
        signalId: HOLD_SECOND_ID,
        reason: "lease_budget",
        heldMs: 1_000,
        ts: "2026-07-30T00:00:03.000Z",
      });
      await record("released second");
      /* An empty claim while only held-back rows are pending. The status must
         not start calling them claimable, and must not forget them either. */
      onEvent({
        type: "delivery_claim",
        signalId: null,
        pendingDeliveryCount: 2,
        terminalDeliveryFailureCount: 0,
        ts: "2026-07-30T00:00:04.000Z",
      });
      await record("empty claim");
      /* A zero pending count is NOT evidence that a held-back row is gone. The
         service counts unacked rows whose signal until is still live, and
         unleases only once the lease deadline passes, so a hand-back whose TTL
         elapsed under its live lease is still leased, still unacked, and not in
         that count. Both round-4 arms proved this from the SQL against a
         version that trimmed the set to the count. */
      onEvent({
        type: "delivery_claim",
        signalId: null,
        pendingDeliveryCount: 0,
        terminalDeliveryFailureCount: 0,
        ts: "2026-07-30T00:00:05.000Z",
      });
      await record("zero pending count");
      return { reason: "cancelled" as const };
    },
  });

  assert.deepEqual(
    seen.map((entry) => [entry.step, entry.heldBack, entry.current]),
    [
      ["claimed first", [], HOLD_FIRST_ID],
      ["released first", [HOLD_FIRST_ID], null],
      ["claimed second", [HOLD_FIRST_ID], HOLD_SECOND_ID],
      /* Both are held back at once. A version that kept only the newest id
         forgot the first one as soon as the second was reclaimed. */
      ["released second", [HOLD_SECOND_ID, HOLD_FIRST_ID], null],
      ["empty claim", [HOLD_SECOND_ID, HOLD_FIRST_ID], null],
      ["zero pending count", [HOLD_SECOND_ID, HOLD_FIRST_ID], null],
    ],
  );
  assert.ok(
    seen[3]!.heldBackLine?.includes(
      `Delivery ${HOLD_SECOND_ID} was handed back 5m ago because ${
        LISTENER_DELIVERY_HOLD_RELEASE_CLAUSES.lease_budget
      }.`,
    ),
    seen[3]!.heldBackLine,
  );
  assert.ok(
    seen[3]!.heldBackLine?.includes(
      "This listener is still tracking 1 other handed-back delivery.",
    ),
    seen[3]!.heldBackLine,
  );
  // An empty claim with rows still pending keeps them named.
  assert.equal(seen[4]!.heldBackLine, seen[3]!.heldBackLine);
  // So does a zero count: it is not evidence about a live-leased hand-back.
  assert.equal(seen[5]!.heldBackLine, seen[3]!.heldBackLine);
  // At no point is any of them described as waiting to be claimed.
  assert.equal(
    seen.some((entry) => entry.heldBackLine?.includes("waiting")),
    false,
  );
});

test("the pending count never trims the held-back set", async (t) => {
  /* An earlier version trimmed the set to the service's pending count, on the
   * argument that every held-back row is unacked so the count bounds them. Both
   * round-4 arms refuted it from the server SQL, and it is wrong in BOTH
   * directions. durable-delivery.ts step 7 counts unacked rows whose signal
   * `until > statement_timestamp()`; step 2 unleases only when
   * `leased_until <= statement_timestamp()`. So a hand-back whose TTL elapses
   * under its live lease is still leased, still unacked, and NOT counted -- a
   * low count dropped rows that were still held back, and because the set is
   * newest first the slice discarded the oldest, the one most likely to be
   * live. The count also includes rows that were never held back, so it could
   * sit above the set and trim nothing. */
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-hold-trim-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const paths = listenerPaths({
    profileId: "profile-hold-trim",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  const held: string[][] = [];
  await runListenerSupervisor({
    paths,
    profileId: "profile-hold-trim",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    run: async (_signal, onEvent) => {
      const record = async () => {
        const snapshot = await queryListenerControl(paths, "status");
        held.push((snapshot.heldBackDeliveries ?? []).map((e) => e.signalId));
      };
      for (const [signalId, ts] of [
        [HOLD_FIRST_ID, "2026-07-30T00:00:00.000Z"],
        [HOLD_SECOND_ID, "2026-07-30T00:00:01.000Z"],
      ] as const) {
        onEvent({
          type: "delivery_claim",
          signalId,
          pendingDeliveryCount: 2,
          terminalDeliveryFailureCount: 0,
          ts,
        });
        onEvent({
          type: "delivery_hold_released",
          signalId,
          reason: "hold_budget",
          heldMs: 600_000,
          ts,
        });
      }
      await record();
      /* The service reports ONE unacked live row, then none. Neither number is
         evidence about either hand-back, so the set does not move. */
      for (const [pending, ts] of [
        [1, "2026-07-30T00:00:02.000Z"],
        [0, "2026-07-30T00:00:03.000Z"],
      ] as const) {
        onEvent({
          type: "delivery_claim",
          signalId: null,
          pendingDeliveryCount: pending,
          terminalDeliveryFailureCount: 0,
          ts,
        });
        await record();
      }
      /* Its OWN evidence does move it: this claim returned the older row. */
      onEvent({
        type: "delivery_claim",
        signalId: HOLD_FIRST_ID,
        pendingDeliveryCount: 1,
        terminalDeliveryFailureCount: 0,
        ts: "2026-07-30T00:00:04.000Z",
      });
      await record();
      return { reason: "cancelled" as const };
    },
  });

  assert.deepEqual(held, [
    [HOLD_SECOND_ID, HOLD_FIRST_ID],
    [HOLD_SECOND_ID, HOLD_FIRST_ID],
    [HOLD_SECOND_ID, HOLD_FIRST_ID],
    [HOLD_SECOND_ID],
  ]);
});

test("a pending count from the delivery-mode event is dated too", async (t) => {
  /* The exact arm sequence: the mode event writes pendingDeliveryCount from the
   * read page and never writes lastClaimAt, so dating the sentence from
   * lastClaimAt left this window undated. On a process killed here the line
   * read as a current count. */
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-hold-mode-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const paths = listenerPaths({
    profileId: "profile-hold-mode",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  let duringRun: ListenerStatus | null = null;
  await runListenerSupervisor({
    paths,
    profileId: "profile-hold-mode",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    run: async (_signal, onEvent) => {
      onEvent({
        type: "delivery_mode",
        mode: "durable_claim",
        pendingDeliveryCount: 3,
        ts: "2026-07-30T00:00:00.000Z",
      });
      duringRun = await queryListenerControl(paths, "status");
      return { reason: "cancelled" as const };
    },
  });

  const observed = duringRun as ListenerStatus | null;
  assert.equal(observed?.pendingDeliveryCount, 3);
  assert.equal(observed?.lastClaimAt, null, "no claim has run yet");
  assert.equal(observed?.pendingDeliveryCountAt, "2026-07-30T00:00:00.000Z");
  const human = renderListenerStatus(observed!, {
    pendingForMainOldestAt: null,
    hookSurfaceExists: false,
    hookSurfaceAdvanced: false,
  }, Date.parse("2026-07-30T03:00:00.000Z"));
  assert.ok(
    human.includes(
      "Pending deliveries reported by the service: 3. The service reported that 3h ago.",
    ),
    human,
  );
});

test("the redelivery claim reads the same in help as in status", () => {
  /* Claim-family sweep. The status line was corrected to name both outcomes
   * after review arms showed "redelivers" is false when the signal's own TTL
   * elapsed under a live lease: the next claim expire-acknowledges it instead.
   * The help text carried the same retired claim and was not swept, which an
   * arm found on e5f75c9. */
  const help = usage();
  assert.ok(help.includes("--turn-budget"), "the flag is still documented");
  assert.ok(
    help.includes(
      "After the lease ends the service either\ndelivers the released one again or terminates it.",
    ),
    help,
  );
  assert.ok(!help.includes("the service redelivers the released one"), help);
});
