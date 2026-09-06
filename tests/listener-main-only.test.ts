/** Main-only listener route, generated enumerations, and no-model runtime. Named in `npm test`. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cloudTarget } from "../src/cloud/config.js";
import {
  listenerRouteConfiguration,
  listenerStatusJson,
  renderListenerStatus,
  usage,
} from "../src/cli.js";
import type { SignalRecord } from "../src/cloud/command-client.js";
import {
  FilePendingMainQueue,
  LISTENER_ATTENDANCE_SURFACES,
  LISTENER_MAIN_HOST_LIMIT_CLAUSES,
  LISTENER_ALLOW_UNATTENDED_CLAUSE,
  LISTENER_NONE_ATTENDING_SENTENCE,
  LISTENER_ROUTE_MODES,
  LISTENER_ROUTE_RULING,
  LISTENER_STORED_ROUTE_MODES,
  NullListenerModel,
  decideListenerRoute,
  isLiveListenerRouteMode,
  listenerAcceptedRoutesSentence,
  listenerDeferOverRefusedSentence,
  listenerAttendanceRemediesSentence,
  listenerAttendanceSurfaceRemedy,
  listenerAttendingSentence,
  listenerAttendingSurfaces,
  listenerLegacyRouteSentence,
  listenerPaths,
  listenerRouteRefusedSentence,
  listenerRouteUsage,
  listenerUnattendedRefusedMessage,
  renderListenerAttendanceCanary,
  readListenerStatus,
  runListenerRuntime,
  writeListenerStatus,
  type ListenerEffectRecord,
  type ListenerPromptMode,
  type ListenerPromptResult,
  type ListenerRuntimeEvent,
  type ListenerRuntimeModel,
  type ListenerStatus,
} from "../src/listener/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";

test("LISTENER_ROUTE_MODES is the single live route main", () => {
  assert.deepEqual([...LISTENER_ROUTE_MODES], ["main"]);
  assert.equal(listenerRouteUsage(), "main");
  assert.equal(listenerAcceptedRoutesSentence(), "main");
  assert.equal(isLiveListenerRouteMode("main"), true);
  assert.equal(isLiveListenerRouteMode("worker"), false);
  assert.equal(isLiveListenerRouteMode("split"), false);
  assert.deepEqual([...LISTENER_STORED_ROUTE_MODES], ["worker", "main", "split"]);
});

test("route parser accepts main and refuses worker, split, and defer-over from the constant", () => {
  assert.deepEqual(listenerRouteConfiguration(undefined, undefined), {
    routeMode: "main",
    deferOverChars: null,
  });
  assert.deepEqual(listenerRouteConfiguration("main", undefined), {
    routeMode: "main",
    deferOverChars: null,
  });
  assert.throws(
    () => listenerRouteConfiguration("worker", undefined),
    (error: unknown) => {
      assert.equal((error as Error).message, listenerRouteRefusedSentence("worker"));
      assert.match((error as Error).message, new RegExp(LISTENER_ROUTE_RULING));
      assert.match((error as Error).message, new RegExp(listenerAcceptedRoutesSentence()));
      return true;
    },
  );
  assert.throws(
    () => listenerRouteConfiguration("split", "200"),
    (error: unknown) => {
      assert.equal((error as Error).message, listenerDeferOverRefusedSentence());
      return true;
    },
  );
  assert.throws(
    () => listenerRouteConfiguration("main", "200"),
    (error: unknown) => {
      assert.equal((error as Error).message, listenerDeferOverRefusedSentence());
      return true;
    },
  );
  assert.throws(
    () => listenerRouteConfiguration("split", undefined),
    (error: unknown) => {
      assert.equal((error as Error).message, listenerRouteRefusedSentence("split"));
      return true;
    },
  );
});

test("usage line is generated from LISTENER_ROUTE_MODES", () => {
  const text = usage();
  assert.match(text, new RegExp(`--route ${listenerRouteUsage()}`));
  assert.doesNotMatch(text, /--route worker\|main\|split/);
  assert.doesNotMatch(text, /--defer-over <chars>/);
  assert.match(text, /never starts a model/);
});

test("attendance remedies and attending sentences are generated from LISTENER_ATTENDANCE_SURFACES", () => {
  assert.deepEqual([...LISTENER_ATTENDANCE_SURFACES], ["hook", "watcher"]);
  const remedies = listenerAttendanceRemediesSentence(PRINCIPAL_ID);
  for (const surface of LISTENER_ATTENDANCE_SURFACES) {
    assert.ok(remedies.includes(listenerAttendanceSurfaceRemedy(surface, PRINCIPAL_ID)));
  }
  const refused = listenerUnattendedRefusedMessage(PRINCIPAL_ID);
  assert.match(refused, /listen_unattended_refused/);
  assert.ok(refused.includes(remedies));
  assert.ok(refused.includes(LISTENER_ALLOW_UNATTENDED_CLAUSE));
  assert.doesNotMatch(refused, /--route worker/);
  assert.deepEqual(listenerAttendingSurfaces(true, false), ["hook"]);
  assert.deepEqual(listenerAttendingSurfaces(false, true), ["watcher"]);
  assert.deepEqual(listenerAttendingSurfaces(true, true), ["hook", "watcher"]);
  assert.deepEqual(listenerAttendingSurfaces(false, false), []);
  assert.equal(
    listenerAttendingSentence([]),
    `ATTENDING: none. ${LISTENER_NONE_ATTENDING_SENTENCE}`,
  );
  assert.equal(listenerAttendingSentence(["hook"]), "ATTENDING: hook.");
  assert.equal(listenerAttendingSentence(["watcher"]), "ATTENDING: watcher.");
  assert.equal(listenerAttendingSentence(["hook", "watcher"]), "ATTENDING: hook, or watcher.");
});

test("legacy worker and split status files still parse and render the cannot-start-again sentence", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-legacy-route-"));
  try {
    const paths = listenerPaths({
      profileId: "legacy-route",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      stateDirectory: root,
    });
    const base = (routeMode: "worker" | "split" | "main"): ListenerStatus => ({
      version: 1,
      instanceId: "55555555-5555-4555-8555-555555555555",
      provider: "claude",
      profileId: "legacy-route",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      pid: 2_147_483_647,
      state: "stopped",
      startedAt: "2026-09-01T12:00:00.000Z",
      readyAt: "2026-09-01T12:00:01.000Z",
      updatedAt: "2026-09-01T12:00:02.000Z",
      stoppedAt: "2026-09-01T12:00:02.000Z",
      lastSignalId: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      providerVersion: null,
      providerLastMeasuredVersion: null,
      lastWorkerStderrTail: null,
      deliveryMode: "durable_claim",
      pendingDeliveryCount: 0,
      lastTerminalDeliveryFailureCount: null,
      lastTerminalDeliveryFailureAt: null,
      lastClaimAt: null,
      lastAckAt: null,
      lastAckOutcome: null,
      consecutiveAckFailureCount: null,
      routeMode,
      deferOverChars: routeMode === "split" ? 200 : null,
      pendingForMainCount: 0,
      droppedForMainCount: 0,
      logPath: paths.logPath,
    });
    await writeListenerStatus(paths, base("worker"));
    const worker = await readListenerStatus(paths);
    assert.equal(worker?.routeMode, "worker");
    await writeListenerStatus(paths, base("split"));
    const split = await readListenerStatus(paths);
    assert.equal(split?.routeMode, "split");
    assert.equal(split?.deferOverChars, 200);
    assert.equal(
      listenerLegacyRouteSentence("worker"),
      `LEGACY: this status file has routeMode worker. That route cannot be started again; ${LISTENER_ROUTE_RULING}.`,
    );
    assert.equal(
      listenerLegacyRouteSentence("split"),
      `LEGACY: this status file has routeMode split. That route cannot be started again; ${LISTENER_ROUTE_RULING}.`,
    );
    assert.equal(
      listenerLegacyRouteSentence("main"),
      "Ask route: main; directed asks wait for this interactive session.",
    );
    const emptyEvidence = {
      pendingForMainOldestAt: null,
      hookSurfaceExists: false,
      hookSurfaceAdvanced: false,
    };
    assert.match(
      renderListenerStatus(worker, emptyEvidence),
      /LEGACY: this status file has routeMode worker\. That route cannot be started again/,
    );
    assert.match(
      renderListenerStatus(split, emptyEvidence),
      /LEGACY: this status file has routeMode split\. That route cannot be started again/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class ThrowingStartModel implements ListenerRuntimeModel {
  starts = 0;
  prompts = 0;
  async start(): Promise<void> {
    this.starts += 1;
    throw new Error("fake model start must not be called");
  }
  async prompt(
    _signal: SignalRecord,
    _mode: ListenerPromptMode,
    _prompt: string,
    _attempt: number,
  ): Promise<ListenerPromptResult> {
    this.prompts += 1;
    throw new Error("fake model prompt must not be called");
  }
  cancel(): void {}
  async close(): Promise<void> {}
}

test("runtime reaches ready without calling model.start even when start throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-main-only-ready-"));
  const controller = new AbortController();
  const model = new ThrowingStartModel();
  const events: ListenerRuntimeEvent[] = [];
  const effects = new Map<string, ListenerEffectRecord>();
  const queue = new FilePendingMainQueue(root);
  const note: SignalRecord = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspace_id: WORKSPACE_ID,
    from: PRINCIPAL_ID,
    from_kind: "agent",
    to: null,
    to_agent: PRINCIPAL_ID,
    in_reply_to: null,
    about: null,
    kind: "note",
    body: "queue me",
    until: "2036-01-01T00:00:00.000Z",
    created_at: "2026-09-06T00:00:00.000Z",
  };
  let reads = 0;
  try {
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      credentialSession: { async bearer() { return "token"; } },
      store: {
        async read(id) { return effects.get(id) ?? null; },
        async write(record) { effects.set(record.signalId, record); },
      },
      model,
      pendingMainQueue: queue,
      signal: controller.signal,
      now: () => Date.parse("2026-09-06T00:00:00.000Z"),
      sleep: async () => {
        controller.abort();
      },
      onEvent: (event) => events.push(event),
      readPage: async () => {
        reads += 1;
        if (reads > 1) controller.abort();
        return {
          signals: reads === 1 ? [note] : [],
          capabilities: {
            senderOwnerRelation: true,
            cursorAfter: true,
            deliveryClaim: false,
            deliveryAck: false,
          },
          legacyCursorFallback: false,
          rawCount: reads === 1 ? 1 : 0,
          nextCursor: null,
          malformedRows: 0,
          pendingDeliveryCount: null,
        };
      },
    });
    assert.equal(stop.reason, "cancelled");
    assert.ok(events.some((event) => event.type === "ready"));
    assert.equal(model.starts, 0);
    assert.equal(model.prompts, 0);
    const queued = await queue.read();
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.signalId, note.id);
    assert.equal(queued[0]?.body, "queue me");
    const raw = await readFile(join(root, "pending-for-main.json"), "utf8");
    assert.match(raw, /queue me/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("NullListenerModel start throws so a missed call cannot look like success", async () => {
  const model = new NullListenerModel();
  await assert.rejects(model.start(), /listener never starts a model/);
  await assert.rejects(
    model.prompt(
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspace_id: WORKSPACE_ID,
        from: PRINCIPAL_ID,
        from_kind: "agent",
        to: null,
        to_agent: PRINCIPAL_ID,
        in_reply_to: null,
        about: null,
        kind: "ask",
        body: "hi",
        until: "2036-01-01T00:00:00.000Z",
        created_at: "2026-09-06T00:00:00.000Z",
      },
      "worker",
      "hi",
      1,
    ),
    /listener never prompts a model/,
  );
});

test("decideListenerRoute never returns worker", () => {
  assert.equal(decideListenerRoute("main", null, 0), "main");
  assert.equal(decideListenerRoute("main", null, 9999), "main");
});

test("main-route status JSON host_limits is generated and does not name a worker", () => {
  const status: ListenerStatus = {
    version: 1,
    instanceId: "55555555-5555-4555-8555-555555555555",
    provider: "grok",
    profileId: "main-host-limits",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    pid: 2_147_483_647,
    state: "ready",
    startedAt: "2026-09-06T12:00:00.000Z",
    readyAt: "2026-09-06T12:00:01.000Z",
    updatedAt: "2026-09-06T12:00:02.000Z",
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    providerVersion: null,
    providerLastMeasuredVersion: null,
    lastWorkerStderrTail: null,
    deliveryMode: "durable_claim",
    pendingDeliveryCount: 0,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: null,
    routeMode: "main",
    deferOverChars: null,
    pendingForMainCount: 0,
    droppedForMainCount: 0,
    logPath: "/tmp/log",
  };
  const json = listenerStatusJson(status, "allow");
  const limits = json.host_limits as Record<string, string>;
  for (const [key, clause] of Object.entries(LISTENER_MAIN_HOST_LIMIT_CLAUSES)) {
    assert.equal(limits[key], clause);
    assert.ok(String(limits.human_copy).includes(clause));
  }
  assert.doesNotMatch(
    JSON.stringify(json.host_limits),
    /same worker|Grok worker|OpenCode worker/,
  );
});

test("canary stalled-surfaced remedy is generated from LISTENER_ATTENDANCE_SURFACES", () => {
  const rendered = renderListenerAttendanceCanary({
    signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    acceptedAt: "2026-09-06T00:00:00.000Z",
    claimedAt: "2026-09-06T00:00:01.000Z",
    routeDecision: "main",
    routedAt: "2026-09-06T00:00:01.000Z",
    pendingForMainCount: 1,
    surfacedAt: null,
    observedAt: null,
    receiptReadErrorCode: null,
    stalledAt: "surfaced",
  }, WORKSPACE_ID, PRINCIPAL_ID);
  assert.match(rendered, /QUEUED:/);
  assert.doesNotMatch(rendered, /QUEUED\/WORKER/);
  assert.ok(rendered.includes(listenerAttendanceSurfaceRemedy("hook", PRINCIPAL_ID)));
});

test("adding worker to LISTENER_ROUTE_MODES fails this pin and the refusal test", async () => {
  const src = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../src/listener/main-routing.ts"),
    "utf8",
  );
  assert.match(src, /export const LISTENER_ROUTE_MODES = \["main"\] as const;/);
  assert.equal((LISTENER_ROUTE_MODES as readonly string[]).includes("worker"), false);
  assert.throws(
    () => listenerRouteConfiguration("worker", undefined),
    (error: unknown) => {
      assert.equal((error as Error).message, listenerRouteRefusedSentence("worker"));
      return true;
    },
  );
});
