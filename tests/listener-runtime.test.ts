import assert from "node:assert/strict";
import test from "node:test";
import {
  CommandHttpError,
  type SignalRecord,
} from "../src/cloud/command-client.js";
import { cloudTarget } from "../src/cloud/config.js";
import {
  RenewalReauthorisationRequired,
  RenewalRevoked,
} from "../src/cloud/renewal.js";
import type {
  AgentSignalPage,
  SignalCursor,
} from "../src/cloud/signals.js";
import { SignalHttpError } from "../src/cloud/signals.js";
import {
  runListenerRuntime,
  type ListenerEffectRecord,
  type ListenerEffectStore,
  type ListenerPromptMode,
  type ListenerRuntimeEvent,
  type ListenerRuntimeModel,
} from "../src/listener/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";

function ask(
  id: string,
  createdAt: string,
): SignalRecord {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    from: "33333333-3333-4333-8333-333333333333",
    from_kind: "agent",
    to: null,
    to_agent: PRINCIPAL_ID,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body: `ask-${id.slice(-4)}`,
    until: "2026-08-30T00:00:00.000Z",
    created_at: createdAt,
    sender_owner_relation: "same_owner",
  };
}

class MemoryStore implements ListenerEffectStore {
  readonly records = new Map<string, ListenerEffectRecord>();
  async read(id: string) {
    return structuredClone(this.records.get(id) ?? null);
  }
  async write(record: ListenerEffectRecord) {
    this.records.set(record.signalId, structuredClone(record));
  }
}

class FakeModel implements ListenerRuntimeModel {
  starts = 0;
  closes = 0;
  cancels = 0;
  prompts: Array<{ id: string; mode: ListenerPromptMode; prompt: string }> = [];

  async start() {
    this.starts += 1;
  }
  async prompt(
    signal: SignalRecord,
    mode: ListenerPromptMode,
    prompt: string,
  ) {
    this.prompts.push({ id: signal.id, mode, prompt });
    return {
      message: `reply-${signal.id.slice(-4)}`,
      stopReason: "end_turn" as const,
    };
  }
  cancel() {
    this.cancels += 1;
  }
  async close() {
    this.closes += 1;
  }
}

function page(
  signals: SignalRecord[],
  options: Partial<AgentSignalPage> = {},
): AgentSignalPage {
  const last = signals[signals.length - 1];
  return {
    signals,
    capabilities: {
      senderOwnerRelation: true,
      cursorAfter: true,
      deliveryClaim: false,
      deliveryAck: false,
    },
    legacyCursorFallback: false,
    rawCount: signals.length,
    nextCursor: last
      ? { created_at: last.created_at, id: last.id }
      : null,
    malformedRows: 0,
    pendingDeliveryCount: null,
    ...options,
  };
}

test("runtime refuses old edges before starting or prompting a model", async () => {
  const model = new FakeModel();
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    readPage: async () =>
      page([], {
        capabilities: {
          senderOwnerRelation: false,
          cursorAfter: true,
          deliveryClaim: false,
          deliveryAck: false,
        },
      }),
  });
  assert.equal(stop.reason, "fatal");
  assert.match(
    stop.reason === "fatal" ? stop.error.message : "",
    /does not prove sender ownership/,
  );
  assert.equal(model.starts, 0);
  assert.equal(model.prompts.length, 0);
  assert.equal(model.closes, 1);
});

test("runtime reports agent read revocation as a credential stop", async () => {
  const model = new FakeModel();
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    readPage: async () => {
      throw new SignalHttpError(403);
    },
  });
  assert.equal(stop.reason, "credential");
  assert.equal(model.starts, 0);
  assert.equal(model.closes, 1);
});

