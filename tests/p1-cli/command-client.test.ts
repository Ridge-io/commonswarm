import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Command, EventEnvelope, EventType } from "../../src/protocol/index.js";
import {
  assertAgentToken,
  newCommandId,
  ThinCommandClient,
} from "../../src/cloud/command-client.js";
import { cloudTarget } from "../../src/cloud/config.js";

function envelope(
  type: EventType,
  seq: number,
  commandId: string,
  workspaceId: string,
  streamId: string,
  payload: Record<string, unknown>,
): EventEnvelope {
  return {
    workspace_id: workspaceId,
    stream_id: streamId,
    seq,
    event_id: randomUUID(),
    command_id: commandId,
    type,
    schema_version: 1,
    actor_user: randomUUID(),
    actor_agent_principal: null,
    actor_run: null,
    occurred_at_server: Date.now(),
    payload,
  };
}

test("command ids are CSPRNG-shaped and unique", () => {
  const ids = new Set(Array.from({ length: 100 }, () => newCommandId()));
  assert.equal(ids.size, 100);
  assert.ok([...ids].every((id) => /^[A-Za-z0-9_-]{8,72}$/.test(id)));
});

test("agent token wire format is strict", () => {
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  assert.doesNotThrow(() => assertAgentToken(token));
  assert.throws(() => assertAgentToken("swm_agt_too-short"), /32 base64url/);
});

test("thin client sends the frozen wire contract and folds a dogfood sequence", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", "anon-key");
  const workspaceId = randomUUID();
  const streamId = randomUUID();
  const taskId = randomUUID();
  const owner = randomUUID();
  const credential = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const requests: Array<Record<string, unknown>> = [];
  const commands: Command[] = [
    { kind: "create", task_id: taskId, slug: "cli-dogfood" },
    { kind: "acquire", task_id: taskId, ttl_ms: 60_000 },
    {
      kind: "submit",
      task_id: taskId,
      epoch: 1,
      branch: "agent/cli",
      head_sha: "a".repeat(40),
      evidence_set: ["test:green"],
    },
    {
      kind: "close",
      task_id: taskId,
      epoch: 1,
      disposition: "archive",
      grant_id: null,
    },
  ];
  const eventTypes: EventType[] = [
    "TaskCreated",
    "LeaseAcquired",
    "TaskSubmitted",
    "TaskClosed",
  ];
  const payloads = [
    { task_id: taskId, slug: "cli-dogfood" },
    {
      task_id: taskId,
      epoch: 1,
      owner,
      lease_expiry: Date.now() + 60_000,
    },
    {
      task_id: taskId,
      epoch: 1,
      branch: "agent/cli",
      head_sha: "a".repeat(40),
      evidence_set: ["test:green"],
    },
    {
      task_id: taskId,
      epoch: 1,
      disposition: "archive",
      grant_id: null,
    },
  ];
  let call = 0;
  const fetcher = async (_url: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      `Bearer ${credential}`,
    );
    assert.equal((init?.headers as Record<string, string>).apikey, "anon-key");
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(request);
    const commandId = String(request.command_id);
    const event = envelope(
      eventTypes[call]!,
      call + 1,
      commandId,
      workspaceId,
      streamId,
      payloads[call]!,
    );
    call += 1;
    return new Response(JSON.stringify({
      status: "accepted",
      ok: true,
      event_ids: [event.event_id],
      events: [event],
      min_client_version: "0.1.0",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new ThinCommandClient(target, fetcher as typeof fetch);
  for (const command of commands) {
    const result = await client.send({
      workspaceId,
      stream: { kind: "workspace" },
      command,
      credential,
    });
    assert.equal(result.response.status, "accepted");
  }
  assert.equal(client.projection(taskId)?.lifecycle, "done");
  assert.equal(client.projection(taskId)?.epoch, 1);
  assert.equal(requests.length, 4);
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]!;
    assert.equal(request.client_version, "0.1.0");
    assert.equal(request.workspace_id, workspaceId);
    assert.deepEqual(request.stream, { kind: "workspace" });
    assert.deepEqual(request.command, commands[index]);
    assert.match(String(request.command_id), /^[A-Za-z0-9_-]{8,72}$/);
  }
  assert.equal(
    new Set(requests.map((request) => request.command_id)).size,
    requests.length,
  );
});

test("client refuses to fold a response requiring a newer version", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", "anon-key");
  const client = new ThinCommandClient(
    target,
    (async () =>
      new Response(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        events: [],
        min_client_version: "9.0.0",
      }), { status: 200 })) as typeof fetch,
  );
  await assert.rejects(
    client.send({
      workspaceId: randomUUID(),
      stream: { kind: "workspace" },
      command: { kind: "create", task_id: randomUUID(), slug: "upgrade" },
      credential: "human-jwt",
    }),
    /client upgrade required/,
  );
});
