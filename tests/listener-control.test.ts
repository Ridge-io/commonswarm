import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import test from "node:test";
import {
  ListenerAlreadyRunningError,
  LISTENER_RESTART_MAX_MS,
  GrokListenerModel,
  ackCommandId,
  appendListenerEvent,
  claimCommandId,
  effectiveListenerStatus,
  isRestartableListenerStop,
  listenerPaths,
  nextListenerRestartMs,
  openListenerDeliveryJournal,
  parseJournalRecord,
  queryListenerControl,
  readListenerStatus,
  runListenerSupervisor,
  startListenerControlServer,
  stopListener,
  waitForListenerReady,
  writeListenerStatus,
  type ListenerPaths,
  type ListenerRuntimeEvent,
  type ListenerRuntimeStop,
  type ListenerStatus,
} from "../src/listener/index.js";
import type { GrokAcpHandle } from "../src/host/grok.js";
import {
  readSecureJsonFile,
  writeSecureJsonFile,
} from "../src/cloud/storage.js";
import {
  SignalHttpError,
  SignalMalformedError,
  SignalReadTimeoutError,
  SignalTransportError,
} from "../src/cloud/signals.js";
import {
  DeliveryHttpError,
  DeliveryProtocolError,
  DeliveryTransportError,
} from "../src/cloud/delivery.js";
import {
  CommandHttpError,
  CommandTransportError,
} from "../src/cloud/command-client.js";
import {
  AcpChildExitError,
  AcpHostError,
  AcpPermissionCanaryError,
  AcpPromptsBlockedError,
  AcpProtocolError,
  AcpTimeoutError,
  AcpTransportError,
  AcpVersionError,
} from "../src/host/types.js";
import {
  RenewalReauthorisationRequired,
  RenewalRevoked,
} from "../src/cloud/renewal.js";
import { ListenerCapabilityError } from "../src/listener/runtime.js";
import {
  listenerStatusJson,
  renderListenerStatus,
} from "../src/cli.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function paths(root: string): ListenerPaths {
  return listenerPaths({
    profileId: `profile-${randomUUID()}`,
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    stateDirectory: root,
  });
}

function statusFor(paths: ListenerPaths, state: ListenerStatus["state"]): ListenerStatus {
  const ts = "2026-07-30T00:00:00.000Z";
  return {
    version: 1,
    instanceId: randomUUID(),
    provider: "grok",
    profileId: "profile-test",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    pid: process.pid,
    state,
    startedAt: ts,
    readyAt: state === "ready" ? ts : null,
    updatedAt: ts,
    stoppedAt: state === "stopped" || state === "failed" ? ts : null,
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    providerVersion: null,
    providerLastMeasuredVersion: null,
    lastWorkerStderrTail: null,
    deliveryMode: null,
    pendingDeliveryCount: null,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
    routeMode: "worker",
    deferOverChars: null,
    pendingForMainCount: 0,
    droppedForMainCount: 0,
    logPath: paths.logPath,
  };
}

test("listener status and event log are secure and reject secret-shaped fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const status = statusFor(target, "ready");
  await writeListenerStatus(target, status);
  assert.deepEqual(await readListenerStatus(target), status);
  assert.equal((await stat(target.statusPath)).mode & 0o777, 0o600);
  assert.equal((await stat(target.instanceDirectory)).mode & 0o777, 0o700);

  await appendListenerEvent(target, {
    ts: status.updatedAt,
    event: "listener_ready",
  });
  assert.equal((await stat(target.logPath)).mode & 0o777, 0o600);
  assert.match(await readFile(target.logPath, "utf8"), /listener_ready/);
  await assert.rejects(
    appendListenerEvent(target, {
      ts: status.updatedAt,
      event: "listener_bad",
      body: "prompt text",
    }),
    /field is not allowed/,
  );
  await assert.rejects(
    appendListenerEvent(target, {
      ts: status.updatedAt,
      event: "swm_agt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
    /unsafe text/,
  );
});

test("Grok canary attempts reach the local event log and terminal detail", async () => {
  const runCanary = async (passed: boolean) => {
    const root = await mkdtemp(join(tmpdir(), "cswarm-control-canary-test-"));
    const target = paths(root);
    const workspaceId = randomUUID();
    const principalId = randomUUID();
    const final = await runListenerSupervisor({
      paths: target,
      profileId: "profile-canary",
      workspaceId,
      principalId,
      restart: { maxAttempts: 0 },
      run: async (_signal, onEvent) => {
        const model = new GrokListenerModel({
          cwd: root,
          onCanaryAttempt: (attempt, total, result) => {
            onEvent({
              type: "canary_attempt",
              attempt,
              total,
              passed: result.passed,
              reason: result.reason ?? null,
              ts: new Date().toISOString(),
            });
          },
          open: async () => ({
            session: {
              async enablePromptsAfterCanary(options?: {
                onAttempt?: (
                  attempt: number,
                  total: number,
                  result: { passed: boolean; reason?: string },
                ) => void;
              }) {
                if (passed) {
                  options?.onAttempt?.(1, 2, { passed: true });
                  return;
                }
                const reason =
                  "canary incomplete: permission=false deniedTool=false";
                options?.onAttempt?.(1, 2, { passed: false, reason });
                options?.onAttempt?.(2, 2, { passed: false, reason });
                throw new AcpPermissionCanaryError(
                  `${reason} (failed 2 attempts)`,
                );
              },
              async prompt() {
                throw new Error("unreachable");
              },
              cancel() {},
            },
            child: {},
            executable: "grok",
            args: [],
            env: {},
            async close() {},
          } as unknown as GrokAcpHandle),
        });
        try {
          await model.start();
          onEvent({
            type: "ready",
            workspaceId,
            principalId,
            ts: new Date().toISOString(),
          });
          await model.close();
          return { reason: "cancelled" as const };
        } catch (error) {
          return {
            reason: "fatal" as const,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      },
    });
    const stored = await readListenerStatus(target);
    const events = (await readFile(target.logPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { final, stored, events };
  };

  const failed = await runCanary(false);
  assert.equal(failed.final.state, "failed");
  assert.equal(
    failed.stored?.lastErrorDetail,
    "canary incomplete: permission=false deniedTool=false (failed 2 attempts)",
  );
  assert.deepEqual(
    failed.events
      .filter((event) => event.event === "listener_canary_attempt")
      .map(({ attempt, total, passed, reason }) => ({
        attempt,
        total,
        passed,
        reason,
      })),
    [
      {
        attempt: 1,
        total: 2,
        passed: false,
        reason: "canary incomplete: permission=false deniedTool=false",
      },
      {
        attempt: 2,
        total: 2,
        passed: false,
        reason: "canary incomplete: permission=false deniedTool=false",
      },
    ],
  );

  const healthy = await runCanary(true);
  assert.equal(healthy.final.state, "stopped");
  assert.equal(healthy.stored?.lastErrorDetail, null);
  assert.deepEqual(
    healthy.events
      .filter((event) => event.event === "listener_canary_attempt")
      .map(({ passed, reason }) => ({ passed, reason })),
    [{ passed: true, reason: null }],
  );
});

test("Claude is a durable listener status provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const status = { ...statusFor(target, "ready"), provider: "claude" as const };
  await writeListenerStatus(target, status);
  assert.deepEqual(await readListenerStatus(target), status);
});

test("Codex is a durable listener status provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const status = { ...statusFor(target, "ready"), provider: "codex" as const };
  await writeListenerStatus(target, status);
  assert.deepEqual(await readListenerStatus(target), status);
});

test("failed Claude startup keeps measured runtime and demanded API floor", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-claude-version-"));
  const target = paths(root);
  const error = new AcpPermissionCanaryError(
    "Internal error: API Error: 400 Claude Code 2.1.232 does not support this model; version 2.1.251 or newer is required.",
    "claude_bridge_version_required",
    "2.1.251",
  );
  const final = await runListenerSupervisor({
    paths: target,
    profileId: "profile-claude-version",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    provider: "claude",
    restart: { maxAttempts: 0 },
    getProviderVersionNotice: () => ({
      executable:
        "/opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
      runningVersion: "0.70.0",
      lastMeasuredVersion: "0.64.2",
      bundledAgentSdkVersion: "0.3.232",
      bundledClaudeCodeVersion: "2.1.232",
    }),
    run: async () => ({ reason: "fatal", error }),
  });
  assert.equal(final.state, "failed");
  assert.equal(final.lastErrorCode, "permission_canary_failed");
  assert.equal(final.lastErrorReasonCode, "claude_bridge_version_required");
  assert.equal(final.providerVersion, "0.70.0");
  assert.equal(final.providerBundledAgentSdkVersion, "0.3.232");
  assert.equal(final.providerBundledClaudeCodeVersion, "2.1.232");
  assert.equal(final.providerMinimumRequiredVersion, "2.1.251");
  assert.deepEqual(await readListenerStatus(target), final);
});

test("lifetime control socket enforces one listener and supports status/stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  let current = statusFor(target, "ready");
  let stopped = 0;
  const first = await startListenerControlServer({
    paths: target,
    status: () => current,
    stop: () => {
      stopped += 1;
      current = { ...current, state: "stopping" };
    },
  });
  assert.deepEqual(await queryListenerControl(target, "status"), current);
  await assert.rejects(
    startListenerControlServer({
      paths: target,
      status: () => current,
      stop: () => undefined,
    }),
    (error: unknown) => error instanceof ListenerAlreadyRunningError,
  );
  const stopping = await queryListenerControl(target, "stop");
  assert.equal(stopping.state, "stopping");
  assert.equal(stopped, 1);
  if (process.platform !== "win32") {
    assert.equal((await stat(target.socketPath)).mode & 0o777, 0o600);
  }
  await first.close();
});

test("custom state directories isolate control sockets for one principal", async () => {
  const leftRoot = await mkdtemp(join(tmpdir(), "cswarm-control-left-"));
  const rightRoot = await mkdtemp(join(tmpdir(), "cswarm-control-right-"));
  const identity = {
    profileId: "profile-isolated-state",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
  };
  const leftPaths = listenerPaths({
    ...identity,
    stateDirectory: leftRoot,
  });
  const rightPaths = listenerPaths({
    ...identity,
    stateDirectory: rightRoot,
  });
  assert.notEqual(leftPaths.socketPath, rightPaths.socketPath);
  assert.equal(
    listenerPaths({ ...identity, stateDirectory: leftRoot }).socketPath,
    leftPaths.socketPath,
  );

  let leftStops = 0;
  let rightStops = 0;
  const leftStatus = {
    ...statusFor(leftPaths, "ready"),
    ...identity,
  };
  const rightStatus = {
    ...statusFor(rightPaths, "ready"),
    ...identity,
  };
  const left = await startListenerControlServer({
    paths: leftPaths,
    status: () => leftStatus,
    stop: () => {
      leftStops += 1;
    },
  });
  let right: Awaited<ReturnType<typeof startListenerControlServer>> | null = null;
  try {
    right = await startListenerControlServer({
      paths: rightPaths,
      status: () => rightStatus,
      stop: () => {
        rightStops += 1;
      },
    });
    assert.deepEqual(await queryListenerControl(leftPaths, "status"), leftStatus);
    assert.deepEqual(await queryListenerControl(rightPaths, "status"), rightStatus);
    await queryListenerControl(leftPaths, "stop");
    assert.equal(leftStops, 1);
    assert.equal(rightStops, 0);
  } finally {
    await right?.close();
    await left.close();
  }
});

test("control socket answers one bounded response to oversized input", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const current = statusFor(target, "ready");
  const control = await startListenerControlServer({
    paths: target,
    status: () => current,
    stop: () => undefined,
  });
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(target.socketPath);
      let response = "";
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        response += chunk;
      });
      socket.once("end", () => resolve(response));
      socket.once("connect", () => {
        socket.end(`${"x".repeat(9_000)}\n{"command":"status"}\n`);
      });
    });
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!), {
      ok: false,
      error: "request_too_large",
    });
  } finally {
    await control.close();
  }
});

