/**
 * Adversarial controls for provider version floors.
 *
 * ★ THIS FILE IS NAMED IN `npm test`; it uses fake executables and no network,
 * provider session, or billable model prompt.
 */
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AcpPermissionCanaryError,
  AcpVersionBelowFloorError,
  AcpVersionError,
  AcpVersionParseError,
  CODEX_ACP_LAST_MEASURED_VERSION,
  CODEX_ACP_MIN_VERSION,
  GROK_LAST_MEASURED_VERSION,
  GROK_MIN_VERSION,
  assertGrokVersionFloor,
  assertCodexVersionFloor,
  assertProviderVersionFloor,
  compareSemVer,
  inspectClaudeBridgeExecutable,
  parseClaudeCodeVersionOutput,
  parseClaudeVersionOutput,
  parseCodexVersionOutput,
  parseGrokVersionOutput,
  parseOpenCodeVersionOutput,
  type GrokAcpHandle,
} from "../src/host/index.js";
import { GrokListenerModel } from "../src/listener/grok-model.js";
import {
  listenerFailureMessage,
  listenerStatusJson,
  renderListenerStatus,
} from "../src/cli.js";
import type { ListenerStatus } from "../src/listener/control.js";

test("floor boundary refuses floor-1 and accepts the floor and floor+1", () => {
  assert.throws(
    () => assertProviderVersionFloor({
      provider: "grok",
      version: "0.2.116",
      minimumVersion: GROK_MIN_VERSION,
      lastMeasuredVersion: GROK_LAST_MEASURED_VERSION,
    }),
    (error: unknown) =>
      error instanceof AcpVersionBelowFloorError &&
      error.code === "version_below_floor",
  );
  assert.doesNotThrow(() => assertProviderVersionFloor({
    provider: "grok",
    version: GROK_MIN_VERSION,
    minimumVersion: GROK_MIN_VERSION,
    lastMeasuredVersion: GROK_LAST_MEASURED_VERSION,
  }));
  assert.doesNotThrow(() => assertProviderVersionFloor({
    provider: "grok",
    version: "0.2.118",
    minimumVersion: GROK_MIN_VERSION,
    lastMeasuredVersion: GROK_LAST_MEASURED_VERSION,
  }));
});

test("real Grok drift 1.0.5 is accepted above the 0.2.117 floor", () => {
  assert.doesNotThrow(() => assertProviderVersionFloor({
    provider: "grok",
    version: "1.0.5",
    minimumVersion: "0.2.117",
    lastMeasuredVersion: "0.2.117",
  }));
});

test("SemVer precedence is numeric, not lexical", () => {
  assert.equal(compareSemVer("0.2.117", "0.10.0"), -1);
  assert.equal(compareSemVer("0.10.0", "1.0.5"), -1);
  assert.equal(compareSemVer("0.10.0", "0.2.117"), 1);
  assert.equal("0.10.0" < "0.2.117", true, "control: lexical ordering disagrees");
  assert.equal(compareSemVer("2.1.236-canary.1", "2.1.236"), -1);
  assert.equal(compareSemVer("2.1.236+build.7", "2.1.236"), 0);
});

test("provider parsers handle prerelease, build, product suffix, and leading banners", () => {
  assert.equal(
    parseGrokVersionOutput(
      "Node 22.0.0 warning: grok needs a supported runtime\ngrok 1.0.5+build.7\n",
    ),
    "1.0.5+build.7",
  );
  assert.equal(
    parseOpenCodeVersionOutput("update banner\nopencode 1.18.21-beta.1\n"),
    "1.18.21-beta.1",
  );
  assert.equal(
    parseClaudeVersionOutput("ExperimentalWarning\n0.65.0-canary.1+build.7\n"),
    "0.65.0-canary.1+build.7",
  );
  assert.equal(
    parseClaudeCodeVersionOutput("update available\n2.1.236-canary.1 (Claude Code)\n"),
    "2.1.236-canary.1",
  );
  assert.equal(
    parseCodexVersionOutput("node warning\n@agentclientprotocol/codex-acp 1.2.0+build.7\n"),
    "1.2.0+build.7",
  );
  assert.equal(parseCodexVersionOutput("codex-cli 0.147.0\n"), null);
});

