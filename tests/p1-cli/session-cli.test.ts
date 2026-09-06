import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  parseSessionMode,
  parseSessionProvider,
  runHumanSessionLifecycle,
  sessionStartCopy,
} from "../../src/cloud/session-cli.js";
import {
  ENABLE_AGENT_MANAGEMENT_KIND,
  DISABLE_AGENT_MANAGEMENT_KIND,
  RECOVER_AGENT_SESSION_KIND,
} from "../../src/cloud/session-contract.js";
import { cloudTarget } from "../../src/cloud/config.js";

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SWARM_CLOUD_URL: "",
      SWARM_CLOUD_ANON_KEY: "",
      SWARM_CLOUD_WORKSPACE_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
}

test("usage advertises session verbs and does not claim status enables enforcement", async () => {
  const result = await cli(["--help"]);
  const text = `${result.stdout}${result.stderr}`;
  assert.match(text, /cswarm session start/);
  assert.match(text, /cswarm session status/);
  assert.match(text, /cswarm session stop/);
  assert.match(text, /cswarm session enable/);
  assert.match(text, /cswarm session disable/);
  assert.match(text, /cswarm session recover/);
  assert.match(text, /--allow-duplicate-name/);
  assert.match(text, /--session-context/);
  assert.match(text, /Interactive mode never starts an ACP model/);
  assert.match(text, /cswarm session start.*--foreground/);
  assert.doesNotMatch(text, /session status enables/);
});

test("session start copy is generated from the mode that actually started", () => {
  const acquired = sessionStartCopy({ mode: "interactive", runReceiver: false });
  assert.equal(acquired.mode, "acquired");
  assert.match(acquired.message, /did not claim or surface/);
  assert.match(acquired.message, /--foreground/);
  assert.doesNotMatch(acquired.message, /It claims and surfaces/);
  const foreground = sessionStartCopy({ mode: "interactive", runReceiver: true });
  assert.equal(foreground.mode, "foreground");
  assert.match(foreground.message, /claims and surfaces/);
  assert.doesNotMatch(foreground.message, /did not claim or surface/);
});

test("session parsers refuse unknown mode and provider", () => {
  assert.equal(parseSessionMode("interactive"), "interactive");
  assert.throws(() => parseSessionMode("hidden"), /--mode must be/);
  assert.equal(parseSessionProvider("codex"), "codex");
  assert.throws(() => parseSessionProvider("mystery"), /--provider must be/);
});

test("session start without mode is a usage error, not a network write", async () => {
  const result = await cli(["session", "start"]);
  assert.notEqual(result.code, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /session start needs --agent-token-file|--mode is required|too few|session requires start/i,
  );
});

test("enable disable and recover post the matching lifecycle commands", async () => {
  const kinds: string[] = [];
  const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      command: { kind: string; principal_id: string };
    };
    kinds.push(body.command.kind);
    assert.equal(body.command.principal_id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    return new Response(JSON.stringify({ ok: true, status: "accepted" }), {
      status: 200,
    });
  }) as typeof fetch;
  const input = {
    target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
    credential: "human-access",
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    principalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    fetcher,
  };
  assert.equal((await runHumanSessionLifecycle("enable", input)).kind, "enable");
  assert.equal((await runHumanSessionLifecycle("disable", input)).kind, "disable");
  assert.equal((await runHumanSessionLifecycle("recover", input)).kind, "recover");
  assert.deepEqual(kinds, [
    ENABLE_AGENT_MANAGEMENT_KIND,
    DISABLE_AGENT_MANAGEMENT_KIND,
    RECOVER_AGENT_SESSION_KIND,
  ]);
});

test("session status without a context path fails closed", async () => {
  const result = await cli(["session", "status"]);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /session-context|--session-context is required|too few/);
});