test("supervisor becomes ready, stops through the socket, and logs metadata only", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const run = runListenerSupervisor({
    paths: target,
    profileId: "profile-supervisor",
    workspaceId,
    principalId,
    run: async (signal, onEvent) => {
      onEvent({
        type: "ready",
        workspaceId,
        principalId,
        ts: new Date().toISOString(),
      });
      onEvent({
        type: "effect",
        signalId: randomUUID(),
        status: "done",
        failureCode: null,
        ts: new Date().toISOString(),
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { reason: "cancelled" };
    },
  });
  // Mark handled immediately: if the supervisor fails while the test polls
  // waitForListenerReady, the run promise must not surface as an unhandled
  // rejection before the test reaches its own await of `run`.
  void run.catch(() => undefined);
  try {
    const ready = await waitForListenerReady(target, {
      timeoutMs: 5_000,
      pollMs: 10,
    });
    assert.equal(ready.state, "ready");
    const stopping = await stopListener(target);
    assert.equal(stopping?.state, "stopping");
    const final = await run;
    assert.equal(final.state, "stopped");
    assert.equal((await readListenerStatus(target))?.state, "stopped");
    const log = await readFile(target.logPath, "utf8");
    assert.match(log, /listener_ready/);
    assert.match(log, /listener_effect/);
    assert.match(log, /listener_stopped/);
    assert.doesNotMatch(log, /prompt|body|swm_agt_/i);
  } finally {
    // Never leak a live supervisor on mid-test failure: stop and settle the
    // run promise so the file cannot hang with an open lifetime socket.
    await stopListener(target).catch(() => undefined);
    await run.catch(() => undefined);
  }
});

test("activity publish failures persist as a local counter and stable last code", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-activity-status-test-"));
  const target = paths(root);
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const final = await runListenerSupervisor({
    paths: target,
    profileId: "profile-activity-status",
    workspaceId,
    principalId,
    run: async (_signal, onEvent) => {
      onEvent({
        type: "ready",
        workspaceId,
        principalId,
        ts: "2026-09-02T10:00:00.000Z",
      });
      onEvent({
        type: "activity_publish_failure",
        code: "activity_transport_failed",
        ts: "2026-09-02T10:00:01.000Z",
      });
      onEvent({
        type: "activity_publish_failure",
        code: "activity_http_rejected",
        ts: "2026-09-02T10:00:02.000Z",
      });
      return { reason: "cancelled" };
    },
  });

  assert.equal(final.activityPublishFailures, 2);
  assert.equal(final.activityLastErrorCode, "activity_http_rejected");
  const stored = await readListenerStatus(target);
  assert.equal(stored?.activityPublishFailures, 2);
  assert.equal(stored?.activityLastErrorCode, "activity_http_rejected");
  const json = listenerStatusJson(final);
  assert.equal(json.activityPublishFailures, 2);
  assert.equal(json.activityLastErrorCode, "activity_http_rejected");
});

test("missing socket converts a live-looking status to unclean_exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  await writeListenerStatus(target, statusFor(target, "ready"));
  const effective = await effectiveListenerStatus(target);
  assert.equal(effective?.state, "failed");
  assert.equal(effective?.lastErrorCode, "unclean_exit");
});

test("control socket handles peer RST and connection reset without crashing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const current = statusFor(target, "ready");
  const control = await startListenerControlServer({
    paths: target,
    status: () => current,
    stop: () => undefined,
  });
  try {
    for (let i = 0; i < 10; i += 1) {
      const client = createConnection(target.socketPath);
      client.once("connect", () => {
        client.write('{"command":"status"}\n');
        client.destroy();
      });
      await new Promise((r) => setTimeout(r, 10));
    }
    const res = await queryListenerControl(target, "status");
    assert.equal(res.state, "ready");
  } finally {
    await control.close();
  }
});

