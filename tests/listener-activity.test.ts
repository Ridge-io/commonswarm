import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVITY_FRAME_INTERVAL_MS,
  ACTIVITY_HEARTBEAT_MS,
  AgentActivityPublishError,
  AgentActivityEndpointTransport,
  ListenerActivityController,
  type AgentActivityFrameRequest,
  type AgentActivityTransport,
} from "../src/listener/activity.js";
import { parseActivityRequest } from "../supabase/functions/activity/core.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SIGNAL_ID = "22222222-2222-4222-8222-222222222222";
const STREAM_ID = "33333333-3333-4333-8333-333333333333";

class FakeClock {
  value = 0;
  private nextTimer = 1;
  private readonly timers = new Map<
    number,
    { callback: () => void; due: number }
  >();

  now = (): number => this.value;

  setTimer = (
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> => {
    const id = this.nextTimer++;
    this.timers.set(id, { callback, due: this.value + delayMs });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimer = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(timer as unknown as number);
  };

  async advance(milliseconds: number): Promise<void> {
    const target = this.value + milliseconds;
    while (true) {
      const ready = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!ready) break;
      this.value = ready[1].due;
      this.timers.delete(ready[0]);
      ready[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.value = target;
    await Promise.resolve();
    await Promise.resolve();
  }
}

class RecordingTransport implements AgentActivityTransport {
  readonly sent: Array<{ at: number; frame: AgentActivityFrameRequest }> = [];

  constructor(private readonly clock: FakeClock) {}

  async publish(frame: AgentActivityFrameRequest): Promise<void> {
    this.sent.push({ at: this.clock.now(), frame: structuredClone(frame) });
  }
}

class FailingTransport implements AgentActivityTransport {
  async publish(): Promise<void> {
    throw new Error("raw transport failure");
  }
}

test("listener frames stay below two per second and redact laced agent tokens", async () => {
  assert.equal(
    ACTIVITY_FRAME_INTERVAL_MS,
    750,
    "the measured 2/s ceiling needs the selected 750ms margin",
  );
  const clock = new FakeClock();
  const transport = new RecordingTransport(clock);
  const activity = new ListenerActivityController({
    workspaceId: WORKSPACE_ID,
    streamId: STREAM_ID,
    transport,
    clock,
  });

  activity.onRuntimeEvent({
    type: "ready",
    workspaceId: WORKSPACE_ID,
    principalId: SIGNAL_ID,
    ts: new Date(0).toISOString(),
  });
  await clock.advance(0);
  assert.equal(transport.sent.length, 1, "ready must be the positive-control frame");

  activity.onRuntimeEvent({
    type: "delivery_claim",
    signalId: SIGNAL_ID,
    pendingDeliveryCount: 1,
    terminalDeliveryFailureCount: 0,
    ts: new Date(0).toISOString(),
  });
  const credential = `swm_\u200bagt_${"a".repeat(43)}`;
  activity.events.update?.({
    kind: "tool_call",
    sessionId: "session",
    toolCallId: "tool-1",
    title: `Open ${credential} records`,
    status: "running",
  });
  await clock.advance(ACTIVITY_FRAME_INTERVAL_MS - 1);
  assert.equal(transport.sent.length, 1, "coalesced changes must wait for the interval");
  await clock.advance(1);
  assert.equal(transport.sent.length, 2);

  activity.events.update?.({
    kind: "tool_call_update",
    sessionId: "session",
    toolCallId: "tool-1",
    title: "Open the next record",
    status: "running",
  });
  activity.events.update?.({
    kind: "tool_call_update",
    sessionId: "session",
    toolCallId: "tool-1",
    title: "Open the final record",
    status: "running",
  });
  await clock.advance(ACTIVITY_FRAME_INTERVAL_MS);
  assert.equal(transport.sent.length, 3, "rapid updates must collapse into one frame");

  for (let index = 1; index < transport.sent.length; index += 1) {
    assert.ok(
      transport.sent[index]!.at - transport.sent[index - 1]!.at >=
        ACTIVITY_FRAME_INTERVAL_MS,
    );
  }
  const redacted = transport.sent[1]!.frame;
  assert.equal(redacted.phase, "tool-running");
  assert.equal(redacted.toolTitle, "Open [redacted-credential] records");
  assert.doesNotMatch(JSON.stringify(transport.sent), /swm_.*agt_/);
  assert.deepEqual(Object.keys(redacted).sort(), [
    "elapsedMs",
    "phase",
    "sequence",
    "signalId",
    "streamId",
    "toolTitle",
    "version",
    "workspaceId",
  ]);

  await clock.advance(ACTIVITY_HEARTBEAT_MS - 1);
  assert.equal(transport.sent.length, 3, "heartbeat must not fire early");
  await clock.advance(1);
  assert.equal(transport.sent.length, 4, "heartbeat keeps a live listener fresh");
  assert.equal(transport.sent[3]!.frame.phase, "tool-running");
  assert.ok(transport.sent[3]!.frame.elapsedMs > redacted.elapsedMs);
  activity.close();
});

test("activity publish failures reach the local observer as stable codes", async () => {
  const clock = new FakeClock();
  const failureCodes: string[] = [];
  const activity = new ListenerActivityController({
    workspaceId: WORKSPACE_ID,
    streamId: STREAM_ID,
    transport: new FailingTransport(),
    clock,
    onPublishFailure: (code: string) => failureCodes.push(code),
  });

  activity.onRuntimeEvent({
    type: "ready",
    workspaceId: WORKSPACE_ID,
    principalId: SIGNAL_ID,
    ts: new Date(0).toISOString(),
  });
  await clock.advance(0);
  assert.deepEqual(failureCodes, ["activity_publish_unknown"]);
  activity.close();
});

test("activity transport keeps the credential in the header and sends the closed frame", async () => {
  const token = `swm_agt_${"b".repeat(43)}`;
  let request: Request | undefined;
  const transport = new AgentActivityEndpointTransport(
    {
      url: "https://example.invalid",
      anonKey: "anon-key",
      profileId: "test-profile",
    },
    { bearer: async () => token },
    async (input, init) => {
      request = new Request(input, init);
      return new Response(null, { status: 202 });
    },
  );
  await transport.publish({
    version: 1,
    workspaceId: WORKSPACE_ID,
    streamId: STREAM_ID,
    sequence: 1,
    phase: "tool-running",
    signalId: SIGNAL_ID,
    toolTitle: "Read file",
    elapsedMs: 50,
  });

  assert.ok(request);
  assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
  const body = await request.text();
  assert.doesNotMatch(body, /swm_agt_/);
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), [
    "elapsed_ms",
    "phase",
    "sequence",
    "signal_id",
    "stream_id",
    "tool_title",
    "version",
    "workspace_id",
  ]);
});

