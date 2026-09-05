import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CHAT_SIGNAL_OPTIONAL_KEYS,
  chatReadKeys,
  chatSignalKeys,
  chatSignalShapeProblem,
  commandFieldsMessage,
  THREAD_REPLY_KINDS,
} from "../supabase/functions/_shared/channels.js";

/**
 * The wire gate for the chat migration, the twin of receipt-wire-compat.
 *
 * There is no version negotiation on this wire and the server migrates
 * independently of the installed base, so a request shape that every shipped
 * client sends must keep validating after the edge deploys. The measured trap
 * is NOT the schema: it is `exactKeys`. `modernKeys` is an all-or-nothing pair
 * (`to_agent_principal_id` + `in_reply_to`) that every installed writer always
 * sends, and agent READ bodies always send `in_reply_to`. Folding a new
 * optional key into that group makes `exactKeys` demand the new key from every
 * body, returning 400 on every post and every agent read after a perfectly
 * ordered migration, with the schema healthy.
 *
 * Gate: `npm test` (a literal file list — this path is named in package.json).
 */

/** exactKeys, as both edges define it. Copied so the assertions are about the
 * key SETS this lane changes, not about importing a Deno module. */
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

/** The body every installed client posts: the modern pair, always both. */
const installedPostBody: Record<string, unknown> = {
  kind: "post_signal",
  signal_kind: "note",
  body: "shipping the parser fix",
  to_user_id: null,
  to_agent_principal_id: null,
  in_reply_to: null,
};

/** The base allow-list the post_signal validator builds, before optionals. */
function postAllowList(body: Record<string, unknown>): string[] {
  const modernShape = Object.hasOwn(body, "to_agent_principal_id") ||
    Object.hasOwn(body, "in_reply_to");
  return [
    "kind",
    "signal_kind",
    "body",
    "to_user_id",
    "about",
    ...(modernShape ? ["to_agent_principal_id", "in_reply_to"] : []),
    ...(Object.hasOwn(body, "attachments") ? ["attachments"] : []),
    ...(Object.hasOwn(body, "until_ms") ? ["until_ms"] : []),
    ...chatSignalKeys(body),
  ];
}

test("a post body that predates channels still matches its own key list", () => {
  const body = { ...installedPostBody, about: null };
  assert.deepEqual(chatSignalKeys(body), []);
  assert.equal(exactKeys(body, postAllowList(body)), true);
});

test("a post body that adds one chat key matches too, and does not drag in its siblings", () => {
  for (const key of CHAT_SIGNAL_OPTIONAL_KEYS) {
    const body = { ...installedPostBody, about: null, [key]: sampleFor(key) };
    assert.deepEqual(
      chatSignalKeys(body),
      [key],
      `${key} must be its own Object.hasOwn group`,
    );
    assert.equal(
      exactKeys(body, postAllowList(body)),
      true,
      `${key} alone must validate`,
    );
  }
  /* The all-or-nothing failure, stated as an assertion rather than left to a
   * reader: if chatSignalKeys ever returned every chat key whenever any one is
   * present -- the modernKeys shape -- this length check goes red and the
   * exactKeys check above goes red with it. */
  const one = { ...installedPostBody, about: null, channel: "mobile" };
  assert.equal(chatSignalKeys(one).length, 1);
});

test("all three chat keys together still validate", () => {
  const body = {
    ...installedPostBody,
    about: null,
    channel: "mobile",
    thread_root_id: null,
    broadcast_to_channel: false,
  };
  assert.deepEqual(chatSignalKeys(body).sort(), [...CHAT_SIGNAL_OPTIONAL_KEYS].sort());
  assert.equal(exactKeys(body, postAllowList(body)), true);
});

test("an unknown key is still rejected, so the allow-list is doing work", () => {
  /* Control. Without it every assertion above would pass against an exactKeys
   * that accepts anything. */
  const body = { ...installedPostBody, about: null, nope: 1 };
  assert.equal(exactKeys(body, postAllowList(body)), false);
});

test("the agent read body, which always carries in_reply_to, is unaffected", () => {
  const agentRead: Record<string, unknown> = {
    resource: "signals",
    workspace_id: "11111111-1111-4111-8111-111111111111",
    inbox: false,
    about: null,
    kind: null,
    since: null,
    in_reply_to: null,
    limit: 50,
    include_stale: false,
  };
  assert.deepEqual(chatReadKeys(agentRead), []);
  assert.deepEqual(chatReadKeys({ ...agentRead, channel: "mobile" }), [
    "channel",
  ]);
  /* The read edge accepts only `channel`. A post-only key must not open a
   * group there, or a body carrying it would be accepted and then ignored. */
  assert.deepEqual(chatReadKeys({ ...agentRead, thread_root_id: null }), []);
});