test("two starters race the startup lock: the winner selects the journal UUID and the loser's initialize never runs", { timeout: 15_000 }, async (t) => {
  const phase = (label: string) =>
    t.diagnostic(`[two-starter race] ${label}`);
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const identity = {
    profileId: "profile-race",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
  };
  const target = listenerPaths({ ...identity, stateDirectory: root });

  // Pre-seed a journal generation with a live (unacknowledged) claim, so the
  // winner must resume the old UUID instead of rotating to its proposed one.
  const resumedInstanceId = randomUUID();
  const seeded = await openListenerDeliveryJournal({
    ...identity,
    stateDirectory: root,
    proposedListenerInstanceId: resumedInstanceId,
  });
  assert.equal(seeded.listenerInstanceId, resumedInstanceId);
  await seeded.journal.reserveClaim();
  const journalPath = join(target.instanceDirectory, "delivery-journal.json");
  const seededBytes = await readFile(journalPath, "utf8");

  let enteredInitialize!: () => void;
  const initializeEntered = new Promise<void>((resolve) => {
    enteredInitialize = resolve;
  });
  let releaseInitialize!: () => void;
  const initializeGate = new Promise<void>((resolve) => {
    releaseInitialize = resolve;
  });
  const proposedWinnerId = randomUUID();
  let winnerSelectedId: string | null = null;
  const starters: {
    winner: Awaited<ReturnType<typeof startListenerControlServer>> | null;
    loser: Awaited<ReturnType<typeof startListenerControlServer>> | null;
  } = {
    winner: null,
    loser: null,
  };
  let loserSettled = false;
  let loserRejected = false;
  let loserInitializeCalls = 0;

  const winnerPromise = startListenerControlServer({
    paths: target,
    status: () => statusFor(target, "starting"),
    stop: () => undefined,
    initialize: async () => {
      const selected = await openListenerDeliveryJournal({
        ...identity,
        stateDirectory: root,
        proposedListenerInstanceId: proposedWinnerId,
      });
      winnerSelectedId = selected.listenerInstanceId;
      enteredInitialize();
      // Hold starting.lock while the loser attempts to start.
      await initializeGate;
    },
  });

  // Wait until the winner is inside initialize: it demonstrably holds
  // starting.lock and has passed the live-socket rejection check.
  await initializeEntered;
  phase("winner inside initialize, holding starting.lock");

  // Start and RETAIN the loser while the winner still holds the lock. The
  // loser is causally queued at starting.lock: it cannot initialize (or even
  // settle) until the winner releases the lock, so asserting zero initialize
  // calls now needs no arbitrary sleep as authority.
  const loserPromise = startListenerControlServer({
    paths: target,
    status: () => statusFor(target, "starting"),
    stop: () => undefined,
    initialize: async () => {
      loserInitializeCalls += 1;
    },
  }).then(
    (control) => {
      starters.loser = control;
      loserSettled = true;
      return control;
    },
    (error: unknown) => {
      loserSettled = true;
      loserRejected = true;
      throw error;
    },
  );
  // Mark handled immediately: the loser can reject while the test is still
  // awaiting the winner (the winner's listen → lock-release window), and an
  // unhandled rejection would fail the test before assert.rejects runs.
  void loserPromise.catch(() => undefined);

  try {
    assert.equal(
      loserSettled,
      false,
      "loser is still queued at starting.lock while the winner holds it",
    );
    assert.equal(loserInitializeCalls, 0, "loser never initialized while queued");

    // Release the gate: the winner binds/listens, then releases the lock.
    phase("releasing the winner initialize gate");
    releaseInitialize();
    const winnerControl = await winnerPromise;
    starters.winner = winnerControl;
    phase("winner reached listen and released starting.lock");

    // The loser must now fail as ListenerAlreadyRunningError — either by
    // acquiring the lock and discovering the live socket in prepareSocket, or
    // by exhausting the bounded lock wait. Both paths happen without ever
    // invoking initialize.
    await assert.rejects(
      loserPromise,
      (error: unknown) => error instanceof ListenerAlreadyRunningError,
    );
    assert.equal(loserSettled, true);
    assert.equal(loserRejected, true);
    assert.equal(loserInitializeCalls, 0, "loser never ran initialize");

    // The winner's socket still answers, and the winner resumed the old
    // journal UUID while the loser never rotated or rewrote the generation.
    const answered = await queryListenerControl(target, "status");
    assert.equal(answered.state, "starting");
    assert.equal(winnerSelectedId, resumedInstanceId);
    assert.notEqual(winnerSelectedId, proposedWinnerId);
    const raw = await readSecureJsonFile(journalPath, 8 * 1024);
    assert.equal(raw, seededBytes);
    const record = parseJournalRecord(
      raw!,
      identity.workspaceId,
      identity.principalId,
    );
    assert.equal(record.listenerInstanceId, resumedInstanceId);
    assert.equal(record.nextClaimOrdinal, 1);
    assert.equal(record.active?.phase, "claim_pending");
    phase("journal generation unchanged and winner socket live");
  } finally {
    // Settle and close every starter on success and failure: never leave the
    // winner gated on initialize, and never leak a live control server.
    releaseInitialize();
    await winnerPromise.catch(() => undefined);
    if (starters.winner) {
      await starters.winner.close().catch(() => undefined);
    }
    await loserPromise.catch(() => undefined);
    if (starters.loser) {
      await starters.loser.close().catch(() => undefined);
    }
    phase("all starters settled and closed");
  }
});

test("control initialize runs after live-socket rejection and before listen", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const occupied = paths(root);
  const first = await startListenerControlServer({
    paths: occupied,
    status: () => statusFor(occupied, "ready"),
    stop: () => undefined,
  });
  try {
    // A loser that discovers the live socket must never invoke initialize.
    // Moving initialize before prepareSocket turns this red.
    let loserInitializeCalls = 0;
    await assert.rejects(
      startListenerControlServer({
        paths: occupied,
        status: () => statusFor(occupied, "ready"),
        stop: () => undefined,
        initialize: async () => {
          loserInitializeCalls += 1;
        },
      }),
      (error: unknown) => error instanceof ListenerAlreadyRunningError,
    );
    assert.equal(loserInitializeCalls, 0);
  } finally {
    await first.close();
  }

  // A winner invokes initialize exactly once, while the socket is not yet
  // answering. Moving initialize after listen turns this red.
  const fresh = paths(root);
  let winnerInitializeCalls = 0;
  let socketStateDuringInitialize: string | null = null;
  const control = await startListenerControlServer({
    paths: fresh,
    status: () => statusFor(fresh, "ready"),
    stop: () => undefined,
    initialize: async () => {
      winnerInitializeCalls += 1;
      try {
        await queryListenerControl(fresh, "status", 200);
        socketStateDuringInitialize = "answered";
      } catch {
        socketStateDuringInitialize = "not_listening";
      }
    },
  });
  try {
    assert.equal(winnerInitializeCalls, 1);
    assert.equal(socketStateDuringInitialize, "not_listening");
    const answered = await queryListenerControl(fresh, "status");
    assert.equal(answered.state, "ready");
  } finally {
    await control.close();
  }
});

test("control initialize never runs on win32 when a live listener control socket exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const occupied = paths(root);
  const winner = await startListenerControlServer({
    paths: occupied,
    status: () => statusFor(occupied, "ready"),
    stop: () => undefined,
  });

  let loserInitializeCalls = 0;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", {
        ...platformDescriptor,
        value: "win32",
      });
    }
    await assert.rejects(
      startListenerControlServer({
        paths: occupied,
        status: () => statusFor(occupied, "ready"),
        stop: () => undefined,
        initialize: async () => {
          loserInitializeCalls += 1;
        },
      }),
      (error: unknown) => error instanceof ListenerAlreadyRunningError,
    );
    assert.equal(loserInitializeCalls, 0);
  } finally {
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
    await winner.close();
  }
});

