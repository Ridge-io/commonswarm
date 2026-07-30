import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

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
  assert.match(source, /queueMicrotask\(\(\) =>/);
  assert.match(source, /authReloadQueued = false;[\s\S]*runBoot\(\)/);
  assert.match(dashboard, /if \(bootInFlight\)[\s\S]*bootAgain = true/);
  assert.match(dashboard, /do \{[\s\S]*await boot\(\);[\s\S]*\} while \(bootAgain\)/);
  assert.match(source, /closes \/app's auth-return race only/);
  assert.match(source, /auth\.onAuthStateChange\(/);
  assert.match(
    source,
    /event === "INITIAL_SESSION" \|\|[\s\S]*event === "SIGNED_IN" \|\|[\s\S]*event === "SIGNED_OUT"/,
  );
});

test("dashboard cannot hide a live or still-minting credential", () => {
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

  assert.match(guard, /connectState !== "working" && connectState !== "done"/);
  assert.match(guard, /Clear this live prompt before leaving this screen/);
  assert.match(guard, /finish creating the key before leaving this screen/);
  assert.match(guard, /data-action='clear'/);
  assert.match(close, /if \(keepConnectCredentialVisible\(\)\) return/);
  assert.match(signout, /if \(keepConnectCredentialVisible\(\)\) return/);
  assert.match(signout, /requestVersion \+= 1;[\s\S]*activeWorkspaceId = ""/);
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
  assert.match(source, /syncConnectWorkspace\(selected\);[\s\S]*closeConnect\(\);/);
});
