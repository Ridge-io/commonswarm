import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";

/* The cswarm feedback verb: parsing refusals, the request shape it puts on
 * the wire, --json passthrough, and how server refusals render. The wire
 * shape assertions are the contract the site's api.md publishes for
 * sandboxed agents — if they drift, that page lies.
 *
 * Reached by `npm run test:p1-cli` (globs tests/p1-cli/**). No database.
 */

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* The stdin parser accepts either the full mint artifact (closed key set,
 * including the exact message string) or a bare token; the bare form keeps
 * this test independent of the mint copy. */
function credentialArtifact(): string {
  return `swm_agt_${randomBytes(32).toString("base64url")}`;
}

async function cli(
  args: string[],
  stdin = "",
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
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(stdin);
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

/* ------------------------------------------------- a recording fake server */

interface Captured {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

let server: Server | undefined;
let captured: Captured[] = [];
let respondWith: { status: number; body: unknown } = {
  status: 200,
  body: { status: "accepted", ok: true, event_ids: [], events: [] },
};

async function serverUrl(): Promise<string> {
  if (server === undefined) {
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => raw += chunk);
      request.on("end", () => {
        captured.push({
          path: request.url ?? "",
          authorization: request.headers.authorization,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        response.statusCode = respondWith.status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(respondWith.body));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  }
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

after(() => {
  server?.close();
});

async function targetFlags(): Promise<string[]> {
  return [
    "--url",
    await serverUrl(),
    "--anon-key",
    "anon",
    "--workspace-id",
    WORKSPACE,
    "--agent-token-stdin",
  ];
}

/* ------------------------------------------------------------- parsing ---- */

test("feedback with no text is a usage error", async () => {
  const result = await cli(["feedback", "--kind", "bug"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /feedback needs the feedback text/);
});

test("feedback without --kind is a usage error", async () => {
  const result = await cli(["feedback", "the flags fought me"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--kind/);
});

test("feedback refuses a kind outside bug|idea|friction", async () => {
  const result = await cli([
    "feedback",
    "the flags fought me",
    "--kind",
    "praise",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--kind must be bug, idea, or friction/);
});

/* ---------------------------------------------------------- wire shape --- */

test("the request carries the published shape and no reporter fields", async () => {
  captured = [];
  respondWith = {
    status: 200,
    body: { status: "accepted", ok: true, event_ids: [], events: [] },
  };
  const result = await cli(
    [
      "feedback",
      "feed --limit hides stale rows with no hint",
      "--kind",
      "friction",
      "--about",
      "cswarm feed",
      ...await targetFlags(),
    ],
    credentialArtifact(),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Feedback recorded for the operators/);
  assert.match(result.stdout, /no reply channel/);

  assert.equal(captured.length, 1);
  const request = captured[0];
  assert.match(request.path, /\/functions\/v1\/command$/);
  assert.match(request.authorization ?? "", /^Bearer swm_agt_/);
  assert.equal(typeof request.body.command_id, "string");
  assert.equal(request.body.workspace_id, WORKSPACE);
  assert.deepEqual(request.body.stream, { kind: "workspace" });
  const command = request.body.command as Record<string, unknown>;
  assert.equal(command.kind, "submit_feedback");
  assert.match(String(command.feedback_id), UUID_RE);
  assert.equal(command.category, "friction");
  assert.equal(command.body, "feed --limit hides stale rows with no hint");
  const context = command.context as Record<string, string>;
  assert.equal(context.surface, "cli");
  assert.equal(context.platform, process.platform);
  assert.equal(typeof context.cswarm_version, "string");
  assert.equal(context.about, "cswarm feed");
  /* Attribution is the server's job: the payload must never name a reporter,
   * or whoever holds the endpoint could impersonate one. */
  assert.deepEqual(
    Object.keys(command).sort(),
    ["body", "category", "context", "feedback_id", "kind"],
  );
  /* The auto-filled context must not leak the environment: exactly the four
   * descriptive keys above, nothing resembling a path or an env var. */
  assert.deepEqual(
    Object.keys(context).sort(),
    ["about", "cswarm_version", "platform", "surface"],
  );
});

test("--json prints the server response verbatim", async () => {
  captured = [];
  respondWith = {
    status: 200,
    body: { status: "accepted", ok: true, event_ids: ["e-1"], events: [] },
  };
  const result = await cli(
    [
      "feedback",
      "json shape probe",
      "--kind",
      "bug",
      "--json",
      ...await targetFlags(),
    ],
    credentialArtifact(),
  );
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(parsed.status, "accepted");
  assert.deepEqual(parsed.event_ids, ["e-1"]);
  assert.doesNotMatch(result.stdout, /Feedback recorded/);
});

test("a duplicate ack renders as already-with-the-operators, not as new", async () => {
  captured = [];
  respondWith = {
    status: 200,
    body: {
      status: "accepted",
      ok: true,
      event_ids: [],
      events: [],
      duplicate: true,
      message: "This feedback matches one you sent within the hour.",
    },
  };
  const result = await cli(
    [
      "feedback",
      "duplicate probe",
      "--kind",
      "bug",
      ...await targetFlags(),
    ],
    credentialArtifact(),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /not recorded twice/);
  assert.match(result.stdout, /already with the operators/);
  assert.doesNotMatch(result.stdout, /Feedback recorded for the operators/);
});

test("a server refusal surfaces its message and fails the command", async () => {
  captured = [];
  respondWith = {
    status: 429,
    body: {
      error: "rate_limited",
      message: "Feedback refused: feedback limit 10/hour; resets at soon.",
    },
  };
  const result = await cli(
    [
      "feedback",
      "refusal probe",
      "--kind",
      "idea",
      ...await targetFlags(),
    ],
    credentialArtifact(),
  );
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Feedback refused: feedback limit 10\/hour/);
});
