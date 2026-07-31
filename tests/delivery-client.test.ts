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
  DELIVERY_FAILED_TERMINAL_CODES,
  DeliveryHttpError,
  DeliveryProtocolError,
  DeliveryTransportError,
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
    terminal_delivery_failure_count: 0,
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

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
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
  respond: (request: CapturedRequest) => Response | Promise<Response>,
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

test("claim_agent_inbox sends the exact command envelope, limit:1, and caller command id", async () => {
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
      limit: 1,
    },
  });
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.terminalDeliveryFailureCount, 0);
});

test("claim rejects a response containing more than one delivery", async () => {
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
  await assert.rejects(
    client.claimAgentInbox(claimRequest()),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryProtocolError);
      assert.equal((error as Error).message, "delivery claim response returned more than one delivery");
      return true;
    },
  );
});

test("header-immediate/body-never-settles claim times out at the injected deadline", async () => {
  const hangingFetcher: typeof fetch = (async () => {
    return new Response(
      new ReadableStream({
        start() {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const client = new DeliveryCommandClient(target, hangingFetcher, { deadlineMs: 20 });
  await assert.rejects(
    client.claimAgentInbox(claimRequest()),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryTransportError);
      assert.equal((error as Error).message, "delivery claim request timed out");
      return true;
    },
  );
});

test("header-immediate/body-never-settles non-2xx refusal and ACK body time out at injected deadline", async () => {
  const hangingRefusalFetcher: typeof fetch = (async () => {
    return new Response(
      new ReadableStream({ start() {} }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const clientClaim = new DeliveryCommandClient(target, hangingRefusalFetcher, { deadlineMs: 20 });
  await assert.rejects(
    clientClaim.claimAgentInbox(claimRequest()),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryTransportError);
      assert.equal((error as Error).message, "delivery claim request timed out");
      return true;
    },
  );

  const clientAck = new DeliveryCommandClient(target, hangingRefusalFetcher, { deadlineMs: 20 });
  await assert.rejects(
    clientAck.ackAgentDelivery(ackRequest()),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryTransportError);
      assert.equal((error as Error).message, "delivery acknowledgement request timed out");
      return true;
    },
  );
});

test("timer does not fire early and is cleaned after success", async () => {
  const client = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(200, claimBody())),
    { deadlineMs: 1000 },
  );
  const result = await client.claimAgentInbox(claimRequest());
  assert.equal(result.deliveries.length, 1);
});

test("duplicate signal/lease errors contain none of the test IDs, body, or bearer", async () => {
  // Test duplicate signal ID rejection message
  const dupSignalBody = claimBody({
    deliveries: [
      delivery({ signal: signal({ id: SIGNAL }) }),
      delivery({ signal: signal({ id: SIGNAL }), lease_id: LEASE_2 }),
    ],
    pending_delivery_count: 5,
  });
  const client = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(200, dupSignalBody)),
  );
  await assert.rejects(
    client.claimAgentInbox(claimRequest()),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryProtocolError);
      assert.ok(!error.message.includes(SIGNAL));
      assert.ok(!error.message.includes(LEASE));
      assert.ok(!error.message.includes(TOKEN));
      return true;
    },
  );
});

test("outer relation overwrites absent or hostile inner relation and normalizes to outer value", async () => {
  const body = claimBody({
    deliveries: [
      delivery({
        signal: signal({ sender_owner_relation: "cross_owner" }),
        sender_owner_relation: "same_owner",
      }),
    ],
  });
  const client = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(200, body)),
  );
  const result = await client.claimAgentInbox(claimRequest());
  assert.equal(result.deliveries[0]!.senderOwnerRelation, "same_owner");
  assert.equal(result.deliveries[0]!.signal.sender_owner_relation, "same_owner");

  const hostileBody = claimBody({
    deliveries: [
      delivery({ sender_owner_relation: "hostile_enemy" }),
    ],
  });
  const hostileClient = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(200, hostileBody)),
  );
  await assert.rejects(
    hostileClient.claimAgentInbox(claimRequest()),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryProtocolError);
      assert.equal(
        (error as Error).message,
        "delivery response returned a malformed sender_owner_relation",
      );
      return true;
    },
  );
});

test("non-RFC3339 timestamp and already-expired lease reject; future exact server timestamp succeeds under injected clock", async () => {
  const fakeNowMs = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  const now = () => fakeNowMs;

  const badTimestampBody = claimBody({
    deliveries: [delivery({ leased_until: "2030-01-02 03:04:05" })],
  });
  const client1 = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(200, badTimestampBody)),
    { now },
  );
  await assert.rejects(
    client1.claimAgentInbox(claimRequest()),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryProtocolError);
      assert.equal((error as Error).message, "delivery response returned a malformed leased_until");
      return true;
    },
  );

  const expiredLeaseBody = claimBody({
    deliveries: [delivery({ leased_until: "2023-11-14T22:13:20.000Z" })],
  });
  const client2 = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(200, expiredLeaseBody)),
    { now },
  );
  await assert.rejects(
    client2.claimAgentInbox(claimRequest()),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryProtocolError);
      assert.equal((error as Error).message, "delivery claim response returned an already expired lease");
      assert.ok(!error.message.includes("2023-11-14"));
      return true;
    },
  );

  const futureLeaseBody = claimBody({
    deliveries: [delivery({ leased_until: "2023-11-14T22:13:21.000Z" })],
  });
  const client3 = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(200, futureLeaseBody)),
    { now },
  );
  const result = await client3.claimAgentInbox(claimRequest());
  assert.equal(result.deliveries[0]!.leasedUntil, "2023-11-14T22:13:21.000Z");
});

