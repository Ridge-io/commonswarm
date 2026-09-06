/**
 * Pure controls for the human-visible arrival monitor.
 *
 * ★ Named by `npm test`; it needs no network or database.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import {
  acquireArrivalWatchLock,
  arrivalWatchLockHeld,
  arrivalNotification,
  arrivalFullTextCommand,
  arrivalReplyCommand,
  arrivalSnippetSuffix,
  arrivalWatchAlreadyRunningSentence,
  ArrivalWatchAlreadyRunningError,
  ARRIVAL_RETRY_NOTICE_THRESHOLD_MS,
  ARRIVAL_SNIPPET_MAX,
  ARRIVAL_WATCH_POLL_MS,
  createArrivalRetryNoticePolicy,
  formatArrivalNotification,
  formatArrivalRetryNotice,
  releaseArrivalWatchLock,
  runArrivalWatch,
  type ArrivalCursorStore,
} from "../../src/cloud/arrival-watch.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { nextIdlePollMs } from "../../src/cloud/idle-poll.js";
import {
  SignalHttpError,
  SignalTransportError,
  type AgentSignalPage,
  type SignalCursor,
} from "../../src/cloud/signals.js";
import { WAKE_EVENT, WAKE_TOPIC_PREFIX } from "../../src/cloud/wake.js";
import {
  createWakeSubscriber,
  LISTENER_RECONCILE_POLL_MS,
  LISTENER_WAKE_MODE_PUSH,
  REALTIME_SUBSCRIBE_STATUS,
  type WakeHandle,
  type WakeRealtimeChannel,
  type WakeRealtimeClient,
} from "../../src/listener/wake.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SENDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TARGET = { url: "https://api.example.test", anonKey: "public-anon-key" };
const CLOUD = cloudTarget(TARGET.url, TARGET.anonKey);
const WAKE_TOPIC = `${WAKE_TOPIC_PREFIX}${"A".repeat(43)}`;
const WAKE_HINT = { topic: WAKE_TOPIC, event: WAKE_EVENT } as const;
const EXISTING_CURSOR = {
  created_at: "2026-08-28T10:04:00.000Z",
  id: "55555555-5555-4555-8555-555555555555",
};

function row(id: string, body: string, createdAt: string): SignalRecord {
  return {
    id,
    workspace_id: WORKSPACE,
    from: SENDER,
    from_kind: "agent",
    to: null,
    to_agent: AGENT,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body,
    until: "2030-01-01T00:00:00.000Z",
    created_at: createdAt,
    sender_owner_relation: "same_owner",
  };
}

function page(
  rows: SignalRecord[],
  extra: { wake?: AgentSignalPage["wake"] } = {},
): AgentSignalPage {
  const last = rows.at(-1);
  return {
    signals: rows,
    capabilities: {
      senderOwnerRelation: true,
      cursorAfter: true,
      deliveryClaim: true,
      deliveryAck: true,
    },
    legacyCursorFallback: false,
    rawCount: rows.length,
    nextCursor: last
      ? { created_at: last.created_at, id: last.id }
      : null,
    malformedRows: 0,
    pendingDeliveryCount: 1,
    ...(extra.wake === undefined ? {} : { wake: extra.wake }),
  };
}

class FakeChannel implements WakeRealtimeChannel {
  statusCb: ((status: string, err?: Error) => void) | null = null;
  wakeCb: ((message: { payload?: unknown }) => void) | null = null;
  autoSubscribe = false;
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
  unsubscribe(): void {}
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

function recordUntil(inner: WakeHandle, untils: number[]): WakeHandle {
  return {
    get state() {
      return inner.state;
    },
    get hasTopic() {
      return inner.hasTopic;
    },
    snapshot: (nowMs) => inner.snapshot(nowMs),
    next: (opts) => {
      untils.push(opts.until);
      return inner.next(opts);
    },
    setTopic: (topic) => inner.setTopic(topic),
    noteReconcile: (nowMs) => inner.noteReconcile(nowMs),
    noteClaim: (nowMs) => inner.noteClaim(nowMs),
    noteWakeClaim: (nowMs) => inner.noteWakeClaim(nowMs),
    canClaimOnWake: (nowMs) => inner.canClaimOnWake(nowMs),
    coalescingRemainingMs: (nowMs) => inner.coalescingRemainingMs(nowMs),
    overWakeBudget: (nowMs) => inner.overWakeBudget(nowMs),
    markRateLimited: (nowMs) => inner.markRateLimited(nowMs),
    close: () => inner.close(),
  };
}

function memoryStore(initial: SignalCursor | null | undefined): {
  store: ArrivalCursorStore;
  value(): SignalCursor | null | undefined;
} {
  let cursor = initial;
  return {
    store: {
      location: "memory://arrival-cursor",
      async read() {
        return cursor;
      },
      async write(value) {
        cursor = value;
      },
    },
    value: () => cursor,
  };
}

test("one directed message renders one bounded line with sender and exact reply command", () => {
  const signal = row(
    "11111111-1111-4111-8111-111111111111",
    "Please check the release.",
    "2026-08-28T10:00:00.000Z",
  );
  const notification = arrivalNotification(signal, WORKSPACE, TARGET);
  const output = formatArrivalNotification(notification);

  assert.equal(output.split("\n").length, 1);
  assert.match(output, new RegExp(SENDER));
  assert.match(output, /Please check the release\./);
  assert.match(
    output,
    new RegExp(
      `cswarm reply ${signal.id} "<answer>" --workspace-id ${WORKSPACE}`,
    ),
  );
});

/* A monitor line becomes a chat notification, so anything in it is read by a
 * human on a phone. The anon key is a JWT: repeating it per message made the
 * line unreadable and taught agents to paste credentials into commands. It is
 * public-by-design, so this is noise and habit rather than a secret leak — but
 * the hook never included it and neither should this. */
