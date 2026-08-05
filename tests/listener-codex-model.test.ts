/** ★ THIS FILE IS NAMED IN `npm test`; all Codex sessions are injected fakes. */
import assert from "node:assert/strict";
import { lstat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SignalRecord } from "../src/cloud/command-client.js";
import type {
  CodexAcpHandle,
  CodexAcpOpenOptions,
} from "../src/host/codex.js";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../src/host/types.js";
import {
  AcpChildExitError,
  AcpHostError,
  AcpPermissionCanaryError,
} from "../src/host/types.js";
import {
  CodexListenerModel,
  ListenerEngine,
  type OpenCodexSession,
} from "../src/listener/index.js";
import type {
  ListenerEffectRecord,
  ListenerEffectStore,
} from "../src/listener/types.js";

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

type Record = {
  options: CodexAcpOpenOptions;
  canaryOptions?: { probeText?: string; timeoutMs?: number };
  canaryDecision?: PermissionDecision;
  promptDecision?: PermissionDecision;
  closed: boolean;
  cancelled: boolean;
};

function fakeOpen(records: Record[]): OpenCodexSession {
  return async (options) => {
    const record: Record = { options, closed: false, cancelled: false };
    records.push(record);
    const session = {
      async enablePromptsAfterCanary(canaryOptions?: {
        probeText?: string;
        timeoutMs?: number;
      }) {
        record.canaryOptions = canaryOptions;
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
      executable: "/opt/codex-acp",
      args: [],
      env: {},
      async close() {
        record.closed = true;
      },
    } as unknown as CodexAcpHandle;
  };
}

test("Codex worker canary denies before explicit allow mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-worker-"));
  const records: Record[] = [];
  const adapter = new CodexListenerModel({
    cwd,
    permissionMode: "allow",
    open: fakeOpen(records),
  });
  await adapter.start();
  assert.deepEqual(records[0]?.canaryDecision, {
    outcome: "selected",
    optionId: "deny",
  });
  assert.match(records[0]?.canaryOptions?.probeText ?? "", /shell command/);
  assert.match(records[0]?.canaryOptions?.probeText ?? "", /cswarm-codex-permission-canary/);
  assert.doesNotMatch(records[0]?.canaryOptions?.probeText ?? "", new RegExp(cwd));
  assert.equal(records[0]?.canaryOptions?.timeoutMs, 30_000);
  const result = await adapter.prompt(SIGNAL, "worker", "work");
  assert.equal(result.message, "reply:work");
  assert.deepEqual(records[0]?.promptDecision, {
    outcome: "selected",
    optionId: "allow",
  });
  await adapter.close();
  assert.equal(records[0]?.closed, true);
});

test("Codex sender relations share one worker, cwd, and permission mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-worker-"));
  const records: Record[] = [];
  const adapter = new CodexListenerModel({
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
  assert.equal("canaryCwd" in records[0]!.options, false);
  assert.equal(records[0]?.closed, false);
  await adapter.close();
  assert.equal(records[0]?.closed, true);
});

test("Codex listener cancel reaches the active host handle", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-worker-"));
  const records: Record[] = [];
  const adapter = new CodexListenerModel({ cwd, open: fakeOpen(records) });
  await adapter.start();
  adapter.cancel();
  assert.equal(records[0]?.cancelled, true);
  await adapter.close();
});

test("Codex canary removes a sentinel written before denial and refuses startup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-worker-"));
  let sentinelPath = "";
  let closed = false;
  const open: OpenCodexSession = async (options) => ({
    session: {
      async enablePromptsAfterCanary(canaryOptions?: { probeText?: string }) {
        const match = canaryOptions?.probeText?.match(
          /Use a shell command to create (\S+) with content/,
        );
        assert.ok(match?.[1]);
        sentinelPath = match[1];
        await writeFile(sentinelPath, "unexpected canary mutation");
        await options.permissionCallback?.(REQUEST);
      },
      async prompt() {
        throw new Error("unreachable");
      },
      cancel() {},
    },
    child: {},
    executable: "/opt/codex-acp",
    args: [],
    env: {},
    async close() {
      closed = true;
    },
  } as unknown as CodexAcpHandle);
  const adapter = new CodexListenerModel({ cwd, open });

  await assert.rejects(
    () => adapter.start(),
    (error: unknown) => error instanceof AcpPermissionCanaryError,
  );
  assert.equal(closed, true);
  assert.notEqual(sentinelPath, "");
  await assert.rejects(
    () => lstat(sentinelPath),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("Codex close waits for an opening worker and closes it before installation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-worker-"));
  const records: Record[] = [];
  let releaseOpen!: () => void;
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const delegate = fakeOpen(records);
  const open: OpenCodexSession = async (options) => {
    await openGate;
    return delegate(options);
  };
  const adapter = new CodexListenerModel({ cwd, open });

  const starting = adapter.start();
  await Promise.resolve();
  const closing = adapter.close();
  releaseOpen();

  await assert.rejects(starting, /closed while the Codex worker was opening/);
  await closing;
  assert.equal(records.length, 1);
  assert.equal(records[0]?.closed, true);
  await assert.rejects(() => adapter.prompt(SIGNAL, "worker", "late"), /closed/);
});

