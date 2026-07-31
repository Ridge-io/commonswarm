import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  SignalRecord,
  SenderOwnerRelation,
} from "../src/cloud/command-client.js";
import { writeSecureJsonFile } from "../src/cloud/storage.js";
import {
  FileListenerEffectStore,
  ListenerEngine,
  newObservedNoteRecord,
  parseListenerEffectRecord,
  type ListenerEffectRecord,
  type ListenerEffectStore,
  type ListenerModel,
  type ListenerReplyPoster,
} from "../src/listener/index.js";

const SIGNAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPLY_ID = "33333333-3333-4333-8333-333333333333";

function v1Row(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    signalId: SIGNAL_ID,
    effectOrdinal: 0,
    commandId: "reply_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa_0",
    askBody: "What are you working on?",
    askUntil: "2026-08-30T00:00:00.000Z",
    senderOwnerRelation: "same_owner",
    state: "received",
    promptAttempts: 0,
    postAttempts: 0,
    replyBody: null,
    replyTruncated: false,
    replySignalId: null,
    failureCode: null,
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function v2AskRow(
  overrides: Record<string, unknown> = {},
): ListenerEffectRecord {
  return {
    version: 2,
    signalId: SIGNAL_ID,
    signalKind: "ask",
    effectOrdinal: 0,
    commandId: "reply_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa_0",
    askBody: "What are you working on?",
    askUntil: "2026-08-30T00:00:00.000Z",
    senderOwnerRelation: "same_owner",
    state: "received",
    promptAttempts: 0,
    postAttempts: 0,
    replyBody: null,
    replyTruncated: false,
    replySignalId: null,
    failureCode: null,
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function noteRecord(
  overrides: Partial<ListenerEffectRecord> = {},
): ListenerEffectRecord {
  return {
    ...newObservedNoteRecord({
      signalId: SIGNAL_ID,
      body: "Heads up, nothing to do.",
      until: "2026-08-30T00:00:00.000Z",
      senderOwnerRelation: "cross_owner",
      updatedAt: "2026-07-30T00:00:00.000Z",
    }),
    ...overrides,
  };
}

class MemoryStore implements ListenerEffectStore {
  readonly records = new Map<string, ListenerEffectRecord>();
  readonly writes: ListenerEffectRecord[] = [];

  async read(signalId: string): Promise<ListenerEffectRecord | null> {
    return structuredClone(this.records.get(signalId.toLowerCase()) ?? null);
  }

  async write(record: ListenerEffectRecord): Promise<void> {
    const copy = structuredClone(record);
    this.records.set(record.signalId.toLowerCase(), copy);
    this.writes.push(copy);
  }
}

function model(): ListenerModel {
  return {
    async prompt() {
      throw new Error("model must not be called for a terminal upcast effect");
    },
  };
}

function poster(): ListenerReplyPoster {
  return {
    async post() {
      throw new Error("poster must not be called for a terminal upcast effect");
    },
  };
}

function askSignal(id: string): SignalRecord {
  return {
    id,
    workspace_id: "11111111-1111-4111-8111-111111111111",
    from: "44444444-4444-4444-8444-444444444444",
    from_kind: "agent",
    to: null,
    to_agent: "22222222-2222-4222-8222-222222222222",
    in_reply_to: null,
    about: null,
    kind: "ask",
    body: "What are you working on?",
    until: "2026-08-30T00:00:00.000Z",
    created_at: "2026-07-30T00:00:00.000Z",
    sender_owner_relation: "same_owner",
  };
}

function parse(raw: unknown): ListenerEffectRecord {
  return parseListenerEffectRecord(JSON.stringify(raw), SIGNAL_ID);
}

function tagged(
  record: object,
  key: string,
  value: unknown,
): ListenerEffectRecord {
  return { ...record, [key]: value } as unknown as ListenerEffectRecord;
}

async function forbidStore(
  prefix: string,
): Promise<{ store: FileListenerEffectStore; path: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = new FileListenerEffectStore({
    profileId: "profile-test",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    principalId: "22222222-2222-4222-8222-222222222222",
    stateDirectory: root,
  });
  const path = join(store.instanceDirectory, "effects", `${SIGNAL_ID}.json`);
  return { store, path };
}

async function assertNoFile(path: string): Promise<void> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ENOENT");
    return null;
  });
  assert.equal(info, null);
}

const malformed = /stored listener effect is malformed/;

