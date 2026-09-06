import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { AgentSessionClient } from "../../src/cloud/session-client.js";
import { AgentSessionManager } from "../../src/cloud/session-manager.js";
import { AgentSessionError } from "../../src/cloud/session-errors.js";
import {
  newSessionBinding,
  writeSessionContext,
} from "../../src/cloud/session-context.js";
import {
  runListenerRuntime,
  type ListenerRuntimeModel,
} from "../../src/listener/runtime.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = `swm_agt_${"S".repeat(43)}`;

class IdleModel implements ListenerRuntimeModel {
  async start() {}
  async prompt() {
    return { message: "unused", stopReason: "end_turn" as const };
  }
  cancel() {}
  async close() {}
}

test("renew failure stops dispatch, stops the worker, and reports lease loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-lease-"));
  await chmod(root, 0o700);
  try {
    const credDir = join(root, "cred");
    await mkdir(credDir, { mode: 0o700 });
    await chmod(credDir, 0o700);
    const tokenFile = join(credDir, "token.json");
    await writeFile(tokenFile, "{}\n", { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    const context = {
      ...newSessionBinding({
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        workspaceId: WORKSPACE,
        principalId: PRINCIPAL,
        provider: "grok",
        mode: "worker",
        hostSessionId: "host-lease",
        tokenFile,
      }),
      generation: 1,
    };
    const contextPath = join(root, "session.json");
    await writeSessionContext(contextPath, context);
    const timers: Array<() => void> = [];
    const manager = new AgentSessionManager({
      client: new AgentSessionClient({
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        fetcher: (async () =>
          new Response(JSON.stringify({ error: "session_expired" }), {
            status: 403,
          })) as typeof fetch,
      }),
      credential: async () => TOKEN,
      workspaceId: WORKSPACE,
      contextPath,
      context,
      now: () => 0,
      setTimer: (callback) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });
    manager.start();
    assert.equal(manager.dispatchState(), "running");
    timers[0]!();
    for (let i = 0; i < 20 && manager.dispatchState() !== "stopped"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.dispatchState(), "stopped");
    assert.ok(manager.stopReason() instanceof AgentSessionError);
    assert.equal((manager.stopReason() as AgentSessionError).code, "session_expired");

    let lost: Error | null = null;
    const stop = await runListenerRuntime({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      workspaceId: WORKSPACE,
      principalId: PRINCIPAL,
      credentialSession: { async bearer() { return TOKEN; } },
      store: {
        async read() { return null; },
        async write() {},
      },
      model: new IdleModel(),
      now: () => Date.parse("2026-09-06T00:00:00.000Z"),
      sleep: async () => undefined,
      readPage: async () => {
        throw new Error("read must not run after lease loss");
      },
      sessionDispatch: () => manager.dispatchState(),
      sessionStopReason: () => manager.stopReason(),
      onSessionLeaseLost: (error) => {
        lost = error;
      },
    });
    assert.equal(stop.reason, "fatal");
    if (stop.reason === "fatal") {
      assert.equal(
        (stop.error as AgentSessionError).code,
        "session_expired",
      );
    }
    assert.equal((lost as unknown as AgentSessionError | null)?.code, "session_expired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