test("an arrival notification never carries the anon key or the url", () => {
  const notification = arrivalNotification(
    row("11111111-1111-4111-8111-111111111111", "hello", "2026-08-28T10:00:00.000Z"),
    WORKSPACE,
    TARGET,
  );
  const rendered = JSON.stringify(notification);
  assert.equal(rendered.includes(TARGET.anonKey), false);
  assert.equal(rendered.includes(TARGET.url), false);
});

test("a multiline body still produces exactly one notification line", () => {
  const signal = row(
    "22222222-2222-4222-8222-222222222222",
    "First line\n\n- second line\r\nthird line",
    "2026-08-28T10:01:00.000Z",
  );
  const output = formatArrivalNotification(arrivalNotification(signal, WORKSPACE, TARGET));
  assert.equal(output.split("\n").length, 1);
  assert.match(output, /First line - second line third line/);
});

/* The notify line is a preview by design (one terminal line), but its --json form
 * was the only copy an automated reader got, and it carried only the snippet. A
 * surface that is a reader's only copy carries the whole body; a surface that
 * shortens one names where the rest is. */
test("--json carries the whole 8,000-char body beside the snippet", () => {
  const body = "x".repeat(8_000);
  const notification = arrivalNotification(
    row("66666666-6666-4666-8666-666666666666", body, "2026-09-06T10:00:00.000Z"),
    WORKSPACE,
    TARGET,
  );
  const parsed = JSON.parse(JSON.stringify(notification)) as { body: string; snippet: string };
  assert.equal(parsed.body, body);
  assert.equal(parsed.body.length, 8_000);
  assert.equal(parsed.snippet.length, ARRIVAL_SNIPPET_MAX);
  assert.notEqual(parsed.snippet, parsed.body);
});

test("the readable line names the cut and the path to the full text, from run-time lengths", () => {
  const body = "y".repeat(1_234);
  const notification = arrivalNotification(
    row("77777777-7777-4777-8777-777777777777", body, "2026-09-06T10:01:00.000Z"),
    WORKSPACE,
    TARGET,
  );
  const output = formatArrivalNotification(notification);
  const expected = ` (${notification.snippet.length.toLocaleString("en-US")} of ${body.length.toLocaleString("en-US")} chars; full text: ${arrivalFullTextCommand(WORKSPACE)})`;
  assert.equal(expected, ` (${ARRIVAL_SNIPPET_MAX} of 1,234 chars; full text: cswarm inbox --workspace-id ${WORKSPACE})`);
  assert.equal(output.includes(expected), true);
  assert.equal(output.split("\n").length, 1);
  assert.match(output, / — reply: cswarm reply /);
  assert.equal(output.indexOf(expected) < output.indexOf(" — reply: "), true);
});

/* The boundary is the constant, not a typed number: at exactly ARRIVAL_SNIPPET_MAX
 * nothing is cut and no phrase appears; one more character and both the ellipsis
 * and the phrase appear. If the phrase were built from a typed 180 this pair
 * would fail as soon as the constant moved. */