/** Representative sensitive fields that must never enter an effect record. */
const forbiddenExtras: Array<[string, string]> = [
  ["lease_id", "lsn_test_lease"],
  ["listenerBearer", "sentinel"],
  ["prompt", "do not persist the model prompt"],
  ["ackCommandId", "reply_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa_0"],
];

test("v1 records upcast to v2 ask records with every durable field preserved", () => {
  const source = v1Row({
    state: "done",
    promptAttempts: 1,
    postAttempts: 1,
    replyBody: "Working on the receive path.",
    replyTruncated: true,
    replySignalId: REPLY_ID,
  });
  const parsed = parse(source);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.signalKind, "ask");
  assert.deepEqual(parsed, v2AskRow({
    state: "done",
    promptAttempts: 1,
    postAttempts: 1,
    replyBody: "Working on the receive path.",
    replyTruncated: true,
    replySignalId: REPLY_ID,
  }));
  // Re-parsing is deterministic; the upcast never mutates the source shape.
  assert.deepEqual(parse(source), parsed);
});

test("v1 read never rewrites the durable file", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-effect-v1-"));
  const store = new FileListenerEffectStore({
    profileId: "profile-test",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    principalId: "22222222-2222-4222-8222-222222222222",
    stateDirectory: root,
  });
  const path = join(store.instanceDirectory, "effects", `${SIGNAL_ID}.json`);
  await writeSecureJsonFile(path, JSON.stringify(v1Row()));
  const before = await readFile(path, "utf8");

  const record = await store.read(SIGNAL_ID);
  assert.ok(record);
  assert.equal(record.version, 2);
  assert.equal(record.signalKind, "ask");
  assert.equal(record.commandId, v1Row().commandId);
  assert.equal(record.askBody, v1Row().askBody as string);
  assert.equal(record.askUntil, v1Row().askUntil as string);

  const after = await readFile(path, "utf8");
  assert.equal(after, before);
  assert.match(before, /"version":1/);
});

test("a terminal v1 upcast suppresses a second prompt without a write", async () => {
  const store = new MemoryStore();
  const upcast = parse(v1Row({
    state: "failed",
    promptAttempts: 2,
    failureCode: "prompt_attempts_exhausted",
  }));
  store.records.set(SIGNAL_ID, upcast);
  const engine = new ListenerEngine({ store, model: model(), poster: poster() });
  const result = await engine.process(askSignal(SIGNAL_ID));
  assert.equal(result.status, "failed");
  assert.equal(
    result.status === "failed" && result.record.failureCode,
    "prompt_attempts_exhausted",
  );
  assert.equal(store.writes.length, 0);
});

test("v2 ask records round-trip through the parser and the file store", async () => {
  const record = v2AskRow();
  assert.deepEqual(parse(record), record);

  const root = await mkdtemp(join(tmpdir(), "cswarm-effect-ask-"));
  const store = new FileListenerEffectStore({
    profileId: "profile-test",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    principalId: "22222222-2222-4222-8222-222222222222",
    stateDirectory: root,
  });
  await store.write(record);
  assert.deepEqual(await store.read(SIGNAL_ID), record);
  assert.equal((await stat(store.instanceDirectory)).mode & 0o777, 0o700);
});

test("v2 observed-note records round-trip with zero prompt/post effects", async () => {
  const note = noteRecord();
  assert.equal(note.version, 2);
  assert.equal(note.signalKind, "note");
  assert.equal(note.state, "observed");
  assert.equal(note.commandId, "");
  assert.equal(note.promptAttempts, 0);
  assert.equal(note.postAttempts, 0);
  assert.equal(note.replyBody, null);
  assert.equal(note.replyTruncated, false);
  assert.equal(note.replySignalId, null);
  assert.equal(note.failureCode, null);
  assert.equal(note.askBody, "Heads up, nothing to do.");
  assert.equal(note.askUntil, "2026-08-30T00:00:00.000Z");
  assert.equal(note.senderOwnerRelation, "cross_owner");
  assert.deepEqual(parse(note), note);

  const root = await mkdtemp(join(tmpdir(), "cswarm-effect-note-"));
  const store = new FileListenerEffectStore({
    profileId: "profile-test",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    principalId: "22222222-2222-4222-8222-222222222222",
    stateDirectory: root,
  });
  await store.write(note);
  assert.deepEqual(await store.read(SIGNAL_ID), note);
});

