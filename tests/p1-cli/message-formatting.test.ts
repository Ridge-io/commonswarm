import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import ts from "typescript";

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
  postSignalAllowedFlags,
  readBoundedUtf8Stream,
  replyAllowedFlags,
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

  // Protective catch verification: must catch if inspection throws and return null without failing
  const throwingInspector = () => {
    throw new Error("simulated body inspector explosion");
  };
  assert.doesNotThrow(() => {
    assert.equal(messageFormatAdvisory("x".repeat(500), throwingInspector), null);
  });
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

test("body source runtime gate: KNOWN_FLAGS carries flag names for error text, per-command allowedFlags accept, and every source supplies a body end to end", async () => {
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

  // Structural check: formatters must map over BODY_SOURCES rather than returning hardcoded strings
  assert.match(
    cliSource,
    /export\s+function\s+formatBodyUsage\([^)]*\)[^{]*\{[\s\S]*?BODY_SOURCES\.map/,
    "formatBodyUsage must map over BODY_SOURCES",
  );
  assert.match(
    cliSource,
    /export\s+function\s+formatBodySourceConflict\([^)]*\)[^{]*\{[\s\S]*?BODY_SOURCES\.map/,
    "formatBodySourceConflict must map over BODY_SOURCES",
  );
  assert.match(
    cliSource,
    /export\s+function\s+formatBodySourceMissing\([^)]*\)[^{]*\{[\s\S]*?BODY_SOURCES\.map/,
    "formatBodySourceMissing must map over BODY_SOURCES",
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

  // Dynamic formatting verification: formatters dynamically reflect additions to BODY_SOURCES
  const probeSource = {
    name: "body-probe-source",
    kind: "flag" as const,
    flag: "body-probe-source",
    conflictLabel: "--body-probe-source",
    missingLabel: "--body-probe-source <val>",
    usageToken: () => "--body-probe-source <val>",
    isPresent: () => false,
    read: () => "probe-body",
  };
  (BODY_SOURCES as any).push(probeSource);
  try {
    const dynamicUsage = formatBodyUsage("<text>");
    const dynamicConflict = formatBodySourceConflict();
    const dynamicMissing = formatBodySourceMissing(1, 0);
    assert.ok(
      dynamicUsage.includes("--body-probe-source <val>"),
      "formatBodyUsage must dynamically derive from BODY_SOURCES",
    );
    assert.ok(
      dynamicConflict.includes("--body-probe-source"),
      "formatBodySourceConflict must dynamically derive from BODY_SOURCES",
    );
    assert.ok(
      dynamicMissing.includes("--body-probe-source <val>"),
      "formatBodySourceMissing must dynamically derive from BODY_SOURCES",
    );
  } finally {
    (BODY_SOURCES as any).pop();
  }

  // Verify usage() actually renders the generated synopses
  const helpText = usage();
  const signalUsage = formatBodyUsage("<text>");
  const workingOnUsage = formatBodyUsage("<what>");
  assert.ok(helpText.includes(`cswarm note ${signalUsage}`), "usage() must include note synopsis");
  assert.ok(helpText.includes(`cswarm ask ${signalUsage}`), "usage() must include ask synopsis");
  assert.ok(helpText.includes(`cswarm reply <signal-id> ${signalUsage}`), "usage() must include reply synopsis");
  assert.ok(helpText.includes(`cswarm working-on ${workingOnUsage}`), "usage() must include working-on synopsis");

  // Verify canonical format strings match expected output
  assert.equal(
    formatBodyUsage("<text>"),
    '("<text>" | --body-file <path> | --body-stdin)',
  );
  assert.equal(
    formatBodyUsage("<what>"),
    '("<what>" | --body-file <path> | --body-stdin)',
  );
  assert.equal(
    formatBodySourceConflict(),
    "use exactly one body source: positional text, --body-file, or --body-stdin",
  );
  assert.equal(
    formatBodySourceMissing(1, 0),
    "too few positional arguments: expected 1, received 0 (provide the message body as positional text, --body-file <path>, or --body-stdin)",
  );

  // 2. Flag registration and acceptance: KNOWN_FLAGS carries flag names for error text; per-command allowedFlags accept
  // Real AST check on src/cli.ts using typescript compiler API
  const cliSourceFile = ts.createSourceFile(
    resolve(root, "src/cli.ts"),
    cliSource,
    ts.ScriptTarget.Latest,
    true,
  );

  function findFunctionDeclaration(name: string): ts.FunctionDeclaration | undefined {
    let match: ts.FunctionDeclaration | undefined;
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
        match = node;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(cliSourceFile);
    return match;
  }

  function findVariableDeclaration(name: string): ts.VariableDeclaration | undefined {
    let match: ts.VariableDeclaration | undefined;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        match = node;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(cliSourceFile);
    return match;
  }

  // KNOWN_FLAGS spreads ...BODY_FLAGS (for error wording during CLI parsing, never acceptance)
  const knownFlagsDecl = findVariableDeclaration("KNOWN_FLAGS");
  assert.ok(knownFlagsDecl?.initializer, "KNOWN_FLAGS declaration must be found in src/cli.ts");
  assert.ok(
    ts.isNewExpression(knownFlagsDecl.initializer),
    "KNOWN_FLAGS must be initialized with new Set(...)",
  );
  const knownArg = knownFlagsDecl.initializer.arguments?.[0];
  assert.ok(
    knownArg && ts.isArrayLiteralExpression(knownArg),
    "KNOWN_FLAGS must pass array literal to new Set",
  );
  const knownSpreads = knownArg.elements
    .filter(ts.isSpreadElement)
    .map((e) => (ts.isIdentifier(e.expression) ? e.expression.text : ""));
  assert.ok(
    knownSpreads.includes("BODY_FLAGS"),
    "KNOWN_FLAGS must spread ...BODY_FLAGS for error wording",
  );
  const knownBodyStrings: string[] = [];
  function findKnownBodyStrings(node: ts.Node) {
    if (ts.isStringLiteral(node) && node.text.startsWith("body-")) {
      knownBodyStrings.push(node.text);
    }
    ts.forEachChild(node, findKnownBodyStrings);
  }
  findKnownBodyStrings(knownArg);
  assert.deepEqual(
    knownBodyStrings,
    [],
    `KNOWN_FLAGS must derive body flags via ...BODY_FLAGS, not literal strings: ${knownBodyStrings.join(", ")}`,
  );

  // BOOLEAN_FLAGS spreads ...BODY_BOOLEAN_FLAGS (for error wording during CLI parsing, never acceptance)
  const booleanFlagsDecl = findVariableDeclaration("BOOLEAN_FLAGS");
  assert.ok(booleanFlagsDecl?.initializer, "BOOLEAN_FLAGS declaration must be found in src/cli.ts");
  assert.ok(
    ts.isNewExpression(booleanFlagsDecl.initializer),
    "BOOLEAN_FLAGS must be initialized with new Set(...)",
  );
  const boolArg = booleanFlagsDecl.initializer.arguments?.[0];
  assert.ok(
    boolArg && ts.isArrayLiteralExpression(boolArg),
    "BOOLEAN_FLAGS must pass array literal to new Set",
  );
  const boolSpreads = boolArg.elements
    .filter(ts.isSpreadElement)
    .map((e) => (ts.isIdentifier(e.expression) ? e.expression.text : ""));
  assert.ok(
    boolSpreads.includes("BODY_BOOLEAN_FLAGS"),
    "BOOLEAN_FLAGS must spread ...BODY_BOOLEAN_FLAGS for error wording",
  );
  const boolBodyStrings: string[] = [];
  function findBoolBodyStrings(node: ts.Node) {
    if (ts.isStringLiteral(node) && node.text.startsWith("body-")) {
      boolBodyStrings.push(node.text);
    }
    ts.forEachChild(node, findBoolBodyStrings);
  }
  findBoolBodyStrings(boolArg);
  assert.deepEqual(
    boolBodyStrings,
    [],
    `BOOLEAN_FLAGS must derive body boolean flags via ...BODY_BOOLEAN_FLAGS, not literal strings: ${boolBodyStrings.join(", ")}`,
  );

  // AST check: each allowedFlags function strictly scoped to its own body
  for (const fn of ["postSignalAllowedFlags", "replyAllowedFlags"] as const) {
    const fnDecl = findFunctionDeclaration(fn);
    assert.ok(fnDecl?.body, `${fn} definition with body must be found in src/cli.ts`);

    let returnArray: ts.ArrayLiteralExpression | undefined;
    function visitBody(node: ts.Node) {
      if (
        ts.isReturnStatement(node) &&
        node.expression &&
        ts.isArrayLiteralExpression(node.expression)
      ) {
        returnArray = node.expression;
        return;
      }
      ts.forEachChild(node, visitBody);
    }
    visitBody(fnDecl.body);
    assert.ok(returnArray, `${fn} must return an array literal`);

    const spreads: string[] = [];
    for (const elem of returnArray.elements) {
      if (ts.isSpreadElement(elem) && ts.isIdentifier(elem.expression)) {
        spreads.push(elem.expression.text);
      }
    }
    assert.ok(
      spreads.includes("BODY_FLAGS"),
      `${fn} AST must directly spread ...BODY_FLAGS`,
    );
    const foreignBodySpreads = spreads.filter(
      (s) => s !== "BODY_FLAGS" && s.toLowerCase().includes("body"),
    );
    assert.deepEqual(
      foreignBodySpreads,
      [],
      `${fn} must not spread alternative body flag lists: ${foreignBodySpreads.join(", ")}`,
    );

    const bodyStringLiterals: string[] = [];
    function findBodyStrings(node: ts.Node) {
      if (ts.isStringLiteral(node) && node.text.startsWith("body-")) {
        bodyStringLiterals.push(node.text);
      }
      ts.forEachChild(node, findBodyStrings);
    }
    findBodyStrings(fnDecl.body);
    assert.deepEqual(
      bodyStringLiterals,
      [],
      `${fn} must not contain hardcoded body flags: ${bodyStringLiterals.join(", ")}`,
    );
  }

  // AST check: runPostSignal and runReply dispatch to their respective allowedFlags functions
  for (const [callerName, calleeName] of [
    ["runPostSignal", "postSignalAllowedFlags"],
    ["runReply", "replyAllowedFlags"],
  ] as const) {
    const callerDecl = findFunctionDeclaration(callerName);
    assert.ok(callerDecl?.body, `Function ${callerName} must be declared with body in src/cli.ts`);
    let callsCallee = false;
    function checkCalls(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === calleeName
      ) {
        callsCallee = true;
        return;
      }
      ts.forEachChild(node, checkCalls);
    }
    checkCalls(callerDecl.body);
    assert.ok(callsCallee, `${callerName} AST must call ${calleeName}`);
  }

  const declaredBodyFlags = [...BODY_FLAGS].sort();
  const declaredBooleanBodyFlags = [...BODY_BOOLEAN_FLAGS].sort();

  // Two-way equality between command allowedFlags and BODY_FLAGS
  for (const kind of ["note", "ask", "working-on"] as const) {
    const postBodyFlags = postSignalAllowedFlags(kind).filter((f) => f.startsWith("body-")).sort();
    assert.deepEqual(
      postBodyFlags,
      declaredBodyFlags,
      `postSignalAllowedFlags(${kind}) body flags must equal BODY_FLAGS exactly in both directions`,
    );
  }
  const replyBodyFlags = replyAllowedFlags().filter((f) => f.startsWith("body-")).sort();
  assert.deepEqual(
    replyBodyFlags,
    declaredBodyFlags,
    "replyAllowedFlags body flags must equal BODY_FLAGS exactly in both directions",
  );

  // Two-way equality between KNOWN_FLAGS / BOOLEAN_FLAGS (error text) and BODY_FLAGS
  const parserKnownBodyFlags = [...KNOWN_FLAGS].filter((f) => f.startsWith("body-")).sort();
  assert.deepEqual(
    parserKnownBodyFlags,
    declaredBodyFlags,
    "KNOWN_FLAGS body flags for error text must equal BODY_FLAGS exactly in both directions",
  );

  const parserBooleanBodyFlags = [...BOOLEAN_FLAGS].filter((f) => f.startsWith("body-")).sort();
  assert.deepEqual(
    parserBooleanBodyFlags,
    declaredBooleanBodyFlags,
    "BOOLEAN_FLAGS body flags for error text must equal BODY_BOOLEAN_FLAGS exactly in both directions",
  );

  // Contracted body sources must be present and follow body- flag naming
  for (const source of BODY_SOURCES) {
    if (source.kind === "flag") {
      assert.ok(
        typeof source.flag === "string" && source.flag.startsWith("body-"),
        `flag source ${source.name} must have a flag starting with "body-": ${source.flag}`,
      );
    }
  }
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

  // 3. Parser recognition for error text: KNOWN_FLAGS carries body flag names and rejects unknown flags; per-command allowedFlags accept
  for (const flag of BODY_FLAGS) {
    const source = BODY_SOURCES.find((s) => s.kind === "flag" && s.flag === flag);
    assert.ok(source, `every BODY_FLAG must correspond to a flag source entry: ${flag}`);
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

  // Per-command allowedFlags acceptance enforcement: unallowed flags are rejected by assertShape in resolveSignalBody
  const unallowedPostArgs = new Arguments(["note", "positional body", "--body-shadow", "x"]);
  await assert.rejects(
    () => resolveSignalBody(unallowedPostArgs, 1, postSignalAllowedFlags("note")),
    (err: any) => {
      assert.match(err.message, /unknown option: --body-shadow/);
      return true;
    },
  );
  const unallowedReplyArgs = new Arguments(["reply", SIGNAL_ID, "positional body", "--body-shadow", "x"]);
  await assert.rejects(
    () => resolveSignalBody(unallowedReplyArgs, 2, replyAllowedFlags()),
    (err: any) => {
      assert.match(err.message, /unknown option: --body-shadow/);
      return true;
    },
  );

  // Command acceptance verification through CLI: unallowed body flags are rejected with unknown option error
  const unallowedNoteRes = await runCli(["note", "positional text", "--body-shadow", "val"]);
  assert.equal(unallowedNoteRes.code, 1);
  assert.match(unallowedNoteRes.stderr, /unknown option: --body-shadow/);

  const unallowedReplyRes = await runCli(["reply", SIGNAL_ID, "positional text", "--body-shadow", "val"]);
  assert.equal(unallowedReplyRes.code, 1);
  assert.match(unallowedReplyRes.stderr, /unknown option: --body-shadow/);

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

  // 5. Runtime behavior: every entry in BODY_SOURCES has a wired reader and can supply a body end to end
  const dir = await mkdtemp(resolve(tmpdir(), "cswarm-msgfmt-gate-"));
  try {
    for (const source of BODY_SOURCES) {
      assert.equal(
        typeof source.read,
        "function",
        `source ${source.name} must have a wired read function on its BODY_SOURCES entry`,
      );

      // Exercise every source through its real wired reader with distinctive payloads.
      // We test with two distinct payloads to ensure stubs returning constants fail.
      if (source.name === "positional") {
        const payload1 = `distinctive-pos-alpha-${randomUUID()}`;
        const payload2 = `distinctive-pos-beta-${randomUUID()}`;
        const body1 = await resolveSignalBody(new Arguments(["note", payload1]), 1, postSignalAllowedFlags("note"));
        assert.equal(body1, payload1, "positional reader must return payload 1 exactly byte for byte");
        const body2 = await resolveSignalBody(new Arguments(["note", payload2]), 1, postSignalAllowedFlags("note"));
        assert.equal(body2, payload2, "positional reader must return payload 2 exactly byte for byte");
      } else if (source.name === "body-file") {
        const payload1 = `distinctive-file-alpha-${randomUUID()}\n# Markdown header\nSecond line`;
        const payload2 = `distinctive-file-beta-${randomUUID()}\nAnother line\nFinal line`;
        const file1 = resolve(dir, "body-file-1.txt");
        const file2 = resolve(dir, "body-file-2.txt");
        await writeFile(file1, payload1 + "\n");
        await writeFile(file2, payload2 + "\n");
        const body1 = await resolveSignalBody(new Arguments(["note", "--body-file", file1]), 1, postSignalAllowedFlags("note"));
        assert.equal(body1, payload1, "body-file reader must return file payload 1 exactly byte for byte");
        const body2 = await resolveSignalBody(new Arguments(["note", "--body-file", file2]), 1, postSignalAllowedFlags("note"));
        assert.equal(body2, payload2, "body-file reader must return file payload 2 exactly byte for byte");
      } else if (source.usesStdin) {
        const streamPayload1 = `distinctive-stdin-alpha-${randomUUID()}\nLine 1\nLine 2`;
        const streamPayload2 = `distinctive-stdin-beta-${randomUUID()}\nDifferent line 1\nDifferent line 2`;
        const streamResult1 = await source.read(
          new Arguments(["note", `--${source.flag}`]),
          1,
          Readable.from([Buffer.from(streamPayload1 + "\n")]),
        );
        assert.equal(streamResult1, streamPayload1, `${source.name} reader must return stream payload 1 exactly byte for byte`);
        const streamResult2 = await source.read(
          new Arguments(["note", `--${source.flag}`]),
          1,
          Readable.from([Buffer.from(streamPayload2 + "\n")]),
        );
        assert.equal(streamResult2, streamPayload2, `${source.name} reader must return stream payload 2 exactly byte for byte`);
      } else {
        // Any newly added non-stdin source must take a value argument and supply its input
        assert.ok(
          !source.boolean,
          `non-stdin flag source ${source.name} cannot be boolean (a body source must accept input)`,
        );
        const payload1 = `distinctive-flag-alpha-${randomUUID()}`;
        const payload2 = `distinctive-flag-beta-${randomUUID()}`;
        const args1 = new Arguments(["note", `--${source.flag}`, payload1]);
        const body1 = await resolveSignalBody(args1, 1, postSignalAllowedFlags("note"));
        const args2 = new Arguments(["note", `--${source.flag}`, payload2]);
        const body2 = await resolveSignalBody(args2, 1, postSignalAllowedFlags("note"));
        assert.equal(body1, payload1, `source ${source.name} reader must return payload 1 exactly byte for byte`);
        assert.equal(body2, payload2, `source ${source.name} reader must return payload 2 exactly byte for byte`);
      }
    }

    // Every source supplies body end to end through the CLI process against mock cloud server
    let receivedBody = "";
    const server = createMockCloudServer((cmd) => {
      receivedBody = cmd.body;
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

      for (const source of BODY_SOURCES) {
        if (source.name === "positional") {
          const cliPosPayload = `cli-pos-e2e-${randomUUID()}`;
          receivedBody = "";
          const result = await runCli(["note", cliPosPayload, ...target], AGENT_TOKEN);
          assert.equal(result.code, 0, result.stderr);
          assert.equal(receivedBody, cliPosPayload, "positional source must supply body end to end through CLI");
        } else if (source.name === "body-file") {
          const cliFilePayload = `cli-file-e2e-${randomUUID()}\n# File content\nLine two`;
          const cliFilePath = resolve(dir, "cli-body-file.md");
          await writeFile(cliFilePath, cliFilePayload + "\n", "utf8");
          receivedBody = "";
          const result = await runCli(["note", "--body-file", cliFilePath, ...target], AGENT_TOKEN);
          assert.equal(result.code, 0, result.stderr);
          assert.equal(receivedBody, cliFilePayload, "body-file source must supply body end to end through CLI");
        } else if (source.usesStdin) {
          const cliStdinPayload = `cli-stdin-e2e-${randomUUID()}\nStream line A\nStream line B`;
          receivedBody = "";
          const result = await runCli(["note", `--${source.flag}`, ...target], cliStdinPayload + "\n");
          assert.equal(result.code, 0, result.stderr);
          assert.equal(receivedBody, cliStdinPayload, `${source.name} source must supply body end to end through CLI`);
        } else {
          const cliValPayload = `cli-val-e2e-${randomUUID()}`;
          receivedBody = "";
          const result = await runCli(["note", `--${source.flag}`, cliValPayload, ...target], AGENT_TOKEN);
          assert.equal(result.code, 0, result.stderr);
          assert.equal(receivedBody, cliValPayload, `${source.name} source must supply body end to end through CLI`);
        }
      }
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
    assert.match(resMissing.stderr, /^cswarm: \[body_file_missing\]/m);
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
    assert.match(resUnreadable.stderr, /^cswarm: \[body_file_unreadable\]/m);
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
