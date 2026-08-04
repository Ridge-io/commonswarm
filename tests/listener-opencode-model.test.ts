import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import type { SignalRecord } from "../src/cloud/command-client.js";
import {
  prepareOpenCodeIsolatedHome,
  type OpenCodeAcpHandle,
  type OpenCodeAcpOpenOptions,
} from "../src/host/opencode.js";
import {
  AcpChildExitError,
  AcpHostError,
  type PermissionDecision,
  type PermissionRequest,
} from "../src/host/types.js";
import {
  OpenCodeListenerModel,
  type OpenOpenCodeSession,
} from "../src/listener/index.js";
import {
  listenerPaths,
  runListenerSupervisor,
} from "../src/listener/index.js";
import { runListenerRuntime } from "../src/listener/index.js";
import { cloudTarget } from "../src/cloud/config.js";

const REQUEST: PermissionRequest = {
  sessionId: "session",
  toolCallId: "tool-1",
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
  workCwd?: string;
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
      get arePromptsEnabled() {
        return false;
      },
      async enablePromptsAfterCanary() {
        record.canaryDecision = await options.permissionCallback?.(REQUEST);
      },
      async openWorkCwd(cwd: string) {
        record.workCwd = cwd;
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
      executable: "/usr/bin/opencode",
      args: ["acp", "--pure"],
      env: {},
      home: options.isolatedHome ?? "/tmp/fake-oc-home",
      async close() {
        record.closed = true;
      },
    } as unknown as OpenCodeAcpHandle;
  };
}

test("OpenCode worker canary denies on empty cwd then openWorkCwd retargets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  const records: Parameters<typeof fakeOpen>[0] = [];
  const adapter = new OpenCodeListenerModel({
    cwd,
    permissionMode: "allow",
    allowMissingAuth: true,
    open: fakeOpen(records),
  });
  await adapter.start();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.canaryDecision, {
    outcome: "selected",
    optionId: "deny",
  });
  // Canary cwd is not the worker project cwd.
  assert.notEqual(records[0]?.options.cwd, cwd);
  assert.equal(records[0]?.workCwd, cwd);
  assert.equal("disposeHomeOnClose" in records[0]!.options, false);
  await assert.doesNotReject(
    stat(records[0]!.options.cwd),
    "MAJOR-1 worker process cwd must exist for the lifetime of its handle",
  );

  const result = await adapter.prompt(SIGNAL, "worker", "work");
  assert.equal(result.message, "reply:work");
  assert.deepEqual(records[0]?.promptDecision, {
    outcome: "selected",
    optionId: "allow",
  });
  await adapter.prompt(SIGNAL, "worker", "again");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.prompts, ["work", "again"]);
  await adapter.close();
  assert.equal(records[0]?.closed, true);
  await assert.rejects(
    stat(records[0]!.options.cwd),
    /ENOENT/,
    "MAJOR-1 worker canary cwd must be removed after the handle closes",
  );
});

test("ensureWorker canary failure abandons workerHome without later close()", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let capturedHome: string | undefined;
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: async (options) => {
      capturedHome = options.isolatedHome;
      await Promise.resolve();
      throw new Error("canary open failed");
    },
  });
  await assert.rejects(adapter.start(), /canary open failed/);
  assert.equal(typeof capturedHome, "string");
  await assert.rejects(stat(capturedHome!), /ENOENT/);
  // Second start can recreate; no stranded auth home from first failure.
  const okRecords: Parameters<typeof fakeOpen>[0] = [];
  const adapter2 = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: fakeOpen(okRecords),
  });
  await adapter2.start();
  await adapter2.close();
});

test("OpenCode cross-owner turns reuse the operator worker, project cwd, and permission mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  const records: Parameters<typeof fakeOpen>[0] = [];
  const adapter = new OpenCodeListenerModel({
    cwd,
    permissionMode: "allow",
    allowMissingAuth: true,
    open: fakeOpen(records),
  });
  await adapter.start();
  await adapter.prompt(
    { ...SIGNAL, sender_owner_relation: "cross_owner" },
    "worker",
    "remote one",
  );
  await adapter.prompt(
    {
      ...SIGNAL,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
      sender_owner_relation: "unknown",
    },
    "worker",
    "remote two",
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]?.workCwd, cwd);
  assert.equal("denyTools" in records[0]!.options, false);
  assert.equal("disposeHomeOnClose" in records[0]!.options, false);
  assert.deepEqual(records[0]?.canaryDecision, {
    outcome: "selected",
    optionId: "deny",
  });
  assert.deepEqual(records[0]?.promptDecision, {
    outcome: "selected",
    optionId: "allow",
  });
  assert.equal(records[0]?.closed, false);
  assert.equal(
    records.every((r) => !("sender_owner_relation" in (r.options as object))),
    true,
  );
  await adapter.close();
  assert.equal(records[0]?.closed, true);
});

