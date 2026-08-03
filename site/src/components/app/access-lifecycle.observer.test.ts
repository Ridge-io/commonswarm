import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PendingRefreshGate } from "../../lib/pending-refresh";
import { isInviteSubmitCurrent } from "../../lib/invite-submit";
import {
  pendingAccessRows,
  shouldPollPendingAccess,
  shouldRetireFreshInvite,
} from "../../lib/pending-access";
import type {
  AgentAccessStatus,
  PendingMemberInvite,
} from "../../lib/commonswarm";

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

/*
 * Heading hierarchy inside the card: the dashboard's channel title is the H1, so
 * every AgentConnect state must expose exactly one visible H2 — never an H3 skip
 * (the audit found H1-workspace -> H3-result), never the stale "Name your agent."
 * above post-submit progress, never a heading-less state. These anchors pin the
 * markup levels and the CSS that retires the head; the live a11y-tree check is
 * separate evidence, not something a regex can claim.
 */
test("every AgentConnect state exposes a correct h2 with no stale or skipped headings", () => {
  assert.match(connect, /<h2 class="ac__title">Name your agent\.<\/h2>/);
  assert.match(connect, /<h2 class="ac__state-title"/);
  assert.match(connect, /<h2 class="ac__result-title">Your agent prompt is ready\.<\/h2>/);
  assert.match(
    connect,
    /<h2 class="ac__working-title">Creating your agent prompt\.<\/h2>/,
    "the working state names itself instead of wearing the form's question",
  );
  assert.match(connect, /<h2 class="ac__muted ac__loading-title">/);
  assert.doesNotMatch(connect, /<h3/, "no h3 skip remains anywhere in the card");
  assert.match(
    connect,
    /\.ac\[data-state="done"\] \.ac__head,[\s\S]*\.ac\[data-state="blocked"\] \.ac__head,[\s\S]*\.ac\[data-state="working"\] \.ac__head,[\s\S]*\.ac\[data-state="loading"\] \.ac__head\s*\{[\s\S]*display: none/,
    "the head survives only in ready, where it is the live question",
  );
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

/*
 * CAUSAL, NOT SOURCE-MATCHED: these drive the same pendingAccessRows the dashboard
 * renders from. What is pinned: the filter (a used, revoked, or expired key is
 * history, not access), the order (invites before agent keys), the identity line
 * (model and owner), and the ids the cancel commands need.
 */
test("pendingAccessRows filters, orders, and carries cancel identity", () => {
  const now = Date.parse("2026-07-31T12:00:00Z");
  const relative = (iso: string) => `in ${iso.slice(11, 16)}`;
  const ownerName = (userId: string) => (userId === "u-owner" ? "Ridgeio" : "Teammate");
  const invites: PendingMemberInvite[] = [
    {
      workspaceId: "w-1",
      invitationId: "inv-1",
      email: "calvin@example.com",
      createdBy: "u-owner",
      createdAt: "2026-07-31T10:00:00Z",
      expiresAt: "2026-08-07T10:00:00Z",
    },
  ];
  const access: AgentAccessStatus[] = [
    {
      workspaceId: "w-1",
      principalId: "p-1",
      ownerUserId: "u-owner",
      agentName: "Wren-LaneQ-Agent",
      model: "grok-4",
      tokenId: "tok-1",
      issuedAt: "2026-07-31T11:00:00Z",
      expiresAt: "2026-07-31T16:00:00Z",
      firstUsedAt: null,
      revokedAt: null,
    },
    {
      workspaceId: "w-1",
      principalId: "p-2",
      ownerUserId: "u-owner",
      agentName: "Consumed-Agent",
      model: null,
      tokenId: "tok-2",
      issuedAt: "2026-07-31T11:00:00Z",
      expiresAt: "2026-07-31T16:00:00Z",
      firstUsedAt: "2026-07-31T11:30:00Z", // consumed: must not appear
      revokedAt: null,
    },
    {
      workspaceId: "w-1",
      principalId: "p-3",
      ownerUserId: "u-owner",
      agentName: "Expired-Agent",
      model: null,
      tokenId: "tok-3",
      issuedAt: "2026-07-30T11:00:00Z",
      expiresAt: "2026-07-31T08:00:00Z", // expired before now: must not appear
      firstUsedAt: null,
      revokedAt: null,
    },
  ];

  const rows = pendingAccessRows(invites, access, ownerName, now, relative);
  assert.equal(rows.length, 2, "consumed and expired keys are history, not access");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.id]),
    [
      ["invite", "inv-1"],
      ["agent", "tok-1"],
    ],
    "invitations first, then unused keys, each with the id its cancel needs",
  );
  assert.equal(rows[0]!.title, "calvin@example.com");
  assert.match(rows[0]!.state, /Teammate invite · expires/);
  assert.equal(rows[0]!.cancelLabel, "Cancel invite for calvin@example.com");
  assert.equal(rows[1]!.title, "Wren-LaneQ-Agent");
  assert.equal(
    rows[1]!.state,
    "grok-4 · owned by Ridgeio · expires in 16:00",
    "model and owner stay explicit on the pending key",
  );
  assert.equal(rows[1]!.cancelLabel, "Cancel access for Wren-LaneQ-Agent");
});