test("neither edge folded a chat key into its modern group", () => {
  const command = readFileSync(
    fileURLToPath(
      new URL("../supabase/functions/command/index.ts", import.meta.url),
    ),
    "utf8",
  );
  const read = readFileSync(
    fileURLToPath(
      new URL("../supabase/functions/read/index.ts", import.meta.url),
    ),
    "utf8",
  );
  const modernKeysLine = command.slice(
    command.indexOf("const modernKeys = modernShape"),
  ).slice(0, 200);
  assert.ok(modernKeysLine.length > 0, "modernKeys must still exist to guard");
  for (const key of CHAT_SIGNAL_OPTIONAL_KEYS) {
    assert.equal(
      modernKeysLine.includes(key),
      false,
      `${key} must never appear in the command edge's modernKeys pair`,
    );
  }
  /* Control on the slice: the fragment really does contain the pair it guards,
   * so a passing loop above is not passing on an empty string. */
  assert.ok(modernKeysLine.includes("to_agent_principal_id"));
  assert.ok(modernKeysLine.includes("in_reply_to"));

  assert.ok(
    read.includes('const modernShape = Object.hasOwn(body, "in_reply_to");'),
    "the read edge's modern group must still be in_reply_to alone",
  );
  assert.ok(
    read.includes("const channelKeys = chatReadKeys(body);"),
    "the read edge's channel key must come from its own group helper",
  );
});

function sampleFor(key: string): unknown {
  if (key === "channel") return "mobile";
  if (key === "broadcast_to_channel") return false;
  return null;
}

/* ------------------------------------------------------------------------- *
 * The rules the chat fields add. These are the validator's, extracted into a
 * pure function so they can be exercised without a Deno runtime.
 * ------------------------------------------------------------------------- */

const undirected = {
  signal_kind: "note",
  to_user_id: null,
  to_agent_principal_id: null,
  in_reply_to: null,
};

test("the chat fields add no rule to a body that carries none of them", () => {
  assert.equal(chatSignalShapeProblem(undirected), null);
  assert.equal(
    chatSignalShapeProblem({ ...undirected, signal_kind: "working-on" }),
    null,
    "working-on is still legal when it is not a thread reply",
  );
  assert.equal(
    chatSignalShapeProblem({
      ...undirected,
      to_user_id: "11111111-1111-4111-8111-111111111111",
    }),
    null,
    "a directed note is still legal",
  );
});

test("channel is a slug or null, and null means unfiled rather than refused", () => {
  assert.equal(chatSignalShapeProblem({ ...undirected, channel: null }), null);
  assert.equal(
    chatSignalShapeProblem({ ...undirected, channel: "mobile" }),
    null,
  );
  assert.notEqual(
    chatSignalShapeProblem({ ...undirected, channel: "Not A Slug" }),
    null,
  );
});

test("a thread reply is open, so it is never working-on and never addressed", () => {
  const root = "22222222-2222-4222-8222-222222222222";
  assert.equal(
    chatSignalShapeProblem({ ...undirected, thread_root_id: root }),
    null,
  );
  assert.equal(
    chatSignalShapeProblem({
      ...undirected,
      signal_kind: "ask",
      thread_root_id: root,
    }),
    null,
    "R11: an ask may be a thread reply",
  );
  assert.notEqual(
    chatSignalShapeProblem({
      ...undirected,
      signal_kind: "working-on",
      thread_root_id: root,
    }),
    null,
  );
  assert.notEqual(
    chatSignalShapeProblem({
      ...undirected,
      to_user_id: "33333333-3333-4333-8333-333333333333",
      thread_root_id: root,
    }),
    null,
  );
  assert.notEqual(
    chatSignalShapeProblem({
      ...undirected,
      to_agent_principal_id: "44444444-4444-4444-8444-444444444444",
      thread_root_id: root,
    }),
    null,
  );
});

