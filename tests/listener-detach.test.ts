import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type {
  ChildProcess,
  SpawnOptions,
} from "node:child_process";
import {
  buildListenerChildArgs,
  listenerNodeExecArgv,
  spawnDetachedListener,
  type ListenerChildSpec,
} from "../src/listener/index.js";

const SPEC: ListenerChildSpec = {
  entrypoint: "/opt/cswarm/cli.js",
  url: "https://example.supabase.co",
  anonKey: "public-anon-key",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  principalId: "22222222-2222-4222-8222-222222222222",
  cwd: "/tmp/work",
  permissionMode: "deny",
  model: "grok-4.5",
  effort: "low",
  nodeExecArgv: [
    "--inspect",
    "--require",
    "/tmp/hook.js",
    "--import",
    "tsx",
    "--enable-source-maps",
  ],
};

test("detached argv is public-only and strips ambient Node hooks", () => {
  const args = buildListenerChildArgs(SPEC);
  assert.deepEqual(listenerNodeExecArgv(SPEC.nodeExecArgv ?? []), [
    "--import",
    "tsx",
    "--enable-source-maps",
  ]);
  assert.equal(args.includes("--inspect"), false);
  assert.equal(args.includes("--require"), false);
  assert.equal(args.includes("/tmp/hook.js"), false);
  assert.equal(args.includes("--agent-token-stdin"), false);
  assert.equal(args.some((value) => value.startsWith("swm_agt_")), false);
  assert.ok(args.includes("--provider"));
  assert.equal(args[args.indexOf("--provider") + 1], "grok");
  assert.deepEqual(args.slice(-4), [
    "--model",
    "grok-4.5",
    "--effort",
    "low",
  ]);
});

test("opencode detached argv pins provider and rejects effort", () => {
  const args = buildListenerChildArgs({
    ...SPEC,
    provider: "opencode",
    effort: undefined,
    opencodeExecutable: "/opt/opencode",
    executable: undefined,
  });
  assert.equal(args[args.indexOf("--provider") + 1], "opencode");
  assert.ok(args.includes("--opencode-executable"));
  assert.equal(args.includes("--effort"), false);
  assert.equal(args.includes("--grok-executable"), false);
  assert.throws(
    () =>
      buildListenerChildArgs({
        ...SPEC,
        provider: "opencode",
        effort: "low",
      }),
    /effort.*opencode/i,
  );
});

test("credential travels only over child stdin, never argv or env", async () => {
  const secret = `{"agent_token":"swm_agt_${"A".repeat(43)}"}`;
  const stdin = new PassThrough();
  let received = "";
  stdin.on("data", (chunk) => {
    received += chunk.toString("utf8");
  });
  let capturedArgs: readonly string[] = [];
  let capturedOptions: SpawnOptions = {};
  let unref = 0;
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin,
    kill: () => true,
    unref: () => {
      unref += 1;
    },
  }) as unknown as ChildProcess;

  await spawnDetachedListener({
    spec: SPEC,
    credentialArtifact: secret,
    env: {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      SWARM_AGENT_TOKEN: secret,
      DATABASE_URL: "postgres://secret",
    },
    spawnImpl: (_command, args, options) => {
      capturedArgs = args;
      capturedOptions = options;
      return child;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(received, secret);
  assert.equal(capturedArgs.join(" ").includes("swm_agt_"), false);
  assert.equal(
    JSON.stringify(capturedOptions.env ?? {}).includes("swm_agt_"),
    false,
  );
  assert.deepEqual(capturedOptions.env, {
    PATH: "/usr/bin",
    HOME: "/Users/test",
  });
  assert.equal(capturedOptions.detached, true);
  assert.deepEqual(capturedOptions.stdio, ["pipe", "ignore", "ignore"]);
  assert.equal(unref, 1);
});
