/**
 * Pure client contract for agent-receive MVP: typed recipient resolution,
 * wait deadlines, JSON shapes, timeout/error separation, and the resilient
 * inbox --follow --ndjson receive stream.
 *
 * ★ THIS FILE IS NAMED IN `npm test` — a hand-run or typecheck-only pass is not a gate.
 */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  askWaitJsonPayload,
  BoundedSignalIdSet,
  formatFollowFrame,
  isFatalFollowError,
  isRetryableFollowError,
  nextFollowBackoffMs,
  nextWaitSleepMs,
  parseRetryAfterMs,
  parseWaitSeconds,
  pollForSignals,
  postSignalTargets,
  readSignals,
  resolveSignalRecipient,
  runInboxFollow,
  SIGNAL_FOLLOW_POLL_MS,
  SIGNAL_READ_TIMEOUT_MS,
  SIGNAL_WAIT_POLL_MS,
  SignalHttpError,
  SignalMalformedError,
  SignalReadTimeoutError,
  SignalTransportError,
  signalReadJsonPayload,
  waitDeadlineMs,
  type FollowFrame,
  type SignalDirectory,
} from "../../src/cloud/signals.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const USER_B = "44444444-4444-4444-8444-444444444444";
const AGENT = "22222222-2222-4222-8222-222222222222";
const AGENT_B = "55555555-5555-4555-8555-555555555555";
const SIGNAL = "33333333-3333-4333-8333-333333333333";
const REPLY = "66666666-6666-4666-8666-666666666666";

const directory: SignalDirectory = {
  members: [
    { user_id: USER, display_name: "Quill" },
    { user_id: USER_B, display_name: "Shared" },
  ],
  agents: [
    { principal_id: AGENT, name: "Hermes" },
    { principal_id: AGENT_B, name: "Shared" },
  ],
};

