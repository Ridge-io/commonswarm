import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SignalRecord } from "../src/cloud/command-client.js";
import type {
  GrokAcpHandle,
  GrokAcpOpenOptions,
} from "../src/host/grok.js";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../src/host/types.js";
import {
  GrokListenerModel,
  type OpenGrokSession,
} from "../src/listener/index.js";

const REQUEST: PermissionRequest = {
  sessionId: "session",
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
  summary: "shell canary",
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
  options: GrokAcpOpenOptions;
  canaryDecision?: PermissionDecision;
  promptDecision?: PermissionDecision;
  closed: boolean;
  cancelled: boolean;
}>): OpenGrokSession {
  return async (options) => {
    const record = {
      options,
      closed: false,
      cancelled: false,
    } as (typeof records)[number];
    records.push(record);
    const session = {
      async enablePromptsAfterCanary() {
        record.canaryDecision = await options.permissionCallback?.(REQUEST);
      },
      async prompt(text: string) {
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
      executable: "grok",
      args: [],
      env: {},
      async close() {
        record.closed = true;
      },
    } as unknown as GrokAcpHandle;
  };
}

test("worker canary always denies before explicit same-owner allow mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-worker-test-"));
  const records: Parameters<typeof fakeOpen>[0] = [];
  const adapter = new GrokListenerModel({
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
  assert.equal("disableCmuxHooks" in records[0]!.options, false);
  assert.equal("sandbox" in records[0]!.options, false);

  const result = await adapter.prompt(SIGNAL, "worker", "work");
  assert.equal(result.message, "reply:work");
  assert.deepEqual(records[0]?.promptDecision, {
    outcome: "selected",
    optionId: "allow",
  });
  await adapter.close();
  assert.equal(records[0]?.closed, true);
});

test("cross-owner turns reach the operator worker, cwd, home, and permission mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-worker-test-"));
  const records: Parameters<typeof fakeOpen>[0] = [];
  const adapter = new GrokListenerModel({
    cwd,
    permissionMode: "allow",
    open: fakeOpen(records),
  });
  await adapter.start();
  await adapter.prompt(
    { ...SIGNAL, sender_owner_relation: "cross_owner" },
    "worker",
    "remote one",
  );
  await adapter.prompt(
    { ...SIGNAL, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab" },
    "worker",
    "remote two",
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]?.options.cwd, cwd);
  assert.equal("isolatedHome" in records[0]!.options, false);
  assert.equal("sandbox" in records[0]!.options, false);
  assert.equal("disableCmuxHooks" in records[0]!.options, false);
  assert.deepEqual(records[0]?.canaryDecision, {
    outcome: "selected",
    optionId: "deny",
  });
  assert.deepEqual(records[0]?.promptDecision, {
    outcome: "selected",
    optionId: "allow",
  });
  assert.equal(records[0]?.closed, false);
  await adapter.close();
  assert.equal(records[0]?.closed, true);
});

test("listener cancel reaches active host handles without logging prompts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-worker-test-"));
  const records: Parameters<typeof fakeOpen>[0] = [];
  const adapter = new GrokListenerModel({
    cwd,
    open: fakeOpen(records),
  });
  await adapter.start();
  adapter.cancel();
  assert.equal(records[0]?.cancelled, true);
  await adapter.close();
});