test("no path phrase at exactly ARRIVAL_SNIPPET_MAX chars; present at one more", () => {
  const atCap = arrivalNotification(
    row("88888888-8888-4888-8888-888888888888", "z".repeat(ARRIVAL_SNIPPET_MAX), "2026-09-06T10:02:00.000Z"),
    WORKSPACE,
    TARGET,
  );
  assert.equal(arrivalSnippetSuffix(atCap), "");
  assert.equal(atCap.snippet, atCap.body);
  assert.equal(formatArrivalNotification(atCap).includes("full text:"), false);

  const overCap = arrivalNotification(
    row("99999999-9999-4999-8999-999999999999", "z".repeat(ARRIVAL_SNIPPET_MAX + 1), "2026-09-06T10:03:00.000Z"),
    WORKSPACE,
    TARGET,
  );
  const suffix = arrivalSnippetSuffix(overCap);
  assert.equal(
    suffix,
    ` (${ARRIVAL_SNIPPET_MAX} of ${ARRIVAL_SNIPPET_MAX + 1} chars; full text: ${arrivalFullTextCommand(WORKSPACE)})`,
  );
  assert.equal(overCap.snippet.endsWith("…"), true);
  assert.equal(formatArrivalNotification(overCap).includes(suffix), true);
});

/* The Codex arm on 727f4c44 failed the lane on this: the phrase named a bare
 * `cswarm inbox`, which cannot show the addressed reader anything. An agent
 * identity comes only from its credential flags and then requires a workspace
 * (`cswarm inbox --notify` itself refuses to run without --workspace-id, and the
 * CLI's agent path throws "agent credentials require --workspace-id"). So the
 * command must carry the same route the sibling reply command carries. */
test("the full-text command names the workspace the way the reply command does", () => {
  const notification = arrivalNotification(
    row("bbbbbbbb-2222-4222-8222-222222222222", "q".repeat(ARRIVAL_SNIPPET_MAX + 1), "2026-09-06T10:05:00.000Z"),
    WORKSPACE,
    TARGET,
  );
  const command = arrivalFullTextCommand(WORKSPACE);
  assert.equal(command, `cswarm inbox --workspace-id ${WORKSPACE}`);
  /* Same route flag set as the reply command: every flag the reply names, the full-text
     command names, so neither can drift to a form the reader cannot run. */
  const flags = (text: string): string[] => [...text.matchAll(/--[a-z-]+/gu)].map((match) => match[0]);
  assert.deepEqual(flags(command), flags(arrivalReplyCommand(notification.signal_id, WORKSPACE)));
  assert.equal(flags(command).includes("--workspace-id"), true);
  const rendered = formatArrivalNotification(notification);
  assert.equal(rendered.includes(`full text: ${command}`), true);
  /* Credentials and target stay out of the line, as the reply command's comment records. */
  assert.doesNotMatch(rendered, /--agent-token|--url|--anon-key/u);
});

/* Whitespace collapses before the cap applies, so a body over the cap in raw
 * characters that fits on one line after collapse is not a cut and gets no phrase.
 * The phrase reports a cut, not a raw length. */
test("a body that fits after whitespace collapse is not reported as cut", () => {
  const body = `${"w".repeat(100)}${" ".repeat(200)}${"w".repeat(50)}`;
  assert.equal(body.length > ARRIVAL_SNIPPET_MAX, true);
  const notification = arrivalNotification(
    row("aaaaaaaa-1111-4111-8111-111111111111", body, "2026-09-06T10:04:00.000Z"),
    WORKSPACE,
    TARGET,
  );
  assert.equal(arrivalSnippetSuffix(notification), "");
  assert.equal(notification.body, body);
});