function row(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: SIGNAL,
    workspace_id: WORKSPACE,
    from: AGENT,
    from_kind: "agent",
    to: null,
    to_agent: null,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body: "mvp-ping",
    until: "2026-07-25T00:00:00.000Z",
    created_at: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

test("typed recipient resolution prefers exact UUID and unique name across members and agents", () => {
  assert.deepEqual(resolveSignalRecipient(USER, directory), {
    kind: "user",
    id: USER,
  });
  assert.deepEqual(resolveSignalRecipient(AGENT, directory), {
    kind: "agent",
    id: AGENT,
  });
  assert.deepEqual(resolveSignalRecipient("Hermes", directory), {
    kind: "agent",
    id: AGENT,
  });
  assert.deepEqual(resolveSignalRecipient("Quill", directory), {
    kind: "user",
    id: USER,
  });
  assert.throws(
    () => resolveSignalRecipient("Shared", directory),
    /ambiguous; use one of these ids: user 44444444.*agent 55555555/,
  );
  assert.throws(
    () => resolveSignalRecipient("Nobody", directory),
    /not a live member or agent/,
  );
  assert.throws(
    () =>
      resolveSignalRecipient("77777777-7777-4777-8777-777777777777", directory),
    /not a live member or agent/,
  );
});

test("postSignalTargets always emits both target fields and null in_reply_to", () => {
  assert.deepEqual(postSignalTargets(null), {
    to_user_id: null,
    to_agent_principal_id: null,
    in_reply_to: null,
  });
  assert.deepEqual(postSignalTargets({ kind: "user", id: USER }), {
    to_user_id: USER,
    to_agent_principal_id: null,
    in_reply_to: null,
  });
  assert.deepEqual(postSignalTargets({ kind: "agent", id: AGENT }), {
    to_user_id: null,
    to_agent_principal_id: AGENT,
    in_reply_to: null,
  });
});

test("wait seconds accept only integers in 1..300", () => {
  assert.equal(parseWaitSeconds("1"), 1);
  assert.equal(parseWaitSeconds("300"), 300);
  assert.throws(() => parseWaitSeconds("0"), /1\.\.300/);
  assert.throws(() => parseWaitSeconds("301"), /1\.\.300/);
  assert.throws(() => parseWaitSeconds("1.5"), /1\.\.300/);
  assert.throws(() => parseWaitSeconds("-1"), /1\.\.300/);
  assert.throws(() => parseWaitSeconds("abc"), /1\.\.300/);
});

test("wait deadline and sleep math clamp to remaining time", () => {
  assert.equal(waitDeadlineMs(30, 1_000_000), 1_030_000);
  assert.equal(nextWaitSleepMs(1_000_000, 1_030_000, 1_000), 1_000);
  assert.equal(nextWaitSleepMs(1_029_500, 1_030_000, 1_000), 500);
  assert.equal(nextWaitSleepMs(1_030_000, 1_030_000, 1_000), 0);
});

test("pollForSignals returns immediately on a match and times out without swallowing errors", async () => {
  let reads = 0;
  const hit = await pollForSignals({
    deadlineMs: 1_000_000,
    now: () => 0,
    sleep: async () => {
      throw new Error("sleep must not run when first read matches");
    },
    read: async () => {
      reads += 1;
      return [row()];
    },
  });
  assert.equal(hit.timedOut, false);
  assert.equal(hit.signals.length, 1);
  assert.equal(reads, 1);

  let clock = 0;
  const empty = await pollForSignals({
    deadlineMs: 50,
    now: () => clock,
    pollMs: 20,
    sleep: async (ms) => {
      clock += ms;
    },
    read: async () => [],
  });
  assert.equal(empty.timedOut, true);
  assert.deepEqual(empty.signals, []);

  await assert.rejects(
    pollForSignals({
      deadlineMs: 1_000,
      now: () => 0,
      sleep: async () => {},
      read: async () => {
        throw new Error("transport blew up");
      },
    }),
    /transport blew up/,
  );
});

test("pollForSignals probes after the last sleep so late arrivals are observed", async () => {
  let clock = 0;
  const deadlineMs = 100;
  const readAt: number[] = [];
  const arrived = await pollForSignals({
    deadlineMs,
    now: () => clock,
    pollMs: 100,
    sleep: async (ms) => {
      // Exhaust the wait window during sleep; the message "arrives" then.
      clock += ms;
    },
    read: async () => {
      readAt.push(clock);
      // First probe empty; probe after the final sleep sees the arrival.
      if (readAt.length === 1) return [];
      return [row()];
    },
  });
  assert.equal(arrived.timedOut, false);
  assert.equal(arrived.signals[0]?.body, "mvp-ping");
  assert.deepEqual(readAt, [0, 100]);
});

test("hung wait reads abort at the remaining deadline, not the 30s read ceiling", async () => {
  assert.ok(SIGNAL_READ_TIMEOUT_MS >= 30_000);
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const hungFetch = (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    return await new Promise<Response>((_resolve, reject) => {
      const onAbort = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;

  // Wall-clock causal proof: remaining budget is ~150ms, far below the 30s ceiling.
  const started = Date.now();
  const deadlineMs = started + 150;
  await assert.rejects(
    readSignals(
      target,
      { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
      { workspaceId: WORKSPACE, inbox: true },
      { fetcher: hungFetch, deadlineMs },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SignalReadTimeoutError);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 5_000,
    `hung wait-bound read must not approach the ${SIGNAL_READ_TIMEOUT_MS}ms ceiling; elapsed ${elapsed}ms`,
  );
  assert.ok(elapsed >= 50, `deadline should have been allowed to fire; elapsed ${elapsed}ms`);

  // A wait deadline already in the past fails as a typed timeout immediately.
  await assert.rejects(
    readSignals(
      target,
      { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
      { workspaceId: WORKSPACE, inbox: true },
      { fetcher: hungFetch, deadlineMs: Date.now() - 1 },
    ),
    (error: unknown) => error instanceof SignalReadTimeoutError,
  );
});

test("SignalReadTimeoutError during poll is a successful wait timeout, not a failure", async () => {
  let clock = 0;
  const wait = await pollForSignals({
    deadlineMs: 100,
    now: () => clock,
    pollMs: 50,
    sleep: async (ms) => {
      clock += ms;
    },
    read: async () => {
      throw new SignalReadTimeoutError();
    },
  });
  assert.equal(wait.timedOut, true);
  assert.deepEqual(wait.signals, []);
});

test("inbox wait JSON keeps one document and marks timeout without failing", () => {
  assert.deepEqual(
    signalReadJsonPayload(WORKSPACE, true, [], {
      waited: true,
      timedOut: true,
    }),
    {
      workspace_id: WORKSPACE,
      view: "inbox",
      signals: [],
      waited: true,
      timed_out: true,
      message: "Nothing arrived before the wait ended.",
    },
  );
  const arrived = signalReadJsonPayload(WORKSPACE, true, [row()], {
    waited: true,
    timedOut: false,
  });
  assert.equal(arrived.waited, true);
  assert.equal(arrived.timed_out, false);
  assert.equal(arrived.message, "1 signal visible.");
});

test("ask wait JSON returns ask plus reply or explicit timed_out success", () => {
  const ask = row({ kind: "ask", body: "mvp-ping" });
  const reply = row({
    id: REPLY,
    kind: "note",
    body: "mvp-pong",
    in_reply_to: SIGNAL,
  });
  assert.deepEqual(askWaitJsonPayload(ask, reply, false), {
    status: "accepted",
    message: "Ask shared and a correlated reply arrived.",
    signal: ask,
    reply,
    timed_out: false,
  });
  assert.deepEqual(askWaitJsonPayload(ask, null, true), {
    status: "accepted",
    message:
      "Ask shared. No reply arrived before the wait ended; the ask remains live.",
    signal: ask,
    reply: null,
    timed_out: true,
  });
});

// ---------------------------------------------------------------------------
// inbox --follow --ndjson resilient receive stream
// ---------------------------------------------------------------------------

test("follow backoff is exponential with jitter and respects Retry-After", () => {
  assert.ok(SIGNAL_FOLLOW_POLL_MS > SIGNAL_WAIT_POLL_MS || SIGNAL_FOLLOW_POLL_MS >= 1_000);
  assert.ok(SIGNAL_FOLLOW_POLL_MS >= 1_000, "follow poll must not be faster than 1Hz");
  // Fixed random = 0.5 => jitter factor 0.75 on the exponential base.
  assert.equal(nextFollowBackoffMs(1, null, () => 0.5), 375);
  assert.equal(nextFollowBackoffMs(2, null, () => 0.5), 750);
  assert.equal(nextFollowBackoffMs(3, null, () => 0.5), 1_500);
  assert.equal(nextFollowBackoffMs(1, 5_000, () => 0.5), 5_000);
  assert.equal(parseRetryAfterMs("2"), 2_000);
  assert.equal(parseRetryAfterMs("not-a-date"), null);
});

test("follow error classification: retryable 5xx/429/transport; fatal 4xx/malformed", () => {
  assert.equal(isRetryableFollowError(new SignalHttpError(500)), true);
  assert.equal(isRetryableFollowError(new SignalHttpError(429, 1_000)), true);
  assert.equal(isRetryableFollowError(new SignalTransportError()), true);
  assert.equal(isRetryableFollowError(new SignalReadTimeoutError()), true);
  assert.equal(isRetryableFollowError(new SignalHttpError(401)), false);
  assert.equal(isFatalFollowError(new SignalHttpError(400)), true);
  assert.equal(isFatalFollowError(new SignalHttpError(401)), true);
  assert.equal(isFatalFollowError(new SignalHttpError(403)), true);
  assert.equal(isFatalFollowError(new SignalHttpError(404)), true);
  assert.equal(isFatalFollowError(new SignalHttpError(426)), true);
  assert.equal(isFatalFollowError(new SignalMalformedError("bad")), true);
  assert.equal(isFatalFollowError(new SignalHttpError(500)), false);
});

test("BoundedSignalIdSet suppresses duplicates and evicts oldest when full", () => {
  const seen = new BoundedSignalIdSet(2);
  assert.equal(seen.add("a"), true);
  assert.equal(seen.add("a"), false);
  assert.equal(seen.add("b"), true);
  assert.equal(seen.add("c"), true);
  assert.equal(seen.has("a"), false);
  assert.equal(seen.has("b"), true);
  assert.equal(seen.has("c"), true);
});

test("formatFollowFrame emits one-line NDJSON without a trailing newline", () => {
  const ready = formatFollowFrame({
    type: "ready",
    workspace_id: WORKSPACE,
    view: "inbox",
    ts: "2026-07-30T00:00:00.000Z",
  });
  assert.equal(ready.includes("\n"), false);
  assert.equal(JSON.parse(ready).type, "ready");
  const signal = formatFollowFrame({
    type: "signal",
    signal: row(),
    ts: "2026-07-30T00:00:00.000Z",
  });
  assert.equal(JSON.parse(signal).signal.id, SIGNAL);
});

test("follow emits ready only after first successful arm, then signals", async () => {
  const frames: FollowFrame[] = [];
  let arms = 0;
  const controller = new AbortController();
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    random: () => 0,
    sleep: async () => {
      controller.abort();
    },
    signal: controller.signal,
    arm: async () => {
      arms += 1;
      if (arms === 1) return [row()];
      return [];
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(frames[0]?.type, "ready");
  assert.equal(frames[1]?.type, "signal");
  if (frames[1]?.type === "signal") {
    assert.equal(frames[1].signal.body, "mvp-ping");
  }
  assert.ok(arms >= 1);
});

test("follow recovers from transient 500 then emits ready and signals", async () => {
  const frames: FollowFrame[] = [];
  let arms = 0;
  const controller = new AbortController();
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    random: () => 0,
    sleep: async () => {},
    signal: controller.signal,
    arm: async () => {
      arms += 1;
      if (arms === 1) throw new SignalHttpError(500);
      if (arms === 2) return [row()];
      controller.abort();
      return [];
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "cancelled");
  // No ready before the successful arm; no retrying frames before ready either.
  assert.equal(frames[0]?.type, "ready");
  assert.equal(frames[1]?.type, "signal");
  assert.equal(frames.some((f) => f.type === "retrying"), false);
  assert.ok(arms >= 2);
});

test("follow emits retrying after ready when a later 500 occurs, then recovers", async () => {
  const frames: FollowFrame[] = [];
  let arms = 0;
  const controller = new AbortController();
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    random: () => 0,
    sleep: async () => {},
    signal: controller.signal,
    arm: async () => {
      arms += 1;
      if (arms === 1) return [];
      if (arms === 2) throw new SignalHttpError(500);
      if (arms === 3) return [row()];
      controller.abort();
      return [];
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(frames[0]?.type, "ready");
  const retry = frames.find((f) => f.type === "retrying");
  assert.ok(retry && retry.type === "retrying");
  assert.equal(retry.reason, "http_500");
  assert.ok(frames.some((f) => f.type === "signal"));
});

test("follow stops on fatal 4xx without retrying", async () => {
  const frames: FollowFrame[] = [];
  let arms = 0;
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    sleep: async () => {
      throw new Error("sleep must not run on fatal 4xx");
    },
    arm: async () => {
      arms += 1;
      throw new SignalHttpError(403);
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "fatal_http");
  assert.equal(frames.length, 0);
  assert.equal(arms, 1);
  assert.match(stop.error?.message ?? "", /HTTP 403/);
});

test("follow rearm after signal and suppresses duplicate live rows", async () => {
  const frames: FollowFrame[] = [];
  let arms = 0;
  const controller = new AbortController();
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    random: () => 0,
    pollMs: 10,
    sleep: async () => {},
    signal: controller.signal,
    arm: async () => {
      arms += 1;
      // Same live row on every arm — must emit once only.
      if (arms >= 4) controller.abort();
      return [row()];
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(frames.filter((f) => f.type === "ready").length, 1);
  assert.equal(frames.filter((f) => f.type === "signal").length, 1);
  assert.ok(arms >= 3, "must rearm after the first emission");
});

test("follow cancellation during idle poll stops cleanly", async () => {
  const frames: FollowFrame[] = [];
  const controller = new AbortController();
  let arms = 0;
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    pollMs: 50,
    sleep: async () => {
      controller.abort();
    },
    signal: controller.signal,
    arm: async () => {
      arms += 1;
      return [];
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(frames[0]?.type, "ready");
  assert.equal(frames.some((f) => f.type === "signal"), false);
  assert.equal(arms, 1);
});

test("follow removes its abort listener after every completed idle poll", async () => {
  const controller = new AbortController();
  let arms = 0;
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    pollMs: 1,
    sleep: async () => {},
    signal: controller.signal,
    arm: async () => {
      assert.equal(
        getEventListeners(controller.signal, "abort").length,
        0,
        "the prior poll left an abort listener behind",
      );
      arms += 1;
      if (arms === 4) controller.abort();
      return [];
    },
    emit: () => undefined,
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(arms, 4);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("follow secret/credential absence never emits ready", async () => {
  const frames: FollowFrame[] = [];
  const secretMissing = new Error("agent credential secret is absent");
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    sleep: async () => {
      throw new Error("sleep must not run when secret is absent");
    },
    isCredentialFailure: (error) =>
      error instanceof Error && /secret is absent/.test(error.message),
    arm: async () => {
      throw secretMissing;
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "credential");
  assert.equal(frames.length, 0);
  assert.equal(stop.error, secretMissing);
});

test("readSignals surfaces typed HTTP status for follow classification", async () => {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const fetcher = (async () =>
    new Response(null, {
      status: 500,
      headers: { "retry-after": "3" },
    })) as typeof fetch;
  await assert.rejects(
    readSignals(
      target,
      { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
      { workspaceId: WORKSPACE, inbox: true },
      { fetcher },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SignalHttpError);
      assert.equal(error.status, 500);
      assert.equal(error.retryAfterMs, 3_000);
      return true;
    },
  );
});
