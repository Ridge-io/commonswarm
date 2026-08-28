import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ASK = "33333333-3333-4333-8333-333333333333";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
const CREATE_REQUEST_ID = "create-phase-500";
const READ_REQUEST_ID = "read-phase-500";

async function runCli(values: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    ...values,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_CLOUD_WORKSPACE_ID: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  child.stdin.end(TOKEN);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
}

function signal(): Record<string, unknown> {
  return {
    id: ASK,
    workspace_id: WORKSPACE,
    from: AGENT,
    from_kind: "agent",
    to: null,
    to_agent: AGENT,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body: "Can you check this?",
    until: "2026-08-27T00:00:00.000Z",
    created_at: "2026-08-26T00:00:00.000Z",
  };
}

async function askAgainst(
  phase: "create" | "read",
): Promise<{ result: Awaited<ReturnType<typeof runCli>>; posts: number }> {
  let posts = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => raw += chunk);
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      response.setHeader("content-type", "application/json");
      if (body.resource === "members") {
        response.end(JSON.stringify({
          members: [{ user_id: USER, display_name: "Quill" }],
          agents: [{
            principal_id: AGENT,
            name: "Hermes",
            owner_user_id: USER,
          }],
        }));
        return;
      }
      if (body.resource === "signals") {
        response.statusCode = 500;
        response.end(JSON.stringify({
          error: "internal_error",
          request_id: READ_REQUEST_ID,
          retryable: false,
        }));
        return;
      }
      const command = body.command as Record<string, unknown> | undefined;
      if (command?.kind === "post_signal") {
        posts += 1;
        if (phase === "create") {
          response.statusCode = 500;
          response.end(JSON.stringify({
            message:
              `signal read failed (HTTP 500): internal_error, request_id ${CREATE_REQUEST_ID}`,
          }));
          return;
        }
        response.end(JSON.stringify({
          status: "accepted",
          ok: true,
          event_ids: [],
          signal: signal(),
        }));
        return;
      }
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "unexpected_request" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await runCli([
      "ask",
      "Can you check this?",
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
      "--to",
      "Hermes",
      "--wait",
      "1",
    ]);
    return { result, posts };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("an ask create 500 says the message may be absent and tells the sender to verify and resend", async () => {
  const { result, posts } = await askAgainst("create");
  assert.equal(result.code, 1);
  assert.equal(posts, 3, "persistent create failure must exhaust the bounded retry set");
  assert.match(result.stderr, /Your message may not have been posted/);
  assert.match(result.stderr, /server error before it was confirmed/);
  assert.match(
    result.stderr,
    new RegExp(`cswarm feed --workspace-id ${WORKSPACE}`),
  );
  assert.match(result.stderr, /resend if it is not there/);
  assert.match(result.stderr, new RegExp(CREATE_REQUEST_ID));
  assert.doesNotMatch(result.stderr, /signal read failed/);
  assert.doesNotMatch(result.stderr, /Your message was posted/);
  assert.doesNotMatch(result.stderr, /reply could not be fetched/);
  assert.doesNotMatch(result.stderr, /Do not resend this ask/);
});

test("an ask reply-read 500 says the post succeeded and forbids a duplicate resend", async () => {
  const { result, posts } = await askAgainst("read");
  assert.equal(result.code, 1);
  assert.equal(posts, 1);
  assert.match(result.stderr, /Your message was posted/);
  assert.match(result.stderr, /reply could not be fetched/);
  assert.match(result.stderr, /Do not resend this ask/);
  assert.match(
    result.stderr,
    new RegExp(`cswarm inbox --workspace-id ${WORKSPACE}`),
  );
  assert.match(result.stderr, new RegExp(READ_REQUEST_ID));
  assert.doesNotMatch(result.stderr, /may not have been posted/);
  assert.doesNotMatch(result.stderr, /resend if it is not there/);
});
