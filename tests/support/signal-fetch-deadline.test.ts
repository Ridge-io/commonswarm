/**
 * D-034 — signal status could wait forever because its fetches had no deadline.
 *
 * Pure: no Supabase, no network, no database. The fake fetch never settles on its own,
 * which distinguishes an application deadline from a fast provider failure.
 *
 * ★ THIS FILE IS NAMED IN `npm test`, AND THAT IS LOAD-BEARING.
 *
 * `test:p1-cli` also covers signal behavior, but that suite owns a shared database stack.
 * This deadline observer must stay runnable by every contributor without coordination.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudTarget } from "../../src/cloud/config.js";
import {
  readAgentSignalMembers,
  readSignals,
  settleSignalStatus,
  SIGNAL_STATUS_UNAVAILABLE_MESSAGE,
} from "../../src/cloud/signals.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const TARGET: CloudTarget = {
  url: "https://example.supabase.co",
  anonKey: "test-anon-key",
  profileId: "test-profile",
};

function hangingFetch(observed: AbortSignal[]): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(
      signal instanceof AbortSignal,
      "every production signal read must propagate an AbortSignal",
    );
    observed.push(signal);
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("signal read timed out");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  }) as typeof fetch;
}

test("D-034: every signal fetch aborts at the 30 second application deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: AbortSignal[] = [];
  const fetcher = hangingFetch(observed);

  const human = readSignals(TARGET, {
    kind: "human",
    accessToken: "human-access-token",
    userId: USER_ID,
  }, {
    workspaceId: WORKSPACE_ID,
    inbox: false,
  }, fetcher);
  const agent = readSignals(TARGET, {
    kind: "agent",
    token: "agent-token",
  }, {
    workspaceId: WORKSPACE_ID,
    inbox: true,
  }, fetcher);
  const members = readAgentSignalMembers(
    TARGET,
    "agent-token",
    WORKSPACE_ID,
    fetcher,
  );

  const humanFailure = assert.rejects(
    human,
    { message: "signal read could not reach the cloud service" },
  );
  const agentFailure = assert.rejects(
    agent,
    { message: "signal read could not reach the cloud service" },
  );
  const memberFailure = assert.rejects(
    members,
    { message: "member read could not reach the cloud service" },
  );

  assert.equal(observed.length, 3, "all three production fetch sites were reached");
  t.mock.timers.tick(29_999);
  assert.deepEqual(
    observed.map((signal) => signal.aborted),
    [false, false, false],
    "the deadline must not fire early",
  );
  t.mock.timers.tick(1);
  await Promise.all([humanFailure, agentFailure, memberFailure]);
  assert.deepEqual(
    observed.map((signal) => signal.aborted),
    [true, true, true],
    "the deadline must abort every production fetch site",
  );
});

test("D-034: the signal status fallback settles when providers never answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: AbortSignal[] = [];
  const fetcher = hangingFetch(observed);
  const recent = readSignals(TARGET, {
    kind: "agent",
    token: "agent-token",
  }, {
    workspaceId: WORKSPACE_ID,
    inbox: false,
  }, fetcher);
  const asks = readSignals(TARGET, {
    kind: "agent",
    token: "agent-token",
  }, {
    workspaceId: WORKSPACE_ID,
    inbox: true,
    kind: "ask",
  }, fetcher);

  const status = settleSignalStatus(recent, asks);
  assert.equal(observed.length, 2, "both status reads were started");
  t.mock.timers.tick(30_000);
  assert.deepEqual(await status, {
    recentSignals: null,
    waitingAsks: null,
    warning: SIGNAL_STATUS_UNAVAILABLE_MESSAGE,
  });
});
