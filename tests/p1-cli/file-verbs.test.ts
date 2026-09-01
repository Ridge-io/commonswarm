import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  absoluteStorageUrl,
  allowedExtensionList,
  contentTypeForName,
  FILE_CONTENT_WARNING,
  FileCommandRefused,
  FileTransportError,
  fileVersionCreate,
  getObject,
  listFilesAsAgent,
  listFilesAsHuman,
  LocalFileExists,
  onceRetried,
  type ReadDeadlineOptions,
  writeDestination,
} from "../../src/cloud/files.js";
import { cloudTarget } from "../../src/cloud/config.js";

const TARGET = cloudTarget("https://example.supabase.co", "anon-key");

function fakeFetcher(
  handler: (input: string | URL | Request, init?: RequestInit) => Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    handler(input, init)) as typeof fetch;
}

function manualDeadline() {
  const handle = {} as ReturnType<typeof setTimeout>;
  let active = false;
  let callback: (() => void) | undefined;
  let delayMs: number | undefined;
  let cancelCalls = 0;
  return {
    schedule(next: () => void, delay: number): ReturnType<typeof setTimeout> {
      active = true;
      callback = next;
      delayMs = delay;
      return handle;
    },
    cancel(timer: ReturnType<typeof setTimeout>): void {
      assert.equal(timer, handle);
      active = false;
      cancelCalls += 1;
    },
    expire(): void {
      if (active) callback?.();
    },
    get delayMs(): number | undefined {
      return delayMs;
    },
    get cancelCalls(): number {
      return cancelCalls;
    },
  };
}

/* ------------------------------------------------------------------ pure -- */

