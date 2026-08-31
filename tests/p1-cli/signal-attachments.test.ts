import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import { formatArrivalNotification, arrivalNotification } from "../../src/cloud/arrival-watch.js";
import { renderSignals } from "../../src/cloud/signals.js";
import { buildListenerPrompt } from "../../src/listener/engine.js";
import { renderHookSignal } from "../../src/listener/hook.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SENDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SIGNAL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FILE_ONE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TOKEN = `swm_agt_${"A".repeat(43)}`;

const attachedSignal = (): SignalRecord => ({
  id: SIGNAL,
  workspace_id: WORKSPACE,
  from: SENDER,
  from_kind: "user",
  to: null,
  to_agent: AGENT,
  in_reply_to: null,
  about: null,
  kind: "ask",
  body: "Please inspect these.",
  attachments: [{
    file_id: FILE_ONE,
    version_n: 2,
    name: "screen.png",
    content_type: "image/png",
    size_bytes: 2048,
  }],
  until: "2030-01-01T00:00:00.000Z",
  created_at: "2026-09-01T00:00:00.000Z",
  sender_owner_relation: "same_owner",
});

test("inbox, notification, hook, and listener prompt surface attached files", () => {
  const signal = attachedSignal();
  const retrieval = `cswarm file get ${FILE_ONE} --version 2 --workspace-id ${WORKSPACE}`;
  const rendered = renderSignals([signal], { inbox: true, includeStale: false });
  assert.match(rendered, /screen\.png/);
  assert.match(rendered, /2\.0 KB/);
  assert.ok(rendered.includes(retrieval));

  const prompt = buildListenerPrompt(signal, "worker");
  assert.match(prompt, /This message has 1 attachment/);
  assert.ok(prompt.includes(retrieval));
  assert.match(prompt, /"retrieval_command"/);

  const notice = arrivalNotification(signal, WORKSPACE, { url: "https://example.test", anonKey: "anon" });
  assert.equal(notice.attachment_count, 1);
  assert.match(formatArrivalNotification(notice), /1 attachment/);

  assert.match(renderHookSignal({
    signalId: SIGNAL,
    workspaceId: WORKSPACE,
    principalId: AGENT,
    fromId: SENDER,
    fromKind: "user",
    kind: "ask",
    senderName: "Sam",
    body: "Please inspect these.",
    attachmentCount: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    queuedAt: "2026-09-01T00:00:01.000Z",
  }), /Attachments: 1/);
});

test("note, ask, and reply share the repeatable attachment parser", () => {
  const source = readFileSync(new URL("../../src/cli.ts", import.meta.url), "utf8");
  const post = source.slice(source.indexOf("async function runPostSignal"), source.indexOf("export function replyRefusalHint"));
  const reply = source.slice(source.indexOf("async function runReply"), source.indexOf("async function runMembers"));
  assert.match(post, /\.\.\.\(allowTo \? \["attach"\] : \[\]\)/);
  assert.match(post, /prepareSignalAttachments\(args\.all\("attach"\)\)/);
  assert.match(reply, /"attach"/);
  assert.match(reply, /prepareSignalAttachments\(args\.all\("attach"\)\)/);
  assert.match(source, /cswarm note[\s\S]*--attach <path>/);
  assert.match(source, /cswarm ask[\s\S]*--attach <path>/);
  assert.match(source, /cswarm reply[\s\S]*--attach <path>/);
});

test("note --attach parses repeatably and uploads both files before posting refs", async () => {
  const root = mkdtempSync(join(tmpdir(), "cswarm-signal-attachments-"));
  const first = join(root, "screen.png");
  const second = join(root, "notes.md");
  writeFileSync(first, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(second, "# notes\n");
  const commands: Array<Record<string, unknown>> = [];
  const fileNames = new Map<string, string>();
  let nextFile = 0;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "PUT" && request.url?.startsWith("/storage/v1/")) {
        response.writeHead(200).end();
        return;
      }
      if (request.method !== "POST" || request.url !== "/functions/v1/command") {
        response.writeHead(404).end();
        return;
      }
      const envelope = JSON.parse(Buffer.concat(chunks).toString()) as {
        command: Record<string, unknown>;
      };
      const command = envelope.command;
      commands.push(command);
      if (command.kind === "file_version_create") {
        nextFile += 1;
        const fileId = String(command.file_id);
        fileNames.set(fileId, String(command.name));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ok: true,
          status: "accepted",
          file_id: fileId,
          version_id: command.version_id,
          version_n: 1,
          name: command.name,
          upload_path: `/storage/v1/upload/${nextFile}`,
          upload_token: null,
          upload_expires_in_seconds: 600,
        }));
        return;
      }
      if (command.kind === "file_version_commit") {
        const fileId = String(command.file_id);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ok: true,
          status: "accepted",
          file_id: fileId,
          version_id: command.version_id,
          version_n: 1,
          name: fileNames.get(fileId),
          size_bytes: 4,
          sha256: command.sha256,
          sha256_note: "unverified client attestation",
          reference: `file:${fileId}@v1`,
        }));
        return;
      }
      if (command.kind === "post_signal") {
        const refs = command.attachments as Array<{ file_id: string; version_n: number }>;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ok: true,
          status: "accepted",
          event_ids: [],
          events: [],
          min_client_version: "0.1.0",
          signal: {
            ...attachedSignal(),
            id: SIGNAL,
            from: AGENT,
            to_agent: null,
            kind: "note",
            body: command.body,
            attachments: refs.map((ref) => ({
              ...ref,
              name: fileNames.get(ref.file_id),
              content_type: fileNames.get(ref.file_id)?.endsWith(".png") ? "image/png" : "text/markdown",
              size_bytes: 4,
            })),
          },
        }));
        return;
      }
      response.writeHead(400).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const credential = JSON.stringify({
    message: "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.",
    status: "accepted",
    principal_id: AGENT,
    token_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    agent_token: TOKEN,
    expires_at: "2030-01-01T00:00:00.000Z",
  });
  try {
    const child = spawn(process.execPath, [
      "--import", "tsx", "src/cli.ts", "note", "Review files",
      "--attach", first, "--attach", second,
      "--url", `http://127.0.0.1:${address.port}`,
      "--anon-key", "anon", "--workspace-id", WORKSPACE,
      "--agent-token-stdin", "--json",
    ], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(credential);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr += chunk);
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolve(value ?? 1));
    });
    assert.equal(code, 0, stderr);
    assert.doesNotThrow(() => JSON.parse(stdout));
    assert.deepEqual(commands.map((command) => command.kind), [
      "file_version_create", "file_version_commit",
      "file_version_create", "file_version_commit",
      "post_signal",
    ]);
    const posted = commands.at(-1)!;
    assert.deepEqual(
      (posted.attachments as Array<Record<string, unknown>>).map((ref) => Object.keys(ref).sort()),
      [["file_id", "version_n"], ["file_id", "version_n"]],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