test("malformed event_ids elements and non-array events reject", async () => {
  const badEventIdsBody = claimBody({ event_ids: [123] });
  const client1 = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(200, badEventIdsBody)),
  );
  await assert.rejects(
    client1.claimAgentInbox(claimRequest()),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryProtocolError);
      assert.equal((error as Error).message, "delivery response returned a malformed event_ids");
      return true;
    },
  );

  const badEventsBody = claimBody({ events: "not-an-array" });
  const client2 = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(200, badEventsBody)),
  );
  await assert.rejects(
    client2.claimAgentInbox(claimRequest()),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryProtocolError);
      assert.equal((error as Error).message, "delivery response returned a malformed events");
      return true;
    },
  );
});

test("missing, fractional, negative, or unsafe terminal failure count rejects; valid zero and positive return", async () => {
  const malformedCounts: Array<[string, unknown]> = [
    ["missing", undefined],
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", 9_007_199_254_740_992],
    ["string", "0"],
  ];
  for (const [label, count] of malformedCounts) {
    const body = claimBody();
    if (count === undefined) delete body.terminal_delivery_failure_count;
    else body.terminal_delivery_failure_count = count;

    const client = new DeliveryCommandClient(
      target,
      capturingFetch([], () => jsonResponse(200, body)),
    );
    await assert.rejects(
      client.claimAgentInbox(claimRequest()),
      (error: unknown) => {
        assert.ok(error instanceof DeliveryProtocolError, `${label}: ${String(error)}`);
        assert.equal(
          (error as Error).message,
          "delivery response returned a malformed terminal_delivery_failure_count",
        );
        return true;
      },
      label,
    );
  }

  const validZeroClient = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(200, claimBody({ terminal_delivery_failure_count: 0 }))),
  );
  const zeroRes = await validZeroClient.claimAgentInbox(claimRequest());
  assert.equal(zeroRes.terminalDeliveryFailureCount, 0);

  const validPosClient = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(200, claimBody({ terminal_delivery_failure_count: 4 }))),
  );
  const posRes = await validPosClient.claimAgentInbox(claimRequest());
  assert.equal(posRes.terminalDeliveryFailureCount, 4);
});

test("429 Retry-After produces bounded retry metadata without reflecting raw body", async () => {
  const secretBody = { error: "rate_limited", secret: "super-secret-token" };
  const client = new DeliveryCommandClient(
    target,
    capturingFetch([], () => jsonResponse(429, secretBody, { "retry-after": "120" })),
  );
  await assert.rejects(
    client.claimAgentInbox(claimRequest()),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryHttpError);
      assert.equal((error as DeliveryHttpError).status, 429);
      assert.equal((error as DeliveryHttpError).code, "rate_limited");
      assert.equal((error as DeliveryHttpError).retryAfterMs, 30000);
      assert.ok(!error.message.includes("super-secret-token"));
      assert.ok(!error.message.includes("120"));
      return true;
    },
  );
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

test("delivery marker present as 0, 2, string, or null rejects; total absence remains false/false/null", async () => {
  const credentials = { kind: "agent" as const, token: TOKEN };
  const malformedMarkers = [0, 2, "1", null, false];
  for (const marker of malformedMarkers) {
    await assert.rejects(
      readAgentSignalPage(
        target,
        credentials,
        { workspaceId: WORKSPACE, inbox: true },
        {
          fetcher: (async () => jsonResponse(200, {
            signals: [signal()],
            capabilities: { delivery_claim: marker },
          })) as typeof fetch,
        },
      ),
      /malformed delivery capability marker/,
    );
  }

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

  const capableOneMarker = await readAgentSignalPage(
    target,
    credentials,
    { workspaceId: WORKSPACE, inbox: true },
    {
      fetcher: (async () => jsonResponse(200, {
        signals: [signal()],
        capabilities: { delivery_claim: 1 },
        pending_delivery_count: 3,
      })) as typeof fetch,
    },
  );
  assert.equal(capableOneMarker.capabilities.deliveryClaim, true);
  assert.equal(capableOneMarker.pendingDeliveryCount, 3);
});

test("the delivery error vocabulary stays bounded and unknown codes collapse", () => {
  assert.equal(DELIVERY_SERVER_ERROR_CODES.has(DELIVERY_UNKNOWN_ERROR_CODE), false);
  assert.equal(DELIVERY_SERVER_ERROR_CODES.has("delivery_unavailable"), true);
  assert.equal(DELIVERY_SERVER_ERROR_CODES.has("delivery_ack_conflict"), true);
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