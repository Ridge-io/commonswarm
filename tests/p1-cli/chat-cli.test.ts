/**
 * The chat client: what it puts on the wire, what it refuses before it sends
 * anything, and what it says afterwards.
 *
 * Three claims are gated here.
 *
 * 1. **The client's copy of the channel rules cannot drift from the edge's.**
 *    `src/cloud/channels.ts` duplicates the constants in
 *    `supabase/functions/_shared/channels.ts` because `tsconfig.json` pins
 *    `rootDir` to `src` and a module under `src/` cannot import one under
 *    `supabase/`. That duplication is the exact failure AGENTS.md measured four
 *    times in one release cycle, so this file imports BOTH and compares them.
 *    Its bound: it compares the constants and the generated sentences NAMED
 *    below, generated from `sharedConstantNames`, and it compares
 *    `channelSlugProblem` over the cases in `slugCases`, which are themselves
 *    derived from the shared constants rather than typed. It does NOT prove the
 *    two modules export the same SET of names, and it does not reach the
 *    database CHECK — `tests/chat-channel-constants.test.ts` owns that pairing.
 *
 * 2. **The bodies match what the served edge accepts.** The expected shapes are
 *    the ones `tests/p1-server/chat-signals.test.ts` sends against a real
 *    command function: its `installedPost()` helper is reproduced here as
 *    `installedPostBody`, and its channel commands as `channelCommandCases`.
 *    That test proves the shapes are accepted; this one proves the client emits
 *    them, without a database.
 *
 * 3. **A name that cannot be a channel name is refused before the credential is
 *    read, and never over the network.** Spawned against `dist/cli.js` with a
 *    complete target and a credential path that cannot exist, so a probe that
 *    got past the local check says `agent_token_file_unreadable` and one that
 *    reached the network would say something else again. Nothing here connects.
 *
 * Gate: `npm run test:p1-cli` (a glob over tests/p1-cli/**), which is also
 * reached by `npm run check:tests`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import * as client from "../../src/cloud/channels.js";
import * as edge from "../../supabase/functions/_shared/channels.js";
import {
  ThinCommandClient,
  type ChannelCommand,
  type PostSignalCommand,
} from "../../src/cloud/command-client.js";
import { parseSignalRecord } from "../../src/cloud/signals.js";
import {
  CHANNEL_SUBCOMMAND_NAMES,
  threadReplyMessage,
} from "../../src/cli.js";
import { CLIENT_PROTOCOL_VERSION } from "../../src/cloud/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const cli = resolve(root, "dist", "cli.js");

const target = {
  url: "https://example.invalid",
  anonKey: "anon-key",
  profileId: "test",
};

/* ------------------------------------------------------------------ *
 * 1. The copy against the enforcement
 * ------------------------------------------------------------------ */

/**
 * The names both modules must agree on, as data. The assertions iterate this
 * list, so adding a shared constant to one module and forgetting it here is
 * visible as a shorter list rather than as a silent gap — which is the bound
 * this file states at the top.
 */
const sharedConstantNames = [
  "CHANNEL_SLUG_MAX",
  "CHANNEL_PURPOSE_MAX",
  "CHANNEL_SLUG_CLASSES",
  "RESERVED_CHANNEL_SLUGS",
  "CHANNEL_SLUG_RULE_TEXT",
  "RESERVED_CHANNEL_SLUG_TEXT",
  "CHANNEL_ID_RULE_TEXT",
] as const;

test("every shared channel constant is identical in the client and the edge", () => {
  for (const name of sharedConstantNames) {
    assert.deepEqual(
      client[name],
      edge[name],
      `${name} differs between src/cloud/channels.ts and the edge module`,
    );
  }
  assert.equal(client.CHANNEL_SLUG_RE.source, edge.CHANNEL_SLUG_RE.source);
  assert.equal(client.CHANNEL_SLUG_RE.flags, edge.CHANNEL_SLUG_RE.flags);
});

/**
 * Slug cases, generated from the shared constants rather than typed, so a
 * changed bound moves the cases with it.
 */
