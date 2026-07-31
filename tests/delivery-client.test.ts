/**
 * Pure client contract for durable direct-signal delivery: the strict
 * claim_agent_inbox / ack_agent_delivery transport and parsing layer, plus the
 * read-edge delivery capability markers and pending count.
 *
 * ★ THIS FILE IS NAMED IN `npm test` — a hand-run or typecheck-only pass is not a gate.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { SignalRecord } from "../src/cloud/command-client.js";
import {
  CLIENT_PROTOCOL_VERSION,
  cloudTarget,
  commandEndpoint,
} from "../src/cloud/config.js";
import {
  DeliveryCommandClient,
  DELIVERY_CLAIM_MAX_LIMIT,
  DELIVERY_FAILED_TERMINAL_CODES,
  DeliveryHttpError,
  DeliveryProtocolError,
  DELIVERY_SERVER_ERROR_CODES,
  DELIVERY_UNKNOWN_ERROR_CODE,
  type DeliveryAckRequest,
  type DeliveryClaimRequest,
} from "../src/cloud/delivery.js";
import { readAgentSignalPage } from "../src/cloud/signals.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SIGNAL = "33333333-3333-4333-8333-333333333333";
const SIGNAL_2 = "44444444-4444-4444-8444-444444444444";
const LEASE = "55555555-5555-4555-8555-555555555555";
const LEASE_2 = "66666666-6666-4666-8666-666666666666";
const LISTENER = "77777777-7777-4777-8777-777777777777";
const TOKEN = "swm_agt_" + "A".repeat(43);
const COMMAND_ID = "cmd_claim_test_0001";
const FUTURE = "2030-01-02T03:04:05.000Z";

const target = cloudTarget("https://cloud.example.test", "anon-key");

function signal(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: SIGNAL,
    workspace_id: WORKSPACE,
    from: USER,
    from_kind: "user",
    to: null,
    to_agent: AGENT,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body: "deliver-this",
    until: "2030-01-01T00:00:00.000Z",
    created_at: "2029-12-31T00:00:00.000Z",
    ...overrides,
  };
}

function delivery(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    signal: signal(),
    lease_id: LEASE,
    leased_until: FUTURE,
    sender_owner_relation: "same_owner",
    ...overrides,
  };
}

function claimBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    status: "accepted",
    ok: true,
    capabilities: {
      delivery_claim: 1,
      delivery_ack: 1,
      sender_owner_relation: 1,
    },
    deliveries: [delivery()],
    pending_delivery_count: 1,
    event_ids: [],
    events: [],
    min_client_version: "0.1.0",
    ...overrides,
  };
}

function ackBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    status: "accepted",
    ok: true,
    event_ids: [],
    signal_id: SIGNAL,
    outcome: "replied",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface CapturedRequest {
  url: string;
  init?: RequestInit;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function capturingFetch(
  captures: CapturedRequest[],
  respond: (request: CapturedRequest) => Response,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const rawHeaders = (init?.headers ?? {}) as
      | Headers
      | Record<string, string>
      | [string, string][];
    const headerOf = (name: string): string => {
      if (rawHeaders instanceof Headers) return rawHeaders.get(name) ?? "";
      if (Array.isArray(rawHeaders)) {
        for (const [key, value] of rawHeaders) {
          if (key.toLowerCase() === name) return value;
        }
        return "";
      }
      const value = (rawHeaders as Record<string, string>)[name];
      return typeof value === "string" ? value : "";
    };
    const captured = {
      url: String(url),
      init,
      headers: {
        authorization: headerOf("authorization"),
        apikey: headerOf("apikey"),
        "content-type": headerOf("content-type"),
      },
      body: (typeof init?.body === "string"
        ? JSON.parse(init.body)
        : {}) as Record<string, unknown>,
    };
    captures.push(captured);
    return respond(captured);
  }) as typeof fetch;
}

function claimRequest(overrides: Partial<DeliveryClaimRequest> = {}): DeliveryClaimRequest {
  return {
    workspaceId: WORKSPACE,
    credential: TOKEN,
    commandId: COMMAND_ID,
    listenerInstanceId: LISTENER,
    limit: 10,
    expectedPrincipalId: AGENT,
    ...overrides,
  };
}

function ackRequest(overrides: Partial<DeliveryAckRequest> = {}): DeliveryAckRequest {
  return {
    workspaceId: WORKSPACE,
    credential: TOKEN,
    commandId: "cmd_ack_test_000001",
    signalId: SIGNAL,
    leaseId: LEASE,
    listenerInstanceId: LISTENER,
    outcome: "replied",
    lastErrorCode: null,
    ...overrides,
  };
}

test("claim_agent_inbox sends the exact command envelope and caller command id", async () => {
  const captures: CapturedRequest[] = [];
  const client = new DeliveryCommandClient(
    target,
    capturingFetch(captures, () => jsonResponse(200, claimBody())),
  );
  const result = await client.claimAgentInbox(claimRequest());
  assert.equal(captures.length, 1);
  const sent = captures[0]!;
  assert.equal(sent.url, commandEndpoint(target));
  assert.equal(sent.init?.method, "POST");
  assert.equal(sent.headers["authorization"], `Bearer ${TOKEN}`);
  assert.equal(sent.headers["apikey"], target.anonKey);
  assert.equal(sent.headers["content-type"], "application/json");
  assert.deepEqual(sent.body, {
    command_id: COMMAND_ID,
    client_version: CLIENT_PROTOCOL_VERSION,
    workspace_id: WORKSPACE,
    stream: { kind: "workspace" },
    command: {
      kind: "claim_agent_inbox",
      listener_instance_id: LISTENER,
      limit: 10,
    },
  });
  assert.equal(result.deliveries.length, 1);
});

test("claim parses a strict success with authoritative relation and unique ids", async () => {
  const body = claimBody({
    deliveries: [
      delivery(),
      delivery({
        signal: signal({ id: SIGNAL_2, kind: "note" }),
        lease_id: LEASE_2,
        sender_owner_relation: "cross_owner",
      }),
    ],
    pending_delivery_count: 5,
  });
  const client = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(200, body)),
  );
  const result = await client.claimAgentInbox(claimRequest());
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.capabilities, {
    deliveryClaim: true,
    deliveryAck: true,
    senderOwnerRelation: true,
  });
  assert.equal(result.pendingDeliveryCount, 5);
  assert.equal(result.deliveries.length, 2);
  assert.equal(result.deliveries[0]!.senderOwnerRelation, "same_owner");
  assert.equal(result.deliveries[1]!.senderOwnerRelation, "cross_owner");
  assert.equal(result.deliveries[1]!.signal.kind, "note");
  assert.equal(result.deliveries[1]!.signal.to_agent, AGENT);
  // The authoritative outer relation survives an inner signal without one.
  assert.equal(result.deliveries[0]!.signal.sender_owner_relation, "unknown");
});

test("claim rejects malformed responses and rows", async () => {
  const rejections: Array<[string, Record<string, unknown> | Response]> = [
    ["status rejected", claimBody({ status: "rejected" })],
    ["ok missing", claimBody({ ok: false })],
    ["capabilities missing", claimBody({ capabilities: undefined })],
    ["delivery_claim marker off", claimBody({
      capabilities: { delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 0 },
    })],
    ["deliveries not an array", claimBody({ deliveries: "nope" })],
    ["malformed lease id", claimBody({
      deliveries: [delivery({ lease_id: "not-a-uuid" })],
    })],
    ["malformed leased_until", claimBody({
      deliveries: [delivery({ leased_until: "tomorrow-ish" })],
    })],
    ["malformed relation", claimBody({
      deliveries: [delivery({ sender_owner_relation: "enemy" })],
    })],
    ["signal workspace mismatch", claimBody({
      deliveries: [delivery({ signal: signal({ workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }) })],
    })],
    ["signal recipient mismatch", claimBody({
      deliveries: [delivery({ signal: signal({ to_agent: AGENT.replace("2", "9") }) })],
    })],
    ["non-direct signal kind", claimBody({
      deliveries: [delivery({ signal: signal({ kind: "working-on" }) })],
    })],
    ["duplicate signal ids", claimBody({
      deliveries: [delivery(), delivery({ lease_id: LEASE_2 })],
    })],
    ["duplicate lease ids", claimBody({
      deliveries: [
        delivery({ signal: signal() }),
        delivery({ signal: signal({ id: SIGNAL_2 }), lease_id: LEASE }),
      ],
    })],
    ["negative count", claimBody({ pending_delivery_count: -1 })],
    ["fractional count", claimBody({ pending_delivery_count: 1.5 })],
    ["unsafe count", claimBody({ pending_delivery_count: 9_007_199_254_740_992 })],
    ["count missing", claimBody({ pending_delivery_count: undefined })],
    ["count smaller than deliveries", claimBody({ pending_delivery_count: 0 })],
    ["malformed signal row", claimBody({
      deliveries: [{ lease_id: LEASE, leased_until: FUTURE, sender_owner_relation: "unknown" }],
    })],
  ];
  for (const [label, body] of rejections) {
    const client = new DeliveryCommandClient(
      target,
      capturingFetch([], () => jsonResponse(200, body)),
    );
    await assert.rejects(
      client.claimAgentInbox(claimRequest()),
      (error: unknown) => {
        assert.ok(error instanceof DeliveryProtocolError, `${label}: ${String(error)}`);
        return true;
      },
      label,
    );
  }
});

test("claim maps bounded HTTP refusals without body or bearer leakage", async () => {
  const secret = "DO-NOT-LEAK-this-response-body";
  const cases: Array<[number, string]> = [
    [401, "unauthenticated"],
    [403, "delivery_unavailable"],
    [409, "delivery_ack_conflict"],
    [429, "rate_limited"],
    [500, "internal_error"],
    [503, "temporarily_unavailable"],
  ];
  for (const [status, code] of cases) {
    const client = new DeliveryCommandClient(
      target,
      capturingFetch([], () =>
        jsonResponse(status, { error: code, secret, echoed: TOKEN }),
      ),
    );
    await assert.rejects(
      client.claimAgentInbox(claimRequest()),
      (error: unknown) => {
        assert.ok(error instanceof DeliveryHttpError, `${status}: ${String(error)}`);
        assert.equal((error as DeliveryHttpError).status, status);
        assert.equal((error as DeliveryHttpError).code, code);
        assert.ok(!error.message.includes(secret), "body leaked into the error");
        assert.ok(!error.message.includes(TOKEN), "bearer leaked into the error");
        return true;
      },
      `status ${status}`,
    );
  }

  // An unknown or non-string code collapses to the bounded unknown code.
  const client = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(403, { error: secret, secret })),
  );
  await assert.rejects(
    client.claimAgentInbox(claimRequest()),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryHttpError);
      assert.equal((error as DeliveryHttpError).code, DELIVERY_UNKNOWN_ERROR_CODE);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test("ack sends the exact shape with explicit null and parses the echo", async () => {
  const captures: CapturedRequest[] = [];
  const client = new DeliveryCommandClient(
    target,
    capturingFetch(captures, () => jsonResponse(200, ackBody())),
  );
  const result = await client.ackAgentDelivery(ackRequest());
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0]!.body, {
    command_id: "cmd_ack_test_000001",
    client_version: CLIENT_PROTOCOL_VERSION,
    workspace_id: WORKSPACE,
    stream: { kind: "workspace" },
    command: {
      kind: "ack_agent_delivery",
      signal_id: SIGNAL,
      lease_id: LEASE,
      listener_instance_id: LISTENER,
      outcome: "replied",
      last_error_code: null,
    },
  });
  assert.equal(result.signalId, SIGNAL);
  assert.equal(result.outcome, "replied");
});

test("ack enforces explicit-null and failed-terminal code rules before the round trip", async () => {
  await assert.rejects(
    Promise.resolve().then(() =>
      new DeliveryCommandClient(target, capturingFetch([], () => jsonResponse(200, ackBody())))
        .ackAgentDelivery(ackRequest({ outcome: "replied", lastErrorCode: "provider_refused" })),
    ),
    /must send lastErrorCode null/,
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      new DeliveryCommandClient(target, capturingFetch([], () => jsonResponse(200, ackBody())))
        .ackAgentDelivery(ackRequest({ outcome: "failed_terminal", lastErrorCode: null })),
    ),
    /failed_terminal acknowledgement requires one of/,
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      new DeliveryCommandClient(target, capturingFetch([], () => jsonResponse(200, ackBody())))
        .ackAgentDelivery(ackRequest({ outcome: "failed_terminal", lastErrorCode: "boom" })),
    ),
    /failed_terminal acknowledgement requires one of/,
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      new DeliveryCommandClient(target, capturingFetch([], () => jsonResponse(200, ackBody())))
        .ackAgentDelivery(ackRequest({ outcome: "evade" as never, lastErrorCode: null })),
    ),
    /must be replied, observed, expired, or failed_terminal/,
  );

  const captures: CapturedRequest[] = [];
  const client = new DeliveryCommandClient(
    target,
    capturingFetch(captures, () => jsonResponse(200, ackBody({ outcome: "failed_terminal" }))),
  );
  const result = await client.ackAgentDelivery(ackRequest({
    outcome: "failed_terminal",
    lastErrorCode: "provider_refused",
  }));
  assert.equal(
    (captures[0]!.body.command as Record<string, unknown>).last_error_code,
    "provider_refused",
  );
  assert.equal(result.outcome, "failed_terminal");
  assert.equal(DELIVERY_FAILED_TERMINAL_CODES.has("credential_unavailable"), true);
});

test("ack rejects an echo that does not repeat the requested signal id or outcome", async () => {
  const mismatches: Array<[string, Record<string, unknown>]> = [
    ["different signal id", ackBody({ signal_id: SIGNAL_2 })],
    ["different outcome", ackBody({ outcome: "observed" })],
    ["status rejected", ackBody({ status: "rejected" })],
    ["ok missing", ackBody({ ok: false })],
  ];
  for (const [label, body] of mismatches) {
    const client = new DeliveryCommandClient(
      target,
      capturingFetch([], () => jsonResponse(200, body)),
    );
    await assert.rejects(
      client.ackAgentDelivery(ackRequest()),
      (error: unknown) => {
        assert.ok(error instanceof DeliveryProtocolError, `${label}: ${String(error)}`);
        return true;
      },
      label,
    );
  }
});

test("legacy read capabilities fall back false/null and capable edges count strictly", async () => {
  const credentials = { kind: "agent" as const, token: TOKEN };
  const legacy = await readAgentSignalPage(
    target,
    credentials,
    { workspaceId: WORKSPACE, inbox: true },
    {
      fetcher: (async () => jsonResponse(200, {
        signals: [signal()],
        capabilities: { sender_owner_relation: 1, cursor_after: 1 },
      })) as typeof fetch,
    },
  );
  assert.equal(legacy.capabilities.deliveryClaim, false);
  assert.equal(legacy.capabilities.deliveryAck, false);
  assert.equal(legacy.pendingDeliveryCount, null);

  const capable = await readAgentSignalPage(
    target,
    credentials,
    { workspaceId: WORKSPACE, inbox: true },
    {
      fetcher: (async () => jsonResponse(200, {
        signals: [signal()],
        capabilities: {
          sender_owner_relation: 1,
          cursor_after: 1,
          delivery_claim: 1,
          delivery_ack: 1,
        },
        pending_delivery_count: 7,
      })) as typeof fetch,
    },
  );
  assert.equal(capable.capabilities.deliveryClaim, true);
  assert.equal(capable.capabilities.deliveryAck, true);
  assert.equal(capable.pendingDeliveryCount, 7);

  // Either delivery marker alone makes the count mandatory and strictly valid.
  const ackOnly = await readAgentSignalPage(
    target,
    credentials,
    { workspaceId: WORKSPACE, inbox: true },
    {
      fetcher: (async () => jsonResponse(200, {
        signals: [signal()],
        capabilities: { delivery_ack: 1 },
        pending_delivery_count: 2,
      })) as typeof fetch,
    },
  );
  assert.equal(ackOnly.pendingDeliveryCount, 2);

  const malformedCountBodies: Array<[string, unknown]> = [
    ["missing", undefined],
    ["negative", -1],
    ["fractional", 2.5],
    ["unsafe", 9_007_199_254_740_992],
    ["string", "3"],
  ];
  for (const [label, count] of malformedCountBodies) {
    const body: Record<string, unknown> = {
      signals: [signal()],
      capabilities: { delivery_claim: 1 },
    };
    if (count !== undefined) body.pending_delivery_count = count;
    await assert.rejects(
      readAgentSignalPage(
        target,
        credentials,
        { workspaceId: WORKSPACE, inbox: true },
        { fetcher: (async () => jsonResponse(200, body)) as typeof fetch },
      ),
      /malformed pending_delivery_count/,
      `count ${label}`,
    );
  }
});

test("the delivery error vocabulary stays bounded and the claim limit matches the server", () => {
  assert.equal(DELIVERY_SERVER_ERROR_CODES.has(DELIVERY_UNKNOWN_ERROR_CODE), false);
  assert.equal(DELIVERY_SERVER_ERROR_CODES.has("delivery_unavailable"), true);
  assert.equal(DELIVERY_SERVER_ERROR_CODES.has("delivery_ack_conflict"), true);
  assert.equal(DELIVERY_CLAIM_MAX_LIMIT, 100);
});

test("delivery-client.test.ts is literally named by the root npm test script", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  const testScript = packageJson.scripts?.["test"] ?? "";
  assert.ok(
    testScript.includes("tests/delivery-client.test.ts"),
    `npm test must name tests/delivery-client.test.ts; script is: ${testScript}`,
  );
});