test("supervisor carries one prepare-selected instance UUID through status, events, and run", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const selectedId = randomUUID();
  const proposedSeen: string[] = [];
  const runInstanceIds: string[] = [];
  const run = runListenerSupervisor({
    paths: target,
    profileId: "profile-supervisor",
    workspaceId,
    principalId,
    prepare: async (proposedInstanceId) => {
      proposedSeen.push(proposedInstanceId);
      return { instanceId: selectedId };
    },
    run: async (signal, onEvent, listenerInstanceId) => {
      runInstanceIds.push(listenerInstanceId);
      onEvent({
        type: "ready",
        workspaceId,
        principalId,
        ts: new Date().toISOString(),
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { reason: "cancelled" };
    },
  });
  // Mark handled immediately: if the supervisor fails while the test polls
  // waitForListenerReady, the run promise must not surface as an unhandled
  // rejection before the test reaches its own await of `run`.
  void run.catch(() => undefined);

  // Exactly one proposed UUID, observed by prepare.
  const ready = await waitForListenerReady(target, {
    timeoutMs: 5_000,
    pollMs: 10,
  });
  try {
    // The socket-visible status carries the selected UUID.
    assert.equal(ready.instanceId, selectedId);

    // Status writes are asynchronous and serialized behind the start-lock
    // release, so wait for the exact selected UUID to become durable instead
    // of racing the first write (bounded, causal).
    const persistedDeadline = Date.now() + 5_000;
    let persisted: ListenerStatus | null = null;
    while (Date.now() < persistedDeadline) {
      persisted = await readListenerStatus(target);
      if (persisted?.instanceId === selectedId) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(persisted, "persisted status appears with the selected UUID");
    assert.equal(persisted?.instanceId, selectedId);
    assert.equal(persisted?.deliveryMode, null);
    assert.equal(persisted?.pendingDeliveryCount, null);
    assert.equal(persisted?.lastTerminalDeliveryFailureCount, null);
    assert.equal(persisted?.lastTerminalDeliveryFailureAt, null);
    assert.equal(persisted?.lastClaimAt, null);
    assert.equal(persisted?.lastAckAt, null);

    await stopListener(target);
    const final = await run;
    assert.equal(final.state, "stopped");
    assert.equal(final.instanceId, selectedId);

    // The runtime callback received exactly the selected UUID as its third
    // argument. Generating a second runtime-only UUID turns this red.
    assert.deepEqual(runInstanceIds, [selectedId]);
    assert.equal(proposedSeen.length, 1);
    assert.match(proposedSeen[0]!, UUID_RE);
    assert.notEqual(proposedSeen[0], selectedId);

    // The starting event carries the selected UUID.
    const log = await readFile(target.logPath, "utf8");
    const startingLine = log
      .split("\n")
      .find((line) => line.includes("listener_starting"));
    assert.ok(startingLine, "listener_starting event is logged");
    assert.equal(JSON.parse(startingLine!).instance_id, selectedId);
  } finally {
    // Never leak a live supervisor on mid-test failure: stop and settle the
    // run promise so the file cannot hang with an open lifetime socket.
    await stopListener(target).catch(() => undefined);
    await run.catch(() => undefined);
  }
});

test("supervisor rejects a prepare-selected id that is not a UUID and releases the lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  let runCalls = 0;
  await assert.rejects(
    runListenerSupervisor({
      paths: target,
      profileId: "profile-supervisor",
      workspaceId: randomUUID(),
      principalId: randomUUID(),
      prepare: async () => ({ instanceId: "not-a-uuid" }),
      run: async () => {
        runCalls += 1;
        return { reason: "cancelled" };
      },
    }),
    /invalid instance id/,
  );
  assert.equal(runCalls, 0);
  await assert.rejects(stat(join(target.instanceDirectory, "starting.lock")));

  // The released lock allows one subsequent starter without a stale-lock wait.
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const run = runListenerSupervisor({
    paths: target,
    profileId: "profile-supervisor",
    workspaceId,
    principalId,
    run: async (signal, onEvent, listenerInstanceId) => {
      assert.match(listenerInstanceId, UUID_RE);
      onEvent({
        type: "ready",
        workspaceId,
        principalId,
        ts: new Date().toISOString(),
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { reason: "cancelled" };
    },
  });
  // Mark handled immediately: if the supervisor fails while the test polls
  // waitForListenerReady, the run promise must not surface as an unhandled
  // rejection before the test reaches its own await of `run`.
  void run.catch(() => undefined);
  try {
    const ready = await waitForListenerReady(target, {
      timeoutMs: 5_000,
      pollMs: 10,
    });
    assert.equal(ready.state, "ready");
    await stopListener(target);
    await run;
  } finally {
    // Never leak a live supervisor on mid-test failure: stop and settle the
    // run promise so the file cannot hang with an open lifetime socket.
    await stopListener(target).catch(() => undefined);
    await run.catch(() => undefined);
  }
});

test("prepare failure rejects cleanly, releases the startup lock, and allows one subsequent starter", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  let runCalls = 0;
  await assert.rejects(
    runListenerSupervisor({
      paths: target,
      profileId: "profile-supervisor",
      workspaceId: randomUUID(),
      principalId: randomUUID(),
      prepare: async () => {
        throw new Error("prepare_boom");
      },
      run: async () => {
        runCalls += 1;
        return { reason: "cancelled" };
      },
    }),
    /prepare_boom/,
  );
  // The runtime never started and no live server or lock survived.
  assert.equal(runCalls, 0);
  await assert.rejects(stat(join(target.instanceDirectory, "starting.lock")));
  await assert.rejects(queryListenerControl(target, "status", 200));

  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const run = runListenerSupervisor({
    paths: target,
    profileId: "profile-supervisor",
    workspaceId,
    principalId,
    run: async (signal, onEvent) => {
      onEvent({
        type: "ready",
        workspaceId,
        principalId,
        ts: new Date().toISOString(),
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { reason: "cancelled" };
    },
  });
  // Mark handled immediately: if the supervisor fails while the test polls
  // waitForListenerReady, the run promise must not surface as an unhandled
  // rejection before the test reaches its own await of `run`.
  void run.catch(() => undefined);
  try {
    const ready = await waitForListenerReady(target, {
      timeoutMs: 5_000,
      pollMs: 10,
    });
    assert.equal(ready.state, "ready");
    await stopListener(target);
    const final = await run;
    assert.equal(final.state, "stopped");
  } finally {
    // Never leak a live supervisor on mid-test failure: stop and settle the
    // run promise so the file cannot hang with an open lifetime socket.
    await stopListener(target).catch(() => undefined);
    await run.catch(() => undefined);
  }
});

test("old status without delivery fields reads as six nulls and is never rewritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const ts = "2026-07-30T00:00:00.000Z";
  // A version-1 status file exactly as the pre-delivery writer produced it.
  const oldStatus = {
    version: 1,
    instanceId: randomUUID(),
    provider: "grok",
    profileId: "profile-test",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    pid: process.pid,
    state: "ready",
    startedAt: ts,
    readyAt: ts,
    updatedAt: ts,
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    lastWorkerStderrTail: null,
    logPath: target.logPath,
  };
  await writeSecureJsonFile(target.statusPath, JSON.stringify(oldStatus));
  const beforeBytes = await readFile(target.statusPath, "utf8");

  const read = await readListenerStatus(target);
  assert.ok(read);
  assert.equal(read.deliveryMode, null);
  assert.equal(read.pendingDeliveryCount, null);
  assert.equal(read.lastTerminalDeliveryFailureCount, null);
  assert.equal(read.lastTerminalDeliveryFailureAt, null);
  assert.equal(read.lastClaimAt, null);
  assert.equal(read.lastAckAt, null);
  assert.equal(read.state, "ready");

  // Reading never rewrites the old file.
  const afterBytes = await readFile(target.statusPath, "utf8");
  assert.equal(afterBytes, beforeBytes);
});

test("new status with delivery metadata round-trips exactly and writes require all six fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const ts = "2026-07-31T12:00:00.000Z";
  const status: ListenerStatus = {
    ...statusFor(target, "ready"),
    deliveryMode: "durable_claim",
    pendingDeliveryCount: 3,
    lastTerminalDeliveryFailureCount: 1,
    lastTerminalDeliveryFailureAt: ts,
    lastClaimAt: ts,
    lastAckAt: ts,
  };
  await writeListenerStatus(target, status);
  assert.deepEqual(await readListenerStatus(target), status);
  const raw = JSON.parse(await readFile(target.statusPath, "utf8")) as Record<
    string,
    unknown
  >;
  for (const key of [
    "deliveryMode",
    "pendingDeliveryCount",
    "lastTerminalDeliveryFailureCount",
    "lastTerminalDeliveryFailureAt",
    "lastClaimAt",
    "lastAckAt",
  ]) {
    assert.ok(key in raw, `new status write contains ${key}`);
  }

  // A write that omits any delivery field fails closed.
  const incomplete = { ...statusFor(target, "ready") } as Record<
    string,
    unknown
  >;
  delete incomplete.lastAckAt;
  await assert.rejects(
    writeListenerStatus(target, incomplete as unknown as ListenerStatus),
    /missing delivery metadata/,
  );
});

test("status ignores unknown keys, renders old counters as unmeasured, and rejects malformed known keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const writeRaw = async (mutate: (row: Record<string, unknown>) => void) => {
    const row = { ...statusFor(target, "ready") } as Record<string, unknown>;
    mutate(row);
    await writeSecureJsonFile(target.statusPath, JSON.stringify(row));
  };

  // A newer writer can add fields without breaking this older reader. Unknown
  // values are not returned or rendered.
  await writeRaw((row) => {
    row.mysteryField = null;
    row.futureMetrics = { opened: 12 };
    row.readHealth = {
      currentEpisodeStartedAt: null,
      currentEpisodeAttempts: 0,
      currentReasonCode: null,
      currentHttpStatus: null,
      currentErrorConstructor: null,
      retryHours: [],
      retryMinutes: [{ minuteStart: "2026-07-30T00:00:00.000Z", retries: 1, future: true }],
      claimCadenceMs: null,
      claimHours: [],
      futureHealthMetric: 12,
    };
  });
  const forward = await readListenerStatus(target);
  assert.ok(forward);
  assert.equal("mysteryField" in forward, false);
  assert.equal("futureMetrics" in forward, false);
  assert.equal("futureHealthMetric" in forward.readHealth!, false);
  assert.equal("future" in forward.readHealth!.retryMinutes[0]!, false);
  const rendered = renderListenerStatus(forward);
  assert.match(rendered, /Connections opened: not measured\./);
  assert.match(rendered, /Connection reuse ratio: not measured\./);
  assert.doesNotMatch(rendered, /mysteryField|futureMetrics/);
  const json = listenerStatusJson(forward);
  assert.equal(json.connectionsOpened, null);
  assert.equal(json.connectionReuseRatio, null);
  assert.equal(json.activityPublishFailures, null);
  assert.equal(json.activityLastErrorCode, null);
  assert.equal("mysteryField" in json, false);
  assert.equal("futureMetrics" in json, false);

  // The write gate keeps its closed allow-list.
  await assert.rejects(
    writeListenerStatus(
      target,
      { ...statusFor(target, "ready"), mysteryField: null } as unknown as ListenerStatus,
    ),
    /malformed/,
  );

  // A malformed known field still fails closed.
  await writeRaw((row) => {
    row.connectionsOpened = -1;
  });
  await assert.rejects(readListenerStatus(target), /malformed/);
  await writeRaw((row) => {
    row.activityLastErrorCode = "provider prose changed";
  });
  await assert.rejects(readListenerStatus(target), /malformed/);

  // Sensitive aliases are rejected by name.
  for (const key of [
    "lease_id",
    "leaseId",
    "claim_command_id",
    "ack_command_id",
    "bearer",
    "token",
    "body",
    "prompt",
    "reply",
    "owner",
  ]) {
    await writeRaw((row) => {
      row[key] = "forbidden";
    });
    await assert.rejects(readListenerStatus(target), /forbidden/);
  }

  // Malformed delivery modes fail closed.
  for (const bad of ["bogus", "DURABLE_CLAIM", 42, true]) {
    await writeRaw((row) => {
      row.deliveryMode = bad;
    });
    await assert.rejects(readListenerStatus(target), /malformed/);
  }

  // Malformed counts fail closed.
  for (const bad of [-1, 1.5, "3", 2 ** 53]) {
    await writeRaw((row) => {
      row.pendingDeliveryCount = bad;
    });
    await assert.rejects(readListenerStatus(target), /malformed/);
    await writeRaw((row) => {
      row.lastTerminalDeliveryFailureCount = bad;
    });
    await assert.rejects(readListenerStatus(target), /malformed/);
  }

  // Malformed timestamps fail closed.
  for (const bad of ["not-a-date", "2026-13-99T99:99:99Z", 42, {}]) {
    await writeRaw((row) => {
      row.lastClaimAt = bad;
    });
    await assert.rejects(readListenerStatus(target), /malformed/);
    await writeRaw((row) => {
      row.lastAckAt = bad;
    });
    await assert.rejects(readListenerStatus(target), /malformed/);
    await writeRaw((row) => {
      row.lastTerminalDeliveryFailureAt = bad;
    });
    await assert.rejects(readListenerStatus(target), /malformed/);
  }

  // Valid explicit nulls and values still read.
  await writeRaw((row) => {
    row.deliveryMode = "cursor_fallback";
    row.pendingDeliveryCount = 0;
  });
  const valid = await readListenerStatus(target);
  assert.equal(valid?.deliveryMode, "cursor_fallback");
  assert.equal(valid?.pendingDeliveryCount, 0);
});