const slugCases: unknown[] = [
  "mobile",
  "a",
  "a-b-c",
  "MiXeD",
  "  padded  ",
  "-leading",
  "trailing-",
  "has space",
  "under_score",
  "",
  "x".repeat(edge.CHANNEL_SLUG_MAX),
  "x".repeat(edge.CHANNEL_SLUG_MAX + 1),
  ...edge.RESERVED_CHANNEL_SLUGS,
  ...edge.RESERVED_CHANNEL_SLUGS.map((slug) => slug.toUpperCase()),
  42,
  null,
  undefined,
];

test("channelSlugProblem answers identically in the client and the edge", () => {
  for (const value of slugCases) {
    assert.equal(
      client.channelSlugProblem(value),
      edge.channelSlugProblem(value),
      `channelSlugProblem disagrees for ${JSON.stringify(value)}`,
    );
  }
  /* Control: the case table discriminates. If every case were accepted or every
   * case refused, agreement above would prove nothing. */
  const answers = slugCases.map((value) => client.channelSlugProblem(value));
  assert.ok(answers.some((answer) => answer === null), "no case is accepted");
  assert.ok(answers.some((answer) => answer !== null), "no case is refused");
});

test("the slug rule sentence names the bound the regex enforces", () => {
  /* The sentence is generated, so this reads it back rather than pinning a
   * literal: a changed CHANNEL_SLUG_MAX must move the text with it. */
  assert.ok(
    client.CHANNEL_SLUG_RULE_TEXT.includes(String(client.CHANNEL_SLUG_MAX)),
  );
  for (const entry of client.CHANNEL_SLUG_CLASSES.edge) {
    assert.ok(
      client.CHANNEL_SLUG_RULE_TEXT.includes(entry.words),
      `the rule does not name ${entry.words}`,
    );
  }
  for (const entry of client.CHANNEL_SLUG_CLASSES.inner) {
    assert.ok(client.CHANNEL_SLUG_RULE_TEXT.includes(entry.words));
  }
  for (const slug of client.RESERVED_CHANNEL_SLUGS) {
    assert.ok(client.RESERVED_CHANNEL_SLUG_TEXT.includes(slug));
  }
});

