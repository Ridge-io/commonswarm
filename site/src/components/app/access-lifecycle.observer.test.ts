import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PendingRefreshGate } from "../../lib/pending-refresh";

const dashboard = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const connect = await readFile(
  new URL("../connect/AgentConnect.astro", import.meta.url),
  "utf8",
);
const agentConnect = await readFile(
  new URL("../../lib/agent-connect.ts", import.meta.url),
  "utf8",
);

test("Add an agent asks who controls it before minting", () => {
  assert.match(dashboard, /Who runs this agent\?/);
  assert.match(dashboard, /data-agent-owner-self/);
  assert.match(dashboard, /data-agent-owner-teammate/);
  assert.match(dashboard, /data-add-agent\]"\)\?\.addEventListener\("click", openAgentChoice\)/);
  assert.match(dashboard, /inviteWorkspaceMember/);
  assert.match(dashboard, /memberInviteUrl/);
});

test("Done, Back, and first use converge on a channel return", () => {
  assert.match(connect, /commonswarm:agent-prompt-ready/);
  assert.doesNotMatch(connect, /commonswarm:agent-connected/);
  assert.match(connect, /data-action="done"[\s\S]*Done/);
  assert.doesNotMatch(connect, /Clear this prompt/);
  assert.match(connect, /finishPrompt\("done"\)/);
  assert.match(connect, /status\?\.firstUsedAt[\s\S]*this\.finishPrompt\("consumed"\)/);
  assert.match(dashboard, /connect\.finishPrompt\("back"\)/);
  assert.match(
    dashboard,
    /explicit exit from an add-agent view[\s\S]*showChannelView\("feed"\);\s*renderFeed\(\)/,
  );
  assert.match(
    dashboard,
    /commonswarm:agent-secret-cleared[\s\S]*returnToChannel\(\)/,
  );
});

test("browser mint uses the server's atomic renewal grant without an obsolete request", () => {
  assert.doesNotMatch(agentConnect, /kind:\s*"create_renewal_grant"/);
  assert.match(agentConnect, /const renews = mintedRunId === runId && times\.expiresAt !== null/);
  assert.match(agentConnect, /times\.issuedAt \+ RENEWAL_HORIZON_DEFAULT_MS/);
});

test("workspace access shows pending rows and explicit agent identity", () => {
  assert.match(dashboard, /Pending access/);
  assert.match(dashboard, /pendingMemberInvites/);
  assert.match(dashboard, /agentAccessStatuses/);
  assert.match(dashboard, /revokeWorkspaceInvitation/);
  assert.match(dashboard, /revokeAgentToken/);
  assert.match(dashboard, /Model not specified/);
  assert.match(dashboard, /owned by/);
  assert.match(dashboard, /markAgentAvatar/);
  assert.match(dashboard, /--avatar-hue/);
});

