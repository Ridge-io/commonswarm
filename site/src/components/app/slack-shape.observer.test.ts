import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import type { Signal } from "../../lib/commonswarm";
import {
  filterSignals,
  signalCounts,
  signalIsDirectToViewer,
} from "../../lib/signal-feed";
import {
  findChrome,
  renderParticipantRailFixture,
} from "./participant-rail.fixture.js";

/*
 * Observer for the Slack-shaped workspace shell. The site gate reaches this file through
 * its recursive component observer-test glob. Source assertions pin the state machine and the
 * bounded rail; emitted assets prove Astro ships the light field and typographic hierarchy.
 */
const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");
const dashboard = readFileSync(join(componentDir, "LiveDashboard.astro"), "utf8");
const dashboardStyle = dashboard.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)?.[1];
assert.ok(dashboardStyle, "LiveDashboard must expose its stylesheet to the geometry fixture");
const appHtml = readFileSync(join(siteRoot, "dist", "app", "index.html"), "utf8");
const assetPaths = Array.from(
  appHtml.matchAll(/(?:src|href)="\/(_astro\/[^"?#]+\.(?:js|css))/g),
  (match) => match[1]!,
);
const builtAssets = assetPaths
  .map((assetPath) => readFileSync(join(siteRoot, "dist", assetPath), "utf8"))
  .join("\n");

const run = promisify(execFile);
type RailGeometry = {
  three: { clientHeight: number; scrollHeight: number; railHeight: number; overflowY: string };
  fifty: { clientHeight: number; scrollHeight: number; railHeight: number; overflowY: string };
};

const renderRailGeometry = async (): Promise<RailGeometry> => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-slack-rail-"));
  const fixture = join(directory, "index.html");
  const member = [{ userId: "dana", name: "Dana Rivera", role: "owner" as const }];
  const rows = (count: number) => Array.from({ length: count }, (_, index) => ({
    principal_id: `agent-${index + 1}`,
    name: `Agent ${String(index + 1).padStart(2, "0")}`,
    model: `Model ${index + 1}`,
    owner_user_id: "dana",
  }));
  const [threeRows, fiftyRows] = await Promise.all([
    renderParticipantRailFixture(member, rows(3)),
    renderParticipantRailFixture(member, rows(50)),
  ]);
  const rail = (name: string, participantRows: string): string => `
    <aside class="dashboard__rail" data-rail="${name}">
      <div class="dashboard__workspace-control">
        <button class="dashboard__workspace-trigger">CommonSwarm Build</button>
      </div>
      <section class="dashboard__rail-section dashboard__rail-section--participants">
        <div class="dashboard__rail-label-row"><h2>PEOPLE &amp; AGENTS</h2></div>
        <ul class="dashboard__sidebar-agent-list" data-list="${name}">${participantRows}</ul>
      </section>
    </aside>`;
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      :root {
        --s-1: 0.25rem;
        --s-2: 0.5rem;
        --s-3: 0.75rem;
        --s-4: 1rem;
        --s-5: 1.5rem;
        --t-2xs: 0.6875rem;
        --t-xs: 0.75rem;
        --t-sm: 0.875rem;
        --weight-medium: 500;
        --weight-semibold: 600;
        --font-sans: Arial, sans-serif;
        --font-mono: monospace;
        --track-eyebrow: 0.08em;
        --lh-xs: 1.2;
        --radius-sm: 0.25rem;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Arial, sans-serif; }
      ${dashboardStyle}
      .fixture { display: flex; align-items: flex-start; gap: 2rem; }
      .fixture .dashboard__rail { inline-size: 18.5rem; }
    </style>
  </head>
  <body>
    <div class="dashboard fixture">
      ${rail("three", threeRows.innerHtml)}
      ${rail("fifty", fiftyRows.innerHtml)}
    </div>
    <script>
      const measure = (name) => {
        const list = document.querySelector('[data-list="' + name + '"]');
        const rail = document.querySelector('[data-rail="' + name + '"]');
        return {
          clientHeight: list.clientHeight,
          scrollHeight: list.scrollHeight,
          railHeight: rail.getBoundingClientRect().height,
          overflowY: getComputedStyle(list).overflowY,
        };
      };
      document.documentElement.dataset.metrics = btoa(JSON.stringify({
        three: measure("three"),
        fifty: measure("fifty"),
      }));
    </script>
  </body>
</html>`;

  try {
    await writeFile(fixture, html, "utf8");
    const chrome = await findChrome();
    const { stdout } = await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--single-process",
      "--no-zygote",
      "--window-size=1440,1000",
      "--allow-file-access-from-files",
      "--dump-dom",
      `file://${fixture}`,
    ], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    const encoded = stdout.match(/data-metrics="([^"]+)"/)?.[1];
    assert.ok(encoded, "headless Chrome must return the rendered rail geometry payload");
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as RailGeometry;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("the workspace shell groups people with their nested agents in one bounded list", () => {
  for (const token of [
    /* ~~"STREAMS"~~ retired 2026-09-05. `stream` is the event log on the wire and in
       SWARM-CLOUD.md 2.1, and this heading was the only place the app showed that word to a
       reader. The rail now lists CHANNELS, with all-signals above them as the whole feed
       rather than a channel among them. */
    "CHANNELS",
    "PEOPLE &amp; AGENTS",
    "# all-signals",
    "Every agent belongs to a person. Workspace-owned agents are not supported yet.",
    "data-sidebar-participant-list",
  ]) {
    assert.ok(dashboard.includes(token), `dashboard shell is missing ${token}`);
  }
  const participantListRules = Array.from(
    dashboard.matchAll(/\.dashboard__sidebar-agent-list\s*\{([\s\S]*?)\}/g),
    (match) => match[1],
  ).join("\n");
  assert.match(
    participantListRules,
    /max-block-size:\s*14rem;[\s\S]*?overflow-y:\s*auto;/,
    "the participant rail must retain its maximum height and its own vertical scroll",
  );
  assert.doesNotMatch(
    participantListRules,
    /(?:^|\n)\s*block-size:\s*14rem;/,
    "a short participant list must shrink to its content",
  );
  assert.match(
    dashboard,
    /renderSidebarParticipants\(participantList, members, agents, initials\)/,
  );
  assert.equal(
    [...dashboard.matchAll(/<button\b[^>]*data-workspace-menu-trigger[^>]*>/g)].length,
    1,
    "the rail renders one workspace control",
  );
  assert.doesNotMatch(
    dashboard,
    /dashboard__workspace-switcher/,
    "the superseded Workspaces rail section must not return beside the top control",
  );
  const privacyResetStart = dashboard.indexOf("const resetWorkspaceSessionState");
  const privacyResetEnd = dashboard.indexOf("armLiveFeed =", privacyResetStart);
  assert.notEqual(privacyResetStart, -1, "privacy-reset start anchor must resolve");
  assert.notEqual(privacyResetEnd, -1, "privacy-reset end anchor must resolve");
  const privacyReset = dashboard.slice(
    privacyResetStart,
    privacyResetEnd,
  );
  for (const selector of [
    "data-sidebar-workspace-name",
    "data-sidebar-participant-list",
    "data-broadcast-count",
    "data-direct-count",
  ]) {
    assert.ok(privacyReset.includes(selector), `privacy reset must clear ${selector}`);
  }
  assert.doesNotMatch(
    dashboard,
    /data-sidebar-(?:people|agent)-(?:list|count)/,
    "the superseded flat participant lists and duplicate visible counts must stay retired",
  );
  assert.match(privacyReset, /renderRoster\(\);/);
});