/* ------------------------------------------------------------------ *
 * 2. The bodies
 * ------------------------------------------------------------------ */

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function capturingFetch(
  captured: Captured[],
  response: Record<string, unknown>,
  status = 200,
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: init?.headers as Record<string, string>,
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/**
 * The EXACT body `tests/p1-server/chat-signals.test.ts:242-256` sends against a
 * real command function: the modern pair, always both.
 */
const installedPostBody: Record<string, unknown> = {
  kind: "post_signal",
  signal_kind: "note",
  body: "p1-server chat body",
  to_user_id: null,
  about: null,
  to_agent_principal_id: null,
  in_reply_to: null,
};

const baseCommand: PostSignalCommand = {
  kind: "post_signal",
  signal_kind: "note",
  body: "p1-server chat body",
  to_user_id: null,
  to_agent_principal_id: null,
  in_reply_to: null,
  about: null,
};

const signalResponse = {
  status: "accepted",
  ok: true,
  event_ids: [],
  signal: {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    from: "33333333-3333-4333-8333-333333333333",
    from_kind: "user",
    to: null,
    to_agent: null,
    in_reply_to: null,
    about: null,
    kind: "note",
    body: "p1-server chat body",
    until: "2030-01-01T00:00:00.000Z",
    created_at: "2026-09-05T00:00:00.000Z",
  },
};

async function postedCommand(
  command: PostSignalCommand,
): Promise<Record<string, unknown>> {
  const captured: Captured[] = ["to"];
  const sent = new ThinCommandClient(
    target,
    capturingFetch(captured, signalResponse),
  );
  await sent.sendSignal({
    workspaceId: "22222222-2222-4222-8222-222222222222",
    command,
    credential: "swm_agt_test",
  });
  assert.equal(captured.length, 1);
  return captured[0]!.body.command as Record<string, unknown>;
}

test("a post with no chat option is byte-identical to the installed body", async () => {
  const command = await postedCommand(baseCommand);
  assert.deepEqual(command, installedPostBody);
  /* The key SET matters as much as the values: the command edge refuses any key
   * it did not expect, so a chat key sent as an explicit null would 400 every
   * post from this client. */
  assert.deepEqual(
    Object.keys(command).sort(),
    Object.keys(installedPostBody).sort(),
  );
});

test("each chat option adds its own key and drags in no sibling", async () => {
  const samples: Array<[string, Partial<PostSignalCommand>, unknown]> = [
    ["channel", { channel: "mobile" }, "mobile"],
    [
      "thread_root_id",
      { thread_root_id: "44444444-4444-4444-8444-444444444444" },
      "44444444-4444-4444-8444-444444444444",
    ],
    [
      "broadcast_to_channel",
      {
        thread_root_id: "44444444-4444-4444-8444-444444444444",
        broadcast_to_channel: true,
      },
      true,
    ],
  ];
  for (const [key, extra, value] of samples) {
    const command = await postedCommand({ ...baseCommand, ...extra });
    assert.equal(command[key], value, `${key} did not reach the wire`);
    const added = Object.keys(command).filter(
      (name) => !Object.hasOwn(installedPostBody, name),
    ).sort();
    assert.deepEqual(
      added,
      Object.keys(extra).sort(),
      `${key} changed the key set by more than itself`,
    );
  }
});

/* Optional chat keys the edge accepts that THIS client does not send yet. When the
 * client learns one, remove it here or the test below goes red: drift is visible in
 * both directions. `to` (a recipient list, lane L2) landed on the edge on 2026-09-05
 * before the CLI had a verb for it. */
const EDGE_CHAT_KEYS_NOT_SENT_YET: readonly string[] = ["to"];

test("the chat keys the client can send are a subset of the edge's, and the rest are named", async () => {
  /* Generated on BOTH sides: the edge's own list of optional chat keys, and the
   * keys `sendSignal` actually emits when every option is set, measured by
   * diffing against the installed body. An earlier version compared the edge's
   * list with a typed array, which a review arm pointed out is not a claim
   * about the client at all; a later one asserted equality, which went red the
   * moment the edge learned a key the client had no verb for. */
  const everything = await postedCommand({
    ...baseCommand,
    channel: "mobile",
    thread_root_id: "44444444-4444-4444-8444-444444444444",
    broadcast_to_channel: true,
  });
  const emitted = Object.keys(everything).filter(
    (name) => !Object.hasOwn(installedPostBody, name),
  ).sort();
  const edgeKeys = [...edge.CHAT_SIGNAL_OPTIONAL_KEYS].sort();
  const unknownToEdge = emitted.filter((key) => !edgeKeys.includes(key));
  assert.deepEqual(unknownToEdge, [], "the client sent a chat key the edge does not accept");
  const notSent = edgeKeys.filter((key) => !emitted.includes(key));
  assert.deepEqual(notSent, [...EDGE_CHAT_KEYS_NOT_SENT_YET].sort());
  assert.ok(emitted.length > 0, "no chat key reached the wire");
});

const channelCommandCases: Array<[ChannelCommand, string[]]> = [
  [{ kind: "channel_create", slug: "mobile" }, ["kind", "slug"]],
  [
    { kind: "channel_create", slug: "mobile", purpose: "ship the app" },
    ["kind", "purpose", "slug"],
  ],
  [
    {
      kind: "channel_rename",
      channel_id: "55555555-5555-4555-8555-555555555555",
      slug: "mobile-app",
    },
    ["channel_id", "kind", "slug"],
  ],
  [
    {
      kind: "channel_archive",
      channel_id: "55555555-5555-4555-8555-555555555555",
    },
    ["channel_id", "kind"],
  ],
];

const channelResponse = {
  status: "accepted",
  ok: true,
  event_ids: [],
  channel: {
    channel_id: "55555555-5555-4555-8555-555555555555",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    slug: "mobile",
    purpose: null,
    created_by_principal: "33333333-3333-4333-8333-333333333333",
    created_by_kind: "user",
    created_at: "2026-09-05T00:00:00.000Z",
    archived_at: null,
  },
};

test("a channel command carries the envelope and the exact fields the edge names", async () => {
  for (const [command, keys] of channelCommandCases) {
    const captured: Captured[] = ["to"];
    const sent = new ThinCommandClient(
      target,
      capturingFetch(captured, channelResponse),
    );
    const result = await sent.sendChannel({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      command,
      credential: "swm_agt_test",
    });
    assert.equal(captured.length, 1);
    const envelope = captured[0]!.body;
    assert.equal(
      captured[0]!.url,
      "https://example.invalid/functions/v1/command",
    );
    assert.deepEqual(
      Object.keys(envelope).sort(),
      ["client_version", "command", "command_id", "stream", "workspace_id"],
    );
    assert.equal(envelope.client_version, CLIENT_PROTOCOL_VERSION);
    assert.deepEqual(envelope.stream, { kind: "workspace" });
    const body = envelope.command as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), keys);
    assert.deepEqual(body, command as unknown as Record<string, unknown>);
    assert.equal(result.channel.channel_id, channelResponse.channel.channel_id);
  }
});

