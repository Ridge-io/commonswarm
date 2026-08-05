/**
 * End-to-end gate on the inbox --follow backoff, driven through the real CLI
 * against a loopback stub. Pure: no external network, no database.
 *
 * ★ Reached by `npm run test:p1-cli` via the tests/p1-cli/**\/*.test.ts glob.
 *
 * WHY THIS EXISTS RATHER THAN ONLY THE UNIT TESTS. D-055 shipped a defect that
 * every unit test missed: the terminal frame was emitted by a helper the tests
 * called directly, while the CLI path forgot to call it. A test that passes
 * against the wrong target is not a test. This one spawns the CLI and reads its
 * stdout, so the thing under test is the thing users run.
 *
 * It also gives D-051 companion 1 (backoff decay) its only non-unit evidence.
 * Wren established it is UNMEASURABLE in production: the decay counter only
 * advances on a RETRYABLE failure, and every current production failure is
 * refused, so the veto fires first and the counter is never touched. The stub
 * below serves the retryable failure mode production is not currently
 * producing.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_TOKEN = `swm_agt_${"A".repeat(43)}`;

interface FollowFrameLine {
  type: string;
  attempt?: number;
  delay_ms?: number;
  reason?: string;
  server_refused?: boolean;
}

function signalRow(id: string) {
  return {
    id,
    workspace_id: WORKSPACE,
    from: "22222222-2222-4222-8222-222222222222",
    from_kind: "agent",
    to: null,
    to_agent: null,
    in_reply_to: null,
    about: null,
    kind: "note",
    body: "e2e",
    until: "2030-01-01T00:00:00.000Z",
    created_at: "2026-07-24T00:00:00.000Z",
  };
}

/**
 * Serves one scripted outcome per read. `true` is a 200 with an empty page,
 * `false` is a 500 whose body decides retryability.
 */
async function startStub(
  outcomes: readonly boolean[],
  failureBody: Record<string, unknown>,
  failureStatus = 500,
): Promise<{ server: Server; url: string; reads: () => number }> {
  let reads = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const index = reads;
      reads += 1;
      // The first read always succeeds so the stream reaches ready; retrying
      // frames are suppressed before ready, so without this there is nothing
      // to observe.
      const ok = index === 0 ? true : (outcomes[index - 1] ?? false);
      if (ok) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            signals: index === 0 ? [signalRow("33333333-3333-4333-8333-333333333333")] : [],
            capabilities: { sender_owner_relation: 1, cursor_after: 1 },
          }),
        );
        return;
      }
      res.writeHead(failureStatus, { "content-type": "application/json" }).end(
        JSON.stringify(failureBody),
      );
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("stub server did not bind a port");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    reads: () => reads,
  };
}

/** Run the real CLI against the stub and collect its NDJSON frames. */
async function followUntil(
  url: string,
  stopAfterFrames: number,
  timeoutMs = 30_000,
): Promise<{ frames: FollowFrameLine[]; unparsed: string[]; code: number | null }> {
  const home = await mkdtemp(join(tmpdir(), "cswarm-e2e-home-"));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("src/cli.ts"),
      "inbox",
      "--follow",
      "--ndjson",
      "--url",
      url,
      "--anon-key",
      "anon-key-for-stub",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, XDG_STATE_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const frames: FollowFrameLine[] = [];
  const unparsed: string[] = [];
  let buffer = "";
  let settled = false;

  const done = new Promise<number | null>((resolveCode) => {
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCode(code);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          frames.push(JSON.parse(line) as FollowFrameLine);
        } catch {
          unparsed.push(line);
        }
      }
      if (frames.length >= stopAfterFrames) {
        child.kill("SIGTERM");
      }
    });
    child.once("exit", (code) => finish(code));
    child.once("error", () => finish(null));
  });

  child.stdin.end(AGENT_TOKEN);
  const code = await done;
  // Drain any final partial line the exit raced.
  if (buffer.trim().length > 0) {
    try {
      frames.push(JSON.parse(buffer) as FollowFrameLine);
    } catch {
      unparsed.push(buffer);
    }
  }
  return { frames, unparsed, code };
}

