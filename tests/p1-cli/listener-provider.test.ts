/**
 * CLI provider selection coverage. This file is reached by both the root
 * literal test list and the test:p1-cli glob.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  listenerFailureMessage,
  resolveDetachedClaudeExecutable,
  resolveDetachedCodexExecutable,
} from "../../src/cli.js";

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=4096",
      },
      input: "",
    },
  );
}

test("listen start requires an explicit provider before target or credential work", () => {
  const result = runCli([
    "listen",
    "start",
    "--agent-token-stdin",
    "--workspace-id",
    "11111111-1111-4111-8111-111111111111",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--provider is required/);
  assert.match(result.stderr, /grok.*0\.2\.117/i);
  assert.match(result.stderr, /opencode.*1\.18\.10/i);
  assert.match(
    result.stderr,
    /npm install -g @agentclientprotocol\/claude-agent-acp@0\.64\.2/,
  );
  assert.match(
    result.stderr,
    /npm install -g @agentclientprotocol\/codex-acp@1\.1\.9/,
  );
  assert.match(result.stderr, /working-on, note, ask, and feed/);
  assert.match(result.stderr, /detached live receipt needs/i);
  assert.doesNotMatch(result.stderr, /Grok is not signed in|Payment Required/i);
});

test("unsupported provider error lists the same four remedies", () => {
  const result = runCli([
    "listen",
    "start",
    "--agent-token-stdin",
    "--workspace-id",
    "11111111-1111-4111-8111-111111111111",
    "--provider",
    "unknown",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported --provider/);
  assert.match(result.stderr, /grok.*opencode.*claude.*codex/i);
  assert.match(
    result.stderr,
    /npm install -g @agentclientprotocol\/claude-agent-acp@0\.64\.2/,
  );
});

test("Codex startup failures give install and bounded diagnostic remedies", () => {
  const install = "npm install -g @agentclientprotocol/codex-acp@1.1.9";
  assert.ok(listenerFailureMessage("executable_missing", "codex").includes(install));
  assert.ok(listenerFailureMessage("version_refused", "codex").includes(install));

  const ambiguous = listenerFailureMessage("rpc_error", "codex");
  assert.match(ambiguous, /could not start \(rpc_error\)/i);
  assert.match(ambiguous, /ChatGPT\/Codex sign-in/i);
  assert.match(ambiguous, /API-key variables are not forwarded/i);

  const canary = listenerFailureMessage("permission_canary_failed", "codex");
  assert.match(canary, /read-only ACP permission canary/i);
  assert.match(canary, /no workspace signal prompt was delivered/i);
  assert.match(
    listenerFailureMessage("permission_mode_unavailable", "codex"),
    /required read-only permission mode.*reinstall codex-acp 1\.1\.9/i,
  );
});

test("detached Codex resolution preserves the exact install remedy", () => {
  assert.throws(
    () =>
      resolveDetachedCodexExecutable(
        "definitely-missing-codex-acp",
        "/definitely/missing",
      ),
    /npm install -g @agentclientprotocol\/codex-acp@1\.1\.9/,
  );
});

test("Claude startup failures give install and bounded diagnostic remedies", () => {
  const install = "npm install -g @agentclientprotocol/claude-agent-acp@0.64.2";
  assert.ok(listenerFailureMessage("executable_missing", "claude").includes(install));
  assert.ok(listenerFailureMessage("version_refused", "claude").includes(install));

  const ambiguous = listenerFailureMessage("rpc_error", "claude");
  assert.match(ambiguous, /could not start \(rpc_error\)/i);
  assert.match(ambiguous, /keychain\/OAuth/i);
  assert.match(ambiguous, /network access/i);
  assert.match(ambiguous, /ANTHROPIC_API_KEY is not forwarded/i);
  assert.doesNotMatch(ambiguous, /authenticated worker session/i);

  const unknownExit = listenerFailureMessage("process_exit", "claude");
  assert.match(unknownExit, /detached listener process exited/i);
  assert.doesNotMatch(unknownExit, /keychain|OAuth|network access/i);

  const canary = listenerFailureMessage("permission_canary_failed", "claude");
  assert.match(canary, /keychain\/OAuth/i);
  assert.match(canary, /startup canary ran/i);
  assert.match(canary, /no workspace signal prompt was delivered/i);
  assert.match(
    listenerFailureMessage("permission_mode_unavailable", "claude"),
    /required manual permission mode.*reinstall claude-agent-acp 0\.64\.2/i,
  );
});

test("detached Claude resolution preserves the exact install remedy", () => {
  assert.throws(
    () =>
      resolveDetachedClaudeExecutable(
        "definitely-missing-claude-agent-acp",
        "/definitely/missing",
      ),
    /npm install -g @agentclientprotocol\/claude-agent-acp@0\.64\.2/,
  );
});

test("explicit unusable Claude path keeps its diagnostic and reinstall option", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-unusable-"));
  const executable = join(root, "claude-agent-acp");
  try {
    await writeFile(executable, "not executable", { mode: 0o600 });
    assert.throws(
      () => resolveDetachedClaudeExecutable(executable, "/unused"),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        assert.match(message, /could not use --claude-executable/i);
        assert.match(message, /not executable/i);
        assert.ok(message.includes(executable));
        assert.match(
          message,
          /npm install -g @agentclientprotocol\/claude-agent-acp@0\.64\.2/,
        );
        assert.doesNotMatch(message, /is not installed/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hidden supervisor rejects another provider's executable before credentials", () => {
  const result = runCli([
    "__listen-supervisor",
    "--provider",
    "claude",
    "--grok-executable",
    "/tmp/grok",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--grok-executable requires --provider grok/);
  assert.doesNotMatch(result.stderr, /credential|workspace-id must be a UUID/i);
});