test("restart neither replays an emitted row nor skips a row received while down", async () => {
  const old = row(
    "33333333-3333-4333-8333-333333333333",
    "old backlog",
    "2026-08-28T10:02:00.000Z",
  );
  const first = row(
    "44444444-4444-4444-8444-444444444444",
    "first live arrival",
    "2026-08-28T10:03:00.000Z",
  );
  const duringDowntime = row(
    "55555555-5555-4555-8555-555555555555",
    "arrived while down",
    "2026-08-28T10:04:00.000Z",
  );
  const memory = memoryStore(undefined);
  const firstAbort = new AbortController();
  const firstEmitted: string[] = [];
  let firstRead = 0;

  await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memory.store,
    signal: firstAbort.signal,
    sleep: async () => {},
    readPage: async ({ baseline, after }) => {
      firstRead += 1;
      if (baseline) {
        assert.equal(after, null);
        return page([old]);
      }
      assert.deepEqual(after, { created_at: old.created_at, id: old.id });
      return page([first]);
    },
    emit: async (signal) => {
      firstEmitted.push(signal.id);
      firstAbort.abort();
    },
  });
  assert.equal(firstRead, 2);
  assert.deepEqual(firstEmitted, [first.id], "the first-run backlog must not replay");
  assert.deepEqual(memory.value(), { created_at: first.created_at, id: first.id });

  const restartAbort = new AbortController();
  const restartEmitted: string[] = [];
  await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memory.store,
    signal: restartAbort.signal,
    sleep: async () => {},
    readPage: async ({ baseline, after }) => {
      assert.equal(baseline, false);
      assert.deepEqual(after, { created_at: first.created_at, id: first.id });
      return page([duringDowntime]);
    },
    emit: async (signal) => {
      restartEmitted.push(signal.id);
      restartAbort.abort();
    },
  });
  assert.deepEqual(restartEmitted, [duringDowntime.id]);
});

test("a transient failure and a 5xx keep the watcher armed without a busy loop", async () => {
  const existingCursor = {
    created_at: "2026-08-28T10:04:00.000Z",
    id: "55555555-5555-4555-8555-555555555555",
  };
  const signal = row(
    "66666666-6666-4666-8666-666666666666",
    "after retry",
    "2026-08-28T10:05:00.000Z",
  );
  const memory = memoryStore(existingCursor);
  const abort = new AbortController();
  const sleeps: number[] = [];
  let reads = 0;

  const stop = await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memory.store,
    signal: abort.signal,
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    readPage: async () => {
      reads += 1;
      if (reads === 1) throw new SignalTransportError();
      if (reads === 2) throw new SignalHttpError(503);
      return page([signal]);
    },
    emit: async () => abort.abort(),
  });

  assert.equal(stop.reason, "cancelled");
  assert.equal(reads, 3);
  assert.deepEqual(sleeps, [250, 500]);
  assert.ok(sleeps[0]! > 0, "retry must not spin hot");
  assert.equal(ARRIVAL_WATCH_POLL_MS, 60_000);
});

test("retry notices stay silent for 60s, emit once, then emit one recovery", () => {
  const policy = createArrivalRetryNoticePolicy();
  const notices: string[] = [];
  const measuredBackoffMs = [439, 612, 834, 1_078, 1_390, 1_792, 2_294, 2_952];
  let nowMs = 0;
  for (const delayMs of measuredBackoffMs) {
    const notice = policy.failure(nowMs, delayMs);
    if (notice !== null) notices.push(formatArrivalRetryNotice(notice));
    nowMs += delayMs;
  }
  assert.equal(notices.length, 0, "Gauge's escalating retries must stay silent");
  assert.equal(
    policy.failure(ARRIVAL_RETRY_NOTICE_THRESHOLD_MS - 1, 2_952),
    null,
  );

  const persistent = policy.failure(ARRIVAL_RETRY_NOTICE_THRESHOLD_MS, 2_952);
  assert.ok(persistent !== null);
  notices.push(formatArrivalRetryNotice(persistent));
  assert.equal(policy.failure(ARRIVAL_RETRY_NOTICE_THRESHOLD_MS + 2_952, 2_952), null);

  const recovered = policy.recovery(ARRIVAL_RETRY_NOTICE_THRESHOLD_MS + 5_000);
  assert.ok(recovered !== null);
  notices.push(formatArrivalRetryNotice(recovered));
  assert.equal(policy.recovery(ARRIVAL_RETRY_NOTICE_THRESHOLD_MS + 6_000), null);

  assert.equal(notices.length, 2);
  assert.match(notices[0]!, /^\[arrival_read_persisting\]/);
  assert.match(notices[0]!, /Durable delivery is unaffected/);
  assert.match(notices[0]!, /Next check: automatic retry in 2952ms/);
  assert.match(notices[1]!, /^\[arrival_read_recovered\]/);
  assert.match(notices[1]!, /durable delivery was unaffected/);

  const shortEpisode = createArrivalRetryNoticePolicy();
  assert.equal(shortEpisode.failure(0, 439), null);
  assert.equal(shortEpisode.recovery(10_000), null);
});

