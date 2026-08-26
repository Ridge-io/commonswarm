/** Pure listener routing and queue tests. This file is named in `npm test`. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendListenerEvent,
  decideListenerRoute,
  FilePendingMainQueue,
  listenerPaths,
  type PendingMainEntry,
} from "../src/listener/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";

test("the pure route decision keeps equal and smaller split asks on the worker", () => {
  assert.equal(decideListenerRoute("worker", null, 10_000), "worker");
  assert.equal(decideListenerRoute("main", null, 1), "main");
  assert.equal(decideListenerRoute("split", 240, 239), "worker");
  assert.equal(decideListenerRoute("split", 240, 240), "worker");
  assert.equal(decideListenerRoute("split", 240, 241), "main");
  assert.equal(decideListenerRoute("split", 1, 2), "main");
  assert.equal(decideListenerRoute("split", 10_000, 10_000), "worker");
});

function entry(index: number): PendingMainEntry {
  const suffix = String(index).padStart(12, "0");
  return {
    signalId: `00000000-0000-4000-8000-${suffix}`,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    fromId: "33333333-3333-4333-8333-333333333333",
    fromKind: "agent",
    senderName: "Wren",
    body: `ask ${index}`,
    createdAt: "2026-08-26T00:00:00.000Z",
    queuedAt: "2026-08-26T00:00:01.000Z",
  };
}

test("the pending-main queue drops its oldest entry at 200 and emits a warning event", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-main-route-"));
  try {
    const paths = listenerPaths({
      profileId: "routing-test",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      stateDirectory: root,
    });
    const queue = new FilePendingMainQueue(paths.instanceDirectory);
    let last = { count: 0, added: false, droppedOldest: false };
    for (let index = 1; index <= 201; index += 1) {
      last = await queue.enqueue(entry(index));
    }
    assert.deepEqual(last, { count: 200, added: true, droppedOldest: true });
    const stored = await queue.read();
    assert.equal(stored.length, 200);
    assert.equal(stored[0]?.signalId, entry(2).signalId);
    assert.equal(stored.at(-1)?.signalId, entry(201).signalId);

    await appendListenerEvent(paths, {
      ts: "2026-08-26T00:00:01.000Z",
      event: "listener_routing_decision",
      signal_id: entry(201).signalId,
      route_mode: "split",
      route_decision: "main",
      defer_over_chars: 12,
      body_length: 13,
    });
    await appendListenerEvent(paths, {
      ts: "2026-08-26T00:00:02.000Z",
      event: "listener_main_queue_oldest_dropped",
      signal_id: entry(201).signalId,
      pending_main_count: 200,
      dropped_count: 1,
    });
    const log = await readFile(paths.logPath, "utf8");
    assert.match(log, /"defer_over_chars":12,"body_length":13/);
    assert.match(log, /"event":"listener_main_queue_oldest_dropped"/);
    assert.match(log, /"dropped_count":1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