test("visible channels poll for fresh signals and preserve readable state on failure", () => {
  assert.match(dashboard, /setInterval\(\(\) => void refreshLatestSignals\(\), 2_000\)/);
  assert.match(dashboard, /document\.visibilityState !== "visible"/);
  assert.match(dashboard, /document\.addEventListener\("visibilitychange"/);
  assert.match(dashboard, /const next = \[\.\.\.page\.rows, \.\.\.signals\.filter/);
  assert.match(
    dashboard,
    /A live refresh never replaces a readable channel with an error/,
  );
});

/*
 * Pending access is a waiting room: the inviter watches it until the teammate redeems
 * or the agent first connects. Consumption that happens in ANOTHER session must clear
 * the row without a full workspace reopen, so the refresh rides the existing signal
 * poll at a slower cooldown, only while something is pending, and never disturbs the
 * feed or the dialog.
 *
 * CAUSAL, NOT SOURCE-MATCHED: the race tests below import and drive the same
 * PendingRefreshGate class the dashboard constructs. The race being pinned: a slow
 * refresh for workspace A is in flight when the user switches to workspace B — B's
 * refresh must start immediately, A's late completion must not free B's ownership,
 * and nothing A carries may be applied over B's state. The regexes at the end only
 * pin that the dashboard is wired to this class; they make no causal claim.
 */
test("pending-refresh gate: a slow old-workspace request cannot block or clear the new one", () => {
  const gate = new PendingRefreshGate(12_000);
  const t0 = 100_000;
  assert.equal(gate.tryAcquire("A", 1, t0, true), true, "A owns its refresh");
  // The user switches workspaces mid-flight; openWorkspace resets the cooldown.
  gate.resetCooldown();
  assert.equal(
    gate.tryAcquire("B", 2, t0 + 50, true),
    true,
    "B refreshes immediately — it never waits behind A's slow request",
  );
  gate.release("A", 1);
  assert.equal(
    gate.tryAcquire("B", 2, t0 + 100, true),
    false,
    "A's late completion did not free the gate: B's refresh is still owned",
  );
  gate.release("B", 2);
  assert.equal(
    gate.tryAcquire("B", 2, t0 + 12_101, true),
    true,
    "once B finishes and the cooldown passes, B can refresh again",
  );
});

test("pending-refresh gate: generations of one workspace stay ordered", () => {
  const gate = new PendingRefreshGate(12_000);
  const t0 = 200_000;
  assert.equal(gate.tryAcquire("A", 1, t0, true), true);
  // Same workspace, newer generation (reopened): the new generation takes the gate.
  gate.resetCooldown();
  assert.equal(gate.tryAcquire("A", 2, t0 + 50, true), true);
  gate.release("A", 1);
  assert.equal(
    gate.tryAcquire("A", 2, t0 + 100, true),
    false,
    "the older generation's completion cannot free the newer generation's slot",
  );
});

test("pending-refresh gate: no-pending, duplicate, and cooldown suppression", () => {
  const gate = new PendingRefreshGate(12_000);
  const t0 = 300_000;
  assert.equal(gate.tryAcquire("A", 1, t0, false), false, "nothing pending: no fetch");
  assert.equal(gate.tryAcquire("A", 1, t0, true), true);
  assert.equal(
    gate.tryAcquire("A", 1, t0 + 1, true),
    false,
    "the same refresh does not duplicate while in flight",
  );
  gate.release("A", 1);
  assert.equal(
    gate.tryAcquire("A", 1, t0 + 6_000, true),
    false,
    "released but inside the cooldown: no refetch",
  );
  assert.equal(
    gate.tryAcquire("A", 1, t0 + 12_001, true),
    true,
    "the cooldown passing re-arms the refresh",
  );
});

test("the dashboard is wired to the gate with the apply guard intact", () => {
  assert.match(
    dashboard,
    /import \{ PendingRefreshGate \} from "\.\.\/\.\.\/lib\/pending-refresh"/,
  );
  assert.match(
    dashboard,
    /new PendingRefreshGate\(PENDING_REFRESH_COOLDOWN_MS\)/,
    "the dashboard drives the same class the race tests drive",
  );
  const refresh = dashboard.slice(
    dashboard.indexOf("const refreshPendingAccess = async"),
    dashboard.indexOf('document.addEventListener("visibilitychange"'),
  );
  assert.match(
    refresh,
    /pendingRefreshGate\.tryAcquire\(\s*workspaceId,\s*version,\s*Date\.now\(\),\s*hasPendingAccess\(\),?\s*\)/,
    "acquisition carries the (workspace, generation) identity and the pending check",
  );
  assert.match(
    refresh,
    /if \(version !== requestVersion \|\| workspaceId !== activeWorkspaceId\) return;[\s\S]*pendingInvites = nextInvites/,
    "a stale completion applies nothing — the guard runs before any assignment",
  );
  assert.match(
    refresh,
    /\} finally \{[\s\S]*pendingRefreshGate\.release\(workspaceId, version\)/,
    "ownership is always released, and only by its holder",
  );
  assert.match(
    dashboard,
    /void refreshPendingAccess\(workspaceId, version\)/,
    "the refresh still rides the healthy signal poll",
  );
  const openWorkspace = dashboard.slice(
    dashboard.indexOf("const openWorkspace ="),
    dashboard.indexOf("const openAgentChoice ="),
  );
  assert.match(
    openWorkspace,
    /pendingRefreshGate\.resetCooldown\(\)/,
    "a workspace switch re-arms the refresh for the fresh workspace",
  );
  assert.doesNotMatch(
    dashboard,
    /pendingRefreshInFlight|pendingRefreshAttemptedAt/,
    "the boolean flag pair is gone — ownership is the gate's",
  );
});

/*
 * The header's Live chip is the consumer-readable promise that the channel updates
 * itself. It must be true exactly while the poll can be armed: feed views only,
 * never sample mode, and it starts hidden in the static markup.
 */
test("the Live chip shows only while the feed poll can be armed", () => {
  assert.match(dashboard, /data-live-chip hidden/);
  const toggle = dashboard.slice(
    dashboard.indexOf("const showChannelView ="),
    dashboard.indexOf("const addAgentViewOpen ="),
  );
  assert.match(toggle, /one<HTMLElement>\("\[data-live-chip\]"\)/);
  assert.match(
    toggle,
    /liveChip\.hidden = sampleMode \|\| \!\(name === "feed" \|\| name === "feed-empty"\)/,
    "hidden in sample mode and in every non-feed view",
  );
  assert.match(
    dashboard,
    /\.dashboard__live\s*\{[\s\S]*var\(--success\)/,
    "the chip borrows the semantic success ink, not a new colour",
  );
});