test("listener events accept the four new bounded delivery keys and reject sensitive fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const ts = "2026-07-31T12:00:00.000Z";

  // Positive controls: bounded delivery metadata is accepted.
  await appendListenerEvent(target, {
    ts,
    event: "delivery_mode",
    delivery_mode: "durable_claim",
    pending_delivery_count: 3,
    terminal_delivery_failure_count: 0,
  });
  await appendListenerEvent(target, {
    ts,
    event: "delivery_ack",
    signal_id: randomUUID(),
    outcome: "replied",
  });
  const log = await readFile(target.logPath, "utf8");
  assert.match(log, /delivery_mode/);
  assert.match(log, /"outcome":"replied"/);

  // Negative controls: capabilities, command IDs, credentials, and bodies.
  for (const key of [
    "lease_id",
    "claim_command_id",
    "ack_command_id",
    "bearer",
    "body",
    "prompt",
    "reply",
  ]) {
    await assert.rejects(
      appendListenerEvent(target, { ts, event: "x", [key]: "value" }),
      /field is not allowed/,
    );
  }

  // The new keys accept only bounded values.
  await assert.rejects(
    appendListenerEvent(target, { ts, event: "x", delivery_mode: "bogus" }),
    /delivery mode is not allowed/,
  );
  await assert.rejects(
    appendListenerEvent(target, { ts, event: "x", pending_delivery_count: -1 }),
    /delivery count is not allowed/,
  );
  await assert.rejects(
    appendListenerEvent(target, {
      ts,
      event: "x",
      terminal_delivery_failure_count: 1.5,
    }),
    /delivery count is not allowed/,
  );
  await assert.rejects(
    appendListenerEvent(target, { ts, event: "x", outcome: "weird" }),
    /outcome is not allowed/,
  );
});

test("the delivery journal module resolves from the listener index", () => {
  assert.equal(typeof openListenerDeliveryJournal, "function");
  assert.equal(typeof parseJournalRecord, "function");
  assert.equal(typeof claimCommandId, "function");
  assert.equal(typeof ackCommandId, "function");
});

// ---------------------------------------------------------------------------
// D-051 companion 2: bounded restart. Honouring retryable:false correctly
// turns a saturation failure into a terminated receiver, and nothing in this
// repo restarts one. Bounded is load-bearing — an unbounded restart would
// recreate the amplification D-051 removed, one process at a time.
// ---------------------------------------------------------------------------

function saturationStop(): ListenerRuntimeStop {
  // What a refused read now produces: a 500 the server told us not to retry.
  return {
    reason: "fatal",
    error: new SignalHttpError(500, null, {
      error: "internal_error",
      requestId: "11111111-2222-4333-8444-555555555555",
      retryable: false,
    }),
  };
}

async function readEvents(
  target: ListenerPaths,
): Promise<Array<Record<string, unknown>>> {
  const log = await readFile(target.logPath, "utf8");
  return log
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("D-051: a transient stop restarts a bounded number of times, then stays down and says why", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-restart-test-"));
  const target = paths(root);
  let runs = 0;
  const delays: number[] = [];
  const status = await runListenerSupervisor({
    paths: target,
    profileId: "profile-restart",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    restart: {
      maxAttempts: 3,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0,
    },
    run: async () => {
      runs += 1;
      return saturationStop();
    },
  });

  // 1 initial attempt + 3 restarts, then it stops trying.
  assert.equal(runs, 4);
  assert.equal(status.state, "failed");
  assert.equal(delays.length, 3);
  // Full jitter with random() === 0 is exactly half the exponential.
  assert.deepEqual(delays, [500, 1_000, 2_000]);

  const events = await readEvents(target);
  const restarting = events.filter((e) => e.event === "listener_restarting");
  assert.equal(restarting.length, 3);
  assert.deepEqual(restarting.map((e) => e.attempt), [1, 2, 3]);

  const failed = events.find((e) => e.event === "listener_failed");
  assert.ok(failed);
  assert.equal(failed.restarts_exhausted, true);
  assert.equal(failed.restart_attempts, 3);
  assert.equal(failed.restartable, true);
});

test("D-051: a cause that cannot clear stops permanently and is never restarted", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-restart-test-"));

  // A revoked credential must not loop: the supervisor must not retry it once.
  const credentialTarget = paths(root);
  let credentialRuns = 0;
  const credentialStatus = await runListenerSupervisor({
    paths: credentialTarget,
    profileId: "profile-restart",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    restart: { maxAttempts: 3, sleep: async () => {}, random: () => 0 },
    run: async () => {
      credentialRuns += 1;
      return {
        reason: "credential",
        error: new Error("agent secret is absent"),
      };
    },
  });
  assert.equal(credentialRuns, 1);
  assert.equal(credentialStatus.state, "failed");
  assert.equal(credentialStatus.lastErrorCode, "credential_stopped");

  // A 4xx refusal will refuse identically forever; restarting cannot help.
  const fatalTarget = paths(root);
  let fatalRuns = 0;
  await runListenerSupervisor({
    paths: fatalTarget,
    profileId: "profile-restart",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    restart: { maxAttempts: 3, sleep: async () => {}, random: () => 0 },
    run: async () => {
      fatalRuns += 1;
      return { reason: "fatal", error: new SignalHttpError(403) };
    },
  });
  assert.equal(fatalRuns, 1);

  const events = await readEvents(fatalTarget);
  assert.equal(events.some((e) => e.event === "listener_restarting"), false);
  const failed = events.find((e) => e.event === "listener_failed");
  assert.ok(failed);
  // Down because it was never eligible, NOT because it ran out of attempts.
  assert.equal(failed.restartable, false);
  assert.equal(failed.restarts_exhausted, false);
  assert.equal(failed.restart_attempts, 0);
});

test("D-051: a listener that recovers on a restart is not reported as failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-restart-test-"));
  const target = paths(root);
  let runs = 0;
  const status = await runListenerSupervisor({
    paths: target,
    profileId: "profile-restart",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    restart: { maxAttempts: 5, sleep: async () => {}, random: () => 0 },
    run: async () => {
      runs += 1;
      if (runs <= 2) return saturationStop();
      return { reason: "cancelled" };
    },
  });
  assert.equal(runs, 3);
  assert.equal(status.state, "stopped");
  assert.equal(status.lastErrorCode, null);
});

test("D-051: the restart classifier separates what can clear from what cannot", () => {
  // Transient: worth another bounded attempt.
  assert.equal(
    isRestartableListenerStop({ reason: "fatal", error: new SignalHttpError(500) }),
    true,
  );
  assert.equal(isRestartableListenerStop(saturationStop()), true);
  assert.equal(
    isRestartableListenerStop({
      reason: "fatal",
      error: new SignalTransportError(),
    }),
    true,
  );
  // D-057 changed this deliberately. An UNTYPED error acquires no decision,
  // however transient its wording sounds — classification is closed. The typed
  // form of a dead child, AcpChildExitError, does restart and is in the table.
  assert.equal(
    isRestartableListenerStop({
      reason: "fatal",
      error: new Error("listener model is closed"),
    }),
    false,
  );

  // Never: the operator's own stop, a credential that will refuse forever,
  // a 4xx that will refuse identically, and a protocol defect.
  assert.equal(isRestartableListenerStop({ reason: "cancelled" }), false);
  assert.equal(
    isRestartableListenerStop({
      reason: "credential",
      error: new Error("revoked"),
    }),
    false,
  );
  for (const status of [400, 401, 403, 404, 426]) {
    assert.equal(
      isRestartableListenerStop({
        reason: "fatal",
        error: new SignalHttpError(status),
      }),
      false,
      `HTTP ${status} must not restart`,
    );
  }
  assert.equal(
    isRestartableListenerStop({
      reason: "fatal",
      error: new SignalMalformedError("signal read returned a malformed row"),
    }),
    false,
  );
});

test("D-051: the restart delay is bounded by its own cap, not the read backoff cap", () => {
  assert.equal(nextListenerRestartMs(1, {}, () => 0), 500);
  assert.equal(nextListenerRestartMs(2, {}, () => 0), 1_000);
  // Saturates at the restart ceiling and never exceeds it.
  assert.equal(
    nextListenerRestartMs(12, {}, () => 1),
    LISTENER_RESTART_MAX_MS,
  );
  assert.ok(nextListenerRestartMs(12, {}, () => 0) <= LISTENER_RESTART_MAX_MS);
});

