import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  absoluteStorageUrl,
  allowedExtensionList,
  assertWritableDestination,
  contentTypeForName,
  FILE_CONTENT_WARNING,
  FileCommandRefused,
  FileTransportError,
  fileVersionCreate,
  listFilesAsAgent,
  LocalFileExists,
} from "../../src/cloud/files.js";
import { cloudTarget } from "../../src/cloud/config.js";

const TARGET = cloudTarget("https://example.supabase.co", "anon-key");

function fakeFetcher(
  handler: (input: string | URL | Request, init?: RequestInit) => Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    handler(input, init)) as typeof fetch;
}

test("content types map the §5 allowlist and refuse everything else", () => {
  assert.equal(contentTypeForName("plan.md"), "text/markdown");
  assert.equal(contentTypeForName("Plan.MD"), "text/markdown");
  // Longest suffix wins: .tar.gz is gzip, never a bare ".gz" guess.
  assert.equal(contentTypeForName("bundle.tar.gz"), "application/gzip");
  assert.equal(
    contentTypeForName("report.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  // Closed default: an unknown extension returns null rather than a guess —
  // the CLI refuses with the allowlist instead of uploading a type the server
  // will refuse after the round trip.
  assert.equal(contentTypeForName("tool.exe"), null);
  assert.equal(contentTypeForName("no-extension"), null);
  assert.equal(contentTypeForName(""), null);
  assert.match(allowedExtensionList(), /\.md/);
});

test("the overwrite guard refuses an existing destination unless forced", () => {
  const exists = (path: string) => path === "taken.md";
  // Mutation control both ways: the guard must fire exactly when the file
  // exists AND force is absent.
  assert.throws(
    () => assertWritableDestination("taken.md", false, exists),
    (error: unknown) =>
      error instanceof LocalFileExists && /--force/.test(error.message),
  );
  assert.doesNotThrow(() => assertWritableDestination("taken.md", true, exists));
  assert.doesNotThrow(() => assertWritableDestination("fresh.md", false, exists));
});

test("absoluteStorageUrl composes only server-relative paths", () => {
  assert.equal(
    absoluteStorageUrl(TARGET, "/storage/v1/object/x"),
    "https://example.supabase.co/storage/v1/object/x",
  );
  // A non-relative "path" from a hostile or broken server must not become a
  // request to an attacker-chosen origin.
  assert.throws(
    () => absoluteStorageUrl(TARGET, "https://attacker.example/steal"),
    FileTransportError,
  );
});

test("file commands send the standard envelope and return the body", async () => {
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  const fetcher = fakeFetcher((input, init) => {
    captured = {
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return new Response(
      JSON.stringify({
        ok: true,
        status: "accepted",
        file_id: "f",
        version_id: "v",
        version_n: 1,
        name: "plan.md",
        upload_path: "/storage/v1/object/upload/sign/swarm-files/x",
        upload_token: null,
        upload_expires_in_seconds: 7200,
      }),
      { status: 200 },
    );
  });
  const result = await fileVersionCreate({
    target: TARGET,
    workspaceId: "3ab184b3-fbb4-5ee9-afad-3842a604439a",
    credential: "swm_agt_x",
    fetcher,
  }, {
    fileId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
    name: "plan.md",
    declaredSizeBytes: 10,
    contentType: "text/markdown",
  });
  assert.equal(result.version_n, 1);
  assert.ok(captured, "the fetcher was reached");
  const sent = captured! as { url: string; body: Record<string, unknown> };
  assert.equal(sent.url, "https://example.supabase.co/functions/v1/command");
  assert.deepEqual(sent.body.stream, { kind: "workspace" });
  assert.equal(
    (sent.body.command as Record<string, unknown>).kind,
    "file_version_create",
  );
  // Command ids are the CLI's own CSPRNG shape (command-client newCommandId),
  // not UUIDs — pinned against what the system actually sends.
  assert.match(String(sent.body.command_id), /^cmd_[A-Za-z0-9_-]{20,}$/);
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

test("a bodyless refusal falls back to a plain sentence, never a crash", async () => {
  const fetcher = fakeFetcher(() => new Response("nope", { status: 403 }));
  await assert.rejects(
    fileVersionCreate({
      target: TARGET,
      workspaceId: "3ab184b3-fbb4-5ee9-afad-3842a604439a",
      credential: "swm_agt_x",
      fetcher,
    }, {
      fileId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      name: "plan.md",
      declaredSizeBytes: 10,
      contentType: "text/markdown",
    }),
    (error: unknown) =>
      error instanceof FileCommandRefused &&
      error.status === 403 &&
      error.code === "http_error" &&
      /HTTP 403/.test(error.message),
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
  // The read function validates by exact key set; an extra field is a 400.
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
