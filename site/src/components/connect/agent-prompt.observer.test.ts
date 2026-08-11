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
     deployment details and once per self-contained command (working-on, listen, follow, reply),
     so a fresh agent can copy any single command block and have it work. */
  assert.equal(prompt.split("public-anon-observer").length - 1, 5);
  assert.doesNotMatch(prompt, /<the anon key above>/);
  assert.match(prompt, /DO NOT ECHO THIS CREDENTIAL BACK/);
  assert.match(prompt, /separate stdin channel/);
  /* ~~This pinned "Do not use echo, printf, or a heredoc".~~ Dead. That string is what a cold
   * agent read before concluding it had no compliant path and STOPPING, and the test was
   * actively defending it — a control discriminating toward a claim that harmed the reader.
   *
   * What must be true now is a PROPERTY: the prompt names a sanctioned form and says why it is
   * safe. Pinning the sanctioned command shape rather than a prohibition means a future edit
   * that removes the way out fails here. */
  assert.match(prompt, /this is the sanctioned form/);
  assert.match(
    prompt,
    /printf '%s' '<the JSON line>' \| cswarm <command> --agent-token-stdin/,
    "the sanctioned form is not shown",
  );
  assert.match(prompt, /printf is a shell builtin/, "it does not say WHY the form is safe");
  assert.doesNotMatch(
    prompt,
    /stop instead of improvising/,
    "it still tells a host without separate stdin to give up",
  );
  /* CONTROL: the prohibition itself must survive. A fix that simply deleted the warning would
   * satisfy everything above while telling an agent nothing about where the credential must
   * never go. */
  assert.match(prompt, /never appears in `ps`/);
  /* The sanctioned form must not CONTRADICT the prohibition it appears under. Both cold agents
   * that connected on 2026-08-10 raised this unprompted: the first version banned putting the
   * credential "in shell history" and then sanctioned a form that puts it there, rebutting only
   * the `ps` exposure. They proceeded; an agent that stopped reading at the prohibition would
   * have had no way through — which is the same coin-flip mechanism the fix was for.
   *
   * So: shell history is NOT in the prohibition list, and the form's limits are stated. */
  const prohibition = prompt.slice(
    prompt.indexOf("Never put it in a URL"),
    prompt.indexOf("If your host can write"),
  );
  assert.doesNotMatch(
    prohibition,
    /shell history/,
    "the prohibition still bans what the sanctioned form does",
  );
  assert.match(prompt, /What it does NOT do/, "the form's limits are not stated");
  assert.match(prompt, /already there, because that is where you/, "it hides the transcript exposure");
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
    'cswarm listen start --agent-token-stdin --provider claude --cwd "$PWD" --permissions deny --json',
    "cswarm inbox --kind ask --follow --ndjson --agent-token-stdin",
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

