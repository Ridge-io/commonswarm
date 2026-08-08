import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

/* D-064. `--json` was accepted on status/feed/inbox/workspaces/listen-status and REFUSED on
 * token mint, principal create, and invite — the three verbs that produce a credential, an
 * identity, or a capability link, and so the three most likely to be consumed by a script.
 *
 * The failure was not a readable error. `cswarm token mint --json > cred.json` exits 1 and
 * writes nothing to stdout, so the shell's `>` truncation leaves an EMPTY FILE where a
 * credential used to be. Measured on a second machine by Wren, who also established that the
 * receipts on these verbs are ALREADY JSON on stdout with narration on stderr — so the flag is
 * redundant rather than unimplemented, and accepting it is a smaller change than adding an
 * output mode.
 *
 * These tests pin the parity, not the implementation. Each case pairs the claim with a
 * same-invocation control, because "does not say `unknown option`" would also be satisfied by
 * deleting the option validator entirely. */

async function cli(
  args: string[],
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
    stdio: ["ignore", "pipe", "pipe"],
  });
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

/** The three verbs, with enough otherwise-valid shape to reach flag validation. */
const CREDENTIAL_VERBS: ReadonlyArray<{ name: string; argv: readonly string[] }> = [
  {
    name: "token mint",
    argv: [
      "token",
      "mint",
      "--workspace-id",
      "00000000-0000-4000-8000-000000000001",
      "--principal-id",
      "00000000-0000-4000-8000-000000000002",
      "--run-id",
      "00000000-0000-4000-8000-000000000003",
      "--task-id",
      "00000000-0000-4000-8000-000000000004",
      "--epoch",
      "1",
    ],
  },
  {
    name: "principal create",
    argv: [
      "principal",
      "create",
      "--workspace-id",
      "00000000-0000-4000-8000-000000000001",
      "--name",
      "probe",
    ],
  },
  {
    name: "invite",
    argv: [
      "invite",
      "--workspace-id",
      "00000000-0000-4000-8000-000000000001",
      "--email",
      "probe@example.com",
    ],
  },
];

for (const verb of CREDENTIAL_VERBS) {
  test(`D-064: \`${verb.name}\` accepts --json, and still rejects a genuinely unknown flag`, async () => {
    const withJson = await cli([...verb.argv, "--json"]);

    // The claim: --json is no longer refused at the shape gate.
    assert.doesNotMatch(
      withJson.stderr,
      /unknown option: --json/,
      `${verb.name} still refuses --json`,
    );

    // THE CONTROL, on the same verb and the same argv shape. Without this, the assertion
    // above is also satisfied by removing option validation altogether — which would be a
    // far worse defect than the one being fixed, and would look identical here.
    //
    // The control carries a VALUE. An unrecognised flag is not in `BOOLEAN_FLAGS`, so the
    // parser treats it as value-taking and fails with "--x requires a value" before the shape
    // gate is ever consulted — a bare `--not-a-real-flag` therefore tests the parser, not the
    // validator, and would have passed this test while proving nothing about it.
    const withNonsense = await cli([...verb.argv, "--not-a-real-flag", "x"]);
    assert.match(
      withNonsense.stderr,
      /unknown option: --not-a-real-flag/,
      `${verb.name} no longer rejects unknown flags — the validator is broken, not fixed`,
    );
  });
}

test("D-064: the flag was already accepted on the read verbs, which is why refusing it was a trap", async () => {
  // Not a change — a pin on the asymmetry that made the defect reachable. If `--json` ever
  // stops working here, the parity this file asserts becomes vacuous rather than false.
  for (const argv of [["feed"], ["inbox"], ["workspaces"], ["status"]]) {
    const result = await cli([...argv, "--json"]);
    assert.doesNotMatch(
      result.stderr,
      /unknown option: --json/,
      `${argv[0]} unexpectedly refuses --json`,
    );
  }
});
