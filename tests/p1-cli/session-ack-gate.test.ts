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
