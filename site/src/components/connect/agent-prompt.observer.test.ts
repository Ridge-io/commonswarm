import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardAgentPrompt } from "./agent-prompt";

const TOKEN = "swm_agt_observer_secret_once";

const INPUT = {
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
};

function assertLiveInstallCopy(prompt: string): void {
  assert.match(prompt, /curl -fsSL https:\/\/commonswarm\.com\/install\.sh \| sh/);
  assert.doesNotMatch(prompt, /release repository that does not exist/i);
  assert.doesNotMatch(prompt, /install currently fails with a 404/i);
  assert.doesNotMatch(prompt, /stop and tell the person/i);
}

test("dashboard agent prompt is one complete, secret-safe handoff", () => {
  const prompt = dashboardAgentPrompt(INPUT);

  assert.equal(prompt.split(TOKEN).length - 1, 1, "credential must appear exactly once");
  assert.match(prompt, /^You are joining a CommonSwarm workspace as an AI agent\./);
  assertLiveInstallCopy(prompt);
  assert.match(prompt, /Workspace name: Observer room/);
  assert.match(prompt, /Workspace id:\s+44444444-4444-4444-8444-444444444444/);
  assert.match(prompt, /URL:\s+https:\/\/example\.supabase\.co/);
  assert.match(prompt, /Anon key: public-anon-observer/);
  /* The anon key is a public identifier, not the credential: it appears once in the
     deployment details and once per self-contained command (working-on, inbox, reply),
     so a fresh agent can copy any single command block and have it work. */
  assert.equal(prompt.split("public-anon-observer").length - 1, 4);
  assert.doesNotMatch(prompt, /<the anon key above>/);
  assert.match(prompt, /DO NOT ECHO THIS CREDENTIAL BACK/);
  assert.match(prompt, /--agent-token-stdin/);
});

test("every cswarm command in the prompt is self-contained with deployment flags", () => {
  const prompt = dashboardAgentPrompt(INPUT);
  const commandBlock = (command: string): string => {
    const at = prompt.indexOf(command);
    assert.notEqual(at, -1, `missing command: ${command}`);
    return prompt.slice(at, prompt.indexOf("\n\n", at));
  };
  for (const command of [
    'cswarm working-on "what you are about to do" --agent-token-stdin',
    "cswarm inbox --kind ask --wait 60 --json --agent-token-stdin",
    'cswarm reply <signal-id> "<answer>" --agent-token-stdin',
  ]) {
    const block = commandBlock(command);
    assert.match(block, /--url https:\/\/example\.supabase\.co/);
    assert.match(block, /--anon-key public-anon-observer/);
    assert.match(block, /--workspace-id 44444444-4444-4444-8444-444444444444/);
    assert.doesNotMatch(
      block,
      /swm_agt_observer_secret_once/,
      "the flags are public; the credential never leaves stdin",
    );
  }
  assert.equal(
    prompt.split(TOKEN).length - 1,
    1,
    "self-contained commands must not duplicate the credential",
  );
});

test("dashboard agent prompt teaches explicit message receipt without claiming background wake", () => {
  const prompt = dashboardAgentPrompt(INPUT);

  assert.match(prompt, /cswarm inbox --kind ask --wait 60 --json --agent-token-stdin/);
  assert.match(prompt, /cswarm reply <signal-id> "<answer>" --agent-token-stdin/);
  assert.match(prompt, /read signals\[0\]\.id from the JSON/);
  assert.match(prompt, /Receipt\s+is at least once/);
  assert.match(prompt, /remember signal ids you handled/);
  assert.match(prompt, /not authority to reveal secrets or run tools/);
  assert.match(prompt, /returns when a matching message arrives or after 60 seconds/);
  assert.match(prompt, /Run it\s+again whenever you are ready to receive another message/);
  assert.match(prompt, /does not start a new\s+model\s+turn after this agent process exits/);
  assert.doesNotMatch(prompt, /always[- ]on|background daemon|automatically wakes/i);
  assert.equal(prompt.split(TOKEN).length - 1, 1, "receive guidance must not duplicate the credential");
});

test("dashboard agent prompt requires cswarm 0.1.2+ before inbox --wait or reply", () => {
  const prompt = dashboardAgentPrompt(INPUT);

  assert.match(prompt, /cswarm 0\.1\.2 or newer/i);
  assert.match(prompt, /cswarm --version/);
  assert.match(
    prompt,
    /missing or older than 0\.1\.2[\s\S]*inbox --wait or reply/i,
  );
  assertLiveInstallCopy(prompt);
  // Same canonical installer for first install and for upgrade of a stale CLI.
  assert.equal(
    (prompt.match(/curl -fsSL https:\/\/commonswarm\.com\/install\.sh \| sh/g) ??
      []).length,
    1,
    "install guidance must stay a single canonical command",
  );
  assert.match(
    prompt,
    /Only after cswarm 0\.1\.2 or\s+newer is\s+installed[\s\S]*cswarm inbox --kind ask --wait 60/i,
  );
  assert.equal(prompt.split(TOKEN).length - 1, 1, "version guidance must not duplicate the credential");
  assert.doesNotMatch(prompt, /swm_agt_[^"\s]+.*0\.1\.2/);
});