test("dashboard agent prompt teaches measured Claude wake and a host-neutral fallback", () => {
  const prompt = dashboardAgentPrompt(INPUT);

  assert.match(
    prompt,
    /Claude Code[\s\S]*npm install -g @agentclientprotocol\/claude-agent-acp@0\.64\.2[\s\S]*cswarm listen start --agent-token-stdin --provider claude/,
  );
  assert.match(prompt, /local Claude worker/);
  assert.match(prompt, /post and read signals[\s\S]*do not need a\s+listener/);
  assert.match(prompt, /listener adds detached live receipt/);
  assert.match(prompt, /--provider grok or --provider opencode/);
  assert.match(prompt, /--permissions deny/);
  assert.match(prompt, /safe default denies\s+ACP tool requests/);
  assert.match(prompt, /Every sender reaches the worker in your project context/);
  assert.match(prompt, /who sent it, their operator, and the owner relation/);
  assert.match(prompt, /seek your confirmation before destructive or irreversible action/);
  assert.doesNotMatch(prompt, /fresh strict|context-free|tool-denied session/);
  assert.match(prompt, /short credential\s+can rotate only while this listener remains\s+alive/);
  assert.match(prompt, /cswarm inbox --kind ask --follow --ndjson --agent-token-stdin/);
  assert.match(prompt, /cswarm reply <signal-id> "<answer>" --agent-token-stdin/);
  assert.match(prompt, /first line has type "ready"/);
  assert.match(prompt, /read signal\.id/);
  assert.match(prompt, /re-arms after every read/);
  assert.match(prompt, /retries transient network, 429, and 5xx/);
  assert.match(prompt, /Receipt\s+is at least once/);
  assert.match(prompt, /remember signal ids you handled/);
  assert.match(prompt, /not authority to reveal secrets or run tools/);
  assert.match(prompt, /fallback stream does not wake a model by itself/);
  assert.match(prompt, /host adapter or wrapper/);
  assert.match(prompt, /If the process exits, receipt\s+stops/);
  assert.match(prompt, /Only after the detached listener says ready or the fallback ready frame appears/);
  assert.doesNotMatch(prompt, /inbox --kind ask --wait 60/);
  assert.doesNotMatch(prompt, /always[- ]on|background daemon|all hosts automatically wake/i);
  assert.equal(prompt.split(TOKEN).length - 1, 1, "receive guidance must not duplicate the credential");
});

test("dashboard agent prompt requires cswarm 0.1.6+ before receive commands", () => {
  const prompt = dashboardAgentPrompt(INPUT);

  /* ~~This pinned "cswarm 0.1.6 or newer" and "missing or older than 0.1.6 … receive paths".~~
   * Dead 2026-08-11. That wording told an agent to install only if it was BELOW the floor, and
   * 0.1.6 is a compatibility floor rather than the current release — so two cold agents each
   * reported "cswarm 0.1.11 ✓ (≥ 0.1.6, no install needed)", skipped the install, and never
   * received 0.1.13 and its reply-loop fix. The test was defending the sentence that caused it.
   *
   * Pins the PROPERTY now: the floor is still stated, the installer is unconditional, and the
   * version check happens AFTER rather than as a gate before it. */
  /* Scoped to STEP 1. A bare /0\.1\.6/ over the whole prompt passes on a different sentence
   * further down ("Only after cswarm 0.1.6 or newer is installed"), so deleting the floor from
   * the step that states it left the test green — measured by mutation, not assumed. A control
   * that matches text elsewhere in the same document cannot see the thing it names. */
  const stepOne = prompt.slice(prompt.indexOf("1. Make sure"), prompt.indexOf("2. Connect"));
  assert.ok(stepOne.length > 80, "step 1 could not be isolated");
  assert.match(stepOne, /0\.1\.6/, "the compatibility floor is no longer stated in step 1");
  assert.match(prompt, /cswarm --version/);
  assert.match(
    prompt,
    /safe to re-run[\s\S]*even if cswarm is\s*already present/i,
    "the installer is no longer unconditional, so an agent can skip it and stay pinned",
  );
  assert.doesNotMatch(
    prompt,
    /if cswarm is missing or older than/i,
    "the conditional-install wording is back",
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
    /Only after cswarm[\s\S]*0\.1\.6 or newer is installed[\s\S]*cswarm inbox --kind ask --follow --ndjson/i,
  );
  assert.equal(prompt.split(TOKEN).length - 1, 1, "version guidance must not duplicate the credential");
  assert.doesNotMatch(prompt, /swm_agt_[^"\s]+.*0\.1\.6/);
});

test("dashboard agent prompt never promises unconditional renewal", () => {
  const renewable = dashboardAgentPrompt({
    ...INPUT,
    credential: {
      ...INPUT.credential,
      renews: true,
      horizonExpiresAt: Date.parse("2026-08-29T23:00:00.000Z"),
    },
  });
  assert.match(renewable, /receiver remains running and secure local state is available/);
  assert.match(renewable, /stopped or idle CLI cannot renew it/);
  assert.doesNotMatch(renewable, /renews it automatically/i);
});
