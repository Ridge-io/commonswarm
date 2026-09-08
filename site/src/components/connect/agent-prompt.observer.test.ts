import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dashboardAgentConnection, dashboardAgentFilePrompt, dashboardAgentPrompt } from "./agent-prompt";
import { parseAgentConnection } from "../../../../src/cloud/agent-profile";
import { AGENT_CONNECTION_FIELDS } from "../../../../src/cloud/agent-onboarding-contract";

const TOKEN = `swm_agt_${"A".repeat(43)}`;
const INPUT = {
  credential: {
    principalId: "11111111-1111-4111-8111-111111111111", principalName: "Observer",
    tokenId: "22222222-2222-4222-8222-222222222222", runId: "33333333-3333-4333-8333-333333333333",
    token: TOKEN, expiresAt: Date.parse("2099-07-29T23:00:00Z"), renews: true,
    horizonExpiresAt: null, grantKind: "standing" as const,
  },
  workspaceId: "44444444-4444-4444-8444-444444444444", workspaceName: "Observer room",
  deploymentUrl: "https://example.supabase.co", anonKey: "public-anon-observer",
};

test("the generated connection is accepted by the CLI without changing the credential schema", () => {
  const raw = dashboardAgentConnection(INPUT);
  const envelope = parseAgentConnection(raw);
  assert.deepEqual(Object.keys(envelope).sort(), [...AGENT_CONNECTION_FIELDS].sort());
  assert.equal(envelope.credential.agent_token, TOKEN);
  assert.equal(envelope.principal_id, INPUT.credential.principalId);
  assert.equal(envelope.workspace_id, INPUT.workspaceId);
  assert.equal(raw.split(TOKEN).length - 1, 1);
});

test("one-paste setup includes a single connection and full agent ID, with private file instructions", () => {
  const prompt = dashboardAgentPrompt(INPUT);
  assert.equal(prompt.split(TOKEN).length - 1, 1);
  assert.equal(prompt.split(INPUT.anonKey).length - 1, 1);
  assert.match(prompt, new RegExp(`connect-${INPUT.credential.principalId}/connection.json`));
  assert.match(prompt, /file-writing tool/);
  assert.match(prompt, /0700/);
  assert.match(prompt, /0600/);
  assert.match(prompt, /cswarm setup --connection-file/);
  assert.match(prompt, /cswarm setup --check-version/);
  assert.ok(prompt.length < 2400, `inline prompt grew to ${prompt.length} characters`);
});

test("file handoff reduces the baseline prompt by at least 90 percent without hiding a manual fetch", () => {
  const prompt = dashboardAgentFilePrompt(INPUT);
  assert.ok(prompt.length <= 13426 * 0.1, `file prompt has ${prompt.length} characters`);
  assert.equal(prompt.includes(TOKEN), false);
  assert.equal(prompt.includes(INPUT.anonKey), false);
  assert.match(prompt, /attached connection JSON/);
  assert.match(prompt, /setup guide only when needed/);
});

test("both prompts require the mode choice and same-session proof, without retired workers", () => {
  for (const prompt of [dashboardAgentPrompt(INPUT), dashboardAgentFilePrompt(INPUT)]) {
    assert.match(prompt, /Ask once:[\s\S]*wakeups in this same session[\s\S]*each turn's start and whenever asked/);
    assert.match(prompt, /user's choice[\s\S]*reuse a saved choice/);
    assert.match(prompt, /idle test passes/);
    assert.match(prompt, /cswarm check before work/);
    assert.doesNotMatch(prompt, /claude-agent-acp|codex-acp|--permissions allow|local Claude worker|note.*does NOT wake|Only after the detached listener/);
    assert.doesNotMatch(prompt, /renews (itself|automatically)|does not expire/);
  }
});

test("file download stays in memory, can be cleared, and key lifetime is under settings", () => {
  const source = readFileSync(new URL("./AgentConnect.astro", import.meta.url), "utf8");
  assert.match(source, /<details class="ac__advanced">[\s\S]*data-field="ttl"[\s\S]*<\/details>/);
  assert.match(source, /data-action="download-connection"/);
  assert.match(source, /URL.revokeObjectURL/);
  assert.match(source, /#forget\(\) \{[\s\S]*this.#connection = null;[\s\S]*this.#filePrompt = null;/);
  assert.doesNotMatch(source, /localStorage.setItem/);
});
