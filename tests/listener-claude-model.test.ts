/** ★ THIS FILE IS NAMED IN `npm test`; all Claude sessions are injected fakes. */
import assert from "node:assert/strict";
import { lstat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SignalRecord } from "../src/cloud/command-client.js";
import type {
  ClaudeAcpHandle,
  ClaudeAcpOpenOptions,
} from "../src/host/claude.js";
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
  classifyClaudeCanaryFailure,
  ClaudeListenerModel,
  ListenerEngine,
  ListenerRenewalUnavailableError,
  type OpenClaudeSession,
} from "../src/listener/index.js";
import type {
  ListenerEffectRecord,
  ListenerEffectStore,
} from "../src/listener/types.js";

test("Claude canary classifier records the API floor and uses typed timeout", () => {
  assert.deepEqual(
    classifyClaudeCanaryFailure(
      "Internal error: API Error: 400 Claude Code 2.1.232 does not support this model; version 2.1.251 or newer is required.",
      "rpc_error",
    ),
    {
      code: "claude_bridge_version_required",
      minimumRequiredVersion: "2.1.251",
    },
  );
  assert.deepEqual(
    classifyClaudeCanaryFailure("wording can change", "timeout"),
    { code: "claude_canary_timeout", minimumRequiredVersion: null },
  );
  assert.deepEqual(
    classifyClaudeCanaryFailure(
      "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed (failed 2 attempts)",
      "rpc_error",
    ),
    { code: "claude_canary_auth_failed", minimumRequiredVersion: null },
  );
  assert.deepEqual(
    classifyClaudeCanaryFailure("presentation text changed", "rpc_error", {
      code: -32603,
      data: { errorKind: "authentication_failed" },
    }),
    { code: "claude_canary_auth_failed", minimumRequiredVersion: null },
  );
  assert.deepEqual(
    classifyClaudeCanaryFailure("presentation text changed", "rpc_error", {
      code: -32000,
    }),
    { code: "claude_canary_auth_failed", minimumRequiredVersion: null },
  );
  assert.deepEqual(
    classifyClaudeCanaryFailure("ordinary unknown bridge text", "rpc_error"),
    { code: "claude_canary_unknown", minimumRequiredVersion: null },
  );
  assert.deepEqual(
    classifyClaudeCanaryFailure("could not be refreshed", "rpc_error"),
    { code: "claude_canary_unknown", minimumRequiredVersion: null },
  );
});

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
  options: ClaudeAcpOpenOptions;
  canaryOptions?: {
    probeText?: string;
    timeoutMs?: number;
    onAttempt?: (
      attempt: number,
      total: number,
      result: { passed: boolean; reason?: string },
    ) => void;
  };
  canaryDecision?: PermissionDecision;
  promptDecision?: PermissionDecision;
  promptTimeoutMs?: number;
  promptCalls: number;
  closed: boolean;
  cancelled: boolean;
};

function fakeOpen(records: Record[]): OpenClaudeSession {
  return async (options) => {
    const record: Record = { options, promptCalls: 0, closed: false, cancelled: false };
    records.push(record);
    const session = {
      async enablePromptsAfterCanary(canaryOptions?: {
        probeText?: string;
        timeoutMs?: number;
        onAttempt?: (
          attempt: number,
          total: number,
          result: { passed: boolean; reason?: string },
        ) => void;
      }) {
        record.canaryOptions = canaryOptions;
        record.canaryDecision = await options.permissionCallback?.(REQUEST);
        canaryOptions?.onAttempt?.(1, 2, { passed: true });
      },
      async prompt(text: string, promptOptions?: { timeoutMs?: number }) {
        record.promptCalls += 1;
        record.promptTimeoutMs = promptOptions?.timeoutMs;
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
      executable: "/opt/claude-agent-acp",
      args: [],
      env: {},
      async close() {
        record.closed = true;
      },
    } as unknown as ClaudeAcpHandle;
  };
}

test("Claude worker canary denies before explicit allow mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
  const records: Record[] = [];
  const attempts: number[] = [];
  const adapter = new ClaudeListenerModel({
    cwd,
    permissionMode: "allow",
    onCanaryAttempt: (attempt) => attempts.push(attempt),
    open: fakeOpen(records),
  });
  await adapter.start();
  assert.deepEqual(records[0]?.canaryDecision, {
    outcome: "selected",
    optionId: "deny",
  });
  assert.match(records[0]?.canaryOptions?.probeText ?? "", /Write tool/);
  assert.match(records[0]?.canaryOptions?.probeText ?? "", /cswarm-claude-permission-canary/);
  assert.doesNotMatch(records[0]?.canaryOptions?.probeText ?? "", new RegExp(cwd));
  assert.equal(records[0]?.canaryOptions?.timeoutMs, 30_000);
  assert.deepEqual(attempts, [1]);
  const result = await adapter.prompt(SIGNAL, "worker", "work");
  assert.equal(result.message, "reply:work");
  assert.deepEqual(records[0]?.promptDecision, {
    outcome: "selected",
    optionId: "allow",
  });
  await adapter.close();
  assert.equal(records[0]?.closed, true);
});

