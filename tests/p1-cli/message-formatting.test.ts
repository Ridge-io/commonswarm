import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import {
  AGENT_MESSAGE_FORMAT_RULE,
  AGENT_QUICK_GUIDE,
  isBlobBody,
  isMessageBlob,
  MESSAGE_BLOB_MIN_LENGTH,
} from "../../src/cloud/agent-onboarding-contract.js";
import {
  Arguments,
  BODY_BOOLEAN_FLAGS,
  BODY_FLAGS,
  BODY_SOURCES,
  BOOLEAN_FLAGS,
  BodyEmptyError,
  BodyEncodingError,
  BodyFileError,
  BodyLengthError,
  BodySourceConflictError,
  BodySourceError,
  BodySourceMissingError,
  BodyStdinConflictError,
  BodyStdinError,
  FORMAT_ADVISORY_FIELD,
  FORMAT_ADVISORY_MESSAGE,
  KNOWN_FLAGS,
  SIGNAL_BODY_MAX,
  STREAM_CHUNK_BYTE_LIMIT,
  formatBodySourceConflict,
  formatBodySourceMissing,
  formatBodyUsage,
  formatOrList,
  messageFormatAdvisory,
  readBoundedUtf8Stream,
  resolveSignalBody,
  stripSingleTrailingNewline,
  usage,
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
  input: string | Buffer = "",
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

  const stdinUnreadableErr = new BodyStdinError("body_stdin_unreadable", "unreadable");
  assert.equal(stdinUnreadableErr.code, "body_stdin_unreadable");
  assert.ok(stdinUnreadableErr instanceof BodyStdinError);

  const encodingErr = new BodyEncodingError();
  assert.equal(encodingErr.code, "body_invalid_utf8");
  assert.ok(encodingErr instanceof BodyEncodingError);

  const lengthErr = new BodyLengthError();
  assert.equal(lengthErr.code, "body_too_large");
  assert.ok(lengthErr instanceof BodyLengthError);
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

  const contractSource = await readFile(
    resolve(root, "src/cloud/agent-onboarding-contract.ts"),
    "utf8",
  );
  assert.match(
    contractSource,
    /AGENT_QUICK_GUIDE\s*=\s*`[^`]*\$\{AGENT_MESSAGE_FORMAT_RULE\}[^`]*`/,
    "agent-onboarding-contract.ts must interpolate AGENT_MESSAGE_FORMAT_RULE into AGENT_QUICK_GUIDE",
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

test("body source runtime gate: parser registers BODY_FLAGS and every source supplies a body end to end", async () => {
  // 1. Structural check on src/cli.ts: ensure the four messages are generated from BODY_SOURCES, not typed literals
  const cliSource = await readFile(resolve(root, "src/cli.ts"), "utf8");

  assert.match(
    cliSource,
    /const\s+signalBody\s*=\s*formatBodyUsage\(["']<text>["']\);/,
    "src/cli.ts must generate signalBody using formatBodyUsage",
  );
  assert.match(
    cliSource,
    /const\s+workingOnBody\s*=\s*formatBodyUsage\(["']<what>["']\);/,
    "src/cli.ts must generate workingOnBody using formatBodyUsage",
  );
  assert.match(
    cliSource,
    /throw\s+new\s+BodySourceConflictError\(\s*["']body_source_conflict["'],\s*formatBodySourceConflict\(\),?\s*\)/,
    "src/cli.ts must generate BodySourceConflictError using formatBodySourceConflict",
  );
  assert.match(
    cliSource,
    /throw\s+new\s+BodySourceMissingError\(\s*["']body_source_missing["'],\s*formatBodySourceMissing\([^)]+\),?\s*\)/,
    "src/cli.ts must generate BodySourceMissingError using formatBodySourceMissing",
  );

  // Negative control on src/cli.ts: old hardcoded strings must NOT be present
  assert.ok(
    !cliSource.includes('("<text>" | --body-file <path> | --body-stdin)'),
    "src/cli.ts must not contain hardcoded signalBody usage string",
  );
  assert.ok(
    !cliSource.includes('("<what>" | --body-file <path> | --body-stdin)'),
    "src/cli.ts must not contain hardcoded workingOnBody usage string",
  );
  assert.ok(
    !cliSource.includes('"use exactly one body source: positional text, --body-file, or --body-stdin"'),
    "src/cli.ts must not contain hardcoded conflict message",
  );

  // Verify usage() actually renders the generated synopses
  const helpText = usage();
  const signalUsage = formatBodyUsage("<text>");
  const workingOnUsage = formatBodyUsage("<what>");
  assert.ok(helpText.includes(`cswarm note ${signalUsage}`), "usage() must include note synopsis");
  assert.ok(helpText.includes(`cswarm ask ${signalUsage}`), "usage() must include ask synopsis");
  assert.ok(helpText.includes(`cswarm reply <signal-id> ${signalUsage}`), "usage() must include reply synopsis");
  assert.ok(helpText.includes(`cswarm working-on ${workingOnUsage}`), "usage() must include working-on synopsis");

  // 2. Parser flag registration derives from BODY_SOURCES
  // KNOWN_FLAGS spreads ...BODY_FLAGS (for error wording during CLI parsing)
  assert.match(
    cliSource,
    /export\s+const\s+KNOWN_FLAGS\s*=\s*new\s+Set\(\[\s*[\s\S]*?\.\.\.BODY_FLAGS,/,
    "KNOWN_FLAGS must spread ...BODY_FLAGS",
  );
  assert.match(
    cliSource,
    /export\s+const\s+BOOLEAN_FLAGS\s*=\s*new\s+Set\(\[\s*[\s\S]*?\.\.\.BODY_BOOLEAN_FLAGS,/,
    "BOOLEAN_FLAGS must spread ...BODY_BOOLEAN_FLAGS",
  );

  const knownFlagsMatch = cliSource.match(
    /export\s+const\s+KNOWN_FLAGS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(knownFlagsMatch, "KNOWN_FLAGS Set definition must be found");
  assert.ok(
    !knownFlagsMatch[1].includes('"body-file"') && !knownFlagsMatch[1].includes('"body-stdin"'),
    "KNOWN_FLAGS must derive body flags via ...BODY_FLAGS, not literal strings",
  );

  const booleanFlagsMatch = cliSource.match(
    /export\s+const\s+BOOLEAN_FLAGS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(booleanFlagsMatch, "BOOLEAN_FLAGS Set definition must be found");
  assert.ok(
    !booleanFlagsMatch[1].includes('"body-stdin"'),
    "BOOLEAN_FLAGS must derive body flags via ...BODY_BOOLEAN_FLAGS, not literal string",
  );

  assert.match(
    cliSource,
    /async\s+function\s+runPostSignal\([\s\S]*?const\s+allowedFlags\s*=\s*\[[\s\S]*?\.\.\.BODY_FLAGS,/,
    "runPostSignal allowedFlags must spread ...BODY_FLAGS",
  );
  assert.match(
    cliSource,
    /async\s+function\s+runReply\([\s\S]*?const\s+allowedFlags\s*=\s*\[[\s\S]*?\.\.\.BODY_FLAGS,/,
    "runReply allowedFlags must spread ...BODY_FLAGS",
  );

  const parserKnownBodyFlags = [...KNOWN_FLAGS].filter((f) => f.startsWith("body-")).sort();
  const declaredBodyFlags = [...BODY_FLAGS].sort();
  assert.deepEqual(
    parserKnownBodyFlags,
    declaredBodyFlags,
    "parser KNOWN_FLAGS body flags must equal BODY_FLAGS",
  );

  const parserBooleanBodyFlags = [...BOOLEAN_FLAGS].filter((f) => f.startsWith("body-")).sort();
  const declaredBooleanBodyFlags = [...BODY_BOOLEAN_FLAGS].sort();
  assert.deepEqual(
    parserBooleanBodyFlags,
    declaredBooleanBodyFlags,
    "parser BOOLEAN_FLAGS body flags must equal BODY_BOOLEAN_FLAGS",
  );

  // Contracted body sources must be present
  assert.ok(
    BODY_FLAGS.includes("body-file"),
    "BODY_FLAGS must include contracted flag body-file",
  );
  assert.ok(
    BODY_FLAGS.includes("body-stdin"),
    "BODY_FLAGS must include contracted flag body-stdin",
  );
  assert.ok(
    BODY_SOURCES.some((s) => s.name === "positional"),
    "BODY_SOURCES must include contracted source positional",
  );

  // 3. Parser recognition: accepts all declared body flags and rejects unknown body flags
  for (const flag of BODY_FLAGS) {
    const source = BODY_SOURCES.find((s) => s.kind === "flag" && s.flag === flag);
    assert.ok(source, `every BODY_FLAG must correspond to a flag source entry`);
    if (source.boolean) {
      const parsed = new Arguments(["note", `--${flag}`]);
      assert.equal(parsed.has(flag), true);
    } else {
      const parsed = new Arguments(["note", `--${flag}`, "test-val"]);
      assert.equal(parsed.optional(flag), "test-val");
    }
  }
  assert.throws(
    () => new Arguments(["note", "--body-unknown-drift-check"]),
    /unknown option --body-unknown-drift-check/,
  );

  // Parser acceptance enforcement: unallowed flags are rejected by assertShape in resolveSignalBody
  const unallowedArgs = new Arguments(["note", "positional body", "--unallowed-extra-flag", "x"]);
  await assert.rejects(
    () => resolveSignalBody(unallowedArgs, 1, ["workspace-id", ...BODY_FLAGS]),
    (err: any) => {
      assert.match(err.message, /unknown option: --unallowed-extra-flag/);
      return true;
    },
  );

  // 4. Runtime dispatch verification: resolveSignalBody dispatches through activeSources[0].read
  const resolveBodyMatch = cliSource.match(
    /export\s+async\s+function\s+resolveSignalBody\([\s\S]*?\n\}/,
  );
  assert.ok(resolveBodyMatch, "resolveSignalBody must be found in src/cli.ts");
  const resolveBodyCode = resolveBodyMatch[0];
  assert.match(
    resolveBodyCode,
    /const\s+raw\s*=\s*await\s+activeSources\[0\]!\.read\(args,\s*positionalIndex\);/,
    "resolveSignalBody must dispatch to activeSources[0]!.read(args, positionalIndex)",
  );
  assert.ok(
    !resolveBodyCode.includes("fromFile") &&
      !resolveBodyCode.includes("fromStdin") &&
      !resolveBodyCode.includes("readFileBody") &&
      !resolveBodyCode.includes("readStdinBody"),
    "resolveSignalBody must not contain hardcoded fromFile or fromStdin branches",
  );

  const originalPositionalRead = BODY_SOURCES[0]!.read;
  let spyDispatched = false;
  (BODY_SOURCES[0] as any).read = () => {
    spyDispatched = true;
    return "spy-dispatched-body";
  };
  try {
    const spyArgs = new Arguments(["note", "positional-val"]);
    const dispatchedBody = await resolveSignalBody(spyArgs, 1, ["workspace-id", ...BODY_FLAGS]);
    assert.equal(spyDispatched, true, "resolveSignalBody must dispatch to activeSources[0].read");
    assert.equal(
      dispatchedBody,
      "spy-dispatched-body",
      "resolveSignalBody must return the result of activeSources[0].read",
    );
  } finally {
    (BODY_SOURCES[0] as any).read = originalPositionalRead;
  }

  // 5. Runtime behavior: every entry in BODY_SOURCES has a wired reader and can supply a body end to end
  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-gate-"));
  try {
    for (const source of BODY_SOURCES) {
      assert.equal(
        typeof source.read,
        "function",
        `source ${source.name} must have a wired read function on its BODY_SOURCES entry`,
      );

      if (source.name === "positional") {
        const args = new Arguments(["note", "gate positional body"]);
        const body = await resolveSignalBody(args, 1, ["workspace-id", ...BODY_FLAGS]);
        assert.equal(body, "gate positional body");
      } else if (source.name === "body-file") {
        const tmpFile = resolve(dir, "body-file.txt");
        await writeFile(tmpFile, "gate file body\n");
        const args = new Arguments(["note", "--body-file", tmpFile]);
        const body = await resolveSignalBody(args, 1, ["workspace-id", ...BODY_FLAGS]);
        assert.equal(body, "gate file body");
      } else if (source.usesStdin) {
        // Direct stream reading test on stdin source
        const streamResult = await source.read(
          new Arguments(["note", `--${source.flag}`]),
          1,
          Readable.from([Buffer.from("gate direct stream body\n")]),
        );
        assert.equal(streamResult, "gate direct stream body");
      } else {
        // Any newly added non-stdin source must supply a valid non-empty body when invoked
        const args = source.boolean
          ? new Arguments(["note", `--${source.flag}`])
          : new Arguments(["note", `--${source.flag}`, "test-input"]);
        const body = await resolveSignalBody(args, 1, ["workspace-id", ...BODY_FLAGS]);
        assert.ok(typeof body === "string" && body.length > 0);
      }
    }

    // body-stdin supplies body end to end through the CLI process
    let receivedStdinBody = "";
    const server = createMockCloudServer((cmd) => {
      receivedStdinBody = cmd.body;
    });
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res());
    });
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
      const result = await runCli(["note", "--body-stdin", ...target], "gate stdin body\n");
      assert.equal(result.code, 0, result.stderr);
      assert.equal(receivedStdinBody, "gate stdin body");
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // 6. Stdin exclusion check derives from BODY_SOURCES
  for (const source of BODY_SOURCES.filter((s) => s.usesStdin && s.kind === "flag")) {
    const conflictArgs = new Arguments([
      "note",
      `--${source.flag}`,
      "--agent-token-stdin",
    ]);
    await assert.rejects(
      () => resolveSignalBody(conflictArgs, 1, ["workspace-id", "agent-token-stdin", ...BODY_FLAGS]),
      (err: any) => {
        assert.equal(err.code, "body_stdin_token_stdin_conflict");
        assert.ok(err.message.includes(source.conflictLabel));
        return true;
      },
    );
  }

  // Dynamic stdin exclusion: prove exclusion derives from BODY_SOURCES.find(...) and is not hardcoded to --body-stdin
  const dynamicStdinSource = {
    name: "body-dynamic-stdin",
    kind: "flag" as const,
    flag: "body-dynamic-stdin",
    boolean: true,
    usesStdin: true,
    conflictLabel: "--body-dynamic-stdin",
    missingLabel: "--body-dynamic-stdin",
    usageToken: () => "--body-dynamic-stdin",
    isPresent: (args: Arguments) => args.has("body-dynamic-stdin"),
    read: () => "dynamic stdin body",
  };
  (BODY_SOURCES as any).push(dynamicStdinSource);
  KNOWN_FLAGS.add("body-dynamic-stdin");
  BOOLEAN_FLAGS.add("body-dynamic-stdin");
  try {
    const dynamicConflictArgs = new Arguments([
      "note",
      "--body-dynamic-stdin",
      "--agent-token-stdin",
    ]);
    await assert.rejects(
      () =>
        resolveSignalBody(
          dynamicConflictArgs,
          1,
          ["workspace-id", "agent-token-stdin", ...BODY_FLAGS, "body-dynamic-stdin"],
        ),
      (err: any) => {
        assert.equal(err.code, "body_stdin_token_stdin_conflict");
        assert.ok(
          err.message.includes("--body-dynamic-stdin"),
          "stdin conflict error message must derive from the dynamic source's conflictLabel",
        );
        return true;
      },
    );
  } finally {
    (BODY_SOURCES as any).pop();
    KNOWN_FLAGS.delete("body-dynamic-stdin");
    BOOLEAN_FLAGS.delete("body-dynamic-stdin");
  }
});

// ---------------------------------------------------------------------------
// 3. CLI Input & Formatting Tests with Mock Cloud Server
// ---------------------------------------------------------------------------

test("--body-file sends body unchanged to server with blank lines, code blocks, and single trailing newline stripped", async () => {
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

test("--body-stdin reads from piped stdin and sends body unchanged to server apart from single trailing newline", async () => {
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
    assert.match(res.stderr, /body_too_large/);
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
    assert.match(resMissing.stderr, /^cswarm: \[body_file_missing\]/);
    assert.doesNotMatch(resMissing.stderr, /\[body_file_unreadable\]/);
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
    assert.match(resUnreadable.stderr, /^cswarm: \[body_file_unreadable\]/);
    assert.doesNotMatch(resUnreadable.stderr, /\[body_file_missing\]/);
    assert.equal((resUnreadable.stderr.match(/could not read --body-file/g) || []).length, 1, "must not double wrap error message");
    assert.match(resUnreadable.stderr, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(networkCalls, 0);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("refusal at parse time: invalid UTF-8 in --body-file is refused with typed error naming path", async () => {
  let networkCalls = 0;
  const server = createServer(() => networkCalls++);
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-invalid-utf8-"));
  const badPath = resolve(dir, "bad-utf8.bin");
  // 0xff is invalid in UTF-8
  await writeFile(badPath, Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff]));

  try {
    const port = (server.address() as { port: number }).port;
    const res = await runCli([
      "note",
      "--body-file",
      badPath,
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
    ], AGENT_TOKEN);

    assert.equal(res.code, 1);
    assert.match(res.stderr, /body_invalid_utf8/);
    assert.match(res.stderr, new RegExp(badPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(networkCalls, 0, "invalid UTF-8 must be refused before network call");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("refusal at parse time: invalid UTF-8 in --body-stdin is refused with typed error", async () => {
  let networkCalls = 0;
  const server = createServer(() => networkCalls++);
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-stdin-utf8-"));
  const credPath = resolve(dir, "cred.json");
  await writeFile(credPath, ARTIFACT, { mode: 0o600 });

  try {
    const port = (server.address() as { port: number }).port;
    const res = await runCli([
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
    ], Buffer.from([0x61, 0x62, 0xff, 0x63]));

    assert.equal(res.code, 1);
    assert.match(res.stderr, /body_invalid_utf8/);
    assert.match(res.stderr, /--body-stdin/);
    assert.equal(networkCalls, 0, "invalid UTF-8 on stdin must be refused before network call");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("refusal at parse time: large over-limit file (>8000 chars) is refused with bounded read and typed error", async () => {
  let networkCalls = 0;
  const server = createServer(() => networkCalls++);
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-large-file-"));
  const largePath = resolve(dir, "large.txt");
  // 100,000 chars - proves bounded resource use does not retain whole file
  await writeFile(largePath, "x".repeat(100000), "utf8");

  try {
    const port = (server.address() as { port: number }).port;
    const res = await runCli([
      "note",
      "--body-file",
      largePath,
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
    ], AGENT_TOKEN);

    assert.equal(res.code, 1);
    assert.match(res.stderr, /body_too_large/);
    assert.match(res.stderr, /maximum of 8000 characters/);
    assert.equal(networkCalls, 0, "large body must be refused before network call");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("refusal at parse time: large over-limit stdin (>8000 chars) is refused with bounded read and typed error", async () => {
  let networkCalls = 0;
  const server = createServer(() => networkCalls++);
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-large-stdin-"));
  const credPath = resolve(dir, "cred.json");
  await writeFile(credPath, ARTIFACT, { mode: 0o600 });

  try {
    const port = (server.address() as { port: number }).port;
    const res = await runCli([
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
    ], "y".repeat(100000));

    assert.equal(res.code, 1);
    assert.match(res.stderr, /body_too_large/);
    assert.match(res.stderr, /maximum of 8000 characters/);
    assert.equal(networkCalls, 0, "large stdin must be refused before network call");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("boundary: 8000 chars plus single newline is accepted; 8001 plus newline is refused", async () => {
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

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-bound-"));
  const okLfPath = resolve(dir, "ok-lf.txt");
  const okCrlfPath = resolve(dir, "ok-crlf.txt");
  const overLfPath = resolve(dir, "over-lf.txt");

  await writeFile(okLfPath, "a".repeat(8000) + "\n", "utf8");
  await writeFile(okCrlfPath, "b".repeat(8000) + "\r\n", "utf8");
  await writeFile(overLfPath, "c".repeat(8001) + "\n", "utf8");

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

    // 8000 chars + \n -> stripped to 8000 chars, accepted
    const resLf = await runCli(["note", "--body-file", okLfPath, ...target], AGENT_TOKEN);
    assert.equal(resLf.code, 0, resLf.stderr);
    assert.equal(receivedBody, "a".repeat(8000));

    // 8000 chars + \r\n -> stripped to 8000 chars, accepted
    const resCrlf = await runCli(["note", "--body-file", okCrlfPath, ...target], AGENT_TOKEN);
    assert.equal(resCrlf.code, 0, resCrlf.stderr);
    assert.equal(receivedBody, "b".repeat(8000));

    // 8001 chars + \n -> stripped to 8001 chars, refused
    const resOver = await runCli(["note", "--body-file", overLfPath, ...target], AGENT_TOKEN);
    assert.equal(resOver.code, 1);
    assert.match(resOver.stderr, /body_too_large/);
    assert.match(resOver.stderr, /signal text is 8001 characters; the maximum is 8000/);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("multi-byte UTF-8 payload is sent unchanged without replacement", async () => {
  let receivedBody = "";
  const server = createMockCloudServer((cmd) => {
    receivedBody = cmd.body;
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });

  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-multibyte-"));
  const mbPath = resolve(dir, "multibyte.txt");
  // Multi-byte Unicode: Japanese + accented + emojis (surrogate pairs in UTF-16)
  const content = "こんにちは世界 — café — 🚀✨\n";
  await writeFile(mbPath, content, "utf8");

  try {
    const port = (server.address() as { port: number }).port;
    const res = await runCli([
      "note",
      "--body-file",
      mbPath,
      "--url",
      `http://127.0.0.1:${port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
    ], AGENT_TOKEN);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(receivedBody, "こんにちは世界 — café — 🚀✨");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("readBoundedUtf8Stream: bounds resource use by stopping stream consumption once limit is exceeded", async () => {
  let chunksYielded = 0;
  let destroyed = false;
  async function* infiniteStream() {
    while (true) {
      chunksYielded++;
      if (chunksYielded > 5) {
        throw new Error("runaway stream: bounded reader did not stop consumption");
      }
      yield Buffer.alloc(4096, 0x61);
    }
  }

  await assert.rejects(
    async () => {
      await readBoundedUtf8Stream(infiniteStream(), SIGNAL_BODY_MAX, {
        source: "stdin",
        destroy: () => { destroyed = true; },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof BodyLengthError);
      assert.equal(err.code, "body_too_large");
      assert.match(err.message, /maximum of 8000 characters/);
      return true;
    },
  );

  assert.equal(destroyed, true, "stream must be destroyed immediately when bound is passed");
  assert.equal(chunksYielded, 2, "must not read more chunks once bound is passed");
});

// ---------------------------------------------------------------------------
// 5. Blob Advisory Line & Receipt Tests (All 4 verbs, text and --json)
// ---------------------------------------------------------------------------

test("advisory line on post receipt: emitted when body is blob, omitted when not; sent body unchanged", async () => {
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
    assert.equal(postedBody, blobText, "client must send body unchanged");

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

// ---------------------------------------------------------------------------
// 6. Fix Round 2 Tests: BOM, Memory Bound, Stdin Failure Typing, Positional Empty
// ---------------------------------------------------------------------------

test("UTF-8 BOM: preserved as character, counted toward 8000 cap; BOM+8000 rejected, BOM+7999 accepted", async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const body8000 = Buffer.from("a".repeat(8000), "utf8");
  const body7999 = Buffer.from("a".repeat(7999), "utf8");

  async function* stream(buf: Buffer) {
    yield buf;
  }

  // 1. BOM + 8000 chars is 8001 code units -> rejected with BodyLengthError
  await assert.rejects(
    async () => {
      await readBoundedUtf8Stream(stream(Buffer.concat([bom, body8000])), SIGNAL_BODY_MAX, {
        source: "stdin",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof BodyLengthError);
      assert.equal(err.code, "body_too_large");
      assert.match(err.message, /signal text is 8001 characters; the maximum is 8000/);
      return true;
    },
  );

  // 2. BOM + 7999 chars is 8000 code units -> accepted and BOM character preserved (passed through)
  const accepted = await readBoundedUtf8Stream(stream(Buffer.concat([bom, body7999])), SIGNAL_BODY_MAX, {
    source: "stdin",
  });
  assert.equal(accepted.length, 8000);
  assert.equal(accepted.charCodeAt(0), 0xfeff, "leading BOM U+FEFF character must be preserved");
  assert.equal(accepted.slice(1), "a".repeat(7999));

  // 3. Via CLI with --body-file: BOM + 8000 chars is refused with body_too_large; BOM + 7999 chars is accepted
  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-bom-"));
  const overBomFile = resolve(dir, "over-bom.txt");
  await writeFile(overBomFile, Buffer.concat([bom, body8000]));
  const okBomFile = resolve(dir, "ok-bom.txt");
  await writeFile(okBomFile, Buffer.concat([bom, body7999]));

  let postedBody = "";
  const server = createMockCloudServer((cmd) => {
    postedBody = cmd.body;
  });
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

    const resOver = await runCli(["note", "--body-file", overBomFile, ...target], AGENT_TOKEN);
    assert.equal(resOver.code, 1);
    assert.match(resOver.stderr, /body_too_large/);
    assert.match(resOver.stderr, /signal text is 8001 characters; the maximum is 8000/);

    const resOk = await runCli(["note", "--body-file", okBomFile, ...target], AGENT_TOKEN);
    assert.equal(resOk.code, 0, resOk.stderr);
    assert.equal(postedBody.length, 8000);
    assert.equal(postedBody.charCodeAt(0), 0xfeff, "client sends BOM character intact to server");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stream bounds: oversized chunk is rejected before decoding and chunk slices check character bound before append", async () => {
  assert.equal(STREAM_CHUNK_BYTE_LIMIT, 4096);

  let destroyed = false;
  // An arbitrary iterable yields a huge chunk of 100,000 bytes with invalid UTF-8 byte at index 0.
  // Because the chunk is oversized, it is rejected with body_too_large BEFORE TextDecoder is ever
  // called, proving it is rejected before decoding and without appending to the accumulator rather than failing with body_invalid_utf8.
  const hugeChunk = Buffer.alloc(100000, 0x61);
  hugeChunk[0] = 0xff;
  async function* hugeChunkStream() {
    yield hugeChunk;
  }

  await assert.rejects(
    async () => {
      await readBoundedUtf8Stream(hugeChunkStream(), SIGNAL_BODY_MAX, {
        source: "stdin",
        destroy: () => { destroyed = true; },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof BodyLengthError, "must be BodyLengthError, not BodyEncodingError");
      assert.equal(err.code, "body_too_large");
      assert.match(err.message, /signal text exceeds the maximum of 8000 characters/);
      return true;
    },
  );
  assert.equal(destroyed, true);

  // Proves chunk-sliced decode bound: an 8203-byte chunk where bytes 0..8199 are valid ASCII
  // and byte 8200 has invalid UTF-8 (0xff). Because chunks are sliced to at most 4096 bytes,
  // slice 1 (4096..8191) exceeds maxChars + 2 (8002) and throws body_too_large BEFORE
  // byte 8200 is ever decoded. Without chunk slicing, TextDecoder would process the whole
  // chunk at once and throw body_invalid_utf8 instead of body_too_large.
  const valid8200 = Buffer.alloc(8200, 0x61);
  const invalidTrailing = Buffer.from([0xff, 0xff, 0xff]);
  const bigChunkWithTrailingInvalid = Buffer.concat([valid8200, invalidTrailing]);

  async function* invalidTrailingStream() {
    yield bigChunkWithTrailingInvalid;
  }

  await assert.rejects(
    async () => {
      await readBoundedUtf8Stream(invalidTrailingStream(), SIGNAL_BODY_MAX, {
        source: "stdin",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof BodyLengthError, "must be BodyLengthError, not BodyEncodingError");
      assert.equal(err.code, "body_too_large");
      return true;
    },
  );
});

test("stream bounds: byteLength getter is read once into a local, preventing lying getter from bypassing bounds", async () => {
  const typedArrayByteLength = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    "byteLength",
  )!.get!;
  class Liar extends Uint8Array {
    reads = 0;
    get byteLength() {
      this.reads++;
      return this.reads === 1 ? 1 : typedArrayByteLength.call(this);
    }
  }
  const liar = new Liar(64 * 1024 * 1024);
  liar.fill(0x61);

  async function* liarStream() {
    yield liar;
  }

  const result = await readBoundedUtf8Stream(liarStream(), SIGNAL_BODY_MAX, {
    source: "stdin",
  });
  assert.equal(liar.reads, 1, "byteLength getter must be read exactly once");
  assert.equal(result, "a");
});

test("cleanup safety: throwing destroy callback never erases typed errors or stable codes (D-053)", async () => {
  // 1. Stdin read failure with throwing destroy preserves BodyStdinError and body_stdin_unreadable
  async function* failingStdinStream() {
    throw new Error("raw socket disconnect error");
  }
  await assert.rejects(
    async () => {
      await readBoundedUtf8Stream(failingStdinStream(), SIGNAL_BODY_MAX, {
        source: "stdin",
        destroy: () => { throw new Error("destroy failed"); },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof BodyStdinError, "must be instance of BodyStdinError");
      assert.equal((err as BodyStdinError).code, "body_stdin_unreadable");
      assert.equal((err as BodyStdinError).name, "BodyStdinError");
      assert.match((err as Error).message, /\[body_stdin_unreadable\] could not read --body-stdin: raw socket disconnect error/);
      return true;
    },
  );

  // 2. File read failure with throwing destroy preserves BodyFileError and body_file_unreadable
  async function* failingFileStream() {
    throw new Error("disk read I/O error");
  }
  await assert.rejects(
    async () => {
      await readBoundedUtf8Stream(failingFileStream(), SIGNAL_BODY_MAX, {
        source: "file",
        filePath: "/tmp/mock-signal.txt",
        destroy: () => { throw new Error("destroy failed"); },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof BodyFileError, "must be instance of BodyFileError");
      assert.equal((err as BodyFileError).code, "body_file_unreadable");
      assert.equal((err as BodyFileError).name, "BodyFileError");
      assert.match((err as Error).message, /\[body_file_unreadable\] could not read --body-file \/tmp\/mock-signal\.txt: disk read I\/O error/);
      return true;
    },
  );

  // 3. Length error with throwing destroy preserves BodyLengthError and body_too_large
  async function* overLengthStream() {
    yield Buffer.alloc(100000, 0x61);
  }
  await assert.rejects(
    async () => {
      await readBoundedUtf8Stream(overLengthStream(), SIGNAL_BODY_MAX, {
        source: "stdin",
        destroy: () => { throw new Error("destroy failed"); },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof BodyLengthError, "must be instance of BodyLengthError");
      assert.equal((err as BodyLengthError).code, "body_too_large");
      assert.equal((err as BodyLengthError).name, "BodyLengthError");
      return true;
    },
  );

  // 4. Invalid UTF-8 error with throwing destroy preserves BodyEncodingError and body_invalid_utf8
  async function* invalidUtf8Stream() {
    yield Buffer.from([0xff, 0xff]);
  }
  await assert.rejects(
    async () => {
      await readBoundedUtf8Stream(invalidUtf8Stream(), SIGNAL_BODY_MAX, {
        source: "stdin",
        destroy: () => { throw new Error("destroy failed"); },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof BodyEncodingError, "must be instance of BodyEncodingError");
      assert.equal((err as BodyEncodingError).code, "body_invalid_utf8");
      assert.equal((err as BodyEncodingError).name, "BodyEncodingError");
      return true;
    },
  );

  // 5. Hostile error with throwing code getter preserves typed BodyFileError and body_file_unreadable
  const hostile = new Error("disk read failure");
  Object.defineProperty(hostile, "code", {
    get() { throw new Error("code getter escaped"); },
  });
  async function* hostileStream() {
    throw hostile;
  }
  await assert.rejects(
    async () => {
      await readBoundedUtf8Stream(hostileStream(), SIGNAL_BODY_MAX, {
        source: "file",
        filePath: "/tmp/mock-signal.txt",
        destroy: () => { throw new Error("destroy failed"); },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof BodyFileError, "must be instance of BodyFileError");
      assert.equal((err as BodyFileError).code, "body_file_unreadable");
      assert.equal((err as BodyFileError).name, "BodyFileError");
      assert.match((err as Error).message, /\[body_file_unreadable\] could not read --body-file \/tmp\/mock-signal\.txt: disk read failure/);
      return true;
    },
  );
});

test("cleanup safety on success: failing destroy after successful read does not fail a command whose bytes were read", async () => {
  // Bytes were read successfully; a failing destroy() callback must not fail a command that succeeded.
  async function* successfulStream() {
    yield Buffer.from("clean message body\n", "utf8");
  }
  const body = await readBoundedUtf8Stream(successfulStream(), SIGNAL_BODY_MAX, {
    source: "stdin",
    destroy: () => { throw new Error("destroy failed"); },
  });
  assert.equal(body, "clean message body");
});

test("chunk type safety: string chunks are excluded so lone surrogates cannot bypass strict UTF-8 validation", async () => {
  async function* stringStream() {
    yield "\ud800" as unknown as Uint8Array;
  }
  await assert.rejects(
    async () => {
      await readBoundedUtf8Stream(stringStream(), SIGNAL_BODY_MAX, {
        source: "stdin",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof BodyStdinError);
      assert.equal((err as BodyStdinError).code, "body_stdin_unreadable");
      return true;
    },
  );
});

test("stdin stream failure: throwing iterable is wrapped in typed BodyStdinError with stable code body_stdin_unreadable", async () => {
  async function* failingStream() {
    throw new Error("raw socket disconnect error");
  }

  await assert.rejects(
    async () => {
      await readBoundedUtf8Stream(failingStream(), SIGNAL_BODY_MAX, {
        source: "stdin",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof BodyStdinError, "must be instance of BodyStdinError");
      assert.equal((err as BodyStdinError).code, "body_stdin_unreadable");
      assert.equal((err as BodyStdinError).name, "BodyStdinError");
      assert.match((err as Error).message, /\[body_stdin_unreadable\] could not read --body-stdin: raw socket disconnect error/);
      return true;
    },
  );
});

test("positional empty bodies: newline, CRLF, and empty strings route to typed BodyEmptyError", async () => {
  const server = createMockCloudServer();
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

    // Positional "\n"
    const resLf = await runCli(["note", "\n", ...target], AGENT_TOKEN);
    assert.equal(resLf.code, 1);
    assert.match(resLf.stderr, /\[body_empty\] signal body cannot be empty or contain only whitespace/);

    // Positional "\r\n"
    const resCrlf = await runCli(["note", "\r\n", ...target], AGENT_TOKEN);
    assert.equal(resCrlf.code, 1);
    assert.match(resCrlf.stderr, /\[body_empty\] signal body cannot be empty or contain only whitespace/);

    // Positional ""
    const resEmpty = await runCli(["note", "", ...target], AGENT_TOKEN);
    assert.equal(resEmpty.code, 1);
    assert.match(resEmpty.stderr, /\[body_empty\] signal body cannot be empty or contain only whitespace/);

    // Positional "   "
    const resSpaces = await runCli(["note", "   ", ...target], AGENT_TOKEN);
    assert.equal(resSpaces.code, 1);
    assert.match(resSpaces.stderr, /\[body_empty\] signal body cannot be empty or contain only whitespace/);
  } finally {
    server.close();
  }
});