test("runtime drains pages, resets scan cursor, and posts stable replies", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const cursors: Array<SignalCursor | null> = [];
  const first = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    "2026-07-30T00:00:01.000Z",
  );
  const second = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    "2026-07-30T00:00:02.000Z",
  );
  const late = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    "2026-07-30T00:00:00.500Z",
  );
  let reads = 0;
  let bearerCalls = 0;
  const posts: Array<{ body: string; commandId: string }> = [];
  const fetcher = (async () => {
    bearerCalls += 0; // bearer is asserted separately; fetch sees no credential value.
    const body = posts.length === 0 ? "reply-aaa1" : `reply-aaa${posts.length + 1}`;
    return new Response(JSON.stringify({
      status: "accepted",
      ok: true,
      event_ids: [],
      signal: {
        ...first,
        id: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${posts.length + 1}`,
        kind: "note",
        body,
        in_reply_to: first.id,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: {
      async bearer() {
        bearerCalls += 1;
        return "token";
      },
    },
    store,
    model,
    signal: controller.signal,
    pageLimit: 2,
    pollMs: 1,
    fetcher,
    onEvent: (event) => events.push(event),
    sleep: async () => undefined,
    readPage: async ({ after }) => {
      cursors.push(after);
      reads += 1;
      if (reads === 1) return page([first, second]);
      if (reads === 2) return page([], { rawCount: 0, nextCursor: null });
      if (reads === 3) return page([late], { rawCount: 1 });
      controller.abort();
      return page([]);
    },
    poster: {
      async post({ body, commandId }) {
        bearerCalls += 1;
        posts.push({ body, commandId });
        return {
          signalId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${posts.length}`,
        };
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(cursors.slice(0, 4), [
    null,
    { created_at: second.created_at, id: second.id },
    null,
    null,
  ]);
  assert.deepEqual(model.prompts.map((item) => item.id), [
    first.id,
    second.id,
    late.id,
  ]);
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map((item) => item.commandId)).size, 3);
  assert.ok(bearerCalls >= reads + posts.length);
  assert.equal(events.filter((event) => event.type === "ready").length, 1);
  assert.equal(model.starts, 1);
  // Abort listener cancels immediately; finally also cancels (at least once).
  assert.ok(model.cancels >= 1);
  assert.equal(model.closes, 1);
});

test("runtime asks the credential session immediately before the real reply post", async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  const callOrder: string[] = [];
  let reads = 0;
  const replyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    callOrder.push(`fetch:${String(init?.headers && (init.headers as Record<string, string>).authorization)}`);
    controller.abort();
    return new Response(JSON.stringify({
      status: "accepted",
      ok: true,
      event_ids: [],
      signal: {
        ...ask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "2026-07-30T00:00:01.000Z"),
        id: replyId,
        kind: "note",
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: {
      async bearer() {
        callOrder.push("bearer");
        return "fresh-token";
      },
    },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    fetcher,
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      return page(
        reads === 1
          ? [ask(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
            "2026-07-30T00:00:01.000Z",
          )]
          : [],
      );
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(callOrder.slice(0, 3), [
    "bearer",
    "bearer",
    "fetch:Bearer fresh-token",
  ]);
});

test("runtime abort cancels model immediately while a hung prompt is pending", async () => {
  const model = new FakeModel();
  let releasePrompt: (() => void) | undefined;
  const hung = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  model.prompt = async () => {
    model.prompts.push({
      id: "hung",
      mode: "worker",
      prompt: "hang",
    });
    await hung;
    return { message: "late", stopReason: "end_turn" as const };
  };
  const controller = new AbortController();
  let cancelAtPrompt = 0;
  const originalCancel = model.cancel.bind(model);
  model.cancel = () => {
    cancelAtPrompt = model.prompts.length;
    originalCancel();
    releasePrompt?.();
  };
  let reads = 0;
  const stopPromise = runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads === 1) {
        return page([
          ask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9", "2026-07-30T00:00:01.000Z"),
        ]);
      }
      return page([]);
    },
    poster: {
      async post() {
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
      },
    },
  });
  // Wait until the hung prompt is entered, then abort while it is still pending.
  for (let i = 0; i < 50 && model.prompts.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(model.prompts.length, 1);
  assert.equal(model.cancels, 0);
  controller.abort();
  const stop = await stopPromise;
  assert.equal(stop.reason, "cancelled");
  // Causal: cancel fired while the hung prompt was in flight (not only in finally after settle).
  assert.equal(cancelAtPrompt, 1);
  assert.ok(model.cancels >= 1);
  assert.equal(model.closes, 1);
});

