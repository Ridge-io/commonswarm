import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SignalRecord } from "../src/cloud/command-client.js";
import type {
  OpenCodeAcpHandle,
  OpenCodeAcpOpenOptions,
} from "../src/host/opencode.js";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../src/host/types.js";
import {
  OpenCodeListenerModel,
  type OpenOpenCodeSession,
} from "../src/listener/index.js";

const REQUEST: PermissionRequest = {
  sessionId: "session",
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
  summary: "bash canary",
};

const SIGNAL = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspace_id: "11111111-1111-4111-8111-111111111111",
  from: "22222222-2222-4222-8222-222222222222",
  from_kind: "agent",
  to: null,
  to_agent: "33333333-3333-4333-8333-333333333333",
  in_reply_to: null,
  about: null,
  kind: "ask",
  body: "hello",
  until: "2026-08-30T00:00:00.000Z",
  created_at: "2026-07-30T00:00:00.000Z",
  sender_owner_relation: "same_owner",
} satisfies SignalRecord;

function fakeOpen(records: Array<{
  options: OpenCodeAcpOpenOptions;
  canaryDecision?: PermissionDecision;
  promptDecision?: PermissionDecision;
  closed: boolean;
  cancelled: boolean;
  prompts: string[];
}>): OpenOpenCodeSession {
  return async (options) => {
    const record = {
      options,
      closed: false,
      cancelled: false,
      prompts: [] as string[],
    } as (typeof records)[number];
    records.push(record);
    const session = {
      async enablePromptsAfterCanary() {
        record.canaryDecision = await options.permissionCallback?.(REQUEST);
      },
      async prompt(text: string) {
        record.prompts.push(text);
        record.promptDecision = await options.permissionCallback?.(REQUEST);
        return {
          message: `reply:${text}`,
          stopReason: "end_turn" as const,
          updates: [],
        };
      },
      cancel() {
        record.cancelled = true;
      },
    };
    return {
      session,
      child: {},
      executable: "opencode",
      args: ["acp", "--pure"],
      env: {},
      home: options.isolatedHome ?? "/tmp/fake-oc-home",
      async close() {
        record.closed = true;
      },
    } as unknown as OpenCodeAcpHandle;
  };
}

test("OpenCode worker canary always denies before explicit same-owner allow mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  const records: Parameters<typeof fakeOpen>[0] = [];
  const adapter = new OpenCodeListenerModel({
    cwd,
    permissionMode: "allow",
    open: fakeOpen(records),
  });
  await adapter.start();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.canaryDecision, {
    outcome: "selected",
    optionId: "deny",
  });
  assert.equal(typeof records[0]?.options.isolatedHome, "string");
  assert.equal(records[0]?.options.disposeHomeOnClose, false);

  const result = await adapter.prompt(SIGNAL, "worker", "work");
  assert.equal(result.message, "reply:work");
  assert.deepEqual(records[0]?.promptDecision, {
    outcome: "selected",
    optionId: "allow",
  });
  // Same-owner persistence: second prompt reuses the same open handle.
  await adapter.prompt(SIGNAL, "worker", "again");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.prompts, ["work", "again"]);
  await adapter.close();
  assert.equal(records[0]?.closed, true);
});

test("OpenCode cross-owner turns get fresh homes/cwds and always deny tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  const records: Parameters<typeof fakeOpen>[0] = [];
  const adapter = new OpenCodeListenerModel({
    cwd,
    permissionMode: "allow",
    open: fakeOpen(records),
  });
  await adapter.start();
  await adapter.prompt(
    { ...SIGNAL, sender_owner_relation: "cross_owner" },
    "isolated",
    "remote one",
  );
  await adapter.prompt(
    { ...SIGNAL, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", sender_owner_relation: "unknown" },
    "isolated",
    "remote two",
  );
  assert.equal(records.length, 3);
  const homes = records.slice(1).map((r) => r.options.isolatedHome);
  const cwds = records.slice(1).map((r) => r.options.cwd);
  assert.notEqual(homes[0], homes[1]);
  assert.notEqual(cwds[0], cwds[1]);
  assert.notEqual(cwds[0], cwd);
  for (const isolated of records.slice(1)) {
    assert.equal(isolated.options.disposeHomeOnClose, true);
    assert.deepEqual(isolated.canaryDecision, {
      outcome: "selected",
      optionId: "deny",
    });
    assert.deepEqual(isolated.promptDecision, {
      outcome: "selected",
      optionId: "deny",
    });
    assert.equal(isolated.closed, true);
    await assert.rejects(stat(isolated.options.cwd), /ENOENT/);
  }
  // Provider never sees ownership — only the engine mode does.
  assert.equal(
    records.every((r) => !("sender_owner_relation" in (r.options as object))),
    true,
  );
  await adapter.close();
});

test("OpenCode cancel reaches active handles; default permissionMode denies", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  const records: Parameters<typeof fakeOpen>[0] = [];
  const adapter = new OpenCodeListenerModel({
    cwd,
    open: fakeOpen(records),
  });
  await adapter.start();
  await adapter.prompt(SIGNAL, "worker", "x");
  assert.deepEqual(records[0]?.promptDecision, {
    outcome: "selected",
    optionId: "deny",
  });
  adapter.cancel();
  assert.equal(records[0]?.cancelled, true);
  await adapter.close();
});

test("one-winner: closed model rejects new prompts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  const adapter = new OpenCodeListenerModel({
    cwd,
    open: fakeOpen([]),
  });
  await adapter.start();
  await adapter.close();
  await assert.rejects(
    () => adapter.prompt(SIGNAL, "worker", "nope"),
    /closed/,
  );
});