test("malformed versions and signalKinds fail closed", () => {
  assert.throws(() => parse({ ...v1Row(), version: 3 }), malformed);
  assert.throws(() => parse({ ...v1Row(), version: "1" }), malformed);
  assert.throws(() => parse({ ...v1Row(), version: undefined }), malformed);
  // Version 1 files never carried a discriminator; v1 remains ask-only.
  assert.throws(() => parse({ ...v1Row(), signalKind: "ask" }), malformed);
  assert.throws(
    () => parse(v1Row({ state: "observed" })),
    malformed,
  );
  assert.throws(() => parse({ ...v2AskRow(), signalKind: undefined }), malformed);
  assert.throws(() => parse({ ...v2AskRow(), signalKind: "broadcast" }), malformed);
});

test("notes cannot carry reply, post, or failure effects", () => {
  const cases: Array<Partial<ListenerEffectRecord>> = [
    { promptAttempts: 1 },
    { postAttempts: 1 },
    { replyBody: "late reply" },
    { replyTruncated: true },
    { replySignalId: REPLY_ID },
    { failureCode: "some_failure" },
    { commandId: "reply_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa_0" },
    { state: "done" },
    { state: "received" },
  ];
  for (const tamper of cases) {
    assert.throws(
      () => parse(noteRecord(tamper)),
      malformed,
      `note with ${JSON.stringify(tamper)} must be rejected`,
    );
  }
});

test("notes with reply/post effects fail closed on write", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-effect-badwrite-"));
  const store = new FileListenerEffectStore({
    profileId: "profile-test",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    principalId: "22222222-2222-4222-8222-222222222222",
    stateDirectory: root,
  });
  await assert.rejects(
    () => store.write(noteRecord({ promptAttempts: 1 })),
    malformed,
  );
  await assert.rejects(
    () => store.write(noteRecord({ state: "done" })),
    malformed,
  );
  const path = join(store.instanceDirectory, "effects", `${SIGNAL_ID}.json`);
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ENOENT");
    return null;
  });
  assert.equal(info, null);
});

test("ask records cannot carry the note-only observed state", () => {
  assert.throws(() => parse(v2AskRow({ state: "observed" })), malformed);
  assert.throws(() => parse(v1Row({ state: "observed" })), malformed);
  // A healthy ask record still parses once observed is in the state vocabulary.
  assert.deepEqual(parse(v2AskRow()), v2AskRow());
});

test("v1 and v2 parsers reject forbidden extras instead of returning them", () => {
  for (const [key, value] of forbiddenExtras) {
    assert.throws(
      () => parse(v1Row({ [key]: value })),
      malformed,
      `v1 extra ${key} must be rejected`,
    );
    assert.throws(
      () => parse({ ...v2AskRow(), [key]: value }),
      malformed,
      `v2 extra ${key} must be rejected`,
    );
  }
});

test("an on-disk file with a forbidden extra fails on read for v1 and v2", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-effect-forbid-read-"));
  const store = new FileListenerEffectStore({
    profileId: "profile-test",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    principalId: "22222222-2222-4222-8222-222222222222",
    stateDirectory: root,
  });
  const path = join(store.instanceDirectory, "effects", `${SIGNAL_ID}.json`);
  for (const [key, value] of forbiddenExtras) {
    await writeSecureJsonFile(path, JSON.stringify(v1Row({ [key]: value })));
    await assert.rejects(
      () => store.read(SIGNAL_ID),
      malformed,
      `v1 file with extra ${key} must fail on read`,
    );
  }
  for (const [key, value] of forbiddenExtras) {
    await writeSecureJsonFile(path, JSON.stringify(tagged(v2AskRow(), key, value)));
    await assert.rejects(
      () => store.read(SIGNAL_ID),
      malformed,
      `v2 file with extra ${key} must fail on read`,
    );
  }
});

test("a rejected write with a forbidden extra creates no file for v1 and v2", async () => {
  const { store, path } = await forbidStore("cswarm-effect-forbid-write-");
  for (const [key, value] of forbiddenExtras) {
    await assert.rejects(
      () => store.write(tagged(v1Row(), key, value)),
      /listener effect/,
      `v1 extra ${key} must fail on write`,
    );
  }
  for (const [key, value] of forbiddenExtras) {
    await assert.rejects(
      () => store.write(tagged(v2AskRow(), key, value)),
      /listener effect/,
      `v2 extra ${key} must fail on write`,
    );
  }
  await assertNoFile(path);
});

