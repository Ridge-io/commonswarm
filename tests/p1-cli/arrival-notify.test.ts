/**
 * Real-CLI proof for `inbox --notify` against a loopback read service.
 *
 * ★ Reached by `npm run test:p1-cli` through tests/p1-cli/**\/*.test.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  fileArrivalCursorStore,
} from "../../src/cloud/arrival-watch.js";
import { cloudTarget } from "../../src/cloud/config.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SENDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OLD_SIGNAL = "11111111-1111-4111-8111-111111111111";
const NEW_SIGNAL = "22222222-2222-4222-8222-222222222222";
const TOKEN = `swm_agt_${"A".repeat(43)}`;

test("inbox --notify flushes one readable line and never calls delivery mutation paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-arrival-cli-"));
  const xdg = join(root, "state");
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const receipt = {
    state: "pending",
    delivered_at: null,
    acked_at: null,
    ack_outcome: null,
  };
  const receiptBefore = structuredClone(receipt);

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw.length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
      requests.push({ path: req.url ?? "", body });
      if (req.url !== "/functions/v1/read" || body.resource !== "signals") {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({ error: "unexpected_mutation_path" }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          signals: [{
            id: NEW_SIGNAL,
            workspace_id: WORKSPACE,
            from: SENDER,
            from_kind: "agent",
            to: null,
            to_agent: PRINCIPAL,
            in_reply_to: null,
            about: null,
            kind: "ask",
            body: "Please review\nthis change.",
            until: "2030-01-01T00:00:00.000Z",
            created_at: "2026-08-28T11:01:00.000Z",
            sender_owner_relation: "same_owner",
          }],
          capabilities: { sender_owner_relation: 1, cursor_after: 1 },
        }),
      );
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const target = cloudTarget(url, "anon-key-for-arrival-test");
  const cursorStore = fileArrivalCursorStore({
    target,
    workspaceId: WORKSPACE,
    principalId: PRINCIPAL,
    stateDirectory: join(xdg, "cswarm", "arrival-cursors"),
  });
  await cursorStore.write({
    created_at: "2026-08-28T11:00:00.000Z",
    id: OLD_SIGNAL,
  });

  const credential = JSON.stringify({
    message: "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.",
    status: "accepted",
    principal_id: PRINCIPAL,
    token_id: "33333333-3333-4333-8333-333333333333",
    run_id: "44444444-4444-4444-8444-444444444444",
    agent_token: TOKEN,
    expires_at: "2030-01-01T00:00:00.000Z",
  });

  try {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      resolve("src/cli.ts"),
      "inbox",
      "--notify",
      "--agent-token-stdin",
      "--url",
      url,
      "--anon-key",
      "anon-key-for-arrival-test",
      "--workspace-id",
      WORKSPACE,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: root, XDG_STATE_HOME: xdg },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(credential);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("\n")) {
        setTimeout(() => child.kill("SIGTERM"), 100);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`notify CLI timed out; stderr=${stderr}`));
      }, 10_000);
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolveExit(exitCode);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    assert.equal(code, 0, stderr);
    const lines = stdout.trimEnd().split("\n");
    assert.equal(lines.length, 1, stdout);
    assert.match(lines[0]!, new RegExp(SENDER));
    assert.match(lines[0]!, /Please review this change\./);
    assert.match(
      lines[0]!,
      new RegExp(
        `cswarm reply ${NEW_SIGNAL} "<answer>" --workspace-id ${WORKSPACE}`,
      ),
    );
    /* The monitor line can reach terminal notification history. It names the public workspace
     * route only; credentials and target configuration stay in the process that owns them. */
    assert.doesNotMatch(lines[0]!, /--agent-token-stdin|--agent-token-file/);
    assert.doesNotMatch(lines[0]!, new RegExp(url));
    assert.doesNotMatch(lines[0]!, /anon-key-for-arrival-test/);
    assert.doesNotMatch(lines[0]!, new RegExp(TOKEN));
    assert.deepEqual(
      requests.map(({ path }) => path),
      ["/functions/v1/read"],
    );
    assert.equal(requests[0]?.body.after_created_at, "2026-08-28T11:00:00.000Z");
    assert.equal(requests[0]?.body.after_id, OLD_SIGNAL);
    assert.deepEqual(receipt, receiptBefore);

    const stored = JSON.parse(await readFile(cursorStore.location, "utf8")) as {
      cursor: { id: string };
    };
    assert.equal(stored.cursor.id, NEW_SIGNAL);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});