test("a fresh invite retires only when its exact pending row disappears", () => {
  const invite: PendingMemberInvite = {
    workspaceId: "w-1",
    invitationId: "inv-fresh",
    email: "calvin@example.com",
    createdBy: "u-owner",
    createdAt: "2026-07-31T10:00:00Z",
    expiresAt: "2026-08-07T10:00:00Z",
  };
  const other = { ...invite, invitationId: "inv-other", email: "alex@example.com" };

  assert.equal(
    shouldRetireFreshInvite("inv-fresh", [invite, other]),
    false,
    "a still-pending link remains copyable",
  );
  assert.equal(
    shouldRetireFreshInvite("inv-fresh", [other]),
    true,
    "acceptance, cancellation, or expiry removes the exact row and retires its link",
  );
  assert.equal(
    shouldRetireFreshInvite("", []),
    false,
    "ordinary pending refreshes cannot invent a completion when no fresh link exists",
  );
});

test("the invite result clears a dead credential without stealing focus", () => {
  assert.match(dashboard, /freshInviteId = created\.invitationId/);
  assert.match(dashboard, /freshInviteWorkspaceId = created\.workspaceId/);
  const retire = dashboard.slice(
    dashboard.indexOf("const retireFreshInviteResult ="),
    dashboard.indexOf("const openInvite ="),
  );
  assert.match(retire, /freshInviteLink = ""/);
  assert.match(retire, /freshInviteId = ""/);
  assert.match(retire, /freshInviteWorkspaceId = ""/);
  assert.match(retire, /receipt\.textContent = "This invite is no longer pending\."/);
  assert.match(retire, /copy\.textContent = "Back to channel"/);
  assert.match(retire, /copy\.dataset\.inviteComplete = "true"/);
  assert.match(
    retire,
    /link\.hidden = document\.activeElement !== link/,
    "a focused link node remains present after its secret text is replaced",
  );
  assert.doesNotMatch(retire, /\.focus\(/, "a remote lifecycle event never moves focus");
  assert.match(
    dashboard,
    /button\.dataset\.inviteComplete === "true"[\s\S]*resetFreshInviteResult\(\);[\s\S]*returnToChannel\(\)/,
    "the transformed primary action returns to the live channel",
  );
});

test("invite submit owner rejects A's credential after an A-to-B switch", () => {
  const owner = { workspaceId: "A", version: 7 };
  let activeWorkspaceId = "A";
  let requestVersion = 7;
  let visibleCredential = "";
  const settleCreate = (credential: string): void => {
    if (!isInviteSubmitCurrent(owner, activeWorkspaceId, requestVersion)) return;
    visibleCredential = credential;
  };

  activeWorkspaceId = "B";
  requestVersion = 8;
  settleCreate("one-use-A");
  assert.equal(visibleCredential, "", "A's token is discarded rather than rendered in B");
});

test("invite pending follow-up cannot assign A rows after B then C take ownership", () => {
  const owner = { workspaceId: "A", version: 11 };
  let activeWorkspaceId = "A";
  let requestVersion = 11;
  let visiblePending = ["C-existing"];
  assert.equal(
    isInviteSubmitCurrent(owner, activeWorkspaceId, requestVersion),
    true,
    "A owns the follow-up when it starts",
  );

  activeWorkspaceId = "B";
  requestVersion = 12;
  activeWorkspaceId = "C";
  requestVersion = 13;
  const applyPending = (rows: string[]): void => {
    if (!isInviteSubmitCurrent(owner, activeWorkspaceId, requestVersion)) return;
    visiblePending = rows;
  };
  applyPending(["A-invite"]);
  assert.deepEqual(
    visiblePending,
    ["C-existing"],
    "A's pending response cannot overwrite the state owned by C",
  );
});

test("invite submit checks ownership after both awaits and before shared writes", () => {
  const submitStart = dashboard.indexOf(
    'one<HTMLFormElement>("[data-invite-form]")?.addEventListener("submit"',
  );
  const submitEnd = dashboard.indexOf(
    'one<HTMLButtonElement>("[data-copy-invite]")?.addEventListener',
    submitStart,
  );
  assert.notEqual(submitStart, -1);
  assert.notEqual(submitEnd, -1);
  const submitHandler = dashboard.slice(
    submitStart,
    submitEnd,
  );
  assert.match(
    submitHandler,
    /const submitOwner = \{\s*workspaceId: activeWorkspaceId,\s*version: requestVersion,?\s*\}/,
    "the request captures exact workspace and generation before awaiting",
  );
  assert.match(
    submitHandler,
    /const created = await inviteWorkspaceMember\([\s\S]*?\);[\s\S]*?if \(!ownsInviteSubmit\(\)\) return;[\s\S]*?freshInviteLink = memberInviteUrl/,
    "create settlement is rejected before the credential reaches shared state or DOM",
  );
  assert.match(
    submitHandler,
    /const nextInvites = await pendingMemberInvites\(created\.workspaceId\);\s*if \(!ownsInviteSubmit\(\)\) return;\s*pendingInvites = nextInvites/,
    "the follow-up queries A explicitly and rejects staleness before assigning rows",
  );
  assert.match(
    submitHandler,
    /\} catch \(caught\) \{\s*if \(!ownsInviteSubmit\(\)\) return;/,
    "a stale rejection cannot write an error into the next workspace",
  );
  assert.match(
    submitHandler,
    /\} finally \{\s*if \(ownsInviteSubmit\(\)\) resetInviteSubmitControl\(\);/,
    "a stale completion cannot mutate the next workspace's submit control",
  );
  assert.match(
    submitHandler,
    /requestAnimationFrame\(\(\) => \{\s*if \(!ownsInviteSubmit\(\)\) return;/,
    "deferred focus rechecks ownership too",
  );
  const openWorkspace = dashboard.slice(
    dashboard.indexOf("const openWorkspace ="),
    dashboard.indexOf("const openAgentChoice ="),
  );
  assert.match(
    openWorkspace,
    /resetInviteSubmitControl\(\);[\s\S]*if \(changesWorkspace\) \{[\s\S]*resetFreshInviteResult\(\);[\s\S]*inviteIntent = null;[\s\S]*activeWorkspaceId = selected\.id/,
    "workspace switching resets the old form before the new workspace owns the DOM",
  );
});

/*
 * The empty-workspace stale-row bug: agents=[], view=no-agents, one pending invite.
 * The poll predicate takes no view input at all — that is the fix — so the
 * no-agents view cannot starve the cadence. This drives the real predicate and
 * the real gate through a simulated redemption: the row clears on its own, then
 * the timer remains cheap and discoverable at the slower idle cadence.
 */
test("no-agents pending poll clears a remote redemption without request storms", () => {
  // The predicate never sees the channel view — the no-agents case is covered
  // by construction, and the flag matrix proves the rest of the contract.
  assert.equal(
    shouldPollPendingAccess({
      sampleMode: false,
      activeWorkspaceId: "w-1",
      visible: true,
    }),
    true,
    "pending exists: poll runs regardless of which view is open",
  );
  for (const [args, expected] of [
    [{ sampleMode: true, activeWorkspaceId: "w-1", visible: true }, false],
    [{ sampleMode: false, activeWorkspaceId: "", visible: true }, false],
    [{ sampleMode: false, activeWorkspaceId: "w-1", visible: false }, false],
    [{ sampleMode: false, activeWorkspaceId: "w-1", visible: true }, true],
  ] as const) {
    assert.equal(shouldPollPendingAccess(args), expected, JSON.stringify(args));
  }

  // The redemption loop, driven with the real gate and the real row model.
  let remote: PendingMemberInvite[] = [
    {
      workspaceId: "w-1",
      invitationId: "inv-9",
      email: "calvin@example.com",
      createdBy: "u-owner",
      createdAt: "2026-07-31T10:00:00Z",
      expiresAt: "2026-08-07T10:00:00Z",
    },
  ];
  const gate = new PendingRefreshGate(12_000, 30_000);
  const fetches: number[] = [];
  let rows = pendingAccessRows(remote, [], () => "Ridgeio", 0, () => "in 7 days");
  for (let tick = 0; tick <= 24_000; tick += 4_000) {
    // The dashboard arms the interval from this predicate; when it flips false
    // the timer is cleared and the loop below cannot run again.
    const armed = shouldPollPendingAccess({
      sampleMode: false,
      activeWorkspaceId: "w-1",
      visible: true,
    });
    if (!armed) break;
    if (!gate.tryAcquire("w-1", 1, tick, rows.length > 0)) continue;
    fetches.push(tick);
    remote = tick >= 12_000 ? [] : remote; // the teammate redeems between fetches
    rows = pendingAccessRows(remote, [], () => "Ridgeio", 0, () => "in 7 days");
    gate.release("w-1", 1);
  }
  assert.equal(rows.length, 0, "the pending row cleared without a workspace reopen");
  assert.deepEqual(fetches, [0, 12_000], "fetches happen on the gate cooldown");
  assert.equal(
    shouldPollPendingAccess({
      sampleMode: false,
      activeWorkspaceId: "w-1",
      visible: true,
    }),
    true,
    "local zero keeps the workspace discoverable",
  );
});

test("idle discovery finds remote zero-to-one access on a bounded cadence", () => {
  const gate = new PendingRefreshGate(12_000, 30_000);
  const fetches: number[] = [];
  let remote: PendingMemberInvite[] = [];
  let local: PendingMemberInvite[] = [];

  for (let tick = 0; tick <= 40_000; tick += 4_000) {
    if (tick === 8_000) {
      remote = [{
        workspaceId: "w-1",
        invitationId: "inv-remote",
        email: "remote@example.com",
        createdBy: "u-admin",
        createdAt: "2026-07-31T10:00:00Z",
        expiresAt: "2026-08-07T10:00:00Z",
      }];
    }
    const hasPending = pendingAccessRows(local, [], () => "Owner", 0, () => "later").length > 0;
    if (!gate.tryAcquire("w-1", 1, tick, hasPending)) continue;
    fetches.push(tick);
    local = remote;
    gate.release("w-1", 1);
  }

  assert.deepEqual(fetches, [0, 32_000], "idle requests stay at least 30 seconds apart");
  assert.equal(local[0]?.invitationId, "inv-remote", "remote first access is discovered");
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
 * the row without a full workspace reopen, so the dedicated access cadence runs in
 * every channel view and slows down — but stays discoverable — when local state is
 * empty. Feed ticks may offer catch-up without owning that cadence.
 *
 * CAUSAL, NOT SOURCE-MATCHED: the race tests below import and drive the same
 * PendingRefreshGate class the dashboard constructs. The race being pinned: a slow
 * refresh for workspace A is in flight when the user switches to workspace B — B's
 * refresh must start immediately, A's late completion must not free B's ownership,
 * and nothing A carries may be applied over B's state. The regexes at the end only
 * pin that the dashboard is wired to this class; they make no causal claim.
 */
test("pending-refresh gate: a slow old-workspace request cannot block or clear the new one", () => {
  const gate = new PendingRefreshGate(12_000, 30_000);
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
  const gate = new PendingRefreshGate(12_000, 30_000);
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

test("pending-refresh gate: discovery, duplicate, and cooldown suppression", () => {
  const gate = new PendingRefreshGate(12_000, 30_000);
  const t0 = 300_000;
  assert.equal(gate.tryAcquire("A", 1, t0, false), true, "local zero starts discovery");
  assert.equal(
    gate.tryAcquire("A", 1, t0 + 1, false),
    false,
    "the same refresh does not duplicate while in flight",
  );
  gate.release("A", 1);
  assert.equal(
    gate.tryAcquire("A", 1, t0 + 12_001, false),
    false,
    "idle discovery remains on the slower cooldown",
  );
  assert.equal(
    gate.tryAcquire("A", 1, t0 + 30_001, false),
    true,
    "the discovery cooldown passing re-arms the refresh",
  );
  gate.release("A", 1);
  assert.equal(
    gate.tryAcquire("A", 1, t0 + 42_002, true),
    true,
    "known pending access returns to the faster active cooldown",
  );
});

test("the dashboard is wired to the gate with the apply guard intact", () => {
  assert.match(
    dashboard,
    /import \{ PendingRefreshGate \} from "\.\.\/\.\.\/lib\/pending-refresh"/,
  );
  assert.match(
    dashboard,
    /new PendingRefreshGate\(\s*PENDING_REFRESH_ACTIVE_COOLDOWN_MS,\s*PENDING_REFRESH_DISCOVERY_COOLDOWN_MS,?\s*\)/,
    "the dashboard drives the same class the race tests drive",
  );
  const refresh = dashboard.slice(
    dashboard.indexOf("const refreshPendingAccess = async"),
    dashboard.indexOf('document.addEventListener("visibilitychange"'),
  );
  assert.match(
    refresh,
    /pendingRefreshGate\.tryAcquire\(\s*workspaceId,\s*version,\s*Date\.now\(\),\s*hasPendingAccess\(\),?\s*\)/,
    "acquisition carries the workspace, generation, and cadence state",
  );
  assert.match(
    refresh,
    /if \(version !== requestVersion \|\| workspaceId !== activeWorkspaceId\) return;[\s\S]*pendingInvites = nextInvites/,
    "a stale completion applies nothing — the guard runs before any assignment",
  );
  assert.match(
    refresh,
    /memberRoster\(workspaceId\)\.catch\(\(\) => null\)[\s\S]*people = nextRoster\.names;[\s\S]*members = nextRoster\.members;[\s\S]*renderMembers\(\);[\s\S]*renderRoster\(\);/,
    "the guarded catch-up makes a remotely accepted teammate visible without reopening",
  );
  assert.match(
    refresh,
    /shouldRetireFreshInvite\(freshInviteId, nextInvites\)[\s\S]*retireFreshInviteResult\(\)/,
    "the exact fresh invitation disappearing clears its one-use result",
  );
  assert.match(
    refresh,
    /\} finally \{[\s\S]*pendingRefreshGate\.release\(workspaceId, version\)/,
    "ownership is always released, and only by its holder",
  );
  assert.match(
    dashboard,
    /void refreshPendingAccess\(workspaceId, version\)/,
    "healthy signal ticks may offer a catch-up through the same bounded gate",
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

test("the Agents dialog carries a mobile-presented Pending access section fed by one renderer", () => {
  /* The section's hooks, its h3 under the dialog's h2, and a unique labelledby. */
  assert.match(dashboard, /data-dialog-access-section/);
  assert.match(dashboard, /data-dialog-access-list/);
  assert.match(dashboard, /data-dialog-access-count/);
  assert.match(dashboard, /data-dialog-access-error/);
  assert.match(
    dashboard,
    /<h3[\s\S]*id="dashboard-roster-pending-title"[\s\S]*Pending access/,
  );
  assert.equal(
    dashboard.match(/dashboard-roster-pending-title/g)?.length,
    2,
    "the id appears once as id and once as aria-labelledby — never duplicated",
  );

  /* ONE row-model call feeds BOTH lists; mirrors of one state, never two states. */
  const render = dashboard.slice(
    dashboard.indexOf("const renderPendingAccess ="),
    dashboard.indexOf("const signalPage ="),
  );
  const rowModel = dashboard.slice(
    dashboard.indexOf("const currentPendingAccessRows ="),
    dashboard.indexOf("const renderPendingAccess ="),
  );
  assert.match(rowModel, /pendingAccessRows\(\s*pendingInvites,\s*accessStatuses,/);
  assert.match(render, /const rows = currentPendingAccessRows\(\)/);
  assert.equal(
    rowModel.match(/pendingAccessRows\(/g)?.length,
    1,
    "one row-model call feeds both lists",
  );
  assert.match(render, /railList\?\.replaceChildren\(buildRows/);
  assert.match(render, /dialogList\?\.replaceChildren\(buildRows/);
  assert.match(
    render,
    /row\.kind === "invite"[\s\S]*revokeWorkspaceInvitation\(session, uuid\(\), row\.workspaceId, row\.id\)[\s\S]*revokeAgentToken\(session, uuid\(\), row\.workspaceId, row\.id\)/,
    "each row's Cancel reaches the right revoke with that row's own id",
  );
  assert.match(render, /button\.dataset\.pendingKind = row\.kind/);
  assert.match(render, /button\.dataset\.pendingId = row\.id/);
  assert.match(
    render,
    /candidate\.dataset\.pendingKind === focusedPending\.kind[\s\S]*candidate\.dataset\.pendingId === focusedPending\.id/,
    "an unchanged refresh restores the exact focused pending action",
  );
  assert.match(
    render,
    /data-add-agent-dialog[\s\S]*focus\(\{ preventScroll: true \}\)/,
    "a consumed focused row moves focus to a stable control inside the dialog",
  );
  assert.match(render, /dashboard__pending-access-row/);
  assert.match(
    render,
    /renderHeaderRoster\(total\);[\s\S]*syncPendingPoll\(\);/,
    "first creation, remote redemption, and final cancel all resync the mobile door",
  );
  assert.match(
    render,
    /else if \(total > 0\)[\s\S]*data-access-details[\s\S]*else \{[\s\S]*data-channel-name[\s\S]*focus/,
    "the final desktop pending row never hands focus to a newly hidden summary",
  );
  assert.match(dashboard, /data-channel-name tabindex="-1"/);
  assert.match(
    dashboard,
    /\.dashboard__pending-access-row\s*>\s*\.dashboard__text-button\s*\{[\s\S]*white-space:\s*nowrap/,
    "the pending-row action keeps Cancel horizontal at rail and phone widths",
  );
  /* Mobile presentation: the section displays only at ≤52rem; desktop keeps the rail. */
  assert.match(
    dashboard,
    /@media \(max-width: 52rem\)[\s\S]*\.dashboard__roster-dialog-pending\s*\{[\s\S]*display: grid/,
  );
  assert.match(
    dashboard,
    /\.dashboard__roster-dialog-pending\s*\{\s*display: none;/,
    "hidden at desktop — no duplicate, competing control",
  );

  /* The view- and row-agnostic timer: armed from the predicate after every render,
     cleared on hide and sign-out, and network work remains gate-bounded. */
  assert.match(
    dashboard,
    /shouldPollPendingAccess\(\{\s*sampleMode,\s*activeWorkspaceId,\s*visible: document\.visibilityState === "visible",?\s*\}\)/,
  );
  assert.match(dashboard, /syncPendingPoll\(\);[\s\S]*showAuthView\("choices"\)/);
  const visibility = dashboard.slice(
    dashboard.indexOf('document.addEventListener("visibilitychange"'),
    dashboard.indexOf("const renderChannel ="),
  );
  assert.match(visibility, /syncPendingPoll\(\)/);
  const pendingPoll = dashboard.slice(
    dashboard.indexOf("const syncPendingPoll ="),
    dashboard.indexOf("armLiveFeed =", dashboard.indexOf("const syncPendingPoll =")),
  );
  assert.match(
    pendingPoll,
    /if \(pendingAccessKey\(\) !== renderedPendingAccessKey\) renderPendingAccess\(\);[\s\S]*void refreshPendingAccess\(activeWorkspaceId, requestVersion\)/,
    "local expiry re-renders while zero-state discovery continues through the gate",
  );
  const openWorkspace = dashboard.slice(
    dashboard.indexOf("const openWorkspace ="),
    dashboard.indexOf("const openAgentChoice =", dashboard.indexOf("const openWorkspace =")),
  );
  assert.match(
    openWorkspace,
    /stopPendingPoll\(\);[\s\S]*activeWorkspaceId = selected\.id;[\s\S]*renderedPendingAccessKey = "";[\s\S]{0,220}syncPendingPoll\(\);/,
    "a workspace switch restarts one timer under the new guarded identity",
  );
  assert.match(
    dashboard,
    /const resetWorkspaceSessionState =[\s\S]*pendingInvites = \[\];[\s\S]*accessStatuses = \[\];[\s\S]*syncPendingPoll\(\);/,
    "auth transitions centralize workspace state and pending-timer cleanup",
  );
  const authReset = dashboard.slice(
    dashboard.indexOf("const resetWorkspaceSessionState ="),
    dashboard.indexOf("armLiveFeed =", dashboard.indexOf("const resetWorkspaceSessionState =")),
  );
  assert.match(authReset, /renderMembers\(\);\s*renderRoster\(\);/);
  assert.match(
    authReset,
    /\[data-workspace-list\], \[data-access-list\], \[data-dialog-access-list\], \[data-feed-list\]/,
    "an auth boundary removes prior workspace names, invite emails, and signal bodies from DOM",
  );
  assert.match(authReset, /list\.replaceChildren\(\)/);
  assert.match(authReset, /\[data-channel-name\], \[data-channel-id\], \[data-invite-link\]/);
  assert.match(authReset, /agent-connect[\s\S]*clearPrompt\(false\)/);
  const authReload = dashboard.slice(
    dashboard.indexOf("const queueAuthReload ="),
    dashboard.indexOf("client()?.auth.onAuthStateChange"),
  );
  assert.match(authReload, /resetWorkspaceSessionState\(\)/);
});

test("existing-agent help distinguishes the shown-once key from the renewed connection", () => {
  assert.match(
    connect,
    /The key\s+is shown once\. While cswarm keeps running, it renews access automatically for up\s+to 30 days, unless access is revoked\./,
  );
  assert.doesNotMatch(
    connect,
    /lasts a few hours|renews it for you/,
    "retired copy either misstated the horizon or overpromised renewal",
  );
});
