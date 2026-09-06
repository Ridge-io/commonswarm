/**
 * Fake-socket and parser controls for listener push delivery (L4).
 * Named in the npm test list.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloudTarget } from "../src/cloud/config.js";
import {
  DeliveryCommandClient,
  type DeliveryClaimResult,
  type DeliveryRow,
} from "../src/cloud/delivery.js";
import {
  IDLE_POLL_DEFAULT_MS,
  formatIdlePollDuration,
} from "../src/cloud/idle-poll.js";
import type { SignalRecord } from "../src/cloud/command-client.js";
import type { AgentSignalPage } from "../src/cloud/signals.js";
import {
  parseOptionalWakeHint,
  WAKE_EVENT,
  WAKE_TOPIC_PREFIX,
} from "../src/cloud/wake.js";
import { writeSecureJsonFile } from "../src/cloud/storage.js";
import { listenerStatusJson, renderListenerStatus } from "../src/cli.js";
import {
  claimCommandId,
  emptyListenerReadHealth,
  emptyListenerWakeStatus,
  LISTENER_RECONCILE_POLL_MS,
  LISTENER_WAKE_MODES,
  LISTENER_WAKE_MODE_POLL,
  LISTENER_WAKE_MODE_PUSH,
  LISTENER_WAKE_MODE_SET,
  listenerPaths,
  listenerWakePersistWorthy,
  listenerWakeStatusSentence,
  WAKE_COALESCE_MS,
  parseListenerWake,
  readListenerStatus,
  recordListenerClaim,
  recordListenerClaimCadence,
  recordListenerWakeModeChange,
  LISTENER_MODE_CHANGE_SKIP_MAX,
  REALTIME_SUBSCRIBE_STATUS,
  runListenerRuntime,
  summarizeListenerReadHealth,
  WAKE_CLAIMS_PER_MINUTE_BUDGET,
  WAKE_ERROR_CODE_SET,
  wakeErrorCodeFromSubscribeStatus,
  writeListenerStatus,
  createWakeSubscriber,
  type ListenerActiveClaim,
  type ListenerDeliveryJournalRecord,
  type ListenerEffectRecord,
  type ListenerEffectStore,
  type ListenerPromptMode,
  type ListenerRuntimeModel,
  type ListenerStatus,
  type ListenerWakeStatus,
  type WakeHandle,
  type WakeRealtimeChannel,
  type WakeRealtimeClient,
  type WakeWaitReason,
} from "../src/listener/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const WAKE_TOPIC = `${WAKE_TOPIC_PREFIX}${"A".repeat(43)}`;
const WAKE_TOPIC_B = `${WAKE_TOPIC_PREFIX}${"B".repeat(43)}`;

class FakeChannel implements WakeRealtimeChannel {
  statusCb: ((status: string, err?: Error) => void) | null = null;
  wakeCb: ((message: { payload?: unknown }) => void) | null = null;
  autoSubscribe = false;
  holdUnsubscribe = false;
  private unsubResolve: (() => void) | null = null;
  constructor(readonly topic: string) {}
  on(
    _type: "broadcast",
    _filter: { event: string },
    callback: (message: { payload?: unknown }) => void,
  ): WakeRealtimeChannel {
    this.wakeCb = callback;
    return this;
  }
  subscribe(callback: (status: string, err?: Error) => void): WakeRealtimeChannel {
    this.statusCb = callback;
    if (this.autoSubscribe) callback(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
    return this;
  }
  unsubscribe(): void | Promise<void> {
    if (!this.holdUnsubscribe) return;
    return new Promise((resolve) => {
      this.unsubResolve = resolve;
    });
  }
  releaseUnsubscribe(): void {
    this.unsubResolve?.();
    this.unsubResolve = null;
  }
  emitStatus(status: string, err?: Error): void {
    this.statusCb?.(status, err);
  }
  emitWake(): void {
    this.wakeCb?.({ payload: { v: 1 } });
  }
}

class FakeRealtime implements WakeRealtimeClient {
  channelInstance: FakeChannel | null = null;
  channels: FakeChannel[] = [];
  authed: string | null = null;
  autoSubscribe = false;
  setAuth(token: string): void {
    this.authed = token;
  }
  channel(topic: string): FakeChannel {
    const channel = new FakeChannel(topic);
    channel.autoSubscribe = this.autoSubscribe;
    this.channelInstance = channel;
    this.channels.push(channel);
    return channel;
  }
  removeChannel(): void {}
  disconnect(): void {}
}

function note(id: string): SignalRecord {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    from: "33333333-3333-4333-8333-333333333333",
    from_kind: "agent",
    to: null,
    to_agent: PRINCIPAL_ID,
    in_reply_to: null,
    about: null,
    kind: "note",
    body: "note",
    until: "2036-08-30T00:00:00.000Z",
    created_at: "2026-07-30T00:00:01.000Z",
    sender_owner_relation: "same_owner",
  };
}

function durablePage(wake = true): AgentSignalPage {
  return {
    signals: [],
    capabilities: {
      senderOwnerRelation: true,
      cursorAfter: true,
      deliveryClaim: true,
      deliveryAck: true,
    },
    legacyCursorFallback: false,
    rawCount: 0,
    nextCursor: null,
    malformedRows: 0,
    pendingDeliveryCount: 0,
    ...(wake ? { wake: { topic: WAKE_TOPIC, event: WAKE_EVENT } } : {}),
  };
}

function claimResult(deliveries: DeliveryRow[] = []): DeliveryClaimResult {
  return {
    httpStatus: 200,
    capabilities: {
      deliveryClaim: true,
      deliveryAck: true,
      senderOwnerRelation: true,
    },
    deliveries,
    pendingDeliveryCount: deliveries.length,
    terminalDeliveryFailureCount: 0,
    wake: { topic: WAKE_TOPIC, event: WAKE_EVENT },
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

class FakeModel implements ListenerRuntimeModel {
  async start() {}
  async prompt(_signal: SignalRecord, _mode: ListenerPromptMode, _prompt: string) {
    return { message: "ok", stopReason: "end_turn" as const };
  }
  cancel() {}
  async close() {}
}

class MemoryJournal {
  record: ListenerDeliveryJournalRecord;
  constructor() {
    this.record = {
      version: 1,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      listenerInstanceId: "44444444-4444-4444-8444-444444444444",
      nextClaimOrdinal: 0,
      active: null,
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
  }
  async read() {
    return structuredClone(this.record);
  }
  async reserveClaim(now = new Date().toISOString()) {
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
    assert.ok(this.record.active);
    this.record.active.claimLastAttemptAt = now;
    this.record.updatedAt = now;
  }
  async recordLease() {
    throw new Error("lease must not run in empty-claim tests");
  }
  async prepareAck() {
    throw new Error("ack must not run in empty-claim tests");
  }
  async clearActive(now = new Date().toISOString()) {
    this.record.active = null;
    this.record.updatedAt = now;
  }
}

class ScriptedWake implements WakeHandle {
  state: "disconnected" | "connecting" | "subscribed" | "errored" = "disconnected";
  hasTopic = false;
  queue: WakeWaitReason[] = [];
  untils: number[] = [];
  waits = 0;
  wakeClaims = 0;
  claims = 0;
  closed = false;
  rateLimitedFlag = false;
  private snap: ListenerWakeStatus = emptyListenerWakeStatus();

  setPush(): void {
    this.state = "subscribed";
    this.hasTopic = true;
    this.snap = {
      ...emptyListenerWakeStatus(),
      mode: "push",
      subscribedAt: "2026-07-30T00:00:00.000Z",
    };
  }

  setPoll(code: ListenerWakeStatus["errorCode"] = "channel_error"): void {
    this.state = "errored";
    this.hasTopic = true;
    this.snap = {
      ...emptyListenerWakeStatus(),
      mode: "poll",
      errorCode: code,
    };
  }

  snapshot(): ListenerWakeStatus {
    return {
      ...this.snap,
      rateLimited: this.rateLimitedFlag,
      mode: this.rateLimitedFlag ? "poll" : this.snap.mode,
      errorCode: this.rateLimitedFlag ? "rate_limited" : this.snap.errorCode,
    };
  }

  async next(options: { until: number; signal?: AbortSignal }): Promise<WakeWaitReason> {
    this.waits += 1;
    this.untils.push(options.until);
    return this.queue.shift() ?? "deadline";
  }

  setTopic(_topic: string): void {
    this.hasTopic = true;
  }

  noteReconcile(): void {}
  noteClaim(): void {
    this.claims += 1;
  }
  noteWakeClaim(): void {
    this.wakeClaims += 1;
    this.claims += 1;
  }
  canClaimOnWake(): boolean {
    return !this.rateLimitedFlag && this.wakeClaims < WAKE_CLAIMS_PER_MINUTE_BUDGET;
  }
  coalescingRemainingMs(): number {
    return 0;
  }
  overWakeBudget(): boolean {
    return this.wakeClaims >= WAKE_CLAIMS_PER_MINUTE_BUDGET;
  }
  markRateLimited(): void {
    this.rateLimitedFlag = true;
    this.snap.rateLimited = true;
    this.snap.mode = "poll";
    this.snap.errorCode = "rate_limited";
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function statusShell(paths: ReturnType<typeof listenerPaths>): ListenerStatus {
  const ts = "2026-07-30T00:00:00.000Z";
  return {
    version: 1,
    instanceId: randomUUID(),
    provider: "grok",
    profileId: "profile-test",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    pid: process.pid,
    state: "ready",
    startedAt: ts,
    readyAt: ts,
    updatedAt: ts,
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    providerVersion: null,
    providerLastMeasuredVersion: null,
    lastWorkerStderrTail: null,
    deliveryMode: "durable_claim",
    pendingDeliveryCount: 0,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: null,
    routeMode: "worker",
    deferOverChars: null,
    pendingForMainCount: 0,
    droppedForMainCount: 0,
    logPath: paths.logPath,
  };
}

test("wake hint parser accepts the closed object and omits 0.1.57 silence", () => {
  assert.equal(parseOptionalWakeHint(undefined), undefined);
  assert.equal(parseOptionalWakeHint(null), undefined);
  assert.deepEqual(parseOptionalWakeHint({ topic: WAKE_TOPIC, event: WAKE_EVENT }), {
    topic: WAKE_TOPIC,
    event: WAKE_EVENT,
  });
  assert.throws(() => parseOptionalWakeHint({ topic: "nope", event: WAKE_EVENT }));
  assert.throws(() => parseOptionalWakeHint({ topic: WAKE_TOPIC, event: "signal" }));
  assert.throws(() => parseOptionalWakeHint("cswarm-wake:x"));
});

test("Realtime subscribe statuses map by code, never by error.message", () => {
  assert.equal(
    wakeErrorCodeFromSubscribeStatus(REALTIME_SUBSCRIBE_STATUS.CHANNEL_ERROR),
    "channel_error",
  );
  assert.equal(
    wakeErrorCodeFromSubscribeStatus(REALTIME_SUBSCRIBE_STATUS.CLOSED),
    "closed",
  );
  assert.equal(
    wakeErrorCodeFromSubscribeStatus(REALTIME_SUBSCRIBE_STATUS.TIMED_OUT),
    "timed_out",
  );
  assert.equal(
    wakeErrorCodeFromSubscribeStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED),
    null,
  );
  const unauthorized = new Error(
    "Unauthorized: You do not have permissions to read from this Channel topic: " +
      WAKE_TOPIC,
  );
  assert.equal(
    wakeErrorCodeFromSubscribeStatus(REALTIME_SUBSCRIBE_STATUS.CHANNEL_ERROR),
    "channel_error",
  );
  assert.equal(WAKE_ERROR_CODE_SET.has("channel_error"), true);
  assert.doesNotMatch(unauthorized.message, /^channel_error$/);
});

test("WakeSubscriber latches a wake while nobody awaits next()", async () => {
  const fake = new FakeRealtime();
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    createRealtime: () => fake,
  });
  wake.setTopic(WAKE_TOPIC);
  assert.equal(fake.authed, "anon");
  fake.channelInstance!.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  assert.equal(wake.state, "subscribed");
  assert.equal(wake.snapshot().mode, "push");
  fake.channelInstance!.emitWake();
  fake.channelInstance!.emitWake();
  const first = await wake.next({ until: Date.now() + 1_000 });
  const second = await wake.next({ until: Date.now() });
  assert.equal(first, "wake");
  assert.equal(second, "deadline");
  const snap = wake.snapshot();
  assert.equal("topic" in snap, false);
  assert.equal(JSON.stringify(snap).includes("cswarm-wake:"), false);
  await wake.close();
});

test("CHANNEL_ERROR flips snapshot to poll without reading error.message", async () => {
  const fake = new FakeRealtime();
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    createRealtime: () => fake,
  });
  wake.setTopic(WAKE_TOPIC);
  fake.channelInstance!.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  const until = Date.now() + 200;
  const waiting = wake.next({ until });
  fake.channelInstance!.emitStatus(
    REALTIME_SUBSCRIBE_STATUS.CHANNEL_ERROR,
    new Error("Unauthorized: " + WAKE_TOPIC),
  );
  assert.equal(await waiting, "state");
  const snap = wake.snapshot();
  assert.equal(snap.mode, "poll");
  assert.equal(snap.errorCode, "channel_error");
  assert.equal(JSON.stringify(snap).includes("cswarm-wake:"), false);
  await wake.close();
});

test("setTopic rotation records topicRotatedAt and joins the new channel", async () => {
  const fake = new FakeRealtime();
  const nowMs = Date.parse("2026-07-30T00:00:10.000Z");
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    now: () => nowMs,
    createRealtime: () => fake,
  });
  wake.setTopic(WAKE_TOPIC);
  fake.channels[0]!.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  assert.equal(wake.snapshot().topicRotatedAt, null);
  wake.setTopic(WAKE_TOPIC_B);
  assert.equal(fake.channels.length, 2);
  assert.equal(fake.channels[1]!.topic, WAKE_TOPIC_B);
  fake.channels[1]!.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  const snap = wake.snapshot();
  assert.equal(snap.mode, "push");
  assert.equal(snap.topicRotatedAt, new Date(nowMs).toISOString());
  assert.equal(JSON.stringify(snap).includes("cswarm-wake:"), false);
  await wake.close();
});

test("setTopic does not clobber a live subscribe when the old unsubscribe settles late", async () => {
  const fake = new FakeRealtime();
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    createRealtime: () => fake,
  });
  wake.setTopic(WAKE_TOPIC);
  const channelA = fake.channels[0]!;
  channelA.holdUnsubscribe = true;
  channelA.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  assert.equal(wake.snapshot().mode, "push");
  wake.setTopic(WAKE_TOPIC_B);
  const channelB = fake.channels[1]!;
  channelB.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  assert.equal(wake.state, "subscribed");
  assert.equal(wake.snapshot().mode, "push");
  channelA.releaseUnsubscribe();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(wake.state, "subscribed");
  assert.equal(wake.snapshot().mode, "push");
  assert.ok(wake.snapshot().topicRotatedAt);
  await wake.close();
});

test("rotated wake id: CLOSED then a new topic on the next read returns to push", async () => {
  const nowMs = Date.parse("2026-07-30T00:00:10.000Z");
  const fake = new FakeRealtime();
  fake.autoSubscribe = true;
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    now: () => nowMs,
    createRealtime: () => fake,
  });
  const journal = new MemoryJournal();
  const controller = new AbortController();
  let claims = 0;
  let reads = 0;
  let lastWake: ListenerWakeStatus | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        if (claims === 1) {
          fake.channels[0]?.emitStatus(REALTIME_SUBSCRIBE_STATUS.CLOSED);
        }
        if (claims >= 2 && lastWake?.mode === "push" && lastWake.topicRotatedAt) {
          controller.abort();
        }
        if (claims >= 8) controller.abort();
        return claims === 1
          ? claimResult([])
          : {
            ...claimResult([]),
            wake: { topic: WAKE_TOPIC_B, event: WAKE_EVENT },
          };
      },
      async ackAgentDelivery() {
        throw new Error("ack must not run");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    pollMs: IDLE_POLL_DEFAULT_MS,
    now: () => nowMs,
    sleep: async () => {},
    wake,
    onEvent: (event) => {
      if (event.type === "wake") lastWake = event.wake;
    },
    readPage: async () => {
      reads += 1;
      if (reads === 1) return durablePage();
      return {
        ...durablePage(false),
        wake: { topic: WAKE_TOPIC_B, event: WAKE_EVENT },
      };
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.ok(claims >= 2);
  assert.ok(reads >= 2);
  assert.equal(lastWake?.mode, "push");
  assert.ok(lastWake?.topicRotatedAt);
  assert.equal(fake.channels.length, 2);
  assert.equal(fake.channels[1]!.topic, WAKE_TOPIC_B);
  await wake.close();
});

test("wake claim budget is 50 per clock minute", () => {
  const fake = new FakeRealtime();
  const nowMs = Date.parse("2026-07-30T00:00:10.000Z");
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    now: () => nowMs,
    createRealtime: () => fake,
  });
  for (let i = 0; i < WAKE_CLAIMS_PER_MINUTE_BUDGET; i++) {
    assert.equal(wake.overWakeBudget(nowMs), false);
    wake.noteWakeClaim(nowMs);
  }
  assert.equal(wake.overWakeBudget(nowMs), true);
  assert.equal(WAKE_CLAIMS_PER_MINUTE_BUDGET, 50);
});

test("over-budget next() keeps the latch and snapshot is poll until the minute clears", async () => {
  let nowMs = Date.parse("2026-07-30T00:00:10.000Z");
  const fake = new FakeRealtime();
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    now: () => nowMs,
    createRealtime: () => fake,
  });
  wake.setTopic(WAKE_TOPIC);
  fake.channelInstance!.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  assert.equal(wake.snapshot().mode, "push");
  for (let i = 0; i < WAKE_CLAIMS_PER_MINUTE_BUDGET; i++) {
    wake.noteWakeClaim(nowMs);
  }
  const snap = wake.snapshot();
  assert.equal(snap.mode, "poll");
  assert.equal(snap.rateLimited, true);
  assert.equal(snap.errorCode, "rate_limited");
  fake.channelInstance!.emitWake();
  fake.channelInstance!.emitWake();
  assert.equal(await wake.next({ until: nowMs }), "deadline");
  assert.equal(await wake.next({ until: nowMs }), "deadline");
  nowMs += 60_000;
  assert.equal(wake.overWakeBudget(nowMs), false);
  assert.equal(wake.snapshot().mode, "push");
  assert.equal(wake.snapshot().rateLimited, false);
  assert.equal(await wake.next({ until: nowMs }), "wake");
  await wake.close();
});

test("70 wakes in one frozen minute stay at most 51 claims with no extra reads", async () => {
  const nowMs = Date.parse("2026-07-30T00:00:10.000Z");
  const fake = new FakeRealtime();
  fake.autoSubscribe = true;
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    now: () => nowMs,
    createRealtime: () => fake,
  });
  const journal = new MemoryJournal();
  const controller = new AbortController();
  let claims = 0;
  let reads = 0;
  let lastWake: ListenerWakeStatus | null = null;
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      listenerInstanceId: journal.record.listenerInstanceId,
      deliveryJournal: journal,
      deliveryClient: {
        async claimAgentInbox() {
          claims += 1;
          fake.channelInstance?.emitWake();
          if (claims === 51) {
            for (let i = 0; i < 20; i++) fake.channelInstance?.emitWake();
          }
          if (claims >= 70) controller.abort();
          return claimResult([]);
        },
        async ackAgentDelivery() {
          throw new Error("ack must not run");
        },
      },
      credentialSession: { async bearer() { return "token"; } },
      store: new MemoryStore(),
      model: new FakeModel(),
      signal: controller.signal,
      pollMs: IDLE_POLL_DEFAULT_MS,
      now: () => nowMs,
      sleep: async () => {},
      wake,
      onEvent: (event) => {
        if (event.type === "wake") lastWake = event.wake;
      },
      readPage: async () => {
        reads += 1;
        return durablePage();
      },
    });
    assert.equal(stop.reason, "cancelled");
  } finally {
    clearTimeout(timer);
  }
  assert.ok(claims <= 51, `claims in one frozen minute: ${claims}`);
  assert.equal(reads, 1);
  assert.equal(lastWake?.mode, "poll");
  assert.equal(lastWake?.rateLimited, true);
  await wake.close();
});

test("status sentence never says push unless mode is push; lists come from constants", () => {
  assert.deepEqual([...LISTENER_WAKE_MODE_SET], [...LISTENER_WAKE_MODES]);
  assert.equal(LISTENER_WAKE_MODE_PUSH, LISTENER_WAKE_MODES[0]);
  assert.equal(LISTENER_WAKE_MODE_POLL, LISTENER_WAKE_MODES[1]);
  const push: ListenerWakeStatus = {
    ...emptyListenerWakeStatus(),
    mode: LISTENER_WAKE_MODE_PUSH,
    subscribedAt: "2026-07-30T00:00:00.000Z",
    lastWakeAt: "2026-07-30T00:00:12.000Z",
  };
  const poll: ListenerWakeStatus = {
    ...emptyListenerWakeStatus(),
    mode: LISTENER_WAKE_MODE_POLL,
    errorCode: "channel_error",
  };
  const pushLine = listenerWakeStatusSentence(push, IDLE_POLL_DEFAULT_MS, "12s ago");
  const pollLine = listenerWakeStatusSentence(
    poll,
    IDLE_POLL_DEFAULT_MS,
    null,
  );
  assert.match(pushLine, new RegExp(`^${LISTENER_WAKE_MODE_PUSH} \\(Realtime\\)`));
  assert.match(pushLine, new RegExp(formatIdlePollDuration(LISTENER_RECONCILE_POLL_MS)));
  assert.doesNotMatch(pollLine, new RegExp(`\\b${LISTENER_WAKE_MODE_PUSH}\\b`));
  assert.match(pollLine, new RegExp(`^${LISTENER_WAKE_MODE_POLL} every`));
  assert.match(pollLine, new RegExp(formatIdlePollDuration(IDLE_POLL_DEFAULT_MS)));
  assert.match(pollLine, /channel_error/);
  assert.doesNotMatch(pushLine, /cswarm-wake:/);
  assert.doesNotMatch(pollLine, /cswarm-wake:/);
});

test("wake status persist skips lastWakeAt-only ticks inside the coalesce window", () => {
  const first: ListenerWakeStatus = {
    ...emptyListenerWakeStatus(),
    mode: "push",
    subscribedAt: "2026-07-30T00:00:00.000Z",
    lastWakeAt: "2026-07-30T00:00:01.000Z",
  };
  const t0 = Date.parse("2026-07-30T00:00:01.000Z");
  assert.equal(listenerWakePersistWorthy(undefined, first, 0, t0), true);
  const sameWake: ListenerWakeStatus = {
    ...first,
    lastWakeAt: "2026-07-30T00:00:01.400Z",
  };
  assert.equal(
    listenerWakePersistWorthy(first, sameWake, t0, t0 + 400),
    false,
  );
  assert.equal(
    listenerWakePersistWorthy(first, sameWake, t0, t0 + WAKE_COALESCE_MS),
    true,
  );
  const modeFlip: ListenerWakeStatus = { ...sameWake, mode: "poll" };
  assert.equal(listenerWakePersistWorthy(first, modeFlip, t0, t0 + 400), true);
  assert.equal(WAKE_COALESCE_MS, 1_000);
});

test("parseListenerWake is closed and refuses topic keys", () => {
  const good: ListenerWakeStatus = emptyListenerWakeStatus();
  assert.deepEqual(parseListenerWake(good, true), good);
  assert.equal(parseListenerWake({ ...good, extra: 1 }, true), null);
  assert.equal(parseListenerWake({ ...good, topic: WAKE_TOPIC }, true), null);
  assert.equal(parseListenerWake({ ...good, wakeTopic: WAKE_TOPIC }, true), null);
  assert.equal(
    parseListenerWake({ ...good, mode: "push", subscribedAt: null }, true),
    null,
  );
});

test("a status file cannot store a topic key or a topic-shaped lastErrorDetail", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-wake-status-"));
  const paths = listenerPaths({
    profileId: "profile-wake",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    stateDirectory: root,
  });
  const base = statusShell(paths);
  await writeListenerStatus(paths, { ...base, wake: emptyListenerWakeStatus() });
  await assert.rejects(
    writeListenerStatus(paths, { ...base, topic: WAKE_TOPIC } as unknown as ListenerStatus),
    /forbidden/,
  );
  const raw = JSON.parse(await readFile(paths.statusPath, "utf8")) as Record<string, unknown>;
  raw.lastErrorDetail = `Unauthorized: ${WAKE_TOPIC}`;
  await writeSecureJsonFile(paths.statusPath, JSON.stringify(raw));
  await assert.rejects(readListenerStatus(paths), /malformed/);
});

test("subscribed wake then one empty claim; two wakes in one claim latch one more", async () => {
  const journal = new MemoryJournal();
  const controller = new AbortController();
  const wake = new ScriptedWake();
  wake.setPush();
  wake.queue.push("wake", "wake");
  let claims = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        if (claims >= 3) controller.abort();
        return claimResult([]);
      },
      async ackAgentDelivery() {
        throw new Error("ack must not run");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    pollMs: IDLE_POLL_DEFAULT_MS,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => {},
    wake,
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(claims, 3);
  assert.equal(wake.wakeClaims, 2);
  assert.ok(wake.waits >= 1);
});

test("CHANNEL_ERROR path reconciles on the idle cadence then push on resubscribe", async () => {
  const journal = new MemoryJournal();
  const controller = new AbortController();
  const wake = new ScriptedWake();
  wake.setPoll("channel_error");
  wake.queue.push("state", "deadline");
  const intervals: number[] = [];
  let claims = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        if (claims === 2) wake.setPush();
        if (claims >= 3) controller.abort();
        return claimResult([]);
      },
      async ackAgentDelivery() {
        throw new Error("ack must not run");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    pollMs: IDLE_POLL_DEFAULT_MS,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => {},
    wake,
    onEvent: (event) => {
      if (event.type === "idle_poll") intervals.push(event.intervalMs);
      if (event.type === "wake" && event.wake.mode === "push" && claims >= 2) {
        /* observed */
      }
    },
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "cancelled");
  assert.ok(claims >= 3);
  assert.ok(intervals.includes(IDLE_POLL_DEFAULT_MS));
});