test("runtime emits only bounded malformed-row metadata", async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    sleep: async () => undefined,
    readPage: async ({ onMalformedRow }) => {
      reads += 1;
      for (let index = 0; index < 5; index += 1) onMalformedRow(index);
      controller.abort();
      return page([]);
    },
  });
  assert.equal(stop.reason, "cancelled");
  const malformed = events.filter((event) => event.type === "malformed_row");
  assert.equal(malformed.length, 3);
  assert.deepEqual(
    malformed.map((event) => Object.keys(event).sort()),
    [
      ["index", "ts", "type"],
      ["index", "ts", "type"],
      ["index", "ts", "type"],
    ],
  );
});

test("default poster credential failures stop as credential with the identical error and no reply fetch", async () => {
  const families = [
    new RenewalReauthorisationRequired(
      "horizon_reached",
      null,
      "renewal reauthorisation required",
    ),
    new RenewalRevoked("forbidden", "credential revoked"),
    new Error("reply credential secret is absent from the store"),
  ] as const;
  for (const [index, thrown] of families.entries()) {
    const model = new FakeModel();
    const store = new MemoryStore();
    let bearerCalls = 0;
    let fetchCalls = 0;
    const theAsk = ask(
      `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac${index}`,
      "2026-07-30T00:00:01.000Z",
    );
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      credentialSession: {
        async bearer() {
          bearerCalls += 1;
          if (bearerCalls === 1) return "token";
          throw thrown;
        },
      },
      store,
      model,
      // A reply fetch would call this; credential acquisition fails first.
      fetcher: (async () => {
        fetchCalls += 1;
        throw new Error("reply fetch must never run");
      }) as typeof fetch,
      sleep: async () => undefined,
      readPage: async () => page([theAsk]),
    });
    assert.equal(stop.reason, "credential");
    assert.equal(
      stop.reason === "credential" && stop.error,
      thrown,
      "the identical credential error must escape",
    );
    assert.equal(fetchCalls, 0, "no reply fetch may occur");
    const record = await store.read(theAsk.id);
    assert.ok(record);
    assert.equal(record.state, "reply_ready");
    assert.equal(record.failureCode, null);
    assert.equal(record.postAttempts, 1);
    assert.equal(model.closes, 1);
  }
});

test("an injected poster throwing typed 401 with hostile text stops as credential, never cancelled", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad0",
    "2026-07-30T00:00:01.000Z",
  );
  const thrown = new CommandHttpError(401, "server says operation cancelled");
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    sleep: async () => undefined,
    readPage: async () => page([theAsk]),
    poster: {
      async post() {
        throw thrown;
      },
    },
  });
  assert.equal(stop.reason, "credential", "typed 401 must stop as credential");
  assert.equal(stop.reason === "credential" && stop.error, thrown);
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "reply_ready");
  assert.equal(record.failureCode, null);
});

test("the default-post HTTP 401/403 path stops as credential, not fatal or cancelled", async () => {
  for (const status of [401, 403]) {
    const model = new FakeModel();
    const store = new MemoryStore();
    const statusIds: Record<number, string> = {
      401: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04",
      403: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05",
    };
    const theAsk = ask(
      statusIds[status]!,
      "2026-07-30T00:00:01.000Z",
    );
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      credentialSession: { async bearer() { return "token"; } },
      store,
      model,
      sleep: async () => undefined,
      readPage: async () => page([theAsk]),
      fetcher: (async () =>
        new Response(
          JSON.stringify({ message: "server says operation cancelled" }),
          {
            status,
            headers: { "content-type": "application/json" },
          },
        )) as typeof fetch,
    });
    assert.equal(stop.reason, "credential", `status ${status}`);
    const record = await store.read(theAsk.id);
    assert.ok(record);
    assert.equal(record.state, "reply_ready", `status ${status}`);
    assert.equal(record.failureCode, null, `status ${status}`);
  }
});

