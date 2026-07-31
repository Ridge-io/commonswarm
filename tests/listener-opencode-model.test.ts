import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.equal(records[0]?.options.disposeHomeOnClose, false);

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

test("OpenCode cross-owner turns get fresh homes/cwds and always deny tools", async () => {
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
    "isolated",
    "remote one",
  );
  await adapter.prompt(
    {
      ...SIGNAL,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
      sender_owner_relation: "unknown",
    },
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
  assert.equal(
    records.every((r) => !("sender_owner_relation" in (r.options as object))),
    true,
  );
  await adapter.close();
});

test("OpenCode cancel reaches worker and in-flight isolates", async () => {
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

test("close during gated isolate open waits for settle; home remains until verified close", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-oc-worker-"));
  let releaseOpen: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  let isolatedHome: string | undefined;
  let childLive = false;
  let handleCloseCount = 0;
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    pendingOpenWaitMs: 2_000,
    open: async (options) => {
      if (options.clientName === "cswarm-listener") {
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
          home: options.isolatedHome ?? "/tmp/x",
          async close() {},
        } as unknown as OpenCodeAcpHandle;
      }
      isolatedHome = options.isolatedHome;
      childLive = true; // openSession has started; child may be live
      await gate;
      return {
        session: {
          async enablePromptsAfterCanary() {
            await options.permissionCallback?.(REQUEST);
          },
          async prompt() {
            return { message: "i", stopReason: "end_turn" as const, updates: [] };
          },
          cancel() {},
        },
        child: {},
        executable: process.execPath,
        args: ["acp", "--pure"],
        env: {},
        home: options.isolatedHome ?? "/tmp/y",
        async close() {
          handleCloseCount += 1;
        },
      } as unknown as OpenCodeAcpHandle;
    },
  });
  await adapter.start();
  const isolatedPrompt = adapter.prompt(
    { ...SIGNAL, sender_owner_relation: "cross_owner" },
    "isolated",
    "race",
  );
  for (let i = 0; i < 50 && !isolatedHome; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(typeof isolatedHome, "string");
  assert.equal(childLive, true);
  // During the gate, close must NOT remove the home (child live under pending open).
  const closePromise = adapter.close();
  await new Promise((r) => setTimeout(r, 30));
  await stat(isolatedHome!);
  releaseOpen?.();
  await assert.rejects(isolatedPrompt, /cancelled during open|closed/i);
  await closePromise;
  assert.equal(handleCloseCount, 1);
  // After settle + verified close, home must be absent on disk.
  await assert.rejects(() => stat(isolatedHome!), /ENOENT/);
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
  const timeoutErr = new AcpHostError(
    "child_exit_timeout",
    "child process did not exit after SIGKILL within 5000ms deadline",
  );
  const adapter = new OpenCodeListenerModel({
    cwd,
    allowMissingAuth: true,
    open: async (options) => {
      workerHome = options.isolatedHome;
      await Promise.resolve();
      throw timeoutErr;
    },
  });
  await assert.rejects(adapter.start(), /child process did not exit/);
  assert.equal(typeof workerHome, "string");
  assert.ok(adapter.getRetainedHomes().includes(workerHome!));
  await stat(workerHome!);
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
      capabilities: { senderOwnerRelation: true, cursorAfter: true },
      legacyCursorFallback: false,
      rawCount: 0,
      nextCursor: null,
      malformedRows: 0,
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
