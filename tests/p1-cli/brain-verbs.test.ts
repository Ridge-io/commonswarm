import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  FILE_VERSION_PRECONDITION_FAILED,
  fileVersionPreconditionMessage,
} from "../../src/protocol/index.js";

/* Reached by `npm run test:p1-cli` through its tests/p1-cli glob. */

const WORKSPACE = "3ab184b3-fbb4-5ee9-afad-3842a604439a";
const BRAIN_FILE_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const TOKEN = `swm_agt_${"b".repeat(43)}`;
const EXISTING_MARKDOWN = "# Architecture\n\nUse the file layer.\n";

interface RecordedCommand {
  kind: string;
  body: Record<string, unknown>;
}

interface FakeCloud {
  url: string;
  commands: RecordedCommand[];
  uploads: Buffer[];
  close(): Promise<void>;
}

async function startFakeCloud(
  options: { liveVersion?: number } = {},
): Promise<FakeCloud> {
  /* The newest LIVE version this fake workspace holds, which is what the real
   * server compares an if_version against. */
  const liveVersion = options.liveVersion ?? 2;
  const commands: RecordedCommand[] = [];
  const uploads: Buffer[] = [];
  const names = new Map<string, string>([[BRAIN_FILE_ID, "brain--architecture.md"]]);
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const path = request.url ?? "";
      if (request.method === "POST" && path === "/functions/v1/read") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          files: [
            {
              file_id: BRAIN_FILE_ID,
              name: "brain--architecture.md",
              current_version: 2,
              size_bytes: EXISTING_MARKDOWN.length,
              content_type: "text/markdown",
              sha256: null,
              created_by_kind: "agent",
              created_by: "11111111-1111-4111-8111-111111111111",
              uploaded_by_kind: "agent",
              uploaded_by: "22222222-2222-4222-8222-222222222222",
              created_at: "2026-08-30T10:00:00.000Z",
              committed_at: "2026-08-31T10:00:00.000Z",
              tombstoned_at: null,
              live_version_count: 2,
              retired_version_count: 4,
            },
            {
              file_id: "cccccccc-1111-4111-8111-cccccccccccc",
              name: "ordinary-plan.md",
              current_version: 1,
              size_bytes: 8,
              content_type: "text/markdown",
              sha256: null,
              created_by_kind: "user",
              created_by: "33333333-3333-4333-8333-333333333333",
              uploaded_by_kind: "user",
              uploaded_by: "33333333-3333-4333-8333-333333333333",
              created_at: "2026-08-31T10:00:00.000Z",
              committed_at: "2026-08-31T10:00:00.000Z",
              tombstoned_at: null,
            },
          ],
        }));
        return;
      }
      if (request.method === "PUT" && path.startsWith("/storage/")) {
        uploads.push(raw);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (request.method === "GET" && path.startsWith("/storage/")) {
        response.writeHead(200, { "content-type": "text/markdown" });
        response.end(EXISTING_MARKDOWN);
        return;
      }
      if (request.method === "POST" && path === "/functions/v1/command") {
        const envelope = JSON.parse(raw.toString("utf8")) as {
          command: Record<string, unknown>;
        };
        const command = envelope.command;
        const kind = String(command.kind ?? "");
        commands.push({ kind, body: command });
        let body: Record<string, unknown>;
        if (kind === "file_version_create") {
          if (
            command.if_version !== undefined &&
            command.if_version !== liveVersion
          ) {
            response.writeHead(409, { "content-type": "application/json" });
            response.end(JSON.stringify({
              error: FILE_VERSION_PRECONDITION_FAILED,
              message: fileVersionPreconditionMessage(
                Number(command.if_version),
                liveVersion,
              ),
            }));
            return;
          }
          const requestedId = String(command.file_id);
          const name = String(command.name);
          const fileId = name === "brain--architecture.md" ? BRAIN_FILE_ID : requestedId;
          names.set(fileId, name);
          body = {
            status: "accepted",
            file_id: fileId,
            version_id: command.version_id,
            version_n: 3,
            name,
            upload_path: `/storage/v1/object/upload/sign/swarm-files/${fileId}/3?token=fake`,
            upload_token: null,
            upload_expires_in_seconds: 7200,
          };
        } else if (kind === "file_version_commit") {
          const fileId = String(command.file_id);
          body = {
            status: "accepted",
            file_id: fileId,
            version_id: command.version_id,
            version_n: 3,
            name: names.get(fileId) ?? "brain--architecture.md",
            size_bytes: uploads.at(-1)?.byteLength ?? 0,
            sha256: command.sha256,
            sha256_note: "unverified client attestation",
            reference: `file:${fileId}@v3`,
            retired_version_n: 1,
          };
        } else if (kind === "file_download_url") {
          body = {
            status: "accepted",
            file_id: command.file_id,
            version_n: command.version_n ?? 2,
            name: "brain--architecture.md",
            size_bytes: EXISTING_MARKDOWN.length,
            content_type: "text/markdown",
            download_path: "/storage/v1/object/sign/swarm-files/brain?token=fake",
            download_url_expires_in_seconds: 300,
            content_warning: "untrusted",
            version_state: command.version_n === 1 ? "retired" : "live",
            live_version_count: 2,
            retired_version_count: 4,
          };
        } else {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_request" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    commands,
    uploads,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    ),
  };
}

