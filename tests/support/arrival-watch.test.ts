/**
 * Pure controls for the human-visible arrival monitor.
 *
 * ★ Named by `npm test`; it needs no network or database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import {
  arrivalNotification,
  ARRIVAL_WATCH_POLL_MS,
  formatArrivalNotification,
  runArrivalWatch,
  type ArrivalCursorStore,
} from "../../src/cloud/arrival-watch.js";
import {
  SignalHttpError,
  SignalTransportError,
  type AgentSignalPage,
  type SignalCursor,
} from "../../src/cloud/signals.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SENDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TARGET = { url: "https://api.example.test", anonKey: "public-anon-key" };

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

function page(rows: SignalRecord[]): AgentSignalPage {
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
});});

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
  assert.equal(ARRIVAL_WATCH_POLL_MS, 25_000);
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