test("emitting a notification does not acknowledge, dequeue, or mutate delivery receipts", async () => {
  const receipt = {
    state: "pending",
    delivered_at: null,
    acked_at: null,
    ack_outcome: null,
  };
  const before = structuredClone(receipt);
  const cursor = {
    created_at: "2026-08-28T10:05:00.000Z",
    id: "66666666-6666-4666-8666-666666666666",
  };
  const signal = row(
    "77777777-7777-4777-8777-777777777777",
    "read only",
    "2026-08-28T10:06:00.000Z",
  );
  const abort = new AbortController();
  let readCalls = 0;
  await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memoryStore(cursor).store,
    signal: abort.signal,
    sleep: async () => {},
    readPage: async () => {
      readCalls += 1;
      return page([signal]);
    },
    emit: async () => abort.abort(),
  });
  assert.equal(readCalls, 1);
  assert.deepEqual(receipt, before);
});

test("a message naming this agent at position 1 is emitted, and one naming other agents still stops the watch", async () => {
  /* THE THROW THIS CLOSES, and it was live before this lane. L2 (merge 060ff67)
   * made the read edge return a signal to EVERY agent the sender named, while
   * `to_agent` still holds only the first. The guard here asked the scalar
   * question and THREW on a correct page, taking `cswarm inbox --notify` down
   * for a message the sender had addressed to this agent.
   *
   * The guard is not softened. It now asks whether the recipient set names this
   * principal, which is the question it always meant. */
  const otherAgent = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const secondSeat: SignalRecord = {
    ...row(
      "66666666-6666-4666-8666-666666666666",
      "both of you",
      "2026-08-28T10:05:00.000Z",
    ),
    to_agent: otherAgent,
    recipients: [
      { kind: "agent", id: otherAgent, position: 0 },
      { kind: "agent", id: AGENT, position: 1 },
    ],
  };
  const abort = new AbortController();
  const emitted: string[] = [];
  await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memoryStore({
      created_at: "2026-08-28T10:04:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    }).store,
    signal: abort.signal,
    sleep: async () => {},
    readPage: async () => page([secondSeat]),
    emit: async (signal) => {
      emitted.push(signal.id);
      abort.abort();
    },
  });
  assert.deepEqual(emitted, [secondSeat.id]);

  /* CONTROL: the SAME field, the same page shape, and the only difference is
   * that the set does not name this principal. The watch must still refuse it,
   * or the guard has been deleted rather than corrected. */
  const notMine: SignalRecord = {
    ...secondSeat,
    id: "77777777-7777-4777-8777-777777777777",
    recipients: [
      { kind: "agent", id: otherAgent, position: 0 },
      { kind: "agent", id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", position: 1 },
    ],
  };
  const refusedAbort = new AbortController();
  let refusedEmits = 0;
  const refused = await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memoryStore({
      created_at: "2026-08-28T10:04:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    }).store,
    signal: refusedAbort.signal,
    sleep: async () => {},
    readPage: async () => page([notMine]),
    emit: async () => {
      refusedEmits += 1;
      refusedAbort.abort();
    },
  });
  assert.equal(refused.reason, "error");
  assert.match(
    refused.error?.message ?? "",
    /directed to another workspace or agent/,
  );
  assert.equal(refusedEmits, 0, "and nothing was handed to the session");

  /* CONTROL: a page with NO recipients field at all still passes on the scalar
   * column, so an edge that never reports a set keeps working. */
  const scalarAbort = new AbortController();
  const scalarEmitted: string[] = [];
  await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memoryStore({
      created_at: "2026-08-28T10:04:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    }).store,
    signal: scalarAbort.signal,
    sleep: async () => {},
    readPage: async () =>
      page([
        row(
          "88888888-8888-4888-8888-888888888888",
          "old edge, scalar only",
          "2026-08-28T10:06:00.000Z",
        ),
      ]),
    emit: async (signal) => {
      scalarEmitted.push(signal.id);
      scalarAbort.abort();
    },
  });
  assert.equal(scalarEmitted.length, 1);
});

test("empty arrival pages back off to 60s and reset on a delivery", async () => {
  const existingCursor = {
    created_at: "2026-08-28T10:04:00.000Z",
    id: "55555555-5555-4555-8555-555555555555",
  };
  const delivered = row(
    "99999999-9999-4999-8999-999999999999",
    "arrived",
    "2026-08-28T10:07:00.000Z",
  );
  const memory = memoryStore(existingCursor);
  const abort = new AbortController();
  const sleeps: number[] = [];
  let reads = 0;
  const stop = await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memory.store,
    signal: abort.signal,
    pollMs: ARRIVAL_WATCH_POLL_MS,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    readPage: async () => {
      reads += 1;
      if (reads <= 3) return page([]);
      if (reads === 4) return page([delivered]);
      abort.abort();
      return page([]);
    },
    emit: async () => undefined,
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(
    sleeps.slice(0, 3),
    [
      nextIdlePollMs(ARRIVAL_WATCH_POLL_MS, 0),
      nextIdlePollMs(ARRIVAL_WATCH_POLL_MS, 1),
      nextIdlePollMs(ARRIVAL_WATCH_POLL_MS, 2),
    ],
  );
  assert.deepEqual(sleeps.slice(0, 3), [60_000, 60_000, 60_000]);
  assert.equal(sleeps[3], ARRIVAL_WATCH_POLL_MS, "a delivery resets the idle wait");
});

test("a second arrival watcher for the same agent names the other pid", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-notify-lock-"));
  const lockPath = join(root, "watch.lock");
  const ownerPid = process.pid;
  await acquireArrivalWatchLock(lockPath, ownerPid);
  await assert.rejects(
    () => acquireArrivalWatchLock(lockPath, ownerPid + 1),
    (error: unknown) => {
      assert.ok(error instanceof ArrivalWatchAlreadyRunningError);
      assert.equal(error.pid, ownerPid);
      assert.equal(error.message, arrivalWatchAlreadyRunningSentence(ownerPid));
      return true;
    },
  );
  await releaseArrivalWatchLock(lockPath, ownerPid);
  await acquireArrivalWatchLock(lockPath, ownerPid + 1);
  await releaseArrivalWatchLock(lockPath, ownerPid + 1);
  await rm(root, { recursive: true, force: true });
});

