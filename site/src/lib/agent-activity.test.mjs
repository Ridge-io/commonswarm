import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_ACTIVITY_ELAPSED_MAX_MS,
  agentActivityFrameIsNewer,
  agentActivityPanelView,
  parseAgentActivityFrame,
} from "./agent-activity.ts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const STREAM_ID = "33333333-3333-4333-8333-333333333333";
const SIGNAL_ID = "44444444-4444-4444-8444-444444444444";
const EMITTED_AT = "2026-09-01T12:00:00.000Z";
const EMITTED_MS = Date.parse(EMITTED_AT);

const frame = {
  version: 1,
  workspaceId: WORKSPACE_ID,
  principalId: PRINCIPAL_ID,
  streamId: STREAM_ID,
  sequence: 1,
  phase: "tool-running",
  signalId: SIGNAL_ID,
  toolTitle: "Read workspace files",
  elapsedMs: 4_200,
  emittedAt: EMITTED_AT,
};

test("fresh activity projects the phase, tool, signal, age, and elapsed time", () => {
  const parsed = parseAgentActivityFrame(frame, WORKSPACE_ID);
  assert.ok(parsed, "valid frame is the parser positive control");
  assert.deepEqual(agentActivityPanelView(parsed, "subscribed", EMITTED_MS + 2_000), {
    state: "fresh",
    ageLabel: "Live now",
    phaseLabel: "Tool running",
    signalLabel: SIGNAL_ID,
    toolTitle: "Read workspace files",
    elapsedLabel: "6s",
    emptyMessage: null,
  });
});

test("a frame older than 30 seconds is stale and stops growing elapsed time", () => {
  const parsed = parseAgentActivityFrame(frame, WORKSPACE_ID);
  assert.ok(parsed);
  const view = agentActivityPanelView(
    parsed,
    "subscribed",
    EMITTED_MS + 8 * 24 * 60 * 60 * 1_000,
  );
  assert.equal(view.state, "stale");
  assert.equal(view.ageLabel, "stale");
  assert.equal(view.elapsedLabel, "stale");
});

test("missing frames state only what the dashboard measured", () => {
  for (const listenerPresence of ["present", "unknown"]) {
    const view = agentActivityPanelView(
      undefined,
      "subscribed",
      EMITTED_MS,
      listenerPresence,
    );
    assert.equal(view.state, "no-frames");
    assert.equal(view.ageLabel, "No frames received");
    assert.equal(view.emptyMessage, "No activity frames received");
    assert.doesNotMatch(JSON.stringify(view), /Not instrumented/i);
  }
});

test("not-instrumented copy requires the roster to prove there is no listener", () => {
  const view = agentActivityPanelView(
    undefined,
    "subscribed",
    EMITTED_MS,
    "absent",
  );
  assert.equal(view.state, "not-instrumented");
  assert.equal(view.ageLabel, "Not instrumented");
  assert.equal(view.emptyMessage, "Not instrumented — this agent has no listener");
});

test("frame parsing rejects another workspace and any expanded free-text shape", () => {
  assert.ok(parseAgentActivityFrame(frame, WORKSPACE_ID));
  assert.equal(
    parseAgentActivityFrame(
      frame,
      "55555555-5555-4555-8555-555555555555",
    ),
    null,
  );
  for (const forbidden of ["messageBody", "stderrTail", "terminalBytes", "rawInput"]) {
    assert.equal(
      parseAgentActivityFrame({ ...frame, [forbidden]: "private" }, WORKSPACE_ID),
      null,
    );
  }
  assert.equal(
    parseAgentActivityFrame(
      { ...frame, elapsedMs: AGENT_ACTIVITY_ELAPSED_MAX_MS + 1 },
      WORKSPACE_ID,
    ),
    null,
  );
});

test("sequence ordering rejects replay but permits a listener restart at the same instant", () => {
  assert.equal(agentActivityFrameIsNewer(frame, { ...frame, sequence: 1 }), false);
  assert.equal(agentActivityFrameIsNewer(frame, { ...frame, sequence: 2 }), true);
  assert.equal(
    agentActivityFrameIsNewer(frame, {
      ...frame,
      streamId: "66666666-6666-4666-8666-666666666666",
      sequence: 1,
    }),
    true,
  );
});