test("a refusal shows the server's own sentence, and a bare one names the version", async () => {
  const served = {
    error: "invalid_request",
    message: "A channel purpose is at most 500 characters.",
  };
  const captured: Captured[] = ["to"];
  const withMessage = new ThinCommandClient(
    target,
    capturingFetch(captured, served, 400),
  );
  await assert.rejects(
    withMessage.sendChannel({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      command: { kind: "channel_create", slug: "mobile" },
      credential: "swm_agt_test",
    }),
    (error: Error) => {
      assert.equal(error.message, served.message);
      return true;
    },
  );

  /* An old deployment refuses at the envelope layer, with no message. The
   * fallback must say the version thing rather than repeating a status code. */
  const bare = new ThinCommandClient(
    target,
    capturingFetch([], { error: "invalid_request" }, 400),
  );
  await assert.rejects(
    bare.sendChannel({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      command: { kind: "channel_create", slug: "mobile" },
      credential: "swm_agt_test",
    }),
    (error: Error) => {
      assert.equal(error.message, client.CHANNEL_UNSUPPORTED_MESSAGE);
      assert.match(error.message, /protocol/);
      return true;
    },
  );
});

test("an unread chat column stays ABSENT, and a read one is carried", () => {
  /* The claim: `null` says the server placed this signal in no channel, and
   * absent says nobody asked. The human REST read names the chat columns only
   * when a channel filter is set, so normalizing absence to null would put
   * `"channel_id": null` into `cswarm feed --json` for a signal that IS in a
   * channel. */
  const row: Record<string, unknown> = {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    from: "33333333-3333-4333-8333-333333333333",
    from_kind: "user",
    to: null,
    to_agent: null,
    in_reply_to: null,
    about: null,
    kind: "note",
    body: "a note",
    until: "2030-01-01T00:00:00.000Z",
    created_at: "2026-09-05T00:00:00.000Z",
  };
  const unasked = parseSignalRecord(row);
  assert.equal(Object.hasOwn(unasked, "channel_id"), false);
  assert.equal(Object.hasOwn(unasked, "thread_root_id"), false);
  assert.equal(Object.hasOwn(unasked, "broadcast_to_channel"), false);

  const asked = parseSignalRecord({
    ...row,
    channel_id: "55555555-5555-4555-8555-555555555555",
    thread_root_id: null,
    broadcast_to_channel: false,
  });
  assert.equal(asked.channel_id, "55555555-5555-4555-8555-555555555555");
  assert.equal(asked.thread_root_id, null);
  assert.equal(asked.broadcast_to_channel, false);
  /* Present but not a boolean is malformed, not false: silently reading a
   * string as false would say a broadcast did not happen. */
  assert.throws(
    () => parseSignalRecord({ ...row, broadcast_to_channel: "yes" }),
    /malformed broadcast_to_channel/,
  );
});