test("hidden extras that JSON.stringify would erase cannot reach disk", async () => {
  const { store, path } = await forbidStore("cswarm-effect-hidden-");
  const cases: Array<{
    name: string;
    build: () => object;
    hiddenFrom: ((json: string) => boolean) | null;
  }> = [
    {
      name: "non-enumerable own extra",
      hiddenFrom: (json) => !json.includes("listenerBearer"),
      build: () => {
        const record = v2AskRow();
        Object.defineProperty(record, "listenerBearer", {
          enumerable: false,
          configurable: true,
          value: "sentinel",
        });
        return record;
      },
    },
    {
      name: "symbol-keyed extra",
      hiddenFrom: (json) => !json.includes("sentinel"),
      build: () => {
        const record = v2AskRow() as unknown as Record<PropertyKey, unknown>;
        record[Symbol.for("listenerBearer")] = "sentinel";
        return record as unknown as object;
      },
    },
    {
      name: "custom prototype with inherited extra",
      hiddenFrom: (json) => !json.includes("listenerBearer"),
      build: () => Object.assign(
        Object.create({ listenerBearer: "sentinel" }),
        v2AskRow(),
      ),
    },
    {
      name: "accessor field",
      hiddenFrom: (json) => !json.includes("sentinel"),
      build: () => {
        const record = v2AskRow();
        Object.defineProperty(record, "askBody", {
          enumerable: true,
          configurable: true,
          get: () => "What are you working on?",
        });
        return record;
      },
    },
    {
      name: "toJSON method",
      hiddenFrom: (json) => !json.includes("sentinel"),
      build: () => {
        const record = v2AskRow();
        Object.defineProperty(record, "toJSON", {
          enumerable: true,
          configurable: true,
          value: () => JSON.parse(JSON.stringify(v2AskRow())),
        });
        return record;
      },
    },
    {
      name: "ordinary unknown extra",
      hiddenFrom: null,
      build: () => ({ ...v2AskRow(), lease_id: "lease" }),
    },
  ];
  for (const { name, build, hiddenFrom } of cases) {
    const candidate = build();
    if (hiddenFrom) {
      assert.ok(
        hiddenFrom(JSON.stringify(candidate)),
        `${name}: control — JSON.stringify must not surface the extra`,
      );
    }
    await assert.rejects(
      () => store.write(candidate as unknown as ListenerEffectRecord),
      /listener effect/,
      `${name}: hidden extra must fail on write`,
    );
    await assertNoFile(path);
  }
});

test("a valid version-1 record is rejected on write, never persisted", async () => {
  const { store, path } = await forbidStore("cswarm-effect-v1write-");
  await assert.rejects(
    () => store.write(v1Row() as unknown as ListenerEffectRecord),
    /listener effect/,
    "a version-1 write must be rejected",
  );
  await assertNoFile(path);
});

test("a null-prototype plain record is an allowed write shape", async () => {
  const { store } = await forbidStore("cswarm-effect-nullproto-");
  const bare = Object.create(null);
  Object.assign(bare, v2AskRow());
  await store.write(bare as unknown as ListenerEffectRecord);
  assert.deepEqual(await store.read(SIGNAL_ID), v2AskRow());
});

test("write-boundary failures use one generic message and echo no key or value", async () => {
  const { store, path } = await forbidStore("cswarm-effect-generic-");
  const sentinelKey = "sentinel_bearer_9f3a1c";
  const sentinelValue = "secret-sentinel-value-77";
  const hidden = v2AskRow();
  Object.defineProperty(hidden, sentinelKey, {
    enumerable: false,
    configurable: true,
    value: sentinelValue,
  });
  const cases: object[] = [
    { ...v2AskRow(), [sentinelKey]: sentinelValue },
    hidden,
  ];
  const messages: string[] = [];
  for (const candidate of cases) {
    await assert.rejects(
      () => store.write(candidate as unknown as ListenerEffectRecord),
      (error: Error) => {
        assert.equal(error.message, "listener effect write rejected");
        assert.ok(
          !error.message.includes(sentinelKey) &&
            !error.message.includes(sentinelValue),
          "the rejection must not echo the attacker-controlled key or value",
        );
        messages.push(error.message);
        return true;
      },
    );
  }
  assert.deepEqual(messages, [
    "listener effect write rejected",
    "listener effect write rejected",
  ]);
  await assertNoFile(path);
});