test("the participant list shrinks when short and fills+scrolls the rail when long", async () => {
  const geometry = await renderRailGeometry();

  // Short roster: the list shrinks to its content, no scroll.
  assert.equal(geometry.three.scrollHeight, geometry.three.clientHeight, JSON.stringify(geometry));
  // Long roster: the list FILLS the rail's available height (well past the retired 14rem/224px
  // cap — operator direction 2026-08-19) and scrolls its overflow within that. The header-dialog
  // copy of this list keeps the 14rem cap; only the growing sidebar list is uncapped.
  assert.ok(geometry.fifty.clientHeight > 224, JSON.stringify(geometry));
  assert.ok(
    geometry.fifty.clientHeight <= geometry.fifty.railHeight,
    "the list must not exceed the rail it lives in: " + JSON.stringify(geometry),
  );
  assert.ok(geometry.fifty.scrollHeight > geometry.fifty.clientHeight, JSON.stringify(geometry));
  assert.equal(geometry.three.overflowY, "auto", JSON.stringify(geometry));
  assert.equal(geometry.fifty.overflowY, "auto", JSON.stringify(geometry));
});

/* ~~"the immutable all-signals STREAM"~~ retired 2026-09-05 with the word: `stream` is the
   event log on the wire and in SWARM-CLOUD.md 2.1, and the app no longer uses it. The header
   is the unfiltered view, and its name is built from ALL_SIGNALS_SLUG rather than typed, so
   the pin moved from the rendered text to the expression that renders it. */