test("thread_root_id and in_reply_to are different mechanisms and cannot both be set", () => {
  const root = "22222222-2222-4222-8222-222222222222";
  /* in_reply_to alone keeps its exact meaning: this lane does not touch it. */
  assert.equal(
    chatSignalShapeProblem({
      ...undirected,
      in_reply_to: "55555555-5555-4555-8555-555555555555",
    }),
    null,
  );
  assert.notEqual(
    chatSignalShapeProblem({
      ...undirected,
      in_reply_to: "55555555-5555-4555-8555-555555555555",
      thread_root_id: root,
    }),
    null,
    "both set is ambiguous exactly where addressing is decided",
  );
});

test("a thread reply inherits its channel rather than taking one, and broadcast needs a thread", () => {
  const root = "22222222-2222-4222-8222-222222222222";
  assert.notEqual(
    chatSignalShapeProblem({
      ...undirected,
      thread_root_id: root,
      channel: "mobile",
    }),
    null,
    "refused, not silently ignored",
  );
  assert.equal(
    chatSignalShapeProblem({
      ...undirected,
      thread_root_id: root,
      broadcast_to_channel: true,
    }),
    null,
  );
  assert.notEqual(
    chatSignalShapeProblem({ ...undirected, broadcast_to_channel: true }),
    null,
    "broadcast_to_channel without a thread has nothing to broadcast",
  );
  assert.equal(
    chatSignalShapeProblem({ ...undirected, broadcast_to_channel: false }),
    null,
    "false is the default an older client would have written, so it must pass",
  );
  assert.notEqual(
    chatSignalShapeProblem({ ...undirected, broadcast_to_channel: "yes" }),
    null,
  );
});

test("the thread root lookup still refuses a directed root in SQL", () => {
  /* This arm is a REGRESSION GUARD, not a behavioural test: the rule lives in a
   * query the command edge runs against Postgres, and no gate in this lane can
   * execute it. resolveThreadRoot reads swarm.signals as swarm_command, which
   * bypasses swarm_read.signals — the view that IS the read policy — so without
   * these two lines any member holding a signal id could hang a PUBLIC thread
   * off a DIRECTED message between two other people. Deleting them is silent;
   * this makes it loud. The behavioural control is owed by a p1-server test. */
  const command = readFileSync(
    fileURLToPath(
      new URL("../supabase/functions/command/index.ts", import.meta.url),
    ),
    "utf8",
  );
  const start = command.indexOf("async function resolveThreadRoot");
  assert.notEqual(start, -1, "resolveThreadRoot must still exist to guard");
  /* Bound the slice by the next top-level declaration rather than by a byte
   * count, so a comment added inside the function cannot push the SQL out of
   * view and turn this guard green by accident. */
  const end = command.indexOf("interface SignalWriteTarget", start);
  assert.ok(end > start, "the function boundary must be findable");
  const body = command.slice(start, end);
  assert.ok(
    body.includes("AND s.to_user_id IS NULL"),
    "the thread root query must refuse a root addressed to a person",
  );
  assert.ok(
    body.includes("AND s.to_agent_principal_id IS NULL"),
    "the thread root query must refuse a root addressed to an agent",
  );
  assert.ok(
    body.includes("AND s.in_reply_to IS NULL"),
    "and one that is itself a private reply",
  );
  /* The archive arm. A thread reply INHERITS its root's channel and sends no
   * slug, so resolveSignalChannel's archive check never runs for it; without
   * this join a reply lands in a channel whose copy says it takes none. */
  assert.ok(
    body.includes("LEFT JOIN swarm.channels"),
    "the thread root query must know whether its channel is archived",
  );
  assert.ok(
    body.includes("channel_archived_at"),
    "and must carry that state back to the caller",
  );
  /* Control: the slice really is resolveThreadRoot's body. */
  assert.ok(body.includes("thread_root_is_a_reply"));
});