test("a stale arrival watch lock is stolen when the other pid is gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-notify-stale-"));
  const lockPath = join(root, "watch.lock");
  await writeFile(lockPath, `${JSON.stringify({ version: 1, pid: 999999 })}\n`, {
    mode: 0o600,
  });
  await acquireArrivalWatchLock(lockPath, process.pid);
  const raw = await readFile(lockPath, "utf8");
  assert.match(raw, new RegExp(`"pid":${process.pid}`));
  await releaseArrivalWatchLock(lockPath, process.pid);
  await rm(root, { recursive: true, force: true });
});

test("arrivalWatchLockHeld is true only while the lock names a live pid", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-notify-held-"));
  const lockPath = join(root, "watch.lock");
  assert.equal(await arrivalWatchLockHeld(lockPath), false);
  await acquireArrivalWatchLock(lockPath, process.pid);
  assert.equal(await arrivalWatchLockHeld(lockPath), true);
  await writeFile(lockPath, `${JSON.stringify({ version: 1, pid: 999999 })}\n`, {
    mode: 0o600,
  });
  assert.equal(await arrivalWatchLockHeld(lockPath), false);
  await rm(root, { recursive: true, force: true });
});

test("delayed SUBSCRIBED unblocks the wait so a later wake can emit", { timeout: 5_000 }, async () => {
  const nowMs = Date.parse("2026-09-06T00:00:00.000Z");
  const fake = new FakeRealtime();
  fake.autoSubscribe = false;
  const inner = createWakeSubscriber({
    target: CLOUD,
    now: () => nowMs,
    createRealtime: () => fake,
  });
  const abort = new AbortController();
  const memory = memoryStore(EXISTING_CURSOR);
  const arrived = row(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    "delayed wake",
    "2026-09-06T00:00:02.000Z",
  );
  const emitted: string[] = [];
  let reads = 0;
  try {
    await runArrivalWatch({
      workspaceId: WORKSPACE,
      principalId: AGENT,
      store: memory.store,
      signal: abort.signal,
      now: () => nowMs,
      wake: inner,
      sleep: async () => undefined,
      readPage: async () => {
        reads += 1;
        if (reads === 1) {
          setTimeout(() => {
            fake.channelInstance?.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
            fake.channelInstance?.emitWake();
          }, 0);
          return page([], { wake: WAKE_HINT });
        }
        return page([arrived], { wake: WAKE_HINT });
      },
      emit: async (signal) => {
        emitted.push(signal.id);
        abort.abort();
      },
    });
  } finally {
    abort.abort();
    await inner.close();
  }
  assert.deepEqual(emitted, [arrived.id]);
  assert.ok(reads >= 2, `delayed SUBSCRIBED must not hang next(); reads=${reads}`);
});

