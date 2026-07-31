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
  appendListenerEvent,
  effectiveListenerStatus,
  listenerPaths,
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
});

test("missing socket converts a live-looking status to unclean_exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
  const target = paths(root);
  await writeListenerStatus(target, statusFor(target, "ready"));
  const effective = await effectiveListenerStatus(target);
  assert.equal(effective?.state, "failed");
  assert.equal(effective?.lastErrorCode, "unclean_exit");
});
