import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { runInteractiveReceiveOnce } from "../../src/cloud/session-cli.js";
import { AgentSessionClient } from "../../src/cloud/session-client.js";
import { AgentSessionManager } from "../../src/cloud/session-manager.js";
import {
  newSessionBinding,
  writeSessionContext,
} from "../../src/cloud/session-context.js";
import type { DeliveryRow } from "../../src/cloud/delivery.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SIGNAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = `swm_agt_${"S".repeat(43)}`;

function row(): DeliveryRow {
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
    leaseId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    leasedUntil: "2099-01-01T00:00:00.000Z",
    senderOwnerRelation: "same_owner",
    recipientPosition: 0,
    recipientCount: 1,
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cswarm-recv-"));
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
    generation: 1,
  };
  const contextPath = join(root, "session.json");
  await writeSessionContext(contextPath, context);
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
  return { root, context, contextPath, manager };
}

test("no callback stays manual and does not ACK", async () => {
  const { root, context, contextPath, manager } = await setup();
  try {
    let acks = 0;
    const pass = await runInteractiveReceiveOnce({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      credential: TOKEN,
      contextPath,
      context,
      manager,
      hostInjection: null,
      claimClient: {
        async claim() {
          return [row()];
        },
        async ack() {
          acks += 1;
        },
      },
    }, new Set());
    assert.equal(pass.receive, "manual");
    assert.equal(pass.acked, 0);
    assert.equal(pass.buffered, 1);
    assert.equal(acks, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate ask ids do not ACK twice", async () => {
  const { root, context, contextPath, manager } = await setup();
  try {
    let acks = 0;
    const seen = new Set<string>();
    const options = {
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
          return [row(), row()];
        },
        async ack() {
          acks += 1;
        },
      },
    };
    const first = await runInteractiveReceiveOnce(options, seen);
    const second = await runInteractiveReceiveOnce(options, seen);
    assert.equal(first.acked, 1);
    assert.equal(second.acked, 0);
    assert.equal(acks, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("idle claim invokes zero models and zero acks", async () => {
  const { root, context, contextPath, manager } = await setup();
  try {
    let factory = 0;
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
      providerFactory: () => {
        factory += 1;
      },
      claimClient: {
        async claim() {
          return [];
        },
        async ack() {
          throw new Error("idle receiver must not ack");
        },
      },
    }, new Set());
    assert.equal(pass.acked, 0);
    assert.equal(pass.surfaced, 0);
    assert.equal(factory, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
