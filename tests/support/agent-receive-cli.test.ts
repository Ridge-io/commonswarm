/**
 * Pure client contract for agent-receive MVP: typed recipient resolution,
 * wait deadlines, JSON shapes, and timeout/error separation.
 *
 * ★ THIS FILE IS NAMED IN `npm test` — a hand-run or typecheck-only pass is not a gate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  askWaitJsonPayload,
  nextWaitSleepMs,
  parseWaitSeconds,
  pollForSignals,
  postSignalTargets,
  readSignals,
  resolveSignalRecipient,
  SIGNAL_READ_TIMEOUT_MS,
  SignalReadTimeoutError,
  signalReadJsonPayload,
  waitDeadlineMs,
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
