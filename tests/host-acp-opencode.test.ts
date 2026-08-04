/**
 * Pure fake-child coverage for the measured OpenCode ACP host core.
 *
 * ★ THIS FILE IS NAMED IN `npm test` — a new file under tests/ is otherwise
 * silent. No network, no live OpenCode model prompt, no billable tokens.
 */
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test, describe } from "node:test";
import {
  ACP_PROTOCOL_VERSION,
  AcpPromptsBlockedError,
  OPENCODE_FORCED_PERMISSION_TOOLS,
  OPENCODE_MEASURED_VERSION,
  buildOpenCodeAcpArgs,
  buildOpenCodeChildEnv,
  buildOpenCodeForcedPermissionConfig,
  buildOpenCodeSafeConfigJson,
  isEnvKeyDenied,
  openAcpSessionOverStdio,
  parseOpenCodeVersionOutput,
  prepareOpenCodeIsolatedHome,
  readValidatedOpenCodeAuth,
  resolveOpenCodeExecutable,
  sanitizeChildEnv,
} from "../src/host/index.js";

function tempCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cswarm-oc-acp-"));
}

type FakeAgentScript = {
  onRequest?: (
    id: number | string,
    method: string,
    params: unknown,
    reply: {
      result: (value: unknown) => void;
      error: (code: number, message: string) => void;
      notify: (method: string, params?: unknown) => void;
      request: (id: number | string, method: string, params: unknown) => void;
    },
  ) => void | Promise<void>;
};

function createFakeChild(script: FakeAgentScript = {}) {
  const agentOut = new PassThrough();
  const hostWritable = new PassThrough();
  const hostReadable = agentOut;
  let buf = "";
  hostWritable.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      void handleAgentLine(line);
    }
  });

  const reply = {
    result: (id: number | string, value: unknown) => {
      agentOut.write(JSON.stringify({ jsonrpc: "2.0", id, result: value }) + "\n");
    },
    error: (id: number | string, code: number, message: string) => {
      agentOut.write(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
      );
    },
    notify: (method: string, params?: unknown) => {
      const frame: Record<string, unknown> = { jsonrpc: "2.0", method };
      if (params !== undefined) frame.params = params;
      agentOut.write(JSON.stringify(frame) + "\n");
    },
    request: (id: number | string, method: string, params: unknown) => {
      agentOut.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    },
  };

  async function handleAgentLine(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.method === "string" && msg.id !== undefined && msg.id !== null) {
      const id = msg.id as number | string;
      const method = msg.method;
      const params = msg.params;
      const api = {
        result: (value: unknown) => reply.result(id, value),
        error: (code: number, message: string) => reply.error(id, code, message),
        notify: reply.notify,
        request: reply.request,
      };
      if (script.onRequest) {
        await script.onRequest(id, method, params, api);
        return;
      }
      if (method === "initialize") {
        api.result({
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true },
          _meta: { agentVersion: OPENCODE_MEASURED_VERSION },
        });
        return;
      }
      if (method === "session/new") {
        api.result({ sessionId: "sess-oc" });
        return;
      }
      if (method === "session/prompt") {
        api.notify("session/update", {
          sessionId: "sess-oc",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ok" },
          },
        });
        api.result({ stopReason: "end_turn" });
        return;
      }
      api.error(-32601, `unknown ${method}`);
    }
  }

  return {
    readable: hostReadable,
    writable: hostWritable,
    reply,
    close() {
      hostWritable.end();
      agentOut.end();
    },
  };
}

