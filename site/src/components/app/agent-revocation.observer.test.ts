import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("agent roster Remove is role-aware and confirms identity end", async () => {
  const source = await readFile(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  assert.match(source, /owner_user_id/);
  assert.match(source, /me\.role === "owner"/);
  assert.match(source, /me\.role === "admin"/);
  assert.match(source, /agent\.ownerUserId === me\.userId/);
  assert.match(source, /dataset\.removeAgent/);
  assert.match(source, /revokeAgentPrincipal\(/);
  assert.match(source, /ends its identity and every live credential/);
  assert.match(source, /Clearing a Copy prompt only hides the secret/);
  assert.match(source, /data-agent-error/);
  assert.match(source, /livePromptPrincipalId/);
});

test("browser helper posts strict revoke_agent_principal only", async () => {
  const source = await readFile(
    new URL("../../lib/commonswarm.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /\{ kind: "revoke_agent_principal", principal_id: principalId \}/,
  );
  assert.match(source, /stream: \{ kind: "workspace" \}/);
  assert.doesNotMatch(source, /kind: "revoke_agent_token"/);
});

test("Clear on connect panel does not revoke", async () => {
  const source = await readFile(
    new URL("../connect/AgentConnect.astro", import.meta.url),
    "utf8",
  );
  assert.match(source, /data-action="clear"/);
  assert.match(source, /Clear this prompt/);
  assert.match(source, /clearPrompt\(/);
  assert.doesNotMatch(source, /revoke_agent_principal/);
  assert.doesNotMatch(source, /revokeAgentPrincipal/);
  assert.doesNotMatch(source, /revoke_agent_token/);
});
