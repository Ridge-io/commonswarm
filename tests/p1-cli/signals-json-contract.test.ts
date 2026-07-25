import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import { signalReadJsonPayload } from "../../src/cloud/signals.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SIGNAL = "33333333-3333-4333-8333-333333333333";

const row: SignalRecord = {
  id: SIGNAL,
  workspace_id: WORKSPACE,
  from: AGENT,
  from_kind: "agent",
  to: null,
  about: "https://example.test/pr/31",
  kind: "note",
  body: "durable intent",
  until: "2026-07-25T00:00:00.000Z",
  created_at: "2026-07-24T00:00:00.000Z",
};

test("feed JSON remains byte-identical and principal-shaped", () => {
  const serialized = `${
    JSON.stringify(
      signalReadJsonPayload(WORKSPACE, false, [row]),
      null,
      2,
    )
  }\n`;
  const baseline = `{
  "workspace_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "view": "feed",
  "signals": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "workspace_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "from": "22222222-2222-4222-8222-222222222222",
      "from_kind": "agent",
      "to": null,
      "about": "https://example.test/pr/31",
      "kind": "note",
      "body": "durable intent",
      "until": "2026-07-25T00:00:00.000Z",
      "created_at": "2026-07-24T00:00:00.000Z"
    }
  ],
  "message": "1 signal visible."
}
`;

  assert.equal(serialized, baseline);
  assert.equal(serialized.includes("display_name"), false);
  assert.equal(serialized.includes("author_name"), false);
});

test("inbox JSON keeps the existing empty message", () => {
  assert.deepEqual(signalReadJsonPayload(WORKSPACE, true, []), {
    workspace_id: WORKSPACE,
    view: "inbox",
    signals: [],
    message: "Nothing is waiting for you.",
  });
});