test("content types map the §5 allowlist and refuse everything else", () => {
  assert.equal(contentTypeForName("plan.md"), "text/markdown");
  assert.equal(contentTypeForName("Plan.MD"), "text/markdown");
  // Longest suffix wins: .tar.gz is gzip, never a bare ".gz" guess.
  assert.equal(contentTypeForName("bundle.tar.gz"), "application/gzip");
  assert.equal(
    contentTypeForName("report.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  // .html/.htm are allowed (Fastio feedback): served as attachment, never inline.
  assert.equal(contentTypeForName("index.html"), "text/html");
  assert.equal(contentTypeForName("page.HTM"), "text/html");
  // Closed default: an unknown extension returns null rather than a guess.
  // A control that .exe stays refused proves the map did not go permissive.
  assert.equal(contentTypeForName("tool.exe"), null);
  assert.equal(contentTypeForName("no-extension"), null);
  assert.equal(contentTypeForName(""), null);
  assert.match(allowedExtensionList(), /\.md/);
});

test("writeDestination is atomic: wx without --force, EEXIST becomes the refusal", () => {
  const calls: Array<{ path: string; flag: string }> = [];
  const writer = (path: string, _bytes: Uint8Array, options: { flag: string }) => {
    calls.push({ path, flag: options.flag });
    if (options.flag === "wx" && path === "taken.md") {
      const error = new Error("EEXIST") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
  };
  // The flag IS the guard: pin it so a check-then-write regression cannot pass.
  writeDestination("fresh.md", new Uint8Array(), false, writer);
  assert.equal(calls.at(-1)?.flag, "wx");
  writeDestination("taken.md", new Uint8Array(), true, writer);
  assert.equal(calls.at(-1)?.flag, "w");
  assert.throws(
    () => writeDestination("taken.md", new Uint8Array(), false, writer),
    (error: unknown) =>
      error instanceof LocalFileExists && /--force/.test(error.message),
  );
  // A non-EEXIST writer failure surfaces as itself, not as the refusal.
  const broken = () => {
    const error = new Error("EACCES") as NodeJS.ErrnoException;
    error.code = "EACCES";
    throw error;
  };
  assert.throws(
    () => writeDestination("x.md", new Uint8Array(), false, broken),
    /EACCES/,
  );
});

test("onceRetried retries exactly the unknown-outcome class, once", async () => {
  let attempts = 0;
  const succeedsSecond = async () => {
    attempts += 1;
    if (attempts === 1) throw new FileTransportError("no response", true);
    return "ok";
  };
  assert.equal(await onceRetried(succeedsSecond), "ok");
  assert.equal(attempts, 2);

  // A received refusal is a KNOWN outcome: never retried.
  let refusals = 0;
  await assert.rejects(
    onceRetried(async () => {
      refusals += 1;
      throw new FileCommandRefused(409, "file_version_cap", "cap");
    }),
    FileCommandRefused,
  );
  assert.equal(refusals, 1);

  // Two transport failures stop after the single retry.
  let hard = 0;
  await assert.rejects(
    onceRetried(async () => {
      hard += 1;
      throw new FileTransportError("still down", true);
    }),
    FileTransportError,
  );
  assert.equal(hard, 2);
});

test("every file read deadline stays armed through a stalled response body", async () => {
  const readers: Array<{
    name: string;
    start: (fetcher: typeof fetch, options: ReadDeadlineOptions) => Promise<unknown>;
  }> = [
    {
      name: "agent list",
      start: (fetcher, options) =>
        listFilesAsAgent(
          TARGET,
          "swm_agt_x",
          "3ab184b3-fbb4-5ee9-afad-3842a604439a",
          fetcher,
          options,
        ),
    },
    {
      name: "human list",
      start: (fetcher, options) =>
        listFilesAsHuman(
          TARGET,
          "human-access-token",
          "3ab184b3-fbb4-5ee9-afad-3842a604439a",
          fetcher,
          options,
        ),
    },
    {
      name: "download",
      start: (fetcher, options) =>
        getObject(TARGET, "/storage/v1/object/download", fetcher, options),
    },
  ];

  for (const reader of readers) {
    const deadline = manualDeadline();
    let stalledResponse: Response | undefined;
    const stalled = fakeFetcher(() => {
      stalledResponse = new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<void>(() => {});
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      return stalledResponse;
    });
    const read = reader.start(stalled, {
      deadlineMs: 25,
      now: () => 0,
      schedule: deadline.schedule,
      cancel: deadline.cancel,
    });
    for (let turn = 0; turn < 5 && stalledResponse?.bodyUsed !== true; turn += 1) {
      await Promise.resolve();
    }
    assert.equal(
      stalledResponse?.bodyUsed,
      true,
      `${reader.name}: the control must reach body consumption`,
    );
    const cancelsAtHeaders = deadline.cancelCalls;
    deadline.expire();
    assert.equal(
      cancelsAtHeaders,
      0,
      `${reader.name}: headers must not clear the deadline`,
    );
    await assert.rejects(
      Promise.race([
        read,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("body-stall control hung")), 100)
        ),
      ]),
      (error: unknown) =>
        error instanceof FileTransportError && error.noResponse === true,
      `${reader.name}: the deadline must return the typed retryable error`,
    );
    assert.equal(deadline.delayMs, 25);
    assert.equal(deadline.cancelCalls, 1);
  }
});

test("one read retry gets only the remaining overall budget", async () => {
  let nowMs = 1_000;
  let attempts = 0;
  const remainingAtAttempt: number[] = [];
  const value = await onceRetried(
    async (attempt) => {
      attempts += 1;
      assert.notEqual(attempt.deadlineMs, undefined);
      remainingAtAttempt.push(attempt.deadlineMs! - nowMs);
      if (attempts === 1) {
        nowMs = 1_850;
        throw new FileTransportError("first attempt had no response", true);
      }
      return "ok";
    },
    {
      timeoutMs: 1_000,
      retryFloorMs: 100,
      now: () => nowMs,
    },
  );
  assert.equal(value, "ok");
  assert.deepEqual(remainingAtAttempt, [1_000, 150]);

  nowMs = 5_000;
  attempts = 0;
  const belowFloor = new FileTransportError("budget nearly spent", true);
  await assert.rejects(
    onceRetried(
      async () => {
        attempts += 1;
        nowMs = 5_901;
        throw belowFloor;
      },
      {
        timeoutMs: 1_000,
        retryFloorMs: 100,
        now: () => nowMs,
      },
    ),
    (error: unknown) => error === belowFloor,
  );
  assert.equal(attempts, 1, "a retry below the floor must not start");
});

