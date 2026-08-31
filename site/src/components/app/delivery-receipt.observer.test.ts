/** Reached by `npm --prefix site test` through the recursive component observer-test glob. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BROWSER_RECEIPT_REQUESTS_PER_TICK,
  browserDeliveryIndicator,
  browserDeliveryReceiptCandidates,
  type BrowserDeliveryReceipt,
  type BrowserDeliveryReceiptCacheEntry,
  type BrowserDeliveryReceiptResult,
  type Signal,
} from "../../lib/commonswarm.js";

const NOW = Date.parse("2026-08-28T15:00:00.000Z");
const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const client = readFileSync(new URL("../../lib/commonswarm.ts", import.meta.url), "utf8");

const receipt = (
  changes: Partial<BrowserDeliveryReceipt> = {},
): BrowserDeliveryReceipt => ({
  recipientAgentPrincipalId: "agent-1",
  enqueuedAt: "2026-08-28T14:30:00.000Z",
  deliveredAt: null,
  leasedUntil: null,
  ackedAt: null,
  ackOutcome: null,
  attemptCount: 0,
  leaseExpiryCount: 0,
  lastErrorCode: null,
  ...changes,
});

const addressed = (...receipts: BrowserDeliveryReceipt[]): BrowserDeliveryReceiptResult => ({
  addressed: true,
  receipts,
});

const signal = (
  id: string,
  createdAt: string,
  changes: Partial<Signal> = {},
): Signal => ({
  id,
  from: "agent-sender",
  fromKind: "agent",
  to: null,
  toAgent: "agent-recipient",
  kind: "ask",
  body: id,
  about: null,
  until: null,
  createdAt,
  ...changes,
});

test("every ledger state has a distinct text-and-symbol indicator", () => {
  const indicators = [
    browserDeliveryIndicator(addressed(receipt()), NOW),
    browserDeliveryIndicator(addressed(receipt({
      deliveredAt: "2026-08-28T14:40:00.000Z",
      attemptCount: 1,
    })), NOW),
    browserDeliveryIndicator(addressed(receipt({
      deliveredAt: "2026-08-28T14:40:00.000Z",
      leasedUntil: "2026-08-28T15:05:00.000Z",
      attemptCount: 1,
    })), NOW),
    browserDeliveryIndicator(addressed(receipt({
      deliveredAt: "2026-08-28T14:30:00.000Z",
      attemptCount: 2,
      leaseExpiryCount: 1,
      lastErrorCode: "listener_gone",
    })), NOW),
  ];

  assert.deepEqual(indicators.map(({ state }) => state), [
    "sent",
    "delivered",
    "working",
    "stuck",
  ]);
  assert.deepEqual(indicators.map(({ label }) => label), [
    "Sent",
    "Delivered",
    "Working",
    "Needs attention",
  ]);
  assert.equal(new Set(indicators.map(({ glyph }) => glyph)).size, indicators.length);
  assert.match(indicators[1]!.detail, /20 minutes ago\. No response yet\./);
  assert.doesNotMatch(indicators.map(({ detail }) => detail).join(" "), /\bread\b/i);
});

test("queued, observed, replied, expired, and failed stay distinct", () => {
  const outcomes = ["queued", "replied", "observed", "expired", "failed_terminal"] as const;
  const indicators = outcomes.map((ackOutcome) => browserDeliveryIndicator(addressed(receipt({
    deliveredAt: "2026-08-28T14:40:00.000Z",
    ackedAt: "2026-08-28T14:50:00.000Z",
    ackOutcome,
    attemptCount: 1,
  })), NOW));

  assert.deepEqual(indicators.map(({ outcome }) => outcome), outcomes);
  assert.deepEqual(indicators.map(({ label }) => label), [
    "Queued",
    "Replied",
    "Observed",
    "Expired",
    "Failed",
  ]);
  assert.equal(new Set(indicators.map(({ label, detail }) => `${label}:${detail}`)).size, 5);
  assert.match(indicators[0]!.detail, /has not seen it yet.*next prompt/);
  assert.equal(indicators[0]!.terminal, false);
  assert.match(indicators[2]!.detail, /saw this delivery without replying/);
  assert.doesNotMatch(indicators[2]!.detail, /acknowledged|read/i);
});

test("broadcast uses addressed=false and can never look pending or failed", () => {
  const indicator = browserDeliveryIndicator({ addressed: false, receipts: [] }, NOW);
  assert.equal(indicator.state, "no-recipient");
  assert.equal(indicator.label, "No recipient");
  assert.match(indicator.detail, /nobody was addressed or woken/);
  assert.doesNotMatch(
    `${indicator.state} ${indicator.label} ${indicator.detail}`,
    /pending|sending|failed|not delivered/i,
  );

  const mapping = client.slice(
    client.indexOf("export function browserDeliveryIndicator"),
    client.indexOf("/** Posts one browser-authored note", client.indexOf("export function browserDeliveryIndicator")),
  );
  assert.match(mapping, /if \(result\.addressed === false\)/);
  assert.match(mapping, /state: "no-recipient"/);
  assert.doesNotMatch(mapping, /result\.receipts\.length === 0[\s\S]*state: "no-recipient"/);

  const renderer = dashboard.slice(
    dashboard.indexOf("const appendDeliveryReceipt ="),
    dashboard.indexOf("const composerForClearance ="),
  );
  assert.match(
    renderer,
    /signal\.toAgent === null\s+\? browserDeliveryIndicator\(\{ addressed: false, receipts: \[\] \}\)/,
  );
});

test("agent-to-agent and viewer-authored directed rows use the same receipt path", () => {
  const rows = [
    signal("agent-to-agent", "2026-08-28T14:59:00.000Z"),
    signal("viewer-to-agent", "2026-08-28T14:58:00.000Z", {
      from: "viewer",
      fromKind: "user",
    }),
    signal("broadcast", "2026-08-28T14:57:00.000Z", { toAgent: null }),
    signal("person-directed", "2026-08-28T14:56:00.000Z", {
      to: "person",
      toAgent: null,
    }),
  ];
  const selected = browserDeliveryReceiptCandidates(
    rows,
    new Map(),
    new Set(rows.map((row) => row.id)),
    NOW,
  );
  assert.deepEqual(selected.map((row) => row.id), ["agent-to-agent", "viewer-to-agent"]);

  const renderer = dashboard.slice(
    dashboard.indexOf("const appendDeliveryReceipt ="),
    dashboard.indexOf("const composerForClearance ="),
  );
  assert.doesNotMatch(renderer, /signal\.fromKind|signal\.from !== viewerId/);
  assert.equal(
    dashboard.match(/details\.className = "dashboard__message-receipt"/g)?.length,
    1,
    "all receipt states must render through one indicator builder",
  );
  assert.equal(
    dashboard.match(/appendDeliveryReceipt\(body, signal\)/g)?.length,
    1,
    "every transcript row must call the single indicator builder once",
  );
  assert.match(
    dashboard,
    /renderMessageAttachments\(body, signal\);[\s\S]{0,500}?appendDeliveryReceipt\(body, signal\)/,
    "attachment cards must extend the same transcript row before its one receipt",
  );
});

test("receipt candidates cap each feed tick and favor visible rows then newest rows", () => {
  const rows = Array.from({ length: 12 }, (_, index) =>
    signal(
      `agent-${index}`,
      new Date(Date.parse("2026-08-28T14:00:00.000Z") + index * 60_000).toISOString(),
    )
  );
  const cache = new Map<string, BrowserDeliveryReceiptCacheEntry>();
  const selected = browserDeliveryReceiptCandidates(
    rows,
    cache,
    new Set(["agent-1", "agent-2"]),
    NOW,
  );
  assert.equal(selected.length, BROWSER_RECEIPT_REQUESTS_PER_TICK);
  assert.deepEqual(selected.slice(0, 2).map((row) => row.id), ["agent-2", "agent-1"]);
  assert.deepEqual(
    selected.slice(2).map((row) => row.id),
    ["agent-11", "agent-10", "agent-9", "agent-8", "agent-7", "agent-6"],
  );
});

test("delivered silence and not-yet-delivered are visually and verbally different", () => {
  const sent = browserDeliveryIndicator(addressed(receipt()), NOW);
  const delivered = browserDeliveryIndicator(addressed(receipt({
    deliveredAt: "2026-08-28T14:40:00.000Z",
    attemptCount: 1,
  })), NOW);
  assert.notEqual(sent.state, delivered.state);
  assert.notEqual(sent.glyph, delivered.glyph);
  assert.match(sent.detail, /Not delivered/);
  assert.match(delivered.detail, /No response yet/);
});

test("several recipients render a count instead of one misleading tick", () => {
  const indicator = browserDeliveryIndicator(addressed(
    receipt({
      recipientAgentPrincipalId: "agent-1",
      deliveredAt: "2026-08-28T14:40:00.000Z",
      attemptCount: 1,
    }),
    receipt({
      recipientAgentPrincipalId: "agent-2",
      deliveredAt: "2026-08-28T14:45:00.000Z",
      attemptCount: 1,
    }),
    receipt({ recipientAgentPrincipalId: "agent-3" }),
  ), NOW);

  assert.equal(indicator.state, "delivered");
  assert.equal(indicator.label, "2 of 3 delivered");
  assert.match(indicator.detail, /2 delivered with no response; 1 sent but not delivered/);
});

test("missing or unusable receipt data renders unavailable, never a fabricated tick", () => {
  for (const result of [
    null,
    { addressed: null, receipts: [] },
    { addressed: true, receipts: [] },
  ] satisfies Array<BrowserDeliveryReceiptResult | null>) {
    const indicator = browserDeliveryIndicator(result, NOW);
    assert.equal(indicator.state, "unavailable");
    assert.equal(indicator.label, "Receipt unavailable");
    assert.equal(indicator.glyph, "?");
  }
});

test("a direct person target is not relabelled as a broadcast", () => {
  const renderer = dashboard.slice(
    dashboard.indexOf("const appendDeliveryReceipt ="),
    dashboard.indexOf("const composerForClearance ="),
  );
  assert.match(renderer, /signal\.to !== null && signal\.toAgent === null/);
  assert.match(renderer, /This message addresses a person\. Agent delivery receipts do not apply\./);
  assert.match(renderer, /state: "unavailable"/);
  assert.doesNotMatch(
    renderer.slice(
      renderer.indexOf("signal.to !== null && signal.toAgent === null"),
      renderer.indexOf(": browserDeliveryIndicator"),
    ),
    /No recipient|broadcast/i,
  );
});

test("rendered receipt has an accessible name and does not rely on colour", () => {
  const renderer = dashboard.slice(
    dashboard.indexOf("const appendDeliveryReceipt ="),
    dashboard.indexOf("const composerForClearance ="),
  );
  assert.match(renderer, /details\.dataset\.receiptState = indicator\.state/);
  assert.match(renderer, /summary\.setAttribute\(\s*"aria-label"/);
  assert.match(renderer, /glyph\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(renderer, /label\.textContent = indicator\.label/);
  assert.match(renderer, /detail\.textContent = indicator\.detail/);
  assert.match(dashboard, /\.dashboard__message-receipt\[data-receipt-state="stuck"\]/);
});

test("receipt refresh reuses the feed tick and adds no timer", () => {
  const refresh = dashboard.slice(
    dashboard.indexOf("const refreshDeliveryReceipts ="),
    dashboard.indexOf("const loadSignals ="),
  );
  const live = dashboard.slice(
    dashboard.indexOf("const refreshLatestSignals ="),
    dashboard.indexOf("const hasPendingAccess ="),
  );
  assert.match(live, /void refreshDeliveryReceipts\(workspaceId, version\)/);
  assert.doesNotMatch(refresh, /setInterval|setTimeout/);
  assert.match(refresh, /browserDeliveryReceiptCandidates\(/);
  assert.match(refresh, /BROWSER_RECEIPT_REQUESTS_PER_TICK/);
  assert.match(client, /BROWSER_RECEIPT_UNAVAILABLE_REFRESH_MS = 30_000/);
  assert.match(refresh, /visibleReceiptSignalIds\(\)/);
});
