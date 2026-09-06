import assert from "node:assert/strict";
import { chmod, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  DeliveryCommandClient,
} from "../../src/cloud/delivery.js";
import {
  ManagedAckRefusedError,
  canAckManagedDelivery,
} from "../../src/cloud/session-ack.js";
import {
  newSessionBinding,
  writeSessionContext,
} from "../../src/cloud/session-context.js";
import { generateSessionKey } from "../../src/cloud/session-proof.js";
import { AgentSessionClient } from "../../src/cloud/session-client.js";
import { AgentSessionManager } from "../../src/cloud/session-manager.js";
import { runInteractiveReceiveOnce } from "../../src/cloud/session-receiver.js";
import type { DeliveryAckRequest, DeliveryRow } from "../../src/cloud/delivery.js";
import {
  ackCommandId,
  type ListenerDeliveryJournalRecord,
} from "../../src/listener/delivery-journal.js";
import { newObservedNoteRecord } from "../../src/listener/file-store.js";
import {
  runListenerRuntime,
  type ListenerRuntimeModel,
} from "../../src/listener/runtime.js";
import type { ListenerEffectRecord } from "../../src/listener/types.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SIGNAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = `swm_agt_${"S".repeat(43)}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cswarm-ack-"));
  await chmod(root, 0o700);
  const credDir = join(root, "cred");
  await mkdir(credDir, { mode: 0o700 });
  await chmod(credDir, 0o700);
  const tokenFile = join(credDir, "token.json");
  await writeFile(tokenFile, "{}\n", { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const context = {
    ...newSessionBinding({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      workspaceId: WORKSPACE,
      principalId: PRINCIPAL,
      provider: "codex",
      mode: "interactive",
      hostSessionId: "thread-1",
      tokenFile,
    }),
    generation: 2,
    session_key: generateSessionKey(),
  };
  const contextPath = join(root, "session.json");
  await writeSessionContext(contextPath, context);
  return { root, context };
}

test("ACK requires current proof and successful host injection", async () => {
  const { root, context } = await fixture();
  try {
    const proof = {
      session_id: context.session_id,
      generation: context.generation,
      key: context.session_key,
    };
    assert.equal(
      canAckManagedDelivery({
        context,
        proof: null,
        injectionSucceeded: true,
        observedHostSessionId: "thread-1",
        hostIdentityTrusted: true,
      }).ok,
      false,
    );
    assert.equal(
      canAckManagedDelivery({
        context,
        proof,
        injectionSucceeded: false,
        observedHostSessionId: "thread-1",
        hostIdentityTrusted: true,
      }).ok,
      false,
    );
    assert.deepEqual(
      canAckManagedDelivery({
        context,
        proof,
        injectionSucceeded: true,
        observedHostSessionId: "thread-1",
        hostIdentityTrusted: true,
      }),
      { ok: true },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale generation or old session cannot ACK", async () => {
  const { root, context } = await fixture();
  try {
    const stale = canAckManagedDelivery({
      context,
      proof: {
        session_id: context.session_id,
        generation: context.generation - 1,
        key: context.session_key,
      },
      injectionSucceeded: true,
      observedHostSessionId: "thread-1",
      hostIdentityTrusted: true,
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "ack_proof_stale");
    const otherSession = canAckManagedDelivery({
      context,
      proof: {
        session_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        generation: context.generation,
        key: context.session_key,
      },
      injectionSucceeded: true,
      observedHostSessionId: "thread-1",
      hostIdentityTrusted: true,
    });
    assert.equal(otherSession.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("untrusted or mismatched host conversation cannot ACK", async () => {
  const { root, context } = await fixture();
  try {
    const untrusted = canAckManagedDelivery({
      context,
      proof: {
        session_id: context.session_id,
        generation: context.generation,
        key: context.session_key,
      },
      injectionSucceeded: true,
      observedHostSessionId: null,
      hostIdentityTrusted: false,
    });
    assert.equal(untrusted.ok, false);
    if (!untrusted.ok) assert.equal(untrusted.code, "ack_host_session_untrusted");
    const mismatch = canAckManagedDelivery({
      context,
      proof: {
        session_id: context.session_id,
        generation: context.generation,
        key: context.session_key,
      },
      injectionSucceeded: true,
      observedHostSessionId: "other-thread",
      hostIdentityTrusted: true,
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.code, "ack_host_session_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale hook observation is refused before any network write", async () => {
  const { root, context } = await fixture();
  try {
    let fetches = 0;
    const fetcher = (async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const client = new DeliveryCommandClient(
      cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      fetcher,
    );
    await assert.rejects(
      () => client.observeQueuedAgentDelivery({
        workspaceId: WORKSPACE,
        credential: TOKEN,
        commandId: "observe_synthetic",
        signalId: SIGNAL,
        managedAck: {
          context,
          proof: {
            session_id: context.session_id,
            generation: 1,
            key: context.session_key,
          },
          injectionSucceeded: true,
          observedHostSessionId: "thread-1",
          hostIdentityTrusted: true,
        },
      }),
      (error: unknown) => error instanceof ManagedAckRefusedError,
    );
    assert.equal(fetches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const INSTANCE = "44444444-4444-4444-8444-444444444444";
const LEASE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function noteRow(): DeliveryRow {
  return {
    signal: {
      id: SIGNAL,
      workspace_id: WORKSPACE,
      from: "11111111-1111-4111-8111-111111111111",
      from_kind: "user",
      to: null,
      to_agent: PRINCIPAL,
      in_reply_to: null,
      about: null,
      kind: "ask",
      body: "synthetic ask",
      until: "2099-01-01T00:00:00.000Z",
      created_at: "2026-09-06T00:00:00.000Z",
    },
    leaseId: LEASE,
    leasedUntil: "2099-01-01T00:00:00.000Z",
    senderOwnerRelation: "same_owner",
    recipientPosition: 0,
    recipientCount: 1,
  };
}

class IdleModel implements ListenerRuntimeModel {
  async start() {}
  async prompt() {
    return { message: "unused", stopReason: "end_turn" as const };
  }
  cancel() {}
  async close() {}
}

function ackPage() {
  return {
    signals: [],
    capabilities: {
      senderOwnerRelation: true,
      cursorAfter: true,
      deliveryClaim: false,
      deliveryAck: true,
    },
    legacyCursorFallback: false,
    rawCount: 0,
    nextCursor: null,
    malformedRows: 0,
    pendingDeliveryCount: 1,
  };
}

test("stale generation cannot ACK through the runtime path", async () => {
  const { root, context } = await fixture();
  try {
    const store = {
      records: new Map<string, ListenerEffectRecord>(),
      async read(id: string) {
        return this.records.get(id) ?? null;
      },
      async write(record: ListenerEffectRecord) {
        this.records.set(record.signalId, record);
      },
    };
    await store.write(newObservedNoteRecord({
      signalId: SIGNAL,
      body: "note-ack",
      until: "2099-01-01T00:00:00.000Z",
      senderOwnerRelation: "same_owner",
      updatedAt: "2026-09-06T00:00:02.000Z",
    }));
    const active = {
      phase: "ack_pending" as const,
      claimOrdinal: 0,
      claimCommandId: "claim_synthetic",
      claimCreatedAt: "2026-09-06T00:00:00.000Z",
      claimLastAttemptAt: "2026-09-06T00:00:01.000Z",
      signalId: SIGNAL,
      leaseId: LEASE,
      leasedUntil: "2099-01-01T00:00:00.000Z",
      ack: {
        commandId: ackCommandId(LEASE),
        outcome: "observed" as const,
        lastErrorCode: null,
        preparedAt: "2026-09-06T00:00:02.000Z",
      },
    };
    const journal = {
      record: {
        version: 1 as const,
        workspaceId: WORKSPACE,
        principalId: PRINCIPAL,
        listenerInstanceId: INSTANCE,
        nextClaimOrdinal: 1,
        active,
        updatedAt: "2026-09-06T00:00:02.000Z",
      } as ListenerDeliveryJournalRecord,
      async read() {
        return structuredClone(this.record);
      },
      async reserveClaim() {
        throw new Error("reserve must not run");
      },
      async recordClaimAttempt() {
        throw new Error("attempt must not run");
      },
      async recordLease() {
        throw new Error("lease must not run");
      },
      async prepareAck() {
        throw new Error("prepareAck must not run");
      },
      async clearActive() {
        this.record.active = null;
      },
    };
    let ackCalls = 0;
    const stop = await runListenerRuntime({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      workspaceId: WORKSPACE,
      principalId: PRINCIPAL,
      listenerInstanceId: INSTANCE,
      deliveryJournal: journal,
      deliveryClient: {
        async claimAgentInbox() {
          throw new Error("claim must not run");
        },
        async ackAgentDelivery() {
          ackCalls += 1;
          return { httpStatus: 200, signalId: SIGNAL, outcome: "observed" };
        },
      },
      credentialSession: { async bearer() { return TOKEN; } },
      store,
      model: new IdleModel(),
      now: () => Date.parse("2026-09-06T00:01:00.000Z"),
      sleep: async () => undefined,
      readPage: async () => ackPage(),
      sessionBinding: {
        contextPath: join(root, "session.json"),
        context,
        proof: {
          session_id: context.session_id,
          generation: 1,
          key: context.session_key,
        },
      },
    });
    assert.equal(stop.reason, "fatal");
    if (stop.reason === "fatal") {
      assert.match(stop.error.message, /ack_proof_stale/);
    }
    assert.equal(ackCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime ACK carries managedAck built from the real injection result", async () => {
  const { root, context } = await fixture();
  try {
    const store = {
      records: new Map<string, ListenerEffectRecord>(),
      async read(id: string) {
        return this.records.get(id) ?? null;
      },
      async write(record: ListenerEffectRecord) {
        this.records.set(record.signalId, record);
      },
    };
    await store.write(newObservedNoteRecord({
      signalId: SIGNAL,
      body: "note-ack",
      until: "2099-01-01T00:00:00.000Z",
      senderOwnerRelation: "same_owner",
      updatedAt: "2026-09-06T00:00:02.000Z",
    }));
    const active = {
      phase: "ack_pending" as const,
      claimOrdinal: 0,
      claimCommandId: "claim_synthetic",
      claimCreatedAt: "2026-09-06T00:00:00.000Z",
      claimLastAttemptAt: "2026-09-06T00:00:01.000Z",
      signalId: SIGNAL,
      leaseId: LEASE,
      leasedUntil: "2099-01-01T00:00:00.000Z",
      ack: {
        commandId: ackCommandId(LEASE),
        outcome: "observed" as const,
        lastErrorCode: null,
        preparedAt: "2026-09-06T00:00:02.000Z",
      },
    };
    const journal = {
      record: {
        version: 1 as const,
        workspaceId: WORKSPACE,
        principalId: PRINCIPAL,
        listenerInstanceId: INSTANCE,
        nextClaimOrdinal: 1,
        active,
        updatedAt: "2026-09-06T00:00:02.000Z",
      } as ListenerDeliveryJournalRecord,
      async read() {
        return structuredClone(this.record);
      },
      async reserveClaim() {
        throw new Error("reserve must not run");
      },
      async recordClaimAttempt() {
        throw new Error("attempt must not run");
      },
      async recordLease() {
        throw new Error("lease must not run");
      },
      async prepareAck() {
        throw new Error("prepareAck must not run");
      },
      async clearActive() {
        this.record.active = null;
      },
    };
    const acks: DeliveryAckRequest[] = [];
    const controller = new AbortController();
    const stop = await runListenerRuntime({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      workspaceId: WORKSPACE,
      principalId: PRINCIPAL,
      listenerInstanceId: INSTANCE,
      deliveryJournal: journal,
      deliveryClient: {
        async claimAgentInbox() {
          throw new Error("claim must not run");
        },
        async ackAgentDelivery(request) {
          acks.push(request);
          controller.abort();
          return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
        },
      },
      credentialSession: { async bearer() { return TOKEN; } },
      store,
      model: new IdleModel(),
      signal: controller.signal,
      now: () => Date.parse("2026-09-06T00:01:00.000Z"),
      sleep: async () => undefined,
      readPage: async () => ackPage(),
      sessionBinding: {
        contextPath: join(root, "session.json"),
        context,
      },
    });
    assert.equal(stop.reason, "cancelled");
    assert.equal(acks.length, 1);
    assert.equal(acks[0]?.managedAck?.injectionSucceeded, true);
    assert.equal(acks[0]?.managedAck?.proof?.generation, context.generation);
    assert.equal(acks[0]?.managedAck?.observedHostSessionId, "thread-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive ACK passes managedAck so a stale proof cannot fetch", async () => {
  const { root, context, } = await fixture();
  const contextPath = join(root, "session.json");
  try {
    let fetches = 0;
    const fetcher = (async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const client = new DeliveryCommandClient(
      cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      fetcher,
    );
    const manager = new AgentSessionManager({
      client: new AgentSessionClient({
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        fetcher: (async () =>
          new Response(JSON.stringify({ ok: true, status: "accepted" }), {
            status: 200,
          })) as typeof fetch,
      }),
      credential: async () => TOKEN,
      workspaceId: WORKSPACE,
      contextPath,
      context,
    });
    const seenManaged: Array<{ generation: number; injectionSucceeded: boolean }> = [];
    const pass = await runInteractiveReceiveOnce({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      credential: TOKEN,
      contextPath,
      context,
      manager,
      hostInjection: {
        async inject() {
          return { ok: true as const };
        },
      },
      hostIdentityTrusted: true,
      observedHostSessionId: "thread-1",
      claimClient: {
        async claim() {
          return [noteRow()];
        },
        async ack(_row, managedAck) {
          seenManaged.push({
            generation: managedAck.proof?.generation ?? 0,
            injectionSucceeded: managedAck.injectionSucceeded,
          });
        },
      },
    }, new Set());
    assert.equal(pass.acked, 1);
    assert.deepEqual(seenManaged, [{
      generation: context.generation,
      injectionSucceeded: true,
    }]);
    await assert.rejects(
      () => client.ackAgentDelivery({
        workspaceId: WORKSPACE,
        credential: TOKEN,
        commandId: "ack_stale",
        signalId: SIGNAL,
        leaseId: LEASE,
        listenerInstanceId: context.session_id,
        outcome: "observed",
        lastErrorCode: null,
        managedAck: {
          context,
          proof: {
            session_id: context.session_id,
            generation: 1,
            key: context.session_key,
          },
          injectionSucceeded: true,
          observedHostSessionId: "thread-1",
          hostIdentityTrusted: true,
        },
      }),
      (error: unknown) => error instanceof ManagedAckRefusedError,
    );
    assert.equal(fetches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
