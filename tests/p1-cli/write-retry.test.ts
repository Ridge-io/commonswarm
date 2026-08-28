/**
 * Signal-write retry controls. This file is reached by the `test:p1-cli` glob;
 * it is deliberately not claimed by the literal `npm test` list.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CommandHttpError,
  CommandTransportError,
  SIGNAL_WRITE_MAX_ATTEMPTS,
  ThinCommandClient,
  type PostSignalRequest,
} from "../../src/cloud/command-client.js";
import type { CloudTarget } from "../../src/cloud/config.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIGNAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET: CloudTarget = {
  url: "https://cloud.example.test",
  anonKey: "anon-key",
  profileId: "test-profile",
};

function request(signal?: AbortSignal): PostSignalRequest {
  return {
    workspaceId: WORKSPACE,
    credential: "agent-credential",
    commandId: "cmd_write_retry_control",
    command: {
      kind: "post_signal",
      signal_kind: "note",
      body: "one durable signal",
      to_user_id: null,
      to_agent_principal_id: null,
      in_reply_to: null,
      about: null,
    },
    ...(signal === undefined ? {} : { signal }),
  };
}

function accepted(): Response {
  return new Response(JSON.stringify({
    status: "accepted",
    ok: true,
    event_ids: [],
    signal: {
      id: SIGNAL,
      workspace_id: WORKSPACE,
      from: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      from_kind: "agent",
      to: null,
      to_agent: null,
      in_reply_to: null,
      about: null,
      kind: "note",
      body: "one durable signal",
      until: "2026-09-01T00:00:00.000Z",
      created_at: "2026-08-27T00:00:00.000Z",
    },
  }), { status: 200 });
}

function failed(status: number): Response {
  return new Response(JSON.stringify({ error: "controlled_failure" }), { status });
}

test("a 500 replay posts one signal with the same command id and reports the retry", async () => {
  const commandIds: string[] = [];
  const ledger = new Set<string>();
  let calls = 0;
  const client = new ThinCommandClient(TARGET, (async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const commandId = String(body.command_id);
    commandIds.push(commandId);
    ledger.add(commandId);
    return calls === 1 ? failed(500) : accepted();
  }) as typeof fetch, { signalRetryBaseMs: 0, signalRetryRandom: () => 0.5 });

  const result = await client.sendSignal(request());

  assert.equal(calls, 2, "CONTROL: removing retry must leave this at one and reject");
  assert.deepEqual(commandIds, ["cmd_write_retry_control", "cmd_write_retry_control"]);
  assert.equal(ledger.size, 1, "same-id replay must represent one posted signal");
  assert.equal(result.retried, true);
  assert.equal(result.attempts, 2);
});

test("400, 403, and 409 decisions are never retried", async (t) => {
  for (const status of [400, 403, 409]) {
    await t.test(String(status), async () => {
      let calls = 0;
      const client = new ThinCommandClient(TARGET, (async () => {
        calls += 1;
        return failed(status);
      }) as typeof fetch, { signalRetryBaseMs: 0 });
      await assert.rejects(
        client.sendSignal(request()),
        (error: unknown) =>
          error instanceof CommandHttpError && error.status === status,
      );
      assert.equal(calls, 1);
    });
  }
});

test("a network failure is transient and replays the same write", async () => {
  const commandIds: string[] = [];
  const client = new ThinCommandClient(TARGET, (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    commandIds.push(String(body.command_id));
    if (commandIds.length === 1) throw new Error("connection reset");
    return accepted();
  }) as typeof fetch, { signalRetryBaseMs: 0 });

  const result = await client.sendSignal(request());
  assert.equal(result.attempts, 2);
  assert.deepEqual(commandIds, ["cmd_write_retry_control", "cmd_write_retry_control"]);
});

test("persistent 500s stop after three total attempts and keep the final typed error", async () => {
  let calls = 0;
  const client = new ThinCommandClient(TARGET, (async () => {
    calls += 1;
    return failed(500);
  }) as typeof fetch, { signalRetryBaseMs: 0 });

  await assert.rejects(
    client.sendSignal(request()),
    (error: unknown) => error instanceof CommandHttpError && error.status === 500,
  );
  assert.equal(calls, SIGNAL_WRITE_MAX_ATTEMPTS);
});

test("caller abort during backoff settles immediately and prevents another attempt", async () => {
  let calls = 0;
  const caller = new AbortController();
  const client = new ThinCommandClient(TARGET, (async () => {
    calls += 1;
    return failed(500);
  }) as typeof fetch, { signalRetryBaseMs: 10_000, signalRetryRandom: () => 0.5 });
  const pending = client.sendSignal(request(caller.signal));
  while (calls === 0) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const started = Date.now();
  caller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(Date.now() - started < 250, "abort waited for the backoff timer");
  assert.equal(calls, 1, "no write may start after the caller signal fires");
});

test("retry backoff shares the overall deadline instead of opening a new window", async () => {
  let calls = 0;
  const client = new ThinCommandClient(TARGET, (async () => {
    calls += 1;
    return failed(500);
  }) as typeof fetch, {
    signalRetryBaseMs: 30,
    signalRetryRandom: () => 0.5,
    signalRequestTimeoutMs: 40,
  });
  const started = Date.now();

  await assert.rejects(client.sendSignal(request()), {
    name: "CommandTransportError",
    message: "signal request timed out",
  });
  const elapsed = Date.now() - started;
  assert.equal(calls, 2, "the deadline must prevent a third attempt");
  assert.ok(elapsed < 200, `overall 40ms deadline took ${elapsed}ms`);
});