test("Codex CLI banner fails with executable_not_bridge while codex-acp parses", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-cli-shape-"));
  const codexCli = join(root, "codex");
  const codexAcp = join(root, "codex-acp");
  try {
    await writeFile(
      codexCli,
      `#!${process.execPath}\nprocess.stdout.write("codex-cli 0.147.0\\n");\n`,
      { mode: 0o700 },
    );
    await writeFile(
      codexAcp,
      `#!${process.execPath}\nprocess.stdout.write("@agentclientprotocol/codex-acp 1.8.0\\n");\n`,
      { mode: 0o700 },
    );
    await Promise.all([chmod(codexCli, 0o700), chmod(codexAcp, 0o700)]);
    await assert.rejects(
      () => assertCodexVersionFloor(codexCli),
      (error: unknown) => {
        assert.ok(error instanceof AcpVersionError);
        assert.equal(error.code, "executable_not_bridge");
        assert.match(error.message, /this is the Codex CLI/);
        assert.match(error.message, /--codex-executable takes the codex-acp bridge/);
        assert.match(error.message, /npm i -g @agentclientprotocol\/codex-acp/);
        return true;
      },
    );
    assert.equal(await assertCodexVersionFloor(codexAcp), "1.8.0");
    assert.equal(CODEX_ACP_MIN_VERSION, "1.1.9");
    assert.equal(CODEX_ACP_LAST_MEASURED_VERSION, "1.8.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex canary reason shapes render their recorded next steps", () => {
  const executed =
    "canary_executed_without_permission: codex-acp 1.8.0 ran the shell probe without a permission request and wrote /operator/.cswarm/canary/sentinel. Next: replace codex-acp 1.8.0 with a bridge version that asks before writing /operator/.cswarm/canary/sentinel";
  const noTool =
    "canary_no_tool_call: codex-acp 1.8.0 did not request permission or create /operator/.cswarm/canary/sentinel. Next: retry to re-sample the model's shell choice";
  const timeout =
    "canary_timeout: ACP request timed out: session/prompt (failed 2 attempts). Next: retry to run a fresh bounded permission canary";
  const pathInsideCwd =
    "canary_path_inside_cwd: /operator/.cswarm/canary is inside listener cwd /operator. Next: pass a --cwd that is not your home directory";
  const details = [executed, noTool, timeout, pathInsideCwd];
  const rendered = details.map((detail) =>
    listenerFailureMessage("permission_canary_failed", "codex", detail)
  );

  assert.equal(new Set(rendered).size, details.length);
  for (let index = 0; index < rendered.length; index += 1) {
    assert.ok(rendered[index]!.includes(JSON.stringify(details[index]!)));
    assert.match(rendered[index]!, /no workspace signal prompt was delivered/i);
    assert.match(rendered[index]!, /permission safety gate/i);
    assert.doesNotMatch(rendered[index]!, /sign[- ]?in/i);
  }
  assert.match(rendered[0]!, /codex-acp 1\.8\.0.*\.cswarm\/canary\/sentinel/);
  assert.match(rendered[1]!, /retry to re-sample/);
  assert.match(rendered[2]!, /ACP request timed out: session\/prompt/);
  assert.match(rendered[3]!, /pass a --cwd that is not your home directory/);
  assert.doesNotMatch(
    rendered[3]!,
    /bridge did not complete|canary (?:ran|was sent)/i,
  );
});

test("Codex CLI executable remedy names the bridge package", () => {
  const message = listenerFailureMessage("executable_not_bridge", "codex");
  assert.match(message, /this is the Codex CLI/);
  assert.match(message, /--codex-executable takes the codex-acp bridge/);
  assert.match(message, /npm i -g @agentclientprotocol\/codex-acp/);
});

test("Claude status/start rendering pins the resolved bridge and exact bundled versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-claude-runtime-version-"));
  const adapterRoot = join(
    root,
    "node_modules",
    "@agentclientprotocol",
    "claude-agent-acp",
  );
  const executable = join(adapterRoot, "dist", "index.js");
  const sdkRoot = join(
    adapterRoot,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
  );
  try {
    await mkdir(join(adapterRoot, "dist"), { recursive: true });
    await mkdir(sdkRoot, { recursive: true });
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write("0.73.0\\n");\n`,
      { mode: 0o700 },
    );
    await writeFile(
      join(adapterRoot, "package.json"),
      JSON.stringify({
        name: "@agentclientprotocol/claude-agent-acp",
        version: "0.73.0",
      }),
    );
    await writeFile(join(sdkRoot, "sdk.mjs"), "export {};\n");
    await writeFile(
      join(sdkRoot, "package.json"),
      JSON.stringify({
        name: "@anthropic-ai/claude-agent-sdk",
        version: "0.3.257",
        claudeCodeVersion: "2.1.257",
        type: "module",
        main: "sdk.mjs",
      }),
    );
    await chmod(executable, 0o700);

    const measured = await inspectClaudeBridgeExecutable(executable, {
      pathEnv: "/unused",
      env: { PATH: "/unused" },
    });
    assert.equal(measured.executable, await realpath(executable));
    assert.equal(measured.providerVersion, "0.73.0");
    assert.equal(measured.bundledAgentSdkVersion, "0.3.257");
    assert.equal(measured.bundledClaudeCodeVersion, "2.1.257");

    const status = {
      state: "failed",
      provider: "claude",
      principalId: "11111111-1111-4111-8111-111111111111",
      pid: 123,
      startedAt: "2026-09-01T00:00:00.000Z",
      readyAt: null,
      lastSignalId: null,
      lastErrorCode: "permission_canary_failed",
      lastErrorDetail: "unknown bridge response",
      lastErrorReasonCode: "claude_canary_unknown",
      lastWorkerStderrTail: null,
      providerExecutable: measured.executable,
      providerVersion: measured.providerVersion,
      providerLastMeasuredVersion: measured.lastMeasuredVersion,
      providerBundledAgentSdkVersion: measured.bundledAgentSdkVersion,
      providerBundledClaudeCodeVersion: measured.bundledClaudeCodeVersion,
      providerMinimumRequiredVersion: null,
      deliveryMode: null,
      pendingDeliveryCount: null,
      lastTerminalDeliveryFailureCount: null,
      lastAckOutcome: null,
      consecutiveAckFailureCount: null,
      routeMode: "worker",
    } as ListenerStatus;
    const rendered = renderListenerStatus(status);
    assert.ok(rendered.includes(`Provider executable: ${measured.executable}`));
    assert.match(rendered, /Provider version 0\.73\.0/);
    assert.match(rendered, /Bundled Claude Code version: 2\.1\.257/);
    assert.match(rendered, /Bundled Claude agent SDK version: 0\.3\.257/);
    assert.match(rendered, /compatibility was not established/);
    assert.doesNotMatch(rendered, /canary passed/);

    const json = listenerStatusJson(status);
    assert.equal(json.providerExecutable, measured.executable);
    assert.equal(json.providerExecutableMeasured, true);
    assert.equal(json.providerVersion, "0.73.0");
    assert.equal(json.providerVersionMeasured, true);
    assert.equal(json.providerBundledClaudeCodeVersion, "2.1.257");
    assert.equal(json.providerBundledAgentSdkVersion, "0.3.257");
    assert.equal(json.connectionsOpened, null);
    assert.equal(json.connectionReuseRatio, null);
    assert.equal(json.handledState, "not_yet_measured");

    const oldProcess = {
      ...status,
      providerVersion: "0.70.0",
      providerLastMeasuredVersion: "0.64.2",
      providerBundledAgentSdkVersion: "0.3.232",
      providerBundledClaudeCodeVersion: "2.1.232",
      providerMinimumRequiredVersion: "2.1.251",
    };
    const installed = {
      executable: measured.executable,
      providerVersion: measured.providerVersion,
      bundledAgentSdkVersion: measured.bundledAgentSdkVersion,
      bundledClaudeCodeVersion: measured.bundledClaudeCodeVersion,
    };
    const drift = renderListenerStatus(
      oldProcess,
      undefined,
      Date.now(),
      installed,
    );
    assert.match(drift, /claude_bridge_below_api_minimum/);
    assert.match(drift, /below the API minimum 2\.1\.251/);
    assert.match(drift, /Restart to pick up 0\.73\.0/);
    const driftJson = listenerStatusJson(
      oldProcess,
      undefined,
      undefined,
      Date.now(),
      installed,
    );
    assert.equal(driftJson.providerBelowDemandedMinimum, true);
    assert.equal(driftJson.providerRestartRequired, true);
    assert.equal(driftJson.providerOnDiskVersion, "0.73.0");

    const notMeasured = renderListenerStatus({
      ...status,
      providerExecutable: null,
      providerVersion: null,
      providerLastMeasuredVersion: null,
      providerBundledAgentSdkVersion: null,
      providerBundledClaudeCodeVersion: null,
    });
    assert.match(notMeasured, /Provider executable: not measured/);
    assert.match(notMeasured, /Provider version: not measured/);
    assert.match(notMeasured, /Bundled Claude Code version: not measured/);
    assert.match(notMeasured, /Connections opened: not measured/);
    assert.match(notMeasured, /Connection reuse ratio: not measured/);
    assert.equal(
      listenerStatusJson({ ...status, providerVersion: null }).providerVersionMeasured,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude canary failure shapes keep the bridge response and choose only measured remedies", () => {
  const versionRequired =
    "Internal error: API Error: 400 Claude Code 2.1.232 does not support this model; version 2.1.251 or newer is required. Run 'claude update'";
  const authFailure =
    "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed (failed 2 attempts)";
  const timeout = "ACP request timed out: session/prompt (failed 2 attempts)";
  const unknown = "bridge returned an unfamiliar refusal without a typed cause";

  const versionMessage = listenerFailureMessage(
    "permission_canary_failed",
    "claude",
    versionRequired,
    "claude_bridge_version_required",
  );
  assert.match(versionMessage, /\[claude_bridge_version_required\]/);
  assert.ok(versionMessage.includes(JSON.stringify(versionRequired)));
  assert.match(
    versionMessage,
    /install the current bridge \(npm i -g @agentclientprotocol\/claude-agent-acp@latest\)/i,
  );
  assert.match(versionMessage, /restart the listener/i);
  assert.match(versionMessage, /cswarm listen status/i);
  assert.match(versionMessage, /bundled Claude Code version meets the API minimum 2\.1\.251/i);
  assert.doesNotMatch(versionMessage, /bundles a newer Claude Code/i);
  assert.doesNotMatch(versionMessage, /confirm.*sign-in/i);
  assert.doesNotMatch(versionMessage, /Next: run ['"]?claude update/i);

  const authMessage = listenerFailureMessage(
    "permission_canary_failed",
    "claude",
    authFailure,
  );
  assert.match(authMessage, /\[claude_canary_auth_failed\]/);
  assert.doesNotMatch(authMessage, /\bclaude login\b/i);
  assert.match(authMessage, /as the operator, sign in with claude auth login on this host/i);
  assert.match(authMessage, /or start claude interactively and complete the prompt/i);
  assert.match(authMessage, /then run cswarm listen start again/i);
  assert.match(authMessage, /Every Claude-provider listener on this host shares that session/i);
  assert.doesNotMatch(authMessage, /network/i);
  assert.doesNotMatch(authMessage, /update the bridge/);

  const timeoutMessage = listenerFailureMessage(
    "permission_canary_failed",
    "claude",
    timeout,
    "claude_canary_timeout",
  );
  assert.match(timeoutMessage, /\[claude_canary_timeout\]/);
  assert.match(timeoutMessage, /run claude -p.*session-limit.*host load.*retry/i);
  assert.doesNotMatch(timeoutMessage, /keychain|OAuth|update the bridge/i);

  const unknownMessage = listenerFailureMessage(
    "permission_canary_failed",
    "claude",
    unknown,
  );
  assert.match(unknownMessage, /\[claude_canary_unknown\]/);
  assert.ok(unknownMessage.includes(JSON.stringify(unknown)));
  assert.match(unknownMessage, /cause was not determined/i);
  assert.doesNotMatch(unknownMessage, /keychain|OAuth|update the bridge/i);
});

test("unparseable version fails closed with a code distinct from below-floor", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-version-unparseable-"));
  const executable = join(root, "grok");
  try {
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write("grok tomorrow\\n");\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    await assert.rejects(
      () => assertGrokVersionFloor(executable),
      (error: unknown) =>
        error instanceof AcpVersionParseError &&
        error.code === "version_unparseable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("newer version reports exactly once to the startup status path", () => {
  const notices: string[] = [];
  assertProviderVersionFloor({
    provider: "grok",
    version: "1.0.5",
    minimumVersion: GROK_MIN_VERSION,
    lastMeasuredVersion: GROK_LAST_MEASURED_VERSION,
    onNewerVersion: (notice) => {
      notices.push(
        `${notice.provider}:${notice.runningVersion}:${notice.lastMeasuredVersion}`,
      );
    },
  });
  assert.deepEqual(notices, ["grok:1.0.5:0.2.117"]);
  const output = renderListenerStatus({
    state: "ready",
    provider: "grok",
    principalId: "11111111-1111-4111-8111-111111111111",
    pid: 123,
    startedAt: "2026-08-27T00:00:00.000Z",
    readyAt: "2026-08-27T00:00:01.000Z",
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    lastWorkerStderrTail: null,
    providerVersion: "1.0.5",
    providerLastMeasuredVersion: "0.2.117",
    deliveryMode: null,
    pendingDeliveryCount: null,
    lastTerminalDeliveryFailureCount: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: null,
    routeMode: "worker",
  } as ListenerStatus);
  assert.equal(output.match(/unverified but allowed/g)?.length, 1);
  assert.match(output, /Next: verify this provider release/);
  assert.match(output, /HANDLED: not yet measured/);
});

test("an exactly measured Codex version renders without an unverified warning", () => {
  const output = renderListenerStatus({
    state: "ready",
    provider: "codex",
    principalId: "11111111-1111-4111-8111-111111111111",
    pid: 123,
    startedAt: "2026-09-02T00:00:00.000Z",
    readyAt: "2026-09-02T00:00:01.000Z",
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    lastWorkerStderrTail: null,
    providerVersion: "1.8.0",
    providerLastMeasuredVersion: "1.8.0",
    deliveryMode: null,
    pendingDeliveryCount: null,
    lastTerminalDeliveryFailureCount: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: null,
    routeMode: "worker",
  } as ListenerStatus);
  assert.match(output, /Provider version: 1\.8\.0 \(last measured: 1\.8\.0\)/);
  assert.doesNotMatch(output, /unverified|newer than/);
  assert.match(output, /HANDLED: not yet measured/);
});

test("a comfortably newer version cannot bypass a failing permission canary", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-version-canary-"));
  const executable = join(root, "grok");
  let canaryCalls = 0;
  let closeCalls = 0;
  try {
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write("grok 9.0.0\\n");\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const model = new GrokListenerModel({
      cwd: root,
      executable,
      open: async (options): Promise<GrokAcpHandle> => {
        await assertGrokVersionFloor(options.executable!);
        return {
          session: {
            async enablePromptsAfterCanary() {
              canaryCalls += 1;
              throw new AcpPermissionCanaryError("adversarial canary refusal");
            },
          },
          child: {},
          executable,
          args: [],
          env: {},
          async close() {
            closeCalls += 1;
          },
        } as unknown as GrokAcpHandle;
      },
    });
    await assert.rejects(
      () => model.start(),
      (error: unknown) =>
        error instanceof AcpPermissionCanaryError &&
        error.code === "permission_canary_failed",
    );
    assert.equal(canaryCalls, 1, "the high version must reach the canary");
    assert.equal(closeCalls, 1, "a canary failure must close the worker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