test("Codex close cancels and closes a canary already in flight", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-worker-"));
  let canaryStarted!: () => void;
  const canaryEntered = new Promise<void>((resolve) => {
    canaryStarted = resolve;
  });
  let releaseCanary!: () => void;
  const canaryGate = new Promise<void>((resolve) => {
    releaseCanary = resolve;
  });
  let cancelled = false;
  let closed = false;
  const open: OpenCodexSession = async () => ({
    session: {
      async enablePromptsAfterCanary() {
        canaryStarted();
        await canaryGate;
      },
      async prompt() {
        throw new Error("unreachable");
      },
      cancel() {
        cancelled = true;
        releaseCanary();
      },
    },
    child: {},
    executable: "/opt/codex-acp",
    args: [],
    env: {},
    async close() {
      closed = true;
    },
  } as unknown as CodexAcpHandle);
  const adapter = new CodexListenerModel({ cwd, open });

  const starting = adapter.start();
  await canaryEntered;
  const closing = adapter.close();

  await assert.rejects(starting, /closed while the Codex worker was opening/);
  await closing;
  assert.equal(cancelled, true);
  assert.equal(closed, true);
});

test("Codex close settles opening work before propagating teardown failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-worker-"));
  let canaryStarted!: () => void;
  const canaryEntered = new Promise<void>((resolve) => {
    canaryStarted = resolve;
  });
  let releaseCanary!: () => void;
  const canaryGate = new Promise<void>((resolve) => {
    releaseCanary = resolve;
  });
  let closeAttempts = 0;
  const open: OpenCodexSession = async () => ({
    session: {
      async enablePromptsAfterCanary() {
        canaryStarted();
        await canaryGate;
      },
      async prompt() {
        throw new Error("unreachable");
      },
      cancel() {
        releaseCanary();
      },
    },
    child: {},
    executable: "/opt/codex-acp",
    args: [],
    env: {},
    async close() {
      closeAttempts += 1;
      throw new Error("verified teardown failed");
    },
  } as unknown as CodexAcpHandle);
  const adapter = new CodexListenerModel({ cwd, open });

  const starting = adapter.start();
  await canaryEntered;
  const closing = adapter.close();

  await assert.rejects(starting, /verified teardown failed/);
  await assert.rejects(closing, /verified teardown failed/);
  assert.ok(closeAttempts >= 1);
  await assert.rejects(() => adapter.prompt(SIGNAL, "worker", "late"), /closed/);
});

test("D-050: Codex close timeout is runtime-fatal before replacement opens", async () => {
  class MemoryStore implements ListenerEffectStore {
    private readonly records = new Map<string, ListenerEffectRecord>();

    async read(signalId: string): Promise<ListenerEffectRecord | null> {
      return structuredClone(this.records.get(signalId.toLowerCase()) ?? null);
    }

    async write(record: ListenerEffectRecord): Promise<void> {
      this.records.set(record.signalId.toLowerCase(), structuredClone(record));
    }
  }

  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-d050-"));
  const store = new MemoryStore();
  let opens = 0;
  let closes = 0;
  const timeout = new AcpHostError(
    "child_exit_timeout",
    "Codex ACP bridge did not exit after SIGTERM and SIGKILL",
  );
  const adapter = new CodexListenerModel({
    cwd,
    open: async () => {
      opens += 1;
      return {
        session: {
          async enablePromptsAfterCanary() {},
          async prompt() {
            throw new AcpChildExitError(1, null);
          },
          cancel() {},
        },
        child: {},
        executable: "/opt/codex-acp",
        args: [],
        env: {},
        async close() {
          closes += 1;
          throw timeout;
        },
      } as unknown as CodexAcpHandle;
    },
  });
  await adapter.start();
  const engine = new ListenerEngine({
    store,
    model: adapter,
    now: () => Date.parse("2026-08-05T12:00:00.000Z"),
    poster: { async post() { throw new Error("unreachable"); } },
  });
  const ask = { ...SIGNAL, from_kind: "user" as const };

  let caught: unknown = null;
  await engine.process(ask).catch((error: unknown) => {
    caught = error;
  });

  assert.equal(caught, timeout);
  assert.equal(opens, 1);
  assert.equal(closes, 1);
  const persisted = await store.read(ask.id);
  assert.equal(persisted?.state, "failed");
  assert.equal(persisted?.failureCode, "child_exit_timeout");
  assert.equal((await engine.process(ask)).status, "failed");
  assert.equal(opens, 1);
});
