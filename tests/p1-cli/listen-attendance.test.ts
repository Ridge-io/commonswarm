/** Attendance coverage. This file is reached by `npm run test:p1-cli`. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import type { DeliveryOutcome } from "../../src/cloud/delivery.js";
import {
  appendListenerEvent,
  FileHookSurfaceStore,
  FilePendingMainQueue,
  listenerPaths,
  renderListenerAttendanceCanary,
  runListenerAttendanceCanary,
  startListenerControlServer,
  writeListenerStatus,
  type ListenerPaths,
  type ListenerStatus,
} from "../../src/listener/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(repoRoot, "src", "cli.ts");
const tsxImport = import.meta.resolve("tsx");
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const SIGNAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
const TARGET = cloudTarget("https://cloud.example.test", "anon");

function artifact(): string {
  return JSON.stringify({
    message: "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.",
    status: "accepted",
    principal_id: PRINCIPAL_ID,
    token_id: "33333333-3333-4333-8333-333333333333",
    run_id: "44444444-4444-4444-8444-444444444444",
    agent_token: TOKEN,
    expires_at: "2030-01-01T00:00:00.000Z",
  });
}

function runCli(
  args: string[],
  options: { cwd: string; home: string; input?: string },
) {
  return spawnSync(process.execPath, ["--import", tsxImport, cliPath, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: options.home,
      CLAUDE_CONFIG_DIR: join(options.home, ".claude"),
      XDG_CONFIG_HOME: join(options.home, ".config"),
      NODE_OPTIONS: "--max-old-space-size=4096",
    },
    input: options.input ?? "",
    timeout: 6_000,
  });
}

async function runCliAsync(
  args: string[],
  options: { cwd: string; home: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", tsxImport, cliPath, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      HOME: options.home,
      CLAUDE_CONFIG_DIR: join(options.home, ".claude"),
      XDG_CONFIG_HOME: join(options.home, ".config"),
      NODE_OPTIONS: "--max-old-space-size=4096",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr };
}

function paths(root: string): ListenerPaths {
  return listenerPaths({
    profileId: TARGET.profileId,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory: root,
  });
}

async function statusFixture(
  listenerPathsValue: ListenerPaths,
  options: {
    state: "ready" | "stopped";
    pending: number;
    lastAckAt?: string | null;
    lastAckOutcome?: DeliveryOutcome | null;
    consecutiveAckFailureCount?: number | null;
    lastErrorCode?: string | null;
    routeMode?: "worker" | "main" | "split";
  },
): Promise<ListenerStatus> {
  const status: ListenerStatus = {
    version: 1,
    instanceId: "55555555-5555-4555-8555-555555555555",
    provider: "claude",
    profileId: TARGET.profileId,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    pid: options.state === "ready" ? process.pid : 2_147_483_647,
    state: options.state,
    startedAt: "2026-09-01T12:00:00.000Z",
    readyAt: "2026-09-01T12:00:01.000Z",
    updatedAt: "2026-09-01T12:00:02.000Z",
    stoppedAt: options.state === "stopped" ? "2026-09-01T12:00:02.000Z" : null,
    lastSignalId: SIGNAL_ID,
    lastErrorCode: options.lastErrorCode ?? null,
    lastErrorDetail: null,
    lastWorkerStderrTail: null,
    deliveryMode: "durable_claim",
    pendingDeliveryCount: 0,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: "2026-09-01T12:00:02.000Z",
    lastAckAt: options.lastAckAt ?? null,
    lastAckOutcome: options.lastAckOutcome ?? null,
    consecutiveAckFailureCount:
      options.consecutiveAckFailureCount ?? null,
    routeMode: options.routeMode ?? "main",
    deferOverChars: null,
    pendingForMainCount: options.pending,
    droppedForMainCount: 0,
    logPath: listenerPathsValue.logPath,
  };
  await writeListenerStatus(listenerPathsValue, status);
  return status;
}

async function queueOne(listenerPathsValue: ListenerPaths): Promise<void> {
  await new FilePendingMainQueue(listenerPathsValue.instanceDirectory).enqueue({
    signalId: SIGNAL_ID,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    fromId: "66666666-6666-4666-8666-666666666666",
    fromKind: "agent",
    kind: "note",
    senderName: "Wren",
    body: "Can you see this?",
    createdAt: "2026-09-01T12:00:00.000Z",
    queuedAt: "2026-09-01T12:00:03.000Z",
    observationPending: true,
  });
}

function statusArgs(root: string): string[] {
  return [
    "listen",
    "status",
    "--url",
    TARGET.url,
    "--anon-key",
    TARGET.anonKey,
    "--workspace-id",
    WORKSPACE_ID,
    "--principal-id",
    PRINCIPAL_ID,
    "--state-dir",
    root,
  ];
}

test("listen status separates connected, attended, and handled across the fixture matrix", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-attendance-status-"));
  const home = await mkdtemp(join(tmpdir(), "cswarm-attendance-home-"));
  let activeControl: { close(): Promise<void> } | null = null;
  try {
    const readyEmptyRoot = join(root, "ready-empty");
    const readyEmptyPaths = paths(readyEmptyRoot);
    const readyEmptyStatus = await statusFixture(readyEmptyPaths, {
      state: "ready",
      pending: 0,
      lastAckAt: "2026-09-01T12:00:04.000Z",
    });
    await new FileHookSurfaceStore(readyEmptyPaths.instanceDirectory).commit({
      signalIds: [SIGNAL_ID],
    });
    const readyEmptyControl = await startListenerControlServer({
      paths: readyEmptyPaths,
      status: () => readyEmptyStatus,
      stop: () => {},
    });
    const readyEmpty = await runCliAsync(statusArgs(readyEmptyRoot), { cwd: root, home });
    assert.equal(readyEmpty.status, 0, readyEmpty.stderr);
    assert.match(readyEmpty.stdout, /CONNECTED: yes/);
    assert.match(readyEmpty.stdout, /ATTENDED: yes/);
    assert.match(readyEmpty.stdout, /HANDLED: not yet measured/);
    assert.doesNotMatch(readyEmpty.stdout, /listener_unattended_main_queue/);
    await readyEmptyControl.close();

    const readyQueuedRoot = join(root, "ready-queued");
    const readyQueuedPaths = paths(readyQueuedRoot);
    const readyQueuedStatus = await statusFixture(
      readyQueuedPaths,
      { state: "ready", pending: 1 },
    );
    await queueOne(readyQueuedPaths);
    activeControl = await startListenerControlServer({
      paths: readyQueuedPaths,
      status: () => readyQueuedStatus,
      stop: () => {},
    });
    const readyQueued = await runCliAsync(statusArgs(readyQueuedRoot), { cwd: root, home });
    assert.equal(readyQueued.status, 0, readyQueued.stderr);
    assert.match(readyQueued.stdout, /Listener WARNING/);
    assert.match(readyQueued.stdout, /CONNECTED: yes/);
    assert.match(readyQueued.stdout, /ATTENDED: no/);
    assert.match(readyQueued.stdout, /HANDLED: no/);
    assert.match(readyQueued.stdout, /WARNING \[listener_unattended_main_queue\]/);
    assert.match(readyQueued.stdout, /queued at 2026-09-01T12:00:03\.000Z/);
    assert.match(
      readyQueued.stdout,
      new RegExp(`cswarm hook install claude --principal-id ${PRINCIPAL_ID} --write`),
    );
    assert.match(readyQueued.stdout, /then start a fresh session/);
    assert.match(readyQueued.stdout, /--route worker/);

    const json = await runCliAsync([...statusArgs(readyQueuedRoot), "--json"], {
      cwd: root,
      home,
    });
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
    assert.equal(parsed.connected, true);
    assert.equal(parsed.attended, false);
    assert.equal(parsed.attendanceState, "unattended");
    assert.equal(parsed.handled, false);
    assert.equal(parsed.handledState, "not_handled");
    assert.equal(parsed.pendingForMainOldestAt, "2026-09-01T12:00:03.000Z");
    assert.equal(parsed.attendanceWarningCode, "listener_unattended_main_queue");
    assert.match(String(parsed.attendanceNextStep), /hook install claude/);
    await activeControl.close();
    activeControl = null;

    const deadQueuedRoot = join(root, "dead-queued");
    const deadQueuedPaths = paths(deadQueuedRoot);
    await statusFixture(deadQueuedPaths, { state: "stopped", pending: 1 });
    await queueOne(deadQueuedPaths);
    const deadQueued = await runCliAsync(statusArgs(deadQueuedRoot), { cwd: root, home });
    assert.equal(deadQueued.status, 0, deadQueued.stderr);
    assert.match(deadQueued.stdout, /CONNECTED: no/);
    assert.match(deadQueued.stdout, /ATTENDED: no/);
    assert.match(deadQueued.stdout, /message is also stranded because this listener is not running/);
  } finally {
    if (activeControl !== null) await activeControl.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("worker status shows terminal delivery failure runs and clears them after an answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-worker-delivery-status-"));
  const home = await mkdtemp(join(tmpdir(), "cswarm-worker-delivery-home-"));
  let activeControl: { close(): Promise<void> } | null = null;
  try {
    const failedRoot = join(root, "failed");
    const failedPaths = paths(failedRoot);
    const failedStatus = await statusFixture(failedPaths, {
      state: "ready",
      pending: 0,
      routeMode: "worker",
      lastAckAt: "2026-09-01T12:00:04.000Z",
      lastAckOutcome: "failed_terminal",
      consecutiveAckFailureCount: 3,
      lastErrorCode: "acpprotocolerror",
    });
    activeControl = await startListenerControlServer({
      paths: failedPaths,
      status: () => failedStatus,
      stop: () => {},
    });

    const failedHuman = await runCliAsync(statusArgs(failedRoot), {
      cwd: root,
      home,
    });
    assert.equal(failedHuman.status, 0, failedHuman.stderr);
    assert.match(failedHuman.stdout, /HANDLED: no/);
    assert.match(
      failedHuman.stdout,
      /newest delivery acknowledgement was failed_terminal \(acpprotocolerror\)/,
    );
    assert.match(failedHuman.stdout, /Last failed delivery signal:/);
    assert.doesNotMatch(failedHuman.stdout, /Last handled signal:/);
    assert.match(failedHuman.stdout, /Listener LAPSE/);
    assert.match(failedHuman.stdout, /WARNING \[listener_delivery_failing\]/);
    assert.match(
      failedHuman.stdout,
      /recorded 3 terminal delivery failures with no reply since/,
    );
    assert.doesNotMatch(failedHuman.stdout, /last answered delivery/);

    const failedJson = await runCliAsync(
      [...statusArgs(failedRoot), "--json"],
      { cwd: root, home },
    );
    assert.equal(failedJson.status, 0, failedJson.stderr);
    const failedParsed = JSON.parse(failedJson.stdout) as Record<string, unknown>;
    assert.equal(failedParsed.handledState, "not_handled");
    assert.equal(failedParsed.listenerLapse, true);
    assert.deepEqual(failedParsed.listenerLapseCodes, [
      "listener_delivery_failing",
    ]);
    assert.equal(failedParsed.lastAckOutcome, "failed_terminal");
    assert.equal(failedParsed.consecutiveAckFailureCount, 3);
    await activeControl.close();
    activeControl = null;

    for (const outcome of ["queued", "expired"] as const) {
      const incompleteRoot = join(root, outcome);
      const incompletePaths = paths(incompleteRoot);
      const incompleteStatus = await statusFixture(incompletePaths, {
        state: "ready",
        pending: 0,
        routeMode: "worker",
        lastAckAt: "2026-09-01T12:00:04.500Z",
        lastAckOutcome: outcome,
      });
      activeControl = await startListenerControlServer({
        paths: incompletePaths,
        status: () => incompleteStatus,
        stop: () => {},
      });
      const incompleteHuman = await runCliAsync(statusArgs(incompleteRoot), {
        cwd: root,
        home,
      });
      assert.equal(incompleteHuman.status, 0, incompleteHuman.stderr);
      assert.match(incompleteHuman.stdout, /HANDLED: not yet measured/);
      assert.match(
        incompleteHuman.stdout,
        new RegExp(`Last acknowledged signal: .* Its outcome was ${outcome}\\.`),
      );
      assert.doesNotMatch(incompleteHuman.stdout, /outcome is not known/);
      const incompleteJson = await runCliAsync(
        [...statusArgs(incompleteRoot), "--json"],
        { cwd: root, home },
      );
      assert.equal(incompleteJson.status, 0, incompleteJson.stderr);
      const incompleteParsed = JSON.parse(incompleteJson.stdout) as Record<
        string,
        unknown
      >;
      assert.equal(incompleteParsed.lastAckOutcome, outcome);
      assert.equal(incompleteParsed.handledState, "not_yet_measured");
      await activeControl.close();
      activeControl = null;
    }

    const answeredRoot = join(root, "answered");
    const answeredPaths = paths(answeredRoot);
    const answeredStatus = await statusFixture(answeredPaths, {
      state: "ready",
      pending: 0,
      routeMode: "worker",
      lastAckAt: "2026-09-01T12:00:05.000Z",
      lastAckOutcome: "replied",
      consecutiveAckFailureCount: 0,
    });
    activeControl = await startListenerControlServer({
      paths: answeredPaths,
      status: () => answeredStatus,
      stop: () => {},
    });

    const answeredHuman = await runCliAsync(statusArgs(answeredRoot), {
      cwd: root,
      home,
    });
    assert.equal(answeredHuman.status, 0, answeredHuman.stderr);
    assert.match(answeredHuman.stdout, /HANDLED: yes/);
    assert.match(answeredHuman.stdout, /newest delivery acknowledgement was replied/);
    assert.match(answeredHuman.stdout, /Last handled signal:/);
    assert.doesNotMatch(answeredHuman.stdout, /listener_delivery_failing/);

    const answeredJson = await runCliAsync(
      [...statusArgs(answeredRoot), "--json"],
      { cwd: root, home },
    );
    assert.equal(answeredJson.status, 0, answeredJson.stderr);
    const answeredParsed = JSON.parse(answeredJson.stdout) as Record<string, unknown>;
    assert.equal(answeredParsed.handledState, "handled");
    assert.equal(answeredParsed.listenerLapse, false);
    assert.deepEqual(answeredParsed.listenerLapseCodes, []);
    assert.equal(answeredParsed.lastAckOutcome, "replied");
    assert.equal(answeredParsed.consecutiveAckFailureCount, 0);
  } finally {
    if (activeControl !== null) await activeControl.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("listen start refuses unattended main routes unless the operator accepts the risk", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-attendance-start-"));
  const home = await mkdtemp(join(tmpdir(), "cswarm-attendance-start-home-"));
  const credentialPath = join(root, "agent.json");
  try {
    await writeFile(credentialPath, artifact(), { mode: 0o600 });
    await chmod(credentialPath, 0o600);
    const common = [
      "listen",
      "start",
      "--url",
      TARGET.url,
      "--anon-key",
      TARGET.anonKey,
      "--workspace-id",
      WORKSPACE_ID,
      "--agent-token-file",
      credentialPath,
      "--provider",
      "opencode",
      "--opencode-executable",
      "/definitely/missing/opencode",
      "--state-dir",
      join(root, "state"),
    ];
    const refused = runCli([...common, "--route", "main"], { cwd: root, home });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /listen_unattended_refused/);
    assert.match(refused.stderr, /then start a fresh session/);
    assert.match(refused.stderr, /--allow-unattended/);

    const refusedSplit = runCli(
      [...common, "--route", "split", "--defer-over", "200"],
      { cwd: root, home },
    );
    assert.equal(refusedSplit.status, 1);
    assert.match(refusedSplit.stderr, /listen_unattended_refused/);

    const allowed = runCli(
      [...common, "--route", "main", "--allow-unattended"],
      { cwd: root, home },
    );
    assert.equal(allowed.status, 1);
    assert.doesNotMatch(allowed.stderr, /listen_unattended_refused/);

    const worker = runCli([...common, "--route", "worker"], { cwd: root, home });
    assert.equal(worker.status, 1);
    assert.doesNotMatch(worker.stderr, /listen_unattended_refused/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

function acceptedSignal(): Record<string, unknown> {
  return {
    status: "accepted",
    ok: true,
    event_ids: [],
    events: [],
    signal: {
      id: SIGNAL_ID,
      workspace_id: WORKSPACE_ID,
      from: PRINCIPAL_ID,
      from_kind: "agent",
      to: null,
      to_agent: PRINCIPAL_ID,
      in_reply_to: null,
      about: null,
      kind: "note",
      body: "CommonSwarm listener attendance canary. No reply is needed.",
      until: "2026-09-01T12:10:00.000Z",
      created_at: "2026-09-01T12:00:00.000Z",
    },
  };
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    addressed: true,
    receipts: [{
      recipient_agent_principal_id: PRINCIPAL_ID,
      enqueued_at: "2026-09-01T12:00:00.000Z",
      delivered_at: null,
      leased_until: null,
      acked_at: null,
      ack_outcome: null,
      attempt_count: 0,
      lease_expiry_count: 0,
      last_error_code: null,
      pending_for_main_count: null,
      ...overrides,
    }],
  };
}

test("listen canary measures a fake server through surfaced and observed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-attendance-canary-"));
  const canaryPaths = paths(root);
  let fakeNow = Date.parse("2026-09-01T12:00:00.000Z");
  let readCount = 0;
  let postedCommand: Record<string, unknown> = {};
  try {
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (Object.hasOwn(body, "command")) {
        postedCommand = body.command as Record<string, unknown>;
        return new Response(JSON.stringify(acceptedSignal()), { status: 200 });
      }
      readCount += 1;
      if (readCount === 1) {
        await appendListenerEvent(canaryPaths, {
          ts: "2026-09-01T12:00:01.000Z",
          event: "listener_delivery_claim",
          signal_id: SIGNAL_ID,
          pending_delivery_count: 0,
          terminal_delivery_failure_count: 0,
        });
        await appendListenerEvent(canaryPaths, {
          ts: "2026-09-01T12:00:01.100Z",
          event: "listener_routing_decision",
          signal_id: SIGNAL_ID,
          route_mode: "main",
          route_decision: "main",
          defer_over_chars: null,
          body_length: 62,
        });
        await new FileHookSurfaceStore(canaryPaths.instanceDirectory).commit({
          signalIds: [SIGNAL_ID],
        });
      }
      return new Response(JSON.stringify(receipt({
        delivered_at: "2026-09-01T12:00:01.000Z",
        acked_at: "2026-09-01T12:00:02.000Z",
        ack_outcome: "observed",
      })), { status: 200 });
    };
    const result = await runListenerAttendanceCanary({
      target: TARGET,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      paths: canaryPaths,
      credential: async () => TOKEN,
      waitMs: 1_000,
      fetcher,
      now: () => fakeNow,
      sleep: async (milliseconds) => {
        fakeNow += milliseconds;
      },
      pollMs: 100,
    });
    assert.equal(postedCommand.kind, "post_signal");
    assert.equal(postedCommand.signal_kind, "note");
    assert.equal(postedCommand.to_agent_principal_id, PRINCIPAL_ID);
    assert.equal(result.stalledAt, null);
    assert.equal(result.routeDecision, "main");
    assert.notEqual(result.claimedAt, null);
    assert.notEqual(result.surfacedAt, null);
    assert.notEqual(result.observedAt, null);
    assert.match(
      renderListenerAttendanceCanary(result, WORKSPACE_ID, PRINCIPAL_ID),
      /Canary passed: every required hop was measured/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listen canary names the first stalled hop against a fake server", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-attendance-stalled-"));
  let fakeNow = Date.parse("2026-09-01T12:00:00.000Z");
  try {
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(
        Object.hasOwn(body, "command") ? acceptedSignal() : receipt(),
      ), { status: 200 });
    };
    const result = await runListenerAttendanceCanary({
      target: TARGET,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      paths: paths(root),
      credential: async () => TOKEN,
      waitMs: 500,
      fetcher,
      now: () => fakeNow,
      sleep: async (milliseconds) => {
        fakeNow += milliseconds;
      },
      pollMs: 100,
    });
    assert.equal(result.stalledAt, "claimed");
    const rendered = renderListenerAttendanceCanary(
      result,
      WORKSPACE_ID,
      PRINCIPAL_ID,
    );
    assert.match(rendered, /CLAIMED: no/);
    assert.match(rendered, /STALLED: claimed/);
    assert.match(rendered, /cswarm listen status/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listen canary CLI posts one self-note and renders the stalled hop", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-attendance-canary-cli-"));
  const home = await mkdtemp(join(tmpdir(), "cswarm-attendance-canary-cli-home-"));
  const credentialPath = join(root, "agent.json");
  let postCount = 0;
  let postedCommand: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const payload = Object.hasOwn(body, "command")
        ? (() => {
          postCount += 1;
          postedCommand = body.command as Record<string, unknown>;
          return acceptedSignal();
        })()
        : receipt();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  try {
    await writeFile(credentialPath, artifact(), { mode: 0o600 });
    await chmod(credentialPath, 0o600);
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await runCliAsync([
      "listen",
      "canary",
      "--agent-token-file",
      credentialPath,
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--anon-key",
      "anon",
      "--workspace-id",
      WORKSPACE_ID,
      "--state-dir",
      join(root, "state"),
      "--wait",
      "1",
    ], { cwd: root, home });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(postCount, 1);
    assert.equal(postedCommand.to_agent_principal_id, PRINCIPAL_ID);
    assert.match(result.stdout, /ACCEPTED: yes/);
    assert.match(result.stdout, /CLAIMED: no/);
    assert.match(result.stdout, /STALLED: claimed/);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
