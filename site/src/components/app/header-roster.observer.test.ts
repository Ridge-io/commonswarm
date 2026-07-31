import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/*
 * Observer for the workspace-header agent roster, dialog model. Source-anchored like the
 * other app observers: it reads LiveDashboard.astro and asserts the mechanisms, not a
 * render. Picked up by site `npm test` through the observer glob in site package.json.
 *
 * Governing ruling (Lead7, 2026-07-30): the agent roster moves OUT of the rail into a
 * Slack-style header stack button that opens an accessible dialog (responsive sheet at
 * mobile widths). The rail keeps workspace switching, account, and details only, and must
 * not grow with agent count.
 */
const dashboard = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");

test("the rail carries no agent roster: no list, no rail Add door, no collapse sync", () => {
  assert.doesNotMatch(
    dashboard,
    /data-agent-list/,
    "the rail's full agent list is superseded by the header dialog",
  );
  assert.doesNotMatch(dashboard, /data-add-agent-rail/);
  assert.doesNotMatch(dashboard, /rail-mobile-summary/);
  assert.doesNotMatch(
    dashboard,
    /narrowRail|syncAgentRail/,
    "nothing remains that needs collapsing on narrow screens",
  );
  assert.doesNotMatch(
    dashboard,
    /Workspace and agent navigation/,
    "the rail's accessible name went stale when agents moved to the header — it must not return",
  );
  assert.match(dashboard, /aria-label="Workspace navigation and details"/);
});

test("the header control is one stack button with a dialog relationship", () => {
  assert.match(dashboard, /data-header-roster/);
  assert.match(
    dashboard,
    /data-roster-open[^>]*aria-haspopup="dialog"/,
    "the single header control announces that it opens a dialog",
  );
  assert.match(dashboard, /aria-expanded/);
  assert.match(dashboard, /id="dashboard-roster-dialog"/);
  assert.match(
    dashboard,
    /data-roster-open[^>]*aria-controls="dashboard-roster-dialog"/,
    "aria-controls ties the button to the dialog it opens",
  );
  assert.match(dashboard, /data-header-agent-stack/);
  assert.match(dashboard, /data-header-roster-summary/);
  assert.match(
    dashboard,
    /view and manage agents/,
    "the accessible name says what the button shows and what it does",
  );
  assert.match(
    dashboard,
    /\.dashboard__roster-stack[\s\S]*margin-inline-start:\s*-0\.5rem/,
    "the stack overlaps its uniform circular initials",
  );
});

test("pending access keeps the header management door reachable before the first agent", () => {
  const header = dashboard.slice(
    dashboard.indexOf("const renderHeaderRoster ="),
    dashboard.indexOf("const renderDialogRoster ="),
  );
  assert.match(
    header,
    /const show = agents\.length > 0 \|\| pendingTotal > 0;/,
    "a zero-agent workspace with a pending invite still exposes the only mobile door",
  );
  assert.match(header, /pendingTotal[^\n]*pending/);
  assert.match(header, /pending access/);

  const pending = dashboard.slice(
    dashboard.indexOf("const renderPendingAccess ="),
    dashboard.indexOf("const signalPage ="),
  );
  assert.match(
    pending,
    /renderHeaderRoster\(total\);/,
    "every pending-state transition shows or hides the door without a workspace reopen",
  );
});

test("agent avatars keep one shape and one tint mechanism", () => {
  assert.doesNotMatch(
    dashboard,
    /avatarShape|data-avatar-shape/,
    "mixed border-radii on identical initial tiles read as inconsistency, not identity",
  );
  assert.match(dashboard, /dashboard__avatar--tinted/);
  assert.match(dashboard, /--avatar-hue/);
});

test("management lives in a dialog whose first primary action is Add an agent", () => {
  assert.match(dashboard, /<dialog/);
  assert.match(dashboard, /data-roster-dialog/);
  const open = dashboard.indexOf("data-roster-dialog");
  const add = dashboard.indexOf("data-add-agent-dialog");
  const search = dashboard.indexOf("data-roster-search");
  const list = dashboard.indexOf("data-dialog-agent-list");
  assert.ok(open >= 0 && add > open, "the Add door is inside the dialog");
  assert.ok(add < search && search < list, "Add an agent is the first action, then filter, then roster");
  assert.match(
    dashboard,
    /add\.hidden = sampleMode/,
    "sample mode never shows an Add door that cannot mint",
  );
  assert.match(dashboard, /rosterFilter/);
  assert.match(dashboard, /dataset\.removeAgent/);
  assert.match(dashboard, /data-agent-error/);
});

