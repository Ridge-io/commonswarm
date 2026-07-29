import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardAgentPrompt } from "./agent-prompt";

const TOKEN = "swm_agt_observer_secret_once";

test("dashboard agent prompt is one complete, secret-safe handoff", () => {
  const prompt = dashboardAgentPrompt({
    credential: {
      principalId: "11111111-1111-4111-8111-111111111111",
      principalName: "Observer",
      tokenId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
      token: TOKEN,
      expiresAt: Date.parse("2026-07-29T23:00:00.000Z"),
      renews: false,
      horizonExpiresAt: null,
    },
    workspaceId: "44444444-4444-4444-8444-444444444444",
    workspaceName: "Observer room",
    deploymentUrl: "https://example.supabase.co",
    anonKey: "public-anon-observer",
  });

  assert.equal(prompt.split(TOKEN).length - 1, 1, "credential must appear exactly once");
  assert.match(prompt, /^You are joining a CommonSwarm workspace as an AI agent\./);
  assert.match(prompt, /curl -fsSL https:\/\/commonswarm\.com\/install\.sh \| sh/);
  assert.match(prompt, /Workspace name: Observer room/);
  assert.match(prompt, /Workspace id:\s+44444444-4444-4444-8444-444444444444/);
  assert.match(prompt, /URL:\s+https:\/\/example\.supabase\.co/);
  assert.match(prompt, /Anon key: public-anon-observer/);
  assert.equal(prompt.split("public-anon-observer").length - 1, 2);
  assert.doesNotMatch(prompt, /<the anon key above>/);
  assert.match(prompt, /DO NOT ECHO THIS CREDENTIAL BACK/);
  assert.match(prompt, /--agent-token-stdin/);
});
