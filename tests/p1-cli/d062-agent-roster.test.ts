import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

/* D-062. A roster existed — `cswarm status` lists every member and agent with names, UUIDs and
 * owners — and it refused `--agent-token-stdin` at its shape gate. So the one party that needs a
 * roster in order to address a signal was the one party that could not read one.
 *
 * The cost was measured: a principal named `Wren` existed in the workspace, `--to Wren` resolved
 * to it, and it was not the Wren anyone meant. Three agents spent about twenty hours on that,
 * and no supported command could have shown it.
 *
 * `cswarm members` closes it. These tests pin the two halves that matter:
 *   1. `members` reaches its work with an agent credential — it does not die at the shape gate;
 *   2. `status` STILL refuses that credential, which is deliberate, not an oversight.
 *
 * (2) is the load-bearing one. `runStatus` is built on `humanCredential` throughout —
 * `human.userId`, `human.deviceId`, `profileIdentity(human)` — and speaks as "You:". Widening
 * its gate moves the failure deeper instead of fixing it. If someone later "fixes the
 * inconsistency" by adding the flag there, this test should fail and send them here. */

async function cli(
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    ...args,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SWARM_CLOUD_URL: "",
      SWARM_CLOUD_ANON_KEY: "",
      SWARM_CLOUD_WORKSPACE_ID: "",
    },
    // Always pipe. A conditional stdio tuple stops TypeScript narrowing stdout/stderr to
    // non-null, and closing an unused stdin is equivalent to "ignore" for these verbs.
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(stdin ?? "");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
}

const WORKSPACE = "00000000-0000-4000-8000-000000000001";

test("D-062: `members` accepts an agent credential — it does not die at the shape gate", async () => {
  const result = await cli([
    "members",
    "--workspace-id",
    WORKSPACE,
    "--agent-token-stdin",
  ], "{}");

  assert.doesNotMatch(
    result.stderr,
    /unknown option: --agent-token-stdin/,
    "members refuses agent credentials — the defect is back",
  );

  // CONTROL, same verb and shape. Without it, the assertion above is equally satisfied by a
  // verb that validates nothing, which would be a worse defect and would look identical.
  // The control carries a VALUE: an unrecognised flag is not in BOOLEAN_FLAGS, so the parser
  // rejects it as value-taking BEFORE the shape gate, and a bare flag would test the parser
  // rather than the validator this test is about.
  const control = await cli([
    "members",
    "--workspace-id",
    WORKSPACE,
    "--not-a-real-flag",
    "x",
  ]);
  assert.match(
    control.stderr,
    /unknown option: --not-a-real-flag/,
    "members no longer validates its options at all",
  );
});

test("D-062: `members` is a real verb, not an unknown command", async () => {
  const result = await cli(["members", "--workspace-id", WORKSPACE]);
  assert.doesNotMatch(result.stderr, /unknown command/);

  // Control: a verb that genuinely does not exist still says so, on the same code path.
  const control = await cli(["definitelynotaverb"]);
  assert.match(control.stderr, /unknown command/);
});

test("D-062: `status` still refuses an agent credential, deliberately", async () => {
  // NOT an oversight and NOT the inconsistency to fix. runStatus is human-shaped throughout;
  // widening this gate moves the failure deeper. `cswarm members` is the agent-facing surface.
  const result = await cli([
    "status",
    "--workspace-id",
    WORKSPACE,
    "--agent-token-stdin",
  ], "{}");

  assert.match(
    result.stderr,
    /unknown option: --agent-token-stdin/,
    "status now accepts an agent credential — if that was intentional, it needs an "
      + "agent-shaped output, not just a widened shape gate",
  );
});

test("D-062: `members` is discoverable in --help, since an undiscoverable roster is the defect", async () => {
  const result = await cli(["--help"]);
  const help = result.stdout + result.stderr;

  assert.match(help, /cswarm members/);
  // The flag is the point of the verb, so the usage line has to carry it.
  assert.match(help, /cswarm members[^\n]*--agent-token-stdin/);

  // Control: the help really is being read, not matched against an empty string.
  assert.match(help, /cswarm status/);
});
