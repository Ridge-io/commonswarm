import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  assertWorkspaceName,
  createWorkspaceError,
  CreateWorkspaceError,
  ThinCommandClient,
  WORKSPACE_NAME_MAX_LENGTH,
} from "../../src/cloud/command-client.js";
import { cloudTarget } from "../../src/cloud/config.js";

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

function accepted(workspaceId: string): Response {
  return new Response(
    JSON.stringify({
      status: "accepted",
      ok: true,
      event_ids: [],
      workspace_id: workspaceId,
      stream_id: randomUUID(),
      min_client_version: "0.1.0",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("project names are bounded before the round trip", () => {
  assert.equal(WORKSPACE_NAME_MAX_LENGTH, 80);
  assert.doesNotThrow(() => assertWorkspaceName("a"));
  assert.doesNotThrow(() => assertWorkspaceName("x".repeat(80)));
  assert.throws(() => assertWorkspaceName(""), /project name is required/);
  assert.throws(
    () => assertWorkspaceName("x".repeat(81)),
    /at most 80 characters; this one is 81/,
  );
  // The name is printed straight to a terminal on success, so the escape and
  // bidi ranges the command function refuses are refused here too.
  assert.throws(
    () => assertWorkspaceName(`red${"\u001b"}[31m`),
    /control characters/,
  );
  assert.throws(() => assertWorkspaceName(`a${"\u202e"}b`), /control characters/);
});

test("create_workspace sends a client id and pins no route", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", "anon-key");
  const workspaceId = randomUUID();
  const requests: Array<Record<string, unknown>> = [];
  const fetcher = (async (_url: URL | RequestInfo, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return accepted(workspaceId);
  }) as typeof fetch;

  const result = await new ThinCommandClient(target, fetcher).sendConnect({
    command: {
      kind: "create_workspace",
      workspace_id: workspaceId,
      name: "Ridge",
    },
    credential: "human-jwt",
  });

  assert.equal(result.httpStatus, 200);
  assert.equal(requests.length, 1);
  const body = requests[0]!;
  // Both absences are load-bearing: the command function reads create_workspace
  // before route resolution and rejects a request that carries either.
  assert.equal(Object.hasOwn(body, "workspace_id"), false);
  assert.equal(Object.hasOwn(body, "stream"), false);
  assert.deepEqual(body.command, {
    kind: "create_workspace",
    workspace_id: workspaceId,
    name: "Ridge",
  });
  assert.equal(typeof body.command_id, "string");
  assert.equal(typeof body.client_version, "string");
});

test("create_workspace refuses to be routed to an existing project", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", "anon-key");
  let called = false;
  const fetcher = (async () => {
    called = true;
    return accepted(randomUUID());
  }) as typeof fetch;

  await assert.rejects(
    new ThinCommandClient(target, fetcher).sendConnect({
      workspaceId: randomUUID(),
      command: {
        kind: "create_workspace",
        workspace_id: randomUUID(),
        name: "Ridge",
      },
      credential: "human-jwt",
    }),
    /client-generated workspace_id/,
  );
  assert.equal(called, false);
});

test("an unusable name never reaches the network", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", "anon-key");
  let called = false;
  const fetcher = (async () => {
    called = true;
    return accepted(randomUUID());
  }) as typeof fetch;

  await assert.rejects(
    new ThinCommandClient(target, fetcher).sendConnect({
      command: {
        kind: "create_workspace",
        workspace_id: randomUUID(),
        name: "x".repeat(81),
      },
      credential: "human-jwt",
    }),
    /at most 80 characters/,
  );
  assert.equal(called, false);
});

test("the workspace limit reads as a limit, not as a status code", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", "anon-key");
  const fetcher = (async () =>
    new Response(
      JSON.stringify({ error: "workspace_limit_reached", limit: 3 }),
      { status: 403, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  const error = await new ThinCommandClient(target, fetcher).sendConnect({
    command: {
      kind: "create_workspace",
      workspace_id: randomUUID(),
      name: "Fourth",
    },
    credential: "human-jwt",
  }).then(() => null, (reason: unknown) => reason);

  assert.ok(error instanceof CreateWorkspaceError);
  assert.equal(error.status, 403);
  assert.equal(error.code, "workspace_limit_reached");
  assert.match(error.message, /already created 3 projects/);
  assert.match(error.message, /Archiving a project frees its slot/);
  assert.doesNotMatch(error.message, /403/);
  assert.doesNotMatch(error.message, /forbidden/i);
});

test("a closed front door says signup is not open, not forbidden", () => {
  const closed = createWorkspaceError(403, { error: "forbidden" });
  assert.equal(closed.code, "forbidden");
  assert.match(closed.message, /not open on this deployment yet/);
  assert.match(closed.message, /confirmed email address/);
  assert.match(closed.message, /coswarm accept --link-stdin/);
  assert.doesNotMatch(closed.message, /403/);
  // The server sends the same body for a disabled feature gate and for an
  // unverified identity, so one sentence has to name both.
  assert.equal(
    createWorkspaceError(403, { error: "forbidden" }).message,
    createWorkspaceError(403, {}).message,
  );
});

test("the remaining refusals each say what to do next", () => {
  const malformed = createWorkspaceError(400, { error: "invalid_request" });
  assert.equal(malformed.code, "invalid_request");
  assert.match(malformed.message, /Nothing was created/);
  assert.match(malformed.message, /coswarm --version/);

  const upgrade = createWorkspaceError(426, {
    error: "upgrade_required",
    min_client_version: "9.9.9",
  });
  assert.equal(upgrade.code, "upgrade_required");
  assert.match(upgrade.message, /minimum 9\.9\.9/);
  assert.match(upgrade.message, /Update coswarm/);

  const signedOut = createWorkspaceError(401, { error: "unauthorized" });
  assert.equal(signedOut.code, "unauthenticated");
  assert.match(signedOut.message, /coswarm login/);

  // An unknown outcome must not be reported as a refusal: the project may exist.
  const unknown = createWorkspaceError(502, null);
  assert.match(unknown.message, /could not tell whether the project was created/);
  assert.match(unknown.message, /coswarm workspaces/);
});

test("new validates its arguments before asking for a credential", async () => {
  const missing = await cli(["new"]);
  assert.equal(missing.code, 1);
  assert.match(
    missing.stderr,
    /too few positional arguments: expected 2, received 1/,
  );

  const blank = await cli(["new", "   "]);
  assert.equal(blank.code, 1);
  assert.match(blank.stderr, /project name is required/);

  const long = await cli(["new", "x".repeat(81)]);
  assert.equal(long.code, 1);
  assert.match(long.stderr, /at most 80 characters; this one is 81/);

  const twice = await cli(["new", "Ridge", "--name", "Ridge"]);
  assert.equal(twice.code, 1);
  assert.match(twice.stderr, /as a positional or as --name, not both/);

  const routed = await cli(["new", "Ridge", "--workspace-id", randomUUID()]);
  assert.equal(routed.code, 1);
  assert.match(routed.stderr, /unknown option: --workspace-id/);

  // None of the above reached credential or target resolution.
  for (const result of [missing, blank, long, twice, routed]) {
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /no Cloud target is selected/);
  }
});

test("new is discoverable in the usage block", async () => {
  const help = await cli(["help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /coswarm new "<project name>"/);
  assert.match(help.stdout, /coswarm new --name "<project name>"/);
  assert.match(help.stdout, /coswarm new starts a project of your own/);
});