test("the channel commands' field lists are generated, not typed", () => {
  /* A review arm found three refusal sentences that TYPED the fields exactKeys
   * enforces, inside a validator whose own comment claimed every sentence was
   * generated. This pins the generator and the enforcement to one array each. */
  const command = readFileSync(
    fileURLToPath(
      new URL("../supabase/functions/command/index.ts", import.meta.url),
    ),
    "utf8",
  );
  for (
    const [kind, required, optional] of [
      ["channel_create", ["slug"], ["purpose"]],
      ["channel_rename", ["channel_id", "slug"], []],
      ["channel_archive", ["channel_id"], []],
    ] as Array<[string, string[], string[]]>
  ) {
    const start = command.indexOf(`if (cmd.kind === "${kind}")`);
    assert.notEqual(start, -1, `${kind} must still be validated`);
    const body = command.slice(start, start + 1200);
    assert.ok(
      body.includes(`commandFieldsMessage("${kind}", required`),
      `${kind} must build its refusal sentence from the array exactKeys reads`,
    );
    assert.ok(
      body.includes(`const required = ${JSON.stringify(required).replace(/","/g, '", "')};`),
      `${kind} must declare exactly ${required.join(", ")}`,
    );
    /* And the sentence itself names every enforced field. */
    const message = commandFieldsMessage(kind, required, optional);
    for (const field of [...required, ...optional]) {
      assert.ok(message.includes(field), `${kind} sentence must name ${field}`);
    }
    assert.ok(message.startsWith(`${kind} takes `));
  }
  /* Control: the generator can produce a sentence that is missing a field, so
   * the assertions above are about content and not about a truthy string. */
  assert.equal(
    commandFieldsMessage("channel_rename", ["channel_id"]).includes("slug"),
    false,
  );
});

test("the chat keys reach exactKeys ONLY through their own group", () => {
  /* The modernKeys grep alone would miss a chat key added as a bare literal
   * later in the same exactKeys array, which would demand it from every body.
   * This reads the array itself. */
  const command = readFileSync(
    fileURLToPath(
      new URL("../supabase/functions/command/index.ts", import.meta.url),
    ),
    "utf8",
  );
  const start = command.indexOf("const keysOk = exactKeys(cmd, [\n      \"kind\",\n      \"signal_kind\"");
  assert.notEqual(start, -1, "the post_signal exactKeys array must be findable");
  const array = command.slice(start, command.indexOf("]);", start));
  assert.ok(array.includes("...chatKeys"), "chat keys arrive as a spread group");
  for (const key of CHAT_SIGNAL_OPTIONAL_KEYS) {
    assert.equal(
      array.includes(`"${key}"`),
      false,
      `${key} must never be a bare literal in the post_signal exactKeys array`,
    );
  }
  /* Control: the slice really is that array. */
  assert.ok(array.includes('"signal_kind"') && array.includes("...modernKeys"));
});

test("a broken chat shape is refused with the sentence that says which rule broke", () => {
  /* The edge used to test the shape function for null and then return the
   * generic "signal fields are malformed" reason, so a caller never learned
   * which of five rules they had broken. */
  const command = readFileSync(
    fileURLToPath(
      new URL("../supabase/functions/command/index.ts", import.meta.url),
    ),
    "utf8",
  );
  assert.ok(
    command.includes("? chatShapeProblem"),
    "the chat refusal sentence must reach the caller",
  );
  /* And ONLY when NOTHING ELSE is wrong. Gating on the key set alone was not
   * enough -- a review arm showed a body with an invalid signal_kind AND a
   * thread_root_id being told the thread-kind rule, when the first broken rule
   * is that the kind is not a signal kind at all. */
  assert.ok(
    command.includes("baseValid && chatShapeProblem !== null"),
    "the chat sentence is used only when every other check passed",
  );
  const sentence = chatSignalShapeProblem({
    signal_kind: "note",
    to_user_id: null,
    to_agent_principal_id: null,
    in_reply_to: "55555555-5555-4555-8555-555555555555",
    thread_root_id: "22222222-2222-4222-8222-222222222222",
  });
  assert.ok(sentence !== null && sentence.includes("thread_root_id"));
  assert.ok(sentence !== null && sentence.includes("in_reply_to"));
});


test("the thread-reply kinds sentence is generated from the kind set", () => {
  /* A review arm found this typed: the check was `=== "working-on"` while the
   * sentence named "a note or an ask" in prose. A fourth kind would have been
   * accepted as a thread reply while the sentence still named two. */
  const sentence = chatSignalShapeProblem({
    signal_kind: "working-on",
    to_user_id: null,
    to_agent_principal_id: null,
    in_reply_to: null,
    thread_root_id: "22222222-2222-4222-8222-222222222222",
  });
  assert.ok(sentence !== null);
  for (const kind of THREAD_REPLY_KINDS) {
    assert.ok(sentence.includes(kind), `the sentence must name ${kind}`);
  }
  assert.ok(sentence.includes("working-on"), "and the kind that was refused");
  /* Control: the refused kind is not itself offered as a remedy. */
  assert.equal(THREAD_REPLY_KINDS.includes("working-on" as never), false);
  /* Both edges read ONE kind set now, so a fourth kind cannot land in three
   * places and lie in a fourth. */
  const command = readFileSync(
    fileURLToPath(
      new URL("../supabase/functions/command/index.ts", import.meta.url),
    ),
    "utf8",
  );
  const read = readFileSync(
    fileURLToPath(
      new URL("../supabase/functions/read/index.ts", import.meta.url),
    ),
    "utf8",
  );
  assert.equal(
    command.includes('["working-on", "note", "ask"]'),
    false,
    "the command edge must not keep its own copy of the kind set",
  );
  assert.equal(
    read.includes('new Set(["working-on", "note", "ask"])'),
    false,
    "the read edge must not keep its own copy of the kind set",
  );
  assert.ok(command.includes("SIGNAL_KINDS") && read.includes("SIGNAL_KIND"));
});