test("cross-owner OpenCode prompts keep the worker ACP canary and request path", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let canaryCalls = 0;
  let promptCalls = 0;
  const adapter = new OpenCodeListenerModel({
    cwd,
    permissionMode: "allow",
    allowMissingAuth: true,
    open: async (options) => ({
      session: {
        get arePromptsEnabled() {
          return false;
        },
        async enablePromptsAfterCanary() {
          canaryCalls += 1;
          await options.permissionCallback?.(REQUEST);
        },
        async openWorkCwd() {},
        async prompt() {
          promptCalls += 1;
          assert.equal("denyTools" in options, false);
          await options.permissionCallback?.(REQUEST);
          return { message: "worker reply", stopReason: "end_turn", updates: [] };
        },
        cancel() {},
      },
      child: {},
      executable: "/usr/bin/opencode",
      args: ["acp", "--pure"],
      env: {},
      home: options.isolatedHome!,
      async close() {},
    }) as unknown as OpenCodeAcpHandle,
  });
  await adapter.start();
  await adapter.prompt(
    { ...SIGNAL, sender_owner_relation: "cross_owner" },
    "worker",
    "remote",
  );
  assert.equal(canaryCalls, 1);
  assert.equal(promptCalls, 1);
  await adapter.close();
});

test("OpenCode cancel reaches the shared worker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  const records: Parameters<typeof fakeOpen>[0] = [];
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: fakeOpen(records),
  });
  await adapter.start();
  adapter.cancel();
  assert.equal(records[0]?.cancelled, true);
  await adapter.close();
});

