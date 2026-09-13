import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { AgentSetupError, parseAgentConnection, saveAgentProfile } from "../../src/cloud/agent-profile.js";
import {
  CLAUDE_MCP_CONFIG_FILE,
  CSWARM_MCP_SERVER_NAME,
  claudeMcpConfigPath,
  configureAgentReceive,
  readReceiveBinding,
  receiveStatus,
} from "../../src/cloud/agent-receive.js";

const exec = promisify(execFile);

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = `swm_agt_${"C".repeat(43)}`;

async function setupFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cswarm-wake-test-")));
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  const profile = join(root, "agent", "profile.json");
  await saveAgentProfile(profile, parseAgentConnection(JSON.stringify({
    version: 1, url: "http://127.0.0.1:9999", anon_key: "fixture-key", workspace_id: WS, principal_id: AGENT,
    credential: { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: AGENT, token_id: "11111111-1111-4111-8111-111111111111", run_id: "22222222-2222-4222-8222-222222222222", agent_token: TOKEN, expires_at: "2099-01-01T00:00:00.000Z" },
  })));
  return {
    root, cwd, profile,
    cleanup: async () => { await rm(root, { recursive: true, force: true }); },
  };
}

test("MCP constants and helper function return expected config values", () => {
  // Wrong implementation to pass: Hardcode a different file name, export the wrong server name, or construct paths without using CLAUDE_MCP_CONFIG_FILE.
  assert.equal(CLAUDE_MCP_CONFIG_FILE, ".mcp.json");
  assert.equal(CSWARM_MCP_SERVER_NAME, "cswarm");
  assert.equal(claudeMcpConfigPath("/custom/repo"), join("/custom/repo", ".mcp.json"));
});

test("wake configure writes channel entry into .mcp.json at <cwd>/.mcp.json", async () => {
  // Wrong implementation to pass: Write the channel config to a different location (such as dirname(profile) or ~/.cswarm),
  // omit the receive serve args, or fail to set channel_config on the binding.
  const { cwd, profile, cleanup } = await setupFixture();
  try {
    const options = {
      profilePath: profile, mode: "wake", provider: "claude", hostSessionId: "host-session-1",
      cwd, previewChannel: true, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] },
    };
    const configured = await configureAgentReceive(options);

    const mcpPath = claudeMcpConfigPath(cwd);
    assert.equal(configured.profile, profile);
    assert.equal(configured.start_command, "claude --resume 'host-session-1' --dangerously-load-development-channels server:cswarm");
    assert.equal(
      configured.host_step,
      `Resume this same Claude session with this command and approve the channel when Claude asks. Organization policy still applies. Channel entry written to ${mcpPath}. This command does not start a separate worker.`,
    );

    // Verify .mcp.json was written at <cwd>/.mcp.json
    const info = await lstat(mcpPath);
    assert.ok(info.isFile());
    assert.equal(info.mode & 0o777, 0o600);

    const parsed = JSON.parse(await readFile(mcpPath, "utf8"));
    assert.deepEqual(parsed, {
      mcpServers: {
        [CSWARM_MCP_SERVER_NAME]: {
          command: options.execution.command,
          args: [...options.execution.args, "receive", "serve", "--profile", profile, "--host-session-id", "host-session-1"],
        },
      },
    });

    const binding = await readReceiveBinding(profile, "host-session-1");
    assert.equal(binding?.channel_config, mcpPath);
    assert.equal(binding?.requested_mode, "wake");
  } finally {
    await cleanup();
  }
});

test("wake configure preserves existing mcpServers and settings in .mcp.json", async () => {
  // Wrong implementation to pass: Completely overwrite .mcp.json, wiping out existing user MCP servers or project settings.
  const { cwd, profile, cleanup } = await setupFixture();
  try {
    const mcpPath = claudeMcpConfigPath(cwd);
    const existingConfig = {
      $schema: "https://modelcontextprotocol.io/schema.json",
      mcpServers: {
        weather: { command: "weather-cli", args: ["--unit", "celsius"] },
      },
      customProperty: 42,
    };
    await writeFile(mcpPath, JSON.stringify(existingConfig, null, 2), { mode: 0o600 });

    const options = {
      profilePath: profile, mode: "wake", provider: "claude", hostSessionId: "host-session-preserve",
      cwd, previewChannel: true, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] },
    };
    await configureAgentReceive(options);

    const parsed = JSON.parse(await readFile(mcpPath, "utf8"));
    assert.equal(parsed.customProperty, 42);
    assert.equal(parsed.$schema, "https://modelcontextprotocol.io/schema.json");
    assert.deepEqual(parsed.mcpServers.weather, { command: "weather-cli", args: ["--unit", "celsius"] });
    assert.deepEqual(parsed.mcpServers[CSWARM_MCP_SERVER_NAME], {
      command: options.execution.command,
      args: [...options.execution.args, "receive", "serve", "--profile", profile, "--host-session-id", "host-session-preserve"],
    });
  } finally {
    await cleanup();
  }
});

