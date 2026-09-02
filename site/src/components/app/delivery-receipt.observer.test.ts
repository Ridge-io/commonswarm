/** Reached by `npm --prefix site test` through the recursive component observer-test glob. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BROWSER_RECEIPT_REQUESTS_PER_TICK,
  browserBroadcastRosterView,
  browserDeliveryIndicator,
  browserDeliveryReceiptCandidates,
  browserHumanDeliveryIndicator,
  browserRosterSectionLines,
  type BrowserDeliveryReceipt,
  type BrowserDeliveryReceiptCacheEntry,
  type BrowserDeliveryReceiptResult,
  type BrowserHumanDeliveryReceipt,
  type BrowserReceiptRow,
  type BrowserBroadcastAgentReceipt,
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

const addressed = (...receipts: BrowserReceiptRow[]): BrowserDeliveryReceiptResult => ({
  addressed: true,
  receipts,
});

const humanReceipt = (
  changes: Partial<BrowserHumanDeliveryReceipt> = {},
): BrowserHumanDeliveryReceipt => ({
  recipientUserId: "person",
  seenAt: null,
  ...changes,
});

const broadcastAgent = (
  changes: Partial<BrowserBroadcastAgentReceipt> = {},
): BrowserBroadcastAgentReceipt => ({
  principalId: "agent-untracked",
  recipientAgentPrincipalId: "agent-untracked",
  displayName: "Quill",
  seenAt: "2026-08-28T14:54:00.000Z",
  trackingState: "not_tracked",
  observedAt: null,
  ...changes,
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
    ...(ackOutcome === "queued" ? { pendingForMainCount: 4 } : {}),
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
  assert.match(
    indicators[0]!.detail,
    /waiting for the recipient's session hook \(4 in queue\)/,
  );
  assert.doesNotMatch(indicators[0]!.detail, /next prompt/);
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
    dashboard.indexOf("const feedScroller ="),
  );
  assert.match(
    renderer,
    /signal\.toAgent === null\s+\? browserDeliveryIndicator\(\s+cached\?\.result \?\? \{ addressed: false, receipts: \[\] \}/,
  );
});

test("broadcast summary and detail model split member and agent attestations", () => {
  /* Agents live under broadcastRoster.agents.principals, never in `receipts`:
   * a cached bundle's parser reads any non-human `receipts` row as a delivery
   * ledger row and would blank the indicator (20260902000001, folded). */
  const result: BrowserDeliveryReceiptResult = {
    addressed: false,
    receipts: [
      humanReceipt({
        recipientUserId: "member-seen",
        displayName: "Ari",
        seenAt: "2026-08-28T14:55:00.000Z",
      }),
      humanReceipt({ recipientUserId: "member-unseen", displayName: "Bo" }),
    ],
    broadcastRoster: {
      members: { total: 2, seen: 1, returned: 2, limit: 50, truncated: false },
      agents: {
        total: 1,
        seen: 1,
        returned: 1,
        limit: 50,
        truncated: false,
        trackingState: "not_tracked",
        principals: [broadcastAgent()],
      },
    },
  };
  const indicator = browserDeliveryIndicator(result, NOW);
  const roster = browserBroadcastRosterView(result);

  assert.equal(indicator.label, "Seen by 1 of 2 members · 1 of 1 agents");
  assert.equal(indicator.state, "seen");
  assert.match(indicator.detail, /nobody was addressed or woken/);
  assert.match(indicator.detail, /agent's CLI rendered it/);
  assert.deepEqual(roster.seenMembers.map((row) => row.displayName), ["Ari"]);
  assert.deepEqual(roster.notSeenMembers.map((row) => row.displayName), ["Bo"]);
  assert.deepEqual(roster.seenAgents.map((row) => row.displayName), ["Quill"]);
  assert.deepEqual(roster.notSeenAgents, []);
  assert.deepEqual(
    [
      roster.seenHidden,
      roster.notSeenHidden,
      roster.seenAgentsHidden,
      roster.notSeenAgentsHidden,
    ],
    [0, 0, 0, 0],
    "an uncut roster hides nothing",
  );
  const agentOnlyIndicator = browserDeliveryIndicator({
    ...result,
    receipts: result.receipts.map((row) =>
      "recipientUserId" in row ? { ...row, seenAt: null } : row
    ),
    broadcastRoster: {
      ...result.broadcastRoster!,
      members: { ...result.broadcastRoster!.members, seen: 0 },
    },
  }, NOW);
  assert.equal(
    agentOnlyIndicator.state,
    "seen",
    "an agent attestation alone must make the combined indicator seen",
  );

  const renderer = dashboard.slice(
    dashboard.indexOf("const appendDeliveryReceipt ="),
    dashboard.indexOf("const feedScroller ="),
  );
  assert.match(renderer, /"Seen members"/);
  assert.match(renderer, /"Not-seen members"/);
  assert.match(renderer, /`Seen agents · \$\{broadcastResult\.broadcastRoster\.agents\.seen\}/);
  assert.match(renderer, /"Not-seen agents"/);
  assert.match(renderer, /not yet seen/);
  assert.doesNotMatch(
    renderer,
    /listener has not read the feed/,
    "no receipt cannot name why an agent has not attested",
  );
  assert.match(
    renderer,
    /roster\.seenAgents\.map/,
    "the agent section must render from the roster view, which reads principals",
  );
  assert.equal(
    dashboard.match(/details\.className = "dashboard__message-receipt"/g)?.length,
    1,
    "broadcast detail must stay inside the one receipt indicator component",
  );
});

/* D3 (2026-09-01 inversion review): 100 live members, 60 seen. The server's
 * seen-first cap returns 50 seen rows and 0 not-seen rows, so a section that
 * prints "None" whenever it has no rows tells 40 people's colleagues that
 * everyone has seen it. The section decision lives in browserRosterSectionLines
 * so this control exercises the dashboard's own rule, and the renderer pin
 * proves the dashboard hands every section through it. */
test("a cut roster section names the hidden remainder instead of None", () => {
  const result: BrowserDeliveryReceiptResult = {
    addressed: false,
    receipts: Array.from({ length: 50 }, (_, index) =>
      humanReceipt({
        recipientUserId: `member-${index}`,
        displayName: `Member ${index}`,
        seenAt: "2026-08-28T14:55:00.000Z",
      })
    ),
    broadcastRoster: {
      members: { total: 100, seen: 60, returned: 50, limit: 50, truncated: true },
      agents: {
        total: 0,
        seen: 0,
        returned: 0,
        limit: 50,
        truncated: false,
        trackingState: "not_tracked",
        principals: [],
      },
    },
  };
  const roster = browserBroadcastRosterView(result);
  assert.equal(
    browserDeliveryIndicator(result, NOW).label,
    "Seen by 60 of 100 members · 0 of 0 agents",
  );
  assert.equal(roster.seenMembers.length, 50);
  assert.equal(roster.notSeenMembers.length, 0);
  assert.deepEqual(
    [
      roster.seenHidden,
      roster.notSeenHidden,
      roster.seenAgentsHidden,
      roster.notSeenAgentsHidden,
    ],
    [10, 40, 0, 0],
  );

  const notSeenLines = browserRosterSectionLines(
    roster.notSeenMembers.map((row) => row.displayName ?? row.recipientUserId),
    roster.notSeenHidden,
  );
  assert.deepEqual(notSeenLines, ["40 not shown (roster cut)"]);
  assert.ok(!notSeenLines.includes("None"), "a cut not-seen section must not read None");

  const seenLines = browserRosterSectionLines(
    roster.seenMembers.map((row) => row.displayName ?? row.recipientUserId),
    roster.seenHidden,
  );
  assert.equal(seenLines.length, 51);
  assert.equal(seenLines.at(-1), "10 more not shown (roster cut)");

  // Controls: "None" still appears when the totals say a section is empty, and
  // an uncut section renders its rows unchanged.
  assert.deepEqual(browserRosterSectionLines([], 0), ["None"]);
  assert.deepEqual(
    browserRosterSectionLines(
      roster.notSeenAgents.map((row) => row.displayName),
      roster.notSeenAgentsHidden,
    ),
    ["None"],
  );
  assert.deepEqual(browserRosterSectionLines(["Ari", "Bo"], 0), ["Ari", "Bo"]);

  const renderer = dashboard.slice(
    dashboard.indexOf("const appendDeliveryReceipt ="),
    dashboard.indexOf("const feedScroller ="),
  );
  assert.match(renderer, /browserRosterSectionLines\(rows, hidden\)/);
  assert.doesNotMatch(
    renderer,
    /textContent = "None"/,
    "the dashboard must not decide None on its own; the shared rule owns it",
  );
  assert.equal(
    renderer.match(/appendRosterSection\([\s\S]*?roster\.(?:seenHidden|notSeenHidden|seenAgentsHidden|notSeenAgentsHidden),\s*\)/g)?.length,
    4,
    "every roster section must pass its hidden remainder",
  );
});

test("agent, member, and broadcast rows use the same bounded receipt path", () => {
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
  assert.deepEqual(selected.map((row) => row.id), [
    "agent-to-agent",
    "viewer-to-agent",
    "broadcast",
    "person-directed",
  ]);

  const renderer = dashboard.slice(
    dashboard.indexOf("const appendDeliveryReceipt ="),
    dashboard.indexOf("const feedScroller ="),
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

test("a direct person target stays Sent until the server returns focused-viewport seen", () => {
  const unseen = browserHumanDeliveryIndicator("person", addressed(humanReceipt()));
  const seen = browserHumanDeliveryIndicator("person", addressed(humanReceipt({
    seenAt: "2026-08-28T14:59:30.000Z",
  })));
  assert.deepEqual(
    { state: unseen.state, label: unseen.label, detail: unseen.detail },
    {
      state: "sent",
      label: "Sent",
      detail: "Delivered to the workspace — not seen yet.",
    },
  );
  assert.equal(seen.state, "seen");
  assert.equal(seen.label, "Seen");
  assert.match(seen.detail, /row was in view and the document had focus/);
  assert.doesNotMatch(`${unseen.label} ${unseen.detail}`, /Receipt unavailable/);

  const renderer = dashboard.slice(
    dashboard.indexOf("const appendDeliveryReceipt ="),
    dashboard.indexOf("const feedScroller ="),
  );
  assert.match(renderer, /signal\.to !== null && signal\.toAgent === null/);
  assert.match(renderer, /browserHumanDeliveryIndicator\(signal\.to, cached\?\.result \?\? null\)/);
  assert.doesNotMatch(
    renderer.slice(
      renderer.indexOf("signal.to !== null && signal.toAgent === null"),
      renderer.indexOf(": browserDeliveryIndicator"),
    ),
    /Receipt unavailable|No recipient|broadcast/i,
  );
});

test("rendered receipt has an accessible name and does not rely on colour", () => {
  const renderer = dashboard.slice(
    dashboard.indexOf("const appendDeliveryReceipt ="),
    dashboard.indexOf("const feedScroller ="),
  );
  assert.match(renderer, /details\.dataset\.receiptState = indicator\.state/);
  assert.match(renderer, /summary\.setAttribute\(\s*"aria-label"/);
  assert.match(renderer, /glyph\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(renderer, /label\.textContent = indicator\.label/);
  assert.match(renderer, /detail\.textContent = indicator\.detail/);
  assert.match(dashboard, /data-receipt-state="seen"/);
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
