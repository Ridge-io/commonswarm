/**
 * Pure client contract for agent-receive MVP: typed recipient resolution,
 * wait deadlines, JSON shapes, timeout/error separation, and the resilient
 * inbox --follow --ndjson receive stream.
 *
 * ★ THIS FILE IS NAMED IN `npm test` — a hand-run or typecheck-only pass is not a gate.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listenerStatusJson } from "../../src/cli.js";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  listenerPaths,
  runListenerSupervisor,
  type ListenerRuntimeEvent,
  type ListenerStatus,
} from "../../src/listener/index.js";
import {
  askWaitJsonPayload,
  BoundedSignalIdSet,
  compareSignalCursor,
  decayFollowAttempt,
  followHttpDetails,
  formatFollowFrame,
  isFatalFollowError,
  isFollowCredentialFailure,
  isRetryableFollowError,
  nextFollowBackoffMs,
  nextWaitSleepMs,
  parseRetryAfterMs,
  parseSignalRecord,
  parseWaitSeconds,
  pollForSignals,
  postSignalTargets,
  readAgentSignalPage,
  readSignals,
  resolveSignalRecipient,
  followErrorEnvelope,
  runInboxFollow,
  SIGNAL_FOLLOW_PAGE_LIMIT,
  SIGNAL_FOLLOW_POLL_MS,
  SIGNAL_FOLLOW_POST_EMIT_MS,
  SIGNAL_READ_TIMEOUT_MS,
  SIGNAL_WAIT_POLL_MS,
  SignalHttpError,
  SignalMalformedError,
  SignalReadTimeoutError,
  SignalTransportError,
  signalReadJsonPayload,
  waitDeadlineMs,
  type FollowArmRequest,
  type FollowFrame,
  type SignalDirectory,
} from "../../src/cloud/signals.js";
import { describeMintRenewal } from "../../src/cloud/renewal.js";
import {
  describeServerError,
  EMPTY_SERVER_ERROR_ENVELOPE,
  parseServerErrorEnvelope,
  serverRefusedRetry,
} from "../../src/cloud/error-envelope.js";

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
  assert.ok(
    SIGNAL_FOLLOW_POLL_MS > SIGNAL_WAIT_POLL_MS,
    "follow idle poll must be slower than the wait path's 1Hz",
  );
  assert.ok(SIGNAL_FOLLOW_POST_EMIT_MS > 0);
  assert.ok(SIGNAL_FOLLOW_POST_EMIT_MS < SIGNAL_FOLLOW_POLL_MS);
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

test("follow stops on non-credential fatal 4xx without retrying", async () => {
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
      throw new SignalHttpError(400);
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "fatal_http");
  assert.equal(frames.length, 0);
  assert.equal(arms, 1);
  assert.match(stop.error?.message ?? "", /HTTP 400/);
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
  assert.equal(isFollowCredentialFailure(secretMissing), true);
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    sleep: async () => {
      throw new Error("sleep must not run when secret is absent");
    },
    arm: async () => {
      throw secretMissing;
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "credential");
  assert.equal(frames.length, 0);
  assert.equal(stop.error, secretMissing);
});

test("follow classifies agent read 401/403 as credential stop", async () => {
  for (const status of [401, 403]) {
    const refusal = new SignalHttpError(status);
    assert.equal(isFollowCredentialFailure(refusal), true);
    const stop = await runInboxFollow({
      workspaceId: WORKSPACE,
      now: () => 1_700_000_000_000,
      sleep: async () => {
        throw new Error("sleep must not run after credential refusal");
      },
      arm: async () => {
        throw refusal;
      },
      emit: () => {
        throw new Error("credential refusal must not emit ready");
      },
    });
    assert.equal(stop.reason, "credential");
    assert.equal(stop.error, refusal);
  }
});

test("follow cancels during retry backoff and clears the delay timer", async () => {
  const frames: FollowFrame[] = [];
  const controller = new AbortController();
  let arms = 0;
  let sleeps = 0;
  const started = Date.now();
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    random: () => 0,
    signal: controller.signal,
    arm: async () => {
      arms += 1;
      if (arms === 1) return [];
      // After ready, a long Retry-After would hang if cancel did not clear timers.
      throw new SignalHttpError(429, 30_000);
    },
    sleep: async (ms) => {
      sleeps += 1;
      // First sleep is the empty idle rearm; second is the 429 backoff.
      if (sleeps >= 2 || ms >= 30_000) controller.abort();
    },
    emit: (frame) => frames.push(frame),
  });
  const elapsed = Date.now() - started;
  assert.equal(stop.reason, "cancelled");
  assert.equal(frames[0]?.type, "ready");
  assert.ok(frames.some((f) => f.type === "retrying"));
  assert.ok(
    elapsed < 5_000,
    `cancel during backoff must not wait out Retry-After; elapsed ${elapsed}ms`,
  );
});

test("follow recovers from 429 using Retry-After delay and rearm", async () => {
  const frames: FollowFrame[] = [];
  const sleeps: number[] = [];
  let arms = 0;
  const controller = new AbortController();
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    random: () => 0,
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    arm: async () => {
      arms += 1;
      if (arms === 1) return [];
      if (arms === 2) throw new SignalHttpError(429, 5_000);
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
  assert.equal(retry.reason, "http_429");
  assert.equal(retry.delay_ms, 5_000);
  assert.ok(sleeps.includes(5_000));
  assert.ok(frames.some((f) => f.type === "signal"));
});

test("follow rearm after signal uses post-emit spacing not zero delay", async () => {
  const sleeps: number[] = [];
  let arms = 0;
  const controller = new AbortController();
  await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    postEmitMs: 40,
    pollMs: 200,
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (arms >= 2) controller.abort();
    },
    arm: async () => {
      arms += 1;
      return arms === 1 ? [row()] : [];
    },
    emit: () => {},
  });
  assert.ok(sleeps.includes(40), `expected post-emit delay; sleeps=${sleeps.join(",")}`);
  assert.ok(!sleeps.includes(0));
});

test("readSignals keeps plain Error taxonomy while carrying Retry-After for follow", async () => {
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
      assert.ok(error instanceof Error);
      assert.equal(error.name, "Error");
      assert.match(error.message, /HTTP 500/);
      const details = followHttpDetails(error);
      assert.equal(details?.status, 500);
      assert.equal(details?.retryAfterMs, 3_000);
      assert.equal(isRetryableFollowError(error), true);
      return true;
    },
  );
});

test("agent signal pages expose capabilities and fail closed on absent markers", async () => {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      signals: [{ ...row(), sender_owner_relation: "same_owner" }],
      capabilities: { sender_owner_relation: 1, cursor_after: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const page = await readAgentSignalPage(
    target,
    { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
    {
      workspaceId: WORKSPACE,
      inbox: true,
      kind: "ask",
      ascending: true,
      limit: 100,
    },
    { fetcher },
  );
  assert.deepEqual(page.capabilities, {
    senderOwnerRelation: true,
    cursorAfter: true,
    deliveryClaim: false,
    deliveryAck: false,
  });
  assert.equal(page.legacyCursorFallback, false);
  assert.equal(bodies[0]?.after_created_at, null);
  assert.equal(bodies[0]?.after_id, null);
  assert.equal(page.signals[0]?.sender_owner_relation, "same_owner");

  const old = await readAgentSignalPage(
    target,
    { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
    { workspaceId: WORKSPACE, inbox: true },
    {
      fetcher: (async () =>
        new Response(JSON.stringify({ signals: [row()] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    },
  );
  assert.deepEqual(old.capabilities, {
    senderOwnerRelation: false,
    cursorAfter: false,
    deliveryClaim: false,
    deliveryAck: false,
  });
  assert.equal(old.signals[0]?.sender_owner_relation, "unknown");
});

test("legacy cursor fallback is explicit and a capable 400 still fails", async () => {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const requests: Array<Record<string, unknown>> = [];
  const legacyFetcher = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (Object.hasOwn(body, "after_created_at")) {
      return new Response("{}", { status: 400 });
    }
    return new Response(JSON.stringify({ signals: [row()] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const page = await readAgentSignalPage(
    target,
    { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
    {
      workspaceId: WORKSPACE,
      inbox: true,
      ascending: true,
      limit: 100,
    },
    { fetcher: legacyFetcher },
    { allowLegacyCursorFallback: true },
  );
  assert.equal(page.legacyCursorFallback, true);
  assert.equal(requests.length, 2);
  assert.equal(Object.hasOwn(requests[1]!, "after_created_at"), false);

  await assert.rejects(
    readAgentSignalPage(
      target,
      { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
      {
        workspaceId: WORKSPACE,
        inbox: true,
        ascending: true,
        limit: 100,
      },
      {
        fetcher: (async (
          _url: string | URL | Request,
          init?: RequestInit,
        ) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Object.hasOwn(body, "after_created_at")
            ? new Response("{}", { status: 400 })
            : new Response(JSON.stringify({
              signals: [],
              capabilities: { sender_owner_relation: 1, cursor_after: 1 },
            }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
        }) as typeof fetch,
      },
      { allowLegacyCursorFallback: true },
    ),
    /HTTP 400/,
  );
});

test("follow-only row quarantine is bounded and preserves a raw page cursor", async () => {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const malformed = { ...row(), body: "" };
  const last = row({
    id: "13111111-1111-4111-8111-111111111111",
    created_at: "2026-07-24T00:00:02.000Z",
  });
  const response = () =>
    new Response(JSON.stringify({
      signals: [malformed, last],
      capabilities: { sender_owner_relation: 1, cursor_after: 1 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  await assert.rejects(
    readAgentSignalPage(
      target,
      { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
      { workspaceId: WORKSPACE, inbox: true, ascending: true },
      { fetcher: (async () => response()) as typeof fetch },
    ),
    /malformed signal data/,
  );

  const diagnostics: number[] = [];
  const page = await readAgentSignalPage(
    target,
    { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
    { workspaceId: WORKSPACE, inbox: true, ascending: true },
    { fetcher: (async () => response()) as typeof fetch },
    {
      tolerateMalformedRows: true,
      maxMalformedRows: 1,
      onMalformedRow: (index) => diagnostics.push(index),
    },
  );
  assert.equal(page.rawCount, 2);
  assert.equal(page.malformedRows, 1);
  assert.deepEqual(diagnostics, [0]);
  assert.deepEqual(page.signals.map((item) => item.id), [last.id]);
  assert.deepEqual(page.nextCursor, {
    created_at: last.created_at,
    id: last.id,
  });

  await assert.rejects(
    readAgentSignalPage(
      target,
      { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
      { workspaceId: WORKSPACE, inbox: true, ascending: true },
      {
        fetcher: (async () =>
          new Response(JSON.stringify({
            signals: [malformed, malformed],
            capabilities: { sender_owner_relation: 1, cursor_after: 1 },
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      },
      { tolerateMalformedRows: true, maxMalformedRows: 1 },
    ),
    /too many malformed rows/,
  );
});

test("follow refuses a full quarantined page without a safe terminal cursor", async () => {
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    pageLimit: 1,
    sleep: async () => {},
    arm: async () => ({
      signals: [],
      rawCount: 1,
      nextCursor: null,
      canPage: true,
    }),
    emit: () => undefined,
  });
  assert.equal(stop.reason, "malformed");
  assert.match(stop.error?.message ?? "", /terminal cursor is malformed/);
});

// ---------------------------------------------------------------------------
// Lossless follow cursor, tolerant parse, honest renewal copy
// ---------------------------------------------------------------------------

test("parseSignalRecord ignores unknown fields and fails closed on bad required data", () => {
  const base = row();
  const parsed = parseSignalRecord({
    ...base,
    future_enum: "whatever",
    extra_nested: { a: 1 },
  });
  assert.equal(parsed.id, base.id);
  assert.equal(parsed.body, base.body);
  // Absent relation from an older edge is fail-closed to unknown for wake.
  assert.equal(parsed.sender_owner_relation, "unknown");
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed, "future_enum"),
    false,
  );

  // Absent optional fields from an older edge normalize to null / unknown.
  const legacy = parseSignalRecord({
    id: base.id,
    workspace_id: base.workspace_id,
    from: base.from,
    from_kind: base.from_kind,
    to: null,
    about: null,
    kind: "note",
    body: "hello",
    until: base.until,
    created_at: base.created_at,
  });
  assert.equal(legacy.to_agent, null);
  assert.equal(legacy.in_reply_to, null);
  assert.equal(legacy.sender_owner_relation, "unknown");

  const related = parseSignalRecord({
    ...base,
    sender_owner_relation: "same_owner",
  });
  assert.equal(related.sender_owner_relation, "same_owner");

  // Present-but-invalid optional UUID fails closed.
  assert.throws(
    () => parseSignalRecord({ ...base, to_agent: "not-a-uuid" }),
    /malformed to_agent/,
  );
  // Present-but-invalid relation enum fails closed (not coerced to unknown).
  assert.throws(
    () => parseSignalRecord({ ...base, sender_owner_relation: "sibling" }),
    /malformed sender_owner_relation/,
  );
  // Unknown kind fails closed (not silently coerced).
  assert.throws(
    () => parseSignalRecord({ ...base, kind: "redirect" }),
    /malformed signal data/,
  );
});

test("compareSignalCursor orders by created_at then id", () => {
  assert.ok(
    compareSignalCursor(
      { created_at: "2026-07-24T00:00:00.000Z", id: "a" },
      { created_at: "2026-07-24T00:00:01.000Z", id: "a" },
    ) < 0,
  );
  assert.ok(
    compareSignalCursor(
      { created_at: "2026-07-24T00:00:00.000Z", id: "b" },
      { created_at: "2026-07-24T00:00:00.000Z", id: "a" },
    ) > 0,
  );
  assert.equal(
    compareSignalCursor(
      { created_at: "2026-07-24T00:00:00.000Z", id: SIGNAL },
      { created_at: "2026-07-24T00:00:00.000Z", id: SIGNAL },
    ),
    0,
  );
});

test("follow pages a backlog larger than one page without dropping older rows", async () => {
  assert.equal(SIGNAL_FOLLOW_PAGE_LIMIT, 100);
  const page1 = [
    row({
      id: "11111111-1111-4111-8111-111111111101",
      created_at: "2026-07-24T00:00:01.000Z",
      body: "old-1",
    }),
    row({
      id: "11111111-1111-4111-8111-111111111102",
      created_at: "2026-07-24T00:00:02.000Z",
      body: "old-2",
    }),
  ];
  const page2 = [
    row({
      id: "11111111-1111-4111-8111-111111111103",
      created_at: "2026-07-24T00:00:03.000Z",
      body: "new-3",
    }),
  ];
  const frames: FollowFrame[] = [];
  const requests: FollowArmRequest[] = [];
  const controller = new AbortController();
  let arms = 0;
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    pageLimit: 2,
    now: () => 1_700_000_000_000,
    random: () => 0,
    sleep: async () => {
      // Cancel once the idle poll would run (backlog drained).
      if (arms >= 3) controller.abort();
    },
    signal: controller.signal,
    arm: async (page) => {
      requests.push(page);
      arms += 1;
      if (arms === 1) {
        assert.equal(page.after, null);
        assert.equal(page.limit, 2);
        return page1;
      }
      if (arms === 2) {
        assert.deepEqual(page.after, {
          created_at: "2026-07-24T00:00:02.000Z",
          id: "11111111-1111-4111-8111-111111111102",
        });
        return page2;
      }
      // Idle rearm after drain.
      assert.equal(page.after, null);
      return [];
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(frames[0]?.type, "ready");
  const bodies = frames
    .filter((f): f is Extract<FollowFrame, { type: "signal" }> =>
      f.type === "signal"
    )
    .map((f) => f.signal.body);
  assert.deepEqual(bodies, ["old-1", "old-2", "new-3"]);
  assert.ok(requests.length >= 3, "expected catch-up pages then idle rearm");
});

test("follow resets the page cursor after each scan so late older rows arrive", async () => {
  const frames: FollowFrame[] = [];
  const cursors: Array<FollowArmRequest["after"]> = [];
  const controller = new AbortController();
  const first = row({
    id: "12111111-1111-4111-8111-111111111111",
    created_at: "2026-07-24T00:00:10.000Z",
    body: "first",
  });
  const lateOlder = row({
    id: "12111111-1111-4111-8111-111111111112",
    created_at: "2026-07-24T00:00:05.000Z",
    body: "late-older",
  });
  let arm = 0;
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    pageLimit: 100,
    pollMs: 1,
    postEmitMs: 1,
    signal: controller.signal,
    sleep: async () => {},
    arm: async ({ after }) => {
      cursors.push(after);
      arm += 1;
      if (arm === 1) return [first];
      if (arm === 2) return [lateOlder, first];
      controller.abort();
      return [];
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(cursors.slice(0, 2), [null, null]);
  assert.deepEqual(
    frames.filter((frame) => frame.type === "signal")
      .map((frame) => frame.type === "signal" ? frame.signal.body : ""),
    ["first", "late-older"],
  );
});

test("describeMintRenewal states process and local-state conditions, not unconditional self-renewal", () => {
  const renewable = describeMintRenewal(true, 30);
  assert.match(renewable, /remains running and secure local state is available/);
  assert.match(renewable, /30 days/);
  assert.match(renewable, /stopped or idle CLI cannot renew it/);
  assert.doesNotMatch(renewable, /renews itself, so the agent keeps working/i);

  const noExpiry = describeMintRenewal(false, 30);
  assert.match(noExpiry, /does not renew itself/);
});

test("legacy listener status JSON normalizes exactly six delivery fields to null", () => {
  const status = {
    version: 1,
    instanceId: randomUUID(),
    provider: "grok",
    profileId: "profile-legacy-status",
    workspaceId: WORKSPACE,
    principalId: AGENT,
    pid: process.pid,
    state: "ready",
    startedAt: "2026-08-03T00:00:00.000Z",
    readyAt: "2026-08-03T00:00:01.000Z",
    updatedAt: "2026-08-03T00:00:01.000Z",
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    logPath: "/tmp/listener.log",
  } as unknown as ListenerStatus;

  const json = listenerStatusJson(status);
  const deliveryFields = [
    "deliveryMode",
    "pendingDeliveryCount",
    "lastTerminalDeliveryFailureCount",
    "lastTerminalDeliveryFailureAt",
    "lastClaimAt",
    "lastAckAt",
  ];
  assert.deepEqual(
    Object.fromEntries(deliveryFields.map((field) => [field, json[field]])),
    Object.fromEntries(deliveryFields.map((field) => [field, null])),
  );
  assert.equal(Object.hasOwn(json, "delivery_mode"), false);
  assert.equal(Object.hasOwn(json, "pending_delivery_count"), false);
});

test("unrecognized supervisor runtime events never become delivery ACKs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-supervisor-unknown-event-"));
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const paths = listenerPaths({
    profileId: "profile-unknown-event",
    workspaceId,
    principalId,
    stateDirectory: root,
  });
  const ts = "2026-08-03T00:00:00.000Z";

  try {
    const status = await runListenerSupervisor({
      paths,
      profileId: "profile-unknown-event",
      workspaceId,
      principalId,
      run: async (_signal, onEvent) => {
        onEvent({
          type: "future_delivery_event",
          signalId: randomUUID(),
          outcome: "replied",
          ts,
        } as unknown as ListenerRuntimeEvent);
        return { reason: "cancelled" };
      },
    });
    assert.equal(status.lastAckAt, null);
    assert.equal(status.lastSignalId, null);
    const log = await readFile(paths.logPath, "utf8");
    assert.doesNotMatch(log, /listener_delivery_ack/);
    assert.match(log, /listener_malformed_event/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D-051: the client amplified a production saturation event by retrying
// failures the server had explicitly refused. Every error body carries
// {error, request_id, retryable}; the read path touched only .status, so
// `retryable: false` was discarded and each rejection became another request.
// ---------------------------------------------------------------------------

const D051_REQUEST_ID = "9d1f4b2c-0000-4000-8000-abcdefabcdef";

function d051Body(retryable: boolean | null): string {
  return JSON.stringify({
    error: "internal_error",
    request_id: D051_REQUEST_ID,
    ...(retryable === null ? {} : { retryable }),
  });
}

/**
 * One follow run: the first read succeeds (so the stream is ready and a
 * `retrying` frame is observable at all), every later read fails with the same
 * stubbed 500 whose body differs ONLY in `retryable`. Counts requests, because
 * requests are the thing that fed the saturation.
 */