test("refuses configure if .mcp.json is not valid JSON or not an object", async () => {
  // Wrong implementation to pass: Silently overwrite corrupt .mcp.json files or crash with an unhandled JSON parse error.
  const { cwd, profile, cleanup } = await setupFixture();
  try {
    const mcpPath = claudeMcpConfigPath(cwd);
    const options = {
      profilePath: profile, mode: "wake", provider: "claude", hostSessionId: "host-session-corrupt",
      cwd, previewChannel: true, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] },
    };

    // Case 1: Corrupted JSON text
    await writeFile(mcpPath, "{ not valid json", { mode: 0o600 });
    await assert.rejects(
      configureAgentReceive(options),
      (err: unknown) => err instanceof AgentSetupError && err.code === "mcp_config_invalid" && err.message.includes(".mcp.json file is not valid JSON"),
    );

    // Case 2: JSON array instead of object
    await writeFile(mcpPath, "[\"item1\", \"item2\"]", { mode: 0o600 });
    await assert.rejects(
      configureAgentReceive(options),
      (err: unknown) => err instanceof AgentSetupError && err.code === "mcp_config_invalid",
    );
  } finally {
    await cleanup();
  }
});

test("refuses configure with mcp_file_tracked if .mcp.json is tracked by git", async () => {
  // Wrong implementation to pass: Allow git-tracked .mcp.json to be modified in place, or throw hook_file_tracked instead of mcp_file_tracked.
  const { cwd, profile, cleanup } = await setupFixture();
  try {
    await exec("git", ["init"], { cwd });
    const mcpPath = claudeMcpConfigPath(cwd);
    await writeFile(mcpPath, "{}", { mode: 0o600 });
    await exec("git", ["add", ".mcp.json"], { cwd });

    const options = {
      profilePath: profile, mode: "wake", provider: "claude", hostSessionId: "host-session-tracked",
      cwd, previewChannel: true, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] },
    };

    await assert.rejects(
      configureAgentReceive(options),
      (err: unknown) =>
        err instanceof AgentSetupError &&
        err.code === "mcp_file_tracked" &&
        err.message === "The .mcp.json file is tracked by git. Use an untracked or ignored .mcp.json for local channel wakeups.",
    );
  } finally {
    await cleanup();
  }
});

test("untracked .mcp.json in git repo is added to .git/info/exclude", async () => {
  // Wrong implementation to pass: Fail to add .mcp.json to .git/info/exclude, polluting developer git status with untracked files.
  const { cwd, profile, cleanup } = await setupFixture();
  try {
    await exec("git", ["init"], { cwd });
    const options = {
      profilePath: profile, mode: "wake", provider: "claude", hostSessionId: "host-session-ignore",
      cwd, previewChannel: true, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] },
    };
    await configureAgentReceive(options);

    const excludePath = join(cwd, ".git", "info", "exclude");
    const excludeContent = await readFile(excludePath, "utf8");
    assert.ok(excludeContent.includes(".mcp.json"), "exclude must contain .mcp.json");

    // git check-ignore must succeed (exit 0)
    const { stdout } = await exec("git", ["check-ignore", ".mcp.json"], { cwd });
    assert.equal(stdout.trim(), ".mcp.json");
  } finally {
    await cleanup();
  }
});

test("host with no channel running reports wake_verified: false, channel_running: false, and falls back to effective mode turn", async () => {
  // Wrong implementation to pass: Prematurely report effective_mode as wake or claim wake_verified before receiving an idle canary receipt.
  const { cwd, profile, cleanup } = await setupFixture();
  try {
    const options = {
      profilePath: profile, mode: "wake", provider: "claude", hostSessionId: "host-session-status",
      cwd, previewChannel: true, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] },
    };
    const configured = await configureAgentReceive(options);

    assert.equal(configured.wake_verified, false);
    assert.equal(configured.channel_running, false);
    assert.equal(configured.requested_mode, "wake");
    assert.equal(configured.effective_mode, "turn");

    const binding = await readReceiveBinding(profile, "host-session-status");
    const status = receiveStatus(binding);
    assert.equal(status.wake_verified, false);
    assert.equal(status.channel_running, false);
    assert.equal(status.requested_mode, "wake");
    assert.equal(status.effective_mode, "turn");
  } finally {
    await cleanup();
  }
});