const scratch = mkdtempSync(join(tmpdir(), "cswarm-brain-verbs-"));
chmodSync(scratch, 0o700);
const tokenPath = join(scratch, "agent.json");
writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
after(() => rmSync(scratch, { recursive: true, force: true }));

async function cliAgainst(
  cloud: FakeCloud,
  args: string[],
  stdin = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    ...args,
    "--url",
    cloud.url,
    "--anon-key",
    "test-anon",
    "--workspace-id",
    WORKSPACE,
    "--agent-token-file",
    tokenPath,
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

test("brain ls exposes only reserved topics with version and updater facts", async () => {
  const cloud = await startFakeCloud();
  try {
    const result = await cliAgainst(cloud, ["brain", "ls"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Brain topics \(1\):/);
    assert.match(result.stdout, /architecture · 2 live · 4 retired/);
    assert.match(result.stdout, /updated 2026-08-31T10:00:00\.000Z/);
    assert.doesNotMatch(result.stdout, /ordinary-plan/);
  } finally {
    await cloud.close();
  }
});

test("brain get resolves the reserved file and writes Markdown to stdout", async () => {
  const cloud = await startFakeCloud();
  try {
    const result = await cliAgainst(cloud, ["brain", "get", "Architecture@1"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, EXISTING_MARKDOWN);
    assert.match(
      result.stderr,
      /architecture · 2 live · 4 retired · showing version 1 \(retired\)/,
    );
    assert.deepEqual(
      cloud.commands.map((command) => command.kind),
      ["file_download_url"],
    );
    assert.equal(cloud.commands[0]!.body.file_id, BRAIN_FILE_ID);
    assert.equal(cloud.commands[0]!.body.version_n, 1);
  } finally {
    await cloud.close();
  }
});

test("brain get JSON shows the live and retired counts", async () => {
  const cloud = await startFakeCloud();
  try {
    const result = await cliAgainst(cloud, [
      "brain",
      "get",
      "architecture",
      "--version",
      "1",
      "--json",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(body.version_state, "retired");
    assert.equal(body.live_version_count, 2);
    assert.equal(body.retired_version_count, 4);
  } finally {
    await cloud.close();
  }
});

test("the v0.1.47 brain-put wire accepts additive retirement fields", async () => {
  const cloud = await startFakeCloud();
  const markdown = "# Architecture\n\nThe durable decision changed.\n";
  try {
    const result = await cliAgainst(cloud, ["brain", "put", "Architecture"], markdown);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(cloud.commands.map((command) => command.kind), [
      "file_version_create",
      "file_version_commit",
    ]);
    assert.equal(cloud.commands[0]!.body.name, "brain--architecture.md");
    assert.equal(cloud.commands[0]!.body.content_type, "text/markdown");
    assert.equal(cloud.uploads.length, 1);
    assert.equal(cloud.uploads[0]!.toString("utf8"), markdown);
    assert.match(
      result.stdout,
      /Saved as version 3 \(oldest retired: version 1\)/,
    );
    assert.match(result.stdout, /cswarm brain get architecture/);
  } finally {
    await cloud.close();
  }
});

test("the usage block names all three brain verbs", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => output += chunk);
  child.stderr.on("data", (chunk: string) => output += chunk);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  assert.equal(code, 0, output);
  for (const verb of ["brain ls", "brain get", "brain put"]) {
    assert.match(output, new RegExp(`cswarm ${verb}`));
  }
});

/* --if-version: an optional compare-and-set on brain put.
 *
 * Measured 2026-09-04: two agents read-modify-wrote the same topic and v4,
 * composed from a copy read before v3, silently replaced it. The same topic had
 * already lost an operator hold that way once. Writes stay last-write-wins by
 * default, so nothing that does not ask for the check changes. */

test("brain put --if-version refuses a stale write, uploads nothing, and says what to do", async () => {
  const cloud = await startFakeCloud({ liveVersion: 3 });
  try {
    const result = await cliAgainst(
      cloud,
      ["brain", "put", "Architecture", "--if-version", "2"],
      "# Architecture\n\nComposed from version 2.\n",
    );

    assert.equal(result.code, 1);
    /* The live version must be in the refusal: without it the reader cannot
     * tell a stale read from a typo in the flag. */
    assert.match(result.stderr, /at version 3/);
    assert.match(result.stderr, /required version 2/);
    assert.match(result.stderr, /cswarm brain get architecture/);
    /* Refused before the upload, so a losing writer spends no bytes and no
     * version number is burned. */
    assert.deepEqual(cloud.commands.map((command) => command.kind), [
      "file_version_create",
    ]);
    assert.equal(cloud.uploads.length, 0);
  } finally {
    await cloud.close();
  }
});

test("brain put --if-version saves when the live version still matches", async () => {
  /* CONTROL. A flag that always refused would satisfy the test above and make
   * the compare-and-set useless. */
  const cloud = await startFakeCloud({ liveVersion: 2 });
  const markdown = "# Architecture\n\nComposed from version 2.\n";
  try {
    const result = await cliAgainst(
      cloud,
      ["brain", "put", "Architecture", "--if-version", "2"],
      markdown,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(cloud.commands[0]!.body.if_version, 2);
    assert.equal(cloud.uploads.length, 1);
    assert.equal(cloud.uploads[0]!.toString("utf8"), markdown);
  } finally {
    await cloud.close();
  }
});

test("brain put without the flag sends no precondition and stays last-write-wins", async () => {
  /* The server validates an EXACT key set, so an unconditional write must not
   * carry the key at all. This is the compatibility claim: an older server and
   * this client still agree on the create payload. */
  const cloud = await startFakeCloud({ liveVersion: 3 });
  try {
    const result = await cliAgainst(
      cloud,
      ["brain", "put", "Architecture"],
      "# Architecture\n\nNo precondition asked for.\n",
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      Object.hasOwn(cloud.commands[0]!.body, "if_version"),
      false,
      "an unconditional brain put must not send if_version",
    );
    assert.equal(cloud.uploads.length, 1);
  } finally {
    await cloud.close();
  }
});

test("--if-version refuses a value that is not a whole version number", async () => {
  const cloud = await startFakeCloud();
  try {
    const result = await cliAgainst(
      cloud,
      ["brain", "put", "Architecture", "--if-version", "two"],
      "# Architecture\n\nBad flag value.\n",
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--if-version must be an integer/);
    /* Rejected in the CLI, so a malformed precondition never reaches the
     * server and never looks like a conflict. */
    assert.deepEqual(cloud.commands, []);
    assert.equal(cloud.uploads.length, 0);
  } finally {
    await cloud.close();
  }
});