test("D-051: one rejected write does not poison the rest of the supervisor's writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-restart-test-"));
  const target = paths(root);
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const status = await runListenerSupervisor({
    paths: target,
    profileId: "profile-restart",
    workspaceId,
    principalId,
    run: async (_signal, onEvent) => {
      onEvent({
        type: "ready",
        workspaceId,
        principalId,
        ts: new Date().toISOString(),
      });
      // A malformed event is rejected by the append allowlist. It must cost
      // only itself: the terminal lines after it still have to land, because
      // they are the ones that say why the listener is down.
      onEvent({ type: "unknown_event_kind" } as unknown as ListenerRuntimeEvent);
      return { reason: "fatal", error: new SignalHttpError(403) };
    },
  });

  assert.equal(status.state, "failed");
  const events = await readEvents(target);
  // The write after the rejected one survived.
  assert.ok(
    events.some((e) => e.event === "listener_failed"),
    "the terminal listener_failed line must survive an earlier failed write",
  );
  // Positive control: the earlier lines are present too, so this is not a
  // vacuous pass from an empty or unwritten log.
  assert.ok(events.some((e) => e.event === "listener_ready"));
  assert.ok(events.some((e) => e.event === "listener_starting"));

  // And the status file itself kept being persisted through the failure.
  const persisted = await readListenerStatus(target);
  assert.equal(persisted?.state, "failed");
});

// ---------------------------------------------------------------------------
// D-057: CLOSED classification. The restart predicate used to exclude three
// signal-read types and return true for everything else, while the runtime also
// emits delivery errors and ACP startup failures — so a delivery 400, a 409
// conflict, a malformed 2xx and a version mismatch each bought up to five
// restarts of work that cannot succeed. The set that failed open was exactly
// the set the tests did not cover.
//
// This table drives every fatal error CLASS the runtime can reach a fatal stop
// with, plus representative codes. It is NOT every code — see the test name.
// It is also what stops the next error type silently acquiring a restart.
// ---------------------------------------------------------------------------

/** An error type nobody has classified yet — the D-058 adversary. */
class FutureRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FutureRuntimeError";
  }
}

const RESTART_MATRIX: ReadonlyArray<[string, Error, boolean]> = [
  // --- read path -----------------------------------------------------------
  ["read 500", new SignalHttpError(500), true],
  ["read 503", new SignalHttpError(503), true],
  ["read 429", new SignalHttpError(429), true],
  // A refused 500 still restarts: the veto governs an immediate retry of the
  // same request, not whether a later run may work.
  ["read 500 refused", new SignalHttpError(500, null, {
    error: "internal_error",
    requestId: "9d1f4b2c-0000-4000-8000-abcdefabcdef",
    retryable: false,
  }), true],
  ["read 400", new SignalHttpError(400), false],
  ["read 401", new SignalHttpError(401), false],
  ["read 403", new SignalHttpError(403), false],
  ["read 404", new SignalHttpError(404), false],
  ["read 426", new SignalHttpError(426), false],
  ["read timeout", new SignalReadTimeoutError(), true],
  ["read transport", new SignalTransportError(), true],
  ["read malformed", new SignalMalformedError("signal read returned a malformed row"), false],
  ["secret absent", new Error("agent credential secret is absent"), false],

  // --- delivery ------------------------------------------------------------
  ["delivery transport", new DeliveryTransportError("unreachable"), true],
  ["delivery 500", new DeliveryHttpError(500, "delivery_500", "delivery failed (HTTP 500)"), true],
  ["delivery 503", new DeliveryHttpError(503, "delivery_503", "delivery failed (HTTP 503)"), true],
  ["delivery 429", new DeliveryHttpError(429, "delivery_429", "delivery failed (HTTP 429)"), true],
  ["delivery 400", new DeliveryHttpError(400, "delivery_400", "delivery failed (HTTP 400)"), false],
  ["delivery 401", new DeliveryHttpError(401, "delivery_401", "delivery failed (HTTP 401)"), false],
  ["delivery 403", new DeliveryHttpError(403, "delivery_403", "delivery failed (HTTP 403)"), false],
  ["delivery 409 conflict", new DeliveryHttpError(409, "delivery_409", "delivery failed (HTTP 409)"), false],
  ["delivery protocol", new DeliveryProtocolError("delivery claim returned more than one row"), false],

  // --- command posts -------------------------------------------------------
  ["command transport", new CommandTransportError("unreachable"), true],
  ["command 500", new CommandHttpError(500), true],
  ["command 429", new CommandHttpError(429), true],
  ["command 400", new CommandHttpError(400), false],
  ["command 403", new CommandHttpError(403), false],

  // --- ACP host ------------------------------------------------------------
  ["acp timeout", new AcpTimeoutError("ACP request timed out"), true],
  ["acp child exit", new AcpChildExitError(1, null), true],
  ["acp transport", new AcpTransportError(new Error("EPIPE")), true],
  ["acp version refused", new AcpVersionError("version refused"), false],
  ["acp canary failed", new AcpPermissionCanaryError("canary failed"), false],
  ["acp protocol", new AcpProtocolError("bad frame", "malformed_frame"), false],
  ["acp rpc_error", new AcpProtocolError("provider refused", "rpc_error"), false],
  ["acp prompts blocked", new AcpPromptsBlockedError(), false],

  // --- runtime's own ------------------------------------------------------
  ["capability missing", new ListenerCapabilityError(
    "cursor_capability_missing",
    "the read service does not support lossless ascending inbox pages",
  ), false],
  ["claim did not settle", new Error("delivery claim did not settle"), false],
  ["lease deadline invalid", new Error("delivery lease deadline is invalid"), false],

  // --- credential horizons -------------------------------------------------
  ["renewal reauth", new RenewalReauthorisationRequired("horizon_reached", null, "sign in again"), false],
  ["renewal revoked", new RenewalRevoked("revoked", "the credential was revoked"), false],

  // --- AcpHostError constructed DIRECTLY (base class, not a subclass) -------
  // Every other ACP row is a subclass, but production constructs the base
  // class directly for these. Without a base-class row the table's claim was
  // unsupported for that whole shape.

  // Terminal for a distinct reason: the child may still be ALIVE, so
  // repeating the work is unsafe rather than merely futile.
  ["acp child_exit_timeout", new AcpHostError(
    "child_exit_timeout",
    "ACP child did not exit after SIGTERM and SIGKILL",
  ), false],

  // The missing-TYPE control: a generic base-class code with no subclass.
  ["acp executable_missing (generic base)", new AcpHostError(
    "executable_missing",
    "the configured executable was not found",
  ), false],

  // false, and this does NOT assert permanence. One code covers two distinct
  // SHAPES and discards the OS error: a child spawn failure raised inside
  // child.once("error") — possibly EAGAIN/EMFILE and transient — and missing
  // stdio after spawn() RETURNS, which establishes only that a ChildProcess
  // handle came back. Both shapes appear in every ACP host adapter; enumerate
  // with `git grep -n spawn_failed -- src/host` rather than trusting a file
  // list, which goes stale the next time a provider is added. The closed
  // default is correct UNTIL the producers preserve or split the cause; the
  // code is under-specified, not the verdict wrong.
  ["acp spawn_failed (mixed causes)", new AcpHostError(
    "spawn_failed",
    "child missing stdio pipes",
  ), false],

  // The pending open may already have spawned a LIVE child and the home is
  // retained, so restarting risks duplication rather than recovery.
  ["acp pending_open_timeout", new AcpHostError(
    "pending_open_timeout",
    "opencode open did not settle",
  ), false],

  // Caller/local lifecycle state, not a condition for retry: a later attempt
  // would countermand a local cancellation and may open a replacement.
  // NOT ESTABLISHED (Plumb ruled the retry verdict and left the taxonomy
  // unprobed — it scoped its ruling, it did not refuse the question):
  // because this is an AcpHostError and not an AbortError, isAbort() is false,
  // so the engine may record "failed" where "cancelled" or "received" would be
  // right. This row asserts the RETRY verdict only. Its greenness is not a
  // claim that the persistence taxonomy is correct.
  ["acp cancelled_during_open", new AcpHostError(
    "cancelled_during_open",
    "listener model cancelled during open",
  ), false],

  // --- AcpProtocolError codes (a SUBCLASS, not directly-constructed base) ---
  // These sit in their own section because the heading above is false for
  // them: production constructs AcpProtocolError, not AcpHostError. An
  // earlier version filed `busy` under the base-class heading with the wrong
  // concrete type, certifying a verdict for a construction that never happens.

  ["acp closed (AcpProtocolError)", new AcpProtocolError("transport closed", "closed"), false],

  // Emitted only when promptInFlight is already true (src/host/session.ts:451);
  // the runtime is sequential, so reaching it is an invariant breach and an
  // immediate retry has no coordination with the in-flight prompt.
  ["acp busy (AcpProtocolError)", new AcpProtocolError(
    "prompt already in flight (sequential only)",
    "busy",
  ), false],

  // --- unrecognised: must acquire NO decision ------------------------------
  ["plain TypeError", new TypeError("cannot read property of undefined"), false],
  ["plain Error", new Error("something nobody has classified"), false],

  // --- D-058: the ADVERSARIAL rows. The first version of this table used only
  // innocuous wording, so it proved the door was shut without trying the key
  // that fits. An unrecognised type spelled like one of ours must still get no
  // decision — classification is by identity, never by how an error reads.
  ["future type, innocuous", new FutureRuntimeError("some ordinary failure"), false],
  ["future type, retry words", new FutureRuntimeError("timeout transport connection"), false],
  ["future type spelled as transport", new FutureRuntimeError(
    "signal read could not reach the cloud service",
  ), false],
  ["future type spelled as HTTP 500", new FutureRuntimeError(
    "signal read failed (HTTP 500)",
  ), false],
  ["future type spelled as HTTP 503", new FutureRuntimeError(
    "signal read failed (HTTP 503)",
  ), false],
  ["future type spelled as HTTP 429", new FutureRuntimeError(
    "signal read failed (HTTP 429)",
  ), false],
  ["future type spelled as HTTP 400", new FutureRuntimeError(
    "signal read failed (HTTP 400)",
  ), false],
  ["future type spelled with envelope suffix", new FutureRuntimeError(
    "signal read failed (HTTP 500): internal_error, request_id 9d1f4b2c",
  ), false],
];

