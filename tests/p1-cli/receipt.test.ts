import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  renderSignalReceiptReport,
  signalReceiptJsonPayload,
  type SignalReceiptReport,
} from "../../src/cloud/receipts.js";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  deliveryReceiptState,
  DeliveryReceiptReadError,
  readAgentDeliveryReceipts,
  type DeliveryAckOutcome,
  type DeliveryReceipt,
  type HumanDeliveryReceipt,
} from "../../src/cloud/delivery-receipts.js";
import { SignalReadTimeoutError } from "../../src/cloud/signals.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIGNAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
const NOW = Date.parse("2026-08-28T12:30:00.000Z");

function receipt(overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return {
    recipient_agent_principal_id: AGENT,
    enqueued_at: "2026-08-28T12:00:00.000Z",
    delivered_at: null,
    leased_until: null,
    acked_at: null,
    ack_outcome: null,
    attempt_count: 0,
    lease_expiry_count: 0,
    last_error_code: null,
    ...overrides,
  };
}

function report(row: DeliveryReceipt): SignalReceiptReport {
  return {
    workspaceId: WORKSPACE,
    signalId: SIGNAL,
    addressed: true,
    receipts: [row],
  };
}

function humanReport(row: HumanDeliveryReceipt): SignalReceiptReport {
  return {
    workspaceId: WORKSPACE,
    signalId: SIGNAL,
    addressed: true,
    receipts: [row],
  };
}

function wireRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipient_agent_principal_id: AGENT,
    enqueued_at: "2026-08-28T12:00:00.000Z",
    delivered_at: null,
    leased_until: null,
    acked_at: null,
    ack_outcome: null,
    attempt_count: 0,
    lease_expiry_count: 0,
    last_error_code: null,
    ...overrides,
  };
}

function wireReport(
  receipts: Record<string, unknown>[],
  addressed = true,
): Record<string, unknown> {
  return {
    addressed,
    receipts,
  };
}

test("receipt rendering keeps pending, delivered, and current work distinct and actionable", () => {
  const pending = renderSignalReceiptReport(report(receipt()), NOW);
  const delivered = renderSignalReceiptReport(report(receipt({
    delivered_at: "2026-08-28T12:18:00.000Z",
  })), NOW);
  const working = renderSignalReceiptReport(report(receipt({
    delivered_at: "2026-08-28T12:18:00.000Z",
    leased_until: "2026-08-28T12:40:00.000Z",
  })), NOW);

  assert.match(pending, /Not yet delivered/);
  assert.match(pending, /cswarm listen status/);
  assert.match(pending, /cswarm receipt/);
  assert.doesNotMatch(pending, /Delivered to agent|working on it right now|finished/);

  assert.match(delivered, /Delivered to agent/);
  assert.match(delivered, /has not acted on it/);
  assert.match(delivered, /cswarm receipt/);
  assert.doesNotMatch(delivered, /Not yet delivered|working on it right now|finished/);

  assert.match(working, /working on it right now/);
  assert.match(working, /cswarm receipt/);
  assert.doesNotMatch(working, /Not yet delivered|has not acted on it|finished/);
});

test("an expired lease is delivered and untouched, not current work", () => {
  const row = receipt({
    delivered_at: "2026-08-28T12:18:00.000Z",
    leased_until: "2026-08-28T12:20:00.000Z",
    lease_expiry_count: 1,
  });

  assert.equal(deliveryReceiptState(row, NOW), "delivered");
  assert.match(renderSignalReceiptReport(report(row), NOW), /has not acted on it/);
});

test("each receipt outcome keeps its exact meaning and next step", () => {
  const expected: Record<DeliveryAckOutcome, RegExp[]> = {
    replied: [/outcome replied/, /cswarm inbox/],
    observed: [/outcome observed/, /saw the signal/, /cswarm ask/],
    queued: [/Queued for agent/, /has not seen it yet/, /next prompt/, /cswarm receipt/],
    expired: [/outcome expired/, /expired before/, /cswarm ask/],
    failed_terminal: [
      /outcome failed_terminal/,
      /will not retry/,
      /cswarm listen status/,
    ],
  };

  for (const outcome of Object.keys(expected) as DeliveryAckOutcome[]) {
    const rendered = renderSignalReceiptReport(report(receipt({
      delivered_at: "2026-08-28T12:02:00.000Z",
      acked_at: "2026-08-28T12:25:00.000Z",
      ack_outcome: outcome,
      last_error_code: outcome === "failed_terminal"
        ? "provider_refused"
        : null,
    })), NOW);
    for (const pattern of expected[outcome]) assert.match(rendered, pattern);
    if (outcome === "queued") {
      assert.doesNotMatch(rendered, /finished|outcome observed|saw the signal/);
      continue;
    }
    for (const other of Object.keys(expected) as DeliveryAckOutcome[]) {
      if (other === outcome) continue;
      assert.doesNotMatch(rendered, new RegExp(`outcome ${other}(?:\\s|\\.)`));
    }
  }
});

