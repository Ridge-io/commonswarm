import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  CommandTransportError,
  ThinCommandClient,
} from "../../src/cloud/command-client.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { sendConnectWithPending } from "../../src/cloud/pending-command.js";
import type {
  CredentialProfile,
  CredentialRecord,
  CredentialStore,
} from "../../src/cloud/storage.js";

class MemoryStore implements CredentialStore {
  readonly kind = "keychain" as const;
  readonly location = "memory";
  credential: CredentialRecord | null = null;
  profile: CredentialProfile;

  constructor(userId: string, workspaceId: string) {
    this.profile = {
      version: 1,
      userId,
      workspaceId,
      pendingCommands: {},
    };
  }

  async read(): Promise<CredentialRecord | null> {
    return this.credential ? structuredClone(this.credential) : null;
  }
  async write(record: CredentialRecord): Promise<void> {
    this.credential = structuredClone(record);
  }
  async delete(): Promise<void> {
    this.credential = null;
  }
  async readProfile(): Promise<CredentialProfile> {
    return structuredClone(this.profile);
  }
  async writeProfile(profile: CredentialProfile): Promise<void> {
    this.profile = structuredClone(profile);
  }
  async withLock<T>(work: () => Promise<T>): Promise<T> {
    return await work();
  }
}

test("pending command ids survive only transport ambiguity", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", "anon-key");
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const store = new MemoryStore(userId, workspaceId);
  const requests: Array<Record<string, unknown>> = [];
  let call = 0;
  const client = new ThinCommandClient(
    target,
    (async (_url: URL | RequestInfo, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call += 1;
      if (call === 1) throw new Error("socket dropped");
      return new Response(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        invitation_id: randomUUID(),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  );
  const session = { accessToken: "human-jwt", userId, store };
  const command = { kind: "invite_member", email: "friend@example.test" } as const;

  await assert.rejects(
    sendConnectWithPending(client, session, workspaceId, command),
    CommandTransportError,
  );
  assert.equal(Object.keys(store.profile.pendingCommands).length, 1);
  await sendConnectWithPending(client, session, workspaceId, command);
  assert.equal(requests[0]?.command_id, requests[1]?.command_id);
  assert.deepEqual(store.profile.pendingCommands, {});

  await sendConnectWithPending(client, session, workspaceId, command);
  assert.notEqual(requests[1]?.command_id, requests[2]?.command_id);
  assert.deepEqual(store.profile.pendingCommands, {});
});

test("parsed HTTP failures clear pending ids", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", "anon-key");
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const store = new MemoryStore(userId, workspaceId);
  const client = new ThinCommandClient(
    target,
    (async () =>
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  );
  await assert.rejects(
    sendConnectWithPending(
      client,
      { accessToken: "human-jwt", userId, store },
      workspaceId,
      { kind: "invite_member", email: "friend@example.test" },
    ),
    /HTTP 403/,
  );
  assert.deepEqual(store.profile.pendingCommands, {});
});
