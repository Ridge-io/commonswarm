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

test("signal pages include standard signals and terminate exact-multiple lookahead pages", () => {
  const source = between(dashboard, "const signalPage = async", "const initials =");

  assert.match(source, /\.or\(`until\.is\.null,until\.gt\.\$\{cutoff\}`\)/);
  assert.doesNotMatch(source, /\.gt\("until", cutoff\)/);
  assert.match(source, /\.range\(offset, offset \+ SIGNAL_FETCH_SIZE - 1\)/);
  assert.match(source, /hasMore: page\.length === SIGNAL_FETCH_SIZE/);
  assert.match(source, /rows: page\.slice\(0, SIGNAL_PAGE_SIZE\)\.map/);

  const pageSize = 50;
  const fetchSize = pageSize + 1;
  const paginate = (total: number): Array<{ offset: number; returned: number; hasMore: boolean }> => {
    const pages = [];
    for (let offset = 0; ; ) {
      const fetched = Math.max(0, Math.min(fetchSize, total - offset));
      const returned = Math.min(pageSize, fetched);
      const hasMore = fetched === fetchSize;
      pages.push({ offset, returned, hasMore });
      if (!hasMore) return pages;
      offset += returned;
    }
  };

  assert.deepEqual(paginate(50), [{ offset: 0, returned: 50, hasMore: false }]);
  assert.deepEqual(paginate(100), [
    { offset: 0, returned: 50, hasMore: true },
    { offset: 50, returned: 50, hasMore: false },
  ]);
  assert.deepEqual(paginate(101), [
    { offset: 0, returned: 50, hasMore: true },
    { offset: 50, returned: 50, hasMore: true },
    { offset: 100, returned: 1, hasMore: false },
  ]);
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
  const source = between(dashboard, "const closeConnect =", "const createFromIntent =");

  assert.match(source, /mintBusy \|\| connectState === "working" \|\| connectState === "done"/);
  assert.match(source, /Clear this live prompt before leaving this screen/);
  assert.match(source, /data-action='clear'/);
  assert.match(source, /return;[\s\S]*pendingWorkspaceId = ""/);
});

test("workspace changes synchronously retarget AgentConnect before its panel opens", () => {
  const openWorkspace = between(dashboard, "const openWorkspace =", "const openConnect =");
  const openConnect = between(dashboard, "const openConnect =", "const closeConnect =");

  assert.match(connect, /static observedAttributes = \["workspace-id", "workspace-name"\]/);
  assert.match(connect, /attributeChangedCallback\(\)/);
  assert.match(connect, /const version = \+\+this\.#loadVersion/);
  assert.match(connect, /if \(version !== this\.#loadVersion\) return/);
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