test("absoluteStorageUrl composes only server-relative paths", () => {
  assert.equal(
    absoluteStorageUrl(TARGET, "/storage/v1/object/x"),
    "https://example.supabase.co/storage/v1/object/x",
  );
  assert.throws(
    () => absoluteStorageUrl(TARGET, "https://attacker.example/steal"),
    FileTransportError,
  );
});

test("a refusal keeps the server's message — the numbers survive to the user", async () => {
  const fetcher = fakeFetcher(() =>
    new Response(
      JSON.stringify({
        error: "file_too_large",
        message: "this file is 31 MB; the per-file limit is 25 MB",
      }),
      { status: 409 },
    )
  );
  await assert.rejects(
    fileVersionCreate({
      target: TARGET,
      workspaceId: "3ab184b3-fbb4-5ee9-afad-3842a604439a",
      credential: "swm_agt_x",
      fetcher,
    }, {
      fileId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      name: "big.pdf",
      declaredSizeBytes: 31 * 1024 * 1024,
      contentType: "application/pdf",
    }),
    (error: unknown) =>
      error instanceof FileCommandRefused &&
      error.status === 409 &&
      error.code === "file_too_large" &&
      /31 MB.*25 MB/.test(error.message),
  );
});

test("the agent list posts the exact read shape and rejects malformed bodies", async () => {
  let captured: Record<string, unknown> | null = null;
  const good = fakeFetcher((_input, init) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        files: [],
        sha256_note: "unverified client attestation",
        content_warning: FILE_CONTENT_WARNING,
      }),
      { status: 200 },
    );
  });
  const rows = await listFilesAsAgent(
    TARGET,
    "swm_agt_x",
    "3ab184b3-fbb4-5ee9-afad-3842a604439a",
    good,
  );
  assert.deepEqual(rows, []);
  assert.deepEqual(captured, {
    resource: "files",
    workspace_id: "3ab184b3-fbb4-5ee9-afad-3842a604439a",
  });
  const malformed = fakeFetcher(() =>
    new Response(JSON.stringify({ nonsense: true }), { status: 200 })
  );
  await assert.rejects(
    listFilesAsAgent(
      TARGET,
      "swm_agt_x",
      "3ab184b3-fbb4-5ee9-afad-3842a604439a",
      malformed,
    ),
    FileTransportError,
  );
});

/* ------------------------------------------------- fake cloud + real CLI -- */

const WORKSPACE = "3ab184b3-fbb4-5ee9-afad-3842a604439a";
const KNOWN_FILE_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const AGENT_TOKEN = `swm_agt_${"a".repeat(43)}`;
const DOWNLOAD_BYTES = "downloaded-bytes-from-the-fake-cloud";
const RESTORABLE_UNTIL = "2026-09-17 12:00:00+00";

interface RecordedCommand {
  command_id: string;
  command: Record<string, unknown>;
}

interface FakeCloud {
  url: string;
  commands: RecordedCommand[];
  storagePuts: Array<{ path: string; bytes: Buffer }>;
  reads: number;
  failFirstCreate: boolean;
  server: Server;
  close(): Promise<void>;
}