test("wake drives one read, one notification, and cursor advance", { timeout: 5_000 }, async () => {
  const nowMs = Date.parse("2026-09-06T00:00:00.000Z");
  const fake = new FakeRealtime();
  fake.autoSubscribe = true;
  const inner = createWakeSubscriber({
    target: CLOUD,
    now: () => nowMs,
    createRealtime: () => fake,
  });
  const abort = new AbortController();
  const memory = memoryStore(EXISTING_CURSOR);
  const arrived = row(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    "wake arrival",
    "2026-09-06T00:00:01.000Z",
  );
  const emitted: string[] = [];
  const lines: string[] = [];
  let reads = 0;
  let modeAtEnd: string | null = null;
  try {
    await runArrivalWatch({
      workspaceId: WORKSPACE,
      principalId: AGENT,
      store: memory.store,
      signal: abort.signal,
      now: () => nowMs,
      wake: inner,
      sleep: async () => undefined,
      readPage: async () => {
        reads += 1;
        if (reads === 1) return page([], { wake: WAKE_HINT });
        if (reads === 2) {
          queueMicrotask(() => fake.channelInstance?.emitWake());
          return page([], { wake: WAKE_HINT });
        }
        return page([arrived], { wake: WAKE_HINT });
      },
      emit: async (signal) => {
        const notification = arrivalNotification(signal, WORKSPACE, TARGET);
        lines.push(formatArrivalNotification(notification), JSON.stringify(notification));
        emitted.push(signal.id);
        abort.abort();
      },
    });
    modeAtEnd = inner.snapshot(nowMs).mode;
  } finally {
    abort.abort();
    await inner.close();
  }
  assert.equal(modeAtEnd, LISTENER_WAKE_MODE_PUSH);
  assert.equal(fake.authed, CLOUD.anonKey);
  assert.deepEqual(emitted, [arrived.id]);
  assert.equal(reads, 3, "the wake itself must cause exactly one inbox read");
  assert.deepEqual(memory.value(), { created_at: arrived.created_at, id: arrived.id });
  for (const line of lines) {
    assert.equal(line.includes(WAKE_TOPIC), false);
    assert.equal(line.includes("cswarm-wake:"), false);
  }
});

test("three wakes in a burst cause at most two reads", { timeout: 5_000 }, async () => {
  const nowMs = Date.parse("2026-09-06T00:00:00.000Z");
  const fake = new FakeRealtime();
  fake.autoSubscribe = true;
  const inner = createWakeSubscriber({
    target: CLOUD,
    now: () => nowMs,
    createRealtime: () => fake,
  });
  const abort = new AbortController();
  let reads = 0;
  let wakeReads = 0;
  const timer = setTimeout(() => abort.abort(), 50);
  try {
    await runArrivalWatch({
      workspaceId: WORKSPACE,
      principalId: AGENT,
      store: memoryStore(EXISTING_CURSOR).store,
      signal: abort.signal,
      now: () => nowMs,
      wake: inner,
      sleep: async () => undefined,
      readPage: async () => {
        reads += 1;
        if (reads === 2) {
          queueMicrotask(() => {
            fake.channelInstance?.emitWake();
            fake.channelInstance?.emitWake();
            fake.channelInstance?.emitWake();
          });
        }
        if (reads > 2) wakeReads += 1;
        if (wakeReads >= 2) abort.abort();
        return page([], { wake: WAKE_HINT });
      },
      emit: async () => undefined,
    });
  } finally {
    clearTimeout(timer);
    abort.abort();
    await inner.close();
  }
  assert.ok(wakeReads >= 1, `expected at least one wake read, got ${wakeReads}`);
  assert.ok(wakeReads <= 2, `three wakes must not each force a read; wakeReads=${wakeReads}`);
});

test("no poll timer while subscribed", { timeout: 5_000 }, async () => {
  const nowMs = Date.parse("2026-09-06T00:00:00.000Z");
  const fake = new FakeRealtime();
  fake.autoSubscribe = true;
  const inner = createWakeSubscriber({
    target: CLOUD,
    now: () => nowMs,
    createRealtime: () => fake,
  });
  const abort = new AbortController();
  const sleeps: number[] = [];
  let reads = 0;
  let modeAtEnd: string | null = null;
  try {
    await runArrivalWatch({
      workspaceId: WORKSPACE,
      principalId: AGENT,
      store: memoryStore(EXISTING_CURSOR).store,
      signal: abort.signal,
      now: () => nowMs,
      wake: inner,
      pollMs: ARRIVAL_WATCH_POLL_MS,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      readPage: async () => {
        reads += 1;
        if (reads >= 2) abort.abort();
        return page([], { wake: WAKE_HINT });
      },
      emit: async () => undefined,
    });
    modeAtEnd = inner.snapshot(nowMs).mode;
  } finally {
    abort.abort();
    await inner.close();
  }
  assert.equal(modeAtEnd, LISTENER_WAKE_MODE_PUSH);
  assert.equal(sleeps.includes(ARRIVAL_WATCH_POLL_MS), false);
  assert.equal(sleeps.includes(60_000), false);
  assert.ok(reads <= 2, `subscribed reconcile must not poll; reads=${reads}`);
});

