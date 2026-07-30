import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

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