test("activity transport classifies every boundary failure without message matching", async () => {
  const frame: AgentActivityFrameRequest = {
    version: 1,
    workspaceId: WORKSPACE_ID,
    streamId: STREAM_ID,
    sequence: 1,
    phase: "idle",
    signalId: null,
    toolTitle: null,
    elapsedMs: 0,
  };
  const rejectedWith = (code: AgentActivityPublishError["code"]) =>
    (error: unknown): boolean =>
      error instanceof AgentActivityPublishError && error.code === code;

  await assert.rejects(
    new AgentActivityEndpointTransport(
      { url: "https://example.invalid", anonKey: "anon", profileId: "test" },
      { bearer: async () => { throw new Error("credential prose may change"); } },
      async () => { throw new Error("fetch must not run"); },
    ).publish(frame),
    rejectedWith("activity_credential_failed"),
  );
  await assert.rejects(
    new AgentActivityEndpointTransport(
      { url: "https://example.invalid", anonKey: "anon", profileId: "test" },
      { bearer: async () => "token" },
      async () => { throw new TypeError("network prose may change"); },
    ).publish(frame),
    rejectedWith("activity_transport_failed"),
  );
  await assert.rejects(
    new AgentActivityEndpointTransport(
      { url: "https://example.invalid", anonKey: "anon", profileId: "test" },
      { bearer: async () => "token" },
      async () => new Response(null, { status: 503 }),
    ).publish(frame),
    rejectedWith("activity_http_rejected"),
  );
});

test("activity parser rejects fields that could carry terminal or message data", () => {
  const valid = {
    version: 1,
    workspace_id: WORKSPACE_ID,
    stream_id: STREAM_ID,
    sequence: 1,
    phase: "tool-running",
    signal_id: SIGNAL_ID,
    tool_title: "Read file",
    elapsed_ms: 50,
  };
  assert.ok(parseActivityRequest(valid), "valid frame is the positive control");
  for (const forbidden of ["message_body", "stderr_tail", "terminal_bytes", "raw_input"]) {
    assert.equal(parseActivityRequest({ ...valid, [forbidden]: "private" }), null);
  }
});
