import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FEED_POLL_MS,
  FEED_PUSH_FALLBACK_STATUSES,
  FEED_RECONCILE_MS,
  FeedPushController,
  WORKSPACE_SIGNALS_EVENT,
  WORKSPACE_SIGNALS_TOPIC_PREFIX,
  attachWorkspaceSignalsChannel,
  feedRefreshIntervalMs,
  isFeedPushFallbackStatus,
  workspaceSignalsTopic,
} from "./feed-push.ts";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    now: () => now,
    setInterval(fn, ms) {
      const id = nextId++;
      intervals.set(id, { fn, ms, next: now + ms });
      return id;
    },
    clearInterval(id) {
      if (id !== undefined) intervals.delete(id);
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      timeouts.set(id, { fn, due: now + ms });
      return id;
    },
    clearTimeout(id) {
      if (id !== undefined) timeouts.delete(id);
    },
    async tick(ms) {
      const end = now + ms;
      while (true) {
        let soonest = null;
        for (const [id, item] of timeouts) {
          if (item.due <= end && (soonest === null || item.due < soonest.at)) {
            soonest = {
              at: item.due,
              run: () => {
                timeouts.delete(id);
                item.fn();
              },
            };
          }
        }
        for (const [, item] of intervals) {
          if (item.next <= end && (soonest === null || item.next < soonest.at)) {
            soonest = {
              at: item.next,
              run: () => {
                item.fn();
                item.next += item.ms;
              },
            };
          }
        }
        if (soonest === null) {
          now = end;
          return;
        }
        now = soonest.at;
        soonest.run();
        await Promise.resolve();
      }
    },
  };
}

function createFakeClient() {
  const log = [];
  const channels = [];
  const client = {
    channel(topic, opts) {
      log.push({ op: "channel", topic, opts });
      const ch = {
        topic,
        opts,
        eventHandler: null,
        statusHandler: null,
        on(_type, filter, cb) {
          log.push({ op: "on", event: filter.event, topic });
          ch.eventHandler = cb;
          return ch;
        },
        subscribe(cb) {
          log.push({ op: "subscribe", topic });
          ch.statusHandler = cb;
          return ch;
        },
      };
      channels.push(ch);
      return ch;
    },
    async removeChannel(ch) {
      log.push({ op: "removeChannel", topic: ch.topic });
      const index = channels.indexOf(ch);
      if (index >= 0) channels.splice(index, 1);
    },
  };
  return { client, log, channels };
}

function createHarness(refresh) {
  const timers = createFakeTimers();
  const fake = createFakeClient();
  const refreshes = { count: 0 };
  const controller = new FeedPushController({
    subscribe: async (workspaceId, onEvent, onStatus) =>
      attachWorkspaceSignalsChannel(fake.client, workspaceId, onEvent, onStatus),
    refresh: refresh ?? (async () => {
      refreshes.count += 1;
    }),
    timers,
  });
  return { controller, timers, fake, refreshes };
}

async function subscribed(harness, workspaceId = WS_A) {
  harness.controller.start(workspaceId);
  harness.controller.arm();
  await harness.controller.whenIdle();
  const channel = harness.fake.channels.at(-1);
  assert.ok(channel, "subscribe must create a channel");
  channel.statusHandler("SUBSCRIBED");
  return channel;
}

