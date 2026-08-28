/** Reached by `npm --prefix site test` through the recursive component observer-test glob. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  browserDeliveryIndicator,
  type BrowserDeliveryReceipt,
  type BrowserDeliveryReceiptResult,
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

test("all four acknowledgements stay distinct, especially observed and replied", () => {
  const outcomes = ["replied", "observed", "expired", "failed_terminal"] as const;
  const indicators = outcomes.map((ackOutcome) => browserDeliveryIndicator(addressed(receipt({
    deliveredAt: "2026-08-28T14:40:00.000Z",
    ackedAt: "2026-08-28T14:50:00.000Z",
    ackOutcome,
    attemptCount: 1,
  })), NOW));

  assert.deepEqual(indicators.map(({ outcome }) => outcome), outcomes);
  assert.deepEqual(indicators.map(({ label }) => label), [
    "Replied",
    "Observed",
    "Expired",
    "Failed",
  ]);
  assert.equal(new Set(indicators.map(({ label, detail }) => `${label}:${detail}`)).size, 4);
  assert.match(indicators[1]!.detail, /without replying/);
  assert.doesNotMatch(indicators[1]!.detail, /replied|read/i);
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
  assert.match(refresh, /RECEIPT_REQUESTS_PER_TICK/);
  assert.match(refresh, /RECEIPT_UNAVAILABLE_REFRESH_MS/);
});