async function startFakeCloud(): Promise<FakeCloud> {
  const state: FakeCloud = {
    url: "",
    commands: [],
    storagePuts: [],
    reads: 0,
    failFirstCreate: false,
    server: undefined as unknown as Server,
    close: async () => {},
  };
  /* Mimics the S1+S2 command-id replay: the same id returns the stored
   * response, which is exactly what makes the CLI's same-id retry safe. */
  const stored = new Map<string, { status: number; body: unknown }>();
  let createAttempts = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const url = request.url ?? "";
      if (request.method === "PUT" && url.startsWith("/storage/")) {
        state.storagePuts.push({ path: url, bytes: raw });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (request.method === "GET" && url.startsWith("/storage/")) {
        response.writeHead(200, { "content-type": "text/markdown" });
        response.end(DOWNLOAD_BYTES);
        return;
      }
      if (request.method === "POST" && url === "/functions/v1/read") {
        state.reads += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          files: [{
            file_id: KNOWN_FILE_ID,
            name: "plan.md",
            current_version: 1,
            size_bytes: "18",
            content_type: "text/markdown",
            sha256: null,
            created_by_kind: "agent",
            created_by: randomUUID(),
            uploaded_by_kind: "agent",
            uploaded_by: randomUUID(),
            created_at: "2026-08-18T00:00:00Z",
            committed_at: "2026-08-18T00:00:00Z",
            tombstoned_at: null,
          }],
          sha256_note: "unverified client attestation",
          content_warning: FILE_CONTENT_WARNING,
        }));
        return;
      }
      if (request.method === "POST" && url === "/functions/v1/command") {
        const body = JSON.parse(raw.toString()) as {
          command_id: string;
          command: Record<string, unknown>;
        };
        state.commands.push({ command_id: body.command_id, command: body.command });
        const kind = String(body.command.kind);
        if (kind === "file_version_create") {
          createAttempts += 1;
          if (state.failFirstCreate && createAttempts === 1) {
            // The unknown-outcome class: the socket dies before any response.
            request.socket.destroy();
            return;
          }
        }
        const replay = stored.get(body.command_id);
        if (replay !== undefined) {
          response.writeHead(replay.status, { "content-type": "application/json" });
          response.end(JSON.stringify(replay.body));
          return;
        }
        const fileId = String(body.command.file_id ?? KNOWN_FILE_ID);
        let out: Record<string, unknown>;
        if (kind === "file_version_create") {
          out = {
            ok: true,
            status: "accepted",
            file_id: fileId,
            version_id: body.command.version_id,
            version_n: 1,
            name: body.command.name,
            upload_path:
              `/storage/v1/object/upload/sign/swarm-files/${WORKSPACE}/${fileId}/1?token=fake`,
            upload_token: null,
            upload_expires_in_seconds: 7200,
          };
        } else if (kind === "file_version_commit") {
          out = {
            ok: true,
            status: "accepted",
            file_id: fileId,
            version_id: body.command.version_id,
            version_n: 1,
            name: "plan.md",
            size_bytes: state.storagePuts.at(-1)?.bytes.byteLength ?? 0,
            sha256: body.command.sha256,
            sha256_note: "unverified client attestation",
            reference: `file:${fileId}@v1`,
          };
        } else if (kind === "file_download_url") {
          out = {
            ok: true,
            status: "accepted",
            file_id: fileId,
            version_n: body.command.version_n ?? 1,
            name: "plan.md",
            size_bytes: DOWNLOAD_BYTES.length,
            content_type: "text/markdown",
            download_path: "/storage/v1/object/sign/swarm-files/dl?token=fake",
            download_url_expires_in_seconds: 300,
            content_warning: FILE_CONTENT_WARNING,
          };
        } else if (kind === "file_tombstone") {
          out = {
            ok: true,
            status: "accepted",
            file_id: fileId,
            name: "plan.md",
            restorable_until: RESTORABLE_UNTIL,
            note:
              "Restorable with file_restore until the date above; existing download URLs expire on their own 5-minute clock.",
          };
        } else if (kind === "file_restore") {
          out = {
            ok: true,
            status: "accepted",
            file_id: fileId,
            name: "plan.md",
            restored: true,
          };
        } else {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_request" }));
          return;
        }
        stored.set(body.command_id, { status: 200, body: out });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(out));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake cloud failed to bind");
  }
  state.url = `http://127.0.0.1:${address.port}`;
  state.server = server;
  state.close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  return state;
}

