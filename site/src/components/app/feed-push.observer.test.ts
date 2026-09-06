import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const dashboard = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const client = await readFile(new URL("../../lib/commonswarm.ts", import.meta.url), "utf8");
const feedPush = await readFile(new URL("../../lib/feed-push.ts", import.meta.url), "utf8");

function between(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing observer start anchor: ${start}`);
  assert.notEqual(endAt, -1, `missing observer end anchor: ${end}`);
  return source.slice(startAt, endAt);
}

test("the dashboard subscribes to workspace signals on open and tears them down on reset", () => {
  const openWorkspace = between(dashboard, "const openWorkspace =", "const openAgentChoice =");
  const reset = between(dashboard, "const resetWorkspaceSessionState =", "armLiveFeed =");
  const sample = between(dashboard, "const renderSample =", "workspaces = [");
  assert.match(openWorkspace, /startAgentActivity\(selected\.id, version\)/);
  assert.match(openWorkspace, /startFeedPush\(selected\.id\)/);
  assert.match(
    dashboard,
    /startFeedPush = \(workspaceId: string\): void => \{[\s\S]*const workspaceForJoin = workspaceId;/,
  );
  assert.match(reset, /stopFeedPush\(\)/);
  assert.match(sample, /stopFeedPush\(\)/);
  assert.match(dashboard, /subscribeWorkspaceSignals/);
  assert.match(dashboard, /new FeedPushController/);
});

test("subscribe captures the workspace id before session and setAuth awaits", () => {
  const subscribe = between(
    client,
    "export async function subscribeWorkspaceSignals",
    "Start an OAuth sign-in",
  );
  assert.match(subscribe, /const workspaceForJoin = workspaceId;/);
  assert.match(subscribe, /const workspaceForJoin = workspaceId;[\s\S]*await currentSession\(\)/);
  assert.match(subscribe, /await c\.realtime\.setAuth\(active\.access_token\)/);
  assert.match(
    subscribe,
    /attachWorkspaceSignalsChannel\(c, workspaceForJoin, onEvent, onStatus\)/,
  );
  assert.doesNotMatch(subscribe, /console\.(log|debug|info|warn|error)/);
});

test("the join is private:true on cswarm-signals and the event is the shared constant", () => {
  assert.match(feedPush, /export const WORKSPACE_SIGNALS_TOPIC_PREFIX = "cswarm-signals:"/);
  assert.match(feedPush, /export const WORKSPACE_SIGNALS_EVENT = "signal"/);
  const attach = between(feedPush, "export function attachWorkspaceSignalsChannel", "export class FeedPushController");
  assert.match(attach, /private: true/);
  assert.match(attach, /event: WORKSPACE_SIGNALS_EVENT/);
  assert.match(attach, /workspaceSignalsTopic\(workspaceForJoin\)/);
  assert.match(attach, /if \(removed\) return;/);
});

test("fallback statuses are one generated set; CHANNEL_ERROR is in it", () => {
  const listed = between(
    feedPush,
    "export const FEED_PUSH_FALLBACK_STATUSES = [",
    "] as const;",
  );
  assert.match(listed, /"CHANNEL_ERROR"/);
  assert.match(listed, /"TIMED_OUT"/);
  assert.match(listed, /"CLOSED"/);
  assert.match(feedPush, /isFeedPushFallbackStatus\(status\)/);
  assert.match(feedPush, /export const FEED_POLL_MS = 2_000/);
  assert.match(feedPush, /export const FEED_RECONCILE_MS = 30_000/);
  assert.match(feedPush, /feedRefreshIntervalMs\(this\.#subscribed\)/);
  assert.doesNotMatch(feedPush, /error\.message/);
});

test("nothing about the topic or a channel error is written into the UI", () => {
  assert.doesNotMatch(
    dashboard,
    /textContent =[^;]*(cswarm-signals|CHANNEL_ERROR|TIMED_OUT)/,
  );
  assert.doesNotMatch(
    dashboard,
    /console\.(log|debug|info|warn|error)/,
  );
  const arm = between(
    dashboard,
    "armLiveFeed = (): void => {\n      if (",
    "const refreshRosterForUnknownAgents",
  );
  assert.match(arm, /feedPush\.arm\(\)/);
  assert.match(arm, /disarmLiveFeed = \(\): void => \{[\s\S]*feedPush\.disarm\(\)/);
  assert.match(
    dashboard,
    /document\.addEventListener\("visibilitychange"[\s\S]*disarmLiveFeed\(\)/,
  );
});