test("Claude listener forwards exact bridge runtime evidence before canary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-runtime-"));
  const records: Record[] = [];
  const notices: Array<{
    executable: string;
    providerVersion: string | null;
    bundledAgentSdkVersion: string | null;
    bundledClaudeCodeVersion: string | null;
  }> = [];
  const delegate = fakeOpen(records);
  const adapter = new ClaudeListenerModel({
    cwd,
    open: async (options) => {
      options.onRuntimeNotice?.({
        executable: "/opt/claude-agent-acp",
        providerVersion: "0.73.0",
        lastMeasuredVersion: "0.64.2",
        bundledAgentSdkVersion: "0.3.257",
        bundledClaudeCodeVersion: "2.1.257",
      });
      return delegate(options);
    },
    onRuntimeNotice: (notice) => notices.push(notice),
  });

  await adapter.start();
  assert.deepEqual(notices, [{
    executable: "/opt/claude-agent-acp",
    providerVersion: "0.73.0",
    lastMeasuredVersion: "0.64.2",
    bundledAgentSdkVersion: "0.3.257",
    bundledClaudeCodeVersion: "2.1.257",
  }]);
  await adapter.close();
});

test("Claude sender relations share one worker, cwd, and permission mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
  const records: Record[] = [];
  const adapter = new ClaudeListenerModel({
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

test("Claude listener cancel reaches the active host handle", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
  const records: Record[] = [];
  const adapter = new ClaudeListenerModel({ cwd, open: fakeOpen(records) });
  await adapter.start();
  adapter.cancel();
  assert.equal(records[0]?.cancelled, true);
  await adapter.close();
});

test("Claude canary removes a sentinel written before denial and refuses startup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
  let sentinelPath = "";
  let closed = false;
  const open: OpenClaudeSession = async (options) => ({
    session: {
      async enablePromptsAfterCanary(canaryOptions?: { probeText?: string }) {
        const match = canaryOptions?.probeText?.match(
          /Create the file (\S+) using the Write tool/,
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
    executable: "/opt/claude-agent-acp",
    args: [],
    env: {},
    async close() {
      closed = true;
    },
  } as unknown as ClaudeAcpHandle);
  const adapter = new ClaudeListenerModel({ cwd, open });

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

test("Claude listener maps retained ACP auth data before rethrowing the canary failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
  let closed = false;
  const detail = "presentation text without an auth phrase";
  const open: OpenClaudeSession = async () => ({
    session: {
      async enablePromptsAfterCanary() {
        throw new AcpPermissionCanaryError(detail, "rpc_error", null, {
          code: -32603,
          data: { errorKind: "authentication_failed" },
        });
      },
      async prompt() {
        throw new Error("unreachable");
      },
      cancel() {},
    },
    child: {},
    executable: "/opt/claude-agent-acp",
    args: [],
    env: {},
    async close() {
      closed = true;
    },
  } as unknown as ClaudeAcpHandle);
  const adapter = new ClaudeListenerModel({ cwd, open });

  await assert.rejects(
    () => adapter.start(),
    (error: unknown) => {
      assert.ok(error instanceof AcpPermissionCanaryError);
      assert.equal(error.message, detail);
      assert.equal(error.reasonCode, "claude_canary_auth_failed");
      return true;
    },
  );
  assert.equal(closed, true);
});

test("Claude close waits for an opening worker and closes it before installation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
  const records: Record[] = [];
  let releaseOpen!: () => void;
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const delegate = fakeOpen(records);
  const open: OpenClaudeSession = async (options) => {
    await openGate;
    return delegate(options);
  };
  const adapter = new ClaudeListenerModel({ cwd, open });

  const starting = adapter.start();
  await Promise.resolve();
  const closing = adapter.close();
  releaseOpen();

  await assert.rejects(starting, /closed while the Claude worker was opening/);
  await closing;
  assert.equal(records.length, 1);
  assert.equal(records[0]?.closed, true);
  await assert.rejects(() => adapter.prompt(SIGNAL, "worker", "late"), /closed/);
});

test("Claude close cancels and closes a canary already in flight", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
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
  const open: OpenClaudeSession = async () => ({
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
    executable: "/opt/claude-agent-acp",
    args: [],
    env: {},
    async close() {
      closed = true;
    },
  } as unknown as ClaudeAcpHandle);
  const adapter = new ClaudeListenerModel({ cwd, open });

  const starting = adapter.start();
  await canaryEntered;
  const closing = adapter.close();

  await assert.rejects(starting, /closed while the Claude worker was opening/);
  await closing;
  assert.equal(cancelled, true);
  assert.equal(closed, true);
});

test("Claude close settles opening work before propagating teardown failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
  let canaryStarted!: () => void;
  const canaryEntered = new Promise<void>((resolve) => {
    canaryStarted = resolve;
  });
  let releaseCanary!: () => void;
  const canaryGate = new Promise<void>((resolve) => {
    releaseCanary = resolve;
  });
  let closeAttempts = 0;
  const open: OpenClaudeSession = async () => ({
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
    executable: "/opt/claude-agent-acp",
    args: [],
    env: {},
    async close() {
      closeAttempts += 1;
      throw new Error("verified teardown failed");
    },
  } as unknown as ClaudeAcpHandle);
  const adapter = new ClaudeListenerModel({ cwd, open });

  const starting = adapter.start();
  await canaryEntered;
  const closing = adapter.close();

  await assert.rejects(starting, /verified teardown failed/);
  await assert.rejects(closing, /verified teardown failed/);
  assert.ok(closeAttempts >= 1);
  await assert.rejects(() => adapter.prompt(SIGNAL, "worker", "late"), /closed/);
});

test("D-050: Claude close timeout is runtime-fatal before replacement opens", async () => {
  class MemoryStore implements ListenerEffectStore {
    private readonly records = new Map<string, ListenerEffectRecord>();

    async read(signalId: string): Promise<ListenerEffectRecord | null> {
      return structuredClone(this.records.get(signalId.toLowerCase()) ?? null);
    }

    async write(record: ListenerEffectRecord): Promise<void> {
      this.records.set(record.signalId.toLowerCase(), structuredClone(record));
    }
  }

  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-d050-"));
  const store = new MemoryStore();
  let opens = 0;
  let closes = 0;
  const timeout = new AcpHostError(
    "child_exit_timeout",
    "Claude ACP bridge did not exit after SIGTERM and SIGKILL",
  );
  const adapter = new ClaudeListenerModel({
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
        executable: "/opt/claude-agent-acp",
        args: [],
        env: {},
        async close() {
          closes += 1;
          throw timeout;
        },
      } as unknown as ClaudeAcpHandle;
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

test("worker prompt turns get the 10-minute default budget; the handshake keeps the tight transport default", async () => {
  /* The 120s transport default protects initialize/session-new/canary; a real
   * prompt turn legitimately runs for minutes (measured: a heavyweight ask
   * died at exactly +120s twice before succeeding on durable retry). The
   * model must therefore pass a per-call budget on the PROMPT only. */
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
  const records: Record[] = [];
  const adapter = new ClaudeListenerModel({
    cwd,
    permissionMode: "allow",
    open: fakeOpen(records),
  });
  await adapter.start();
  await adapter.prompt(SIGNAL, "worker", "work");
  assert.equal(records[0]?.promptTimeoutMs, 600_000);
  // The open options must NOT widen the transport-wide request timeout —
  // that would slow every wedged-handshake failure, not just prompts.
  assert.equal(records[0]?.options.requestTimeoutMs, undefined);
  await adapter.close();
});

test("promptTimeoutMs overrides the prompt-turn budget and onWorkerStderrTail threads into the host open", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
  const records: Record[] = [];
  const tails: string[] = [];
  const adapter = new ClaudeListenerModel({
    cwd,
    permissionMode: "allow",
    promptTimeoutMs: 45_000,
    onWorkerStderrTail: (tail) => tails.push(tail),
    open: fakeOpen(records),
  });
  await adapter.start();
  await adapter.prompt(SIGNAL, "worker", "work");
  assert.equal(records[0]?.promptTimeoutMs, 45_000);
  const onStderrTail = (records[0]?.options as { onStderrTail?: (tail: string) => void })
    .onStderrTail;
  assert.equal(typeof onStderrTail, "function");
  onStderrTail!("boom");
  assert.deepEqual(tails, ["boom"]);
  await adapter.close();
});

test("a promptTimeoutMs resolver is awaited at each turn start", async () => {
  /* The listener passes a resolver, not a number: it renews the credential
   * when due and clamps to what it can still cover, so the value can differ
   * per turn. The model must call it per prompt, never cache it. */
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
  const records: Record[] = [];
  const budgets = [120_000, 45_000];
  let calls = 0;
  const adapter = new ClaudeListenerModel({
    cwd,
    permissionMode: "allow",
    promptTimeoutMs: async () => budgets[calls++]!,
    open: fakeOpen(records),
  });
  await adapter.start();
  await adapter.prompt(SIGNAL, "worker", "one");
  assert.equal(records[0]?.promptTimeoutMs, 120_000);
  await adapter.prompt(SIGNAL, "worker", "two");
  assert.equal(records[0]?.promptTimeoutMs, 45_000);
  assert.equal(calls, 2, "the resolver must run once per turn");
  await adapter.close();
});

test("a resolver that defers (throws) is not caught by the model and never reaches the worker prompt", async () => {
  /* Item 4: the budget is resolved BEFORE the worker is prompted. If the
   * resolver throws ListenerRenewalUnavailableError (credential cannot outlast
   * the turn), the model must let it propagate — no session.prompt, so the
   * engine defers the ask instead of burning a doomed turn. */
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
  const records: Record[] = [];
  const adapter = new ClaudeListenerModel({
    cwd,
    permissionMode: "allow",
    promptTimeoutMs: async () => {
      throw new ListenerRenewalUnavailableError("deferring: credential inside margin");
    },
    open: fakeOpen(records),
  });
  await adapter.start();
  await assert.rejects(
    adapter.prompt(SIGNAL, "worker", "work"),
    (error) => error instanceof ListenerRenewalUnavailableError,
  );
  assert.equal(records[0]?.promptCalls, 0, "the worker prompt must not run on a deferral");
  await adapter.close();
});

test("a worker death + slow respawn with an expired credential defers, never prompting on the dead credential", async () => {
  /* Item 1 (final round): the budget gate must run AFTER the respawn, not
   * before it. Turn 1's worker dies mid-prompt (AcpChildExitError), so turn 2
   * respawns. The respawn is SLOW — it advances the clock past the credential's
   * expiry — so a gate that resolved BEFORE the respawn would prompt turn 2 on
   * a now-dead credential. With the gate after ensureWorker, turn 2 defers. */
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-claude-worker-"));
  let now = 0;
  const expiry = 1_000;
  const marginAnalog = 60; // defer once within this of expiry
  let opens = 0;
  const promptCallsPerWorker: number[] = [];
  const openSession: OpenClaudeSession = async (options) => {
    opens += 1;
    const workerIndex = opens;
    // The respawn (2nd open) is slow: it advances the clock past expiry.
    if (opens >= 2) now = expiry + 1;
    promptCallsPerWorker[workerIndex - 1] = 0;
    const session = {
      async enablePromptsAfterCanary() {
        await options.permissionCallback?.(REQUEST);
      },
      async prompt(text: string) {
        promptCallsPerWorker[workerIndex - 1] += 1;
        if (workerIndex === 1) {
          // Worker 1 dies mid-turn; the model nulls it, forcing a respawn.
          throw new AcpChildExitError(1, null);
        }
        return { message: `reply:${text}`, stopReason: "end_turn" as const, updates: [] };
      },
      cancel() {},
    };
    return {
      session,
      child: {},
      executable: "/opt/claude-agent-acp",
      args: [],
      env: {},
      async close() {},
    } as unknown as import("../src/host/claude.js").ClaudeAcpHandle;
  };
  const promptTimeoutMs = async () => {
    // The same shape as the real resolver: defer when the credential is inside
    // its rotation margin / expired at the moment the turn actually starts.
    if (now >= expiry - marginAnalog) {
      throw new ListenerRenewalUnavailableError("credential inside margin / expired at turn start");
    }
    return 30_000;
  };
  const adapter = new ClaudeListenerModel({
    cwd,
    permissionMode: "allow",
    promptTimeoutMs,
    open: openSession,
  });

  // Turn 1: worker opens (now=0), gate resolves a live budget, prompt dies.
  await assert.rejects(
    adapter.prompt(SIGNAL, "worker", "one"),
    (error) => error instanceof AcpChildExitError,
  );
  assert.equal(promptCallsPerWorker[0], 1, "worker 1 was prompted, then died");

  // Turn 2: ensureWorker respawns worker 2, which advances the clock past
  // expiry; ONLY THEN does the gate resolve -> it must defer, not prompt.
  await assert.rejects(
    adapter.prompt(SIGNAL, "worker", "two"),
    (error) => error instanceof ListenerRenewalUnavailableError,
  );
  assert.equal(
    promptCallsPerWorker[1],
    0,
    "worker 2 must NOT be prompted on the now-dead credential",
  );
  await adapter.close();
});