const scratch = mkdtempSync(join(tmpdir(), "cswarm-file-verbs-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function cliAgainst(
  cloud: FakeCloud,
  args: string[],
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
    "--agent-token-stdin",
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
  child.stdin.end(AGENT_TOKEN);
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

test("file put drives create -> PUT -> commit in order with the ★R10 echo", async () => {
  const cloud = await startFakeCloud();
  try {
    const localPath = join(scratch, "plan.md");
    const content = "# plan\n\nreview me\n";
    writeFileSync(localPath, content);
    const result = await cliAgainst(cloud, ["file", "put", localPath]);
    assert.equal(result.code, 0, result.stderr);

    const kinds = cloud.commands.map((entry) => entry.command.kind);
    assert.deepEqual(kinds, ["file_version_create", "file_version_commit"]);
    const create = cloud.commands[0]!.command;
    assert.equal(create.name, "plan.md");
    assert.equal(create.declared_size_bytes, content.length);
    assert.equal(create.content_type, "text/markdown");
    // The PUT landed between the two commands, on the signed path.
    assert.equal(cloud.storagePuts.length, 1);
    assert.match(
      cloud.storagePuts[0]!.path,
      /^\/storage\/v1\/object\/upload\/sign\/swarm-files\//,
    );
    assert.equal(cloud.storagePuts[0]!.bytes.toString(), content);
    const commit = cloud.commands[1]!.command;
    assert.equal(commit.file_id, create.file_id);
    assert.equal(commit.version_id, create.version_id);
    assert.equal(
      commit.sha256,
      createHash("sha256").update(content).digest("hex"),
    );
    // ★R10: the versioned reference is the copy-paste line.
    assert.match(result.stdout, new RegExp(`--about file:${String(create.file_id)}@v1`));
    assert.match(result.stdout, /unverified client attestation/);
  } finally {
    await cloud.close();
  }
});

test("file put --json passes the commit body through", async () => {
  const cloud = await startFakeCloud();
  try {
    const localPath = join(scratch, "shapes.md");
    writeFileSync(localPath, "shapes");
    const result = await cliAgainst(cloud, ["file", "put", localPath, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    for (const key of ["file_id", "version_id", "version_n", "name", "size_bytes", "sha256", "sha256_note", "reference"]) {
      assert.ok(key in body, `put --json is missing ${key}`);
    }
  } finally {
    await cloud.close();
  }
});

test("an unknown-outcome create is retried with the SAME ids and replays safely", async () => {
  const cloud = await startFakeCloud();
  cloud.failFirstCreate = true;
  try {
    const localPath = join(scratch, "retry.md");
    writeFileSync(localPath, "retry me");
    const result = await cliAgainst(cloud, ["file", "put", localPath]);
    assert.equal(result.code, 0, result.stderr);
    const creates = cloud.commands.filter(
      (entry) => entry.command.kind === "file_version_create",
    );
    assert.equal(creates.length, 2, "the no-response attempt was retried once");
    // Finding 2a: the retry reuses every id, so the server replay — not a
    // second version — resolves the unknown outcome.
    assert.equal(creates[0]!.command_id, creates[1]!.command_id);
    assert.equal(creates[0]!.command.file_id, creates[1]!.command.file_id);
    assert.equal(creates[0]!.command.version_id, creates[1]!.command.version_id);
    const commits = cloud.commands.filter(
      (entry) => entry.command.kind === "file_version_commit",
    );
    assert.equal(commits.length, 1);
  } finally {
    await cloud.close();
  }
});

test("file get resolves a name, downloads, and refuses to overwrite atomically", async () => {
  const cloud = await startFakeCloud();
  try {
    const out = join(scratch, "kept.md");
    writeFileSync(out, "KEEP");
    const refused = await cliAgainst(
      cloud,
      ["file", "get", "plan.md", "--out", out],
    );
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /--force/);
    // Finding 1: the original bytes survive the refusal — nothing truncated.
    assert.equal(readFileSync(out, "utf8"), "KEEP");
    // The name selector resolved through the read to the known file id.
    const download = cloud.commands.find(
      (entry) => entry.command.kind === "file_download_url",
    );
    assert.ok(download, "download url was requested");
    assert.equal(download!.command.file_id, KNOWN_FILE_ID);
    assert.ok(cloud.reads >= 1, "the name resolved through the files read");

    const forced = await cliAgainst(
      cloud,
      ["file", "get", "plan.md", "--out", out, "--force"],
    );
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(readFileSync(out, "utf8"), DOWNLOAD_BYTES);
    assert.match(forced.stdout, /Downloaded plan\.md version 1/);
    assert.match(forced.stdout, new RegExp(FILE_CONTENT_WARNING.slice(0, 30)));
  } finally {
    await cloud.close();
  }
});

test("file get --json carries the grant plus where the bytes went", async () => {
  const cloud = await startFakeCloud();
  try {
    const out = join(scratch, "json-get.md");
    const result = await cliAgainst(
      cloud,
      ["file", "get", KNOWN_FILE_ID, "--out", out, "--json"],
    );
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    for (const key of ["file_id", "version_n", "name", "content_type", "content_warning", "written_to", "written_bytes"]) {
      assert.ok(key in body, `get --json is missing ${key}`);
    }
    assert.equal(body.written_bytes, DOWNLOAD_BYTES.length);
    // A file-id selector must not need the read round-trip.
    assert.equal(cloud.reads, 0);
  } finally {
    await cloud.close();
  }
});

test("file rm announces the ★R7 window and file restore closes the loop", async () => {
  const cloud = await startFakeCloud();
  try {
    const removed = await cliAgainst(cloud, ["file", "rm", "plan.md"]);
    assert.equal(removed.code, 0, removed.stderr);
    const tombstone = cloud.commands.find(
      (entry) => entry.command.kind === "file_tombstone",
    );
    assert.deepEqual(
      Object.keys(tombstone!.command).sort(),
      ["file_id", "kind"],
      "tombstone request carries exactly the compound-key target",
    );
    assert.equal(tombstone!.command.file_id, KNOWN_FILE_ID);
    // ★R7: no ceremony, and the response ANNOUNCES the purge date.
    assert.match(
      removed.stdout,
      new RegExp(`restorable with cswarm file restore until ${RESTORABLE_UNTIL.slice(0, 10)}`),
    );
    assert.match(removed.stdout, /purge permanently deletes the bytes/);
    assert.match(removed.stdout, /5-minute clock/);

    const restored = await cliAgainst(cloud, ["file", "restore", KNOWN_FILE_ID]);
    assert.equal(restored.code, 0, restored.stderr);
    const restore = cloud.commands.find(
      (entry) => entry.command.kind === "file_restore",
    );
    assert.deepEqual(Object.keys(restore!.command).sort(), ["file_id", "kind"]);
    assert.match(restored.stdout, /Restored plan\.md/);
  } finally {
    await cloud.close();
  }
});

test("file ls renders the list with one warning line", async () => {
  const cloud = await startFakeCloud();
  try {
    const result = await cliAgainst(cloud, ["file", "ls"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Files in this workspace \(1\):/);
    assert.match(result.stdout, /plan\.md {2}v1/);
    const warnings = result.stdout.split(FILE_CONTENT_WARNING).length - 1;
    assert.equal(warnings, 1, "the warning renders once, not per row");
  } finally {
    await cloud.close();
  }
});

test("file download-url requests pin the version argument shape", async () => {
  const cloud = await startFakeCloud();
  try {
    const out = join(scratch, "versioned.md");
    const result = await cliAgainst(
      cloud,
      ["file", "get", KNOWN_FILE_ID, "--version", "3", "--out", out],
    );
    assert.equal(result.code, 0, result.stderr);
    const download = cloud.commands.find(
      (entry) => entry.command.kind === "file_download_url",
    );
    assert.deepEqual(
      Object.keys(download!.command).sort(),
      ["file_id", "kind", "version_n"],
    );
    assert.equal(download!.command.version_n, 3);
  } finally {
    await cloud.close();
  }
});

/* -------------------------------------------------------- spawned usage -- */

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

test("cswarm file names its five actions when asked for anything else", async () => {
  const result = await cli(["file", "frobnicate"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /put, ls, get, rm, or restore/);
});

test("cswarm file put without a path is a usage error, not a network error", async () => {
  const result = await cli(["file", "put"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /needs a local path/);
});

test("the usage block names every file verb", async () => {
  const result = await cli(["--help"]);
  for (const verb of ["file put", "file ls", "file get", "file rm", "file restore"]) {
    assert.match(result.stdout + result.stderr, new RegExp(`cswarm ${verb}`));
  }
});
