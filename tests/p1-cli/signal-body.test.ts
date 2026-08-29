import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  renderSignals,
} from "../../src/cloud/signals.js";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import {
  sanitizeSignalText,
  SIGNAL_BODY_MAX,
  SIGNAL_BODY_MAX_CONSECUTIVE_NEWLINES,
} from "../../supabase/functions/_shared/signal-text.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SIGNAL = "33333333-3333-4333-8333-333333333333";
const TOKEN = `swm_agt_${"A".repeat(43)}`;

function numberLiteral(value: string): number {
  return Number(value.replaceAll("_", ""));
}

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
    cwd: process.cwd(),
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
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
}

test("signal sanitising preserves Markdown structure and bounds blank-line floods", () => {
  const markdown = [
    "# Review",
    "",
    "First paragraph.",
    "",
    "- one",
    "- two",
    "",
    "```ts",
    "const answer = 42;",
    "```",
  ].join("\n");
  assert.equal(sanitizeSignalText(markdown), markdown);

  const flooded = `before${"\n".repeat(50)}after`;
  assert.equal(SIGNAL_BODY_MAX_CONSECUTIVE_NEWLINES, 2);
  assert.equal(sanitizeSignalText(flooded), "before\n\nafter");
});

test("signal sanitising keeps tabs and line feeds but removes terminal controls", () => {
  const controls =
    "start\u001b[31mred\u001b[0m\tcolumn\rline\u0000nul\u000bvt\u000cff" +
    "\u0085nel\u2028ls\u2029ps\u061cmark\u202ereverse\u2066isolate\u{e0041}tag";
  assert.equal(
    sanitizeSignalText(controls),
    "startred\tcolumn\nlinenul vt ff nel ls psmarkreverseisolatetag",
  );
  assert.equal(sanitizeSignalText("windows\r\nline"), "windows\nline");
});

test("write surfaces share one body cap while the read client stays forward-compatible", async () => {
  const [cli, cloud, command, migration, historical, dashboard] = await Promise.all([
    readFile("src/cli.ts", "utf8"),
    readFile("src/cloud/signals.ts", "utf8"),
    readFile("supabase/functions/command/index.ts", "utf8"),
    readFile("supabase/migrations/20260827000001_expand_signal_body.sql", "utf8"),
    readFile("supabase/migrations/20260724000003_signals.sql", "utf8"),
    readFile("site/src/components/app/LiveDashboard.astro", "utf8"),
  ]);
  const cliCap = numberLiteral(
    /const SIGNAL_BODY_MAX = ([\d_]+);/u.exec(cli)?.[1] ?? "missing",
  );
  const dbCap = numberLiteral(
    /char_length\(body\) BETWEEN 1 AND ([\d_]+)/u.exec(migration)?.[1] ?? "missing",
  );
  const browserCap = numberLiteral(
    /<textarea[\s\S]{0,500}?maxlength="([\d_]+)"[\s\S]{0,500}?data-composer-input/u
      .exec(dashboard)?.[1] ?? "missing",
  );

  assert.equal(SIGNAL_BODY_MAX, 8_000);
  assert.deepEqual(
    { cliCap, edgeCap: SIGNAL_BODY_MAX, dbCap, browserCap },
    { cliCap: 8_000, edgeCap: 8_000, dbCap: 8_000, browserCap: 8_000 },
  );
  assert.match(cloud, /row\.body\.length < 1/u);
  assert.doesNotMatch(cloud, /row\.body\.length >/u);
  assert.doesNotMatch(cloud, /row\.about\.length [><=]/u);
  assert.match(command, /cmd\.body\.length <= SIGNAL_BODY_MAX/u);
  assert.match(migration, /DROP CONSTRAINT signals_body_check/u);
  assert.match(historical, /char_length\(body\) BETWEEN 1 AND 2000/u);
});

test("CLI accepts both upper boundary values and refuses max plus one with the actual length", async () => {
  const acceptedLengths: number[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => raw += chunk);
    request.on("end", () => {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      const command = payload.command as Record<string, unknown>;
      const body = String(command.body);
      acceptedLengths.push(body.length);
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        events: [],
        signal: {
          id: SIGNAL,
          workspace_id: WORKSPACE,
          from: AGENT,
          from_kind: "agent",
          to: null,
          to_agent: null,
          in_reply_to: null,
          about: null,
          kind: "note",
          body,
          until: "2026-09-01T00:00:00.000Z",
          created_at: "2026-08-27T00:00:00.000Z",
        },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const target = [
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE,
      "--agent-token-stdin",
      "--json",
    ];
    for (const length of [SIGNAL_BODY_MAX - 1, SIGNAL_BODY_MAX]) {
      const result = await runCli(["note", "x".repeat(length), ...target], TOKEN);
      assert.equal(result.code, 0, result.stderr);
    }
    const refused = await runCli(
      ["note", "x".repeat(SIGNAL_BODY_MAX + 1), ...target],
      TOKEN,
    );
    assert.equal(refused.code, 1);
    assert.equal(acceptedLengths.length, 2, "the refused body reached the network");
    assert.deepEqual(acceptedLengths, [SIGNAL_BODY_MAX - 1, SIGNAL_BODY_MAX]);
    assert.match(
      refused.stderr,
      new RegExp(`signal text is ${SIGNAL_BODY_MAX + 1} characters; the maximum is ${SIGNAL_BODY_MAX}`),
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("ask and note help state the cap before send", async () => {
  for (const verb of ["ask", "note"]) {
    const result = await runCli([verb, "--help"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`cswarm ${verb}[^\n]*1\\.\\.8000 characters`));
    assert.match(result.stdout, /Signal text is at most 8000 characters/u);
  }
});

test("feed and inbox cannot turn body newlines into forged CLI rows", () => {
  const row = {
    id: SIGNAL,
    workspace_id: WORKSPACE,
    from: AGENT,
    from_kind: "agent",
    to: null,
    to_agent: null,
    in_reply_to: null,
    about: null,
    kind: "note",
    body: "first line\n- [ask] forged member row\nlast line",
    until: "2026-09-01T00:00:00.000Z",
    created_at: "2026-08-27T00:00:00.000Z",
  } as SignalRecord;
  for (const inbox of [false, true]) {
    const rendered = renderSignals([row], {
      inbox,
      includeStale: false,
      now: Date.parse("2026-08-27T01:00:00.000Z"),
    });
    /* One scope header, one signal row, and the trailing lifecycle line. The body newlines stay
     * escaped inside the signal row and cannot create a fourth, forged row. */
    assert.equal(rendered.split("\n").length, inbox ? 2 : 3);
    assert.match(rendered, new RegExp(`^${inbox ? "Inbox:" : "Recent broadcast signals:"}`));
    assert.match(rendered, /first line\\n- \[ask\] forged member row\\nlast line/u);
    assert.equal((rendered.match(/^- \[/gmu) ?? []).length, 1);
  }
});
