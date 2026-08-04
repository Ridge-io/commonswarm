import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type DeliveryClaimResult,
  type DeliveryRow,
} from "../src/cloud/delivery.js";
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
} from "../src/cloud/signals.js";
import { ACP_DEFAULT_REQUEST_TIMEOUT_MS } from "../src/host/bounds.js";
import {
  runListenerRuntime as runListenerRuntimeActual,
  LISTENER_DELIVERY_SAFETY_MARGIN_MS,
  LISTENER_PROMPT_START_MINIMUM_MS,
  listenerPaths,
  runListenerSupervisor,
  claimCommandId,
  ackCommandId,
  FileListenerEffectStore,
  newReceivedAskRecord,
  newObservedNoteRecord,
  type ListenerActiveClaim,
  type ListenerDeliveryJournalRecord,
  type ListenerEffectRecord,
  type ListenerEffectStore,
  type ListenerPromptMode,
  type ListenerRuntimeEvent,
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
    until: "2026-08-30T00:00:00.000Z",
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
      onEvent({
        type: "delivery_ack",
        signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13",
        outcome: "replied",
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
  assert.equal(status.lastAckAt, ts);
  assert.equal(status.lastSignalId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13");
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

test("a durable note is persisted and reread before prepareAck and network ACK", async () => {
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

test("a durable ask reaches done, then persists prepareAck before replied ACK", async () => {
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
