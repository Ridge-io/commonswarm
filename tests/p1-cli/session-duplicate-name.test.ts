import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  createAgentPrincipalCommand,
} from "../../src/cloud/command-client.js";
import { ALLOW_DUPLICATE_NAME_FIELD } from "../../src/cloud/session-contract.js";

test("create-agent omits allow_duplicate_name unless the caller opts in", () => {
  const off = createAgentPrincipalCommand("echo");
  assert.equal(Object.hasOwn(off, ALLOW_DUPLICATE_NAME_FIELD), false);
  assert.deepEqual(off, { kind: "create_agent_principal", name: "echo" });
  const on = createAgentPrincipalCommand("echo", true);
  assert.equal(on.allow_duplicate_name, true);
  assert.equal(JSON.stringify(on).includes(`"${ALLOW_DUPLICATE_NAME_FIELD}":false`), false);
  const silent = createAgentPrincipalCommand("echo", false);
  assert.equal(Object.hasOwn(silent, ALLOW_DUPLICATE_NAME_FIELD), false);
});

async function cli(args: string[]): Promise<{ code: number; stderr: string }> {
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
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stderr };
}

test("principal create accepts --allow-duplicate-name and still rejects unknown flags", async () => {
  const accepted = await cli([
    "principal",
    "create",
    "--workspace-id",
    "00000000-0000-4000-8000-000000000001",
    "--name",
    "echo",
    "--allow-duplicate-name",
  ]);
  assert.doesNotMatch(accepted.stderr, /unknown option: --allow-duplicate-name/);
  const unknown = await cli([
    "principal",
    "create",
    "--workspace-id",
    "00000000-0000-4000-8000-000000000001",
    "--name",
    "echo",
    "--not-a-real-flag",
    "x",
  ]);
  assert.match(unknown.stderr, /unknown option: --not-a-real-flag/);
});