test("thread_root_id's uuid shape is a chat rule and lives with the chat rules", () => {
  assert.notEqual(
    chatSignalShapeProblem({
      signal_kind: "note",
      to_user_id: null,
      to_agent_principal_id: null,
      in_reply_to: null,
      thread_root_id: "not-a-uuid",
    }),
    null,
  );
  assert.equal(
    chatSignalShapeProblem({
      signal_kind: "note",
      to_user_id: null,
      to_agent_principal_id: null,
      in_reply_to: null,
      thread_root_id: null,
    }),
    null,
    "an explicit null still means no thread",
  );
});

test("a validation reason is safe to return because the validator cannot know anything else", () => {
  /* This lane started returning validation.reason in the 400 body for EVERY
   * command, not just the chat ones, because a generated sentence nobody can
   * read is not a generated sentence. That is the widest change in the lane, so
   * the safety argument is pinned here rather than left in a commit message.
   *
   * The argument is structural, not a review of 22 strings: validateCommand
   * takes ONE parameter, the caller's own decoded body. No transaction, no auth
   * context, no route. It runs before route resolution and before any query, so
   * a reason it produces cannot name another tenant's data, a token, an id the
   * caller did not supply, or the existence of a row. Give it a second
   * parameter and this test fails, which is when the argument needs re-making. */
  const command = readFileSync(
    fileURLToPath(
      new URL("../supabase/functions/command/index.ts", import.meta.url),
    ),
    "utf8",
  );
  const start = command.indexOf("function validateCommand(");
  assert.notEqual(start, -1, "validateCommand must still exist to guard");
  const signature = command.slice(start, command.indexOf("{", command.indexOf("reason: string }", start)));
  assert.ok(
    signature.includes("value: unknown,"),
    "validateCommand takes the caller's own body",
  );
  for (const forbidden of ["tx:", "Sql", "auth:", "route:", "AuthContext", "Route"]) {
    assert.equal(
      signature.includes(forbidden),
      false,
      `validateCommand must not receive ${forbidden}: a reason could then carry state the caller never sent`,
    );
  }
  /* Control: the slice is the signature and not an empty string. */
  assert.ok(signature.includes("ValidatedCommand"));

  /* And the body actually carries it, or the sentences stay invisible. */
  assert.ok(
    command.includes("message: validation.reason,"),
    "the refusal reason must reach the caller, not only swarm.audit",
  );
});


test("neither horizon refusal claims the thread ended", () => {
  /* REGRESSION GUARD, and labelled as one. The atomic refusal fires only when
   * the named horizon stops fitting between the root lookup and the insert --
   * a band one SQL round trip wide, which no p1-server test can hit on demand.
   * Its sentence said the thread had ended; the thread usually has most of its
   * life left and the caller simply asked for more than now fits. A wrong
   * sentence in a correct refusal is the shape this codebase keeps producing,
   * so it is pinned where it can be pinned. */
  const command = readFileSync(
    fileURLToPath(
      new URL("../supabase/functions/command/index.ts", import.meta.url),
    ),
    "utf8",
  );
  const start = command.indexOf('error: "thread_reply_until_exceeds_root"');
  assert.notEqual(start, -1, "the refusal must still exist to guard");
  /* Both arms use this error code; scan every occurrence. */
  let cursor = 0;
  let seen = 0;
  while (true) {
    const at = command.indexOf('error: "thread_reply_until_exceeds_root"', cursor);
    if (at === -1) break;
    seen += 1;
    const block = command.slice(at, at + 700);
    assert.doesNotMatch(
      block,
      /thread ended/i,
      "a refusal must not say the thread ended when it has not",
    );
    cursor = at + 1;
  }
  assert.equal(seen, 2, "both the early and the atomic arm must be scanned");
});