test("a broadcast names the no-recipient fact and never invents a failed or pending state", () => {
  const rendered = renderSignalReceiptReport({
    workspaceId: WORKSPACE,
    signalId: SIGNAL,
    addressed: false,
    receipts: [],
  }, NOW);

  assert.match(
    rendered,
    /This was a broadcast; no agent was addressed and none was woken\./,
  );
  assert.match(rendered, /cswarm ask/);
  assert.doesNotMatch(rendered, /pending|failed|not yet delivered|working/i);
});

test("a human receipt states the browser proxy without claiming comprehension", () => {
  const notSeen = renderSignalReceiptReport(humanReport({
    recipient_user_id: AGENT,
    seen_at: null,
  }), NOW);
  assert.equal(
    notSeen,
    "Not seen yet — the member's browser reports seen state when the message is viewed.",
  );
  assert.doesNotMatch(notSeen, /Receipt unavailable|read|understood/i);

  const seen = renderSignalReceiptReport(humanReport({
    recipient_user_id: AGENT,
    seen_at: "2026-08-28T12:25:00.000Z",
  }), NOW);
  assert.match(seen, new RegExp(`Seen by ${AGENT} at 2026-08-28T12:25:00.000Z\\.`));
  assert.match(seen, /browser proxy.*row was in view.*document had focus/i);
  assert.doesNotMatch(seen, /read|understood|acknowledged/i);
});

test("human JSON distinguishes not_seen from seen", () => {
  const unseen = signalReceiptJsonPayload(humanReport({
    recipient_user_id: AGENT,
    seen_at: null,
  }), NOW);
  const seen = signalReceiptJsonPayload(humanReport({
    recipient_user_id: AGENT,
    seen_at: "2026-08-28T12:25:00.000Z",
  }), NOW);
  assert.deepEqual((unseen.receipts as unknown[])[0], {
    recipient_user_id: AGENT,
    state: "not_seen",
    seen_at: null,
  });
  assert.equal(
    ((seen.receipts as Array<Record<string, unknown>>)[0]!).state,
    "seen",
  );
});

test("--json payload carries the machine state, outcome, recipient, and ledger fields", () => {
  const payload = signalReceiptJsonPayload(report(receipt({
    delivered_at: "2026-08-28T12:02:00.000Z",
    acked_at: "2026-08-28T12:25:00.000Z",
    ack_outcome: "observed",
    attempt_count: 2,
    lease_expiry_count: 1,
  })), NOW);
  const rows = payload.receipts as Array<Record<string, unknown>>;

  assert.equal(payload.workspace_id, WORKSPACE);
  assert.equal(payload.signal_id, SIGNAL);
  assert.equal(payload.broadcast, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.recipient_agent_principal_id, AGENT);
  assert.equal(rows[0]!.state, "finished");
  assert.equal(rows[0]!.outcome, "observed");
  assert.equal(rows[0]!.attempt_count, 2);
  assert.equal(rows[0]!.lease_expiry_count, 1);
  assert.ok("delivered_at" in rows[0]!);
  assert.ok("leased_until" in rows[0]!);
  assert.ok("acked_at" in rows[0]!);
});

test("--json keeps queued separate from a finished or observed delivery", () => {
  const payload = signalReceiptJsonPayload(report(receipt({
    delivered_at: "2026-08-28T12:02:00.000Z",
    acked_at: "2026-08-28T12:03:00.000Z",
    ack_outcome: "queued",
  })), NOW);
  const row = (payload.receipts as Array<Record<string, unknown>>)[0]!;
  assert.equal(row.state, "queued");
  assert.equal(row.outcome, "queued");
});

test("the client seam sends the narrow author-scoped request with the agent credential", async () => {
  const authorizations: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(wireReport([wireRow()])), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const target = cloudTarget("https://example.supabase.co", "anon");

  const fromAgent = await readAgentDeliveryReceipts(
    target,
    TOKEN,
    WORKSPACE,
    SIGNAL,
    { fetcher },
  );
  assert.equal(fromAgent.receipts.length, 1);
  assert.deepEqual(authorizations, [`Bearer ${TOKEN}`]);
  assert.deepEqual(requests, [
    { resource: "delivery_receipts", workspace_id: WORKSPACE, signal_id: SIGNAL },
  ]);
});