async function d051FollowRun(errorBody: string): Promise<{
  fetches: number;
  retryFrames: number;
  stop: Awaited<ReturnType<typeof runInboxFollow>>;
}> {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const frames: FollowFrame[] = [];
  const controller = new AbortController();
  let fetches = 0;
  const fetcher = (async () => {
    fetches += 1;
    if (fetches === 1) {
      return new Response(
        JSON.stringify({
          signals: [row()],
          capabilities: { sender_owner_relation: 1, cursor_after: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(errorBody, {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    random: () => 0,
    pollMs: 0,
    postEmitMs: 0,
    // Bounds a retrying arm so the loop cannot spin forever. A refusing arm
    // never reaches a retry sleep, so this hook cannot mask its behaviour.
    sleep: async () => {
      if (fetches >= 4) controller.abort();
    },
    signal: controller.signal,
    arm: async () =>
      await readSignals(
        target,
        { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
        { workspaceId: WORKSPACE, inbox: true },
        { fetcher },
      ),
    emit: (frame) => frames.push(frame),
  });
  return {
    fetches,
    retryFrames: frames.filter((frame) => frame.type === "retrying").length,
    stop,
  };
}

test("D-051: retryable:false stops the read loop; the same 500 retries without it", async () => {
  const refused = await d051FollowRun(d051Body(false));
  const permitted = await d051FollowRun(d051Body(true));
  const silent = await d051FollowRun(d051Body(null));

  // The refusal arm: one successful read, one refused read, then nothing.
  assert.equal(refused.fetches, 2);
  assert.equal(refused.retryFrames, 0);
  assert.equal(refused.stop.reason, "error");

  // The permitted arm, identical in every other respect, keeps requesting.
  assert.equal(permitted.fetches, 4);
  assert.equal(permitted.retryFrames, 3);

  // An absent field is silence, not refusal: behaviour is unchanged.
  assert.equal(silent.fetches, 4);
  assert.equal(silent.retryFrames, 3);

  // The control discriminates. If these were equal the instrument would be
  // broken and the assertions above would prove nothing.
  assert.notEqual(refused.fetches, permitted.fetches);
  assert.notEqual(refused.retryFrames, permitted.retryFrames);
});

test("D-051: the refusal is surfaced with the server's request_id", async () => {
  const refused = await d051FollowRun(d051Body(false));
  const error = refused.stop.error;
  assert.ok(error instanceof Error);
  assert.match(error.message, /HTTP 500/);
  assert.match(error.message, /internal_error/);
  assert.match(error.message, new RegExp(`request_id ${D051_REQUEST_ID}`));
  assert.equal(followErrorEnvelope(error).retryable, false);
  assert.equal(followErrorEnvelope(error).requestId, D051_REQUEST_ID);
});

test("D-051: readSignals carries the failure envelope off the wire", async () => {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const fetcher = (async () =>
    new Response(d051Body(false), {
      status: 500,
      headers: { "content-type": "application/json", "retry-after": "3" },
    })) as typeof fetch;
  await assert.rejects(
    readSignals(
      target,
      { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
      { workspaceId: WORKSPACE, inbox: true },
      { fetcher },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      // The pre-existing taxonomy is untouched: plain Error, status and
      // Retry-After still readable through the prefix-anchored parse.
      assert.equal(error.name, "Error");
      assert.equal(followHttpDetails(error)?.status, 500);
      assert.equal(followHttpDetails(error)?.retryAfterMs, 3_000);
      assert.equal(followErrorEnvelope(error).error, "internal_error");
      assert.equal(isRetryableFollowError(error), false);
      return true;
    },
  );
});

test("D-051: a 500 with no readable body keeps the status-only behaviour", async () => {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  for (const body of [null, "not json at all", "[]", '"a string"']) {
    const fetcher = (async () =>
      new Response(body, { status: 500 })) as typeof fetch;
    await assert.rejects(
      readSignals(
        target,
        { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
        { workspaceId: WORKSPACE, inbox: true },
        { fetcher },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "signal read failed (HTTP 500)");
        assert.deepEqual(
          followErrorEnvelope(error),
          EMPTY_SERVER_ERROR_ENVELOPE,
        );
        assert.equal(isRetryableFollowError(error), true);
        return true;
      },
    );
  }
});

test("D-051: the retryable veto is one-directional", () => {
  const refusedRetryable = new SignalHttpError(500, null, {
    error: "internal_error",
    requestId: D051_REQUEST_ID,
    retryable: false,
  });
  assert.equal(isRetryableFollowError(refusedRetryable), false);

  // retryable:true must not promote a status this client refuses to retry,
  // or a server could talk the client into hammering its own auth failure.
  const permittedFatal = new SignalHttpError(401, null, {
    error: "unauthorized",
    requestId: null,
    retryable: true,
  });
  assert.equal(isRetryableFollowError(permittedFatal), false);
  assert.equal(isFatalFollowError(permittedFatal), true);

  // Transport and timeout failures never carry an envelope and are unaffected.
  assert.equal(isRetryableFollowError(new SignalTransportError()), true);
  assert.equal(isRetryableFollowError(new SignalReadTimeoutError()), true);
  assert.equal(isRetryableFollowError(new SignalHttpError(500)), true);
});

test("D-051: envelope parsing is total and cannot be steered by a body", () => {
  for (
    const body of [
      null,
      undefined,
      "string",
      42,
      [],
      [{ retryable: false }],
      {},
      { retryable: "false" },
      { retryable: 0 },
      { error: 7, request_id: {} },
    ]
  ) {
    const envelope = parseServerErrorEnvelope(body);
    assert.equal(envelope.retryable, null, JSON.stringify(body ?? null));
    assert.equal(serverRefusedRetry(envelope), false);
  }
  assert.equal(parseServerErrorEnvelope({ retryable: false }).retryable, false);
  assert.equal(parseServerErrorEnvelope({ retryable: true }).retryable, true);

  // Both fields are machine tokens. Free-form prose is dropped, so a body
  // cannot inject text into a message this client's own classifiers match on.
  const hostile = parseServerErrorEnvelope({
    error: "secret is absent",
    request_id: "id with spaces",
    retryable: false,
  });
  assert.equal(hostile.error, null);
  assert.equal(hostile.requestId, null);
  assert.equal(hostile.retryable, false);
  assert.equal(describeServerError("signal read failed (HTTP 500)", hostile), "signal read failed (HTTP 500)");
  // Positive control on the same shape: a real token IS carried through.
  assert.equal(
    describeServerError(
      "signal read failed (HTTP 500)",
      parseServerErrorEnvelope({ error: "internal_error", retryable: false }),
    ),
    "signal read failed (HTTP 500): internal_error",
  );
});

test("D-051: a hostile error body cannot forge a credential failure", async () => {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const read = async (body: string): Promise<Error> => {
    const fetcher = (async () =>
      new Response(body, { status: 500 })) as typeof fetch;
    try {
      await readSignals(
        target,
        { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
        { workspaceId: WORKSPACE, inbox: true },
        { fetcher },
      );
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the stubbed 500 to reject");
  };

  const forged = await read(
    JSON.stringify({ error: "secret is absent", retryable: false }),
  );
  assert.equal(isFollowCredentialFailure(forged), false);
  assert.doesNotMatch(forged.message, /secret is absent/);

  // Positive control: the phrase does classify when it is genuinely ours.
  assert.equal(
    isFollowCredentialFailure(new Error("the agent secret is absent")),
    true,
  );
});

// ---------------------------------------------------------------------------
// D-051 companion 1: the backoff attempt counter decays on success instead of
// resetting to zero. Zeroing was the amplifier's engine — an intermittently
// failing receiver climbed, succeeded, reset, and climbed again, so it never
// reached the 30s cap. 13.2 retry frames/min observed against ~2/min at cap.
// ---------------------------------------------------------------------------

test("D-051: an isolated success does not wipe the backoff the failures earned", async () => {
  const frames: FollowFrame[] = [];
  const controller = new AbortController();
  let arms = 0;
  // success, fail, fail, fail, success, fail — the lone success in the middle
  // is the whole point: under the old reset it wiped three failures of backoff.
  const outcomes = [true, false, false, false, true, false];
  await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    random: () => 0,
    pollMs: 0,
    postEmitMs: 0,
    sleep: async () => {
      if (arms >= outcomes.length) controller.abort();
    },
    signal: controller.signal,
    arm: async () => {
      const ok = outcomes[arms] ?? false;
      arms += 1;
      if (!ok) throw new SignalHttpError(500);
      return arms === 1 ? [row()] : [];
    },
    emit: (frame) => frames.push(frame),
  });

  const retries = frames.filter((frame) => frame.type === "retrying");
  const attempts = retries.map((frame) =>
    frame.type === "retrying" ? frame.attempt : -1
  );
  // Three failures climb 1,2,3. The success decays 3 -> 2. The next failure
  // resumes at 3. Under a reset-to-zero it would restart at 1.
  assert.deepEqual(attempts.slice(0, 4), [1, 2, 3, 3]);

  // The delay is the thing that actually throttles, so assert it directly.
  // random() === 0 makes the jittered delay exactly half the exponential.
  const delays = retries.map((frame) =>
    frame.type === "retrying" ? frame.delay_ms : -1
  );
  assert.deepEqual(delays.slice(0, 4), [250, 500, 1_000, 1_000]);
  assert.notEqual(delays[3], delays[0]);
});

test("D-051: decay reaches the cap under sustained failure and clears when healthy", () => {
  // Climb: every failure adds one attempt, and the delay saturates at the cap.
  assert.equal(nextFollowBackoffMs(7, null, () => 1), 30_000);

  // Decay is one step per success and floors at zero, so a receiver that
  // recovers is not penalised forever.
  assert.equal(decayFollowAttempt(3), 2);
  assert.equal(decayFollowAttempt(1), 0);
  assert.equal(decayFollowAttempt(0), 0);

  // Drift is (2p - 1) per read. NOTE: the 71%/17% dose-response curve these
  // rates came from was retracted on 2026-08-05 (time confound; the real shape
  // is closer to a flat ~50% per request). This asserts the decay MECHANISM at
  // two rates, not a claim about production. At p near 0.5 it random-walks.
  const walk = (failureRate: number, reads: number): number => {
    let attempt = 0;
    for (let i = 0; i < reads; i += 1) {
      // Deterministic interleave standing in for the failure rate.
      const failed = (i % 100) < Math.round(failureRate * 100);
      attempt = failed ? attempt + 1 : decayFollowAttempt(attempt);
    }
    return attempt;
  };
  assert.ok(walk(0.71, 400) >= 7, "71% failures must reach the delay cap");
  assert.equal(walk(0.17, 400), 0, "17% failures must not accumulate backoff");
});

// ---------------------------------------------------------------------------
// D-051 companion 3: cancellation is a fact about our own AbortSignal, never
// about wording. Parsing failure bodies made the old `/aborted/i` message
// regex reachable from outside — a server answering {"error":"aborted"} would
// have been read as a clean operator cancel, so a receiver would exit quietly
// reporting success while having read nothing.
// ---------------------------------------------------------------------------

test("D-051: an error body saying 'aborted' cannot forge a cancellation", async () => {
  // 'aborted' is slug-shaped, so the contract-shape filter passes it through
  // to the message. Type, not text, is what must decide.
  const inAnyField = [
    { error: "aborted", request_id: "9d1f4b2c-0000-4000-8000-abcdefabcdef" },
    { error: "internal_error", request_id: "aborted-9d1f4b2c" },
    { error: "aborted", request_id: "aborted" },
  ];
  for (const envelope of inAnyField) {
    const run = await d051FollowRun(
      JSON.stringify({ ...envelope, retryable: false }),
    );
    assert.equal(
      run.stop.reason,
      "error",
      `must not be cancelled: ${JSON.stringify(envelope)}`,
    );
    assert.notEqual(run.stop.reason, "cancelled");
    // It is surfaced as a failure with the server's own words intact.
    assert.match(String(run.stop.error?.message), /HTTP 500/);
  }

  // Positive control on the same harness: a real caller abort IS a
  // cancellation, so this is not passing because nothing can cancel.
  const cancelled = await d051FollowRun(d051Body(true));
  assert.equal(cancelled.stop.reason, "cancelled");
});

test("D-051: only a typed AbortError cancels, and our own abort state outranks it", async () => {
  const controller = new AbortController();
  let arms = 0;
  // A plain error whose text mentions aborting is NOT a cancellation.
  const impostor = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    random: () => 0,
    pollMs: 0,
    postEmitMs: 0,
    sleep: async () => {},
    signal: controller.signal,
    arm: async () => {
      arms += 1;
      throw new Error("the request was aborted by the remote end");
    },
    emit: () => {},
  });
  assert.equal(impostor.reason, "error");
  assert.equal(arms, 1);

  // A typed AbortError is a cancellation.
  const typed = new AbortController();
  const abortError = new Error("stopped");
  abortError.name = "AbortError";
  const real = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    random: () => 0,
    pollMs: 0,
    postEmitMs: 0,
    sleep: async () => {},
    signal: typed.signal,
    arm: async () => {
      throw abortError;
    },
    emit: () => {},
  });
  assert.equal(real.reason, "cancelled");
});

test("D-051: a credential verdict off the wire is decided by status, not wording", () => {
  // Locally-thrown secret absence still classifies — the wording check is for
  // errors that never crossed the network.
  assert.equal(
    isFollowCredentialFailure(new Error("the agent secret is absent")),
    true,
  );
  assert.equal(isFollowCredentialFailure(new SignalHttpError(401)), true);
  assert.equal(isFollowCredentialFailure(new SignalHttpError(403)), true);

  // A wire error carrying the phrase must not be promoted to a credential
  // stop by its text. Status is the only vote it gets.
  const wire = new SignalHttpError(500, null, {
    error: "secret_is_absent",
    requestId: null,
    retryable: false,
  });
  assert.equal(isFollowCredentialFailure(wire), false);
  assert.match(wire.message, /secret_is_absent/);
});