test("the reply sentence comes from the row, not from the flag", () => {
  /* A thread reply is filed in its ROOT's channel. A root that is in no channel
   * leaves channel_id null while broadcast_to_channel is still stored as true,
   * so a sentence built from the flag would claim a delivery that did not
   * happen. */
  const filed = threadReplyMessage(
    { channel_id: "55555555-5555-4555-8555-555555555555" },
    { inThread: true, broadcastToChannel: true },
  );
  assert.match(filed, /sent to the thread's channel as well/);

  const unfiled = threadReplyMessage(
    { channel_id: null },
    { inThread: true, broadcastToChannel: true },
  );
  assert.doesNotMatch(unfiled, /sent to the thread's channel as well/);
  assert.match(unfiled, /in no channel/);

  /* Absent is a third state: an edge that predates channels says nothing, so
   * neither does this. */
  const unknown = threadReplyMessage(
    {},
    { inThread: true, broadcastToChannel: true },
  );
  assert.match(unknown, /unknown/);
  assert.doesNotMatch(unknown, /sent to the thread's channel as well/);

  /* Controls: without the flag, and without --thread at all. */
  assert.equal(
    threadReplyMessage(
      { channel_id: "55555555-5555-4555-8555-555555555555" },
      { inThread: true, broadcastToChannel: false },
    ),
    "Reply shared in the thread. It is immutable and readable by everyone who can read the thread.",
  );
  assert.match(
    threadReplyMessage({ channel_id: null }, {
      inThread: false,
      broadcastToChannel: false,
    }),
    /addressed to the original author/,
  );
});

/* ------------------------------------------------------------------ *
 * 3. Rendering
 * ------------------------------------------------------------------ */

const channelRows: client.ChannelRow[] = [
  {
    channel_id: "55555555-5555-4555-8555-555555555555",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    slug: "mobile",
    purpose: "ship the app",
    created_by_principal: "33333333-3333-4333-8333-333333333333",
    created_by_kind: "user",
    created_at: "2026-09-05T00:00:00.000Z",
    archived_at: null,
  },
  {
    channel_id: "66666666-6666-4666-8666-666666666666",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    slug: "old-thing",
    purpose: null,
    created_by_principal: "33333333-3333-4333-8333-333333333333",
    created_by_kind: "agent",
    created_at: "2026-09-05T00:00:00.000Z",
    archived_at: "2026-09-05T01:00:00.000Z",
  },
];

test("the channel list hides archived channels but says they are there", () => {
  const live = client.renderChannelList(channelRows, {
    includeArchived: false,
  });
  assert.match(live, /Channels in this workspace \(1\)/);
  assert.match(live, /- mobile: ship the app/);
  assert.doesNotMatch(live, /old-thing/);
  assert.match(live, /--include-archived/);

  const all = client.renderChannelList(channelRows, { includeArchived: true });
  assert.match(all, /Channels in this workspace \(2\)/);
  assert.match(all, /old-thing.*\[archived/);
  assert.doesNotMatch(
    all,
    /archived channels? not shown/,
    "it must not offer a flag that is already on",
  );

  assert.match(
    client.renderChannelList([], { includeArchived: false }),
    /No channels in this workspace yet/,
  );
});

test("an unknown channel name is answered with the names that exist", () => {
  const message = client.unknownChannelMessage("mobil", channelRows);
  assert.match(message, /no channel named mobil/);
  assert.match(message, /Channels here: mobile\./);
  /* The list is generated from the rows, so an archived channel is not offered
   * as somewhere to post. */
  assert.doesNotMatch(message, /old-thing/);
  assert.match(
    client.unknownChannelMessage("mobile", []),
    /no channel has been created yet/,
  );
});

test("a channel is found by name whatever its case, and never by a near miss", () => {
  assert.equal(client.findChannelBySlug(channelRows, "MOBILE")?.slug, "mobile");
  assert.equal(client.findChannelBySlug(channelRows, " mobile "), channelRows[0]);
  assert.equal(client.findChannelBySlug(channelRows, "mobil"), null);
});

/* ------------------------------------------------------------------ *
 * 4. Argument parsing, against the built CLI
 * ------------------------------------------------------------------ */

function run(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SWARM_CLOUD_URL: "",
        SWARM_CLOUD_ANON_KEY: "",
        SWARM_CLOUD_WORKSPACE_ID: "",
      },
    });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * Every spawn below carries a complete target AND a credential flag pointing at
 * a path that cannot exist. That is the positive control: anything that got as
 * far as resolving a credential says `agent_token_file_unreadable`, and no
 * probe here reaches the network at all, so this stays a pure gate.
 */
const offlineTarget = [
  "--url",
  "https://127.0.0.1:1",
  "--anon-key",
  "k",
  "--workspace-id",
  "22222222-2222-4222-8222-222222222222",
  "--agent-token-file",
  "/nonexistent/nope.json",
];

/** Reached the credential step, which is AFTER every local check in this lane. */
const REACHED_CREDENTIAL = /agent_token_file_unreadable/;

test("a name that cannot be a channel name is refused with the rule, before the credential", () => {
  for (
    const args of [
      ["channel", "create", "Not A Slug"],
      ["channel", "rename", "mobile", "Not A Slug"],
      ["note", "hello", "--channel", "Not A Slug"],
      ["feed", "--channel", "Not A Slug"],
      ["inbox", "--channel", "Not A Slug"],
      ["working-on", "something", "--channel", "Not A Slug"],
      ["ask", "anything", "--channel", "Not A Slug"],
      /* The SELECTOR halves. Both were missing, and both reached the credential
       * first, which is the ordering defect a review arm found. */
      ["channel", "archive", "Not A Slug"],
      ["channel", "rename", "Not A Slug", "mobile"],
    ]
  ) {
    const { code, output } = run([...args, ...offlineTarget]);
    assert.equal(code, 1, `${args.join(" ")} did not fail`);
    assert.ok(
      output.includes(client.CHANNEL_SLUG_RULE_TEXT),
      `${args.join(" ")} did not print the slug rule: ${output}`,
    );
    assert.doesNotMatch(
      output,
      REACHED_CREDENTIAL,
      `${args.join(" ")} paid for a credential before checking the name`,
    );
  }
});

test("a selector that is neither a name nor an id names both rules", () => {
  /* A mistyped id is 36 characters, so it breaks the name rule too. Telling
   * such a caller only the name rule sends them to fix the wrong thing. */
  for (
    const args of [
      ["channel", "archive", "9f9cbbff-42da-44b9-b4bf-34bbc8e32e0"],
      ["channel", "rename", "9f9cbbff-42da-44b9-b4bf-34bbc8e32e0", "mobile"],
    ]
  ) {
    const { output } = run([...args, ...offlineTarget]);
    assert.ok(
      output.includes(client.CHANNEL_ID_RULE_TEXT),
      `${args.join(" ")} did not name the id rule: ${output}`,
    );
    assert.ok(output.includes(client.CHANNEL_SLUG_RULE_TEXT), output);
    assert.doesNotMatch(output, REACHED_CREDENTIAL);
  }
  /* A RESERVED name is a well-formed name. Telling that caller the shape rule
   * sends them to fix a rule they kept, which is the defect a review arm found
   * in the first version of this check. */
  for (const slug of client.RESERVED_CHANNEL_SLUGS) {
    for (
      const args of [
        ["channel", "archive", slug],
        ["channel", "rename", slug, "mobile"],
      ]
    ) {
      const { output } = run([...args, ...offlineTarget]);
      assert.ok(
        output.includes(client.RESERVED_CHANNEL_SLUG_TEXT),
        `${args.join(" ")} did not say the name is reserved: ${output}`,
      );
      assert.ok(
        !output.includes(client.CHANNEL_SLUG_RULE_TEXT),
        `${args.join(" ")} named the shape rule it did not break: ${output}`,
      );
      assert.doesNotMatch(output, REACHED_CREDENTIAL);
    }
  }
  /* CONTROL: a WELL-FORMED id passes the local rules and reaches the
   * credential, so the refusals above are about the selector and not about
   * archive always failing. */
  const ok = run([
    "channel",
    "archive",
    "9f9cbbff-42da-44b9-b4bf-34bbc8e32e0f",
    ...offlineTarget,
  ]);
  assert.match(ok.output, REACHED_CREDENTIAL);
  assert.doesNotMatch(ok.output, /neither a channel name nor a channel id/);
});

test("a reserved channel name is refused by name, and a usable one gets past the rule", () => {
  /* The loop below has no subject when nothing is reserved, and a loop with no
   * subject passes without testing anything. Both arms called that out. If the
   * reserved list is ever emptied on purpose, delete this test rather than
   * letting it stand as a green claim about behaviour nobody exercises. */
  assert.ok(
    client.RESERVED_CHANNEL_SLUGS.length > 0,
    "nothing is reserved, so this test has no subject",
  );
  for (const slug of client.RESERVED_CHANNEL_SLUGS) {
    const { output } = run(["channel", "create", slug, ...offlineTarget]);
    assert.ok(output.includes(client.RESERVED_CHANNEL_SLUG_TEXT), output);
    assert.doesNotMatch(output, REACHED_CREDENTIAL);
  }
  /* CONTROL. A usable name must pass the local rule and get FURTHER, to the
   * credential — otherwise the refusals above would prove only that
   * `channel create` always fails. */
  const { output } = run(["channel", "create", "mobile", ...offlineTarget]);
  assert.doesNotMatch(output, /A channel name uses/);
  assert.match(output, REACHED_CREDENTIAL);
});

test("--broadcast-to-channel without --thread is refused, and with it is not", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const refused = run(["reply", id, "hi", "--broadcast-to-channel", ...offlineTarget]);
  assert.match(refused.output, /needs --thread/);
  assert.doesNotMatch(refused.output, REACHED_CREDENTIAL);
  /* CONTROL: the same invocation with --thread gets past the pairing check and
   * reaches the credential instead. */
  const allowed = run([
    "reply",
    id,
    "hi",
    "--thread",
    "--broadcast-to-channel",
    ...offlineTarget,
  ]);
  assert.doesNotMatch(allowed.output, /needs --thread/);
  assert.match(allowed.output, REACHED_CREDENTIAL);
});

test("cswarm channel names its subcommands, and inbox --follow refuses --channel", () => {
  const unknown = run(["channel", "nope", ...offlineTarget]);
  /* ONLY the refusal line. A UsageError prints the whole usage block after its
   * sentence, and the usage block names every subcommand — so asserting against
   * the full output passes whatever the sentence says, which is a probe that
   * never reaches the thing it tests. */
  const refusal = unknown.output.split("\n").find((line) =>
    line.startsWith("cswarm: cswarm channel takes ")
  );
  assert.ok(refusal !== undefined, unknown.output);
  /* The list is generated from the dispatch table, so this reads it back
   * against the surfaces the help text advertises rather than pinning a
   * literal: a fifth subcommand must appear in both or neither. */
  const advertised = [
    ...new Set(
      run(["--help"]).output
        .split("\n")
        .filter((line) => line.trimStart().startsWith("cswarm channel "))
        .map((line) => line.trimStart().split(" ")[2]!),
    ),
  ];
  assert.ok(advertised.length >= 4, advertised.join(","));
  /* BOTH directions, read from the dispatch table itself. Comparing the two
   * SETS catches a subcommand that exists but is not advertised as well as one
   * advertised but not dispatched. An earlier version parsed the names back out
   * of the refusal sentence; a review arm pointed out that this is a typed
   * assumption about English punctuation, and it would fail on a legitimate
   * rewording rather than on a real drift. */
  assert.deepEqual(
    [...CHANNEL_SUBCOMMAND_NAMES].sort(),
    [...advertised].sort(),
    `help and dispatch name different subcommands: ${advertised.join(",")}`,
  );
  /* And the refusal is built from that same table, so it names every one. */
  for (const name of CHANNEL_SUBCOMMAND_NAMES) {
    assert.ok(refusal.includes(name), `${refusal} omits ${name}`);
  }
  const follow = run([
    "inbox",
    "--follow",
    "--ndjson",
    "--channel",
    "mobile",
    ...offlineTarget,
  ]);
  assert.match(follow.output, /--follow cannot be combined with --channel/);
  /* The combination is refused BEFORE the name is judged. Fixing an unusable
   * name would leave a combination that is still refused, so naming the name
   * first sends the caller to the wrong repair. */
  const both = run([
    "inbox",
    "--follow",
    "--ndjson",
    "--channel",
    "Not A Slug",
    ...offlineTarget,
  ]);
  assert.match(both.output, /--follow cannot be combined with --channel/);
  assert.ok(!both.output.includes(client.CHANNEL_SLUG_RULE_TEXT), both.output);
});

test("cswarm channel ls says why an agent credential cannot list channels", () => {
  const { output } = run(["channel", "ls", ...offlineTarget]);
  /* It reaches the credential first, which is correct: the list is refused for
   * the credential KIND, and the kind is not known until the credential is
   * read. The sentence itself is gated as a constant here rather than by a live
   * agent token, so what is NOT established is that a readable agent token
   * produces it. */
  assert.match(output, REACHED_CREDENTIAL);
  assert.match(
    client.CHANNEL_LIST_NEEDS_HUMAN_MESSAGE,
    /signed in with cswarm login/,
  );
  assert.match(client.CHANNEL_SELECTOR_NEEDS_ID_MESSAGE, /channel id/);
  /* It must not enumerate what the read service DOES answer. That list lives in
   * a Deno module this package cannot import, so a copy of it here would be a
   * typed enumeration with nothing holding it true. */
  for (const resource of ["members", "files", "delivery receipts", "renewal grants"]) {
    assert.ok(
      !client.CHANNEL_LIST_NEEDS_HUMAN_MESSAGE.includes(resource),
      `the sentence enumerates the read service's resources: ${resource}`,
    );
  }
});

test("a flag this subcommand does not take is named before the channel name is judged", () => {
  /* Shape before content. A caller who typed both a flag this subcommand does
   * not take and an unusable name must be told about the flag: fixing the name
   * alone leaves a command that is still refused.
   *
   * The flag is `--kind`, which the CLI DOES know — `--not-a-real-flag` would
   * die in the argument parser, before any subcommand runs, so it would pass
   * this test whether the ordering were right or wrong. That is the negative
   * result that never reaches the path it claims to test. */
  const { output } = run([
    "channel",
    "create",
    "Not A Slug",
    "--kind",
    "note",
    ...offlineTarget,
  ]);
  assert.match(output, /unknown option: --kind/);
  assert.doesNotMatch(output, /A channel name uses/);
  /* CONTROL: without that flag the same name IS judged, so the assertion above
   * is about ordering and not about the name being ignored. */
  const named = run(["channel", "create", "Not A Slug", ...offlineTarget]);
  assert.ok(named.output.includes(client.CHANNEL_SLUG_RULE_TEXT));
});

test("the usage text advertises every channel surface this build has", () => {
  const { output } = run(["--help"]);
  for (
    const line of [
      "cswarm channel create <name>",
      "cswarm channel ls",
      "cswarm channel rename <name|channel-id> <new-name>",
      "cswarm channel archive <name|channel-id>",
    ]
  ) {
    assert.ok(output.includes(line), `help does not show: ${line}`);
  }
  assert.ok(output.includes(`at most ${client.CHANNEL_PURPOSE_MAX} characters`));
  assert.match(output, /--thread \[--broadcast-to-channel\]/);
});
