import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AGENT_CREDENTIAL_OPTIONAL_FIELDS,
  AGENT_CREDENTIAL_REQUIRED_FIELDS,
  parseAgentCredentialInput,
} from "../../src/cloud/agent-credential-input.js";

/* Reached by `npm run test:p1-cli` through its tests/p1-cli glob. */

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "11111111-1111-4111-8111-111111111111";
const TOKEN_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = `swm_agt_${"S".repeat(43)}`;
const MESSAGE =
  "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.";

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message: MESSAGE,
    status: "accepted",
    principal_id: PRINCIPAL,
    token_id: TOKEN_ID,
    run_id: RUN_ID,
    agent_token: TOKEN,
    expires_at: "2099-09-02T22:00:00.000Z",
    ...overrides,
  };
}

async function runCli(credentialPath: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "whoami",
    "--agent-token-file",
    credentialPath,
    "--url",
    "http://127.0.0.1:9",
    "--anon-key",
    "public-anon",
    "--workspace-id",
    WORKSPACE,
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

const faults = [
  {
    code: "agent_credential_invalid_json",
    content: `{"leak":"${TOKEN}"`,
    found: /contains text that is not valid JSON/,
  },
  {
    code: "agent_credential_not_object",
    content: JSON.stringify([TOKEN]),
    found: /contains a JSON array instead of a JSON object/,
  },
  {
    code: "agent_credential_missing_agent_token",
    content: JSON.stringify({ principal_id: TOKEN }),
    found: /is missing "agent_token"/,
  },
  {
    code: "agent_credential_invalid_agent_token",
    content: JSON.stringify(artifact({ agent_token: `wrong-${TOKEN}` })),
    found: /has "agent_token" as a string that is not a swm_agt_ credential/,
  },
  {
    code: "agent_credential_fields_invalid",
    content: JSON.stringify({
      workspace_id: WORKSPACE,
      agent_id: PRINCIPAL,
      agent_name: "Invented schema",
      agent_token: TOKEN,
    }),
    found: /has 3 unrecognized fields and is missing required fields/,
  },
] as const;

for (const fault of faults) {
  test(`agent credential file reports ${fault.code} without the credential`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cswarm-credential-fault-"));
    const credentialPath = join(directory, "agent.json");
    try {
      await writeFile(credentialPath, fault.content, { mode: 0o600 });
      const result = await runCli(credentialPath);

      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, new RegExp(`\\[${fault.code}\\]`));
      assert.ok(
        result.stderr.includes(`agent credential file ${credentialPath}`),
        result.stderr,
      );
      assert.match(result.stderr, fault.found);
      assert.match(
        result.stderr,
        /It must be the JSON line CommonSwarm minted, copied unchanged: message, status, principal_id, token_id, run_id, agent_token \(expires_at is optional\)\./,
      );
      assert.ok(
        result.stderr.includes(
          `Next step: copy the minted JSON line again and replace ${credentialPath}.`,
        ),
        result.stderr,
      );
      assert.doesNotMatch(result.stderr, new RegExp(TOKEN));
      assert.doesNotMatch(result.stderr, /Invented schema/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("credential contract keeps every minted required field and one optional field", () => {
  assert.deepEqual(AGENT_CREDENTIAL_REQUIRED_FIELDS, [
    "message",
    "status",
    "principal_id",
    "token_id",
    "run_id",
    "agent_token",
  ]);
  assert.deepEqual(AGENT_CREDENTIAL_OPTIONAL_FIELDS, ["expires_at"]);
});

test("agent-token-only error copy names every field reported missing", () => {
  assert.throws(
    () => parseAgentCredentialInput(
      JSON.stringify({ agent_token: TOKEN }),
      { kind: "file", path: "/synthetic/agent.json" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const missingClause = error.message.match(
        /is missing required fields (?<fields>[^.]+)\. It must/,
      );
      const contractClause = error.message.match(
        /copied unchanged: (?<fields>[^()]+) \(expires_at is optional\)\./,
      );
      assert.ok(missingClause?.groups, error.message);
      assert.ok(contractClause?.groups, error.message);

      const missingFields = [...missingClause.groups.fields.matchAll(/"([^"]+)"/g)]
        .map((match) => match[1]);
      const namedFields = contractClause.groups.fields.split(", ");
      assert.deepEqual(
        missingFields,
        AGENT_CREDENTIAL_REQUIRED_FIELDS.filter((field) => field !== "agent_token"),
      );
      for (const field of missingFields) {
        assert.ok(namedFields.includes(field), `error copy omits missing field ${field}`);
      }
      return true;
    },
  );
});

test("full synthetic minted shape passes the credential parser", () => {
  const parsed = parseAgentCredentialInput(
    JSON.stringify(artifact()),
    { kind: "file", path: "/synthetic/agent.json" },
  );

  assert.equal(parsed.token, TOKEN);
  assert.equal(parsed.principalId, PRINCIPAL);
  assert.equal(parsed.tokenId, TOKEN_ID);
  assert.equal(parsed.runId, RUN_ID);
  assert.equal(parsed.expiresAt, Date.parse("2099-09-02T22:00:00.000Z"));
  assert.equal(parsed.durable, true);
});