test("topic is the workspace prefix plus a lowercased uuid", () => {
  assert.equal(workspaceSignalsTopic(WS_A), `${WORKSPACE_SIGNALS_TOPIC_PREFIX}${WS_A}`);
  assert.equal(
    workspaceSignalsTopic("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
    `${WORKSPACE_SIGNALS_TOPIC_PREFIX}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  );
  assert.throws(() => workspaceSignalsTopic("sample-design-studio"));
});

test("fallback statuses are the named Realtime subscribe states, not error.message", () => {
  assert.deepEqual([...FEED_PUSH_FALLBACK_STATUSES], [
    "CHANNEL_ERROR",
    "TIMED_OUT",
    "CLOSED",
  ]);
  assert.equal(isFeedPushFallbackStatus("CHANNEL_ERROR"), true);
  assert.equal(isFeedPushFallbackStatus("TIMED_OUT"), true);
  assert.equal(isFeedPushFallbackStatus("CLOSED"), true);
  assert.equal(isFeedPushFallbackStatus("SUBSCRIBED"), false);
  assert.equal(isFeedPushFallbackStatus("Unauthorized"), false);
  assert.equal(feedRefreshIntervalMs(true), FEED_RECONCILE_MS);
  assert.equal(feedRefreshIntervalMs(false), FEED_POLL_MS);
  assert.equal(FEED_POLL_MS, 2_000);
  assert.equal(FEED_RECONCILE_MS, 30_000);
});

test("fake client joins the private signal topic", async () => {
  const { controller, fake } = createHarness();
  controller.start(WS_A);
  await controller.whenIdle();
  assert.equal(fake.channels.length, 1);
  assert.equal(fake.channels[0].topic, workspaceSignalsTopic(WS_A));
  assert.equal(fake.channels[0].opts.config.private, true);
  assert.deepEqual(fake.log.filter((row) => row.op === "on").map((row) => row.event), [
    WORKSPACE_SIGNALS_EVENT,
  ]);
});

test("subscribed: no poll timer fires before the 30 s reconcile", async () => {
  const harness = createHarness();
  await subscribed(harness);
  assert.equal(harness.controller.subscribed, true);
  await harness.timers.tick(30_000 - 1);
  assert.equal(harness.refreshes.count, 0);
});

test("a signal event triggers one refresh", async () => {
  const harness = createHarness();
  const channel = await subscribed(harness);
  channel.eventHandler({});
  await Promise.resolve();
  assert.equal(harness.refreshes.count, 1);
});

test("three events in 100 ms coalesce to at most two refreshes", async () => {
  let release;
  let started = 0;
  let finished = 0;
  const harness = createHarness(async () => {
    started += 1;
    if (started === 1) {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    finished += 1;
  });
  const channel = await subscribed(harness);
  channel.eventHandler({});
  channel.eventHandler({});
  channel.eventHandler({});
  await Promise.resolve();
  assert.equal(started, 1, "the first refresh is in flight");
  release();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(started, 2);
  assert.equal(finished, 2);
  assert.ok(started <= 2);
});

test("CHANNEL_ERROR resumes the two-second poll", async () => {
  const harness = createHarness();
  const channel = await subscribed(harness);
  await harness.timers.tick(30_000 - 1);
  assert.equal(harness.refreshes.count, 0);
  channel.statusHandler("CHANNEL_ERROR");
  assert.equal(harness.controller.subscribed, false);
  await harness.timers.tick(FEED_POLL_MS);
  assert.equal(harness.refreshes.count, 1);
  await harness.timers.tick(FEED_POLL_MS);
  assert.equal(harness.refreshes.count, 2);
});

test("TIMED_OUT and CLOSED also resume the poll", async () => {
  for (const status of ["TIMED_OUT", "CLOSED"]) {
    const harness = createHarness();
    const channel = await subscribed(harness);
    channel.statusHandler(status);
    assert.equal(harness.controller.subscribed, false, status);
    await harness.timers.tick(FEED_POLL_MS);
    assert.equal(harness.refreshes.count, 1, status);
  }
});

test("re-SUBSCRIBED stops the poll", async () => {
  const harness = createHarness();
  const first = await subscribed(harness);
  first.statusHandler("CHANNEL_ERROR");
  await harness.timers.tick(FEED_POLL_MS);
  const afterPoll = harness.refreshes.count;
  assert.ok(afterPoll >= 1);
  await harness.controller.whenIdle();
  const next = harness.fake.channels.at(-1);
  assert.ok(next);
  assert.notEqual(next, first);
  next.statusHandler("SUBSCRIBED");
  assert.equal(harness.controller.subscribed, true);
  const atPush = harness.refreshes.count;
  await harness.timers.tick(30_000 - 1);
  assert.equal(harness.refreshes.count, atPush);
});

test("workspace switch removes the old channel before the new subscribe", async () => {
  const harness = createHarness();
  harness.controller.start(WS_A);
  await harness.controller.whenIdle();
  assert.equal(harness.fake.channels[0].topic, workspaceSignalsTopic(WS_A));
  harness.controller.start(WS_B);
  await harness.controller.whenIdle();
  const ops = harness.fake.log
    .filter((row) => row.op === "channel" || row.op === "removeChannel")
    .map((row) => `${row.op}:${row.topic}`);
  const removeA = ops.indexOf(`removeChannel:${workspaceSignalsTopic(WS_A)}`);
  const channelB = ops.indexOf(`channel:${workspaceSignalsTopic(WS_B)}`);
  assert.ok(removeA >= 0, `old channel was removed: ${ops.join(" ")}`);
  assert.ok(channelB >= 0, `new channel was created: ${ops.join(" ")}`);
  assert.ok(
    removeA < channelB,
    `old channel must go before the new subscribe: ${ops.join(" ")}`,
  );
});

test("reconcile fires once at 30 seconds while subscribed", async () => {
  const harness = createHarness();
  await subscribed(harness);
  await harness.timers.tick(30_000 - 1);
  assert.equal(harness.refreshes.count, 0);
  await harness.timers.tick(1);
  assert.equal(harness.refreshes.count, 1);
});

test("a 0.1.57 silent topic still reconciles; poll covers a refused join", async () => {
  const silent = createHarness();
  await subscribed(silent);
  await silent.timers.tick(FEED_RECONCILE_MS);
  assert.equal(silent.refreshes.count, 1);

  const refused = createHarness();
  refused.controller.start(WS_A);
  refused.controller.arm();
  await refused.controller.whenIdle();
  refused.fake.channels[0].statusHandler("CHANNEL_ERROR");
  await refused.timers.tick(FEED_POLL_MS);
  assert.equal(refused.refreshes.count, 1);
});