test("the dialog is modal with Escape, backdrop, close, and focus handling", () => {
  assert.match(dashboard, /dialog\.showModal\(\)/);
  assert.match(
    dashboard,
    /event\.target === dialog[\s\S]*dialog\.close\(\)/,
    "backdrop clicks close the dialog",
  );
  assert.match(
    dashboard,
    /dialog\?\.addEventListener\("close"/,
    "every close path (Escape included, via the native cancel) re-syncs aria-expanded",
  );
  assert.match(
    dashboard,
    /one<HTMLButtonElement>\("\[data-roster-open\]"\)[\s\S]*?focus\(\{ preventScroll: true \}\)/,
    "after a removal reload, focus lands back on the stack button that opened the flow",
  );
});

test("the dialog cannot outlive its workspace or session", () => {
  const openWorkspace = dashboard.slice(
    dashboard.indexOf("const openWorkspace ="),
    dashboard.indexOf("const openAgentChoice ="),
  );
  assert.match(openWorkspace, /closeRosterDialog\(\)/);
  const signout = dashboard.slice(
    dashboard.indexOf('for (const button of all<HTMLButtonElement>("[data-signout]"))'),
    dashboard.indexOf(
      'one<HTMLButtonElement>("[data-add-agent]")?.addEventListener("click", openAgentChoice)',
    ),
  );
  assert.match(signout, /resetWorkspaceSessionState\(\)/);
  const reset = dashboard.slice(
    dashboard.indexOf("const resetWorkspaceSessionState ="),
    dashboard.indexOf("armLiveFeed =", dashboard.indexOf("const resetWorkspaceSessionState =")),
  );
  assert.match(reset, /closeRosterDialog\(\)/);
});

test("the dialog is a bottom sheet at mobile widths", () => {
  assert.match(
    dashboard,
    /@media \(max-width: 52rem\)[\s\S]*\.dashboard__roster-dialog\s*\{[\s\S]*margin-block-start:\s*auto/,
  );
  assert.match(
    dashboard,
    /\.dashboard__roster-dialog::backdrop/,
  );
});

test("the stack gets its own header row and the body floor gives it back at mobile widths", () => {
  assert.match(
    dashboard,
    /@media \(max-width: 52rem\)[\s\S]*\.dashboard__channel-roster\s*\{[\s\S]*flex:\s*1 1 100%/,
    "the roster row never depends on the workspace name's length",
  );
  assert.match(
    dashboard,
    /\.dashboard__channel--roster \.dashboard__channel-body\s*\{[\s\S]*min-block-size:\s*calc\(100svh - 5\.5rem - 4\.5rem - 3\.5rem\)/,
  );
});

test("unknown agent-authored signals trigger a bounded roster refresh", () => {
  assert.match(
    dashboard,
    /signal\.fromKind === "agent" &&\s*!knownAgents\.has\(signal\.from\)/,
    "a new agent's first signal is the join event the roster learns from",
  );
  assert.match(dashboard, /rosterRefreshInFlight/);
  assert.match(
    dashboard,
    /Date\.now\(\) - rosterRefreshAttemptedAt < 10_000/,
    "a failing roster refresh must not retry on every two-second poll",
  );
  assert.match(dashboard, /void refreshRosterForUnknownAgents/);
  assert.match(
    dashboard,
    /setInterval\(\(\) => void refreshLatestSignals\(\), 2_000\)/,
    "the two-second signal polling cadence is preserved",
  );
});

/*
 * Release blocker (Lead7, 2026-07-30): after a Remove, the revoked principal is absent
 * from roster() but its immutable recent signals stay in every latest feed page, so an
 * unaware catch-up refetches roster+member every cooldown forever. The catch-up must be
 * principal-aware: only a SUCCESSFUL fetch may settle a principal, only principals still
 * absent from that fetch settle, a failure settles and drains nothing, and a workspace
 * switch clears both sets.
 */
test("roster catch-up is principal-aware: settle confirmed-absent, retry failed, reset on switch", () => {
  assert.match(
    dashboard,
    /!settledUnknownAgents\.has\(signal\.from\)/,
    "a settled (confirmed revoked/historical) principal must not re-trigger",
  );
  assert.match(
    dashboard,
    /if \(unknownAgentCandidates\.size > 0\)/,
    "queued candidates drive the attempt; the cooldown inside bounds it",
  );
  const refresh = dashboard.slice(
    dashboard.indexOf("const refreshRosterForUnknownAgents ="),
    dashboard.indexOf("const renderChannel ="),
  );
  assert.match(refresh, /const candidates = \[\.\.\.unknownAgentCandidates\]/);
  assert.match(
    refresh,
    /for \(const principalId of \[\.\.\.unknownAgentCandidates\]\) \{[\s\S]*if \(rosterIds\.has\(principalId\)\) unknownAgentCandidates\.delete\(principalId\)/,
    "principals queued during the flight and present in the fresh roster are pruned, not refetched",
  );
  assert.match(
    refresh,
    /unknownAgentCandidates\.delete\(principalId\);[\s\S]*if \(!rosterIds\.has\(principalId\)\) settledUnknownAgents\.add\(principalId\)/,
    "only a successful fetch may settle, and only captured principals still absent from it",
  );
  const catchBlock = refresh.slice(
    refresh.indexOf("} catch {"),
    refresh.indexOf("} finally {"),
  );
  assert.doesNotMatch(
    catchBlock,
    /settledUnknownAgents\.add|unknownAgentCandidates\.delete/,
    "a failed refresh settles and drains nothing — it stays retryable after the cooldown",
  );
  const openWorkspace = dashboard.slice(
    dashboard.indexOf("const openWorkspace ="),
    dashboard.indexOf("const openAgentChoice ="),
  );
  assert.match(openWorkspace, /unknownAgentCandidates\.clear\(\)/);
  assert.match(openWorkspace, /settledUnknownAgents\.clear\(\)/);
});

test("the catch-up state machine: no repeat after absent confirmation, retry after failure", () => {
  /* A pure model of the rules the regexes above pin to the real source, in the same
     spirit as the pagination model in dashboard-runtime.observer.test.ts. */
  const simulate = (
    fetchOutcomes: Array<"ok-absent" | "ok-present" | "fail">,
    polls: number,
  ): number => {
    const known = new Set<string>();
    const candidates = new Set<string>();
    const settled = new Set<string>();
    let attemptedAt = Number.NEGATIVE_INFINITY;
    let fetches = 0;
    let outcomeIx = 0;
    for (let poll = 0; poll < polls; poll++) {
      const now = poll * 2_000;
      /* Every page carries one historical signal from the revoked principal. */
      if (
        !known.has("revoked-1") &&
        !settled.has("revoked-1") &&
        !candidates.has("revoked-1")
      ) {
        candidates.add("revoked-1");
      }
      if (candidates.size === 0) continue;
      if (now - attemptedAt < 10_000) continue;
      attemptedAt = now;
      fetches++;
      const outcome = fetchOutcomes[Math.min(outcomeIx++, fetchOutcomes.length - 1)];
      if (outcome === "fail") continue; /* settles and drains nothing */
      candidates.delete("revoked-1");
      if (outcome === "ok-absent") settled.add("revoked-1");
      else known.add("revoked-1"); /* present in the fresh roster: now known */
    }
    return fetches;
  };
  assert.equal(
    simulate(["ok-absent"], 20),
    1,
    "a confirmed-absent principal must not be refetched every cooldown",
  );
  assert.equal(
    simulate(["ok-present"], 20),
    1,
    "a genuinely joined principal is fetched once and becomes known",
  );
  assert.equal(
    simulate(["fail", "fail", "ok-absent"], 20),
    3,
    "failed refreshes stay retryable after each cooldown until one succeeds",
  );

  /* Coalescing (Lead7 #18166): "new-2" first signals while the fetch for "old-1" is in
     flight, and the completed fetch's roster already contains it. It must be pruned from
     the queue — never settled, never refetched after the cooldown. */
  const simulateCoalesce = (): number => {
    const known = new Set<string>();
    const candidates = new Set<string>();
    const settled = new Set<string>();
    let attemptedAt = Number.NEGATIVE_INFINITY;
    let fetches = 0;
    let inFlight = false;
    let completesAt = -1;
    let captured: string[] = [];
    for (let poll = 0; poll < 20; poll++) {
      const now = poll * 2_000;
      for (const [principal, since] of [["old-1", 0], ["new-2", 1]] as const) {
        if (
          poll >= since &&
          !known.has(principal) &&
          !settled.has(principal) &&
          !candidates.has(principal)
        ) {
          candidates.add(principal);
        }
      }
      /* The one fetch takes a full poll, so "new-2" queues DURING its flight. */
      if (inFlight && poll >= completesAt) {
        const rosterIds = new Set(["old-1", "new-2"]);
        for (const principalId of [...candidates]) {
          if (rosterIds.has(principalId)) {
            candidates.delete(principalId);
            known.add(principalId); /* present in the fresh roster */
          }
        }
        for (const principalId of captured) {
          candidates.delete(principalId);
          if (!rosterIds.has(principalId)) settled.add(principalId);
          else known.add(principalId);
        }
        inFlight = false;
        continue;
      }
      if (candidates.size === 0 || inFlight) continue;
      if (now - attemptedAt < 10_000) continue;
      attemptedAt = now;
      fetches++;
      inFlight = true;
      captured = [...candidates];
      completesAt = poll + 1;
    }
    return fetches;
  };
  assert.equal(
    simulateCoalesce(),
    1,
    "a principal queued during the flight and present in the fetch is pruned, not refetched",
  );
});
