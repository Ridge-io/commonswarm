import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CHAT_SIGNAL_OPTIONAL_KEYS,
  chatReadKeys,
  chatSignalKeys,
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
