import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BootFocusGate } from "../../lib/boot-focus";

const cwd = process.cwd();
const siteRoot = fs.existsSync(path.join(cwd, "src", "components", "app"))
  ? cwd
  : path.join(cwd, "site");
const dashboardPath =
  process.env.COMMONSWARM_DASHBOARD_SOURCE ??
  path.join(siteRoot, "src", "components", "app", "LiveDashboard.astro");
const connectPath =
  process.env.COMMONSWARM_CONNECT_SOURCE ??
  path.join(siteRoot, "src", "components", "connect", "AgentConnect.astro");
const dashboard = fs.readFileSync(dashboardPath, "utf8");
const connect = fs.readFileSync(connectPath, "utf8");

function between(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing observer start anchor: ${start}`);
  assert.notEqual(endAt, -1, `missing observer end anchor: ${end}`);
  return source.slice(startAt, endAt);
}

test("signal pages use a frozen keyset and terminate exact-multiple lookahead pages", () => {
  const source = between(dashboard, "const signalPage = async", "const initials =");
  const loader = between(dashboard, "const loadSignals = async", "const renderChannel =");

  assert.match(source, /\.or\(`until\.is\.null,until\.gt\.\$\{cutoff\}`\)/);
  assert.doesNotMatch(source, /\.gt\("until", cutoff\)/);
  assert.match(source, /if \(cursor\) \{/);
  assert.match(
    source,
    /created_at\.lt\.\$\{cursor\.createdAt\},and\(created_at\.eq\.\$\{cursor\.createdAt\},id\.lt\.\$\{cursor\.id\}\)/,
  );
  assert.match(source, /\.order\("created_at", \{ ascending: false \}\)/);
  assert.match(source, /\.order\("id", \{ ascending: false \}\)/);
  assert.match(source, /\.limit\(SIGNAL_FETCH_SIZE\)/);
  assert.doesNotMatch(source, /\.range\(/);
  assert.match(source, /hasMore: page\.length === SIGNAL_FETCH_SIZE/);
  assert.match(source, /rows: page\.slice\(0, SIGNAL_PAGE_SIZE\)\.map/);
  assert.match(loader, /const cursor = reset \? null : signalCursor/);
  assert.match(loader, /if \(reset\) \{[\s\S]*signalCutoff = new Date\(\)\.toISOString\(\)/);
  assert.match(loader, /const last = page\.rows\.at\(-1\)/);
  assert.match(
    loader,
    /signalCursor = last \? \{ createdAt: last\.createdAt, id: last\.id \} : cursor/,
  );
  assert.doesNotMatch(dashboard, /signalOffset/);

  const pageSize = 50;
  const fetchSize = pageSize + 1;
  const paginate = (total: number): Array<{ returned: number; hasMore: boolean }> => {
    const pages = [];
    for (let consumed = 0; ; ) {
      const fetched = Math.max(0, Math.min(fetchSize, total - consumed));
      const returned = Math.min(pageSize, fetched);
      const hasMore = fetched === fetchSize;
      pages.push({ returned, hasMore });
      if (!hasMore) return pages;
      consumed += returned;
    }
  };

  assert.deepEqual(paginate(50), [{ returned: 50, hasMore: false }]);
  assert.deepEqual(paginate(100), [
    { returned: 50, hasMore: true },
    { returned: 50, hasMore: false },
  ]);
  assert.deepEqual(paginate(101), [
    { returned: 50, hasMore: true },
    { returned: 50, hasMore: true },
    { returned: 1, hasMore: false },
  ]);

  const ordered = [
    { createdAt: "2026-07-29T12:00:00Z", id: "b" },
    { createdAt: "2026-07-29T12:00:00Z", id: "a" },
    { createdAt: "2026-07-29T11:59:59Z", id: "z" },
  ];
  const cursor = ordered[1]!;
  const afterCursor = ordered.filter(
    (row) =>
      row.createdAt < cursor.createdAt ||
      (row.createdAt === cursor.createdAt && row.id < cursor.id),
  );
  assert.deepEqual(afterCursor, [ordered[2]]);
});

test("dashboard auth transitions include INITIAL_SESSION and coalesce reloads", () => {
  const startAt = dashboard.indexOf("const queueAuthReload =");
  const endAt = dashboard.lastIndexOf("runBoot();");
  assert.notEqual(startAt, -1);
  assert.notEqual(endAt, -1);
  const source = dashboard.slice(startAt, endAt + "runBoot();".length);

  assert.match(source, /nextUserId === renderedAuthUserId \|\| authReloadQueued/);
  assert.match(source, /authReloadQueued = true/);
  assert.match(source, /renderedAuthUserId = nextUserId;[\s\S]*requestVersion \+= 1/);
  assert.match(source, /queueMicrotask\(\(\) =>/);
  assert.match(source, /authReloadQueued = false;[\s\S]*runBoot\(\)/);
  assert.match(
    source,
    /if \(nextSession\?\.user\.id === renderedAuthUserId\) session = nextSession/,
  );
  assert.match(dashboard, /if \(bootInFlight\)[\s\S]*bootAgain = true/);
  assert.match(dashboard, /do \{[\s\S]*await boot\(\);[\s\S]*\} while \(bootAgain\)/);
  assert.match(
    dashboard,
    /const boot = async[\s\S]*const version = \+\+requestVersion;[\s\S]*session = await currentSession\(\);[\s\S]*if \(version !== requestVersion\) return;[\s\S]*workspaces = await workspaceMemberships\(\);[\s\S]*if \(version !== requestVersion\) return;[\s\S]*catch \(error\) \{[\s\S]*if \(version !== requestVersion\) return/,
  );
  assert.match(
    source,
    /one auth-return controller for both current and compatibility links/,
  );
  assert.match(source, /auth\.onAuthStateChange\(/);
  assert.match(
    source,
    /event === "INITIAL_SESSION" \|\|[\s\S]*event === "SIGNED_IN" \|\|[\s\S]*event === "SIGNED_OUT"/,
  );
});

test("workspace creation and active-feed expiry cannot outlive their session", () => {
  const create = between(dashboard, "const createFromIntent =", "const renderSample =");
  const feed = between(dashboard, "const renderFeed =", "const syncConnectWorkspace =");
  const channelView = between(dashboard, "const showChannelView =", "const accountName =");
  const createSubmit = between(
    dashboard,
    'one<HTMLFormElement>("[data-create-form]")',
    'for (const button of all<HTMLButtonElement>("[data-signout]"))',
  );

  assert.match(create, /const version = requestVersion/);
  assert.match(create, /session\?\.user\.id === userId/);
  assert.match(
    create,
    /if \(activeCreate\?\.version === version && activeCreate\.userId === userId\) return/,
  );
  assert.match(create, /activeCreate = marker/);
  assert.match(create, /if \(activeCreate === marker\) activeCreate = null/);
  assert.match(
    createSubmit,
    /activeCreate\?\.version === requestVersion[\s\S]*activeCreate\.userId === session\.user\.id/,
  );
  assert.match(createSubmit, /const savedIntent = readCreateIntent\(session\.user\.id\)/);
  assert.match(
    createSubmit,
    /const intent: CreateIntent = savedIntent\?\.name === name[\s\S]*\? savedIntent[\s\S]*workspaceId: uuid\(\)[\s\S]*commandId: uuid\(\)/,
  );
  assert.equal(
    create.match(/if \(!isCurrent\(\)\) return/g)?.length,
    3,
    "success, failure, and cleanup must all reject a stale create completion",
  );
  assert.match(
    feed,
    /window\.clearTimeout\(signalExpiryTimer\)[\s\S]*if \(addAgentViewOpen\(\)\) return/,
  );
  assert.match(
    feed,
    /signals = signals\.filter\([\s\S]*signal\.until === null \|\| new Date\(signal\.until\)\.getTime\(\) > now/,
  );
  assert.match(feed, /signalExpiryTimer = window\.setTimeout\([\s\S]*renderFeed/);
  assert.match(
    channelView,
    /if \(name !== "feed"\) \{[\s\S]*window\.clearTimeout\(signalExpiryTimer\)[\s\S]*signalExpiryTimer = undefined/,
  );
  assert.doesNotMatch(feed, /expired \?/);
});

test("panel changes expose busy state and move focus only on real transitions", () => {
  const source = between(dashboard, "const showPanel =", "const setLoading =");

  assert.match(source, /const previous = app\.dataset\.state/);
  assert.match(source, /aria-busy/);
  assert.match(source, /previous !== name && name !== "loading"/);
  assert.match(source, /querySelector<HTMLElement>\("h1, h2"\)/);
  assert.match(
    source,
    /if \(!panelBootFocus\.allowsFocus\(\)\) return;/,
    "the boot presentation skips the focus move — a fresh load must not paint " +
      "a :focus-visible ring around the headline",
  );
  assert.match(
    source,
    /heading\.focus\(\{ preventScroll: true \}\)/,
    "later transitions move focus plainly: the platform heuristic shows the " +
      "ring to keyboard users and not to pointer users",
  );
  assert.doesNotMatch(
    dashboard,
    /focusVisible/,
    "focus visibility is never suppressed anywhere — it is the platform's call",
  );
});

/*
 * CAUSAL, NOT A COPIED MODEL: this drives the same BootFocusGate class the
 * dashboard constructs for both surfaces (panel headings, the auth email field).
 * The regexes after it only pin that wiring.
 */
test("boot focus gate: each surface skips its first presentation", () => {
  const gate = new BootFocusGate();
  assert.equal(
    gate.allowsFocus(),
    false,
    "the first presentation of a surface takes no scripted focus",
  );
  assert.equal(
    gate.allowsFocus(),
    true,
    "the first user-driven transition moves focus",
  );
  assert.equal(
    gate.allowsFocus(),
    true,
    "and every transition after that",
  );
  /* Two surfaces are independent gates: a signed-in boot presents the channel
     panel without presenting auth. On the first explicit sign-out, the panel's
     later presentation may focus its heading while auth's first presentation
     still skips the email field, avoiding two competing scripted moves. */
  const panel = new BootFocusGate();
  const auth = new BootFocusGate();
  assert.equal(panel.allowsFocus(), false, "signed-in channel boot skips panel focus");
  assert.equal(panel.allowsFocus(), true, "sign-out moves context to the panel heading");
  assert.equal(
    auth.allowsFocus(),
    false,
    "auth's first presentation does not steal that focus for the email field",
  );
  assert.equal(
    auth.allowsFocus(),
    true,
    "a later use-different-address transition may focus the email field",
  );
});

test("the dashboard wires one boot gate per scripted-focus surface", () => {
  assert.match(
    dashboard,
    /import \{ BootFocusGate \} from "\.\.\/\.\.\/lib\/boot-focus"/,
  );
  assert.match(dashboard, /const panelBootFocus = new BootFocusGate\(\)/);
  assert.match(dashboard, /const authBootFocus = new BootFocusGate\(\)/);
  const authView = between(dashboard, "const showAuthView =", "const createStorageKey =");
  assert.match(
    authView,
    /name === "choices" && authBootFocus\.allowsFocus\(\)/,
    "the email field is focused only when the gate allows — its first choices " +
      "presentation skips, and email-sent never consumes",
  );
  assert.match(
    authView,
    /one<HTMLInputElement>\("#dashboard-email"\)\?\.focus\(\)/,
    "and when it does focus, it is a plain platform-heuristic focus",
  );
});

/*
 * LIVE RELEASE BLOCKER (62f8a3b): showPanel walked every [data-panel] under live-dashboard,
 * including AgentConnect's nested loading/form/result panels. Opening the channel set
 * hidden on those children; UA [hidden]{display:none!important} then permanently hid the
 * name field and mint button after "Add an agent", while the always-visible card header
 * still rendered. The fix scopes panel lookup and showPanel to .dashboard__root > [data-panel].
 * Causal: the unscoped walk must be absent; the scoped walk must be present; AgentConnect
 * must still own its own data-panel surfaces.
 */
test("showPanel must not stamp hidden on AgentConnect nested data-panel surfaces", () => {
  const showPanel = between(dashboard, "const showPanel =", "const setLoading =");
  const panelHelper = between(
    dashboard,
    "const panel = (name: string)",
    "const one =",
  );

  assert.match(
    panelHelper,
    /\.dashboard__root > \[data-panel="\$\{name\}"\]/,
    "panel() must resolve only top-level dashboard panels",
  );
  assert.match(
    showPanel,
    /all<HTMLElement>\("\.dashboard__root > \[data-panel\]"\)/,
    "showPanel must toggle only .dashboard__root > [data-panel]",
  );
  assert.doesNotMatch(
    showPanel,
    /all<HTMLElement>\("\[data-panel\]"\)/,
    "unscoped [data-panel] walk is the 62f8a3b cause of the missing form",
  );
  assert.match(
    connect,
    /data-panel="form"[\s\S]*data-field="name"[\s\S]*data-action="mint"/,
    "AgentConnect still owns nested data-panel form surfaces",
  );
  assert.match(
    connect,
    /\.ac\[data-state="ready"\] \[data-panel="form"\]/,
    "AgentConnect still switches form visibility via data-state, not dashboard hidden",
  );
});

test("dashboard blocks an in-flight mint but Done and Back can finish a visible prompt", () => {
  const openWorkspace = between(dashboard, "const openWorkspace =", "const openAgentChoice =");
  const guard = between(
    dashboard,
    "const keepConnectCredentialVisible =",
    "const closeConnect =",
  );
  const close = between(dashboard, "const closeConnect =", "const createFromIntent =");
  const signout = between(
    dashboard,
    'for (const button of all<HTMLButtonElement>("[data-signout]"))',
    'one<HTMLButtonElement>("[data-add-agent]")',
  );

  assert.match(guard, /connectState !== "working"/);
  assert.match(guard, /finish creating the key before leaving this screen/);
  assert.match(close, /if \(keepConnectCredentialVisible\(\)\) return/);
  assert.match(close, /connect\?\.dataset\.state === "done"[\s\S]*connect\.finishPrompt\("back"\)/);
  assert.match(signout, /if \(keepConnectCredentialVisible\(\)\) return/);
  assert.match(signout, /requestVersion \+= 1;[\s\S]*resetWorkspaceSessionState\(\)/);
  const reset = between(
    dashboard,
    "const resetWorkspaceSessionState =",
    "armLiveFeed =",
  );
  assert.match(reset, /activeWorkspaceId = ""/);
  assert.match(
    openWorkspace,
    /if \(connectState === "done"\)[\s\S]*pendingWorkspaceId = workspaceId;[\s\S]*connect\?\.finishPrompt\("back"\)/,
  );
  assert.match(
    openWorkspace,
    /if \(mintBusy \|\| connectState === "working"\)/,
  );
  assert.match(
    openWorkspace,
    /showChannelView\("connect"\);[\s\S]*return;[\s\S]*activeWorkspaceId = selected\.id/,
  );
  assert.match(
    openWorkspace,
    /people = nextRoster\.names;[\s\S]*members = nextRoster\.members;[\s\S]*if \(!addAgentViewOpen\(\)\) renderChannel\(selected\)/,
  );
  assert.match(
    openWorkspace,
    /channelLoadError = `\$\{readableError\(error\)\} Nothing was changed\.`;[\s\S]*if \(addAgentViewOpen\(\)\) return;[\s\S]*renderChannel\(selected\);[\s\S]*showChannelView\("feed-error"\)/,
  );
  assert.match(
    dashboard,
    /const returnToChannel = \(\): void => \{[\s\S]*if \(channelLoadError\) showChannelView\("feed-error"\)/,
  );
  assert.match(
    dashboard,
    /loadSignals\(workspaceId, true, version\)\.catch\(\(error\) => \{[\s\S]*channelLoadError = `\$\{readableError\(error\)\} Nothing was changed\.`;[\s\S]*if \(addAgentViewOpen\(\)\) return;[\s\S]*showChannelView\("feed-error"\)/,
  );
});

test("workspace changes synchronously retarget AgentConnect before its panel opens", () => {
  const openWorkspace = between(dashboard, "const openWorkspace =", "const openConnect =");
  const openConnect = between(dashboard, "const openConnect =", "const closeConnect =");

  assert.match(connect, /static observedAttributes = \["workspace-id", "workspace-name"\]/);
  assert.match(connect, /attributeChangedCallback\(\)/);
  assert.match(
    connect,
    /if \(this\.#busy \|\| this\.dataset\.state === "done"\)[\s\S]*this\.#retargetPending = true/,
  );
  assert.match(
    connect,
    /if \(this\.#retargetPending && this\.dataset\.state !== "done"\)[\s\S]*this\.#queueLoad\(\)/,
  );
  assert.match(connect, /const version = \+\+this\.#loadVersion/);
  assert.equal(
    connect.match(/if \(version !== this\.#loadVersion\) return/g)?.length,
    4,
    "every async AgentConnect load branch must reject stale results",
  );
  assert.match(
    connect,
    /const session = await currentSession\(\);[\s\S]*if \(version !== this\.#loadVersion\) return/,
  );
  assert.match(
    connect,
    /const workspaces = await myWorkspaces\(\);[\s\S]*if \(version !== this\.#loadVersion\) return/,
  );
  assert.match(
    connect,
    /const nextAgents = await myAgents\(session, nextWorkspaceId\);[\s\S]*if \(version !== this\.#loadVersion\) return;[\s\S]*this\.#workspaceId = nextWorkspaceId/,
  );
  assert.match(
    dashboard,
    /connect\.setAttribute\("workspace-name", workspace\.name\);[\s\S]*connect\.setAttribute\("workspace-id", workspace\.id\)/,
  );
  assert.match(
    openWorkspace,
    /activeWorkspaceId = selected\.id;[\s\S]*syncConnectWorkspace\(selected\);/,
  );
  assert.match(openConnect, /syncConnectWorkspace\(selected\);[\s\S]*showChannelView\("connect"\)/);
  assert.match(connect, /createAgentIdentity\([\s\S]*this\.#workspaceId/);
  assert.match(connect, /mintAgentCredential\([\s\S]*this\.#workspaceId/);
});

test("clearing the one-time secret always returns to the active channel", () => {
  const source = between(
    dashboard,
    'app.addEventListener("commonswarm:agent-secret-cleared"',
    "const queueAuthReload =",
  );

  assert.match(source, /if \(nextWorkspaceId\)[\s\S]*void openWorkspace\(nextWorkspaceId\)/);
  assert.match(source, /syncConnectWorkspace\(selected\);[\s\S]*returnToChannel\(\);/);
});