test("D-051: an isolated success does not wipe earned backoff, through the real CLI", async () => {
  // fail, fail, fail, SUCCESS, fail — the lone success is the whole point.
  // retryable:true so the D-051 veto does NOT fire and the decay is reachable;
  // this is the failure mode production is currently not producing.
  const stub = await startStub(
    [false, false, false, true, false],
    { error: "internal_error", request_id: "e2e-1", retryable: true },
  );
  try {
    const { frames, unparsed } = await followUntil(stub.url, 6);
    assert.deepEqual(unparsed, [], "every stdout line must be NDJSON");

    const retries = frames.filter((frame) => frame.type === "retrying");
    assert.ok(
      retries.length >= 4,
      `expected at least 4 retry frames, saw ${retries.length}: ${
        JSON.stringify(frames.map((f) => f.type))
      }`,
    );
    const attempts = retries.slice(0, 4).map((frame) => frame.attempt);
    // Three failures climb 1,2,3; the success decays 3 -> 2; the next failure
    // resumes at 3. Under the old reset-to-zero it restarts at 1.
    assert.deepEqual(attempts, [1, 2, 3, 3]);
  } finally {
    await new Promise<void>((closed) => stub.server.close(() => closed()));
  }
});

test("D-051/D-055: a refused read exits without retrying and its last line is a frame", async () => {
  const stub = await startStub(
    [false, false, false],
    {
      error: "internal_error",
      request_id: "9d1f4b2c-0000-4000-8000-abcdefabcdef",
      retryable: false,
    },
  );
  try {
    const { frames, unparsed } = await followUntil(stub.url, 3);
    assert.deepEqual(
      unparsed,
      [],
      `the terminal condition must be a frame, not bare text: ${unparsed.join(" | ")}`,
    );

    // The veto: refused means no retry at all.
    assert.equal(frames.filter((frame) => frame.type === "retrying").length, 0);

    const terminal = frames[frames.length - 1];
    assert.equal(terminal?.type, "error");
    assert.equal(terminal?.server_refused, true);

    // Exactly two reads: the first that succeeded, then the refusal.
    assert.equal(stub.reads(), 2);
  } finally {
    await new Promise<void>((closed) => stub.server.close(() => closed()));
  }
});

test("D-056: the exit status separates a refusal from a revoked credential", async () => {
  // A refused 500 — the server said do not retry THIS request, but a later
  // attempt may still succeed, so a supervisor should restart.
  const refused = await startStub(
    [false],
    {
      error: "internal_error",
      request_id: "9d1f4b2c-0000-4000-8000-abcdefabcdef",
      retryable: false,
    },
  );
  let refusedCode: number | null;
  try {
    // Never kill early: SIGTERM would replace the natural exit status with
    // null, which is the very thing under test. Both arms exit on their own.
    refusedCode = (await followUntil(refused.url, Number.POSITIVE_INFINITY)).code;
  } finally {
    await new Promise<void>((closed) => refused.server.close(() => closed()));
  }

  // A revoked credential — refuses identically forever; restarting is a spin.
  const revoked = await startStub(
    [false],
    { error: "unauthorized" },
    401,
  );
  let revokedCode: number | null;
  try {
    revokedCode = (await followUntil(revoked.url, Number.POSITIVE_INFINITY)).code;
  } finally {
    await new Promise<void>((closed) => revoked.server.close(() => closed()));
  }

  // LITERAL, not imported from src/cli.ts. 75 is sysexits EX_TEMPFAIL and
  // supervisors already know it, so it is an EXTERNAL contract: importing the
  // constant would let it drift to 74 with the test still green while every
  // shell loop and service unit silently broke. Importing the CLI entrypoint
  // would also execute main().
  assert.equal(refusedCode, 75, "a refusal must exit EX_TEMPFAIL (75)");
  assert.equal(revokedCode, 1, "a revoked credential must not be restartable");
});
