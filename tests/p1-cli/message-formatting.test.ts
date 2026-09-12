import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENT_MESSAGE_FORMAT_RULE,
  AGENT_QUICK_GUIDE,
  isBlobBody,
  isMessageBlob,
  MESSAGE_BLOB_MIN_LENGTH,
} from "../../src/cloud/agent-onboarding-contract.js";
import {
  BodyEmptyError,
  BodyFileError,
  BodySourceConflictError,
  BodySourceError,
  BodySourceMissingError,
  BodyStdinConflictError,
  BodyStdinError,
  FORMAT_ADVISORY_FIELD,
  FORMAT_ADVISORY_MESSAGE,
  messageFormatAdvisory,
  stripSingleTrailingNewline,
} from "../../src/cli.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SIGNAL_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "66666666-6666-4666-8666-666666666666";
const AGENT_TOKEN = `swm_agt_${"a".repeat(43)}`;

const ARTIFACT = JSON.stringify({
  agent_token: AGENT_TOKEN,
  message:
    "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.",
  principal_id: AGENT,
  run_id: RUN_ID,
  status: "accepted",
  token_id: TOKEN_ID,
  expires_at: "2099-01-01T00:00:00.000Z",
});

async function runCli(
  args: string[],
  input = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    ...args,
  ], {
    cwd: root,
    env: {
      ...process.env,
      SWARM_CLOUD_URL: "",
      SWARM_CLOUD_ANON_KEY: "",
      SWARM_CLOUD_WORKSPACE_ID: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  child.stdin.end(input);
  const code = await new Promise<number>((res, rej) => {
    child.once("error", rej);
    child.once("close", (status) => res(status ?? 1));
  });
  return { code, stdout, stderr };
}

function createMockCloudServer(onCommand?: (cmd: any) => void) {
  return createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => raw += chunk);
    req.on("end", () => {
      let payload: Record<string, any> = {};
      try {
        payload = JSON.parse(raw);
      } catch {
        // empty / non-json
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (payload.resource === "members" || payload.resource === "signals") {
        res.end(JSON.stringify({ members: [], agents: [], signals: [] }));
        return;
      }
      if (payload.command) {
        onCommand?.(payload.command);
        res.end(JSON.stringify({
          status: "accepted",
          ok: true,
          event_ids: [],
          events: [],
          signal: {
            id: SIGNAL_ID,
            workspace_id: WORKSPACE,
            from: AGENT,
            from_kind: "agent",
            to: null,
            to_agent: null,
            in_reply_to: null,
            about: null,
            kind: payload.command.signal_kind ?? "note",
            body: payload.command.body,
            until: "2099-01-01T00:00:00.000Z",
            created_at: "2026-09-11T00:00:00.000Z",
          },
        }));
        return;
      }
      res.end(JSON.stringify({ ok: true, members: [], agents: [], signals: [] }));
    });
  });
}

// ---------------------------------------------------------------------------
// 1. Contract & Predicate Unit Tests
// ---------------------------------------------------------------------------

test("blob predicate: 500 chars with no newline is a blob, 499 is not", () => {
  assert.equal(MESSAGE_BLOB_MIN_LENGTH, 500);

  const exactBlob = "x".repeat(500);
  assert.equal(isBlobBody(exactBlob), true);
  assert.equal(isMessageBlob(exactBlob), true);

  const underBlob = "x".repeat(499);
  assert.equal(isBlobBody(underBlob), false);
  assert.equal(isMessageBlob(underBlob), false);
});

test("blob predicate: long body with a newline anywhere is not a blob", () => {
  const withNewline = "x".repeat(400) + "\n" + "x".repeat(200);
  assert.equal(isBlobBody(withNewline), false);

  const withWindowsNewline = "x".repeat(400) + "\r\n" + "x".repeat(200);
  assert.equal(isBlobBody(withWindowsNewline), false);

  const newlineAtStart = "\n" + "x".repeat(600);
  assert.equal(isBlobBody(newlineAtStart), false);

  const newlineAtEnd = "x".repeat(600) + "\n";
  assert.equal(isBlobBody(newlineAtEnd), false);
});