test("CHANNEL_ERROR resumes the 60s poll and SUBSCRIBED stops it", { timeout: 5_000 }, async () => {
  const nowMs = Date.parse("2026-09-06T00:00:00.000Z");
  const fake = new FakeRealtime();
  fake.autoSubscribe = true;
  const inner = createWakeSubscriber({
    target: CLOUD,
    now: () => nowMs,
    createRealtime: () => fake,
  });
  const untils: number[] = [];
  const wake = recordUntil(inner, untils);
  const abort = new AbortController();
  let reads = 0;
  let modeAtEnd: string | null = null;
  const refused = new Error(
    `Unauthorized: You do not have permissions to read from this Channel topic: ${WAKE_TOPIC}`,
  );
  try {
    await runArrivalWatch({
      workspaceId: WORKSPACE,
      principalId: AGENT,
      store: memoryStore(EXISTING_CURSOR).store,
      signal: abort.signal,
      now: () => nowMs,
      wake,
      pollMs: ARRIVAL_WATCH_POLL_MS,
      sleep: async () => undefined,
      readPage: async () => {
        reads += 1;
        if (reads === 2) {
          queueMicrotask(() =>
            fake.channelInstance?.emitStatus(
              REALTIME_SUBSCRIBE_STATUS.CHANNEL_ERROR,
              refused,
            )
          );
        }
        if (reads === 3) {
          queueMicrotask(() =>
            fake.channelInstance?.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED)
          );
        }
        if (reads === 4) abort.abort();
        return page([], { wake: WAKE_HINT });
      },
      emit: async () => undefined,
    });
    modeAtEnd = inner.snapshot(nowMs).mode;
  } finally {
    abort.abort();
    await inner.close();
  }
  assert.ok(
    untils.includes(nowMs + ARRIVAL_WATCH_POLL_MS),
    `CHANNEL_ERROR must wait ${ARRIVAL_WATCH_POLL_MS}ms, untils=${untils.join(",")}`,
  );
  assert.ok(
    untils.includes(nowMs + LISTENER_RECONCILE_POLL_MS),
    `SUBSCRIBED must restore the ${LISTENER_RECONCILE_POLL_MS}ms reconcile, untils=${untils.join(",")}`,
  );
  assert.equal(modeAtEnd, LISTENER_WAKE_MODE_PUSH);
  assert.equal(ARRIVAL_WATCH_POLL_MS, 60_000);
  assert.equal(LISTENER_RECONCILE_POLL_MS, 300_000);
  assert.equal(refused.message.includes(WAKE_TOPIC), true, "positive control: the Realtime error names the topic");
});

test("a server response without wake keeps today's poll and never joins", async () => {
  const fake = new FakeRealtime();
  const inner = createWakeSubscriber({
    target: CLOUD,
    createRealtime: () => fake,
  });
  const abort = new AbortController();
  const sleeps: number[] = [];
  let reads = 0;
  const stop = await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memoryStore(EXISTING_CURSOR).store,
    signal: abort.signal,
    wake: inner,
    pollMs: ARRIVAL_WATCH_POLL_MS,
    sleep: async (ms) => {
      sleeps.push(ms);
      abort.abort();
    },
    readPage: async () => {
      reads += 1;
      return page([]);
    },
    emit: async () => undefined,
  });
  await inner.close();
  assert.equal(stop.reason, "cancelled");
  assert.equal(inner.hasTopic, false);
  assert.equal(fake.channels.length, 0);
  assert.deepEqual(sleeps, [ARRIVAL_WATCH_POLL_MS]);
  assert.equal(reads, 1);
});

test("arrival-watch source never imports claim or ack", async () => {
  const src = await readFile("src/cloud/arrival-watch.ts", "utf8");
  assert.equal(src.includes("claim_agent_inbox"), false);
  assert.equal(src.includes("ack_agent_delivery"), false);
  assert.equal(src.includes('from "./delivery.js"'), false);
  assert.equal(src.includes("from \"./delivery.js\""), false);
});