describe("OpenCode ACP host core (pure)", () => {
  test("argv is only acp --pure; version pin; forced-ask config covers every tool + wildcard", () => {
    assert.deepEqual(buildOpenCodeAcpArgs(), ["acp", "--pure"]);
    assert.equal(parseOpenCodeVersionOutput("1.18.10\n"), "1.18.10");
    assert.equal(parseOpenCodeVersionOutput("opencode 1.18.10"), "1.18.10");
    assert.equal(parseOpenCodeVersionOutput("1.19.0"), "1.19.0");
    assert.equal(OPENCODE_MEASURED_VERSION, "1.18.10");
    const permission = buildOpenCodeForcedPermissionConfig();
    for (const tool of OPENCODE_FORCED_PERMISSION_TOOLS) {
      assert.equal(permission[tool], "ask", tool);
    }
    assert.equal(permission["*"], "ask");
    const json = JSON.parse(buildOpenCodeSafeConfigJson({ model: "kimi" }));
    assert.equal(json.model, "kimi");
    assert.equal(json.permission.bash, "ask");
    assert.equal(json.permission.external_directory, "ask");
  });

  test("child env strips secrets and CommonSwarm credentials (causal control)", () => {
    const home = "/tmp/cswarm-oc-home-example";
    const env = buildOpenCodeChildEnv(
      {
        PATH: "/usr/bin",
        HOME: "/Users/real",
        SWARM_CLOUD_ANON_KEY: "secret-anon",
        OPENAI_API_KEY: "sk-test",
        TOKEN: "nope",
        LANG: "en_US.UTF-8",
      },
      home,
    );
    assert.equal(env.HOME, home);
    assert.equal(env.XDG_DATA_HOME, join(home, "xdg-data"));
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
    assert.equal(env.SWARM_CLOUD_ANON_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.TOKEN, undefined);
    // Causal negative control: a denylisted key is reported denied, and an
    // allowlisted key is not — proves the instrument can fail both ways.
    assert.equal(isEnvKeyDenied("SWARM_AGENT_TOKEN"), true);
    assert.equal(isEnvKeyDenied("PATH"), false);
    const sanitized = sanitizeChildEnv({
      PATH: "/bin",
      SWARM_X: "1",
      SECRET_TOKEN: "x",
    });
    assert.equal(sanitized.SWARM_X, undefined);
    assert.equal(sanitized.SECRET_TOKEN, undefined);
    assert.equal(sanitized.PATH, "/bin");
  });

  test("OpenCode child env keeps forced-ask config without a relation kill-switch", () => {
    const home = "/tmp/cswarm-oc-home-example";
    const env = buildOpenCodeChildEnv(
      { PATH: "/usr/bin", OPENCODE_PERMISSION: '{"*":"allow"}' },
      home,
    );
    assert.equal(
      env.OPENCODE_PERMISSION,
      undefined,
      "CommonSwarm must not install a relation-specific tool kill-switch",
    );
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  });

  test("auth validation requires owned 0600 regular bounded JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cswarm-oc-auth-"));
    const path = join(dir, "auth.json");
    await writeFile(path, '{"ok":true}', { mode: 0o600 });
    await chmod(path, 0o600);
    const raw = await readValidatedOpenCodeAuth(path);
    assert.ok(raw);
    assert.equal(JSON.parse(raw!.toString("utf8")).ok, true);

    await chmod(path, 0o644);
    await assert.rejects(
      () => readValidatedOpenCodeAuth(path),
      /opencode_auth_insecure|0600/,
    );
    await chmod(path, 0o600);
    await writeFile(path, "not-json", { mode: 0o600 });
    await chmod(path, 0o600);
    await assert.rejects(
      () => readValidatedOpenCodeAuth(path),
      /opencode_auth_malformed|malformed/,
    );
    await assert.rejects(
      () => readValidatedOpenCodeAuth(join(dir, "missing.json")),
      /opencode_auth_missing|not signed in/,
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("prepareOpenCodeIsolatedHome copies auth only and writes forced-ask config", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "cswarm-oc-src-"));
    const dataDir = join(sourceRoot, "opencode");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const authPath = join(dataDir, "auth.json");
    await writeFile(authPath, '{"token":"x"}', { mode: 0o600 });
    await chmod(authPath, 0o600);
    const home = await prepareOpenCodeIsolatedHome({
      env: { XDG_DATA_HOME: sourceRoot, HOME: sourceRoot, PATH: "/usr/bin" },
      model: "openrouter/moonshotai/kimi-k3",
    });
    const st = await stat(home);
    assert.equal((st.mode & 0o777), 0o700);
    const copied = join(home, "xdg-data", "opencode", "auth.json");
    const authSt = await stat(copied);
    assert.equal((authSt.mode & 0o777), 0o600);
    assert.equal(JSON.parse(await readFile(copied, "utf8")).token, "x");
    const config = JSON.parse(
      await readFile(join(home, "xdg-config", "opencode", "opencode.json"), "utf8"),
    );
    assert.equal(config.permission.bash, "ask");
    assert.equal(config.permission["*"], "ask");
    assert.equal(config.model, "openrouter/moonshotai/kimi-k3");
    // No leakage of ambient allow-all project config — only generated file.
    assert.equal(config.permission.edit, "ask");
    await rm(home, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  });


  test("resolveOpenCodeExecutable requires absolute realpath (no bare ambiguous spawn)", () => {
    // Use this process binary as a portable absolute executable (no machine paths).
    const abs = resolveOpenCodeExecutable(process.execPath);
    assert.equal(abs.startsWith("/"), true);
    assert.throws(
      () => resolveOpenCodeExecutable("no-such-opencode-binary-zzzz"),
      /not found|not executable|realpath/i,
    );
  });

  test("canary requires permission request AND denied tool result (negative + positive)", async () => {
    const cwd = await tempCwd();
    try {
      const fake = createFakeChild({
        onRequest: async (_id, method, params, api) => {
          if (method === "initialize") {
            api.result({
              protocolVersion: ACP_PROTOCOL_VERSION,
              _meta: { agentVersion: OPENCODE_MEASURED_VERSION },
            });
            return;
          }
          if (method === "session/new") {
            api.result({ sessionId: "s-canary" });
            return;
          }
          if (method === "session/prompt") {
            const text = String(
              (params as { prompt?: Array<{ text?: string }> })?.prompt?.[0]?.text ??
                "",
            );
            if (text.includes("canary")) {
              api.request(42, "session/request_permission", {
                sessionId: "s-canary",
                toolCall: { toolCallId: "c1", title: "bash", kind: "bash" },
                options: [
                  { optionId: "a", name: "Allow", kind: "allow_once" },
                  { optionId: "r", name: "Reject", kind: "reject_once" },
                ],
              });
              await new Promise((r) => setTimeout(r, 15));
              api.notify("session/update", {
                sessionId: "s-canary",
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: "c1",
                  status: "failed",
                  content: [
                    {
                      type: "content",
                      content: { type: "text", text: "permission denied by host" },
                    },
                  ],
                },
              });
              api.result({ stopReason: "end_turn" });
              return;
            }
            api.notify("session/update", {
              sessionId: "s-canary",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "ok" },
              },
            });
            api.result({ stopReason: "end_turn" });
          }
        },
      });
      const { session } = await openAcpSessionOverStdio({
        cwd,
        readable: fake.readable,
        writable: fake.writable,
        requestTimeoutMs: 5_000,
      });
      assert.equal(session.arePromptsEnabled, false);
      await assert.rejects(
        () => session.prompt("real work"),
        (e: unknown) => e instanceof AcpPromptsBlockedError,
      );

      // Negative: permission request alone without denied tool fails.
      const halfFake = createFakeChild({
        onRequest: async (_id, method, _params, api) => {
          if (method === "initialize") {
            api.result({ protocolVersion: ACP_PROTOCOL_VERSION });
            return;
          }
          if (method === "session/new") {
            api.result({ sessionId: "s-half" });
            return;
          }
          if (method === "session/prompt") {
            api.request(77, "session/request_permission", {
              sessionId: "s-half",
              options: [{ optionId: "r", name: "Reject", kind: "reject_once" }],
              toolCall: { toolCallId: "t2", title: "read", kind: "read" },
            });
            await new Promise((r) => setTimeout(r, 15));
            api.result({ stopReason: "end_turn" });
          }
        },
      });
      const half = await openAcpSessionOverStdio({
        cwd,
        readable: halfFake.readable,
        writable: halfFake.writable,
        requestTimeoutMs: 5_000,
      });
      const halfResult = await half.session.runPermissionBoundaryCanary({
        timeoutMs: 2_000,
      });
      assert.equal(halfResult.passed, false);
      assert.equal(halfResult.sawPermissionRequest, true);
      assert.equal(halfResult.sawDeniedToolResult, false);
      await half.session.close();
      halfFake.close();

      // Negative: no permission request at all.
      const failFake = createFakeChild({
        onRequest: async (_id, method, _params, api) => {
          if (method === "initialize") {
            api.result({ protocolVersion: ACP_PROTOCOL_VERSION });
            return;
          }
          if (method === "session/new") {
            api.result({ sessionId: "s-fail" });
            return;
          }
          if (method === "session/prompt") {
            api.result({ stopReason: "end_turn" });
          }
        },
      });
      const fail = await openAcpSessionOverStdio({
        cwd,
        readable: failFake.readable,
        writable: failFake.writable,
        requestTimeoutMs: 5_000,
      });
      const failResult = await fail.session.runPermissionBoundaryCanary({
        timeoutMs: 2_000,
      });
      assert.equal(failResult.passed, false);
      assert.equal(failResult.sawPermissionRequest, false);
      await fail.session.close();
      failFake.close();

      // Positive canary path.
      await session.enablePromptsAfterCanary({ timeoutMs: 5_000 });
      assert.equal(session.arePromptsEnabled, true);
      const obs = session.canaryObservation;
      assert.equal(obs.sawPermissionRequest, true);
      assert.equal(obs.sawDeniedToolResult, true);
      const out = await session.prompt("real work");
      assert.equal(out.message, "ok");
      await session.close();
      fake.close();

      // Negative: matching toolCallId on the wrong sessionId must not unlock.
      const mismatchFake = createFakeChild({
        onRequest: async (_id, method, params, api) => {
          if (method === "initialize") {
            api.result({ protocolVersion: ACP_PROTOCOL_VERSION });
            return;
          }
          if (method === "session/new") {
            api.result({ sessionId: "s-active" });
            return;
          }
          if (method === "session/prompt") {
            api.request(88, "session/request_permission", {
              sessionId: "s-other",
              options: [{ optionId: "r", name: "Reject", kind: "reject_once" }],
              toolCall: { toolCallId: "c9", title: "bash", kind: "bash" },
            });
            await new Promise((r) => setTimeout(r, 15));
            api.notify("session/update", {
              sessionId: "s-other",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "c9",
                status: "failed",
              },
            });
            // Also try a terminal update on the active session without a matching reject key.
            api.notify("session/update", {
              sessionId: "s-active",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "c9",
                status: "failed",
              },
            });
            api.result({ stopReason: "end_turn" });
          }
        },
      });
      const mismatch = await openAcpSessionOverStdio({
        cwd,
        readable: mismatchFake.readable,
        writable: mismatchFake.writable,
        requestTimeoutMs: 5_000,
      });
      const mismatchResult = await mismatch.session.runPermissionBoundaryCanary({
        timeoutMs: 2_000,
      });
      assert.equal(mismatchResult.passed, false);
      assert.equal(mismatchResult.sawPermissionRequest, false);
      assert.equal(mismatchResult.sawDeniedToolResult, false);
      await mismatch.session.close();
      mismatchFake.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
