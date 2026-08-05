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
  ackCommandId,
  appendListenerEvent,
  claimCommandId,
  effectiveListenerStatus,
  listenerPaths,
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
  type ListenerStatus,
} from "../src/listener/index.js";
import {
  readSecureJsonFile,
  writeSecureJsonFile,
} from "../src/cloud/storage.js";

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
    deliveryMode: null,
    pendingDeliveryCount: null,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
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

test("Claude is a durable listener status provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const status = { ...statusFor(target, "ready"), provider: "claude" as const };
  await writeListenerStatus(target, status);
  assert.deepEqual(await readListenerStatus(target), status);
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

test("status rejects unknown keys, sensitive aliases, and malformed delivery values", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  const writeRaw = async (mutate: (row: Record<string, unknown>) => void) => {
    const row = { ...statusFor(target, "ready") } as Record<string, unknown>;
    mutate(row);
    await writeSecureJsonFile(target.statusPath, JSON.stringify(row));
  };

  // Unknown top-level keys fail closed rather than being returned.
  await writeRaw((row) => {
    row.mysteryField = null;
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