// NOTE the scope in the name. This table enumerates the typed error CLASSES the
// runtime can reach a fatal stop with, plus representative directly-constructed
// AcpHostError codes. It is NOT every code: `new AcpHostError(<code>, …)` is
// used with 30+ ad-hoc codes across src/host, and those reach `false` through
// the closed default rather than through a row here. That is safe but it is not
// enumeration, and an earlier version of this name claimed it was.
test("D-057: every fatal error CLASS, and representative codes, has an explicit restart verdict", () => {
  const wrong: string[] = [];
  for (const [name, error, expected] of RESTART_MATRIX) {
    const actual = isRestartableListenerStop({ reason: "fatal", error });
    if (actual !== expected) {
      wrong.push(`${name}: expected ${expected}, got ${actual}`);
    }
  }
  assert.deepEqual(wrong, []);

  // The table must contain both verdicts, or it could pass by being uniform.
  const restartable = RESTART_MATRIX.filter(([, , expected]) => expected);
  const terminal = RESTART_MATRIX.filter(([, , expected]) => !expected);
  assert.ok(restartable.length >= 10, "table must exercise the restartable arm");
  assert.ok(terminal.length >= 20, "table must exercise the terminal arm");
});

test("D-057: classification is closed — an unrecognised failure never restarts", () => {
  // The defect was default-TRUE, so this is the property that failed. Anything
  // the classifier does not recognise must decline, not acquire a restart.
  assert.equal(
    isRestartableListenerStop({
      reason: "fatal",
      error: new FutureRuntimeError("an error type added after this test"),
    }),
    false,
  );
  assert.equal(
    isRestartableListenerStop({ reason: "fatal", error: new Error("") }),
    false,
  );

  // Positive control on the same call: the classifier is not simply saying no.
  assert.equal(
    isRestartableListenerStop({ reason: "fatal", error: new SignalHttpError(500) }),
    true,
  );
});

test("D-057: a non-restartable delivery failure is not restarted by the supervisor", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-restart-test-"));
  const target = paths(root);
  let runs = 0;
  const status = await runListenerSupervisor({
    paths: target,
    profileId: "profile-restart",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    restart: { maxAttempts: 3, sleep: async () => {}, random: () => 0 },
    run: async () => {
      runs += 1;
      // Before D-057 this restarted 3 times, repeating a delivery command that
      // the server had already rejected as invalid.
      return { reason: "fatal", error: new DeliveryHttpError(400, "delivery_400", "delivery failed (HTTP 400)") };
    },
  });
  assert.equal(runs, 1);
  assert.equal(status.state, "failed");
  const events = await readEvents(target);
  assert.equal(events.some((e) => e.event === "listener_restarting"), false);
  const failed = events.find((e) => e.event === "listener_failed");
  assert.equal(failed?.restartable, false);
  assert.equal(failed?.restart_attempts, 0);
});

/* D-090 family: a crash-looping worker whose every failure event read a bare
 * "error" was undiagnosable from the failing box's own log, because all four
 * hosts drained stderr. The tail is LOCAL-ONLY — these tests pin the two
 * schema gates and the supervisor's consumption of it. */

test("appendListenerEvent: worker_stderr_tail is exempt from the 128-char cap but keeps its own bound and the secret scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const ts = "2026-08-19T00:00:00.000Z";
  const longTail = "x".repeat(300);
  await appendListenerEvent(target, {
    ts,
    event: "listener_failed",
    failure_code: "error",
    worker_stderr_tail: longTail,
  });
  const log = await readFile(target.logPath, "utf8");
  assert.match(log, /worker_stderr_tail/);
  // CONTROL: the same 300 characters in any OTHER string field must still be
  // rejected — the exemption is for the tail alone, not a general loosening.
  await assert.rejects(
    appendListenerEvent(target, { ts, event: "listener_failed", failure_code: longTail }),
    /unsafe text/,
  );
  await assert.rejects(
    appendListenerEvent(target, {
      ts,
      event: "listener_failed",
      worker_stderr_tail: "y".repeat(2_049),
    }),
    /stderr tail is not allowed/,
  );
  await assert.rejects(
    appendListenerEvent(target, {
      ts,
      event: "listener_failed",
      worker_stderr_tail: "",
    }),
    /stderr tail is not allowed/,
  );
  // The secret scan still applies to the tail itself.
  await assert.rejects(
    appendListenerEvent(target, {
      ts,
      event: "listener_failed",
      worker_stderr_tail: "leaked swm_agt_abc123",
    }),
    /unsafe text/,
  );
});

test("appendListenerEvent: turn_budget_ms must be a positive safe integer", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const ts = "2026-08-19T00:00:00.000Z";
  await appendListenerEvent(target, {
    ts,
    event: "listener_effect",
    failure_code: "acptimeouterror",
    turn_budget_ms: 600_000,
  });
  assert.match(await readFile(target.logPath, "utf8"), /"turn_budget_ms":600000/);
  for (const bad of [0, -5, 1.5, "600000", null] as const) {
    await assert.rejects(
      appendListenerEvent(target, { ts, event: "listener_effect", turn_budget_ms: bad }),
      /turn budget is not allowed/,
    );
  }
});

test("status lastWorkerStderrTail: round-trips, absent key normalizes to null, secrets are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const base = statusFor(target, "failed");
  await writeListenerStatus(target, {
    ...base,
    lastWorkerStderrTail: "boom: provider crashed\nsecond line",
  });
  assert.equal(
    (await readListenerStatus(target))?.lastWorkerStderrTail,
    "boom: provider crashed\nsecond line",
  );
  // An old status file without the key reads back as null, without a rewrite.
  const raw = JSON.parse(
    await readFile(target.statusPath, "utf8"),
  ) as { lastWorkerStderrTail?: unknown };
  delete raw.lastWorkerStderrTail;
  await writeSecureJsonFile(target.statusPath, JSON.stringify(raw));
  assert.equal((await readListenerStatus(target))?.lastWorkerStderrTail, null);
  // A credential-shaped tail is rejected by name, never displayed.
  raw.lastWorkerStderrTail = "token swm_agt_abc";
  await writeSecureJsonFile(target.statusPath, JSON.stringify(raw));
  await assert.rejects(readListenerStatus(target), /malformed/);
});

test("status lastErrorDetail: round-trips and old files without it normalize to null", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const base = statusFor(target, "failed");
  await writeListenerStatus(target, {
    ...base,
    lastErrorDetail:
      "canary incomplete: permission=false deniedTool=false (failed 2 attempts)",
  });
  assert.equal(
    (await readListenerStatus(target))?.lastErrorDetail,
    "canary incomplete: permission=false deniedTool=false (failed 2 attempts)",
  );

  const raw = JSON.parse(
    await readFile(target.statusPath, "utf8"),
  ) as { lastErrorDetail?: unknown };
  delete raw.lastErrorDetail;
  await writeSecureJsonFile(target.statusPath, JSON.stringify(raw));
  assert.equal((await readListenerStatus(target))?.lastErrorDetail, null);

  raw.lastErrorDetail = "token swm_agt_abc";
  await writeSecureJsonFile(target.statusPath, JSON.stringify(raw));
  await assert.rejects(readListenerStatus(target), /malformed/);
});

test("a failing worker's stderr tail reaches the terminal failure event and status", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  let tailSlot: string | null = "fatal: provider crashed\nlast line names the cause";
  const final = await runListenerSupervisor({
    paths: target,
    profileId: "profile-tail",
    workspaceId,
    principalId,
    restart: { maxAttempts: 0 },
    takeWorkerStderrTail: () => {
      const tail = tailSlot;
      tailSlot = null;
      return tail;
    },
    run: async () => ({
      reason: "fatal",
      error: new AcpChildExitError(1, null),
    }),
  });
  assert.equal(final.state, "failed");
  assert.equal(
    final.lastWorkerStderrTail,
    "fatal: provider crashed\nlast line names the cause",
  );
  const log = await readFile(target.logPath, "utf8");
  const failed = log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; worker_stderr_tail?: string })
    .find((event) => event.event === "listener_failed");
  assert.ok(failed, "listener_failed line missing");
  assert.equal(
    failed.worker_stderr_tail,
    "fatal: provider crashed\nlast line names the cause",
  );
});