test("remedy sentence in receiveStatus names the restart and contains exact path generated from CLAUDE_MCP_CONFIG_FILE", async () => {
  // Wrong implementation to pass: Hardcode a generic remedy string without naming the restart or without using CLAUDE_MCP_CONFIG_FILE / claudeMcpConfigPath.
  const { cwd, profile, cleanup } = await setupFixture();
  try {
    const options = {
      profilePath: profile, mode: "wake", provider: "claude", hostSessionId: "host-session-remedy",
      cwd, previewChannel: true, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] },
    };
    await configureAgentReceive(options);
    const mcpPath = claudeMcpConfigPath(cwd);
    const binding = await readReceiveBinding(profile, "host-session-remedy");
    assert.ok(binding);

    // Case 1: Channel not running
    const inactiveStatus = receiveStatus(binding);
    assert.equal(
      inactiveStatus.next_action,
      `Wake is not verified. Channel entry written to ${mcpPath}. Restart Claude Code to start the channel, run cswarm receive test, end the turn, then confirm with cswarm receive status. Use cswarm check meanwhile.`,
    );
    assert.ok(inactiveStatus.next_action?.includes("Restart Claude Code to start the channel"));
    assert.ok(inactiveStatus.next_action?.includes(mcpPath));

    // Case 2: Channel is live but wake not verified
    const liveBinding = {
      ...binding,
      channel_pid: process.pid,
      channel_heartbeat_at: new Date().toISOString(),
    };
    const liveStatus = receiveStatus(liveBinding);
    assert.equal(
      liveStatus.next_action,
      "The Claude channel is running. Run cswarm receive test, end the turn, then confirm with cswarm receive status. Use cswarm check meanwhile.",
    );
  } finally {
    await cleanup();
  }
});

test("reconfiguring to turn mode removes cswarm from .mcp.json and resets channel_config: null", async () => {
  // Wrong implementation to pass: Leave cswarm server in .mcp.json, delete unrelated user servers, or fail to reset channel_config to null.
  const { cwd, profile, cleanup } = await setupFixture();
  try {
    const mcpPath = claudeMcpConfigPath(cwd);
    // Setup .mcp.json with an existing server as well as cswarm
    const options = {
      profilePath: profile, mode: "wake", provider: "claude", hostSessionId: "host-session-turn",
      cwd, previewChannel: true, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] },
    };
    await configureAgentReceive(options);

    // Add another server manually into .mcp.json
    const configWithOther = JSON.parse(await readFile(mcpPath, "utf8"));
    configWithOther.mcpServers.database = { command: "db-tool" };
    await writeFile(mcpPath, JSON.stringify(configWithOther, null, 2), { mode: 0o600 });

    // Now reconfigure to turn mode
    await configureAgentReceive({ ...options, mode: "turn", previewChannel: false });

    // Verify binding state
    const turnBinding = await readReceiveBinding(profile, "host-session-turn");
    assert.equal(turnBinding?.channel_config, null);
    assert.equal(turnBinding?.requested_mode, "turn");

    // Verify .mcp.json: cswarm removed, database preserved
    const afterTurn = JSON.parse(await readFile(mcpPath, "utf8"));
    assert.equal(afterTurn.mcpServers?.[CSWARM_MCP_SERVER_NAME], undefined);
    assert.deepEqual(afterTurn.mcpServers?.database, { command: "db-tool" });

    // Now reconfigure when only cswarm was present
    const onlyCswarmOptions = {
      profilePath: profile, mode: "wake", provider: "claude", hostSessionId: "host-session-only",
      cwd, previewChannel: true, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] },
    };
    // Reset .mcp.json to empty
    await writeFile(mcpPath, "{}", { mode: 0o600 });
    await configureAgentReceive(onlyCswarmOptions);
    assert.ok(JSON.parse(await readFile(mcpPath, "utf8")).mcpServers?.[CSWARM_MCP_SERVER_NAME]);

    // Reconfigure to turn mode
    await configureAgentReceive({ ...onlyCswarmOptions, mode: "turn", previewChannel: false });
    const afterOnlyTurn = JSON.parse(await readFile(mcpPath, "utf8"));
    // When mcpServers becomes empty, mcpServers key is deleted
    assert.equal(afterOnlyTurn.mcpServers, undefined);

    const onlyTurnBinding = await readReceiveBinding(profile, "host-session-only");
    assert.equal(onlyTurnBinding?.channel_config, null);
  } finally {
    await cleanup();
  }
});

test("safety check: rejects configure if .mcp.json is a symlink", async () => {
  // Wrong implementation to pass: Follow symlinks blindly without verifying the file is an owned regular file via ownedRegular.
  const { cwd, profile, cleanup } = await setupFixture();
  try {
    const targetFile = join(cwd, "real-file.json");
    await writeFile(targetFile, "{}", { mode: 0o600 });
    const mcpPath = claudeMcpConfigPath(cwd);
    await symlink(targetFile, mcpPath);

    const options = {
      profilePath: profile, mode: "wake", provider: "claude", hostSessionId: "host-session-symlink",
      cwd, previewChannel: true, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] },
    };

    await assert.rejects(
      configureAgentReceive(options),
      (err: unknown) => err instanceof AgentSetupError && err.code === "hook_file_unsafe",
    );
  } finally {
    await cleanup();
  }
});