test("broadcast and addressed-empty responses are distinguishable and fail closed", async () => {
  const target = cloudTarget("https://example.supabase.co", "anon");
  const broadcast = await readAgentDeliveryReceipts(
    target,
    TOKEN,
    WORKSPACE,
    SIGNAL,
    { fetcher: async () => new Response(JSON.stringify(wireReport([], false))) },
  );
  assert.equal(broadcast.addressed, false);
  assert.deepEqual(broadcast.receipts, []);

  await assert.rejects(
    readAgentDeliveryReceipts(target, TOKEN, WORKSPACE, SIGNAL, {
      fetcher: async () => new Response(JSON.stringify(wireReport([], true))),
    }),
    (error: unknown) =>
      error instanceof DeliveryReceiptReadError && error.code === "protocol",
  );
  await assert.rejects(
    readAgentDeliveryReceipts(target, TOKEN, WORKSPACE, SIGNAL, {
      fetcher: async () =>
        new Response(JSON.stringify({ addressed: null, receipts: [] })),
    }),
    (error: unknown) =>
      error instanceof DeliveryReceiptReadError && error.code === "not_author",
  );
});

test("deadline and caller abort both stop a receipt read with the existing timeout type", async () => {
  const neverFetch: typeof fetch = async () =>
    await new Promise<Response>(() => {});
  const target = cloudTarget("https://example.supabase.co", "anon");

  await assert.rejects(
    readAgentDeliveryReceipts(target, TOKEN, WORKSPACE, SIGNAL, {
      fetcher: neverFetch,
      deadlineMs: Date.now() + 10,
    }),
    SignalReadTimeoutError,
  );

  const controller = new AbortController();
  const read = readAgentDeliveryReceipts(target, TOKEN, WORKSPACE, SIGNAL, {
    fetcher: neverFetch,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(read, SignalReadTimeoutError);
});

async function runCliAgainst(
  status: number,
  responseBody: Record<string, unknown>,
  json = true,
): Promise<{ code: number; stdout: string; stderr: string; request: unknown }> {
  let received: unknown = null;
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => raw += chunk);
    request.on("end", () => {
      received = JSON.parse(raw);
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "src/cli.ts",
      "receipt",
      SIGNAL,
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
      ...(json ? ["--json"] : []),
    ], {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_CLOUD_WORKSPACE_ID: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(TOKEN);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout += chunk);
    child.stderr.on("data", (chunk: string) => stderr += chunk);
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolve(value ?? 1));
    });
    return { code, stdout, stderr, request: received };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("the receipt CLI prints machine fields from the fake server", async () => {
  const result = await runCliAgainst(200, wireReport([wireRow({
    delivered_at: "2026-08-28T12:02:00.000Z",
  })]));

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  const rows = output.receipts as Array<Record<string, unknown>>;
  assert.equal(output.signal_id, SIGNAL);
  assert.equal(rows[0]!.state, "delivered");
  assert.equal(rows[0]!.recipient_agent_principal_id, AGENT);
  assert.deepEqual(result.request, {
    resource: "delivery_receipts",
    workspace_id: WORKSPACE,
    signal_id: SIGNAL,
  });
});

test("the receipt CLI uses the human wording by default", async () => {
  const result = await runCliAgainst(200, wireReport([wireRow()]), false);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Not yet delivered/);
  assert.match(result.stdout, /cswarm listen status/);
  assert.match(result.stdout, /cswarm receipt/);
  assert.doesNotMatch(result.stdout, /^\s*\{/);
});

test("the receipt CLI renders a member target as not seen instead of unavailable", async () => {
  const result = await runCliAgainst(200, wireReport([{
    recipient_user_id: AGENT,
    seen_at: null,
  }]), false);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Not seen yet/);
  assert.match(result.stdout, /member's browser reports seen state when the message is viewed/);
  assert.doesNotMatch(result.stdout, /Receipt unavailable|read|understood/i);
});

test("the receipt CLI renders the focused-viewport timestamp as Seen", async () => {
  const result = await runCliAgainst(200, wireReport([{
    recipient_user_id: AGENT,
    seen_at: "2026-08-28T12:25:00.000Z",
  }]), false);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, new RegExp(`Seen by ${AGENT}`));
  assert.match(result.stdout, /row was in view while the document had focus/);
  assert.doesNotMatch(result.stdout, /read|understood|acknowledged/i);
});

test("a missing receipt endpoint shows no fabricated state", async () => {
  const result = await runCliAgainst(404, { error: "not_found" });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /No delivery state was shown/);
  assert.match(result.stderr, /HTTP 404/);
  assert.match(result.stderr, /cswarm receipt/);
  assert.doesNotMatch(
    result.stderr,
    /Not yet delivered|Delivered to agent|working on it right now|finished with outcome/,
  );
});