test("a restart carries the dead worker's tail; reaching ready clears it; a healthy stop writes NO tail field", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  let attempts = 0;
  let tailSlot: string | null = "restart-me: first worker died";
  const run = runListenerSupervisor({
    paths: target,
    profileId: "profile-tail-restart",
    workspaceId,
    principalId,
    restart: { maxAttempts: 2, initialMs: 1, maxMs: 2 },
    // The CLAMPED budget actually in force for the last turn (5m), which is
    // deliberately NOT the 10m configured default — the event must carry this,
    // not the cap.
    getTurnBudgetMs: () => 300_000,
    takeWorkerStderrTail: () => {
      const tail = tailSlot;
      tailSlot = null;
      return tail;
    },
    run: async (signal, onEvent) => {
      attempts += 1;
      if (attempts === 1) {
        return { reason: "fatal", error: new AcpChildExitError(1, null) };
      }
      onEvent({
        type: "ready",
        workspaceId,
        principalId,
        ts: new Date().toISOString(),
      });
      onEvent({
        type: "effect",
        signalId: randomUUID(),
        status: "retry_pending",
        failureCode: "acptimeouterror",
        ts: new Date().toISOString(),
      });
      onEvent({
        type: "effect",
        signalId: randomUUID(),
        status: "failed",
        failureCode: "error",
        ts: new Date().toISOString(),
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { reason: "cancelled" };
    },
  });
  void run.catch(() => undefined);
  try {
    const ready = await waitForListenerReady(target, { timeoutMs: 5_000, pollMs: 10 });
    assert.equal(ready.state, "ready");
    // Reaching ready cleared the tail from status.
    assert.equal(ready.lastWorkerStderrTail, null);
    await stopListener(target);
    const final = await run;
    assert.equal(final.state, "stopped");
    // A healthy stop must not resurrect a tail.
    assert.equal(final.lastWorkerStderrTail, null);
    const events = (await readFile(target.logPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        JSON.parse(line) as {
          event: string;
          failure_code?: string;
          worker_stderr_tail?: string;
          turn_budget_ms?: number;
        }
      );
    const restarting = events.find((event) => event.event === "listener_restarting");
    assert.ok(restarting, "listener_restarting line missing");
    assert.equal(restarting.worker_stderr_tail, "restart-me: first worker died");
    const stopped = events.find((event) => event.event === "listener_stopped");
    assert.ok(stopped, "listener_stopped line missing");
    // CONTROL: the field is absent on a healthy stop, not null or empty.
    assert.equal("worker_stderr_tail" in stopped, false);
    // The budget rides only the timeout class.
    const timeoutEffect = events.find((event) => event.failure_code === "acptimeouterror");
    assert.ok(timeoutEffect, "timeout effect line missing");
    // The clamped budget in force, not the configured cap.
    assert.equal(timeoutEffect.turn_budget_ms, 300_000);
    const otherEffect = events.find((event) => event.failure_code === "error");
    assert.ok(otherEffect, "non-timeout effect line missing");
    assert.equal("turn_budget_ms" in otherEffect, false);
  } finally {
    await stopListener(target).catch(() => undefined);
    await run.catch(() => undefined);
  }
});

test("an oversized tail is fitted from the front so the event line stays under its byte cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const hugeTail = `HEAD-${"z".repeat(2_040)}-TAIL`;
  const final = await runListenerSupervisor({
    paths: target,
    profileId: "profile-tail-fit",
    workspaceId,
    principalId,
    restart: { maxAttempts: 0 },
    takeWorkerStderrTail: () => hugeTail,
    run: async () => ({
      reason: "fatal",
      error: new AcpChildExitError(1, null),
    }),
  });
  assert.equal(final.state, "failed");
  const tail = final.lastWorkerStderrTail;
  assert.ok(tail, "fitted tail missing from status");
  assert.ok(tail.endsWith("-TAIL"), "the END of the tail must survive fitting");
  assert.doesNotMatch(tail, /HEAD-/);
  assert.ok(tail.length <= 2_048);
  // And the events.ndjson write actually landed (it would throw over the cap,
  // and the swallowed throw would silently drop this exact line — the scar).
  assert.match(await readFile(target.logPath, "utf8"), /listener_failed/);
});

test("a tail that expands under JSON escaping is fitted by SERIALIZED size, and the failure line survives", async () => {
  /* A raw-byte budget passes 2000 backslashes, but each serializes to two
   * bytes — the line blows the 4096 cap, appendListenerEvent throws, the
   * write chain swallows it, and the failure line is silently dropped: the
   * supervisor.ts scar, reintroduced by the fit itself. */
  for (const [label, raw] of [
    ["backslashes", "\\".repeat(2_000)],
    ["quotes", '"'.repeat(2_000)],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
    const target = paths(root);
    const final = await runListenerSupervisor({
      paths: target,
      profileId: "profile-tail-escape",
      workspaceId: randomUUID(),
      principalId: randomUUID(),
      restart: { maxAttempts: 0 },
      takeWorkerStderrTail: () => raw,
      run: async () => ({
        reason: "fatal",
        error: new AcpChildExitError(1, null),
      }),
    });
    assert.equal(final.state, "failed", label);
    const lines = (await readFile(target.logPath, "utf8"))
      .split("\n")
      .filter(Boolean);
    const failedLine = lines.find((line) => line.includes("listener_failed"));
    assert.ok(failedLine, `${label}: the failure line was dropped`);
    assert.ok(
      Buffer.byteLength(`${failedLine}\n`, "utf8") <= 4_096,
      `${label}: serialized line exceeds the cap`,
    );
    const failed = JSON.parse(failedLine) as { worker_stderr_tail?: string };
    assert.ok(
      (failed.worker_stderr_tail ?? "").length > 0,
      `${label}: the tail itself was lost in fitting`,
    );
  }
});

test("a second worker's failure never inherits the first worker's tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  let tailSlot: string | null = "worker-one: died with this stderr";
  const final = await runListenerSupervisor({
    paths: target,
    profileId: "profile-tail-inherit",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    restart: { maxAttempts: 1, initialMs: 1, maxMs: 2 },
    takeWorkerStderrTail: () => {
      const tail = tailSlot;
      tailSlot = null;
      return tail;
    },
    // Both attempts fail; only the FIRST worker wrote stderr.
    run: async () => ({
      reason: "fatal",
      error: new AcpChildExitError(1, null),
    }),
  });
  assert.equal(final.state, "failed");
  // CONTROL: the terminal failure belongs to worker two, which wrote nothing.
  assert.equal(final.lastWorkerStderrTail, null);
  const events = (await readFile(target.logPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      JSON.parse(line) as { event: string; worker_stderr_tail?: string }
    );
  const restarting = events.find((event) => event.event === "listener_restarting");
  assert.ok(restarting, "listener_restarting line missing");
  assert.equal(restarting.worker_stderr_tail, "worker-one: died with this stderr");
  const failed = events.find((event) => event.event === "listener_failed");
  assert.ok(failed, "listener_failed line missing");
  assert.equal(
    "worker_stderr_tail" in failed,
    false,
    "worker two's failure inherited worker one's tail",
  );
});

test("read retry episodes persist, recover once, and log typed totals", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-read-health-"));
  const target = paths(root);
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const startedAt = "2026-09-01T12:00:00.000Z";
  const secondAt = "2026-09-01T12:00:30.000Z";
  const recoveredAt = "2026-09-01T12:01:05.000Z";
  const status = await runListenerSupervisor({
    paths: target,
    profileId: "profile-read-health",
    workspaceId,
    principalId,
    run: async (_signal, onEvent) => {
      onEvent({
        type: "ready",
        workspaceId,
        principalId,
        cadenceMs: 3_500,
        ts: "2026-09-01T11:00:00.000Z",
      });
      onEvent({
        type: "read_retry",
        attempt: 1,
        episodeAttempt: 1,
        episodeStartedAt: startedAt,
        failure: {
          code: "http_status",
          httpStatus: 503,
          errorConstructor: null,
        },
        delayMs: 20_000,
        ts: startedAt,
      });
      onEvent({
        type: "read_retry",
        attempt: 2,
        episodeAttempt: 2,
        episodeStartedAt: startedAt,
        failure: {
          code: "no_response",
          httpStatus: null,
          errorConstructor: null,
        },
        delayMs: 30_000,
        ts: secondAt,
      });
      onEvent({
        type: "read_recovered",
        attempts: 2,
        durationMs: 65_000,
        startedAt,
        ts: recoveredAt,
      });
      return { reason: "cancelled" };
    },
  });
  assert.ok(status.readHealth);
  assert.equal(status.readHealth.currentEpisodeStartedAt, null);
  assert.equal(status.readHealth.currentEpisodeAttempts, 0);
  assert.equal(status.readHealth.claimCadenceMs, 3_500);
  assert.equal(status.readHealth.retryHours.length, 1);
  assert.deepEqual(status.readHealth.retryHours[0], {
    hourStart: "2026-09-01T12:00:00.000Z",
    retries: 2,
    episodes: 1,
    longestEpisodeAttempts: 2,
    longestEpisodeDurationMs: 65_000,
  });

  const events = (await readFile(target.logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const retries = events.filter((event) => event.event === "listener_read_retry");
  assert.equal(retries.length, 2);
  assert.equal(retries[0]!.reason_code, "http_status");
  assert.equal(retries[0]!.http_status, 503);
  assert.equal(retries[1]!.reason_code, "no_response");
  const recovered = events.filter(
    (event) => event.event === "listener_read_recovered",
  );
  assert.equal(recovered.length, 1, "one episode emits one recovery line");
  assert.equal(recovered[0]!.attempts, 2);
  assert.equal(recovered[0]!.duration_ms, 65_000);
});