test("the channel header says what the immutable all-signals view is", () => {
  assert.match(
    dashboard,
    /data-channel-name tabindex="-1">\{channelLabel\(ALL_SIGNALS_SLUG\)\}<\/h1>/,
  );
  assert.ok(
    dashboard.includes("Intent posted by every agent in this workspace. Immutable, and never a claim."),
  );
});

test("loaded-signal filters and counts classify person, agent, and broadcast targets", () => {
  for (const filter of ["all", "broadcast", "direct-to-you"]) {
    assert.match(dashboard, new RegExp(`data-feed-filter="${filter}"`));
  }
  assert.match(dashboard, /let signalFilter: SignalFilter = "all";/);
  /* ~~filterSignals(signals, signalFilter, viewerId, agentById)~~ Dead 2026-09-01: the
   * fourth argument was dead plumbing from the retired operated-agent clause, and this pin
   * held it in place. The filter is person-only and takes no agent-ownership map. */
  assert.match(dashboard, /filterSignals\(signals, signalFilter, viewerId\)/);
  assert.doesNotMatch(
    dashboard,
    /filterSignals\([^)]*agentById/,
    "the feed filter must not be handed an agent-ownership map it does not read",
  );
  assert.match(
    dashboard,
    /for \(const button of all<HTMLButtonElement>\("\[data-feed-filter\]"\)\)[\s\S]*?signalFilter = next;[\s\S]*?renderFeed\(\);/,
  );

  const makeSignal = (id: string, to: string | null, toAgent: string | null): Signal => ({
    id,
    from: "author-agent",
    fromKind: "agent",
    to,
    toAgent,
    kind: "note",
    body: id,
    about: null,
    until: null,
    createdAt: "2026-08-04T12:00:00.000Z",
  });
  const signals = [
    makeSignal("broadcast", null, null),
    makeSignal("person-direct", "viewer", null),
    makeSignal("agent-direct", null, "viewer-agent"),
    makeSignal("other-direct", null, "other-agent"),
  ];

  assert.deepEqual(
    filterSignals(signals, "all", "viewer").map((signal) => signal.id),
    signals.map((signal) => signal.id),
  );
  assert.deepEqual(
    filterSignals(signals, "broadcast", "viewer").map((signal) => signal.id),
    ["broadcast"],
  );
  /* ~~["person-direct", "agent-direct"]~~ Dead 2026-09-01, operator report: in a
   * solo-owner workspace the operated-agent clause made this filter show ALL
   * directed traffic. Direct to you = to the person, and a message to an agent
   * the viewer OPERATES must be excluded — that exclusion IS the fix. The
   * ownership map fixture that used to sit here is gone with the parameter: the
   * filter cannot consult who operates "viewer-agent", so its exclusion below
   * cannot depend on it. */
  assert.deepEqual(
    filterSignals(signals, "direct-to-you", "viewer").map((signal) => signal.id),
    ["person-direct"],
  );
  assert.deepEqual(signalCounts(signals), { broadcastCount: 1, directCount: 3 });
  assert.equal(signalIsDirectToViewer(signals[1]!, "viewer"), true);
  assert.equal(signalIsDirectToViewer(signals[2]!, "viewer"), false);
  assert.equal(signalIsDirectToViewer(signals[3]!, "viewer"), false);

  const sampleStart = dashboard.indexOf("const renderSample =");
  const sampleEnd = dashboard.indexOf("const boot =", sampleStart);
  assert.notEqual(sampleStart, -1, "sample-render start anchor must resolve");
  assert.notEqual(sampleEnd, -1, "sample-render end anchor must resolve");
  const sample = dashboard.slice(sampleStart, sampleEnd);
  const assertProtocolValidSamples = (source: string): void => {
    const objects = Array.from(source.matchAll(/{\s*id:\s*"sample-\d+"[\s\S]*?\n\s*},/g));
    assert.ok(objects.length > 0, "sample signal objects must resolve");
    for (const object of objects) {
      const field = (name: "to" | "toAgent" | "kind"): string | null => {
        const match = object[0].match(new RegExp(`\\b${name}:\\s*(null|"[^"]*")`));
        assert.ok(match, `sample signal must expose ${name}`);
        return match[1] === "null" ? null : JSON.parse(match[1]!);
      };
      if (field("kind") === "working-on") {
        assert.equal(field("to"), null, "working-on sample must not target a person");
        assert.equal(field("toAgent"), null, "working-on sample must not target an agent");
      }
    }
  };
  assertProtocolValidSamples(sample);

  const directedShape = `to: null,\n          toAgent: "sample-river",\n          kind: "note",`;
  assert.ok(sample.includes(directedShape), "directed sample mutation anchor must resolve");
  assert.throws(
    () => assertProtocolValidSamples(sample.replace(
      directedShape,
      `kind: "working-on",\n          to: "sample-owner",\n          toAgent: null,`,
    )),
    /working-on sample must not target a person/,
    "human-directed working-on must fail independent of field order",
  );
  assert.throws(
    () => assertProtocolValidSamples(sample.replace(
      directedShape,
      `kind: "working-on",\n          to: null,\n          toAgent: "sample-river",`,
    )),
    /working-on sample must not target an agent/,
    "agent-directed working-on must fail independent of field order",
  );
});