test("cross-owner prompts create no second open for close to settle", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  const records: Parameters<typeof fakeOpen>[0] = [];
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    pendingOpenWaitMs: 2_000,
    open: fakeOpen(records),
  });
  await adapter.start();
  await adapter.prompt(
    { ...SIGNAL, sender_owner_relation: "cross_owner" },
    "worker",
    "remote",
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]?.options.clientName, "cswarm-listener");
  assert.equal(records[0]?.workCwd, cwd);
  await adapter.close();
  assert.equal(records[0]?.closed, true);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("close during gated worker open waits for settle; home remains until verified close", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let releaseOpen: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  let workerHome: string | undefined;
  let childLive = false;
  let handleCloseCount = 0;
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    pendingOpenWaitMs: 2_000,
    open: async (options) => {
      workerHome = options.isolatedHome;
      childLive = true;
      await gate;
      return {
        session: {
          async enablePromptsAfterCanary() {
            await options.permissionCallback?.(REQUEST);
          },
          async openWorkCwd() {},
          async prompt() {
            return { message: "w", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/w",
        async close() {
          handleCloseCount += 1;
        },
      } as unknown as OpenCodeAcpHandle;
    },
  });
  const startPromise = adapter.start();
  for (let i = 0; i < 50 && !workerHome; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(typeof workerHome, "string");
  assert.equal(childLive, true);
  await stat(workerHome!);
  const closePromise = adapter.close();
  await new Promise((r) => setTimeout(r, 30));
  await stat(workerHome!);
  releaseOpen?.();
  await assert.rejects(startPromise, /cancelled during open|closed|listener model is closed/i);
  await closePromise;
  assert.equal(handleCloseCount, 1);
  await assert.rejects(() => stat(workerHome!), /ENOENT/);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("pending open that never settles retains home and fails close", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let workerHome: string | undefined;
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    pendingOpenWaitMs: 50,
    open: async (options) => {
      workerHome = options.isolatedHome;
      // Never settles.
      return new Promise(() => undefined) as Promise<OpenCodeAcpHandle>;
    },
  });
  const startPromise = adapter.start();
  for (let i = 0; i < 50 && !workerHome; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(typeof workerHome, "string");
  await assert.rejects(() => adapter.close(), /pending_open_timeout|retain/i);
  await stat(workerHome!);
  assert.ok(adapter.getRetainedHomes().includes(workerHome!));
  // Clean retained temp artifact after proof
  await rm(workerHome!, { recursive: true, force: true }).catch(() => undefined);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  void startPromise.catch(() => undefined);
});

test("close during gated worker enablePromptsAfterCanary waits for settle; handle closed once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let releaseCanary: (() => void) | undefined;
  const canaryGate = new Promise<void>((resolve) => {
    releaseCanary = resolve;
  });
  let workerHome: string | undefined;
  let handleCloseCount = 0;
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    pendingOpenWaitMs: 2_000,
    open: async (options) => {
      workerHome = options.isolatedHome;
      return {
        session: {
          async enablePromptsAfterCanary() {
            await canaryGate;
          },
          async openWorkCwd() {},
          async prompt() {
            return { message: "w", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/w",
        async close() {
          handleCloseCount += 1;
        },
      } as unknown as OpenCodeAcpHandle;
    },
  });
  const startPromise = adapter.start();
  for (let i = 0; i < 50 && !workerHome; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(typeof workerHome, "string");
  await stat(workerHome!);
  const closePromise = adapter.close();
  await new Promise((r) => setTimeout(r, 30));
  await stat(workerHome!);
  releaseCanary?.();
  await assert.rejects(startPromise, /cancelled during open|closed/i);
  await closePromise;
  assert.equal(handleCloseCount, 1);
  await assert.rejects(() => stat(workerHome!), /ENOENT/);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("close during gated worker openWorkCwd waits for settle; handle closed once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let releaseCwd: (() => void) | undefined;
  const cwdGate = new Promise<void>((resolve) => {
    releaseCwd = resolve;
  });
  let workerHome: string | undefined;
  let handleCloseCount = 0;
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    pendingOpenWaitMs: 2_000,
    open: async (options) => {
      workerHome = options.isolatedHome;
      return {
        session: {
          async enablePromptsAfterCanary() {},
          async openWorkCwd() {
            await cwdGate;
          },
          async prompt() {
            return { message: "w", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/w",
        async close() {
          handleCloseCount += 1;
        },
      } as unknown as OpenCodeAcpHandle;
    },
  });
  const startPromise = adapter.start();
  for (let i = 0; i < 50 && !workerHome; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(typeof workerHome, "string");
  await stat(workerHome!);
  const closePromise = adapter.close();
  await new Promise((r) => setTimeout(r, 30));
  await stat(workerHome!);
  releaseCwd?.();
  await assert.rejects(startPromise, /cancelled during open|closed/i);
  await closePromise;
  assert.equal(handleCloseCount, 1);
  await assert.rejects(() => stat(workerHome!), /ENOENT/);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("close during in-flight open propagates exact child_exit_timeout cleanup failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let releaseOpen: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  let workerHome: string | undefined;
  const timeoutErr = new AcpHostError(
    "child_exit_timeout",
    "child process did not exit after SIGKILL within 5000ms deadline",
  );
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    pendingOpenWaitMs: 2_000,
    open: async (options) => {
      workerHome = options.isolatedHome;
      await gate;
      return {
        session: {
          async enablePromptsAfterCanary() {},
          async openWorkCwd() {},
          async prompt() {
            return { message: "w", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/w",
        async close() {
          await Promise.resolve();
          throw timeoutErr;
        },
      } as unknown as OpenCodeAcpHandle;
    },
  });
  const startPromise = adapter.start();
  void startPromise.catch(() => undefined);
  for (let i = 0; i < 50 && !workerHome; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(typeof workerHome, "string");
  const closePromise = adapter.close();
  void closePromise.catch(() => undefined);
  releaseOpen?.();
  await assert.rejects(startPromise, /child process did not exit/);
  await assert.rejects(closePromise, /child process did not exit/);
  assert.ok(adapter.getRetainedHomes().includes(workerHome!));
  await stat(workerHome!);
  await rm(workerHome!, { recursive: true, force: true }).catch(() => undefined);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("openSession failure propagating child_exit_timeout retains home directory in model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let workerHome: string | undefined;
  let workerCwd: string | undefined;
  const timeoutErr = new AcpHostError(
    "child_exit_timeout",
    "child process did not exit after SIGKILL within 5000ms deadline",
  );
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: async (options) => {
      workerHome = options.isolatedHome;
      workerCwd = options.cwd;
      await Promise.resolve();
      throw timeoutErr;
    },
  });
  await assert.rejects(adapter.start(), /child process did not exit/);
  assert.equal(typeof workerHome, "string");
  assert.ok(adapter.getRetainedHomes().includes(workerHome!));
  await stat(workerHome!);
  await assert.doesNotReject(
    stat(workerCwd!),
    "MAJOR-1 child_exit_timeout must retain the cwd of a possibly live child",
  );
  assert.equal(
    relative(workerHome!, workerCwd!).startsWith(".."),
    false,
    "MAJOR-1 retained child cwd must stay inside the owner-marked home for eventual sweep",
  );
  await rm(workerCwd!, { recursive: true, force: true }).catch(() => undefined);
  await rm(workerHome!, { recursive: true, force: true }).catch(() => undefined);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("concurrent model.close() calls share single performClose; handle closed once; both receive exact error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let handleCloseCount = 0;
  const timeoutErr = new AcpHostError(
    "child_exit_timeout",
    "child process did not exit after SIGKILL within 5000ms deadline",
  );
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: async (options) => {
      return {
        session: {
          async enablePromptsAfterCanary() {},
          async openWorkCwd() {},
          async prompt() {
            return { message: "w", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/w",
        async close() {
          handleCloseCount += 1;
          await Promise.resolve();
          throw timeoutErr;
        },
      } as unknown as OpenCodeAcpHandle;
    },
  });
  await adapter.start();

  const c1 = adapter.close();
  const c2 = adapter.close();
  void c1.catch(() => undefined);
  void c2.catch(() => undefined);

  await assert.rejects(c1, /child process did not exit/);
  await assert.rejects(c2, /child process did not exit/);
  assert.equal(handleCloseCount, 1);

  await assert.rejects(adapter.close(), /child process did not exit/);
  assert.equal(handleCloseCount, 1);

  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("process signal handler close failure is memoized so later runtime close sees exact error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let handleCloseCount = 0;
  const timeoutErr = new AcpHostError(
    "child_exit_timeout",
    "child process did not exit after SIGKILL within 5000ms deadline",
  );
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: async (options) => {
      return {
        session: {
          async enablePromptsAfterCanary() {},
          async openWorkCwd() {},
          async prompt() {
            return { message: "w", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/w",
        async close() {
          handleCloseCount += 1;
          await Promise.resolve();
          throw timeoutErr;
        },
      } as unknown as OpenCodeAcpHandle;
    },
  });
  await adapter.start();

  process.emit("SIGTERM");

  const runtimeClose = adapter.close();
  void runtimeClose.catch(() => undefined);

  await assert.rejects(runtimeClose, /child process did not exit/);
  assert.equal(handleCloseCount, 1);

  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("openSession failure with AcpChildExitError releases home directory (child is dead)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let workerHome: string | undefined;
  const deadErr = new AcpChildExitError(1, null);
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: async (options) => {
      workerHome = options.isolatedHome;
      await Promise.resolve();
      throw deadErr;
    },
  });
  await assert.rejects(adapter.start(), /child exited/);
  assert.equal(typeof workerHome, "string");
  assert.ok(!adapter.getRetainedHomes().includes(workerHome!));
  await assert.rejects(stat(workerHome!), /ENOENT/);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("worker prompt AcpChildExitError plus close timeout retains home and surfaces cleanup failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let workerHome: string | undefined;
  const timeoutErr = new AcpHostError(
    "child_exit_timeout",
    "child process did not exit after SIGKILL within 5000ms deadline",
  );
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: async (options) => {
      workerHome = options.isolatedHome;
      return {
        session: {
          async enablePromptsAfterCanary() {},
          async openWorkCwd() {},
          async prompt() {
            throw new AcpChildExitError(1, null);
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/w",
        async close() {
          throw timeoutErr;
        },
      } as unknown as OpenCodeAcpHandle;
    },
  });
  await adapter.start();
  const dummySignal = {
    id: "sig_1",
    workspace_id: "ws_1",
    from: "usr_1",
    from_kind: "user" as const,
    to: "usr_1",
    to_agent: null,
    in_reply_to: null,
    about: null,
    kind: "ask" as const,
    body: "hello",
    until: new Date().toISOString(),
    created_at: new Date().toISOString(),
    sender_owner_relation: "same_owner" as const,
  };

  const promptPromise = adapter.prompt(dummySignal, "worker", "test prompt");
  void promptPromise.catch(() => undefined);
  await assert.rejects(promptPromise, /child process did not exit/);
  assert.ok(adapter.getRetainedHomes().includes(workerHome!));
  await stat(workerHome!);

  await adapter.close();
  assert.ok(adapter.getRetainedHomes().includes(workerHome!));

  await rm(workerHome!, { recursive: true, force: true }).catch(() => undefined);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("ensureWorker openWorkCwd failure plus cleanup timeout surfaces cleanup failure and retains home", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let workerHome: string | undefined;
  const timeoutErr = new AcpHostError(
    "child_exit_timeout",
    "child process did not exit after SIGKILL within 5000ms deadline",
  );
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: async (options) => {
      workerHome = options.isolatedHome;
      return {
        session: {
          async enablePromptsAfterCanary() {},
          async openWorkCwd() {
            throw new Error("openWorkCwd RPC failed");
          },
          async prompt() {
            return { message: "w", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/w",
        async close() {
          throw timeoutErr;
        },
      } as unknown as OpenCodeAcpHandle;
    },
  });

  const startPromise = adapter.start();
  void startPromise.catch(() => undefined);
  await assert.rejects(startPromise, /child process did not exit/);
  assert.ok(adapter.getRetainedHomes().includes(workerHome!));
  await stat(workerHome!);

  await rm(workerHome!, { recursive: true, force: true }).catch(() => undefined);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("cross-owner prompt errors leave the shared worker open until listener close", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let handleCloseCount = 0;
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: async (options) => {
      return {
        session: {
          async enablePromptsAfterCanary() {},
          async openWorkCwd() {},
          async prompt() {
            throw new Error("worker prompt failed");
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/w",
        async close() {
          handleCloseCount += 1;
        },
      } as unknown as OpenCodeAcpHandle;
    },
  });

  const promptPromise = adapter.prompt(
    {
      id: "sig_2",
      workspace_id: "ws_1",
      from: "usr_2",
      from_kind: "user",
      to: "usr_1",
      to_agent: null,
      in_reply_to: null,
      about: null,
      kind: "ask",
      body: "hello",
      until: new Date().toISOString(),
      created_at: new Date().toISOString(),
      sender_owner_relation: "cross_owner",
    },
    "worker",
    "isolated prompt",
  );
  void promptPromise.catch(() => undefined);
  await assert.rejects(promptPromise, /worker prompt failed/);
  assert.equal(handleCloseCount, 0);
  await adapter.close();
  assert.equal(handleCloseCount, 1);

  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("releaseOpenCodeHome failure records home in retainedHomes and surfaces exact cleanup failure to caller", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cswarm-oc-ro-"));
  const workerHome = await mkdtemp(join(parent, "home-"));
  const adapter = new OpenCodeListenerModel({
    cwd: parent,
    allowMissingAuth: true,
    prepareHome: async () => workerHome,
    open: async () => {
      await chmod(parent, 0o400);
      throw new Error("open failed");
    },
  });

  await assert.rejects(adapter.start(), /EACCES|permission denied/i);
  assert.ok(adapter.getRetainedHomes().includes(workerHome));

  await chmod(parent, 0o700).catch(() => undefined);
  await rm(parent, { recursive: true, force: true }).catch(() => undefined);
});

test("MAJOR-1 review: canary cwd creation failure releases the prepared worker home", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cswarm-oc-canary-init-"));
  const workerHome = join(parent, "worker-home");
  await writeFile(workerHome, "not a directory");
  const adapter = new OpenCodeListenerModel({
    cwd: parent,
    allowMissingAuth: true,
    prepareHome: async () => workerHome,
  });

  await assert.rejects(adapter.start(), /ENOTDIR|not a directory/i);
  await assert.rejects(
    stat(workerHome),
    /ENOENT/,
    "MAJOR-1 pre-handle canary cwd failure must release its prepared worker home",
  );

  await rm(parent, { recursive: true, force: true }).catch(() => undefined);
});

test("MAJOR-1 review: close during canary cwd preparation cannot start an untracked worker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let workerHome: string | undefined;
  let releasePreparation: (() => void) | undefined;
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  let markPreparationStarted: (() => void) | undefined;
  const preparationStarted = new Promise<void>((resolve) => {
    markPreparationStarted = resolve;
  });
  let openCalls = 0;
  const records: Parameters<typeof fakeOpen>[0] = [];
  const open = fakeOpen(records);
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    prepareHome: async (options) => {
      workerHome = await prepareOpenCodeIsolatedHome(options);
      return workerHome;
    },
    prepareWorkerCwd: async (home) => {
      const prepared = await mkdtemp(join(home, "canary-cwd-"));
      await chmod(prepared, 0o700);
      markPreparationStarted?.();
      await preparationGate;
      return prepared;
    },
    open: async (options) => {
      openCalls += 1;
      return await open(options);
    },
  });

  const startPromise = adapter.start();
  void startPromise.catch(() => undefined);
  await preparationStarted;
  await adapter.close();
  await assert.rejects(stat(workerHome!), /ENOENT/);
  releasePreparation?.();
  await assert.rejects(startPromise, /cancelled during open|closed/);
  assert.equal(
    openCalls,
    0,
    "MAJOR-1 close during canary cwd preparation must not start an untracked worker",
  );

  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("cross-owner prompt does not finalize the shared worker home after the turn", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let workerHome: string | undefined;
  const adapter = new OpenCodeListenerModel({
    cwd: parent,
    allowMissingAuth: true,
    open: async (options) => {
      workerHome = options.isolatedHome;
      return {
        session: {
          async enablePromptsAfterCanary() {},
          async openWorkCwd() {},
          async prompt() {
            return { message: "w", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome!,
        async close() {},
      } as unknown as OpenCodeAcpHandle;
    },
  });

  await adapter.prompt(
    { ...SIGNAL, sender_owner_relation: "cross_owner" },
    "worker",
    "prompt text",
  );
  assert.equal(typeof workerHome, "string");
  await stat(workerHome!);
  assert.equal(adapter.getRetainedHomes().includes(workerHome!), false);
  await adapter.close();
  await assert.rejects(stat(workerHome!), /ENOENT/);
  await rm(parent, { recursive: true, force: true }).catch(() => undefined);
});

test("close failure during a cross-owner worker turn retains the shared home", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let isolateHome: string | undefined;
  let releasePrompt: (() => void) | undefined;
  const promptGate = new Promise<void>((r) => {
    releasePrompt = r;
  });
  const timeoutErr = new AcpHostError(
    "child_exit_timeout",
    "child process did not exit after SIGKILL within 5000ms deadline",
  );
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    pendingOpenWaitMs: 2_000,
    open: async (options) => {
      isolateHome = options.isolatedHome;
      return {
        session: {
          async enablePromptsAfterCanary() {},
          async openWorkCwd() {},
          async prompt() {
            await promptGate;
            return { message: "w", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/w",
        async close() {
          throw timeoutErr;
        },
      } as unknown as OpenCodeAcpHandle;
    },
  });

  const promptPromise = adapter.prompt(
    {
      id: "sig_iso",
      workspace_id: "ws_1",
      from: "usr_1",
      from_kind: "user",
      to: "usr_1",
      to_agent: null,
      in_reply_to: null,
      about: null,
      kind: "ask",
      body: "hello",
      until: new Date().toISOString(),
      created_at: new Date().toISOString(),
      sender_owner_relation: "cross_owner",
    },
    "worker",
    "prompt text",
  );

  for (let i = 0; i < 50 && !isolateHome; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(typeof isolateHome, "string");

  const closePromise = adapter.close();
  void promptPromise.catch(() => undefined);
  void closePromise.catch(() => undefined);

  await new Promise((r) => setTimeout(r, 30));
  releasePrompt?.();

  await assert.rejects(closePromise, /child process did not exit/);
  assert.ok(adapter.getRetainedHomes().includes(isolateHome!));

  await chmod(isolateHome!, 0o700).catch(() => undefined);
  await rm(isolateHome!, { recursive: true, force: true }).catch(() => undefined);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

test("performSingleOwnerCleanup home deletion failure overrides cause error and retains home", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cswarm-oc-ro-"));
  const workerHome = await mkdtemp(join(parent, "home-"));
  const adapter = new OpenCodeListenerModel({
    cwd: parent,
    allowMissingAuth: true,
    prepareHome: async () => workerHome,
    open: async (options) => {
      return {
        session: {
          async enablePromptsAfterCanary() {
            await chmod(parent, 0o400);
          },
          async openWorkCwd() {
            throw new Error("canary work CWD failed");
          },
          async prompt() {
            return { message: "w", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/w",
        async close() {},
      } as unknown as OpenCodeAcpHandle;
    },
  });

  await assert.rejects(adapter.start(), /EACCES|permission denied/i);
  assert.ok(adapter.getRetainedHomes().includes(workerHome));

  await chmod(parent, 0o700).catch(() => undefined);
  await rm(parent, { recursive: true, force: true }).catch(() => undefined);
});

test("ensureWorkerHome cancellation home deletion failure surfaces cleanup error and retains home", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cswarm-oc-ro-"));
  const workerHome = await mkdtemp(join(parent, "home-"));
  let homePrepared: (() => void) | undefined;
  const prepareGate = new Promise<void>((r) => {
    homePrepared = r;
  });

  const adapter = new OpenCodeListenerModel({
    cwd: parent,
    allowMissingAuth: true,
    prepareHome: async () => {
      homePrepared?.();
      await new Promise((r) => setTimeout(r, 15));
      await chmod(parent, 0o400);
      return workerHome;
    },
    open: async (options) => {
      return {
        session: {
          async enablePromptsAfterCanary() {},
          async openWorkCwd() {},
          async prompt() {
            return { message: "w", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/w",
        async close() {},
      } as unknown as OpenCodeAcpHandle;
    },
  });

  const startPromise = adapter.start();
  await prepareGate;
  const closePromise = adapter.close();

  await assert.rejects(startPromise, /EACCES|permission denied/i);
  await closePromise.catch(() => undefined);
  assert.ok(adapter.getRetainedHomes().includes(workerHome));

  await chmod(parent, 0o700).catch(() => undefined);
  await rm(parent, { recursive: true, force: true }).catch(() => undefined);
});

test("allowMissingAuth is explicit — not implied by fake open alone", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  const records: Parameters<typeof fakeOpen>[0] = [];
  // Without allowMissingAuth, prepareOpenCodeIsolatedHome may throw if no auth —
  // when open is faked, home prep still runs and needs real auth OR allowMissingAuth.
  // Force missing auth path via empty XDG and require the option.
  const adapter = new OpenCodeListenerModel({
    cwd,
    env: {
      PATH: "/usr/bin",
      HOME: cwd,
      XDG_DATA_HOME: join(cwd, "empty-xdg"),
    },
    open: fakeOpen(records),
    // deliberately no allowMissingAuth
  });
  await assert.rejects(() => adapter.start(), /opencode_auth_missing|not signed in/);
});

test("one-winner: closed model rejects new prompts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: fakeOpen([]),
  });
  await adapter.start();
  await adapter.close();
  await assert.rejects(
    () => adapter.prompt(SIGNAL, "worker", "nope"),
    /closed/,
  );
});

test("cancel during deferred ensureWorkerHome releases registered home", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let releasePrepare: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });
  let capturedHome: string | undefined;
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    prepareHome: async (options) => {
      await gate;
      const home = await prepareOpenCodeIsolatedHome(options);
      capturedHome = home;
      return home;
    },
    open: fakeOpen([]),
  });
  const startPromise = adapter.start();
  // Cancel while prepare is still gated (before home is registered).
  adapter.cancel();
  releasePrepare?.();
  await assert.rejects(startPromise, /cancelled during open|closed/);
  assert.equal(typeof capturedHome, "string");
  // After registration+assert failure path, home must be released (absent).
  await assert.rejects(() => stat(capturedHome!), /ENOENT/);
});

test("close child_exit_timeout retains worker home; runtime+supervisor fail", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let workerHome: string | undefined;
  const dyingClose = async () => {
    throw new AcpHostError(
      "child_exit_timeout",
      "OpenCode child did not exit after SIGTERM and SIGKILL",
    );
  };
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: async (options) => {
      workerHome = options.isolatedHome;
      return {
        session: {
          async enablePromptsAfterCanary() {
            await options.permissionCallback?.(REQUEST);
          },
          async openWorkCwd() {},
          async prompt() {
            return { message: "ok", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? cwd,
        close: dyingClose,
      } as unknown as OpenCodeAcpHandle;
    },
  });
  await adapter.start();
  assert.equal(typeof workerHome, "string");
  await assert.rejects(() => adapter.close(), /child_exit_timeout|did not exit/);
  await stat(workerHome!);
  assert.ok(adapter.getRetainedHomes().includes(workerHome!));

  // Runtime escalates close failure to fatal (does not swallow).
  const controller = new AbortController();
  let homeFromRuntime: string | undefined;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: SIGNAL.workspace_id,
    principalId: SIGNAL.to_agent!,
    credentialSession: { async bearer() { return "t"; } },
    store: {
      async read() { return null; },
      async write() {},
    },
    model: new OpenCodeListenerModel({
      cwd,
      allowMissingAuth: true,
      open: async (options) => {
        homeFromRuntime = options.isolatedHome;
        return {
          session: {
            async enablePromptsAfterCanary() {
              await options.permissionCallback?.(REQUEST);
            },
            async openWorkCwd() {},
            async prompt() {
              return { message: "ok", stopReason: "end_turn" as const, updates: [] };
            },
            cancel() {},
          },
          child: {},
          executable: process.execPath,
          args: ["acp", "--pure"],
          env: {},
          home: options.isolatedHome ?? cwd,
          close: dyingClose,
        } as unknown as OpenCodeAcpHandle;
      },
    }),
    signal: controller.signal,
    sleep: async () => {
      controller.abort();
    },
    readPage: async () => ({
      signals: [],
      capabilities: {
        senderOwnerRelation: true,
        cursorAfter: true,
        deliveryClaim: false,
        deliveryAck: false,
      },
      legacyCursorFallback: false,
      rawCount: 0,
      nextCursor: null,
      malformedRows: 0,
      pendingDeliveryCount: null,
    }),
  });
  assert.equal(stop.reason, "fatal");
  if (stop.reason === "fatal") {
    assert.equal(
      (stop.error as Error & { code?: string }).code,
      "child_exit_timeout",
    );
  }
  assert.equal(typeof homeFromRuntime, "string");
  await stat(homeFromRuntime!);

  // Supervisor records failed status with child_exit_timeout code.
  const paths3 = listenerPaths({
    profileId: "p3",
    workspaceId: SIGNAL.workspace_id,
    principalId: SIGNAL.to_agent!,
    stateDirectory: await mkdtemp(join(tmpdir(), "cswarm-oc-state3-")),
  });
  let homeExact: string | undefined;
  const status3 = await runListenerSupervisor({
    paths: paths3,
    profileId: "p3",
    workspaceId: SIGNAL.workspace_id,
    principalId: SIGNAL.to_agent!,
    provider: "opencode",
    run: async () => {
      const model = new OpenCodeListenerModel({
        cwd,
        allowMissingAuth: true,
        open: async (options) => {
          homeExact = options.isolatedHome;
          return {
            session: {
              async enablePromptsAfterCanary() {
                await options.permissionCallback?.(REQUEST);
              },
              async openWorkCwd() {},
              async prompt() {
                return {
                  message: "ok",
                  stopReason: "end_turn" as const,
                  updates: [],
                };
              },
              cancel() {},
            },
            child: {},
            executable: process.execPath,
            args: ["acp", "--pure"],
            env: {},
            home: options.isolatedHome ?? cwd,
            close: dyingClose,
          } as unknown as OpenCodeAcpHandle;
        },
      });
      await model.start();
      await model.close(); // throws → supervisor catch → failed
      return { reason: "cancelled" as const };
    },
  });
  assert.equal(status3.state, "failed");
  assert.equal(status3.lastErrorCode, "child_exit_timeout");
  assert.equal(typeof homeExact, "string");
  await stat(homeExact!);
});