test("blob predicate: empty and 1-char bodies do not throw", () => {
  assert.equal(isBlobBody(""), false);
  assert.equal(isBlobBody("a"), false);
  assert.equal(isBlobBody(" "), false);
  assert.equal(isBlobBody("\n"), false);
});

test("stripSingleTrailingNewline: strips at most one trailing newline and preserves everything else", () => {
  assert.equal(stripSingleTrailingNewline("hello\n"), "hello");
  assert.equal(stripSingleTrailingNewline("hello\r\n"), "hello");
  assert.equal(stripSingleTrailingNewline("hello\n\n"), "hello\n");
  assert.equal(stripSingleTrailingNewline("hello\r\n\r\n"), "hello\r\n");
  assert.equal(stripSingleTrailingNewline("hello"), "hello");

  const complex = "# Title\n\n```ts\nconst x = 1;\n```\n";
  assert.equal(stripSingleTrailingNewline(complex), "# Title\n\n```ts\nconst x = 1;\n```");
});

test("messageFormatAdvisory: emits advisory only for blobs and never throws", () => {
  assert.equal(messageFormatAdvisory("x".repeat(500)), FORMAT_ADVISORY_MESSAGE);
  assert.equal(messageFormatAdvisory("x".repeat(499)), null);
  assert.equal(messageFormatAdvisory("x".repeat(500) + "\n"), null);
  assert.equal(messageFormatAdvisory(""), null);
  assert.equal(FORMAT_ADVISORY_FIELD, "format_advisory");
});

test("typed error classes: export codes and retain error hierarchies", () => {
  const fileErr = new BodyFileError("body_file_missing", "missing");
  assert.equal(fileErr.code, "body_file_missing");
  assert.ok(fileErr instanceof BodyFileError);

  const conflictErr = new BodySourceConflictError();
  assert.equal(conflictErr.code, "body_source_conflict");
  assert.ok(conflictErr instanceof BodySourceError);
  assert.ok(conflictErr instanceof BodySourceConflictError);

  const missingErr = new BodySourceMissingError();
  assert.equal(missingErr.code, "body_source_missing");
  assert.ok(missingErr instanceof BodySourceError);
  assert.ok(missingErr instanceof BodySourceMissingError);

  const stdinConflictErr = new BodyStdinConflictError();
  assert.equal(stdinConflictErr.code, "body_stdin_token_stdin_conflict");
  assert.ok(stdinConflictErr instanceof BodyStdinConflictError);

  const emptyErr = new BodyEmptyError();
  assert.equal(emptyErr.code, "body_empty");
  assert.ok(emptyErr instanceof BodyEmptyError);

  const stdinErr = new BodyStdinError("body_stdin_tty", "tty error");
  assert.equal(stdinErr.code, "body_stdin_tty");
  assert.ok(stdinErr instanceof BodyStdinError);
});

// ---------------------------------------------------------------------------
// 2. Drift Test
// ---------------------------------------------------------------------------

test("drift test: site prompt and AGENT_QUICK_GUIDE both derive from AGENT_MESSAGE_FORMAT_RULE", async () => {
  const sitePromptSource = await readFile(
    resolve(root, "site/src/components/connect/agent-prompt.ts"),
    "utf8",
  );
  assert.match(
    sitePromptSource,
    /import\s*\{[^}]*AGENT_MESSAGE_FORMAT_RULE[^}]*\}\s*from/,
    "site agent-prompt.ts must import AGENT_MESSAGE_FORMAT_RULE",
  );
  assert.match(
    sitePromptSource,
    /\$\{AGENT_MESSAGE_FORMAT_RULE\}/,
    "site agent-prompt.ts must interpolate AGENT_MESSAGE_FORMAT_RULE into the prompt text",
  );

  assert.ok(
    AGENT_QUICK_GUIDE.includes(AGENT_MESSAGE_FORMAT_RULE),
    "AGENT_QUICK_GUIDE must contain AGENT_MESSAGE_FORMAT_RULE",
  );
  assert.match(
    AGENT_QUICK_GUIDE,
    /--body-file/,
    "AGENT_QUICK_GUIDE must mention --body-file",
  );
});

// ---------------------------------------------------------------------------
// 3. CLI Input & Formatting Tests with Mock Cloud Server
// ---------------------------------------------------------------------------