test("sidebar counts come from loaded signals and the shared field ships both schemes", () => {
  assert.match(dashboard, /const \{ broadcastCount, directCount \} = signalCounts\(signals\);/);
  assert.match(dashboard, /broadcastTarget\.textContent = String\(broadcastCount\)/);
  assert.match(dashboard, /directTarget\.textContent = String\(directCount\)/);
  const renderChannelStart = dashboard.indexOf("const renderChannel =");
  const renderChannelEnd = dashboard.indexOf("const resetInviteSubmitControl", renderChannelStart);
  assert.notEqual(renderChannelStart, -1, "channel-render start anchor must resolve");
  assert.notEqual(renderChannelEnd, -1, "channel-render end anchor must resolve");
  const renderChannel = dashboard.slice(
    renderChannelStart,
    renderChannelEnd,
  );
  assert.match(
    renderChannel,
    /renderSignalCounts\(\);/,
    "every pending, empty, and failed workspace render must replace the prior workspace's counts",
  );
  assert.ok(builtAssets.includes("dashboard__workspace-summary"));
  assert.ok(builtAssets.includes("dashboard__feed-filters"));
  assert.match(
    builtAssets,
    /\.dashboard\{[^}]*background:var\(--bg\)/,
    "the dashboard field follows the shared semantic background",
  );
  assert.match(builtAssets, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.doesNotMatch(
    dashboard,
    /--dashboard-(?:field|panel|rail-field|ink|muted|faint|line|direct)\s*:/,
    "the retired fixed-light palette must not return",
  );
});

test("participant navigation uses human presence and agent model identity", async () => {
  const rail = await renderParticipantRailFixture(
    [{ userId: "dana", name: "Dana Rivera", role: "owner" }],
    [
      { principal_id: "atlas", name: "Atlas", model: "Claude Opus", owner_user_id: "dana" },
      { principal_id: "orphan", name: "Orphan", model: "GPT-5", owner_user_id: "former" },
    ],
  );

  assert.match(rail.innerHtml, /dashboard__presence-dot/);
  assert.match(rail.innerHtml, /dashboard__sidebar-model-glyph/);
  assert.match(rail.innerHtml, />Claude Opus</);
  assert.match(rail.innerHtml, />operated by Owner unavailable</);
  assert.doesNotMatch(rail.innerHtml, /dashboard__sidebar-agent-avatar/);
  assert.doesNotMatch(rail.innerHtml, />AGENT</);
});