test("wake ticks while mode is poll still read; skipRead is push-only", async () => {
  const journal = new MemoryJournal();
  const controller = new AbortController();
  const wake = new ScriptedWake();
  wake.setPoll("channel_error");
  wake.queue.push("wake", "wake", "wake");
  let claims = 0;
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        if (claims >= 3) controller.abort();
        return claimResult([]);
      },
      async ackAgentDelivery() {
        throw new Error("ack must not run");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    pollMs: IDLE_POLL_DEFAULT_MS,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => {},
    wake,
    readPage: async () => {
      reads += 1;
      return durablePage();
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(wake.wakeClaims, 0);
  assert.ok(reads >= 3);
  assert.equal(claims, 3);
});

test("reconcile deadline while subscribed is 5 minutes", () => {
  assert.equal(LISTENER_RECONCILE_POLL_MS, 300_000);
  assert.equal(formatIdlePollDuration(LISTENER_RECONCILE_POLL_MS), "5m");
});

test("a lost wake is claimed when next() hits the reconcile deadline", async () => {
  const nowMs = Date.parse("2026-07-30T00:00:00.000Z");
  const journal = new MemoryJournal();
  const controller = new AbortController();
  const wake = new ScriptedWake();
  wake.setPush();
  let claims = 0;
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        if (claims >= 2) controller.abort();
        return claimResult([]);
      },
      async ackAgentDelivery() {
        throw new Error("ack must not run");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    pollMs: IDLE_POLL_DEFAULT_MS,
    now: () => nowMs,
    sleep: async () => {},
    wake,
    readPage: async () => {
      reads += 1;
      return durablePage();
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(claims, 2);
  assert.equal(reads, 2);
  assert.equal(wake.wakeClaims, 0);
  assert.ok(wake.untils.length >= 1);
  assert.equal(wake.untils[0], nowMs + LISTENER_RECONCILE_POLL_MS);
});

test("claim throughput skips a mode-change hour and keeps the slowest cadence", () => {
  const hourStart = "2026-09-01T10:00:00.000Z";
  const readyAt = "2026-09-01T09:00:00.000Z";
  let health = recordListenerClaimCadence(
    emptyListenerReadHealth(),
    LISTENER_RECONCILE_POLL_MS,
    hourStart,
  );
  health = recordListenerWakeModeChange(health, hourStart);
  for (let i = 0; i < 12; i++) health = recordListenerClaim(health, hourStart);
  const nextHour = "2026-09-01T11:00:00.000Z";
  health = recordListenerClaimCadence(health, IDLE_POLL_DEFAULT_MS, nextHour);
  const summary = summarizeListenerReadHealth(
    health,
    readyAt,
    Date.parse("2026-09-01T12:00:00.000Z"),
  );
  const changed = summary.claimThroughputHours.find((row) => row.hourStart === hourStart);
  assert.ok(changed);
  assert.equal(
    summary.throughputLapseHours.some((row) => row.hourStart === hourStart),
    false,
  );
  assert.equal(health.claimHours[0]?.modeChanged, true);
  const frozen = health.claimHours.find((row) => row.hourStart === hourStart);
  assert.equal(frozen?.expectedClaims, 3600_000 / LISTENER_RECONCILE_POLL_MS);
});

test("a second consecutive mode-change hour is scored for throughput lapse", () => {
  const hour10 = "2026-09-01T10:00:00.000Z";
  const hour11 = "2026-09-01T11:00:00.000Z";
  const hour12 = "2026-09-01T12:00:00.000Z";
  const readyAt = "2026-09-01T09:00:00.000Z";
  let health = recordListenerClaimCadence(
    emptyListenerReadHealth(),
    IDLE_POLL_DEFAULT_MS,
    hour10,
  );
  health = recordListenerWakeModeChange(health, hour10);
  health = recordListenerClaimCadence(health, IDLE_POLL_DEFAULT_MS, hour11);
  health = recordListenerWakeModeChange(health, hour11);
  health = recordListenerClaimCadence(health, IDLE_POLL_DEFAULT_MS, hour12);
  const summary = summarizeListenerReadHealth(
    health,
    readyAt,
    Date.parse(hour12),
  );
  const lapsed = new Set(
    summary.throughputLapseHours.map((row) => row.hourStart),
  );
  assert.equal(lapsed.has(hour10), false);
  assert.equal(lapsed.has(hour11), true);
  assert.equal(LISTENER_MODE_CHANGE_SKIP_MAX, 1);
});

test("listen status JSON names mode from the same wake.mode constant set", () => {
  const ts = "2026-07-30T00:00:00.000Z";
  const status = {
    version: 1 as const,
    instanceId: randomUUID(),
    provider: "grok" as const,
    profileId: "p",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    pid: 1,
    state: "ready" as const,
    startedAt: ts,
    readyAt: ts,
    updatedAt: ts,
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    lastWorkerStderrTail: null,
    deliveryMode: "durable_claim" as const,
    pendingDeliveryCount: 0,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: ts,
    lastAckAt: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: null,
    routeMode: "worker" as const,
    deferOverChars: null,
    pendingForMainCount: 0,
    droppedForMainCount: 0,
    idlePollMs: IDLE_POLL_DEFAULT_MS,
    wake: {
      ...emptyListenerWakeStatus(),
      mode: "push" as const,
      subscribedAt: ts,
      lastWakeAt: ts,
      lastReconcileAt: ts,
    },
    logPath: "/tmp/cswarm-wake.log",
  };
  const json = listenerStatusJson(status);
  assert.equal(json.mode, "push");
  assert.equal((json.wake as ListenerWakeStatus).mode, "push");
  assert.equal(LISTENER_WAKE_MODE_SET.has(json.mode as string), true);
  const human = renderListenerStatus(status);
  assert.match(human, /^push \(Realtime\)|push \(Realtime\)/m);
  assert.doesNotMatch(human, /cswarm-wake:/);
  assert.equal(JSON.stringify(json).includes("cswarm-wake:"), false);
});

test("delivery claim parser carries optional wake and ignores its absence", async () => {
  const SIGNAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const LEASE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const body = {
    status: "accepted",
    ok: true,
    capabilities: {
      delivery_claim: 1,
      delivery_ack: 1,
      sender_owner_relation: 1,
    },
    deliveries: [{
      signal: {
        id: SIGNAL,
        workspace_id: WORKSPACE_ID,
        from: "33333333-3333-4333-8333-333333333333",
        from_kind: "agent",
        to: null,
        to_agent: PRINCIPAL_ID,
        in_reply_to: null,
        about: null,
        kind: "note",
        body: "note",
        until: "2036-08-30T00:00:00.000Z",
        created_at: "2026-07-30T00:00:01.000Z",
        sender_owner_relation: "same_owner",
      },
      lease_id: LEASE,
      leased_until: "2036-07-30T00:15:00.000Z",
      sender_owner_relation: "same_owner",
    }],
    pending_delivery_count: 1,
    terminal_delivery_failure_count: 0,
    event_ids: [],
    events: [],
    wake: { topic: WAKE_TOPIC, event: WAKE_EVENT },
  };
  const client = new DeliveryCommandClient(
    cloudTarget("https://cloud.example.test", "anon"),
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    { now: () => Date.parse("2026-07-30T00:00:00.000Z") },
  );
  const result = await client.claimAgentInbox({
    workspaceId: WORKSPACE_ID,
    credential: "swm_agt_" + "c".repeat(43),
    commandId: "claimcmd01",
    listenerInstanceId: "44444444-4444-4444-8444-444444444444",
    expectedPrincipalId: PRINCIPAL_ID,
  });
  assert.equal(result.wake?.topic, WAKE_TOPIC);
  assert.equal(result.wake?.event, WAKE_EVENT);

  const without = { ...body };
  delete (without as { wake?: unknown }).wake;
  const client2 = new DeliveryCommandClient(
    cloudTarget("https://cloud.example.test", "anon"),
    async () =>
      new Response(JSON.stringify(without), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    { now: () => Date.parse("2026-07-30T00:00:00.000Z") },
  );
  const omitted = await client2.claimAgentInbox({
    workspaceId: WORKSPACE_ID,
    credential: "swm_agt_" + "c".repeat(43),
    commandId: "claimcmd02",
    listenerInstanceId: "44444444-4444-4444-8444-444444444444",
    expectedPrincipalId: PRINCIPAL_ID,
  });
  assert.equal(omitted.wake, undefined);
});