test("--body-file byte-identical post with blank lines, code blocks, and single trailing newline stripped", async () => {
  let receivedBody = "";
  let networkCalls = 0;

  const server = createMockCloudServer((cmd) => {
    networkCalls++;
    receivedBody = cmd.body;
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-"));
  const mdPath = resolve(dir, "message.md");
  const markdownContent = [
    "# Section Title",
    "",
    "A paragraph with **bold** text and `inline code`.",
    "",
    "```typescript",
    "export function calculate(): number {",
    "  return 42;",
    "}",
    "```",
    "",
  ].join("\n"); // ends with single \n

  try {
    await writeFile(mdPath, markdownContent, "utf8");
    const port = (server.address() as { port: number }).port;
    const target = [
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
      "--json",
    ];

    const result = await runCli(["note", "--body-file", mdPath, ...target], AGENT_TOKEN);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(networkCalls, 1);

    const expectedBody = [
      "# Section Title",
      "",
      "A paragraph with **bold** text and `inline code`.",
      "",
      "```typescript",
      "export function calculate(): number {",
      "  return 42;",
      "}",
      "```",
    ].join("\n");

    assert.equal(receivedBody, expectedBody);
    const parsedJson = JSON.parse(result.stdout) as { signal: { body: string }; format_advisory?: string };
    assert.equal(parsedJson.signal.body, expectedBody);
    assert.equal(parsedJson.format_advisory, undefined, "non-blob body should not have format_advisory");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("--body-file with two trailing newlines retains the second one", async () => {
  let receivedBody = "";

  const server = createMockCloudServer((cmd) => {
    receivedBody = cmd.body;
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-2nl-"));
  const mdPath = resolve(dir, "two_newlines.md");
  const content = "Line 1\nLine 2\n\n";

  try {
    await writeFile(mdPath, content, "utf8");
    const port = (server.address() as { port: number }).port;
    const target = [
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
      "--json",
    ];

    const result = await runCli(["note", "--body-file", mdPath, ...target], AGENT_TOKEN);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(receivedBody, "Line 1\nLine 2\n");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("--body-stdin reads from piped stdin byte-identical and posts", async () => {
  let receivedBody = "";

  const server = createMockCloudServer((cmd) => {
    receivedBody = cmd.body;
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-stdin-"));
  const credPath = resolve(dir, "cred.json");

  try {
    await writeFile(credPath, ARTIFACT, { mode: 0o600 });
    const port = (server.address() as { port: number }).port;
    const target = [
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-file",
      credPath,
      "--json",
    ];

    const stdinPayload = "Piped stdin line 1\n\nPiped stdin line 2\n";
    const result = await runCli(["note", "--body-stdin", ...target], stdinPayload);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(receivedBody, "Piped stdin line 1\n\nPiped stdin line 2");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Parse-Time Refusal Tests (No Network Calls)
// ---------------------------------------------------------------------------

test("refusal at parse time: two body sources at once is refused", async () => {
  let networkCalls = 0;
  const server = createServer(() => networkCalls++);
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-conflict-"));
  const mdPath = resolve(dir, "msg.md");
  const credPath = resolve(dir, "cred.json");
  await writeFile(mdPath, "content", "utf8");
  await writeFile(credPath, ARTIFACT, { mode: 0o600 });

  try {
    const port = (server.address() as { port: number }).port;
    const targetStdinAuth = [
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
    ];
    const targetFileAuth = [
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-file",
      credPath,
    ];

    // Positional + --body-file
    const res1 = await runCli(["note", "positional text", "--body-file", mdPath, ...targetStdinAuth], AGENT_TOKEN);
    assert.equal(res1.code, 1);
    assert.match(res1.stderr, /body_source_conflict/);
    assert.equal(networkCalls, 0, "must refuse before network call");

    // --body-file + --body-stdin (using --agent-token-file so it doesn't trigger token stdin conflict first)
    const res2 = await runCli(["note", "--body-file", mdPath, "--body-stdin", ...targetFileAuth]);
    assert.equal(res2.code, 1);
    assert.match(res2.stderr, /body_source_conflict/);
    assert.equal(networkCalls, 0);

    // reply with UUID + positional + --body-file
    const res3 = await runCli(["reply", SIGNAL_ID, "positional text", "--body-file", mdPath, ...targetStdinAuth], AGENT_TOKEN);
    assert.equal(res3.code, 1);
    assert.match(res3.stderr, /body_source_conflict/);
    assert.equal(networkCalls, 0);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("refusal at parse time: zero body sources is refused", async () => {
  let networkCalls = 0;
  const server = createServer(() => networkCalls++);
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  try {
    const port = (server.address() as { port: number }).port;
    const target = [
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
    ];

    for (const verb of ["note", "ask", "working-on"]) {
      const res = await runCli([verb, ...target], AGENT_TOKEN);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /body_source_missing/);
      assert.equal(networkCalls, 0);
    }

    const replyRes = await runCli(["reply", SIGNAL_ID, ...target], AGENT_TOKEN);
    assert.equal(replyRes.code, 1);
    assert.match(replyRes.stderr, /body_source_missing/);
    assert.equal(networkCalls, 0);
  } finally {
    server.close();
  }
});

test("refusal at parse time: --body-stdin with --agent-token-stdin is refused before reading streams", async () => {
  const res = await runCli([
    "note",
    "--body-stdin",
    "--agent-token-stdin",
    "--url",
    "http://127.0.0.1:1",
    "--anon-key",
    "anon",
    "--workspace-id",
    WORKSPACE,
  ]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /body_stdin_token_stdin_conflict/);
  assert.match(res.stderr, /cannot read both message body and agent credential from stdin/);
});

test("refusal at parse time: file >8000 characters is refused with existing length error", async () => {
  let networkCalls = 0;
  const server = createServer(() => networkCalls++);
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-large-"));
  const mdPath = resolve(dir, "large.md");
  // 8001 chars
  await writeFile(mdPath, "a".repeat(8001), "utf8");

  try {
    const port = (server.address() as { port: number }).port;
    const res = await runCli([
      "note",
      "--body-file",
      mdPath,
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
    ], AGENT_TOKEN);

    assert.equal(res.code, 1);
    assert.match(res.stderr, /signal text is 8001 characters; the maximum is 8000/);
    assert.equal(networkCalls, 0, "large body must be refused before network call");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("refusal at parse time: file or stdin containing only whitespace is refused", async () => {
  let networkCalls = 0;
  const server = createServer(() => networkCalls++);
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-ws-"));
  const mdPath = resolve(dir, "whitespace.md");
  const credPath = resolve(dir, "cred.json");
  await writeFile(mdPath, "   \n\n  \t  \n", "utf8");
  await writeFile(credPath, ARTIFACT, { mode: 0o600 });

  try {
    const port = (server.address() as { port: number }).port;

    // File with whitespace
    const resFile = await runCli([
      "note",
      "--body-file",
      mdPath,
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
    ], AGENT_TOKEN);
    assert.equal(resFile.code, 1);
    assert.match(resFile.stderr, /body_empty/);
    assert.equal(networkCalls, 0);

    // Stdin with whitespace
    const resStdin = await runCli([
      "note",
      "--body-stdin",
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-file",
      credPath,
    ], "   \n  \n");
    assert.equal(resStdin.code, 1);
    assert.match(resStdin.stderr, /body_empty/);
    assert.equal(networkCalls, 0);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("refusal at parse time: missing or unreadable file gives typed error naming the path", async () => {
  let networkCalls = 0;
  const server = createServer(() => networkCalls++);
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-missing-"));
  const nonExistentPath = resolve(dir, "does-not-exist.md");

  try {
    const port = (server.address() as { port: number }).port;

    // Missing file
    const resMissing = await runCli([
      "note",
      "--body-file",
      nonExistentPath,
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
    ], AGENT_TOKEN);
    assert.equal(resMissing.code, 1);
    assert.match(resMissing.stderr, /body_file_missing/);
    assert.match(resMissing.stderr, new RegExp(nonExistentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(networkCalls, 0);

    // Unreadable file (pass a directory as --body-file)
    const resUnreadable = await runCli([
      "note",
      "--body-file",
      dir,
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
    ], AGENT_TOKEN);
    assert.equal(resUnreadable.code, 1);
    assert.match(resUnreadable.stderr, /body_file_unreadable/);
    assert.match(resUnreadable.stderr, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(networkCalls, 0);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Blob Advisory Line & Receipt Tests (All 4 verbs, text and --json)
// ---------------------------------------------------------------------------

test("advisory line on post receipt: emitted when body is blob, omitted when not; body byte-identical", async () => {
  let postedBody = "";

  const server = createMockCloudServer((cmd) => {
    postedBody = cmd.body;
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const blobText = "x".repeat(500); // 500 characters, no newline -> blob!
  const normalText = "Short message with newlines\nSecond line";

  try {
    const port = (server.address() as { port: number }).port;
    const target = [
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
    ];

    // 1. Blob body in text mode -> advisory line present
    const resBlobText = await runCli(["note", blobText, ...target], AGENT_TOKEN);
    assert.equal(resBlobText.code, 0, resBlobText.stderr);
    assert.match(resBlobText.stdout, new RegExp(FORMAT_ADVISORY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(postedBody, blobText, "posted body must never be mutated");

    // 2. Blob body in --json mode -> format_advisory field present
    const resBlobJson = await runCli(["note", blobText, ...target, "--json"], AGENT_TOKEN);
    assert.equal(resBlobJson.code, 0, resBlobJson.stderr);
    const blobJsonParsed = JSON.parse(resBlobJson.stdout) as { format_advisory?: string; signal: { body: string } };
    assert.equal(blobJsonParsed.format_advisory, FORMAT_ADVISORY_MESSAGE);
    assert.equal(blobJsonParsed.signal.body, blobText);

    // 3. Normal body in text mode -> advisory line absent
    const resNormalText = await runCli(["note", normalText, ...target], AGENT_TOKEN);
    assert.equal(resNormalText.code, 0, resNormalText.stderr);
    assert.doesNotMatch(resNormalText.stdout, new RegExp(FORMAT_ADVISORY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // 4. Normal body in --json mode -> format_advisory omitted (not null)
    const resNormalJson = await runCli(["note", normalText, ...target, "--json"], AGENT_TOKEN);
    assert.equal(resNormalJson.code, 0, resNormalJson.stderr);
    const normalJsonParsed = JSON.parse(resNormalJson.stdout) as Record<string, unknown>;
    assert.equal("format_advisory" in normalJsonParsed, false);
  } finally {
    server.close();
  }
});

test("all 4 verbs (note, ask, reply, working-on) support --body-file and format advisory", async () => {
  let lastPostedKind = "";
  let lastPostedBody = "";

  const server = createMockCloudServer((cmd) => {
    lastPostedKind = cmd.signal_kind ?? "note";
    lastPostedBody = cmd.body;
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-verbs-"));
  const blobFile = resolve(dir, "blob.txt");
  const blobContent = "y".repeat(500); // blob
  await writeFile(blobFile, blobContent, "utf8");

  try {
    const port = (server.address() as { port: number }).port;
    const target = [
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
      "--json",
    ];

    // note
    const noteRes = await runCli(["note", "--body-file", blobFile, ...target], AGENT_TOKEN);
    assert.equal(noteRes.code, 0, noteRes.stderr);
    assert.equal(lastPostedKind, "note");
    assert.equal(JSON.parse(noteRes.stdout).format_advisory, FORMAT_ADVISORY_MESSAGE);

    // ask
    const askRes = await runCli(["ask", "--body-file", blobFile, ...target], AGENT_TOKEN);
    assert.equal(askRes.code, 0, askRes.stderr);
    assert.equal(lastPostedKind, "ask");
    assert.equal(JSON.parse(askRes.stdout).format_advisory, FORMAT_ADVISORY_MESSAGE);

    // working-on
    const woRes = await runCli(["working-on", "--body-file", blobFile, ...target], AGENT_TOKEN);
    assert.equal(woRes.code, 0, woRes.stderr);
    assert.equal(lastPostedKind, "working-on");
    assert.equal(JSON.parse(woRes.stdout).format_advisory, FORMAT_ADVISORY_MESSAGE);

    // reply
    const replyRes = await runCli(["reply", SIGNAL_ID, "--body-file", blobFile, ...target], AGENT_TOKEN);
    assert.equal(replyRes.code, 0, replyRes.stderr);
    assert.equal(JSON.parse(replyRes.stdout).format_advisory, FORMAT_ADVISORY_MESSAGE);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