test("a trusted injected poster receives the same closed runtime credential classification", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaf0",
    "2026-07-30T00:00:01.000Z",
  );
  const thrown = new RenewalRevoked("forbidden", "credential revoked mid-reply");
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    sleep: async () => undefined,
    readPage: async () => page([theAsk]),
    poster: {
      async post() {
        throw thrown;
      },
    },
  });
  assert.equal(stop.reason, "credential");
  assert.equal(stop.reason === "credential" && stop.error, thrown);
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "reply_ready");
  assert.equal(record.failureCode, null);
});

test("an explicitly already-aborted runtime stays cancelled even for credential-shaped errors", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab00",
    "2026-07-30T00:00:01.000Z",
  );
  const thrown = new RenewalRevoked("forbidden", "credential revoked");
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    sleep: async () => undefined,
    readPage: async () => page([theAsk]),
    poster: {
      async post() {
        // A credential-shaped error surfaces after the caller already aborted:
        // the exact abort state is authoritative, so the stop is cancelled.
        controller.abort();
        throw thrown;
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.notEqual(stop.reason, "credential");
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "reply_ready");
  assert.equal(record.failureCode, null);
});

test("runtime classifies noncredential secret wording only by the closed fleet convention", async () => {
  // Exact fleet wording is credential loss and stops resumable.
  const model = new FakeModel();
  const store = new MemoryStore();
  const exact = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab01",
    "2026-07-30T00:00:01.000Z",
  );
  const exactStop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    sleep: async () => undefined,
    readPage: async () => page([exact]),
    poster: {
      async post() {
        throw new Error("reply credential secret is absent from the store");
      },
    },
  });
  assert.equal(exactStop.reason, "credential");
  assert.equal((await store.read(exact.id))?.state, "reply_ready");

  // Different wording is an ordinary terminal failure, not credential loss.
  const model2 = new FakeModel();
  const store2 = new MemoryStore();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const other = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab02",
    "2026-07-30T00:00:01.000Z",
  );
  let reads = 0;
  const otherStop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: store2,
    model: model2,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads === 1) return page([other]);
      controller.abort();
      return page([]);
    },
    poster: {
      async post() {
        throw new Error("reply credential is missing");
      },
    },
  });
  assert.equal(otherStop.reason, "cancelled", "never a credential stop");
  const failed = events.find(
    (event) => event.type === "effect" && event.signalId === other.id,
  );
  assert.ok(failed && failed.type === "effect");
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureCode, "error");
});

test("the default poster forwards the runtime caller signal and stays bounded", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab03",
    "2026-07-30T00:00:01.000Z",
  );
  let requestSignal: AbortSignal | undefined;
  let fetchStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    fetchStarted?.();
    // Never settles and ignores abort: only caller cancellation bounds it.
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const stopPromise = runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    fetcher,
    sleep: async () => undefined,
    readPage: async () => page([theAsk]),
  });
  await started;
  controller.abort();
  const stop = await Promise.race([
    stopPromise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("runtime did not settle after caller abort")),
        2000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(stop.reason, "cancelled");
  assert.equal(
    requestSignal?.aborted,
    true,
    "the effective request signal must abort with the caller",
  );
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "reply_ready", "the effect must remain resumable");
});

test("an already-aborted runtime caller never starts the reply fetch and stays resumable", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab04",
    "2026-07-30T00:00:01.000Z",
  );
  let fetchCalls = 0;
  model.prompt = async () => {
    controller.abort();
    return { message: "reply", stopReason: "end_turn" as const };
  };
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    fetcher: (async () => {
      fetchCalls += 1;
      throw new Error("no reply fetch after an already-aborted caller");
    }) as typeof fetch,
    sleep: async () => undefined,
    readPage: async () => page([theAsk]),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(fetchCalls, 0, "no reply fetch may occur");
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "reply_ready", "the effect must remain resumable");
});
