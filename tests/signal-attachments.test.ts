import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  attachmentRetrievalCommand,
  parseSignalAttachments,
  SIGNAL_ATTACHMENT_MAX,
} from "../src/cloud/attachments.js";
import { parseSignalRecord } from "../src/cloud/signals.js";
import {
  parseSignalAttachmentRefs,
  signalAttachmentListRefusal,
} from "../supabase/functions/command/signal-attachments.js";
import { validateFileCommand } from "../supabase/functions/command/file-artifacts.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIGNAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SENDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FILE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const signal = (attachments?: unknown): Record<string, unknown> => ({
  id: SIGNAL,
  workspace_id: WORKSPACE,
  from: SENDER,
  from_kind: "user",
  to: null,
  to_agent: null,
  in_reply_to: null,
  about: null,
  kind: "note",
  body: "See the attached file.",
  until: "2026-09-02T00:00:00.000Z",
  created_at: "2026-09-01T00:00:00.000Z",
  ...(attachments === undefined ? {} : { attachments }),
});

test("legacy signal JSON remains readable and feature-off readers ignore the additive field", () => {
  assert.deepEqual(parseSignalRecord(signal()).attachments, []);
  assert.deepEqual(
    parseSignalRecord(signal("future attachment wire"), { attachmentsEnabled: false }).attachments,
    [],
  );
  assert.equal(parseSignalRecord({ ...signal(), future_server_field: true }).body, "See the attached file.");
});

test("attachment metadata parses additively, pins order, and has a closed cap", () => {
  const metadata = {
    file_id: FILE,
    version_n: 3,
    name: "screen.png",
    content_type: "image/png",
    size_bytes: 2048,
    future_metadata: "ignored",
  };
  assert.deepEqual(parseSignalAttachments([metadata]), [{
    file_id: FILE,
    version_n: 3,
    name: "screen.png",
    content_type: "image/png",
    size_bytes: 2048,
  }]);
  assert.equal(parseSignalRecord(signal([metadata])).attachments?.[0]?.name, "screen.png");
  assert.throws(
    () => parseSignalAttachments(Array.from({ length: SIGNAL_ATTACHMENT_MAX + 1 }, (_, i) => ({
      ...metadata,
      file_id: `${i.toString(16).padStart(8, "0")}-dddd-4ddd-8ddd-dddddddddddd`,
    }))),
    /malformed attachments/,
  );
});

test("command attachment refs validate shape, stable cap refusal, and duplicates", () => {
  const refs = Array.from({ length: SIGNAL_ATTACHMENT_MAX + 1 }, (_, index) => ({
    file_id: `${index.toString(16).padStart(8, "0")}-dddd-4ddd-8ddd-dddddddddddd`,
    version_n: 1,
  }));
  const parsed = parseSignalAttachmentRefs(refs);
  assert.ok(parsed);
  assert.equal(signalAttachmentListRefusal(parsed), "signal_attachment_limit");
  assert.equal(
    signalAttachmentListRefusal([{ file_id: FILE, version_n: 2 }, { file_id: FILE, version_n: 2 }]),
    "signal_attachment_duplicate",
  );
  assert.equal(signalAttachmentListRefusal([{ file_id: FILE, version_n: 2 }]), null);
  assert.equal(parseSignalAttachmentRefs([{ file_id: FILE, version_n: 0 }]), null);
  assert.equal(parseSignalAttachmentRefs([{ file_id: FILE, version_n: 1, name: "no" }]), null);
});

test("retrieval copy uses a file id and a command the file-get surface accepts", () => {
  assert.equal(
    attachmentRetrievalCommand(WORKSPACE, { file_id: FILE, version_n: 3 }),
    `cswarm file get ${FILE} --version 3 --workspace-id ${WORKSPACE}`,
  );
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(cli, /cswarm file get <name\|file-id> \[--version <n>\]/);
  assert.match(cli, /resolveFileSelector\([\s\S]*UUID_RE\.test\(selector\)/);
  assert.deepEqual(validateFileCommand({
    kind: "file_download_url",
    file_id: FILE,
    version_n: 3,
  }), {
    ok: true,
    command: { kind: "file_download_url", file_id: FILE, version_n: 3 },
  });
});

test("the command resolver proves tenancy in both file and version lookups", () => {
  const command = readFileSync(
    new URL("../supabase/functions/command/index.ts", import.meta.url),
    "utf8",
  );
  const resolver = command.slice(
    command.indexOf("async function resolveSignalAttachments"),
    command.indexOf("async function postSignal"),
  );
  assert.equal(
    resolver.match(/AND workspace_id = \$\{route\.workspaceId\}::uuid/g)?.length,
    2,
    "both attachment parent lookups must use the routed workspace compound key",
  );
  assert.match(resolver, /version\.state !== "live"/);
});

test("the schema permits attachment inserts only with their new parent signal", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20260901000010_signal_attachments.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TRIGGER signal_attachments_same_transaction/);
  assert.match(
    migration,
    /signal\.xmin::text::bigint[\s\S]*pg_current_xact_id\(\)/,
  );
  assert.match(migration, /BEFORE UPDATE OR DELETE ON swarm\.signal_attachments/);
});
