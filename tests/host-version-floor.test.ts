/**
 * Adversarial controls for provider version floors.
 *
 * ★ THIS FILE IS NAMED IN `npm test`; it uses fake executables and no network,
 * provider session, or billable model prompt.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AcpPermissionCanaryError,
  AcpVersionBelowFloorError,
  AcpVersionParseError,
  GROK_LAST_MEASURED_VERSION,
  GROK_MIN_VERSION,
  assertGrokVersionFloor,
  assertProviderVersionFloor,
  compareSemVer,
  parseClaudeCodeVersionOutput,
  parseClaudeVersionOutput,
  parseCodexVersionOutput,
  parseGrokVersionOutput,
  parseOpenCodeVersionOutput,
  type GrokAcpHandle,
} from "../src/host/index.js";
import { GrokListenerModel } from "../src/listener/grok-model.js";
import { renderListenerStatus } from "../src/cli.js";
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
    lastWorkerStderrTail: null,
    providerVersion: "1.0.5",
    providerLastMeasuredVersion: "0.2.117",
    deliveryMode: null,
    pendingDeliveryCount: null,
    lastTerminalDeliveryFailureCount: null,
    routeMode: "worker",
  } as ListenerStatus);
  assert.equal(output.match(/unverified but allowed/g)?.length, 1);
  assert.match(output, /Next: verify this provider release/);
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
